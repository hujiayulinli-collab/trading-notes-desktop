import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createId } from './id.ts';
import {
  conditionGroups,
  baseRiskPercent,
  validateRecords,
  validId,
  type Shot,
  type Trade,
} from './journal.ts';
import {
  localRequest,
  type JournalClient,
  type Snapshot,
} from './journal-client.ts';
import {
  encodeBase64,
  imageBytes,
  inspectCloudBackup,
  MAX_BACKUP,
  sha256,
  verifyBitmap,
  type Backup,
} from './journal-backup.ts';

export type CloudConfig = { url: string; key: string };
export const CLOUD_CONFIG_KEY = 'pankou.supabase.config.v1';
export function validateCloudConfig(input: CloudConfig): CloudConfig {
  const url = new URL(input.url.trim());
  if (
    url.protocol !== 'https:' ||
    !/^[a-z0-9-]+\.supabase\.co$/.test(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !['', '/'].includes(url.pathname)
  )
    throw new Error(
      '请填写 Supabase 项目地址，例如 https://项目编号.supabase.co。',
    );
  const key = input.key.trim();
  if (key.startsWith('sb_secret_'))
    throw new Error('不能使用 secret 密钥，请改用 Publishable key。');
  if (!/^sb_publishable_[A-Za-z0-9_-]{10,}$/.test(key)) {
    let role = '';
    try {
      role = JSON.parse(
        atob(key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')),
      ).role;
    } catch {}
    if (role !== 'anon')
      throw new Error(
        '请填写 Publishable key 或旧版 anon 公钥，不要使用 service_role 密钥。',
      );
  }
  if (key.length > 2000) throw new Error('连接密钥过长。');
  return { url: url.origin, key };
}
export function createCloudClient(config: CloudConfig) {
  const valid = validateCloudConfig(config);
  return createClient(valid.url, valid.key, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
    global: {
      fetch: (input, init) =>
        fetch(input, {
          ...init,
          signal: init?.signal || AbortSignal.timeout(45000),
        }),
    },
  });
}
function cloudError(error: { message: string; code?: string }) {
  if (error.code === '23514')
    return new Error(
      '云端资料校验未通过。若尚未升级自定义模块功能，请在 Supabase SQL Editor 重新运行最新版建库文件；未保存内容仍保留在页面中。',
    );
  if (error.message.includes('JOURNAL_ACCOUNT_CHANGED'))
    return new Error('登录账号已改变，请重新登录原账号后重试。');
  if (error.message.includes('JOURNAL_CONFLICT'))
    return new Error(
      '另一台设备已保存了新内容。请下载未保存文字后重新载入，避免覆盖云端更改。',
    );
  if (
    error.code === 'PGRST202' ||
    error.code === '42P01' ||
    error.message.includes('schema cache')
  )
    return new Error('云数据库尚未初始化，请先执行项目附带的建库文件。');
  if (error.code === '42501' || error.message.includes('row-level security'))
    return new Error('云端访问权限不足，请确认已登录并完成建库设置。');
  return new Error(`云端操作失败：${error.message}`);
}
const bucket = 'journal-screenshots';
export class CloudJournalClient implements JournalClient {
  cloud = true;
  label: string;
  client: SupabaseClient;
  userId: string;
  snapshot: Snapshot | null = null;
  private urls = new Map<string, { url: string; expires: number }>();
  constructor(client: SupabaseClient, userId: string, email: string) {
    this.client = client;
    this.userId = userId;
    this.label = email;
  }
  private async assertAccount() {
    const { data, error } = await this.client.auth.getSession();
    if (error || data.session?.user.id !== this.userId)
      throw new Error('登录已失效，请重新登录当前账号后重试。');
  }
  authorize = async () => {
    await this.assertAccount();
  };
  private path(shot: Shot) {
    const extension: Record<string, string> = {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/webp': 'webp',
    };
    if (!validId(shot.id) || !extension[shot.mime])
      throw new Error('截图引用无效。');
    return `${this.userId}/${shot.id}.${extension[shot.mime]}`;
  }
  async load(): Promise<Snapshot> {
    await this.assertAccount();
    const { data, error } = await this.client.rpc('load_journal', {
      expected_user_id: this.userId,
    });
    if (error) throw cloudError(error);
    const records = data?.content?.records ?? [];
    validateRecords(records);
    if (
      data &&
      (data.content?.schemaVersion !== 1 ||
        !Number.isSafeInteger(data.revision) ||
        data.revision < 1)
    )
      throw new Error('云端资料格式无效，请保留备份并检查数据库。');
    const snapshot = {
      records,
      conditionGroups: conditionGroups(data?.content?.conditionGroups),
      baseRiskPercent: baseRiskPercent(data?.content?.baseRiskPercent),
      revision: data?.revision ?? 0,
      directory: this.label,
    };
    this.snapshot = structuredClone(snapshot);
    return snapshot;
  }
  async save(payload: {
    records: Trade[];
    revision: number;
    conditionGroups?: unknown;
    baseRiskPercent?: unknown;
  }): Promise<Snapshot> {
    await this.assertAccount();
    validateRecords(payload.records);
    if (!Number.isSafeInteger(payload.revision) || payload.revision < 0)
      throw new Error('资料版本无效。');
    const content = {
      schemaVersion: 1,
      records: payload.records,
      conditionGroups: conditionGroups(
        payload.conditionGroups === undefined
          ? this.snapshot?.conditionGroups
          : payload.conditionGroups,
      ),
      baseRiskPercent: baseRiskPercent(
        payload.baseRiskPercent === undefined
          ? this.snapshot?.baseRiskPercent
          : payload.baseRiskPercent,
      ),
    };
    if (new Blob([JSON.stringify(content)]).size > 16 * 1024 * 1024)
      throw new Error('文字资料超过当前云资料库 16 MB 上限，请先导出备份。');
    const { data, error } = await this.client.rpc('save_journal', {
      expected_user_id: this.userId,
      expected_revision: payload.revision,
      next_content: content,
    });
    if (error) throw cloudError(error);
    if (!Number.isSafeInteger(data) || data !== payload.revision + 1)
      throw new Error('未能确认云端保存结果，请重新载入检查。');
    const snapshot = { ...content, revision: data, directory: this.label };
    this.snapshot = structuredClone(snapshot);
    return snapshot;
  }
  private async upload(
    payload: { name: string; mime: string; data: string },
    verified = false,
  ): Promise<Shot> {
    await this.assertAccount();
    if (typeof payload.name !== 'string' || payload.name.length > 200)
      throw new Error('截图文件名无效。');
    const bytes = imageBytes(payload.data, payload.mime);
    if (!verified) await verifyBitmap(bytes, payload.mime);
    const shot = {
      id: createId(),
      name: payload.name,
      mime: payload.mime,
      stage: '入场',
    };
    const { error } = await this.client.storage
      .from(bucket)
      .upload(this.path(shot), bytes, {
        contentType: shot.mime,
        upsert: false,
      });
    if (error) throw cloudError(error);
    return shot;
  }
  imageSource = async (shot: Shot): Promise<string> => {
    await this.assertAccount();
    const path = this.path(shot);
    const cached = this.urls.get(path);
    if (cached && cached.expires > Date.now()) return cached.url;
    const { data, error } = await this.client.storage
      .from(bucket)
      .createSignedUrl(path, 3600);
    if (error) throw cloudError(error);
    this.urls.set(path, {
      url: data.signedUrl,
      expires: Date.now() + 50 * 60000,
    });
    return data.signedUrl;
  };
  private async bytes(shot: Shot) {
    await this.assertAccount();
    const { data, error } = await this.client.storage
      .from(bucket)
      .download(this.path(shot));
    if (error) throw cloudError(error);
    return new Uint8Array(await data.arrayBuffer());
  }
  imageBytes = async (shot: Shot) => {
    const bytes = await this.bytes(shot);
    await this.assertAccount();
    return bytes;
  };
  private async exportBackup(): Promise<Backup> {
    const snapshot = await this.load();
    const assets = [];
    const seen = new Set<string>();
    let size = new Blob([JSON.stringify(snapshot)]).size;
    for (const trade of snapshot.records)
      for (const shot of trade.screenshots)
        if (!seen.has(shot.id)) {
          const bytes = await this.bytes(shot);
          size += Math.ceil((bytes.length * 4) / 3) + 1024;
          if (size > MAX_BACKUP - 4096)
            throw new Error('完整备份超过 200 MB，请在云项目中单独备份截图。');
          assets.push({
            id: shot.id,
            mime: shot.mime,
            sha256: await sha256(bytes),
            data: encodeBase64(bytes),
          });
          seen.add(shot.id);
        }
    return {
      format: 'pankou-journal-backup',
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      records: snapshot.records,
      conditionGroups: snapshot.conditionGroups,
      baseRiskPercent: snapshot.baseRiskPercent,
      assets,
    };
  }
  private async inspect(backup: unknown) {
    const snapshot = await this.load();
    const inspected = await inspectCloudBackup(
      backup,
      snapshot.records,
      snapshot.conditionGroups,
      snapshot.baseRiskPercent,
    );
    for (const asset of inspected.assets.values())
      await verifyBitmap(asset.bytes, asset.mime);
    return { ...inspected, snapshot };
  }
  private async importBackup(backup: unknown, revision: number) {
    const inspected = await this.inspect(backup);
    if (inspected.snapshot.revision !== revision)
      throw cloudError({ message: 'JOURNAL_CONFLICT' });
    const records = structuredClone(inspected.unique);
    const remap = new Map<string, string>();
    for (const trade of records)
      for (const shot of trade.screenshots) {
        if (!remap.has(shot.id)) {
          const asset = inspected.assets.get(shot.id)!;
          const uploaded = await this.upload(
            {
              name: shot.name,
              mime: shot.mime,
              data: encodeBase64(asset.bytes),
            },
            true,
          );
          remap.set(shot.id, uploaded.id);
        }
        shot.id = remap.get(shot.id)!;
      }
    const snapshot = await this.save({
      records: [...inspected.snapshot.records, ...records],
      conditionGroups: inspected.groups,
      baseRiskPercent: inspected.baseRiskPercent,
      revision,
    });
    return { ...snapshot, added: inspected.added, skipped: inspected.skipped };
  }
  request = async <T>(
    url: string,
    method = 'GET',
    input?: unknown,
  ): Promise<T> => {
    let result: unknown;
    if (url === '/api/journal')
      result =
        method === 'PUT'
          ? await this.save(input as Parameters<CloudJournalClient['save']>[0])
          : await this.load();
    else if (url === '/api/screenshots')
      result = await this.upload(
        input as Parameters<CloudJournalClient['upload']>[0],
      );
    else if (url === '/api/backup') result = await this.exportBackup();
    else if (url === '/api/import/preview') {
      const info = await this.inspect(input);
      result = {
        total: info.total,
        added: info.added,
        skipped: info.skipped,
        screenshots: info.screenshots,
      };
    } else if (url === '/api/import') {
      const payload = input as { backup: unknown; revision: number };
      result = await this.importBackup(payload.backup, payload.revision);
    } else if (url === '/api/analyze') {
      const payload = input as { records: Trade[]; includeImages: boolean };
      const cloudImages = [];
      if (payload.includeImages)
        for (const trade of payload.records)
          for (const shot of trade.screenshots)
            cloudImages.push({
              id: shot.id,
              mime: shot.mime,
              data: encodeBase64(await this.bytes(shot)),
            });
      result = await localRequest(url, method, { ...payload, cloudImages });
    } else throw new Error('当前资料库使用云端存储，不支持此本地操作。');
    return result as T;
  };
}
