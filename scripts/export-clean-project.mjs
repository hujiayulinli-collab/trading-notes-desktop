import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const sourceDirectories = ['app', 'components', 'hooks', 'lib', 'server', 'tests'];
const sourceExtensions = new Set(['.ts', '.tsx', '.mjs', '.css']);
const fixedFiles = [
  '.gitignore', '.oxfmtrc.json', '.oxlintrc.json', 'components.json',
  'next.config.ts', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
  'tsconfig.json', 'vite.config.ts', 'README.md',
  '安装与构建.cmd', '启动盘口手记.cmd', '导出纯净项目.cmd',
  '启动盘口手记（局域网）.cmd', '配置局域网访问.cmd',
  'public/favicon.svg', 'public/cloud-setup.sql',
  'supabase/setup.sql', 'supabase/开始使用云端.md',
  'scripts/build-weekly-report.mjs', 'scripts/build.mjs', 'scripts/dev.mjs',
  'scripts/windows-build-exit.mjs', 'scripts/runtime.ps1',
  'scripts/setup.ps1', 'scripts/start.ps1', 'scripts/export-clean-project.mjs',
  'scripts/export-clean-project.ps1',
  'scripts/lan-firewall.ps1',
  'docs/开始使用.md', 'docs/ai-prompts/单笔交易复盘.md',
  'docs/ai-prompts/周总结复盘.md', 'docs/ai-prompts/交易规则填写模板.md',
];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Copy reviewed source locations only. Never traverse user data or build output.
export async function cleanFileList(root) {
  const files = [...fixedFiles];
  async function walk(relative) {
    const directory = path.join(root, relative);
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error(`源码目录不能是链接：${relative}`);
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      const name = `${relative}/${item.name}`;
      if (item.isSymbolicLink()) throw new Error(`不能导出链接：${name}`);
      if (item.name.startsWith('.')) continue;
      if (item.isDirectory()) await walk(name);
      else if (item.isFile() && sourceExtensions.has(path.extname(item.name)))
        files.push(name);
    }
  }
  for (const directory of sourceDirectories) await walk(directory);
  // Check every path component, including ancestors of individually allowed files.
  for (const relative of files) {
    let current = root;
    const parts = relative.split('/');
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() ||
          (i === parts.length - 1 ? !stat.isFile() : !stat.isDirectory()))
        throw new Error(`无法安全读取导出文件：${relative}`);
    }
  }
  return files.sort();
}

export async function exportCleanProject(root, destination) {
  root = path.resolve(root);
  destination = path.resolve(destination);
  const files = await cleanFileList(root);
  // Refuse reuse: an existing folder might contain private files from a prior run.
  await fs.mkdir(destination, { recursive: false });
  const entries = [];
  for (const relative of files) {
    const bytes = await fs.readFile(path.join(root, relative));
    const target = path.join(destination, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes, { flag: 'wx' });
    entries.push({ path: relative, bytes: bytes.length, sha256: sha256(bytes) });
  }
  await fs.writeFile(path.join(destination, 'share-manifest.json'), JSON.stringify({
    formatVersion: 1,
    kind: 'clean-source-project',
    createdAt: new Date().toISOString(),
    containsPersonalData: false,
    dependenciesIncluded: false,
    buildIncluded: false,
    files: entries,
  }, null, 2) + '\n', { flag: 'wx' });
  return { directory: destination, fileCount: entries.length + 1 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const output = path.join(root, 'outputs');
    await fs.mkdir(output, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
    const destination = path.join(output, `pankou-journal-clean-${stamp}`);
    const result = await exportCleanProject(root, destination);
    if (process.platform === 'win32') {
      const archive = `${destination}.zip`;
      const literal = (value) => `'${value.replaceAll("'", "''")}'`;
      const command = `$ErrorActionPreference = 'Stop'\nAdd-Type -AssemblyName System.IO.Compression.FileSystem\n[IO.Compression.ZipFile]::CreateFromDirectory(${literal(destination)}, ${literal(archive)}, [IO.Compression.CompressionLevel]::Optimal, $true)`;
      const zip = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive',
        '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
      { encoding: 'utf8', windowsHide: true });
      if (zip.error || zip.status !== 0)
        throw new Error(`源码已导出，压缩失败：${zip.error?.message || zip.stderr}`);
      const bytes = await fs.readFile(archive);
      await fs.writeFile(`${archive}.sha256`, `${sha256(bytes)}  ${path.basename(archive)}\n`, { flag: 'wx' });
      result.archive = archive;
      result.archiveBytes = bytes.length;
    }
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
