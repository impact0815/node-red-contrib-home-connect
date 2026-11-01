'use strict';

const crypto = require('node:crypto');

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function createState() {
  return base64url(crypto.randomBytes(32));
}

function buildAuthorizationUrl(options) {
  const url = new URL('/security/oauth/authorize', options.baseUrl);
  url.searchParams.set('client_id', options.clientId);
  url.searchParams.set('redirect_uri', options.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', options.scope);
  url.searchParams.set('state', options.state);
  return url.toString();
}

module.exports = { base64url, createState, buildAuthorizationUrl };
