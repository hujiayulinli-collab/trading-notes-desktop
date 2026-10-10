import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { newTrade } from '../lib/journal.ts';
import { JournalStore, atomicJSON } from '../server/storage.mjs';
import { createReport, getReport, downloadReport } from '../server/reports.mjs';
import { startReportAnalysis } from '../server/report-api.mjs';
import { createApp } from '../server/index.mjs';

const KEY = 'sk-synthetic-NEVER-PERSIST-87934';
const config = { apiKey: KEY, model: 'gpt-5.4-mini', includeImages: true };
const fixture = async (count = 1, withImages = true) => {
  await fs.mkdir(path.resolve('test-results'), { recursive: true });
  const root = await fs.mkdtemp(path.resolve('test-results/report-api-'));
  const store = await new JournalStore(root).init();
  const records = [],
    originals = [];
  for (let i = 0; i < count; i++) {
    const bytes = await sharp({
      create: {
        width: 6,
        height: 4,
        channels: 3,
        background: { r: 20 + i, g: 70, b: 50 },
      },
    })
      .png()
      .toBuffer();
    const shot = withImages
      ? await store.upload({
          name: `合成-${i}.png`,
          mime: 'image/png',
          data: bytes.toString('base64'),
        })
      : null;
    originals.push(bytes);
    records.push({
      ...newTrade(),
      symbol: 'SYNTHETIC',
      date: '2026-09-08',
      time: `09:${String(i).padStart(2, '0')}`,
      category: i % 2 ? 'review' : 'live',
      status: 'closed',
      resultR: i % 2 ? -1 : 1,
      riskPercent: 2,
      entryScore: i % 2 ? 85 : 0,
      screenshots: shot ? [shot] : [],
    });
  }
  const outside = {
    ...newTrade(),
    symbol: 'UNSELECTED-PRIVATE',
    date: '2026-09-08',
  };
  await store.save([...records, outside], 0, undefined, 0.5);
  const report = await createReport(root, store, {
    from: '2026-09-07',
    to: '2026-09-13',
    category: 'all',
    title: '合成 API 周报',
    source: 'local',
    revision: 1,
    recordIds: records.map((t) => t.id),
  });
  return { root, store, report, records, originals };
};
const output = (value, status = 'completed') =>
  Response.json({
    status,
    output: [
      {
        type: 'message',
        content: [{ type: 'output_text', text: JSON.stringify(value) }],
      },
    ],
  });
function reply(body) {
  const properties = body.text.format.schema.properties;
  if (body.text.format.name === 'weekly_trade_batch')
    return {
      trades: properties.trades.items.properties.id.enum.map((id) => ({
        id,
        observation: '合成记录中的事实。',
        assessment: '这只是自动测试分析。',
        improvement: '补全执行记录。',
      })),
      reviewedScreenshotIds: properties.reviewedScreenshotIds.items.enum || [],
      limitations: '仅用于程序验证，不是真实交易判断。',
    };
  return {
    summary: '合成周总结。',
    strengths: [
      {
        text: '信息可核对。',
        tradeIds: [
          properties.strengths.items.properties.tradeIds.items.enum[0],
        ],
      },
    ],
    problems: [],
    nextWeek: ['完善执行记录。'],
    questions: ['需补充哪些信息？'],
    limitations: '样本只用于自动测试。',
  };
}
const mock = (calls, transform) => async (url, options) => {
  assert.equal(url, 'https://api.openai.com/v1/responses');
  assert.equal(options.headers.Authorization, `Bearer ${KEY}`);
  const body = JSON.parse(options.body);
  assert.equal(body.store, false);
  assert.equal(body.truncation, 'disabled');
  assert.equal(body.text.format.type, 'json_schema');
  assert.equal(body.text.format.strict, true);
  assert.ok(!options.body.includes(KEY));
  assert.ok(!options.body.includes('UNSELECTED-PRIVATE'));
  const checkSchema = (schema) => {
    if (schema.type === 'object') {
      assert.equal(schema.additionalProperties, false);
      assert.deepEqual(
        schema.required.sort(),
        Object.keys(schema.properties).sort(),
      );
      Object.values(schema.properties).forEach(checkSchema);
    } else if (schema.type === 'array') checkSchema(schema.items);
  };
  checkSchema(body.text.format.schema);
  calls.push(body);
  return transform ? transform(body, calls.length) : output(reply(body));
};
async function assertNoKey(report) {
  for (const file of await fs.readdir(report.directory, { recursive: true })) {
    const full = path.join(report.directory, file);
    if ((await fs.stat(full)).isFile())
      assert.ok(
        !(await fs.readFile(full)).includes(KEY),
        `${file} must not contain the key`,
      );
  }
  assert.ok(!JSON.stringify(report).includes(KEY));
}

