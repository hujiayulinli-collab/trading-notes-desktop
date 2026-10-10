import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const deriveKey = promisify(scrypt);
const MAX_PASSWORD_BYTES = 1024;
const KEY_BYTES = 64;
const SALT_BYTES = 32;
// Keep parameters fixed and validated; a modified file must not request unbounded work.
const SCRYPT_OPTIONS = Object.freeze({
  N: 32768,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
});
const CONFIG_LIMIT = 8192;

export class AuthError extends Error {
  constructor(code, message, retryAfterMs = 0) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

function validPassword(value, { allowEmpty = true, minimum = false } = {}) {
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value, 'utf8') > MAX_PASSWORD_BYTES
  ) {
    throw new AuthError(
      'INVALID_PASSWORD',
      '密码须为文字，且不能超过 1,024 个 UTF-8 字节。',
    );
  }
  if (
    (!allowEmpty && value.length === 0) ||
    (minimum && Array.from(value).length < 8)
  ) {
    throw new AuthError('INVALID_PASSWORD', '新密码至少需要 8 个字符。');
  }
}

function parseConfig(contents) {
  const value = JSON.parse(contents);
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value.schemaVersion !== 1 ||
    typeof value.enabled !== 'boolean'
  ) {
    throw new Error('Invalid application lock configuration');
  }
  const keys = Object.keys(value).sort().join(',');
  if (!value.enabled) {
    if (keys !== 'enabled,schemaVersion')
      throw new Error('Invalid disabled configuration');
    return Object.freeze(value);
  }
  if (
    keys !== 'algorithm,enabled,hash,salt,schemaVersion' ||
    value.algorithm !== 'scrypt-N32768-r8-p1' ||
    typeof value.salt !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.salt) ||
    typeof value.hash !== 'string' ||
    !/^[a-f0-9]{128}$/.test(value.hash)
  ) {
    throw new Error('Invalid application lock credential');
  }
  return Object.freeze(value);
}

async function atomicWrite(filename, value) {
  const temporary = `${filename}.${randomBytes(16).toString('hex')}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(value) + '\n', 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, filename);
  } finally {
    await handle?.close().catch(() => {});
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

/** A local application gate, not encryption or protection from filesystem access. */
export class AuthStore {
  #filename;
  #record;
  #initialized = false;
  #queue = Promise.resolve();
  #failures = 0;
  #retryAt = 0;

  constructor(settingsRoot) {
    if (typeof settingsRoot !== 'string' || !path.isAbsolute(settingsRoot)) {
      throw new TypeError('应用锁设置目录必须为绝对路径。');
    }
    this.#filename = path.join(settingsRoot, '.app-lock.json');
  }

  // Never report passwordless before a successful init, including after corruption.
  get enabled() {
    return !this.#initialized || this.#record.enabled;
  }

  #enqueue(operation) {
    const next = this.#queue.then(operation);
    this.#queue = next.catch(() => {});
    return next;
  }

  #assertInitialized() {
    if (!this.#initialized)
      throw new AuthError('AUTH_NOT_READY', '应用锁尚未安全载入。');
  }

  async init() {
    return this.#enqueue(async () => {
      if (this.#initialized) return this;
      await fs.mkdir(path.dirname(this.#filename), {
        recursive: true,
        mode: 0o700,
      });
      let existed = false;
      try {
        const info = await fs.lstat(this.#filename);
        existed = true;
        if (!info.isFile() || info.size > CONFIG_LIMIT)
          throw new Error('Invalid configuration file');
        this.#record = parseConfig(await fs.readFile(this.#filename, 'utf8'));
      } catch (error) {
        if (error.code === 'ENOENT' && !existed) {
          this.#record = Object.freeze({ schemaVersion: 1, enabled: false });
        } else {
          throw new AuthError(
            'AUTH_CONFIG_INVALID',
            '应用锁配置无法读取或已损坏。已停止启动，不会自动关闭密码或覆盖配置。请保留文件并联系维护者。',
          );
        }
      }
      this.#initialized = true;
      return this;
    });
  }

  async #verify(password) {
    this.#assertInitialized();
    validPassword(password);
    if (!this.#record.enabled) return true;
    const remaining = this.#retryAt - Date.now();
    if (remaining > 0) {
      throw new AuthError(
        'AUTH_RETRY_LATER',
        `尝试次数较多，请 ${Math.ceil(remaining / 1000)} 秒后重试。`,
        remaining,
      );
    }
    const actual = await deriveKey(
      password,
      Buffer.from(this.#record.salt, 'hex'),
      KEY_BYTES,
      SCRYPT_OPTIONS,
    );
    const expected = Buffer.from(this.#record.hash, 'hex');
    const matches = timingSafeEqual(actual, expected);
    actual.fill(0);
    expected.fill(0);
    if (matches) {
      this.#failures = 0;
      this.#retryAt = 0;
    } else {
      this.#failures += 1;
      if (this.#failures >= 3) {
        this.#retryAt =
          Date.now() +
          Math.min(30_000, 1000 * 2 ** Math.min(5, this.#failures - 3));
      }
    }
    return matches;
  }

  async verify(password) {
    // Validate before joining the queue so oversized input is not retained behind work.
    validPassword(password);
    return this.#enqueue(() => this.#verify(password));
  }

  async setPassword(currentPassword, newPassword) {
    validPassword(currentPassword);
    validPassword(newPassword, { minimum: newPassword !== '' });
    return this.#enqueue(async () => {
      this.#assertInitialized();
      if (this.#record.enabled && !(await this.#verify(currentPassword))) {
        throw new AuthError('INVALID_CURRENT_PASSWORD', '当前密码不正确。');
      }
      let next = { schemaVersion: 1, enabled: false };
      if (newPassword !== '') {
        const salt = randomBytes(SALT_BYTES);
        const key = await deriveKey(
          newPassword,
          salt,
          KEY_BYTES,
          SCRYPT_OPTIONS,
        );
        next = {
          schemaVersion: 1,
          enabled: true,
          algorithm: 'scrypt-N32768-r8-p1',
          salt: salt.toString('hex'),
          hash: key.toString('hex'),
        };
        key.fill(0);
      }
      // Commit memory only after the complete replacement is safely written.
      try {
        await atomicWrite(this.#filename, next);
      } catch {
        throw new AuthError(
          'AUTH_WRITE_FAILED',
          '密码设置未能保存。请检查磁盘空间和文件夹权限后重试。',
        );
      }
      this.#record = Object.freeze(next);
      this.#failures = 0;
      this.#retryAt = 0;
      return true;
    });
  }
}
