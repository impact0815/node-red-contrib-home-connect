'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SECRET_KEY = /(?:psk|initialization.?vector|iv64|^iv$|secret|token|password|credential|authorization|cookie|nonce|ship.?ski|private.?key|client.?id)/i;
const IDENTIFIER_KEY = /^(?:deviceID|serialNumber|mac|euiAddress|ssid|ipAddress|ipv4|ipv6)$/i;
const MAX_TRACE_ENTRIES = 500;

function sanitizeValue(value, key = '', seen = new WeakSet()) {
  if (SECRET_KEY.test(String(key))) return '[REDACTED]';
  if (IDENTIFIER_KEY.test(String(key))) return '[REDACTED_IDENTIFIER]';
  if (value === null || value === undefined) return value;
  if (Buffer.isBuffer(value)) return `[BUFFER ${value.length} bytes]`;
  if (typeof value !== 'object') return value;
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 200).map(item => sanitizeValue(item, '', seen));
  const result = {};
  for (const [name, item] of Object.entries(value).slice(0, 200)) result[name] = sanitizeValue(item, name, seen);
  return result;
}

function sanitizeProtocolMessage(message) {
  const safe = sanitizeValue(message);
  if (String(message?.resource || '') === '/ci/authentication' && Object.hasOwn(safe || {}, 'data')) {
    safe.data = '[REDACTED_AUTHENTICATION_DATA]';
  }
  return safe;
}

function resolveTraceFile(configuredPath) {
  const value = String(configuredPath || '').trim();
  if (!value) return '';
  if (!path.isAbsolute(value)) return '';
  try {
    const stat = fs.existsSync(value) ? fs.statSync(value) : null;
    return stat?.isDirectory() ? path.join(value, 'home-connect-local-protocol.jsonl') : value;
  } catch {
    return '';
  }
}

class LocalProtocolTrace {
  constructor(options = {}) {
    this.enabled = options.enabled === true;
    this.profile = `sha256:${crypto.createHash('sha256').update(String(options.profile || 'local-appliance')).digest('hex').slice(0, 12)}`;
    this.maxEntries = Math.max(20, Math.min(MAX_TRACE_ENTRIES, Number(options.maxEntries || 250)));
    this.entries = [];
    this.file = this.enabled ? resolveTraceFile(options.path) : '';
    this.writeError = null;
    if (this.file) {
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
        const handle = fs.openSync(this.file, 'a', 0o600);
        fs.closeSync(handle);
        fs.chmodSync(this.file, 0o600);
      } catch (error) {
        this.writeError = { code: error.code || 'TRACE_OPEN_FAILED', message: error.message };
        this.file = '';
      }
    }
  }

  record(direction, message, metadata = {}) {
    if (!this.enabled) return;
    const entry = {
      timestamp: new Date().toISOString(),
      direction: String(direction),
      profile: this.profile,
      ...sanitizeValue(metadata),
      message: sanitizeProtocolMessage(message)
    };
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) this.entries.splice(0, this.entries.length - this.maxEntries);
    if (this.file) {
      try { fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 }); }
      catch (error) { this.writeError = { code: error.code || 'TRACE_WRITE_FAILED', message: error.message }; }
    }
  }

  event(type, details = {}) {
    this.record('internal', { type, details }, { kind: 'lifecycle' });
  }

  snapshot() {
    return {
      enabled: this.enabled,
      file: this.file || undefined,
      writeError: this.writeError || undefined,
      entries: this.entries.map(entry => structuredClone(entry))
    };
  }
}

module.exports = {
  LocalProtocolTrace,
  sanitizeProtocolMessage,
  sanitizeValue,
  resolveTraceFile,
  MAX_TRACE_ENTRIES
};