test('多批 API 完整覆盖所选笔记和截图，汇总分类统计，HTML 保留原图且密钥不落盘', async () => {
  const { root, report, records, originals } = await fixture(5);
  const calls = [];
  const job = await startReportAnalysis(root, report.id, config, mock(calls));
  assert.equal(job.entry.status, 'running');
  await job.done;
  const entry = await getReport(root, report.id);
  assert.equal(entry.status, 'ready', entry.error);
  assert.equal(entry.includeImages, true);
  assert.equal(entry.model, config.model);
  assert.equal(calls.length, 3);
  const batches = calls.filter(
    (b) => b.text.format.name === 'weekly_trade_batch',
  );
  assert.deepEqual(
    batches
      .flatMap(
        (b) => b.text.format.schema.properties.trades.items.properties.id.enum,
      )
      .sort(),
    records.map((t) => t.id).sort(),
  );
  const images = batches.flatMap((b) =>
    b.input[0].content.filter((c) => c.type === 'input_image'),
  );
  assert.equal(images.length, 5);
  for (const bytes of originals)
    assert.ok(
      images.some((c) => c.image_url.endsWith(bytes.toString('base64'))),
    );
  assert.match(calls[2].input[0].content[0].text, /"category":"review"/);
  assert.match(calls[0].input[0].content[0].text, /基础 1R = 0.5%/);
  assert.match(calls[2].input[0].content[0].text, /"baseRiskPercent":0.5/);
  assert.match(calls[2].input[0].content[0].text, /"sumR":12/);
  assert.match(calls[2].input[0].content[0].text, /"sumR":-8/);
  assert.match(calls[0].input[0].content[0].text, /"entryScore":0/);
  assert.match(calls[2].input[0].content[0].text, /"entryScore":85/);
  const html = (await downloadReport(root, report.id)).html.toString();
  for (const bytes of originals)
    assert.ok(html.includes(bytes.toString('base64')));
  assert.match(html, /图表核对：已查看 5 \/ 5/);
  await (
    await startReportAnalysis(root, report.id, config, mock(calls))
  ).done;
  assert.equal(calls.length, 3, 'completed report must not call the API again');
  await assertNoKey(entry);
});

test('只发文字时不给 GPT 图片，HTML 仍附原图并说明没有图表分析', async () => {
  const { root, report, originals } = await fixture();
  const calls = [];
  await (
    await startReportAnalysis(
      root,
      report.id,
      { ...config, includeImages: false },
      mock(calls),
    )
  ).done;
  assert.ok(
    calls.every((b) =>
      b.input[0].content.every((c) => c.type !== 'input_image'),
    ),
  );
  const html = (await downloadReport(root, report.id)).html.toString();
  assert.ok(html.includes(originals[0].toString('base64')));
  assert.match(html, /图表核对：已查看 0 \/ 1/);
  assert.match(html, /仅分析文字，未发送截图/);
  assert.equal((await getReport(root, report.id)).includeImages, false);
});

test('多批较长局限说明由最终汇总归纳，不因拼接超过字段上限而无法完成', async () => {
  const { root, report } = await fixture(28, false);
  const calls = [];
  await (
    await startReportAnalysis(
      root,
      report.id,
      { ...config, includeImages: false },
      mock(calls, (body) => {
        const value = reply(body);
        if (body.text.format.name === 'weekly_trade_batch')
          value.limitations = '资料不足，'.repeat(360);
        else
          assert.ok(
            body.input[0].content[0].text.includes('资料不足，'.repeat(360)),
          );
        return output(value);
      }),
    )
  ).done;
  const entry = await getReport(root, report.id);
  assert.equal(entry.status, 'ready', entry.error);
  assert.equal(calls.length, 8);
});

test('中途失败重试复用已完成批次，源记录改变后仍使用原快照', async () => {
  const { root, report, store, records } = await fixture(5);
  const calls = [];
  await (
    await startReportAnalysis(
      root,
      report.id,
      config,
      mock(calls, (body, n) =>
        n === 2
          ? Response.json({ error: KEY }, { status: 429 })
          : output(reply(body)),
      ),
    )
  ).done;
  let entry = await getReport(root, report.id);
  assert.equal(entry.status, 'failed');
  assert.match(entry.error, /额度/);
  await assert.rejects(() => downloadReport(root, report.id));
  await store.save(
    records.map((t) => ({ ...t, symbol: 'CHANGED-AFTER-SNAPSHOT' })),
    1,
  );
  await (
    await startReportAnalysis(root, report.id, config, mock(calls))
  ).done;
  entry = await getReport(root, report.id);
  assert.equal(entry.status, 'ready', entry.error);
  assert.equal(
    calls.length,
    4,
    'retry calls only the failed batch and summary',
  );
  assert.equal(
    calls.filter(
      (b) =>
        b.text.format.schema.properties.trades?.items.properties.id.enum
          .length === 4,
    ).length,
    1,
  );
  assert.ok(!JSON.stringify(calls).includes('CHANGED-AFTER-SNAPSHOT'));
  await assertNoKey(entry);
});

