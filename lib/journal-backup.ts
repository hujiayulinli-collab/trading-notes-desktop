import {
  conditionGroups,
  baseRiskPercent,
  mergeConditionGroups,
  validId,
  validateRecords,
  type ConditionGroup,
  type Trade,
} from './journal.ts';

export const MAX_BACKUP = 200 * 1024 * 1024;
export type BackupAsset = {
  id: string;
  mime: string;
  sha256: string;
  data: string;
};
export type Backup = {
  format: 'pankou-journal-backup';
  schemaVersion: 1;
  exportedAt: string;
  records: Trade[];
  conditionGroups?: ConditionGroup[];
  baseRiskPercent?: number;
  assets: BackupAsset[];
};
export async function sha256(bytes: Uint8Array<ArrayBuffer>) {
  if (!globalThis.crypto.subtle)
    throw new Error(
      '云端截图校验需要安全连接，请在主机的本机页面操作，或使用 HTTPS 访问后再备份或准备报告。',
    );
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('');
}
export function encodeBase64(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 32768)
    text += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(text);
}
export function imageBytes(
  data: unknown,
  mime: string,
): Uint8Array<ArrayBuffer> {
  if (
    typeof data !== 'string' ||
    data.length > 12 * 1024 * 1024 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(data)
  )
    throw new Error('截图编码无效或超过 8 MB。');
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  } catch {
    throw new Error('截图编码无效。');
  }
  const valid =
    mime === 'image/png'
      ? [137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n)
      : mime === 'image/jpeg'
        ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        : mime === 'image/webp' &&
          String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' &&
          String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP';
  if (!valid || !bytes.length || bytes.length > 8 * 1024 * 1024)
    throw new Error('截图内容与格式不符，或超过 8 MB。');
  return bytes;
}
export async function verifyBitmap(
  bytes: Uint8Array<ArrayBuffer>,
  mime: string,
) {
  const bitmap = await createImageBitmap(
    new Blob([bytes], { type: mime }),
  ).catch(() => null);
  if (!bitmap) throw new Error('截图无法解码，请选择有效图片。');
  const tooLarge = bitmap.width * bitmap.height > 40000000;
  bitmap.close();
  if (tooLarge) throw new Error('截图超过 4,000 万像素。');
}
export async function inspectCloudBackup(
  input: unknown,
  records: Trade[],
  groups: ConditionGroup[],
  currentBase = 1,
) {
  const backup = input as Backup;
  if (
    !backup ||
    backup.format !== 'pankou-journal-backup' ||
    backup.schemaVersion !== 1 ||
    !Array.isArray(backup.assets)
  )
    throw new Error('这不是有效的盘口手记完整备份文件。');
  if (new Blob([JSON.stringify(backup)]).size > MAX_BACKUP)
    throw new Error('备份超过 200 MB。');
  validateRecords(backup.records);
  const incomingBase = baseRiskPercent(backup.baseRiskPercent);
  const base =
    !records.length && backup.baseRiskPercent !== undefined
      ? incomingBase
      : baseRiskPercent(currentBase);
  const mergedGroups =
    !records.length && backup.conditionGroups !== undefined
      ? conditionGroups(backup.conditionGroups)
      : mergeConditionGroups(groups, backup.conditionGroups);
  const ids = new Set(records.map((t) => t.id));
  const unique = backup.records.filter((t) => !ids.has(t.id));
  validateRecords([...records, ...unique]);
  const assets = new Map<
    string,
    { mime: string; bytes: Uint8Array<ArrayBuffer> }
  >();
  for (const asset of backup.assets) {
    if (!asset || !validId(asset.id) || assets.has(asset.id))
      throw new Error('备份截图 ID 无效或重复。');
    const bytes = imageBytes(asset.data, asset.mime);
    if ((await sha256(bytes)) !== asset.sha256)
      throw new Error('截图校验失败，备份可能损坏。');
    assets.set(asset.id, { bytes, mime: asset.mime });
  }
  for (const trade of backup.records)
    for (const shot of trade.screenshots)
      if (assets.get(shot.id)?.mime !== shot.mime)
        throw new Error(`备份缺少截图“${shot.name}”。`);
  return {
    unique,
    groups: conditionGroups(mergedGroups),
    baseRiskPercent: base,
    assets,
    total: backup.records.length,
    added: unique.length,
    skipped: backup.records.length - unique.length,
    screenshots: assets.size,
  };
}
