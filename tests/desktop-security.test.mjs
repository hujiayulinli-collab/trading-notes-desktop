import test from 'node:test';
import assert from 'node:assert/strict';
import { isAppUrl, allowRequest, validSender } from '../desktop/security.mjs';
const origin = 'http://127.0.0.1:32123';
void test('desktop rejects outside hosts, other local ports and external protocols', () => {
  for (const url of [
    'https://example.com',
    'http://127.0.0.1:32124/',
    'http://127.0.0.1:32123.evil.com',
    'file:///tmp/a',
    'javascript:alert(1)',
  ]) {
    assert.equal(isAppUrl(url, origin), false);
    assert.equal(allowRequest(url, origin), false);
  }
  assert.equal(isAppUrl(origin + '/api/journal', origin), true);
  assert.equal(allowRequest('blob:' + origin + '/1234', origin), true);
});
void test('only the trusted main renderer frame may invoke desktop operations', () => {
  const frame = { url: origin + '/' };
  const contents = { mainFrame: frame };
  const window = { webContents: contents };
  assert.equal(
    validSender({ sender: contents, senderFrame: frame }, window, origin),
    true,
  );
  assert.equal(
    validSender({ sender: {}, senderFrame: frame }, window, origin),
    false,
  );
  assert.equal(
    validSender(
      { sender: contents, senderFrame: { url: origin } },
      window,
      origin,
    ),
    false,
  );
  frame.url = 'https://example.com';
  assert.equal(
    validSender({ sender: contents, senderFrame: frame }, window, origin),
    false,
  );
});
