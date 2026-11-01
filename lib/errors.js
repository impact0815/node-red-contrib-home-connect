'use strict';

class HomeConnectError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'HomeConnectError';
    this.code = options.code || 'HOME_CONNECT_ERROR';
    this.status = options.status;
    this.details = options.details;
    this.retryAfter = options.retryAfter;
    if (options.cause) this.cause = options.cause;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      status: this.status,
      details: this.details,
      retryAfter: this.retryAfter
    };
  }
}

function retryAfterSeconds(value, now = Date.now()) {
  if (value === undefined || value === null || value === '') return undefined;
  const text = String(value);
  const seconds = Number(text);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(text);
  if (Number.isFinite(date)) return Math.max(0, Math.ceil((date - now) / 1000));
  const match = text.match(/(?:remaining\s+period\s+of|retry(?:\s+after|\s+in)?|blocked(?:\s+for|\s+during)?)[^0-9]{0,24}(\d+)\s*seconds?/i)
    || text.match(/(\d+)\s*seconds?[^.]{0,40}(?:remaining|retry|blocked)/i);
  return match ? Number(match[1]) : undefined;
}

function apiError(response, payload) {
  const raw = payload && payload.error !== undefined ? payload.error : payload;
  const source = typeof raw === 'string' ? { key: raw } : (raw || {});
  const description = source.description || source.message || payload?.error_description;
  const retryAfter = retryAfterSeconds(response.headers?.get?.('retry-after') || description);
  return new HomeConnectError(description || `Home Connect API returned HTTP ${response.status}`, {
    code: source.key || source.code || (typeof raw === 'string' ? raw : `HTTP_${response.status}`),
    status: response.status,
    details: source,
    retryAfter: retryAfter === undefined ? undefined : String(retryAfter)
  });
}

module.exports = { HomeConnectError, apiError, retryAfterSeconds };
