'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSSE, parseSSEBlock } = require('../lib/sse');

test('SSE block parser combines data lines', () => {
  const result = parseSSEBlock('id: 7\nevent: STATUS\ndata: {"a":\ndata: 1}\nretry: 2500');
  assert.equal(result.id, '7');
  assert.equal(result.event, 'STATUS');
  assert.equal(result.data, '{"a":\n1}');
  assert.equal(result.retry, 2500);
});

test('SSE stream parser handles arbitrary chunk boundaries and comments', async () => {
  const chunks = [': keep-alive\n\nevent: NOT', 'IFY\ndata: {"value":1}\n\n', 'event: STATUS\ndata: ok\n\n'];
  const body = new ReadableStream({ start(controller) { chunks.forEach(chunk => controller.enqueue(new TextEncoder().encode(chunk))); controller.close(); } });
  const result = [];
  for await (const message of parseSSE(body)) result.push(message);
  assert.equal(result.length, 3);
  assert.equal(result[0].event, 'KEEP-ALIVE');
  assert.equal(result[0].comment, 'keep-alive');
  assert.equal(result[0].data, '');
  assert.equal(result[1].event, 'NOTIFY');
  assert.equal(result[1].data, '{"value":1}');
  assert.equal(result[2].event, 'STATUS');
});
