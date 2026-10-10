import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['scripts/build.mjs'], {
    cwd: root,
    stdio: 'inherit',
  });
  child.on('error', reject);
  child.on('exit', (code) =>
    code === 0 ? resolve() : reject(new Error(`UI build failed: ${code}`)),
  );
});
await fs.access(path.join(root, 'dist/client/index.html'));
await build({
  absWorkingDir: root,
  entryPoints: ['server/index.mjs'],
  outfile: 'desktop/service.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['sharp'],
});
