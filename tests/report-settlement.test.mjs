import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import {
  validateSettlement,
  settlementStats,
} from '../lib/report-settlement.ts';
import { loadSettlement } from '../server/report-settlement.mjs';
import { digest } from '../server/storage.mjs';

const snapshot = {
  id: '11111111-1111-4111-8111-111111111111',
  records: [{ id: '22222222-2222-4222-8222-222222222222' }],
};
const order = (patch = {}) => ({
  id: '101',
  symbol: 'EURUSD',
  direction: 'short',
  openedAt: '2026-09-15 10:00',
  closedAt: '2026-09-15 10:30',
  openPrice: 1.16,
  closePrice: 1.15,
  lots: 1,
  commission: -7,
  netProfit: 93,
  profitText: '93.00',
  tradeIds: [snapshot.records[0].id],
  match: 'matched',
  note: '',
  ...patch,
});
const settlement = (patch = {}) => ({
  snapshotId: snapshot.id,
  currency: 'USD',
  sourceLabel: '测试交割单',
  period: { from: '2026-09-15', to: '2026-09-16' },
  reportedNetProfit: 93,
  daily: [{ date: '2026-09-15', orderCount: 1, netProfit: 93 }],
  orders: [order()],
  aggregateGroups: [],
  notes: [],
  sources: [
    {
      id: 'source-1',
      file: 'settlement/source-1.png',
      mime: 'image/png',
      sha256: 'a'.repeat(64),
      title: '测试来源',
    },
  ],
  ...patch,
});
const cropped = () =>
  settlement({
    reportedNetProfit: 73.43,
    daily: [{ date: '2026-09-15', orderCount: 3, netProfit: 73.43 }],
    orders: [
      order(),
      order({
        id: '102',
        symbol: 'GBPUSD',
        netProfit: null,
        profitText: '+20.',
        commission: -2,
      }),
      order({
        id: '103',
        symbol: 'GBPUSD',
        netProfit: null,
        profitText: '-40.',
        commission: -3,
      }),
    ],
    aggregateGroups: [
      {
        orderIds: ['102', '103'],
        netProfit: -19.57,
        reason: '小数裁剪，按日汇总减去已知订单得到合计，不拆分金额。',
      },
    ],
  });
const fixture = async () => {
  await fs.mkdir(path.resolve('test-results'), { recursive: true });
  const directory = await fs.mkdtemp(
    path.resolve('test-results/report-settlement-'),
  );
  const bytes = await sharp({
    create: { width: 5, height: 4, channels: 3, background: '#abcdef' },
  })
    .png()
    .toBuffer();
  const data = settlement();
  data.sources[0].sha256 = digest(bytes);
  await fs.mkdir(path.join(directory, 'settlement'));
  await fs.writeFile(path.join(directory, 'settlement/source-1.png'), bytes);
  await fs.writeFile(
    path.join(directory, 'settlement.json'),
    JSON.stringify(data),
  );
  return { directory, bytes, data };
};

await test('Profit 已含佣金，统计不再扣除；保本计入胜率分母', () => {
  const data = settlement({
    orders: [order(), order({ id: '102', netProfit: 0, profitText: '0.00' })],
    daily: [{ date: '2026-09-15', orderCount: 2, netProfit: 93 }],
  });
  validateSettlement(data, snapshot);
  assert.deepEqual(settlementStats(data), {
    orderCount: 2,
    netProfit: 93,
    commission: -14,
    wins: 1,
    losses: 0,
    flats: 1,
    winRate: 50,
    symbols: [
      {
        symbol: 'EURUSD',
        orderCount: 2,
        netProfit: 93,
        commission: -14,
        wins: 1,
        losses: 0,
        flats: 1,
      },
    ],
  });
});

await test('裁剪金额只使用组总额，不伪造分配；可见正负用于输赢统计', () => {
  const data = cropped();
  validateSettlement(data, snapshot);
  const result = settlementStats(data);
  assert.equal(result.netProfit, 73.43);
  assert.equal(result.commission, -12);
  assert.equal(result.wins, 2);
  assert.equal(result.losses, 1);
  assert.equal(result.winRate, (2 / 3) * 100);
  assert.equal(
    result.symbols.find((group) => group.symbol === 'GBPUSD').netProfit,
    -19.57,
  );
  assert.equal(data.orders[1].netProfit, null);
  assert.equal(data.orders[2].netProfit, null);
  data.orders[1].profitText = '金额未显示';
  assert.equal(settlementStats(data).winRate, null);
  assert.equal(settlementStats(data).wins, 1);
  data.orders[1].profitText = '0.';
  assert.equal(settlementStats(data).winRate, null);
});

await test('快照、手记、日期、订单 ID 与匹配状态须有效', () => {
  const mutations = [
    (data) => {
      data.snapshotId = 'other';
    },
    (data) => {
      data.orders[0].tradeIds = ['other'];
    },
    (data) => {
      data.orders[0].tradeIds.push(snapshot.records[0].id);
    },
    (data) => {
      data.orders[0].match = 'unmatched';
    },
    (data) => {
      data.orders[0].openedAt = '2026-02-30 10:00';
    },
    (data) => {
      data.orders[0].closedAt = '2026-09-15 09:00';
    },
    (data) => {
      data.orders[0].openedAt = '2026-09-15 24:00';
    },
    (data) => {
      data.orders[0].netProfit = Infinity;
    },
    (data) => {
      data.orders[0].commission = 0.001;
    },
    (data) => {
      data.orders.push(order());
    },
  ];
  for (const mutate of mutations) {
    const data = settlement();
    mutate(data);
    assert.throws(() => validateSettlement(data, snapshot));
  }
});

