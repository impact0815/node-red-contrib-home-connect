'use strict';

const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const net = require('node:net');
const tls = require('node:tls');
const { EventEmitter } = require('node:events');
const { HomeConnectError } = require('./errors');
const { decodeBase64Url } = require('./local-crypto');

const WEBSOCKET_PATH = '/homeconnect';
const TLS_PSK_CIPHERS = 'ECDHE-PSK-CHACHA20-POLY1305:PSK-AES128-CBC-SHA256:PSK-AES256-CBC-SHA:PSK';

function cleanHost(value) {
  const host = String(value || '').trim().replace(/^\[|\]$/g, '');
  if (!host || /[\s/@?#]/.test(host) || /^[a-z]+:\/\//i.test(host)) {
    throw new HomeConnectError('A plain local hostname or IP address is required.', { code: 'LOCAL_HOST_INVALID' });
  }
  return host;
}

function privateIp(address) {
  const plain = String(address).split('%')[0].toLowerCase();
  if (net.isIPv4(plain)) {
    const parts = plain.split('.').map(Number);
    return parts[0] === 10 || (parts[0] === 169 && parts[1] === 254)
      || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
      || (parts[0] === 192 && parts[1] === 168);
  }
  if (net.isIPv6(plain)) {
    return plain.startsWith('fe8') || plain.startsWith('fe9')
      || plain.startsWith('fea') || plain.startsWith('feb') || plain.startsWith('fc') || plain.startsWith('fd');
  }
  return false;
}

async function resolveLocalHost(host, lookup = dns.lookup) {
  const plain = cleanHost(host);
  const ip = net.isIP(plain.split('%')[0]);
  const addresses = ip ? [{ address: plain.split('%')[0] }] : await lookup(plain, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(entry => !privateIp(entry.address))) {
    throw new HomeConnectError('The configured appliance host does not resolve exclusively to a private or link-local address.', {
      code: 'LOCAL_HOST_NOT_PRIVATE'
    });
  }
  return { host: plain, address: ip ? plain : addresses[0].address };
}

async function assertLocalHost(host, lookup = dns.lookup) { return (await resolveLocalHost(host, lookup)).host; }

function transportError(cause, mode = 'TLS') {
  if (cause instanceof HomeConnectError) return cause;
  const code = String(cause?.code || '');
  const message = String(cause?.message || cause || '');
  const combined = `${code} ${message}`.toLowerCase();
  const details = { transport: String(mode).toUpperCase(), causeCode: code || undefined };
  if (['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'EAI_AGAIN', 'ENOTFOUND', 'ETIMEDOUT'].includes(code)) {
    return new HomeConnectError('Could not reach the local appliance over the network.', {
      code: 'LOCAL_NETWORK_ERROR',
      details: {
        ...details,
        category: 'network',
        hintDe: code === 'EHOSTUNREACH'
          ? 'Kein Netzwerkpfad zum Gerät. Geräte-Strom/Standby, IP, WLAN, VLAN-Routing und Firewall prüfen.'
          : 'Geräte-Strom/Standby, IP/Hostname, WLAN, VLAN-Routing, Firewall und Zielport prüfen.',
        hintEn: code === 'EHOSTUNREACH'
          ? 'No network path to the appliance. Check power/standby, IP, Wi-Fi, VLAN routing, and firewall.'
          : 'Check appliance power/standby, IP/hostname, Wi-Fi, VLAN routing, firewall, and target port.'
      },
      cause
    });
  }
  if (/psk|pre.?shared|bad record mac|decrypt|unknown identity|identity unknown|handshake failure/.test(combined)) {
    return new HomeConnectError('The local appliance rejected the configured profile key.', {
      code: 'LOCAL_PROFILE_KEY_REJECTED',
      details: {
        ...details, category: 'profile',
        hintDe: 'Profil gehört nicht zu diesem Gerät oder PSK/IV ist unvollständig. Profil neu herunterladen; Schlüssel nie bearbeiten.',
        hintEn: 'The profile does not match this appliance or its PSK/IV is incomplete. Download it again; never edit key material.'
      },
      cause
    });
  }
  if (/no shared cipher|unsupported protocol|protocol version|wrong version|cipher.*unsupported|legacy sigalg/.test(combined)) {
    return new HomeConnectError('The appliance does not support the selected local transport or TLS profile.', {
      code: 'LOCAL_TRANSPORT_UNSUPPORTED',
      details: {
        ...details, category: 'transport',
        hintDe: 'Auto verwenden und die im Profil deklarierte Verbindungsart prüfen; Node.js/OpenSSL muss TLS-PSK unterstützen.',
        hintEn: 'Use Auto and verify the transport declared by the profile; Node.js/OpenSSL must support TLS-PSK.'
      },
      cause
    });
  }
  return new HomeConnectError('Could not connect to the local appliance.', {
    code: 'LOCAL_CONNECT_FAILED',
    details: { ...details, category: 'transport' },
    cause
  });
}

function frame(opcode, payload = Buffer.alloc(0), masked = true) {
  const data = Buffer.from(payload);
  let lengthBytes;
  if (data.length < 126) lengthBytes = Buffer.from([data.length]);
  else if (data.length <= 0xffff) {
    lengthBytes = Buffer.alloc(3);
    lengthBytes[0] = 126;
    lengthBytes.writeUInt16BE(data.length, 1);
  } else {
    lengthBytes = Buffer.alloc(9);
    lengthBytes[0] = 127;
    lengthBytes.writeBigUInt64BE(BigInt(data.length), 1);
  }
  lengthBytes[0] |= masked ? 0x80 : 0;
  const head = Buffer.from([0x80 | (opcode & 0x0f)]);
  if (!masked) return Buffer.concat([head, lengthBytes, data]);
  const mask = crypto.randomBytes(4);
  const output = Buffer.alloc(data.length);
  for (let index = 0; index < data.length; index++) output[index] = data[index] ^ mask[index % 4];
  return Buffer.concat([head, lengthBytes, mask, output]);
}

function assertTlsPskSupport(ciphers = TLS_PSK_CIPHERS) {
  const available = new Set(tls.getCiphers().map(value => value.toUpperCase()));
  const requested = String(ciphers).split(':').map(value => value.trim()).filter(Boolean);
  if (!requested.some(value => available.has(value.toUpperCase()))) {
    throw new HomeConnectError('This Node.js/OpenSSL runtime does not provide a requested TLS-PSK cipher.', {
      code: 'LOCAL_TLS_PSK_UNAVAILABLE', details: { transport: 'TLS', protocol: 'TLSv1.2-PSK' }
    });
  }
}

class FrameDecoder extends EventEmitter {
  constructor() {
    super();
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = null;
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const final = Boolean(first & 0x80);
      const opcode = first & 0x0f;
      const masked = Boolean(second & 0x80);
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2); offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2);
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new HomeConnectError('WebSocket frame is too large.', { code: 'LOCAL_WEBSOCKET_FRAME_TOO_LARGE' });
        length = Number(big); offset = 10;
      }
      const maskOffset = masked ? 4 : 0;
      if (this.buffer.length < offset + maskOffset + length) return;
      const mask = masked ? this.buffer.subarray(offset, offset + 4) : null;
      offset += maskOffset;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      this.buffer = this.buffer.subarray(offset + length);
      if (mask) for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4];
      this._emitFrame(opcode, final, payload);
    }
  }

  _emitFrame(opcode, final, payload) {
    if (opcode === 0x8) return this.emit('close', payload);
    if (opcode === 0x9) return this.emit('ping', payload);
    if (opcode === 0xA) return this.emit('pong', payload);
    if (opcode === 0x0) {
      if (this.fragmentOpcode == null) return this.emit('error', new HomeConnectError('Unexpected WebSocket continuation frame.', { code: 'LOCAL_WEBSOCKET_PROTOCOL_ERROR' }));
      this.fragments.push(payload);
      if (final) {
        const type = this.fragmentOpcode;
        const value = Buffer.concat(this.fragments);
        this.fragmentOpcode = null; this.fragments = [];
        this.emit('message', value, type === 0x2);
      }
      return;
    }
    if (![0x1, 0x2].includes(opcode)) return this.emit('error', new HomeConnectError('Unsupported WebSocket opcode.', { code: 'LOCAL_WEBSOCKET_PROTOCOL_ERROR' }));
    if (final) return this.emit('message', payload, opcode === 0x2);
    this.fragmentOpcode = opcode;
    this.fragments = [payload];
  }
}

