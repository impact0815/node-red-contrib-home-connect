'use strict';

const path = require('node:path');
const { HomeConnectClient } = require('../lib/client');
const { LocalHomeConnectClient } = require('../lib/local-client');
const {
  exportLocalProfileJson,
  loadLocalProfiles,
  parseLocalDeviceMappings,
  scanLocalProfileDirectory
} = require('../lib/local-profile');
const { assertLocalHost } = require('../lib/websocket-transport');
const { validateLocalKeyMaterial } = require('../lib/local-crypto');
const { LocalConnectionDiagnostics } = require('../lib/local-diagnostics');
const { BuiltinSimulator } = require('../lib/simulator');
const { HomeConnectError } = require('../lib/errors');
const { formatDeviceLabel } = require('../lib/device-label');
const { createState, buildAuthorizationUrl } = require('../lib/oauth');
const { validateWrite } = require('../lib/validation');
const { HealthMonitor } = require('../lib/health');
const {
  DEFAULT_MAX_REQUESTS,
  DEFAULT_MINIMUM_INTERVAL,
  SlidingWindowRateLimiter,
  createFileRateLimitStore,
  integerInRange
} = require('../lib/rate-limiter');
const { DEFAULT_SCOPE, READ_OPERATIONS, WRITE_ACTIONS } = require('../lib/constants');
const BUILD_INFO = require('../BUILD-INFO.json');

const pendingOAuth = new Map();
const sharedRateLimiters = new Map();
const OAUTH_TTL = 10 * 60 * 1000;

function useSharedRateLimiter(key, consumerId, options) {
  let entry = sharedRateLimiters.get(key);
  if (!entry) {
    entry = { limiter: new SlidingWindowRateLimiter(options), consumers: new Map() };
    sharedRateLimiters.set(key, entry);
  }
  entry.consumers.set(consumerId, options);
  entry.limiter.configure({
    maxRequests: Math.min(...[...entry.consumers.values()].map(value => value.maxRequests)),
    minimumIntervalMs: Math.max(...[...entry.consumers.values()].map(value => value.minimumIntervalMs))
  });
  return entry.limiter;
}

