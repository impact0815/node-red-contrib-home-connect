'use strict';

const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { HomeConnectError } = require('./errors');

function decodeBase64Url(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new HomeConnectError(`${label} is required.`, { code: 'LOCAL_PROFILE_KEY_MISSING' });
  }
  try {
    const text = value.trim();
    if (!/^[A-Za-z0-9_-]+={0,2}$/.test(text) || text.replace(/=/g, '').length % 4 === 1) throw new Error('syntax');
    const buffer = Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (!buffer.length) throw new Error('empty');
    if (buffer.toString('base64url') !== text.replace(/=+$/, '')) throw new Error('canonical');
    return buffer;
  } catch (cause) {
    throw new HomeConnectError(`${label} is not valid Base64URL.`, { code: 'LOCAL_PROFILE_KEY_INVALID', cause });
  }
}

function hmac(key, ...parts) {
  const value = crypto.createHmac('sha256', key);
  for (const part of parts) value.update(part);
  return value.digest();
}

class AesMessageCrypto {
  constructor(options = {}) {
    this.psk = Buffer.isBuffer(options.psk) ? Buffer.from(options.psk) : decodeBase64Url(options.psk64, 'PSK');
    this.iv = Buffer.isBuffer(options.iv) ? Buffer.from(options.iv) : decodeBase64Url(options.iv64, 'IV');
    if (this.psk.length !== 32) {
      throw new HomeConnectError('The local Home Connect PSK must contain exactly 32 bytes.', {
        code: 'LOCAL_PROFILE_KEY_LENGTH_INVALID', details: { transport: 'AES' }
      });
    }
    if (this.iv.length !== 16) {
      throw new HomeConnectError('The local AES IV must contain exactly 16 bytes.', { code: 'LOCAL_PROFILE_IV_INVALID' });
    }
    this.encryptionKey = hmac(this.psk, Buffer.from('ENC'));
    this.authenticationKey = hmac(this.psk, Buffer.from('MAC'));
    this.randomBytes = options.randomBytes || crypto.randomBytes;
    this.reset();
  }

  reset() {
    this.lastTxHmac = Buffer.alloc(16);
    this.lastRxHmac = Buffer.alloc(16);
    this.encryptor = crypto.createCipheriv('aes-256-cbc', this.encryptionKey, this.iv);
    this.decryptor = crypto.createDecipheriv('aes-256-cbc', this.encryptionKey, this.iv);
    this.encryptor.setAutoPadding(false);
    this.decryptor.setAutoPadding(false);
  }

  _messageHmac(direction, previous, ciphertext) {
    return hmac(this.authenticationKey, this.iv, Buffer.from([direction]), previous, ciphertext).subarray(0, 16);
  }

  encrypt(value) {
    const clear = Buffer.from(String(value), 'utf8');
    let paddingLength = 16 - (clear.length % 16);
    if (paddingLength === 1) paddingLength += 16;
    const randomLength = paddingLength - 2;
    const padding = Buffer.concat([
      Buffer.from([0]),
      randomLength ? this.randomBytes(randomLength) : Buffer.alloc(0),
      Buffer.from([paddingLength])
    ]);
    const ciphertext = this.encryptor.update(Buffer.concat([clear, padding]));
    this.lastTxHmac = this._messageHmac(0x45, this.lastTxHmac, ciphertext);
    return Buffer.concat([ciphertext, this.lastTxHmac]);
  }

  decrypt(value) {
    const frame = Buffer.from(value);
    if (frame.length < 32 || frame.length % 16 !== 0) {
      throw new HomeConnectError('Invalid local AES frame length.', { code: 'LOCAL_CRYPTO_FRAME_INVALID' });
    }
    const ciphertext = frame.subarray(0, -16);
    const received = frame.subarray(-16);
    const expected = this._messageHmac(0x43, this.lastRxHmac, ciphertext);
    if (!crypto.timingSafeEqual(received, expected)) {
      throw new HomeConnectError('Local AES frame authentication failed; reconnect is required.', { code: 'LOCAL_CRYPTO_AUTH_FAILED' });
    }
    this.lastRxHmac = Buffer.from(received);
    const clear = this.decryptor.update(ciphertext);
    const paddingLength = clear.at(-1);
    if (paddingLength < 2 || paddingLength > 17 || paddingLength > clear.length) {
      throw new HomeConnectError('Invalid local AES frame padding; reconnect is required.', { code: 'LOCAL_CRYPTO_PADDING_INVALID' });
    }
    if (clear[clear.length - paddingLength] !== 0) {
      throw new HomeConnectError('Invalid local AES frame padding marker; reconnect is required.', { code: 'LOCAL_CRYPTO_PADDING_INVALID' });
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(clear.subarray(0, -paddingLength));
    } catch (cause) {
      throw new HomeConnectError('Local AES frame is not valid UTF-8; reconnect is required.', { code: 'LOCAL_CRYPTO_TEXT_INVALID', cause });
    }
  }
}

function validateLocalKeyMaterial(profile) {
  const transport = String(profile?.connectionType || '').toUpperCase();
  const psk = decodeBase64Url(profile?.psk64, 'PSK');
  if (psk.length !== 32) {
    throw new HomeConnectError('The local Home Connect PSK must contain exactly 32 bytes.', {
      code: 'LOCAL_PROFILE_KEY_LENGTH_INVALID', details: { transport }
    });
  }
  if (transport === 'AES') {
    const iv = decodeBase64Url(profile?.iv64, 'IV');
    if (iv.length !== 16) {
      throw new HomeConnectError('The local AES IV must contain exactly 16 bytes.', {
        code: 'LOCAL_PROFILE_IV_INVALID', details: { transport }
      });
    }
  }
  return { transport, pskLength: psk.length, ivLength: transport === 'AES' ? 16 : 0 };
}

module.exports = { AesMessageCrypto, decodeBase64Url, hmac, validateLocalKeyMaterial };
