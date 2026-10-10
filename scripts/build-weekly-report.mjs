import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { completeReport, reportDirectory } from '../server/reports.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  const id = process.argv[2];
  if (process.argv.length !== 3)
    throw new Error('用法：node scripts/build-weekly-report.mjs 报告编号');
  const file = path.join(reportDirectory(root, id), 'analysis.json');
  if ((await fs.stat(file)).size > 1024 * 1024)
    throw new Error('分析结果超过 1 MB。');
  const analysis = JSON.parse(
    (await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''),
  );
  const report = await completeReport(root, id, analysis);
  console.log(
    `报告已生成：${path.join(report.directory, 'report.html')}\n在盘口手记“周总结”中刷新报告状态，即可下载。`,
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