function releaseSharedRateLimiter(key, consumerId) {
  const entry = sharedRateLimiters.get(key);
  if (!entry) return;
  entry.consumers.delete(consumerId);
  if (!entry.consumers.size) {
    sharedRateLimiters.delete(key);
    return;
  }
  entry.limiter.configure({
    maxRequests: Math.min(...[...entry.consumers.values()].map(value => value.maxRequests)),
    minimumIntervalMs: Math.max(...[...entry.consumers.values()].map(value => value.minimumIntervalMs))
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[character]);
}

function errorPayload(error) {
  return error && typeof error.toJSON === 'function'
    ? error.toJSON()
    : { name: error?.name || 'Error', code: error?.code || 'UNEXPECTED_ERROR', message: error?.message || String(error) };
}

function attachHealth(msg, assessment) {
  msg.health = assessment.health;
  msg.warnings = assessment.warnings;
  msg.homeConnect = {
    ...(msg.homeConnect || {}),
    health: assessment.health,
    warnings: assessment.warnings,
    healthSchema: assessment.schema,
    healthAt: assessment.updatedAt
  };
  return msg;
}

function statusForHealth(node, assessment, fallback) {
  const values = {
    ok: { fill: 'green', shape: 'dot', text: fallback || 'ok' },
    running: { fill: 'blue', shape: 'dot', text: 'running' },
    info: { fill: 'blue', shape: 'ring', text: 'info' },
    warning: { fill: 'yellow', shape: 'ring', text: 'warning' },
    action_required: { fill: 'yellow', shape: 'dot', text: 'action required' },
    offline: { fill: 'grey', shape: 'ring', text: 'offline' },
    error: { fill: 'red', shape: 'ring', text: 'error' }
  };
  node.status(values[assessment.health] || values.error);
}

function optionArray(value) {
  if (!value) return [];
  let options;
  if (Array.isArray(value)) {
    options = value.map(entry => ({
      key: entry?.key,
      value: entry?.value,
      ...(entry?.unit ? { unit: entry.unit } : {})
    }));
  } else if (typeof value === 'object') {
    options = Object.entries(value).map(([key, entry]) => {
      if (entry && typeof entry === 'object' && Object.hasOwn(entry, 'value')) {
        return { key, value: entry.value, ...(entry.unit ? { unit: entry.unit } : {}) };
      }
      return { key, value: entry };
    });
  } else {
    throw new HomeConnectError('options must be an array or object.', { code: 'INVALID_OPTIONS' });
  }
  if (options.length > 100) throw new HomeConnectError('A maximum of 100 options is allowed.', { code: 'TOO_MANY_OPTIONS' });
  return options;
}

function mergeLocalTestMappings(value, current) {
  const mappings = parseLocalDeviceMappings(value);
  const [selected] = parseLocalDeviceMappings([current]);
  const byId = new Map(mappings.map(mapping => [mapping.profileId, mapping]));
  // The values from the device card are authoritative, even when the hidden
  // editor field still contains the previous keystroke or deployed value.
  byId.set(selected.profileId, selected);
  return [...byId.values()];
}

function resolveLocalTestProfile(options = {}) {
  const mappings = mergeLocalTestMappings(options.mappings, {
    profileId: options.profileId,
    host: options.host,
    connectionType: options.connectionType || 'auto'
  });
  if (!mappings.find(mapping => mapping.profileId === options.profileId)?.host) {
    throw new HomeConnectError('Enter a Host/IP for this device.', { code: 'LOCAL_MAPPING_HOST_REQUIRED' });
  }
  const profiles = loadLocalProfiles({
    profilePath: options.profilePath,
    mappings,
    requireMapping: false,
    targetProfileId: options.profileId
  });
  return profiles[0];
}

function setSecurityHeaders(res) {
  res.set?.({
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
    'referrer-policy': 'no-referrer',
    'x-home-connect-build': BUILD_INFO.buildId,
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY'
  });
}

function oauthPage({ title, heading, message, code, success = false }) {
  const colour = success ? '#16794a' : '#b42318';
  const codeMarkup = code ? `<p><strong>Code:</strong> <code>${escapeHtml(code)}</code></p>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:48rem;margin:4rem auto;padding:0 1.25rem;color:#222}h1{color:${colour}}code{background:#f3f3f3;padding:.15rem .35rem;border-radius:.2rem}small{color:#666}</style></head><body><h1>${escapeHtml(heading)}</h1><p>${escapeHtml(message)}</p>${codeMarkup}<hr><p><small>Runtime build: ${escapeHtml(BUILD_INFO.buildId)}</small></p></body></html>`;
}

function sendOAuthError(res, error) {
  const payload = errorPayload(error);
  return res.status(error.status || 400).type('html').send(oauthPage({
    title: 'Home Connect authorization failed',
    heading: 'Home Connect authorization failed',
    message: payload.message,
    code: payload.code
  }));
}

function registerRoutes(RED) {
  const readPermission = RED.auth?.needsPermission
    ? RED.auth.needsPermission('home-connect.read')
    : (_req, _res, next) => next();
  const writePermission = RED.auth?.needsPermission
    ? RED.auth.needsPermission('home-connect.write')
    : (_req, _res, next) => next();

  RED.httpAdmin.get('/home-connect/diagnostics', readPermission, (_req, res) => {
    setSecurityHeaders(res);
    res.json({
      packageName: BUILD_INFO.packageName,
      packageVersion: BUILD_INFO.packageVersion,
      buildId: BUILD_INFO.buildId,
      loadedFrom: __dirname,
      oauth: {
        flow: BUILD_INFO.oauthFlow,
        pkce: BUILD_INFO.pkce,
        clientAuthentication: 'client_secret_post'
      }
    });
  });

  // Deliberately returns only non-secret setup state. The editor uses this to
  // prevent a first OAuth attempt before the configuration has been deployed.
  RED.httpAdmin.get('/home-connect/config/:id/status', readPermission, async (req, res) => {
    setSecurityHeaders(res);
    const config = RED.nodes.getNode(req.params.id);
    if (!config || config.type !== 'home-connect-config') {
      return res.status(404).json({ ok: false, code: 'CONFIG_NOT_FOUND' });
    }
    return res.json({
      ok: true,
      name: config.name || '',
      environment: config.environment,
      redirectUri: config.redirectUri || '',
      scope: config.scope || '',
      maxRequestsPerDay: config.maxRequestsPerDay,
      minimumRequestInterval: config.minimumRequestInterval,
      rateLimit: config.client.getRateLimitStatus
        ? await config.client.getRateLimitStatus()
        : { simulated: true, blocked: false },
      requiresOAuth: config.client.requiresOAuth,
      localReadOnly: config.environment === 'local',
      localProfilePath: config.environment === 'local' ? (config.localProfilePath || '') : '',
      localDeviceMappings: config.environment === 'local' ? JSON.stringify(config.localDeviceMappings || []) : '[]',
      localProfiles: config.environment === 'local' ? config.client.profiles.length : 0,
      localProtocolTrace: config.environment === 'local' ? config.localProtocolTrace : false,
      localProtocolTracePath: config.environment === 'local' ? (config.localProtocolTracePath || '') : '',
      hasClientId: Boolean(config.credentials?.clientId),
      hasClientSecret: Boolean(config.credentials?.clientSecret),
      hasRefreshToken: Boolean(config.credentials?.refreshToken),
      hasLocalProfileJson: Boolean(config.credentials?.localProfileJson),
      buildId: BUILD_INFO.buildId
    });
  });

  RED.httpAdmin.get('/home-connect/local-profiles/scan', readPermission, (req, res) => {
    setSecurityHeaders(res);
    try {
      const result = scanLocalProfileDirectory(req.query?.path);
      return res.json({ ok: true, ...result });
    } catch (error) {
      return res.status(error.status || 400).json({ ok: false, error: errorPayload(error) });
    }
  });

  if (RED.httpAdmin.post) {
    RED.httpAdmin.post('/home-connect/local-profiles/test', readPermission, async (req, res) => {
      setSecurityHeaders(res);
      let client;
      let testedProfileId = '';
      const diagnostics = new LocalConnectionDiagnostics();
      try {
        const profilePath = String(req.body?.path || '').trim();
        const profileId = String(req.body?.profileId || '').trim();
        testedProfileId = profileId;
        if (!profilePath) throw new HomeConnectError('The local profile folder is required.', { code: 'LOCAL_PROFILE_PATH_REQUIRED' });
        if (!profileId) throw new HomeConnectError('Select a detected device profile first.', { code: 'LOCAL_MAPPING_PROFILE_REQUIRED' });
        const profile = resolveLocalTestProfile({
          profilePath,
          profileId,
          host: req.body?.host,
          connectionType: req.body?.connectionType || 'auto',
          mappings: req.body?.mappings
        });
        validateLocalKeyMaterial(profile);
        const traceEnabled = req.body?.traceEnabled === true;
        const tracePath = String(req.body?.tracePath || '').trim();
        if (traceEnabled && tracePath && !path.isAbsolute(tracePath)) {
          throw new HomeConnectError('Protocol trace path must be absolute on the Node-RED host.', { code: 'LOCAL_TRACE_PATH_INVALID' });
        }
        diagnostics.pass('profile-loaded', {
          transport: profile.connectionType,
          profileTransport: profile.automaticConnectionType,
          declaredTransport: profile.declaredConnectionType
        });
        client = new LocalHomeConnectClient({
          profiles: [profile], requestTimeout: req.body?.requestTimeout,
          diagnostics, autoRefresh: false, traceEnabled, tracePath
        });
        const snapshot = await client.testConnection(profileId);
        return res.json({
          ok: true,
          appliance: snapshot.appliance,
          transport: snapshot.transport,
          readOnly: true,
          readValues: snapshot.values?.length || 0,
          services: Object.keys(snapshot.services || {}),
          protocolTrace: traceEnabled ? snapshot.protocolTrace : undefined,
          stages: diagnostics.snapshot()
        });
      } catch (error) {
        diagnostics.failFromError(error);
        return res.status(error.status || 400).json({
          ok: false,
          error: errorPayload(error),
          protocolTrace: client && testedProfileId && req.body?.traceEnabled === true ? client.getProtocolTrace(testedProfileId) : undefined,
          stages: diagnostics.snapshot()
        });
      } finally {
        client?.close();
      }
    });

    RED.httpAdmin.post('/home-connect/local-profiles/export', writePermission, async (req, res) => {
      setSecurityHeaders(res);
      try {
        const profilePath = String(req.body?.path || '').trim();
        const mappings = parseLocalDeviceMappings(req.body?.mappings);
        if (!profilePath) throw new HomeConnectError('The local profile folder is required.', { code: 'LOCAL_PROFILE_PATH_REQUIRED' });
        if (!mappings.length) throw new HomeConnectError('Scan the folder and complete every Host/IP assignment first.', { code: 'LOCAL_MAPPING_HOST_REQUIRED' });
        await Promise.all(mappings.map(mapping => {
          if (!mapping.host) throw new HomeConnectError(`Host/IP is missing for ${mapping.profileId}.`, { code: 'LOCAL_MAPPING_HOST_REQUIRED' });
          return assertLocalHost(mapping.host);
        }));
        const profileJson = exportLocalProfileJson({ profilePath, mappings });
        return res.json({ ok: true, profileJson, profiles: mappings.length });
      } catch (error) {
        return res.status(error.status || 400).json({ ok: false, error: errorPayload(error) });
      }
    });
  }

  RED.httpAdmin.get('/home-connect/oauth/:id/start', writePermission, async (req, res) => {
    setSecurityHeaders(res);
    try {
      const config = RED.nodes.getNode(req.params.id);
      if (!config || config.type !== 'home-connect-config') throw new HomeConnectError('Configuration node not found.', { code: 'CONFIG_NOT_FOUND', status: 404 });
       if (!config.client.requiresOAuth) throw new HomeConnectError('OAuth is not required for local or built-in simulator connections.', { code: 'OAUTH_NOT_REQUIRED' });
      if (!config.credentials?.clientId || !config.credentials?.clientSecret || !config.redirectUri) {
        throw new HomeConnectError('Client ID, client secret and redirect URI are required.', { code: 'OAUTH_CONFIGURATION_INCOMPLETE' });
      }
      const state = createState();
      for (const [key, value] of pendingOAuth) if (Date.now() - value.createdAt > OAUTH_TTL) pendingOAuth.delete(key);
      pendingOAuth.set(state, { nodeId: config.id, createdAt: Date.now() });
      const url = buildAuthorizationUrl({
        baseUrl: config.client.baseUrl,
        clientId: config.credentials.clientId,
        redirectUri: config.redirectUri,
        scope: config.scope,
        state
      });
      res.redirect(url);
    } catch (error) {
      sendOAuthError(res, error);
    }
  });

  RED.httpAdmin.get('/home-connect/config/:id/test', readPermission, async (req, res) => {
    try {
      const config = RED.nodes.getNode(req.params.id);
      if (!config || config.type !== 'home-connect-config') throw new HomeConnectError('Configuration node not found.', { code: 'CONFIG_NOT_FOUND', status: 404 });
       const appliances = config.environment === 'local'
         ? await config.client.discoverAll(true)
         : await config.client.listHomeAppliances();
      res.json({ ok: true, environment: config.environment, appliances });
    } catch (error) {
      res.status(error.status || 400).json({ ok: false, error: errorPayload(error) });
    }
  });

  RED.httpAdmin.get('/home-connect/config/:id/appliances', readPermission, async (req, res) => {
    try {
      const config = RED.nodes.getNode(req.params.id);
      if (!config || config.type !== 'home-connect-config') throw new HomeConnectError('Configuration node not found.', { code: 'CONFIG_NOT_FOUND', status: 404 });
      const appliances = config.environment === 'local'
        ? (await config.client.listHomeAppliances()).map(appliance => ({ appliance }))
        : await config.client.discoverAll(false);
      res.json({
        appliances: appliances.map(entry => entry?.appliance
          ? { ...entry, appliance: { ...entry.appliance, displayLabel: formatDeviceLabel(entry.appliance, config.language) } }
          : entry)
      });
    } catch (error) {
      res.status(error.status || 400).json({ error: errorPayload(error) });
    }
  });

  if (RED.httpNode) {
    RED.httpNode.get('/home-connect/oauth/callback', async (req, res) => {
      setSecurityHeaders(res);
      try {
        if (typeof req.query.state !== 'string' || !req.query.state) {
          throw new HomeConnectError('OAuth callback is missing state.', { code: 'OAUTH_STATE_INVALID' });
        }
        const state = req.query.state;
        const pending = pendingOAuth.get(state);
        pendingOAuth.delete(state);
        if (!pending || Date.now() - pending.createdAt > OAUTH_TTL) {
          throw new HomeConnectError('OAuth state is invalid or expired.', { code: 'OAUTH_STATE_INVALID' });
        }
        const config = RED.nodes.getNode(pending.nodeId);
        if (!config || config.type !== 'home-connect-config') throw new HomeConnectError('Configuration node is no longer available.', { code: 'CONFIG_NOT_FOUND', status: 404 });
        if (typeof req.query.error === 'string' && req.query.error) {
          const description = typeof req.query.error_description === 'string' && req.query.error_description
            ? req.query.error_description
            : req.query.error;
          throw new HomeConnectError(`Home Connect rejected the authorization request: ${description}`, {
            code: req.query.error,
            status: 400
          });
        }
        if (typeof req.query.code !== 'string' || !req.query.code) {
          throw new HomeConnectError('OAuth callback is missing the authorization code.', { code: 'OAUTH_CALLBACK_INVALID' });
        }
        await config.client.exchangeCode(req.query.code);
        res.type('html').send(oauthPage({
          title: 'Home Connect authorized',
          heading: 'Home Connect authorized',
          message: 'The refresh token was stored in the Node-RED credential store. You can close this window and return to Node-RED.',
          success: true
        }));
      } catch (error) {
        sendOAuthError(res, error);
      }
    });
  }
}

module.exports = function homeConnectNodes(RED) {
  function HomeConnectConfigNode(config) {
    RED.nodes.createNode(this, config);
    this.name = config.name;
    this.environment = config.environment || 'production';
    this.redirectUri = config.redirectUri;
    this.scope = config.scope || DEFAULT_SCOPE;
    this.language = config.language || 'en-GB';
    this.allowWrite = this.environment !== 'local' && (config.allowWrite === true || config.allowWrite === 'true');
    this.localProfilePath = config.localProfilePath || '';
    this.localDeviceMappings = parseLocalDeviceMappings(config.localDeviceMappings);
    this.localProtocolTrace = config.localProtocolTrace === true || config.localProtocolTrace === 'true';
    this.localProtocolTracePath = String(config.localProtocolTracePath || '').trim();
    if (this.localProtocolTrace && this.localProtocolTracePath && !path.isAbsolute(this.localProtocolTracePath)) {
      throw new HomeConnectError('Protocol trace path must be absolute on the Node-RED host.', { code: 'LOCAL_TRACE_PATH_INVALID' });
    }
    this.requestTimeout = Math.max(1000, Number(config.requestTimeout || 15000));
    this.maxRequestsPerDay = integerInRange(config.maxRequestsPerDay, DEFAULT_MAX_REQUESTS, 1, 1000);
    this.minimumRequestInterval = integerInRange(config.minimumRequestInterval, DEFAULT_MINIMUM_INTERVAL, 100, 60000);
    this.healthMonitor = new HealthMonitor();

    if (this.environment === 'builtin-simulator') {
      this.client = new BuiltinSimulator({ language: this.language });
    } else if (this.environment === 'local') {
      this.client = new LocalHomeConnectClient({
        // A configured folder is the primary source. The optional credential JSON
        // remains stored but is ignored until the folder field is cleared.
        profileJson: this.localProfilePath ? undefined : this.credentials?.localProfileJson,
        profilePath: this.localProfilePath,
        mappings: this.localDeviceMappings,
        requireMapping: Boolean(this.localProfilePath),
        requestTimeout: this.requestTimeout,
        traceEnabled: this.localProtocolTrace,
        tracePath: this.localProtocolTracePath,
        identity: this.id
      });
    } else {
      const rateLimitKey = `${this.environment}\0${this.credentials?.clientId || this.id}`;
      const rateLimitStore = RED.settings?.userDir
        ? createFileRateLimitStore(
          path.join(RED.settings.userDir, '.home-connect'),
          rateLimitKey
        )
        : undefined;
      const rateLimiter = useSharedRateLimiter(rateLimitKey, this.id, {
        maxRequests: this.maxRequestsPerDay,
        minimumIntervalMs: this.minimumRequestInterval,
        store: rateLimitStore
      });
      this.releaseRateLimiter = () => releaseSharedRateLimiter(rateLimitKey, this.id);
      this.client = new HomeConnectClient({
        environment: this.environment,
        clientId: this.credentials?.clientId,
        clientSecret: this.credentials?.clientSecret,
        redirectUri: this.redirectUri,
        scope: this.scope,
        language: this.language,
        requestTimeout: this.requestTimeout,
        rateLimiter,
        refreshToken: this.credentials?.refreshToken,
        onToken: tokens => {
          const credentials = { ...(this.credentials || {}) };
          if (tokens.refreshToken) credentials.refreshToken = tokens.refreshToken;
          this.credentials = credentials;
          RED.nodes.addCredentials(this.id, credentials);
        }
      });
    }

    this.on('close', (_removed, done) => {
      this.client.close?.();
      this.releaseRateLimiter?.();
      done?.();
    });
  }

  RED.nodes.registerType('home-connect-config', HomeConnectConfigNode, {
    credentials: {
      clientId: { type: 'text' },
      clientSecret: { type: 'password' },
      refreshToken: { type: 'password' },
      localProfileJson: { type: 'password' }
    }
  });

  function requireConfig(node, id) {
    const config = RED.nodes.getNode(id);
    if (!config) {
      node.status({ fill: 'red', shape: 'ring', text: 'configuration missing' });
      throw new HomeConnectError('Home Connect configuration is missing.', { code: 'CONFIG_MISSING' });
    }
    return config;
  }

  function sendError(node, msg, send, done, error) {
    const output = RED.util.cloneMessage(msg || {});
    delete output.confirm;
    output.payload = errorPayload(error);
    output.homeConnect = { ok: false, error: output.payload };
    const assessment = node.healthMonitor?.assessError(error) || new HealthMonitor().assessError(error);
    attachHealth(output, assessment);
    statusForHealth(node, assessment, output.payload.code || 'error');
    node.error(error);
    send([null, output]);
    done?.();
  }

  function HomeConnectDiscoverNode(config) {
    RED.nodes.createNode(this, config);
    this.connection = config.connection;
    this.mode = config.mode || 'all';
    this.haId = config.haId;
    const connection = requireConfig(this, this.connection);
    this.healthMonitor = connection.healthMonitor;
    this.on('input', async (msg, send, done) => {
      send = send || this.send.bind(this);
      try {
        this.status({ fill: 'blue', shape: 'dot', text: 'discovering' });
        const haId = msg.haId || this.haId;
        const payload = this.mode === 'all' || !haId
          ? await connection.client.discoverAll(msg.force === true)
          : await connection.client.discoverAppliance(haId, msg.force === true);
        msg.payload = payload;
        msg.homeConnect = { ok: true, operation: 'discover', environment: connection.environment };
        const assessment = connection.healthMonitor.assessPayload(payload, { haId, operation: 'discover' });
        attachHealth(msg, assessment);
        statusForHealth(this, assessment, Array.isArray(payload) ? `${payload.length} appliances` : 'discovered');
        send([msg, null]);
        done?.();
      } catch (error) {
        sendError(this, msg, send, done, error);
      }
    });
  }
  RED.nodes.registerType('home-connect-discover', HomeConnectDiscoverNode);

  function HomeConnectReadNode(config) {
    RED.nodes.createNode(this, config);
    this.connection = config.connection;
    this.operation = READ_OPERATIONS.includes(config.operation) ? config.operation : 'snapshot';
    this.haId = config.haId;
    this.key = config.key;
    this.subKey = config.subKey;
    const connection = requireConfig(this, this.connection);
    this.healthMonitor = connection.healthMonitor;
    this.on('input', async (msg, send, done) => {
      send = send || this.send.bind(this);
      try {
        const operation = msg.operation || this.operation;
        const haId = msg.haId || this.haId;
        msg.haId = haId;
        const key = msg.key ?? this.key;
        const subKey = msg.subKey ?? this.subKey;
        if (!READ_OPERATIONS.includes(operation)) throw new HomeConnectError(`Unsupported read operation: ${operation}`, { code: 'READ_ACTION_NOT_ALLOWED' });
        this.status({ fill: 'blue', shape: 'dot', text: operation });
        msg.payload = await connection.client.read(haId, operation, key, subKey);
        msg.haId = haId;
        msg.homeConnect = { ok: true, operation, environment: connection.environment, at: new Date().toISOString() };
        const assessment = connection.healthMonitor.assessPayload(msg.payload, { haId, operation });
        attachHealth(msg, assessment);
        statusForHealth(this, assessment, operation);
        send([msg, null]);
        done?.();
      } catch (error) {
        sendError(this, msg, send, done, error);
      }
    });
  }
  RED.nodes.registerType('home-connect-read', HomeConnectReadNode);

  function HomeConnectEventsNode(config) {
    RED.nodes.createNode(this, config);
    this.connection = config.connection;
    this.haId = config.haId || '*';
    const connection = requireConfig(this, this.connection);
    this.healthMonitor = connection.healthMonitor;
    let closeStream;
    const start = haId => {
      closeStream?.();
      this.status({ fill: 'yellow', shape: 'ring', text: 'connecting' });
      closeStream = connection.client.openEvents(haId, event => {
        const assessment = connection.healthMonitor.assessEvent(event);
        statusForHealth(this, assessment, event.event || 'event');
        const output = attachHealth({
          topic: event.event,
          haId: event.haId,
          payload: event,
          homeConnect: { ok: true, operation: 'event', environment: connection.environment }
        }, assessment);
        this.send([output, null]);
      }, error => {
        const assessment = connection.healthMonitor.assessError(error);
        statusForHealth(this, assessment, 'reconnecting');
        this.send([null, attachHealth({
          haId: error?.haId,
          payload: errorPayload(error),
          homeConnect: { ok: false, operation: 'event', environment: connection.environment }
        }, assessment)]);
      });
    };
    start(this.haId);
    this.on('input', (msg, _send, done) => {
      start(msg.haId || this.haId);
      done?.();
    });
    this.on('close', (_removed, done) => {
      closeStream?.();
      done?.();
    });
  }
  RED.nodes.registerType('home-connect-events', HomeConnectEventsNode);

  function HomeConnectWriteNode(config) {
    RED.nodes.createNode(this, config);
    this.connection = config.connection;
    this.action = config.action || 'from-message';
    this.haId = config.haId;
    this.dryRun = config.dryRun !== false;
    this.confirmationMode = config.confirmationMode || 'token';
    this.confirmationToken = this.credentials?.confirmationToken || 'CONFIRM';
    this.allowedApplianceTypes = String(config.allowedApplianceTypes || '').split(',').map(value => value.trim()).filter(Boolean);
    const connection = requireConfig(this, this.connection);
    this.healthMonitor = connection.healthMonitor;

    this.on('input', async (msg, send, done) => {
      send = send || this.send.bind(this);
      try {
        if (connection.environment === 'local') {
          throw new HomeConnectError('Local Home Connect access is deliberately read-only.', { code: 'LOCAL_READ_ONLY', status: 403 });
        }
        if (!connection.allowWrite) throw new HomeConnectError('Write access is disabled in the configuration node.', { code: 'WRITE_DISABLED' });
        const input = msg.payload && typeof msg.payload === 'object' && !Array.isArray(msg.payload) ? msg.payload : {};
        const action = this.action === 'from-message' ? (msg.action || input.action) : this.action;
        if (!WRITE_ACTIONS.includes(action)) throw new HomeConnectError(`Unsupported write action: ${action}`, { code: 'WRITE_ACTION_NOT_ALLOWED' });
        const request = {
          action,
          haId: msg.haId || input.haId || this.haId,
          program: msg.program || input.program,
          key: msg.key || input.key,
          value: msg.value !== undefined ? msg.value : input.value,
          options: optionArray(msg.options || input.options)
        };
        if (!request.haId) throw new HomeConnectError('haId is required.', { code: 'HAID_REQUIRED' });
        if (this.confirmationMode === 'token' && msg.confirm !== this.confirmationToken && input.confirm !== this.confirmationToken) {
          throw new HomeConnectError('Write confirmation token is missing or invalid.', { code: 'CONFIRMATION_REQUIRED' });
        }
        this.status({ fill: 'yellow', shape: 'dot', text: this.dryRun ? 'validating' : 'writing' });
        const capability = await connection.client.discoverAppliance(request.haId, true);
        if (this.allowedApplianceTypes.length && !this.allowedApplianceTypes.includes(capability.appliance.type)) {
          throw new HomeConnectError(`Writes to appliance type ${capability.appliance.type} are not allowed by this node.`, { code: 'APPLIANCE_TYPE_NOT_ALLOWED' });
        }
        validateWrite(capability, request);
        const result = this.dryRun
          ? { accepted: false, dryRun: true, validated: true, request, capabilityTimestamp: capability.discoveredAt }
          : await connection.client.write(request, capability);
        delete msg.confirm;
        msg.payload = result;
        msg.homeConnect = { ok: true, operation: 'write', action, dryRun: this.dryRun, environment: connection.environment };
        const assessment = connection.healthMonitor.current(request.haId);
        attachHealth(msg, assessment);
        statusForHealth(this, assessment, this.dryRun ? 'dry-run valid' : 'written');
        send([msg, null]);
        done?.();
      } catch (error) {
        sendError(this, msg, send, done, error);
      }
    });
  }
  RED.nodes.registerType('home-connect-write', HomeConnectWriteNode, {
    credentials: { confirmationToken: { type: 'password' } }
  });

  registerRoutes(RED);
};

module.exports.optionArray = optionArray;
module.exports.mergeLocalTestMappings = mergeLocalTestMappings;
module.exports.resolveLocalTestProfile = resolveLocalTestProfile;
module.exports.errorPayload = errorPayload;
module.exports.attachHealth = attachHealth;
module.exports.BUILD_INFO = BUILD_INFO;
