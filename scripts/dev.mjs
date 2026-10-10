import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
await fs.copyFile('supabase/setup.sql', 'public/cloud-setup.sql');
const children = [
  spawn(process.execPath, ['server/index.mjs'], { stdio: 'inherit' }),
  spawn(
    process.execPath,
    [
      'node_modules/vinext/dist/cli.js',
      'dev',
      '--hostname',
      '127.0.0.1',
      '--port',
      '5173',
    ],
    { stdio: 'inherit' },
  ),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  process.exitCode = code;
}
for (const child of children) {
  child.on('error', (error) => {
    console.error(error.message);
    stop(1);
  });
  child.on('exit', (code) => stop(code ?? 1));
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