class HomeConnectWebSocketTransport extends EventEmitter {
  constructor(options = {}) {
    super();
    this.host = cleanHost(options.host);
    this.mode = String(options.mode || (options.iv64 ? 'AES' : 'TLS')).toUpperCase();
    this.psk = decodeBase64Url(options.psk64, 'PSK');
    this.timeoutMs = Math.max(1000, Number(options.timeoutMs || 15000));
    this.heartbeatMs = Math.max(5000, Number(options.heartbeatMs || 20000));
    this.pskIdentity = String(options.pskIdentity || 'HCCOM_Local_App');
    this.tlsCiphers = String(options.tlsCiphers || TLS_PSK_CIPHERS);
    this.lookup = options.lookup;
    this.onStage = typeof options.onStage === 'function' ? options.onStage : () => {};
    this.closed = false;
  }

  async connect() {
    const resolved = await resolveLocalHost(this.host, this.lookup || dns.lookup);
    const useTls = this.mode === 'TLS';
    if (!['AES', 'TLS'].includes(this.mode)) throw new HomeConnectError(`Unsupported local connection type: ${this.mode}`, { code: 'LOCAL_CONNECTION_TYPE_INVALID' });
    if (useTls) assertTlsPskSupport(this.tlsCiphers);
    const port = useTls ? 443 : 80;
    this.onStage('transport-recognized', {
      transport: this.mode, port, path: WEBSOCKET_PATH,
      protocol: useTls ? 'TLSv1.2-PSK' : 'AES-256-CBC/HMAC-SHA256'
    });
    // Connect to the address that was checked, avoiding a second DNS lookup/rebinding window.
    const socketOptions = { host: resolved.address, port };
    this.socket = useTls
      ? tls.connect({
        ...socketOptions,
        minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2', rejectUnauthorized: false,
        ciphers: this.tlsCiphers,
        pskCallback: () => ({ psk: this.psk, identity: this.pskIdentity })
      })
      : net.connect(socketOptions);
    let reachableReported = false;
    const reportReachable = () => {
      if (reachableReported) return;
      reachableReported = true;
      this.onStage('ip-reachable', { transport: this.mode, port, path: WEBSOCKET_PATH });
    };
    // For TLS, TCP reachability is distinct from the subsequent PSK handshake.
    this.socket.once('connect', reportReachable);
    await new Promise((resolve, reject) => {
      const event = useTls ? 'secureConnect' : 'connect';
      const timer = setTimeout(() => {
        this.socket.destroy();
        reject(new HomeConnectError('Local appliance connection timed out.', {
          code: 'LOCAL_CONNECT_TIMEOUT',
          details: {
            transport: this.mode, category: 'network', port,
            hintDe: 'Gerät kann im Standby/ausgeschaltet sein oder VLAN/Firewall blockiert den Zielport.',
            hintEn: 'The appliance may be asleep/offline, or a VLAN/firewall may block the target port.'
          }
        }));
      }, this.timeoutMs);
      const fail = cause => { clearTimeout(timer); reject(transportError(cause, this.mode)); };
       this.socket.once(event, () => {
         clearTimeout(timer);
         this.socket.off('error', fail);
         reportReachable();
         resolve();
       });
      this.socket.once('error', fail);
    });
    await this._upgrade();
    this.onStage('websocket-connected', {
      transport: this.mode, port, path: WEBSOCKET_PATH,
      protocol: 'RFC6455', cipher: useTls ? this.socket.getCipher?.()?.name : undefined
    });
    this._startFrames();
  }

