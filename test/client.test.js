'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  HomeConnectClient,
  ENVIRONMENTS,
  API_MEDIA_TYPE,
  retryDelay,
  timedSignal
} = require('../lib/client');

test('environment hosts match the official production and simulation specifications', () => {
  assert.equal(ENVIRONMENTS.production, 'https://api.home-connect.com');
  assert.equal(ENVIRONMENTS.china, 'https://api.home-connect.cn');
  assert.equal(ENVIRONMENTS['official-simulator'], 'https://simulator.home-connect.com');
});

test('client refreshes a token, uses the vendor media type and unwraps API data', async () => {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/security/oauth/token')) {
      return new Response(JSON.stringify({ access_token: 'access', refresh_token: 'refresh-2', expires_in: 3600 }), {
        status: 200, headers: { 'content-type': 'application/json' }
      });
    }
    assert.equal(options.headers.authorization, 'Bearer access');
    assert.equal(options.headers.accept, API_MEDIA_TYPE);
    return new Response(JSON.stringify({ data: { homeappliances: [{ haId: 'one' }] } }), {
      status: 200, headers: { 'content-type': API_MEDIA_TYPE }
    });
  };
  const client = new HomeConnectClient({ clientId: 'id', clientSecret: 'secret', refreshToken: 'refresh', fetch });
  const appliances = await client.listHomeAppliances();
  assert.deepEqual(appliances, [{ haId: 'one' }]);
  assert.equal(calls.length, 2);
  assert.match(calls[0].options.body.toString(), /grant_type=refresh_token/);
  assert.match(calls[0].options.body.toString(), /client_id=id/);
  assert.match(calls[0].options.body.toString(), /client_secret=secret/);
});

test('confidential clients send their client secret only to the token endpoint', async () => {
  let body;
  const fetch = async (_url, options) => {
    body = options.body.toString();
    return new Response(JSON.stringify({ access_token: 'access', expires_in: 3600 }), { status: 200 });
  };
  const client = new HomeConnectClient({ clientId: 'id', clientSecret: 'secret', refreshToken: 'refresh', fetch });
  await client.refreshAccessToken();
  assert.match(body, /client_secret=secret/);
});

test('authorization-code exchange uses confidential client data, exact redirect URI and no PKCE verifier', async () => {
  let request;
  let stored;
  const redirectUri = 'https://localhost:1880/home-connect/oauth/callback';
  const fetch = async (url, options) => {
    request = { url: String(url), options };
    return new Response(JSON.stringify({ access_token: 'access', refresh_token: 'refresh-new', expires_in: 3600 }), { status: 200 });
  };
  const client = new HomeConnectClient({
    clientId: 'private-id', clientSecret: 'private-secret', redirectUri, fetch,
    onToken: tokens => { stored = tokens; }
  });
  await client.exchangeCode('authorization-code');
  const body = new URLSearchParams(request.options.body);
  assert.equal(request.url, 'https://api.home-connect.com/security/oauth/token');
  assert.equal(request.options.method, 'POST');
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('code'), 'authorization-code');
  assert.equal(body.get('client_id'), 'private-id');
  assert.equal(body.get('client_secret'), 'private-secret');
  assert.equal(body.get('redirect_uri'), redirectUri);
  assert.equal(body.has('code_verifier'), false);
  assert.equal(stored.refreshToken, 'refresh-new');
});

test('authorization-code exchange rejects a successful response without a refresh token', async () => {
  const fetch = async () => new Response(JSON.stringify({ access_token: 'access', expires_in: 3600 }), { status: 200 });
  const client = new HomeConnectClient({ clientId: 'id', clientSecret: 'secret', redirectUri: 'https://localhost/callback', fetch });
  await assert.rejects(() => client.exchangeCode('code'), { code: 'REFRESH_TOKEN_MISSING' });
});

test('token calls fail locally when the confidential client secret is missing', async () => {
  const client = new HomeConnectClient({ clientId: 'id', refreshToken: 'refresh', fetch: async () => { throw new Error('must not run'); } });
  await assert.rejects(() => client.refreshAccessToken(), { code: 'CLIENT_SECRET_REQUIRED' });
});

test('write requests use the official envelope and are not automatically retried', async () => {
  let count = 0;
  let sent;
  const fetch = async (_url, options) => {
    count++;
    sent = options;
    return new Response(JSON.stringify({ error: { key: '500', description: 'failed' } }), { status: 500 });
  };
  const client = new HomeConnectClient({ accessToken: 'access', expiresAt: Date.now() + 60000, fetch });
  await assert.rejects(() => client.request('PUT', '/api/test', { body: { data: { key: 'Power', value: 'On' } } }), { status: 500 });
  assert.equal(count, 1);
  assert.equal(sent.headers['content-type'], API_MEDIA_TYPE);
  assert.deepEqual(JSON.parse(sent.body), { data: { key: 'Power', value: 'On' } });
});

