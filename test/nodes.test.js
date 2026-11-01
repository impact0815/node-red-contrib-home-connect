'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

test('runtime registers all public Node-RED types, protected routes and credentials', () => {
  const types = new Map();
  const adminRoutes = [];
  const adminPostRoutes = [];
  const nodeRoutes = [];
  const permissions = [];
  const RED = {
    nodes: { registerType: (name, ctor, options) => types.set(name, { ctor, options }), getNode: () => null },
    httpAdmin: {
      get: (path, ...handlers) => adminRoutes.push({ path, handlers }),
      post: (path, ...handlers) => adminPostRoutes.push({ path, handlers })
    },
    httpNode: { get: (path, ...handlers) => nodeRoutes.push({ path, handlers }) },
    auth: { needsPermission: permission => { permissions.push(permission); return (_req, _res, next) => next(); } },
    util: { cloneMessage: value => structuredClone(value) }
  };
  require('../nodes/home-connect')(RED);
  assert.deepEqual([...types.keys()], ['home-connect-config', 'home-connect-discover', 'home-connect-read', 'home-connect-events', 'home-connect-write']);
  assert.ok(adminRoutes.some(route => route.path.includes('/oauth/')));
  assert.ok(adminRoutes.some(route => route.path === '/home-connect/diagnostics'));
  assert.ok(adminRoutes.some(route => route.path === '/home-connect/config/:id/status'));
  assert.ok(adminRoutes.some(route => route.path === '/home-connect/local-profiles/scan'));
  assert.ok(adminPostRoutes.some(route => route.path === '/home-connect/local-profiles/test'));
  assert.ok(adminPostRoutes.some(route => route.path === '/home-connect/local-profiles/export'));
  assert.ok(nodeRoutes.some(route => route.path === '/home-connect/oauth/callback'));
  assert.ok(types.get('home-connect-config').options.credentials.refreshToken);
  assert.ok(types.get('home-connect-write').options.credentials.confirmationToken);
  assert.deepEqual(permissions.sort(), ['home-connect.read', 'home-connect.write']);
});

test('editor centralizes local Host/IP mapping and gives Read/Events device selectors', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'nodes', 'home-connect.html'), 'utf8');
  const configTemplate = html.match(/data-template-name="home-connect-config">([\s\S]*?)<\/script>/)[1];
  const readTemplate = html.match(/data-template-name="home-connect-read">([\s\S]*?)<\/script>/)[1];
  const eventsTemplate = html.match(/data-template-name="home-connect-events">([\s\S]*?)<\/script>/)[1];
  assert.match(configTemplate, /node-config-input-localDeviceMappings/);
  assert.match(configTemplate, /hc-local-devices/);
  assert.match(configTemplate, /id="hc-local-scan-help"[^>]*>[^<]+</);
  assert.match(configTemplate, /Profile suchen \/ Geräte erkennen/);
  assert.match(html, /Verbindung testen \/ Test connection/);
  assert.match(configTemplate, /Profil-JSON manuell einfügen \(optional\)/);
  assert.match(configTemplate, /<details id="hc-local-advanced"/);
  assert.match(html, /hc-local-host/);
  assert.match(html, /Auto \(empfohlen \/ recommended\)/);
  assert.match(html, /home-connect\/local-profiles\/test/);
  assert.match(html, /home-connect\/local-profiles\/export/);
  assert.match(html, /oneditsave: function\(\)/);
  assert.match(html, /mappings,\s*requestTimeout/);
  assert.match(html, /deviceLabel\(entry\.appliance\)/);
  assert.match(html, /shortTechnicalId/);
  assert.doesNotMatch(html, /__PWRD__/);
  assert.doesNotMatch(configTemplate, /<label[^>]*>\s*Profile JSON\s*<\/label>/);
  assert.match(configTemplate, /id="hc-rate-status" class="hc-mini hc-cloud-row"/);
  assert.match(configTemplate, /form-tips hc-cloud-row[^>]*>Diese Version verwendet/);
  assert.match(readTemplate, /<select id="node-input-haId">/);
  assert.doesNotMatch(readTemplate, /Host\/IP|node-input-host|node-input-ip/);
  assert.match(eventsTemplate, /<select id="node-input-haId">/);
  assert.match(eventsTemplate, /All configured appliances/);
  assert.doesNotMatch(eventsTemplate, /Host\/IP|node-input-host|node-input-ip/);
  assert.match(html, /LOCAL_PROTOCOL_REJECTED/);
  assert.match(html, /LOCAL_PROFILE_KEY_REJECTED/);
  assert.match(html, /ip-reachable/);
  assert.match(html, /readonly-data-received/);
  assert.match(html, /Test gestoppt bei/);
});

