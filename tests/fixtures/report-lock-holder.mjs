import { acquireReportLock } from '../../server/reports.mjs';

const lock = await acquireReportLock(process.argv[2], process.argv[3]);
process.stdout.write('LOCKED\n');
try {
  await new Promise((resolve) => {
    process.stdin.once('data', resolve);
    process.stdin.once('end', resolve);
  });
} finally {
  await lock.release();
  process.stdin.pause();
}
