import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import {
  validateRecords,
  validId,
  conditionGroups,
  baseRiskPercent,
  mergeConditionGroups,
} from '../lib/journal.ts';

export const MAX_IMAGE = 8 * 1024 * 1024;
export const MAX_BACKUP = 200 * 1024 * 1024;
const extension = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};
export function decodeImage(data, mime) {
  if (
    !extension[mime] ||
    typeof data !== 'string' ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(data)
  )
    throw new Error('截图编码或格式无效。');
  const bytes = Buffer.from(data, 'base64');
  if (!bytes.length || bytes.length > MAX_IMAGE)
    throw new Error('单张截图不能超过 8 MB。');
  const valid =
    mime === 'image/png'
      ? bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
      : mime === 'image/jpeg'
        ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        : bytes.toString('ascii', 0, 4) === 'RIFF' &&
          bytes.toString('ascii', 8, 12) === 'WEBP';
  if (!valid) throw new Error('截图内容与文件格式不符。');
  return bytes;
}
export const digest = (bytes) =>
  createHash('sha256').update(bytes).digest('hex');
export async function verifyImage(bytes) {
  try {
    await sharp(bytes, {
      limitInputPixels: 40000000,
      failOn: 'warning',
      animated: false,
    })
      .resize({ width: 1, height: 1 })
      .raw()
      .toBuffer();
  } catch {
    throw new Error('截图无法解码或超过 4,000 万像素，请重新选择有效图片。');
  }
}
export async function atomicJSON(file, data) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx');
  try {
    await handle.writeFile(JSON.stringify(data, null, 2), 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
}
function validateLibrary(value) {
  if (
    value?.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0
  )
    throw new Error('资料库版本无效。请保留原文件并从备份恢复。');
  validateRecords(value.records);
  return {
    ...value,
    conditionGroups: conditionGroups(value.conditionGroups),
    baseRiskPercent: baseRiskPercent(value.baseRiskPercent),
  };
}
export class JournalStore {
  constructor(root, directory) {
    this.root = root;
    this.directory = directory || path.join(root, 'data');
    this.explicitDirectory = !!directory;
    this.queue = Promise.resolve();
  }
  async init() {
    if (!this.explicitDirectory) {
      try {
        const settings = JSON.parse(
          await fs.readFile(
            path.join(this.root, '.local-settings.json'),
            'utf8',
          ),
        );
        if (!path.isAbsolute(settings.directory))
          throw new Error('保存位置无效。');
        this.directory = settings.directory;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    await fs.mkdir(path.join(this.directory, 'screenshots'), {
      recursive: true,
    });
    try {
      this.library = validateLibrary(
        JSON.parse(
          await fs.readFile(path.join(this.directory, 'journal.json'), 'utf8'),
        ),
      );
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const previous = await fs
        .stat(path.join(this.directory, 'journal.previous.json'))
        .catch(() => null);
      if (previous)
        throw new Error(
          '主资料文件丢失，但发现 journal.previous.json。请先备份整个数据文件夹，再将该文件复制为 journal.json 后重启；没有创建空库。',
        );
      this.library = {
        schemaVersion: 1,
        revision: 0,
        records: [],
        conditionGroups: conditionGroups(),
        baseRiskPercent: baseRiskPercent(),
      };
      await atomicJSON(path.join(this.directory, 'journal.json'), this.library);
    }
    return this;
  }
  async lock() {
    const file = path.join(this.directory, '.journal.lock');
    const token = randomUUID();
    try {
      await fs.writeFile(file, JSON.stringify({ pid: process.pid, token }), {
        flag: 'wx',
      });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let existing;
      try {
        existing = JSON.parse(await fs.readFile(file, 'utf8'));
      } catch {
        throw new Error(
          '资料库锁文件损坏。请确认程序已关闭后移除 .journal.lock，再重新启动。',
        );
      }
      let alive = true;
      try {
        process.kill(existing.pid, 0);
      } catch (error) {
        if (error.code === 'ESRCH') alive = false;
      }
      if (alive)
        throw new Error(
          '这个资料库已被另一个盘口手记进程使用。请使用已经打开的页面，或关闭旧进程后重启。',
        );
      await fs.unlink(file);
      await fs.writeFile(file, JSON.stringify({ pid: process.pid, token }), {
        flag: 'wx',
      });
    }
    this.lockInfo = { file, token };
    return this;
  }
  async unlock() {
    if (!this.lockInfo) return;
    const info = this.lockInfo;
    this.lockInfo = null;
    const stored = JSON.parse(
      await fs.readFile(info.file, 'utf8').catch(() => '{}'),
    );
    if (stored.token === info.token) await fs.unlink(info.file).catch(() => {});
  }
  serialized(operation) {
    const task = this.queue.then(operation);
    this.queue = task.catch(() => {});
    return task;
  }
  snapshot() {
    return { ...structuredClone(this.library), directory: this.directory };
  }
  assertRevision(revision) {
    if (revision !== this.library.revision) {
      const error = new Error(
        '资料已在另一个窗口更新。请先下载未保存文字，再重新载入；不会覆盖另一窗口的数据。',
      );
      error.status = 409;
      throw error;
    }
  }
  assetPath(shot, directory = this.directory) {
    if (!validId(shot.id) || !extension[shot.mime])
      throw new Error('截图引用无效。');
    return path.join(
      directory,
      'screenshots',
      `${shot.id}.${extension[shot.mime]}`,
    );
  }
  async verifyAssets(records, directory = this.directory) {
    for (const t of records)
      for (const s of t.screenshots) {
        const stat = await fs
          .stat(this.assetPath(s, directory))
          .catch(() => null);
        if (!stat?.isFile())
          throw new Error(`截图“${s.name}”缺失，未保存更改。`);
      }
  }
  async write(
    records,
    groups = this.library.conditionGroups,
    base = this.library.baseRiskPercent,
  ) {
    validateRecords(records);
    const validatedGroups = conditionGroups(groups);
    const validatedBase = baseRiskPercent(base);
    await this.verifyAssets(records);
    const disk = validateLibrary(
      JSON.parse(
        await fs.readFile(path.join(this.directory, 'journal.json'), 'utf8'),
      ),
    );
    if (
      disk.revision !== this.library.revision ||
      disk.baseRiskPercent !== this.library.baseRiskPercent ||
      JSON.stringify(disk.records) !== JSON.stringify(this.library.records) ||
      JSON.stringify(disk.conditionGroups) !==
        JSON.stringify(this.library.conditionGroups)
    )
      throw new Error(
        '磁盘资料已被其他程序修改，未覆盖更改。请下载未保存文字后重新启动。',
      );
    const previous = this.library;
    const next = {
      schemaVersion: 1,
      revision: previous.revision + 1,
      records,
      conditionGroups: validatedGroups,
      baseRiskPercent: validatedBase,
    };
    await atomicJSON(
      path.join(this.directory, 'journal.previous.json'),
      previous,
    );
    await atomicJSON(path.join(this.directory, 'journal.json'), next);
    this.library = structuredClone(next);
    return this.snapshot();
  }
  save(records, revision, groups, base) {
    return this.serialized(async () => {
      this.assertRevision(revision);
      return this.write(records, groups, base);
    });
  }
  upload(payload) {
    return this.serialized(async () => {
      if (typeof payload.name !== 'string' || payload.name.length > 200)
        throw new Error('文件名无效。');
      const bytes = decodeImage(payload.data, payload.mime);
      await verifyImage(bytes);
      const shot = {
        id: randomUUID(),
        name: payload.name,
        mime: payload.mime,
        stage: '入场',
      };
      await fs.writeFile(this.assetPath(shot), bytes, { flag: 'wx' });
      return shot;
    });
  }
  exportBackup() {
    return this.serialized(async () => {
      const assets = [];
      const seen = new Set();
      let size = 0;
      for (const t of this.library.records)
        for (const s of t.screenshots)
          if (!seen.has(s.id)) {
            const bytes = await fs.readFile(this.assetPath(s));
            size += Math.ceil((bytes.length * 4) / 3);
            if (size > MAX_BACKUP - 20 * 1024 * 1024)
              throw new Error(
                '备份超过 200 MB，请关闭程序后复制整个数据文件夹进行迁移。',
              );
            assets.push({
              id: s.id,
              mime: s.mime,
              sha256: digest(bytes),
              data: bytes.toString('base64'),
            });
            seen.add(s.id);
          }
      const backup = {
        format: 'pankou-journal-backup',
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        records: structuredClone(this.library.records),
        conditionGroups: structuredClone(this.library.conditionGroups),
        baseRiskPercent: this.library.baseRiskPercent,
        assets,
      };
      if (Buffer.byteLength(JSON.stringify(backup), 'utf8') > MAX_BACKUP - 4096)
        throw new Error(
          '完整备份超过 200 MB，请关闭程序后复制整个数据文件夹迁移。',
        );
      return backup;
    });
  }
  inspectBackup(backup) {
    if (
      backup?.format !== 'pankou-journal-backup' ||
      backup.schemaVersion !== 1 ||
      !Array.isArray(backup.assets)
    )
      throw new Error('这不是有效的盘口手记完整备份文件。');
    validateRecords(backup.records);
    const incomingBase = baseRiskPercent(backup.baseRiskPercent);
    const base =
      !this.library.records.length && backup.baseRiskPercent !== undefined
        ? incomingBase
        : this.library.baseRiskPercent;
    const groups =
      !this.library.records.length && backup.conditionGroups !== undefined
        ? conditionGroups(backup.conditionGroups)
        : mergeConditionGroups(
            this.library.conditionGroups,
            backup.conditionGroups,
          );
    const ids = new Set(this.library.records.map((t) => t.id));
    const unique = backup.records.filter((t) => !ids.has(t.id));
    validateRecords([...this.library.records, ...unique]);
    const assets = new Map();
    for (const s of backup.assets) {
      if (!validId(s.id) || assets.has(s.id))
        throw new Error('备份截图 ID 无效或重复。');
      const bytes = decodeImage(s.data, s.mime);
      if (s.sha256 !== digest(bytes))
        throw new Error('截图校验失败，备份可能已损坏。');
      assets.set(s.id, { ...s, bytes });
    }
    for (const t of backup.records)
      for (const s of t.screenshots)
        if (!assets.has(s.id) || assets.get(s.id).mime !== s.mime)
          throw new Error(`备份缺少截图“${s.name}”。`);
    return {
      unique,
      groups,
      baseRiskPercent: base,
      assets,
      total: backup.records.length,
      added: unique.length,
      skipped: backup.records.length - unique.length,
      screenshots: assets.size,
    };
  }
  async previewBackup(backup) {
    const inspected = this.inspectBackup(backup);
    for (const asset of inspected.assets.values())
      await verifyImage(asset.bytes);
    return inspected;
  }
  importBackup(backup, revision) {
    return this.serialized(async () => {
      this.assertRevision(revision);
      const inspected = await this.previewBackup(backup);
      const imported = structuredClone(inspected.unique);
      const remap = new Map();
      for (const t of imported)
        for (const s of t.screenshots) {
          if (!remap.has(s.id)) {
            const original = inspected.assets.get(s.id);
            const next = { ...s, id: randomUUID() };
            await fs.writeFile(this.assetPath(next), original.bytes, {
              flag: 'wx',
            });
            remap.set(s.id, next.id);
          }
          s.id = remap.get(s.id);
        }
      if (
        imported.length ||
        inspected.baseRiskPercent !== this.library.baseRiskPercent ||
        JSON.stringify(inspected.groups) !==
          JSON.stringify(this.library.conditionGroups)
      )
        await this.write(
          [...this.library.records, ...imported],
          inspected.groups,
          inspected.baseRiskPercent,
        );
      return {
        ...this.snapshot(),
        added: imported.length,
        skipped: inspected.skipped,
      };
    });
  }
  migrate(target, revision) {
    return this.serialized(async () => {
      this.assertRevision(revision);
      if (
        typeof target !== 'string' ||
        !path.isAbsolute(target) ||
        target.length > 240
      )
        throw new Error('请输入有效的绝对文件夹路径。');
      target = path.resolve(target);
      const source = path.resolve(this.directory);
      const within = (a, b) => {
        const relative = path.relative(a, b);
        return (
          !relative ||
          (!relative.startsWith('..') && !path.isAbsolute(relative))
        );
      };
      if (
        within(source, target) ||
        within(target, source) ||
        target === path.parse(target).root
      )
        throw new Error('请选择当前资料库之外的独立空文件夹。');
      const existing = await fs.readdir(target).catch((error) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      if (existing.length)
        throw new Error(
          '目标文件夹不是空的。请新建一个空文件夹，以免覆盖已有文件。',
        );
      await this.verifyAssets(this.library.records);
      await fs.mkdir(target, { recursive: true });
      // Copy, verify, then switch. The original folder remains intact.
      for (const entry of await fs.readdir(source)) {
        if (entry === '.journal.lock') continue;
        await fs.cp(path.join(source, entry), path.join(target, entry), {
          recursive: true,
          force: false,
          errorOnExist: true,
        });
      }
      const copied = validateLibrary(
        JSON.parse(
          await fs.readFile(path.join(target, 'journal.json'), 'utf8'),
        ),
      );
      if (JSON.stringify(copied) !== JSON.stringify(this.library))
        throw new Error('资料校验失败，仍使用原文件夹。');
      await this.verifyAssets(copied.records, target);
      for (const t of copied.records)
        for (const s of t.screenshots)
          if (
            digest(await fs.readFile(this.assetPath(s))) !==
            digest(await fs.readFile(this.assetPath(s, target)))
          )
            throw new Error('截图复制校验失败，仍使用原文件夹。');
      const oldLock = this.lockInfo;
      this.directory = target;
      try {
        if (oldLock) await this.lock();
        await atomicJSON(path.join(this.root, '.local-settings.json'), {
          directory: target,
        });
      } catch (error) {
        if (this.lockInfo !== oldLock) await this.unlock();
        this.lockInfo = oldLock;
        this.directory = source;
        throw error;
      }
      if (oldLock) await fs.unlink(oldLock.file).catch(() => {});
      return this.snapshot();
    });
  }
}
