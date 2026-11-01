'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { HomeConnectError, retryAfterSeconds } = require('./errors');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_REQUESTS = 900;
const DEFAULT_MINIMUM_INTERVAL = 250;

const sleep = ms => new Promise(resolve => {
  const timer = setTimeout(resolve, ms);
});

function integerInRange(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(number)));
}

function createFileRateLimitStore(directory, key) {
  if (!directory || !key) return undefined;
  const digest = crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 24);
  const file = path.join(directory, `rate-limit-${digest}.json`);
  return {
    file,
    async load() {
      try {
        return JSON.parse(await fs.readFile(file, 'utf8'));
      } catch (error) {
        if (error.code === 'ENOENT' || error.name === 'SyntaxError') return undefined;
        throw error;
      }
    },
    async save(state) {
      await fs.mkdir(directory, { recursive: true });
      const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
      await fs.writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
      await fs.rename(temporary, file);
    }
  };
}

class SlidingWindowRateLimiter {
  constructor(options = {}) {
    this.windowMs = integerInRange(options.windowMs, DAY_MS, 1000, DAY_MS);
    this.configure(options);
    this.store = options.store;
    this.now = options.now || Date.now;
    this.wait = options.wait || sleep;
    this.state = { version: 1, timestamps: [], blockedUntil: 0 };
    this.lastRequestAt = 0;
    this.queue = Promise.resolve();
    this.ready = this._load();
  }

  configure(options = {}) {
    this.maxRequests = integerInRange(options.maxRequests, this.maxRequests || DEFAULT_MAX_REQUESTS, 1, 1000);
    this.minimumIntervalMs = integerInRange(
      options.minimumIntervalMs,
      this.minimumIntervalMs || DEFAULT_MINIMUM_INTERVAL,
      100,
      60000
    );
  }

  async _load() {
    if (!this.store?.load) return;
    const saved = await this.store.load();
    if (!saved || typeof saved !== 'object') return;
    this.state.timestamps = Array.isArray(saved.timestamps)
      ? saved.timestamps.map(Number).filter(Number.isFinite).sort((a, b) => a - b)
      : [];
    this.state.blockedUntil = Number.isFinite(Number(saved.blockedUntil)) ? Number(saved.blockedUntil) : 0;
    this._prune(this.now());
  }

  _prune(now) {
    const threshold = now - this.windowMs;
    this.state.timestamps = this.state.timestamps.filter(timestamp => timestamp > threshold);
    if (this.state.blockedUntil <= now) this.state.blockedUntil = 0;
  }

  async _save() {
    if (this.store?.save) await this.store.save(this.state);
  }

  _limitError(now, blockedUntil, source) {
    const retryAfter = Math.max(1, Math.ceil((blockedUntil - now) / 1000));
    return new HomeConnectError(
      `Home Connect request blocked by the local rate limiter. Retry in ${retryAfter} seconds.`,
      {
        code: 'LOCAL_RATE_LIMITED',
        status: 429,
        retryAfter: String(retryAfter),
        details: {
          source,
          maxRequests: this.maxRequests,
          periodSeconds: Math.ceil(this.windowMs / 1000),
          usedRequests: this.state.timestamps.length,
          remainingRequests: Math.max(0, this.maxRequests - this.state.timestamps.length),
          resetAt: new Date(blockedUntil).toISOString()
        }
      }
    );
  }

  async _acquire() {
    await this.ready;
    let now = this.now();
    this._prune(now);
    if (this.state.blockedUntil > now) {
      throw this._limitError(now, this.state.blockedUntil, 'server');
    }
    if (this.state.timestamps.length >= this.maxRequests) {
      this.state.blockedUntil = this.state.timestamps[0] + this.windowMs;
      await this._save();
      throw this._limitError(now, this.state.blockedUntil, 'local-budget');
    }

    const delay = Math.max(0, this.minimumIntervalMs - (now - this.lastRequestAt));
    if (delay) await this.wait(delay);
    now = this.now();
    this._prune(now);
    if (this.state.blockedUntil > now) {
      throw this._limitError(now, this.state.blockedUntil, 'server');
    }
    if (this.state.timestamps.length >= this.maxRequests) {
      this.state.blockedUntil = this.state.timestamps[0] + this.windowMs;
      await this._save();
      throw this._limitError(now, this.state.blockedUntil, 'local-budget');
    }

    this.state.timestamps.push(now);
    this.lastRequestAt = now;
    await this._save();
    return this.status();
  }

  acquire() {
    const run = this.queue.then(() => this._acquire(), () => this._acquire());
    this.queue = run;
    return run;
  }

  async recordServerLimit(value) {
    await this.ready;
    const now = this.now();
    this._prune(now);
    const seconds = retryAfterSeconds(value, now) || Math.ceil(this.windowMs / 1000);
    this.state.blockedUntil = Math.max(this.state.blockedUntil, now + seconds * 1000);
    await this._save();
    return this.status();
  }

  async status() {
    await this.ready;
    const now = this.now();
    this._prune(now);
    const localReset = this.state.timestamps.length >= this.maxRequests
      ? this.state.timestamps[0] + this.windowMs
      : 0;
    const resetAt = Math.max(localReset, this.state.blockedUntil);
    return {
      maxRequests: this.maxRequests,
      periodSeconds: Math.ceil(this.windowMs / 1000),
      minimumIntervalMs: this.minimumIntervalMs,
      usedRequests: this.state.timestamps.length,
      remainingRequests: Math.max(0, this.maxRequests - this.state.timestamps.length),
      blocked: resetAt > now,
      retryAfter: resetAt > now ? String(Math.max(1, Math.ceil((resetAt - now) / 1000))) : undefined,
      resetAt: resetAt > now ? new Date(resetAt).toISOString() : undefined
    };
  }
}

module.exports = {
  DAY_MS,
  DEFAULT_MAX_REQUESTS,
  DEFAULT_MINIMUM_INTERVAL,
  SlidingWindowRateLimiter,
  createFileRateLimitStore,
  integerInRange
};
