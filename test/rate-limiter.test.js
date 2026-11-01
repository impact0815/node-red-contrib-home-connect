'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SlidingWindowRateLimiter,
  createFileRateLimitStore,
  integerInRange
} = require('../lib/rate-limiter');

function memoryStore(initial) {
  let value = initial;
  return {
    async load() { return value ? structuredClone(value) : undefined; },
    async save(next) { value = structuredClone(next); },
    read() { return structuredClone(value); }
  };
}

test('sliding-window limiter blocks before the configured daily budget is exceeded', async () => {
  let now = 1000;
  const store = memoryStore();
  const limiter = new SlidingWindowRateLimiter({
    maxRequests: 2,
    windowMs: 1000,
    minimumIntervalMs: 100,
    now: () => now,
    wait: async milliseconds => { now += milliseconds; },
    store
  });

  await limiter.acquire();
  await limiter.acquire();
  await assert.rejects(() => limiter.acquire(), error => {
    assert.equal(error.code, 'LOCAL_RATE_LIMITED');
    assert.equal(error.status, 429);
    assert.equal(error.details.source, 'local-budget');
    assert.equal(error.details.usedRequests, 2);
    return true;
  });
  assert.equal(store.read().timestamps.length, 2);

  now = 2101;
  const status = await limiter.acquire();
  assert.equal(status.usedRequests, 1);
  assert.equal(status.remainingRequests, 1);
});

test('server cooldown is persisted and prevents further outbound request permits', async () => {
  let now = 5000;
  const store = memoryStore();
  const limiter = new SlidingWindowRateLimiter({
    maxRequests: 900,
    windowMs: 86400000,
    minimumIntervalMs: 100,
    now: () => now,
    wait: async milliseconds => { now += milliseconds; },
    store
  });
  await limiter.acquire();
  await limiter.recordServerLimit('The rate limit "1000 calls in 1 day" was reached. Requests are blocked during the remaining period of 75502 seconds.');
  const status = await limiter.status();
  assert.equal(status.blocked, true);
  assert.equal(status.retryAfter, '75502');
  await assert.rejects(() => limiter.acquire(), { code: 'LOCAL_RATE_LIMITED', retryAfter: '75502' });

  const restored = new SlidingWindowRateLimiter({
    maxRequests: 900,
    windowMs: 86400000,
    minimumIntervalMs: 100,
    now: () => now,
    wait: async () => {},
    store
  });
  await assert.rejects(() => restored.acquire(), { code: 'LOCAL_RATE_LIMITED', retryAfter: '75502' });
});

test('configuration is bounded to safe supported values', () => {
  assert.equal(integerInRange(1200, 900, 1, 1000), 1000);
  assert.equal(integerInRange(0, 900, 1, 1000), 1);
  assert.equal(integerInRange('invalid', 900, 1, 1000), 900);
  assert.equal(typeof createFileRateLimitStore(undefined, 'key'), 'undefined');
});
