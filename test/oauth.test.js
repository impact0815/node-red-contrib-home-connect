'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createState, buildAuthorizationUrl } = require('../lib/oauth');

test('OAuth state is random', () => {
  const a = createState();
  const b = createState();
  assert.notEqual(a, b);
  assert.ok(a.length >= 32);
});

test('authorization URL contains the exact redirect URI and no PKCE parameters', () => {
  const redirectUri = 'https://localhost:1880/home-connect/oauth/callback';
  const url = new URL(buildAuthorizationUrl({
    baseUrl: 'https://api.home-connect.com', clientId: 'client', redirectUri,
    scope: 'IdentifyAppliance Monitor', state: 'state'
  }));
  assert.equal(url.pathname, '/security/oauth/authorize');
  assert.equal(url.searchParams.get('client_id'), 'client');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('state'), 'state');
  assert.equal(url.searchParams.get('scope'), 'IdentifyAppliance Monitor');
  assert.equal(url.searchParams.get('redirect_uri'), redirectUri);
  assert.equal(url.searchParams.has('code_challenge'), false);
  assert.equal(url.searchParams.has('code_challenge_method'), false);
  assert.equal(url.searchParams.has('code_verifier'), false);
});