test('official simulator capability discovery does not call the production-only commands endpoint', async () => {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push(String(url));
    const path = new URL(url).pathname;
    if (path.endsWith('/homeappliances/one')) return new Response(JSON.stringify({ data: { haId: 'one', type: 'Oven', connected: true } }), { status: 200 });
    if (path.endsWith('/status')) return new Response(JSON.stringify({ data: { status: [] } }), { status: 200 });
    if (path.endsWith('/settings')) return new Response(JSON.stringify({ data: { settings: [] } }), { status: 200 });
    if (path.endsWith('/programs/available')) return new Response(JSON.stringify({ data: { programs: [] } }), { status: 200 });
    return new Response(JSON.stringify({ error: { key: '409', description: 'not set' } }), { status: 409 });
  };
  const client = new HomeConnectClient({ environment: 'official-simulator', accessToken: 'access', expiresAt: Date.now() + 60000, fetch });
  const capability = await client.discoverAppliance('one', true);
  assert.equal(capability.commands.unsupported, true);
  assert.equal(calls.some(url => url.endsWith('/commands')), false);
});

test('Retry-After supports seconds and HTTP dates with a bounded delay', () => {
  const now = Date.parse('2026-10-31T12:00:00Z');
  assert.equal(retryDelay('2', 100, now), 2000);
  assert.equal(retryDelay('Sat, 31 Oct 2026 12:00:05 GMT', 100, now), 5000);
  assert.equal(retryDelay('120', 100, now), 60000);
  assert.equal(retryDelay('invalid', 123, now), 123);
});

test('HTTP 429 opens the local circuit breaker and is not retried', async () => {
  let count = 0;
  const fetch = async () => {
    count++;
    return new Response(JSON.stringify({
      error: {
        key: '429',
        description: 'The rate limit "1000 calls in 1 day" was reached. Requests are blocked during the remaining period of 75502 seconds.'
      }
    }), { status: 429, headers: { 'content-type': 'application/json' } });
  };
  const client = new HomeConnectClient({
    accessToken: 'access', expiresAt: Date.now() + 60000, fetch,
    maxRequestsPerDay: 900, minimumRequestInterval: 100
  });
  await assert.rejects(() => client.listHomeAppliances(), error => {
    assert.equal(error.status, 429);
    assert.equal(error.code, '429');
    assert.equal(error.retryAfter, '75502');
    return true;
  });
  await assert.rejects(() => client.listHomeAppliances(), error => {
    assert.equal(error.code, 'LOCAL_RATE_LIMITED');
    assert.equal(error.retryAfter, '75502');
    return true;
  });
  assert.equal(count, 1);
  const status = await client.getRateLimitStatus();
  assert.equal(status.blocked, true);
  assert.equal(status.usedRequests, 1);
});

test('timeout signal aborts and reports whether the timer fired', async () => {
  const timeout = timedSignal(undefined, 5);
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(timeout.signal.aborted, true);
  assert.equal(timeout.timedOut(), true);
  timeout.cleanup();
});

test('binary images and nested cleaning-robot map resources use documented paths', async () => {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('/images/')) {
      return new Response(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), {
        status: 200, headers: { 'content-type': 'image/jpeg' }
      });
    }
    return new Response(JSON.stringify({ objectId: 9 }), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
  };
  const client = new HomeConnectClient({ accessToken: 'access', expiresAt: Date.now() + 60000, fetch });
  const image = await client.read('robot', 'image', 'camera/latest');
  assert.equal(image.contentType, 'image/jpeg');
  assert.ok(Buffer.isBuffer(image.data));
  assert.deepEqual([...image.data], [0xff, 0xd8, 0xff, 0xd9]);
  const object = await client.read('robot', 'map-detected-object', 7, 9);
  assert.deepEqual(object, { objectId: 9 });
  assert.equal(new URL(calls[0].url).pathname, '/api/homeappliances/robot/images/camera%2Flatest');
  assert.equal(calls[0].options.headers.accept, 'image/jpeg');
  assert.equal(new URL(calls[1].url).pathname, '/api/homeappliances/robot/map/maps/7/cleaningStatus/objects/9');
  assert.equal(calls[1].options.headers.accept, 'application/json');
});


test('event stream emits normalized lifecycle events and promotes all-appliance data haId', async () => {
  const body = 'event: STATUS\nid: event-1\ndata: {"haId":"appliance-example","items":[{"key":"BSH.Common.Status.OperationState","value":"BSH.Common.EnumType.OperationState.Ready"}]}\n\n';
  const client = new HomeConnectClient({
    accessToken: 'access-token',
    expiresAt: Date.now() + 60000,
    fetch: async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  });
  const events = [];
  let closeStream;
  await new Promise((resolve, reject) => {
    closeStream = client.openEvents('*', event => {
      events.push(event);
      if (event.event === 'DISCONNECTED') {
        closeStream();
        resolve();
      }
    }, reject);
  });
  assert.equal(events[0].event, 'CONNECTED');
  assert.equal(events[0].connection.synthetic, true);
  assert.equal(events[1].event, 'STATUS');
  assert.equal(events[1].haId, 'appliance-example');
  assert.equal(events[1].id, 'event-1');
  assert.equal(events[2].event, 'DISCONNECTED');
  assert.equal(events[2].connection.reason, 'stream-ended');
  client.close();
});
