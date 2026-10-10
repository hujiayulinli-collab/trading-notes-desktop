import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createId } from '../lib/id.ts';
import { newTrade, validateRecords, conditionGroups } from '../lib/journal.ts';
import { sha256 } from '../lib/journal-backup.ts';

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function withCrypto(implementation, run) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: implementation,
  });
  try {
    return run();
  } finally {
    Object.defineProperty(globalThis, 'crypto', original);
  }
}

test('局域网 HTTP 不提供 randomUUID 时仍可创建有效手记与自定义模块', () => {
  withCrypto(
    { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) },
    () => {
      assert.equal(globalThis.crypto.randomUUID, undefined);
      const records = Array.from({ length: 100 }, () => ({
        ...newTrade(),
        symbol: 'TEST',
      }));
      assert.doesNotThrow(() => validateRecords(records));
      assert.equal(new Set(records.map((trade) => trade.id)).size, 100);
      records.forEach((trade) => assert.match(trade.id, uuidV4));
      const group = { id: createId(), title: 'OB', options: ['15m OB'] };
      assert.match(group.id, uuidV4);
      assert.deepEqual(conditionGroups([group]), [group]);
    },
  );
});

test('UUID 回退保留随机字节并设置 v4 版本与 RFC 变体位', () => {
  withCrypto(
    { getRandomValues: (bytes) => bytes.fill(255) },
    () => assert.equal(createId(), 'ffffffff-ffff-4fff-bfff-ffffffffffff'),
  );
  withCrypto(
    { getRandomValues: (bytes) => bytes.fill(0) },
    () => assert.equal(createId(), '00000000-0000-4000-8000-000000000000'),
  );
});

test('安全上下文优先使用浏览器自带 UUID，保留 Crypto 方法接收者', () => {
  const uuid = 'bed75330-0ca9-490e-9f76-45c6f9f782a8';
  const implementation = {
    randomUUID() {
      assert.equal(this, implementation);
      return uuid;
    },
    getRandomValues() {
      assert.fail('原生 randomUUID 可用时无需回退');
    },
  };
  withCrypto(implementation, () => assert.equal(createId(), uuid));
});

test('HTTP 云端备份明确提示安全连接要求，不跳过截图校验', async () => {
  const result = withCrypto(
    { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) },
    () => sha256(new Uint8Array([1, 2, 3])),
  );
  await assert.rejects(result, /云端截图校验需要安全连接/);
});