await test('每日笔数、合计和总额按整数分核对', () => {
  const data = settlement({
    orders: [order({ netProfit: 0.1 }), order({ id: '102', netProfit: 0.2 })],
    daily: [{ date: '2026-09-15', orderCount: 2, netProfit: 0.3 }],
    reportedNetProfit: 0.3,
  });
  validateSettlement(data, snapshot);
  assert.equal(settlementStats(data).netProfit, 0.3);
  data.daily[0].orderCount = 1;
  assert.throws(() => validateSettlement(data, snapshot), /笔数/);
  data.daily[0].orderCount = 2;
  data.daily[0].netProfit = 0.31;
  assert.throws(() => validateSettlement(data, snapshot), /合计/);
  data.daily[0].netProfit = 0.3;
  data.reportedNetProfit = 0.31;
  assert.throws(() => validateSettlement(data, snapshot), /总计/);
  data.reportedNetProfit = 0.3;
  data.daily.push({ ...data.daily[0] });
  assert.throws(() => validateSettlement(data, snapshot), /日期重复/);
});

await test('聚合禁止已知金额、跨品种、跨日、重复行及未覆盖金额', () => {
  const mutations = [
    (data) => {
      data.aggregateGroups[0].orderIds[0] = '101';
    },
    (data) => {
      data.orders[2].symbol = 'AUDUSD';
    },
    (data) => {
      data.orders[2].openedAt = '2026-09-16 10:00';
      data.orders[2].closedAt = '2026-09-16 10:30';
    },
    (data) => {
      data.aggregateGroups[0].orderIds[1] = '102';
    },
    (data) => {
      data.aggregateGroups.push(structuredClone(data.aggregateGroups[0]));
    },
    (data) => {
      data.aggregateGroups = [];
    },
    (data) => {
      data.aggregateGroups[0].orderIds[1] = 'unknown';
    },
  ];
  for (const mutate of mutations) {
    const data = cropped();
    mutate(data);
    assert.throws(() => validateSettlement(data, snapshot), /聚合|缺失/);
  }
});

await test('来源固定路径、ID、格式、哈希与数组规模限制', () => {
  const mutations = [
    (data) => {
      data.sources[0].file = '../source-1.png';
    },
    (data) => {
      data.sources[0].file = 'settlement\\source-1.png';
    },
    (data) => {
      data.sources[0].id = 'source-2';
    },
    (data) => {
      data.sources[0].sha256 = 'not-a-hash';
    },
    (data) => {
      data.sources[0].mime = 'image/jpeg';
    },
    (data) => {
      data.sources.push({ ...data.sources[0] });
    },
    (data) => {
      data.orders = Array.from({ length: 1001 }, (_, i) =>
        order({ id: String(i) }),
      );
    },
    (data) => {
      data.notes = ['x'.repeat(6001)];
    },
  ];
  for (const mutate of mutations) {
    const data = settlement();
    mutate(data);
    assert.throws(() => validateSettlement(data, snapshot));
  }
});

await test('没有 settlement.json 的旧报告继续兼容', async () => {
  await fs.mkdir(path.resolve('test-results'), { recursive: true });
  const directory = await fs.mkdtemp(
    path.resolve('test-results/report-settlement-empty-'),
  );
  assert.equal(await loadSettlement(directory, snapshot), null);
});

await test('读取校验后的原图，返回内嵌图片并拒绝错误哈希', async () => {
  const { directory, bytes, data } = await fixture();
  const loaded = await loadSettlement(directory, snapshot);
  assert.deepEqual(loaded.data, data);
  assert.equal(loaded.images.get('source-1').mime, 'image/png');
  assert.deepEqual(
    Buffer.from(loaded.images.get('source-1').data, 'base64'),
    bytes,
  );
  data.sources[0].sha256 = '0'.repeat(64);
  await fs.writeFile(
    path.join(directory, 'settlement.json'),
    JSON.stringify(data),
  );
  await assert.rejects(loadSettlement(directory, snapshot), /SHA-256/);
});

await test('拒绝虽有正确哈希但无法解码的原图', async () => {
  const { directory, data } = await fixture();
  const invalid = Buffer.from('89504e470d0a1a0a0000000000000000', 'hex');
  data.sources[0].sha256 = digest(invalid);
  await fs.writeFile(path.join(directory, 'settlement/source-1.png'), invalid);
  await fs.writeFile(
    path.join(directory, 'settlement.json'),
    JSON.stringify(data),
  );
  await assert.rejects(loadSettlement(directory, snapshot), /无法解码/);
});

await test('拒绝 settlement 目录链接', async (t) => {
  const { directory } = await fixture();
  const original = path.join(directory, 'settlement');
  const relocated = path.join(directory, 'settlement-original');
  await fs.rename(original, relocated);
  try {
    await fs.symlink(
      relocated,
      original,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  } catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code))
      return t.skip('当前环境不允许创建目录链接。');
    throw error;
  }
  await assert.rejects(loadSettlement(directory, snapshot), /链接/);
});
