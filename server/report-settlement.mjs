import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import {
  MAX_SETTLEMENT_BYTES,
  MAX_SETTLEMENT_JSON_BYTES,
  validateSettlement,
} from '../lib/report-settlement.ts';
import { MAX_IMAGE, decodeImage, digest, verifyImage } from './storage.mjs';

async function checkedDirectory(directory, parent) {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error('交割补充目录不能是链接或非文件夹。');
  const resolved = await fs.realpath(directory);
  if (parent && path.dirname(resolved) !== parent)
    throw new Error('交割补充目录超出报告保存范围。');
  return resolved;
}

async function readChecked(file, parent, max) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error('交割补充文件不能是链接或非普通文件。');
  if (stat.size <= 0 || stat.size > max)
    throw new Error('交割补充文件为空或超过大小限制。');
  if (path.dirname(await fs.realpath(file)) !== parent)
    throw new Error('交割补充文件超出报告保存范围。');
  const handle = await fs.open(file, 'r');
  try {
    const opened = await handle.stat();
    const current = await fs.lstat(file);
    if (
      !opened.isFile() ||
      current.isSymbolicLink() ||
      opened.ino !== stat.ino ||
      opened.dev !== stat.dev ||
      current.ino !== stat.ino ||
      current.dev !== stat.dev ||
      opened.size !== stat.size
    )
      throw new Error('交割补充文件在读取时发生变化。');
    // Bound allocation and reads even if another process grows the file.
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await handle.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    const after = await handle.stat();
    if (
      length !== stat.size ||
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs
    )
      throw new Error('交割补充文件在读取时发生变化或超过大小限制。');
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}

export async function loadSettlement(directory, snapshot) {
  const resolved = await checkedDirectory(path.resolve(directory));
  const file = path.join(resolved, 'settlement.json');
  try {
    await fs.lstat(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const bytes = await readChecked(file, resolved, MAX_SETTLEMENT_JSON_BYTES);
  let data;
  try {
    data = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('交割补充 settlement.json 不是有效 JSON。');
  }
  validateSettlement(data, snapshot);
  const imageDirectory = await checkedDirectory(
    path.join(resolved, 'settlement'),
    resolved,
  );
  const images = new Map();
  let total = bytes.length;
  for (const source of data.sources) {
    const imageFile = path.join(resolved, source.file);
    const imageBytes = await readChecked(imageFile, imageDirectory, MAX_IMAGE);
    total += imageBytes.length;
    if (total > MAX_SETTLEMENT_BYTES)
      throw new Error('交割补充原图与数据合计超过 64 MB。');
    if (digest(imageBytes) !== source.sha256)
      throw new Error(`交割原图 ${source.id} 的 SHA-256 校验失败。`);
    const encoded = imageBytes.toString('base64');
    decodeImage(encoded, source.mime);
    await verifyImage(imageBytes);
    const { width, height } = await sharp(imageBytes).metadata();
    images.set(source.id, { mime: source.mime, data: encoded, width, height });
  }
  return { data, images };
}