test('per-device local connection test rejects public targets before network access', async () => {
  const postRoutes = [];
  const RED = {
    nodes: { registerType: () => {}, getNode: () => null },
    httpAdmin: {
      get: () => {},
      post: (path, ...handlers) => postRoutes.push({ path, handlers })
    },
    httpNode: { get: () => {} },
    auth: { needsPermission: () => (_req, _res, next) => next() },
    util: { cloneMessage: value => structuredClone(value) }
  };
  require('../nodes/home-connect')(RED);
  const handler = postRoutes.find(route => route.path === '/home-connect/local-profiles/test').handlers.at(-1);
  const response = {
    statusCode: 200,
    headers: {},
    set(values) { Object.assign(this.headers, values); return this; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; }
  };
  await handler({ body: { path: '/not-used', profileId: 'device-one', host: '8.8.8.8', connectionType: 'auto' } }, response);
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.error.code, 'LOCAL_HOST_NOT_PRIVATE');
  assert.equal(response.body.stages.find(stage => stage.id === 'ip-reachable').status, 'failed');
  assert.equal(response.body.stages.find(stage => stage.id === 'readonly-data-received').status, 'skipped');
  assert.equal(response.headers['cache-control'], 'no-store');
});

test('registered nodes execute discovery against the built-in simulator', async () => {
  const types = new Map();
  const instances = new Map();
  const RED = {
    nodes: {
      registerType: (name, ctor, options) => types.set(name, { ctor, options }),
      createNode: (node, config) => {
        const emitter = new EventEmitter();
        node.id = config.id;
        node.type = config.type;
        node.credentials = config.credentials || {};
        node.on = emitter.on.bind(emitter);
        node.emit = emitter.emit.bind(emitter);
        node.status = () => {};
        node.error = () => {};
        node.send = () => {};
        instances.set(node.id, node);
      },
      getNode: id => instances.get(id),
      addCredentials: () => {}
    },
    httpAdmin: { get: () => {} }, httpNode: { get: () => {} },
    auth: { needsPermission: () => (_req, _res, next) => next() },
    util: { cloneMessage: value => structuredClone(value) }
  };
  require('../nodes/home-connect')(RED);
  const Config = types.get('home-connect-config').ctor;
  const Discover = types.get('home-connect-discover').ctor;
  const config = new Config({ id: 'cfg', type: 'home-connect-config', environment: 'builtin-simulator', allowWrite: true });
  const discover = new Discover({ id: 'discover', type: 'home-connect-discover', connection: 'cfg', mode: 'all' });
  const output = await new Promise((resolve, reject) => {
    discover.emit('input', {}, outputs => resolve(outputs[0]), error => error ? reject(error) : undefined);
  });
  assert.deepEqual(output.payload.map(entry => entry.appliance.type), ['Dishwasher', 'Washer', 'Oven']);
  assert.equal(output.health, 'ok');
  assert.deepEqual(output.warnings, []);
  assert.equal(output.homeConnect.healthSchema, 'home-connect-health/v1');
  assert.ok(output.payload.every(entry => entry.health === 'ok'));
  config.client.close();
});

test('option input accepts arrays and object shorthand without retaining confirmation data', () => {
  const runtime = require('../nodes/home-connect');
  assert.deepEqual(runtime.optionArray({ Temperature: 180, Duration: { value: 600, unit: 'seconds' } }), [
    { key: 'Temperature', value: 180 },
    { key: 'Duration', value: 600, unit: 'seconds' }
  ]);
  assert.throws(() => runtime.optionArray('invalid'), { code: 'INVALID_OPTIONS' });
});