test('错误、截断、拒绝及错误引用均不能成为已完成报告', async (t) => {
  const cases = {
    unauthorized: () => Response.json({ error: KEY }, { status: 401 }),
    incomplete: (body) => output(reply(body), 'incomplete'),
    refusal: () =>
      Response.json({
        status: 'completed',
        output: [{ content: [{ type: 'refusal', refusal: KEY }] }],
      }),
    malformed: () => new Response('{bad json', { status: 200 }),
    missingTrade: (body) => output({ ...reply(body), trades: [] }),
    wrongTrade: (body) =>
      output({
        ...reply(body),
        trades: [{ ...reply(body).trades[0], id: crypto.randomUUID() }],
      }),
    wrongImage: (body) =>
      output({ ...reply(body), reviewedScreenshotIds: [crypto.randomUUID()] }),
  };
  for (const [name, respond] of Object.entries(cases))
    await t.test(name, async () => {
      const { root, report } = await fixture();
      const calls = [];
      await (
        await startReportAnalysis(root, report.id, config, mock(calls, respond))
      ).done;
      const entry = await getReport(root, report.id);
      assert.equal(entry.status, 'failed');
      assert.equal(calls.length, 1);
      await assert.rejects(() => downloadReport(root, report.id));
      await assertNoKey(entry);
    });
});

test('HTTP 生成快速返回进度，重复请求和单笔复盘互斥，跨站请求被拒绝', async () => {
  const { root, report } = await fixture();
  const calls = [];
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const app = await createApp({
    root,
    fetcher: mock(calls, async (body, n) => {
      if (n === 1) await blocked;
      return output(reply(body));
    }),
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const post = (endpoint, payload, headers = {}) =>
    fetch(`${url}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(payload),
    });
  try {
    assert.equal(
      (
        await post(`/api/reports/${report.id}/analyze`, config, {
          Origin: 'https://example.com',
        })
      ).status,
      403,
    );
    const start = await post(`/api/reports/${report.id}/analyze`, config);
    assert.equal(start.status, 202);
    assert.equal((await start.json()).status, 'running');
    assert.equal(
      (await fetch(`${url}/api/reports/${report.id}`, { method: 'DELETE' }))
        .status,
      409,
    );
    assert.equal(
      (
        await fetch(`${url}/api/reports/${report.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ archived: true }),
        })
      ).status,
      409,
    );
    assert.equal(
      (await post(`/api/reports/${report.id}/analyze`, config)).status,
      429,
    );
    assert.equal((await post('/api/analyze', {})).status, 429);
    assert.equal(
      (await (await fetch(`${url}/api/reports/${report.id}`)).json()).status,
      'running',
    );
    release();
    for (let i = 0; i < 200; i++) {
      if ((await getReport(root, report.id)).status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal((await getReport(root, report.id)).status, 'ready');
    assert.equal(calls.length, 2);
    assert.equal(
      (await fetch(`${url}/api/reports/${report.id}/download`)).status,
      200,
    );
  } finally {
    release();
    await new Promise((resolve) => app.server.close(resolve));
  }
});

test('中断可恢复，更换图文选项会重新分析，损坏图片在 API 调用前阻止生成', async () => {
  const { root, report, records } = await fixture();
  await atomicJSON(path.join(report.directory, 'api-state.json'), {
    status: 'running',
    progress: 'old process',
  });
  assert.equal((await getReport(root, report.id)).status, 'failed');
  const calls = [];
  await (
    await startReportAnalysis(
      root,
      report.id,
      config,
      mock(calls, (body, n) =>
        n === 2 ? Response.json({}, { status: 429 }) : output(reply(body)),
      ),
    )
  ).done;
  assert.equal(calls.length, 2);
  await (
    await startReportAnalysis(
      root,
      report.id,
      { ...config, includeImages: false },
      mock(calls),
    )
  ).done;
  assert.equal(
    calls.length,
    4,
    'different image setting invalidates old checkpoints',
  );
  const second = await fixture();
  await fs.writeFile(
    path.join(
      second.report.directory,
      'screenshots',
      `${second.records[0].screenshots[0].id}.png`,
    ),
    'broken',
  );
  await (
    await startReportAnalysis(
      second.root,
      second.report.id,
      config,
      mock(calls),
    )
  ).done;
  assert.equal(
    (await getReport(second.root, second.report.id)).status,
    'failed',
  );
  assert.equal(calls.length, 4, 'corrupt images must never reach GPT');
  await assert.rejects(
    () =>
      startReportAnalysis(
        root,
        report.id,
        { ...config, apiKey: '' },
        mock(calls),
      ),
    /API Key/,
  );
  assert.ok(records.length);
});