  _upgrade() {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');
      const displayHost = this.host.includes(':') ? `[${this.host}]` : this.host;
      const originScheme = this.mode === 'TLS' ? 'https' : 'http';
      // Match websocket-client/homeconnect-websocket exactly: /homeconnect,
      // HTTP/1.1 Upgrade and an Origin derived from the ws/wss URL.
      const request = [
        `GET ${WEBSOCKET_PATH} HTTP/1.1`, 'Upgrade: websocket', `Host: ${displayHost}`,
        `Origin: ${originScheme}://${displayHost}`,
        `Sec-WebSocket-Key: ${key}`, 'Sec-WebSocket-Version: 13', 'Connection: Upgrade', '', ''
      ].join('\r\n');
      let response = Buffer.alloc(0);
      const timer = setTimeout(() => {
        cleanup();
        this.socket.destroy();
        reject(new HomeConnectError('Local WebSocket upgrade timed out.', {
          code: 'LOCAL_WEBSOCKET_TIMEOUT', details: { transport: this.mode, path: WEBSOCKET_PATH }
        }));
      }, this.timeoutMs);
      const onData = chunk => {
        response = Buffer.concat([response, chunk]);
        const marker = response.indexOf('\r\n\r\n');
        if (marker < 0) return;
        cleanup();
        const header = response.subarray(0, marker).toString('latin1');
        const lines = header.split('\r\n');
        const headers = Object.fromEntries(lines.slice(1).map(line => {
          const index = line.indexOf(':'); return [line.slice(0, index).trim().toLowerCase(), line.slice(index + 1).trim()];
        }));
        const expected = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        if (!/^HTTP\/1\.[01] 101\b/.test(lines[0]) || headers['sec-websocket-accept'] !== expected) {
          const status = lines[0].match(/^HTTP\/1\.[01]\s+(\d{3})(?:\s+(.+))?$/);
          this.socket.destroy();
          reject(new HomeConnectError('The appliance rejected the WebSocket upgrade.', {
            code: 'LOCAL_WEBSOCKET_UPGRADE_FAILED',
            details: {
              transport: this.mode, path: WEBSOCKET_PATH, category: 'transport',
              httpStatus: status ? Number(status[1]) : undefined,
              httpStatusText: status?.[2],
              hintDe: 'Host/IP, Profilzuordnung, AES/TLS-Port und den exakten Pfad /homeconnect prüfen.',
              hintEn: 'Verify Host/IP, profile assignment, AES/TLS port, and the exact /homeconnect path.'
            }
          }));
          return;
        }
        this.leftover = response.subarray(marker + 4);
        resolve();
      };
      const onError = cause => {
        cleanup();
        reject(new HomeConnectError('Local WebSocket upgrade failed.', {
          code: 'LOCAL_WEBSOCKET_UPGRADE_FAILED', details: { transport: this.mode, path: WEBSOCKET_PATH }, cause
        }));
      };
      const cleanup = () => { clearTimeout(timer); this.socket.off('data', onData); this.socket.off('error', onError); };
      this.socket.on('data', onData); this.socket.once('error', onError); this.socket.write(request);
    });
  }

  _startFrames() {
    this.decoder = new FrameDecoder();
    this.decoder.on('message', (payload, binary) => this.emit('message', payload, binary));
    this.decoder.on('ping', payload => this.socket.write(frame(0xA, payload)));
    this.decoder.on('pong', () => { this.awaitingPong = false; });
    this.decoder.on('close', payload => { if (!this.closed) this.socket.write(frame(0x8, payload)); this.close(); });
    this.decoder.on('error', error => { this.emit('error', error); this.close(); });
    this.socket.on('data', chunk => {
      try { this.decoder.push(chunk); } catch (error) { this.emit('error', error); this.close(); }
    });
    this.socket.on('error', cause => this.emit('error', transportError(cause, this.mode)));
    this.socket.on('close', () => { clearInterval(this.heartbeat); this.emit('close'); });
    if (this.leftover?.length) this.decoder.push(this.leftover);
    this.heartbeat = setInterval(() => {
      if (this.awaitingPong) {
        this.emit('error', new HomeConnectError('Local appliance heartbeat timed out.', {
          code: 'LOCAL_HEARTBEAT_TIMEOUT',
          details: {
            category: 'network', transport: this.mode,
            hintDe: 'Die WebSocket-Verbindung antwortet nicht mehr; Session wird geschlossen und neu aufgebaut.',
            hintEn: 'The WebSocket stopped responding; the session will be closed and rebuilt.'
          }
        }));
        return this.close();
      }
      this.awaitingPong = true;
      this.socket.write(frame(0x9, Buffer.alloc(0)));
    }, this.heartbeatMs);
    this.heartbeat.unref?.();
  }

  send(payload, binary = false) {
    if (!this.socket || this.socket.destroyed) throw new HomeConnectError('Local appliance socket is not connected.', { code: 'LOCAL_NOT_CONNECTED' });
    this.socket.write(frame(binary ? 0x2 : 0x1, payload));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    try { if (this.socket && !this.socket.destroyed) this.socket.end(frame(0x8)); } catch { this.socket?.destroy(); }
  }
}

module.exports = {
  HomeConnectWebSocketTransport, FrameDecoder, frame, cleanHost, privateIp, resolveLocalHost, assertLocalHost,
  transportError, assertTlsPskSupport, WEBSOCKET_PATH, TLS_PSK_CIPHERS
};