test('OAuth routes run confidential Authorization Code flow without PKCE and store the refresh token', async () => {
  const types = new Map();
  const instances = new Map();
  const adminRoutes = [];
  const nodeRoutes = [];
  const savedCredentials = [];
  const RED = {
    nodes: {
      registerType: (name, ctor, options) => types.set(name, { ctor, options }),
      createNode: (node, config) => {
        const emitter = new EventEmitter();
        node.id = config.id;
        node.type = config.type;
        node.credentials = config.credentials || {};
        node.on = emitter.on.bind(emitter);
        node.emit = emitter.emit.bind(emitter);
        instances.set(node.id, node);
      },
      getNode: id => instances.get(id),
      addCredentials: (id, credentials) => savedCredentials.push({ id, credentials: { ...credentials } })
    },
    httpAdmin: { get: (path, ...handlers) => adminRoutes.push({ path, handlers }) },
    httpNode: { get: (path, ...handlers) => nodeRoutes.push({ path, handlers }) },
    auth: { needsPermission: () => (_req, _res, next) => next() },
    util: { cloneMessage: value => structuredClone(value) }
  };
  require('../nodes/home-connect')(RED);
  const Config = types.get('home-connect-config').ctor;
  const redirectUri = 'https://localhost:1880/home-connect/oauth/callback';
  const config = new Config({
    id: 'oauth-config', type: 'home-connect-config', environment: 'production', redirectUri,
    scope: 'IdentifyAppliance Monitor', credentials: { clientId: 'client-id', clientSecret: 'client-secret' }
  });

  const tokenCalls = [];
  config.client.fetch = async (url, options) => {
    tokenCalls.push({ url: String(url), options });
    return new Response(JSON.stringify({ access_token: 'access-token', refresh_token: 'refresh-token', expires_in: 3600 }), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
  };

  function response() {
    return {
      statusCode: 200,
      headers: {},
      set(values) { Object.assign(this.headers, values); return this; },
      status(value) { this.statusCode = value; return this; },
      type(value) { this.contentType = value; return this; },
      send(value) { this.body = value; return this; },
      json(value) { this.jsonBody = value; return this; },
      redirect(value) { this.location = value; return this; }
    };
  }

  const start = adminRoutes.find(route => route.path === '/home-connect/oauth/:id/start').handlers.at(-1);
  const diagnostics = adminRoutes.find(route => route.path === '/home-connect/diagnostics').handlers.at(-1);
  const status = adminRoutes.find(route => route.path === '/home-connect/config/:id/status').handlers.at(-1);
  const callback = nodeRoutes.find(route => route.path === '/home-connect/oauth/callback').handlers.at(-1);
  const diagnosticsResponse = response();
  await diagnostics({}, diagnosticsResponse);
  assert.equal(diagnosticsResponse.jsonBody.packageVersion, '0.2.0');
  assert.equal(diagnosticsResponse.jsonBody.buildId, 'hc-0.2.0-final');
  assert.equal(diagnosticsResponse.jsonBody.oauth.pkce, false);
  assert.equal(diagnosticsResponse.jsonBody.oauth.flow, 'authorization_code_client_secret');
  assert.match(diagnosticsResponse.jsonBody.loadedFrom, /nodes$/);
  assert.equal(diagnosticsResponse.headers['x-home-connect-build'], 'hc-0.2.0-final');
  const statusResponse = response();
  await status({ params: { id: config.id } }, statusResponse);
  assert.equal(statusResponse.jsonBody.ok, true);
  assert.equal(statusResponse.jsonBody.environment, 'production');
  assert.equal(statusResponse.jsonBody.redirectUri, redirectUri);
  assert.equal(statusResponse.jsonBody.maxRequestsPerDay, 900);
  assert.equal(statusResponse.jsonBody.minimumRequestInterval, 250);
  assert.equal(statusResponse.jsonBody.rateLimit.maxRequests, 900);
  assert.equal(statusResponse.jsonBody.rateLimit.blocked, false);
  assert.equal(statusResponse.jsonBody.hasClientId, true);
  assert.equal(statusResponse.jsonBody.hasClientSecret, true);
  assert.equal(statusResponse.jsonBody.hasRefreshToken, false);
  assert.equal(Object.hasOwn(statusResponse.jsonBody, 'clientSecret'), false);
  const startResponse = response();
  await start({ params: { id: config.id } }, startResponse);
  const authorizationUrl = new URL(startResponse.location);
  assert.equal(authorizationUrl.origin, 'https://api.home-connect.com');
  assert.equal(authorizationUrl.pathname, '/security/oauth/authorize');
  assert.equal(authorizationUrl.searchParams.get('redirect_uri'), redirectUri);
  assert.equal(authorizationUrl.searchParams.get('client_id'), 'client-id');
  assert.equal(authorizationUrl.searchParams.has('code_challenge'), false);
  assert.equal(authorizationUrl.searchParams.has('code_challenge_method'), false);
  assert.ok(authorizationUrl.searchParams.get('state'));
  assert.equal(startResponse.headers['cache-control'], 'no-store');
  assert.equal(startResponse.headers['x-home-connect-build'], 'hc-0.2.0-final');

  const callbackResponse = response();
  await callback({ query: { state: authorizationUrl.searchParams.get('state'), code: 'authorization-code' } }, callbackResponse);
  assert.equal(callbackResponse.statusCode, 200);
  assert.match(callbackResponse.body, /refresh token was stored/i);
  assert.match(callbackResponse.body, /hc-0\.2\.0-final/);
  assert.equal(tokenCalls.length, 1);
  const tokenBody = new URLSearchParams(tokenCalls[0].options.body);
  assert.equal(tokenBody.get('grant_type'), 'authorization_code');
  assert.equal(tokenBody.get('client_id'), 'client-id');
  assert.equal(tokenBody.get('client_secret'), 'client-secret');
  assert.equal(tokenBody.get('redirect_uri'), redirectUri);
  assert.equal(tokenBody.has('code_verifier'), false);
  assert.deepEqual(savedCredentials, [{
    id: config.id,
    credentials: { clientId: 'client-id', clientSecret: 'client-secret', refreshToken: 'refresh-token' }
  }]);

  const authorizedStatusResponse = response();
  await status({ params: { id: config.id } }, authorizedStatusResponse);
  assert.equal(authorizedStatusResponse.jsonBody.hasRefreshToken, true);

  const replayResponse = response();
  await callback({ query: { state: authorizationUrl.searchParams.get('state'), code: 'replayed-code' } }, replayResponse);
  assert.equal(replayResponse.statusCode, 400);
  assert.match(replayResponse.body, /OAUTH_STATE_INVALID/);
  assert.equal(tokenCalls.length, 1);

  const secondStartResponse = response();
  await start({ params: { id: config.id } }, secondStartResponse);
  const secondState = new URL(secondStartResponse.location).searchParams.get('state');
  const deniedResponse = response();
  await callback({ query: { state: secondState, error: 'access_denied', error_description: '<not granted>' } }, deniedResponse);
  assert.equal(deniedResponse.statusCode, 400);
  assert.match(deniedResponse.body, /access_denied/);
  assert.match(deniedResponse.body, /&lt;not granted&gt;/);
  assert.doesNotMatch(deniedResponse.body, /<not granted>/);
  assert.equal(tokenCalls.length, 1);

  const thirdStartResponse = response();
  await start({ params: { id: config.id } }, thirdStartResponse);
  const thirdState = new URL(thirdStartResponse.location).searchParams.get('state');
  config.client.fetch = async () => new Response(JSON.stringify({
    error: 'unauthorized_client', error_description: 'Client authentication failed'
  }), { status: 401, headers: { 'content-type': 'application/json' } });
  const tokenErrorResponse = response();
  await callback({ query: { state: thirdState, code: 'failed-code' } }, tokenErrorResponse);
  assert.equal(tokenErrorResponse.statusCode, 401);
  assert.match(tokenErrorResponse.body, /unauthorized_client/);
  assert.match(tokenErrorResponse.body, /Client authentication failed/);
  assert.match(tokenErrorResponse.body, /hc-0\.2\.0-final/);
  assert.doesNotMatch(tokenErrorResponse.body, /client-secret|failed-code/);

  const untrustedErrorResponse = response();
  await callback({ query: { error: 'evil', error_description: '<script>alert(1)</script>' } }, untrustedErrorResponse);
  assert.equal(untrustedErrorResponse.statusCode, 400);
  assert.match(untrustedErrorResponse.body, /OAUTH_STATE_INVALID/);
  assert.doesNotMatch(untrustedErrorResponse.body, /alert\(1\)/);
});

test('OAuth start route reports a missing client secret as a safe browser page', async () => {
  const types = new Map();
  const instances = new Map();
  const adminRoutes = [];
  const RED = {
    nodes: {
      registerType: (name, ctor, options) => types.set(name, { ctor, options }),
      createNode: (node, config) => {
        const emitter = new EventEmitter();
        node.id = config.id;
        node.type = config.type;
        node.credentials = config.credentials || {};
        node.on = emitter.on.bind(emitter);
        instances.set(node.id, node);
      },
      getNode: id => instances.get(id),
      addCredentials: () => {}
    },
    httpAdmin: { get: (path, ...handlers) => adminRoutes.push({ path, handlers }) },
    httpNode: { get: () => {} },
    auth: { needsPermission: () => (_req, _res, next) => next() },
    util: { cloneMessage: value => structuredClone(value) }
  };
  require('../nodes/home-connect')(RED);
  const Config = types.get('home-connect-config').ctor;
  const config = new Config({
    id: 'incomplete', type: 'home-connect-config', environment: 'production',
    redirectUri: 'https://localhost:1880/home-connect/oauth/callback', credentials: { clientId: 'client-id' }
  });
  const res = {
    statusCode: 200, headers: {},
    set(values) { Object.assign(this.headers, values); return this; },
    status(value) { this.statusCode = value; return this; },
    type(value) { this.contentType = value; return this; },
    send(value) { this.body = value; return this; }
  };
  const start = adminRoutes.find(route => route.path === '/home-connect/oauth/:id/start').handlers.at(-1);
  await start({ params: { id: config.id } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.contentType, 'html');
  assert.match(res.body, /OAUTH_CONFIGURATION_INCOMPLETE/);
  assert.match(res.body, /client secret/i);
  assert.equal(res.headers['x-frame-options'], 'DENY');
});
