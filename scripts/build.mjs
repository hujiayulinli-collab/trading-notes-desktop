import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await fs.copyFile(
  path.join(root, 'supabase/setup.sql'),
  path.join(root, 'public/cloud-setup.sql'),
);
const args =
  process.platform === 'win32'
    ? [
        '--import',
        pathToFileURL(path.join(root, 'scripts/windows-build-exit.mjs')).href,
      ]
    : [];
const child = spawn(
  process.execPath,
  [...args, path.join(root, 'node_modules/vinext/dist/cli.js'), 'build'],
  { cwd: root, stdio: 'inherit' },
);
child.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
