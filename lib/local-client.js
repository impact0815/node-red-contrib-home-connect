'use strict';

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { HomeConnectError } = require('./errors');
const { AesMessageCrypto } = require('./local-crypto');
const { loadLocalProfiles, publicProfile } = require('./local-profile');
const { HomeConnectWebSocketTransport } = require('./websocket-transport');
const { LocalProtocolTrace } = require('./local-trace');
const { READ_OPERATIONS } = require('./constants');

// Community implementations initialize mandatory/current values before the
// optional description/program resources. Every request remains a GET.
const READ_RESOURCES = Object.freeze([
  '/ro/allMandatoryValues',
  '/ro/values',
  '/ro/allDescriptionChanges',
  '/ro/activeProgram',
  '/ro/selectedProgram'
]);

function withTimeout(promise, timeoutMs, code, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new HomeConnectError(message, { code })), timeoutMs);
      timer.unref?.();
    })
  ]).finally(() => clearTimeout(timer));
}

function compactMessage(value) { return JSON.stringify(value); }

function parseMessage(value) {
  try { return JSON.parse(value); }
  catch (cause) {
    try { return JSON.parse(String(value).replace(/\]"/g, ']')); }
    catch { throw new HomeConnectError('The local appliance sent invalid JSON.', { code: 'LOCAL_MESSAGE_INVALID', cause }); }
  }
}

function serviceName(resource) {
  return String(resource || '').split('/').filter(Boolean)[0] || 'ci';
}

function messageData(message) {
  if (Array.isArray(message?.data)) return message.data;
  if (!message?.data || typeof message.data !== 'object') return [];
  for (const key of ['services', 'items', 'values']) {
    if (Array.isArray(message.data[key])) return message.data[key];
  }
  return [message.data];
}

function serviceVersions(message) {
  const result = {};
  for (const entry of messageData(message)) {
    const service = String(entry?.service || entry?.name || '').replace(/^\/+|\/+$/g, '').toLowerCase();
    const version = Number(entry?.version ?? entry?.serviceVersion ?? 1);
    if (service && Number.isFinite(version) && version > 0) result[service] = version;
  }
  return result;
}

function acceptedResponseCode(code) {
  return code === undefined || code === null || code === '' || Number(code) === 0 || Number(code) === 200;
}

function protocolResponseError(message, pending = {}) {
  const deviceCode = Number(message?.code);
  const resource = message?.resource || pending.resource || 'unknown resource';
  const action = pending.action || 'request';
  const version = pending.version ?? message?.version;
  return new HomeConnectError(`Local appliance rejected ${action} ${resource} (version ${version}) with code ${message?.code}.`, {
    code: 'LOCAL_PROTOCOL_REJECTED',
    status: Number.isFinite(deviceCode) ? deviceCode : undefined,
    details: {
      category: 'protocol',
      resource,
      action,
      version,
      deviceCode: message?.code,
      hintDe: 'Ressource, Aktion und ausgehandelte Service-Version mit dem Geräteprofil bzw. Mitschnitt vergleichen.',
      hintEn: 'Compare the resource, action, and negotiated service version with the appliance profile or protocol trace.'
    }
  });
}

function shortName(name) {
  const text = String(name || '');
  return text.includes('.') ? text.slice(text.lastIndexOf('.') + 1) : text;
}

function itemCategory(feature = {}, key = '') {
  const declared = String(feature.category || '').toLowerCase().replace(/s$/, '');
  if (['status', 'setting', 'event', 'option', 'program', 'command'].includes(declared)) return declared;
  if (/\.Status\./.test(key)) return 'status';
  if (/\.Setting\./.test(key)) return 'setting';
  if (/\.Event\./.test(key)) return 'event';
  if (/\.Option\./.test(key)) return 'option';
  if (/\.Program\./.test(key)) return 'program';
  if (/\.Command\./.test(key)) return 'command';
  return 'value';
}

function isOfflineError(error) {
  if (error?.details?.category === 'network') return true;
  return new Set([
    'LOCAL_NETWORK_ERROR', 'LOCAL_CONNECT_TIMEOUT', 'LOCAL_WEBSOCKET_TIMEOUT',
    'LOCAL_DISCONNECTED', 'LOCAL_HANDSHAKE_TIMEOUT', 'LOCAL_REQUEST_TIMEOUT',
    'LOCAL_HEARTBEAT_TIMEOUT', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH',
    'ENETUNREACH', 'ENETDOWN', 'EAI_AGAIN', 'ENOTFOUND', 'ETIMEDOUT'
  ]).has(error?.code);
}

function safeOfflineReason(error) {
  if (!error) return undefined;
  return {
    code: String(error.code || '').startsWith('LOCAL_') ? error.code : 'LOCAL_NETWORK_ERROR',
    category: 'network',
    ...(error.details?.causeCode ? { causeCode: error.details.causeCode } : {}),
    ...(error.details?.hintDe ? { hintDe: error.details.hintDe } : {}),
    ...(error.details?.hintEn ? { hintEn: error.details.hintEn } : {})
  };
}

function profileBoolean(rawValue) {
  if (rawValue === true || rawValue === false) return { matched: true, value: rawValue };
  const text = String(rawValue).toLowerCase();
  if (rawValue === 1 || rawValue === '1' || text === 'true' || text.endsWith('.true')) return { matched: true, value: true };
  if (rawValue === 0 || rawValue === '0' || text === 'false' || text.endsWith('.false')) return { matched: true, value: false };
  return { matched: false, value: rawValue };
}

function safeRawDiagnostic(rawValue) {
  if (rawValue === null) return 'null';
  if (['number', 'boolean'].includes(typeof rawValue)) return String(rawValue);
  if (typeof rawValue === 'string' && /^-?\d+(?:\.\d+)?$/.test(rawValue)) return rawValue;
  return `[${typeof rawValue}]`;
}

function findEdMessageId(value) {
  if (!value || typeof value !== 'object') return undefined;
  if (Object.hasOwn(value, 'edMsgID') && Number.isFinite(Number(value.edMsgID))) return Number(value.edMsgID);
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const found = findEdMessageId(child);
    if (found !== undefined) return found;
  }
  return undefined;
}

function valueEntries(value, result = [], seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return result;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) valueEntries(item, result, seen);
    return result;
  }
  if (Object.hasOwn(value, 'uid') && Object.hasOwn(value, 'value')) result.push(value);
  for (const [key, child] of Object.entries(value)) {
    if (key === 'uid' || key === 'value') continue;
    if (child && typeof child === 'object') valueEntries(child, result, seen);
  }
  return result;
}

function aggregateProtocolRejection(failures) {
  const rejected = failures.filter(item => item.error?.code === 'LOCAL_PROTOCOL_REJECTED');
  const first = rejected[0]?.error;
  if (!first) return failures[0]?.error;
  const rejections = rejected.map(item => ({
    resource: item.resource,
    action: item.error.details?.action || 'GET',
    version: item.error.details?.version,
    deviceCode: item.error.details?.deviceCode
  }));
  return new HomeConnectError(
    `The appliance rejected the local read sequence. First rejection: ${rejections[0].action} ${rejections[0].resource} (version ${rejections[0].version}), code ${rejections[0].deviceCode}.`,
    {
      code: 'LOCAL_PROTOCOL_REJECTED',
      status: first.status,
      cause: first,
      details: {
        ...first.details,
        stage: 'readonly-data-received',
        rejections,
        rejectedResources: rejections.map(item => `${item.action} ${item.resource} v${item.version}: ${item.deviceCode}`)
      }
    }
  );
}

class LocalApplianceSession extends EventEmitter {
  constructor(profile, options = {}) {
    super();
    this.profile = profile;
    this.timeoutMs = Math.max(1000, Number(options.timeoutMs || 15000));
    this.appName = options.appName || 'node-red-home-connect';
    this.appId = options.appId || crypto.randomBytes(8).toString('hex');
    this.transportFactory = options.transportFactory || (transportOptions => new HomeConnectWebSocketTransport(transportOptions));
    this.diagnostics = options.diagnostics;
    this.autoRefresh = options.autoRefresh !== false;
    this.trace = options.trace || new LocalProtocolTrace({
      enabled: options.traceEnabled === true,
      path: options.tracePath,
      profile: profile.haId
    });
    this.services = {};
    this.values = new Map();
    this.pending = new Map();
    this.connected = false;
    this.connecting = null;
    this.closed = false;
    this.watchers = 0;
    this.reconnectBaseDelay = 1000;
    this.reconnectDelay = this.reconnectBaseDelay;
    this.reconnectAttempt = 0;
    this.transportGeneration = 0;
    this.readEvidence = { messages: 0, responses: 0, notifications: 0, values: 0, lastResource: undefined, lastAction: undefined };
    this.optionalFailures = [];
    this.lastValueAt = undefined;
  }

  get versionInfo() { return { ...this.services }; }
  get protocolTrace() { return this.trace.snapshot(); }

  ensureConnected() {
    if (this.connected) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = this._connect().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async _connect() {
    if (this.closed) throw new HomeConnectError('The local appliance session is closed.', { code: 'LOCAL_SESSION_CLOSED' });
    const generation = ++this.transportGeneration;
    this._clearSessionState();
    this.trace.event('connect-start', { transport: this.profile.connectionType, attempt: this.reconnectAttempt + 1 });
    try {
      this.crypto = this.profile.connectionType === 'AES'
        ? new AesMessageCrypto({ psk64: this.profile.psk64, iv64: this.profile.iv64 })
        : null;
      const transport = this.transportFactory({
        host: this.profile.host,
        mode: this.profile.connectionType,
        psk64: this.profile.psk64,
        pskIdentity: this.profile.pskIdentity,
        timeoutMs: this.timeoutMs,
        onStage: (stage, details) => this.diagnostics?.pass(stage, details)
      });
      this.transport = transport;
      transport.on('message', (payload, binary) => {
        if (generation === this.transportGeneration) this._receive(payload, binary);
      });
      transport.on('error', error => {
        if (generation === this.transportGeneration) this._transportError(error);
      });
      transport.on('close', () => {
        if (generation === this.transportGeneration) this._transportClosed();
      });
      const initialized = new Promise((resolve, reject) => { this.initialized = { resolve, reject, settled: false }; });
      await transport.connect();
      await withTimeout(initialized, this.timeoutMs, 'LOCAL_HANDSHAKE_TIMEOUT', 'The local Home Connect handshake timed out.');
      this.connected = true;
      this.reconnectDelay = this.reconnectBaseDelay;
      this.reconnectAttempt = 0;
      this.emit('event', this._event('CONNECTED', { items: [] }, { synthetic: true, transport: this.profile.connectionType }));
      if (this.autoRefresh) await this.refresh().catch(error => this.emit('warning', error));
    } catch (error) {
      this.trace.event('connect-failed', { code: error.code, details: error.details });
      this.diagnostics?.failFromError(error);
      if (generation === this.transportGeneration) {
        try { this.transport?.close(); } catch { /* no-op */ }
      }
      throw error;
    }
  }

  _clearSessionState() {
    this.connected = false;
    this.sessionId = null;
    this.nextMessageId = null;
    this.services = {};
    this.optionalFailures = [];
  }

  _receive(payload, binary) {
    try {
      let text;
      if (this.crypto) {
        if (!binary) throw new HomeConnectError('AES appliance sent a non-binary WebSocket frame.', { code: 'LOCAL_CRYPTO_FRAME_INVALID' });
        text = this.crypto.decrypt(payload);
      } else {
        text = Buffer.from(payload).toString('utf8');
      }
      const message = parseMessage(text);
      this.trace.record('rx', message, { binary: Boolean(binary) });
      this._handleMessage(message);
    } catch (error) {
      this.trace.event('receive-error', { code: error.code, message: error.message });
      this._emitError(error);
      if (String(error.code || '').startsWith('LOCAL_CRYPTO_') || error.code === 'LOCAL_MESSAGE_INVALID') this.transport?.close();
    }
  }

  _handleMessage(message) {
    message.sID = Number(message.sID);
    message.msgID = Number(message.msgID);
    message.version = Number(message.version || 1);
    message.action = String(message.action || '').toUpperCase();
    if (!Number.isFinite(message.sID) || !Number.isFinite(message.msgID)) {
      throw new HomeConnectError('The local appliance message has invalid identifiers.', { code: 'LOCAL_MESSAGE_INVALID' });
    }

    if (message.resource === '/ei/initialValues' && ['POST', 'GET', 'NOTIFY'].includes(message.action)) {
      this._startHandshake(message);
      return;
    }

    if (this.sessionId != null && message.sID !== this.sessionId) {
      this.trace.event('stale-session-message', { expectedSID: this.sessionId, receivedSID: message.sID, resource: message.resource });
      return;
    }

    if (['GET', 'POST'].includes(message.action)) {
      this._respondToDeviceRequest(message);
      return;
    }

    if (message.resource === '/ei/keepAlive' || message.resource === '/ci/keepAlive') {
      this.trace.event('protocol-keepalive', { action: message.action, resource: message.resource });
    }

    const carriesReadData = String(message.resource || '').startsWith('/ro/') || valueEntries(message.data).length;
    const acceptedReadMessage = message.action !== 'RESPONSE' || acceptedResponseCode(message.code);
    if (carriesReadData && acceptedReadMessage) {
      this._recordReadEvidence(message);
      this._applyResource(message);
    }

    if (message.action === 'RESPONSE' && this.pending.has(message.msgID)) {
      const pending = this.pending.get(message.msgID);
      this.pending.delete(message.msgID);
      clearTimeout(pending.timer);
      if (message.resource && pending.resource !== message.resource) {
        pending.reject(new HomeConnectError(`Local response resource mismatch: expected ${pending.resource}, received ${message.resource}.`, {
          code: 'LOCAL_PROTOCOL_RESPONSE_MISMATCH',
          details: { category: 'protocol', expectedResource: pending.resource, resource: message.resource, action: pending.action, version: pending.version }
        }));
      } else if (!acceptedResponseCode(message.code)) {
        pending.reject(protocolResponseError(message, pending));
      } else {
        pending.resolve(message);
      }
    }
  }

  _startHandshake(initial) {
    this._handshake(initial).catch(error => {
      if (this.initialized && !this.initialized.settled) {
        this.initialized.settled = true;
        this.initialized.reject(error);
      }
      this._emitError(error);
      this.transport?.close();
    });
  }

  async _handshake(initial) {
    const startId = findEdMessageId(initial.data);
    if (!Number.isFinite(startId)) throw new HomeConnectError('The local appliance handshake did not provide edMsgID.', { code: 'LOCAL_HANDSHAKE_INVALID' });

    if (this.sessionId != null && this.sessionId !== initial.sID) {
      this._rejectPending(new HomeConnectError('The appliance started a new local session.', { code: 'LOCAL_SESSION_REPLACED' }));
      this.services = {};
    }
    this.sessionId = initial.sID;
    this.nextMessageId = startId;
    const initialValues = valueEntries(initial.data);
    if (initialValues.length) {
      this._recordReadEvidence(initial);
      this._applyResource(initial);
    }
    this._sendResponse(initial, [{
      deviceType: initial.version === 1 ? 2 : 'Application',
      deviceName: this.appName,
      deviceID: this.appId
    }]);
    this.diagnostics?.pass('session-initialized', { transport: this.profile.connectionType });

    const services = await this.request('/ci/services', 'GET', undefined, 1);
    this.services = serviceVersions(services);
    if (!Object.keys(this.services).length) {
      throw new HomeConnectError('The appliance returned no usable service versions.', {
        code: 'LOCAL_SERVICES_INVALID',
        details: { category: 'protocol', resource: '/ci/services', action: 'GET', version: 1 }
      });
    }
    this.diagnostics?.pass('services-recognized', {
      services: Object.entries(this.services).map(([name, version]) => `${name}:${version}`),
      serviceCount: Object.keys(this.services).length
    });

    const ciVersion = this.services.ci || 1;
    if (ciVersion < 3) await this._authenticate(ciVersion);
    const eiVersion = Number(this.services.ei || initial.version || 1);
    this.notify('/ei/deviceReady', undefined, eiVersion);
    await this._readOptionalInfo();

    if (this.initialized && !this.initialized.settled) {
      this.initialized.settled = true;
      this.initialized.resolve();
    }
  }

  async _authenticate(ciVersion) {
    const nonce = crypto.randomBytes(32).toString('base64url');
    const attempts = [];
    // hcpy sends POST. Some firmware documented/implemented GET, so retry GET
    // only after a concrete protocol rejection.
    for (const version of [...new Set([ciVersion, 2])]) {
      attempts.push({ action: 'POST', version }, { action: 'GET', version });
    }
    let lastError;
    for (const attempt of attempts) {
      try {
        await this.request('/ci/authentication', attempt.action, { nonce }, attempt.version);
        return;
      } catch (error) {
        if (error.code !== 'LOCAL_PROTOCOL_REJECTED') throw error;
        lastError = error;
      }
    }
    throw new HomeConnectError('The appliance rejected local profile authentication.', {
      code: 'LOCAL_PROFILE_AUTHENTICATION_FAILED',
      status: lastError?.status,
      details: { ...lastError?.details, category: 'profile' },
      cause: lastError
    });
  }

  async _readOptionalInfo() {
    const requests = [];
    if (this.services.iz) requests.push(['/iz/info', this.services.iz]);
    else if (this.services.ci) requests.push(['/ci/info', this.services.ci]);
    if (this.services.ni) requests.push(['/ni/info', this.services.ni]);
    for (const [resource, version] of requests) {
      try { await this.request(resource, 'GET', undefined, version); }
      catch (error) {
        this.optionalFailures.push({ resource, action: 'GET', version, code: error.code, deviceCode: error.details?.deviceCode });
        this.trace.event('optional-request-failed', { resource, action: 'GET', version, code: error.code, deviceCode: error.details?.deviceCode });
      }
    }
  }

  _respondToDeviceRequest(message) {
    // Device-originated requests are protocol housekeeping, not appliance
    // control. Acknowledge them without issuing any write resource.
    this._sendResponse(message, undefined);
    this.trace.event('device-request-acknowledged', {
      resource: message.resource,
      action: message.action,
      version: message.version,
      msgID: message.msgID
    });
  }

  _sendResponse(request, data, code) {
    const response = {
      sID: request.sID,
      msgID: request.msgID,
      resource: request.resource,
      version: request.version,
      action: 'RESPONSE'
    };
    if (data !== undefined) response.data = Array.isArray(data) ? data : [data];
    if (code !== undefined) response.code = code;
    this._send(response);
  }

  _send(message) {
    const text = compactMessage(message);
    this.trace.record('tx', message, { binary: Boolean(this.crypto) });
    if (this.crypto) this.transport.send(this.crypto.encrypt(text), true);
    else this.transport.send(Buffer.from(text), false);
  }

  request(resource, action = 'GET', data, version) {
    if (!this.transport || this.sessionId == null || !Number.isFinite(this.nextMessageId)) {
      return Promise.reject(new HomeConnectError('Local appliance is not connected.', { code: 'LOCAL_NOT_CONNECTED' }));
    }
    const msgID = this.nextMessageId++;
    const requestVersion = Number(version || this.services[serviceName(resource)] || 1);
    const message = { sID: this.sessionId, msgID, resource, version: requestVersion, action: String(action).toUpperCase() };
    if (data !== undefined) message.data = Array.isArray(data) ? data : [data];
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(msgID);
        reject(new HomeConnectError(`Local request timed out: ${message.action} ${resource} (version ${requestVersion}).`, {
          code: 'LOCAL_REQUEST_TIMEOUT',
          details: {
            category: 'network', resource, action: message.action, version: requestVersion,
            hintDe: 'Gerät kann im Standby/ausgeschaltet sein oder VLAN/Firewall blockiert die bestehende Verbindung.',
            hintEn: 'The appliance may be asleep/offline, or a VLAN/firewall may be interrupting the established connection.'
          }
        }));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(msgID, { resolve, reject, timer, resource, action: message.action, version: requestVersion });
      try { this._send(message); }
      catch (error) { clearTimeout(timer); this.pending.delete(msgID); reject(error); }
    });
  }

  notify(resource, data, version) {
    if (this.sessionId == null || !Number.isFinite(this.nextMessageId)) throw new HomeConnectError('Local session is not initialized.', { code: 'LOCAL_NOT_CONNECTED' });
    const message = {
      sID: this.sessionId,
      msgID: this.nextMessageId++,
      resource,
      version: Number(version || this.services[serviceName(resource)] || 1),
      action: 'NOTIFY'
    };
    if (data !== undefined) message.data = Array.isArray(data) ? data : [data];
    this._send(message);
  }

  async refresh() {
    if (!this.connected) await this.ensureConnected();
    const results = [];
    const failures = [];
    const before = this.readEvidence.messages;
    const roVersion = Number(this.services.ro || 1);

    for (const resource of READ_RESOURCES) {
      try {
        const response = await this.request(resource, 'GET', undefined, roVersion);
        results.push({ resource, action: 'GET', version: roVersion, ok: true, itemCount: valueEntries(response.data).length });
      } catch (error) {
        const failure = { resource, action: 'GET', version: roVersion, ok: false, code: error.code, status: error.status, deviceCode: error.details?.deviceCode };
        results.push(failure);
        failures.push({ resource, error });
      }
    }

    const newEvidence = this.readEvidence.messages > before;
    const existingEvidence = this.readEvidence.messages > 0 || this.values.size > 0;
    const successfulResponse = results.some(item => item.ok);
    if (!newEvidence && !existingEvidence && !successfulResponse) {
      const nonProtocol = failures.find(item => item.error?.code !== 'LOCAL_PROTOCOL_REJECTED')?.error;
      if (nonProtocol) throw nonProtocol;
      throw aggregateProtocolRejection(failures) || new HomeConnectError('The appliance returned no read-only data.', {
        code: 'LOCAL_VALUES_UNAVAILABLE', details: { stage: 'readonly-data-received', category: 'protocol' }
      });
    }

    const readSource = this.readEvidence.notifications > 0 && !successfulResponse
      ? 'device-notify'
      : (this.readEvidence.values > 0 ? 'values' : 'successful-read-response');
    const resolution = this.resolutionSummary();
    this.diagnostics?.pass('readonly-data-received', {
      valueCount: this.values.size,
      readResponses: results.filter(item => item.ok).length,
      readSource,
      featureCount: resolution.featureCount,
      resolvedItemCount: resolution.resolvedItemCount,
      unresolvedItemCount: resolution.unresolvedItemCount,
      valueResolvedItemCount: resolution.valueResolvedItemCount,
      unresolvedValueCount: resolution.unresolvedValueCount,
      statusCount: resolution.statusCount,
      settingsCount: resolution.settingsCount,
      programCount: resolution.programCount,
      unresolvedValues: resolution.unresolvedValues,
      rejectedResources: results.filter(item => !item.ok).map(item => `${item.action} ${item.resource} v${item.version}: ${item.deviceCode ?? item.code}`)
    });
    return results;
  }

  _recordReadEvidence(message) {
    this.readEvidence.messages++;
    if (message.action === 'NOTIFY') this.readEvidence.notifications++;
    if (message.action === 'RESPONSE') this.readEvidence.responses++;
    this.readEvidence.values += valueEntries(message.data).length;
    this.readEvidence.lastResource = message.resource;
    this.readEvidence.lastAction = message.action;
  }

  _applyResource(message) {
    const data = Array.isArray(message.data) ? message.data : (message.data && typeof message.data === 'object' ? [message.data] : []);
    if (message.resource === '/ro/activeProgram') this.activeProgram = this._programFromResource(data);
    if (message.resource === '/ro/selectedProgram') this.selectedProgram = this._programFromResource(data);
    const changed = [];
    for (const entry of valueEntries(data)) {
      const uid = String(entry.uid);
      this.values.set(uid, entry.value);
      const item = this.item(uid, entry.value);
      changed.push(item);
      if (item.key === 'BSH.Common.Root.ActiveProgram') this.activeProgram = this._program(item.rawValue);
      if (item.key === 'BSH.Common.Root.SelectedProgram') this.selectedProgram = this._program(item.rawValue);
    }
    if (changed.length) {
      this.lastValueAt = new Date().toISOString();
      const programs = this.programState();
      this.emit('event', this._event('STATUS', {
        items: changed,
        programs
      }, { resource: message.resource, action: message.action }));
    }
  }

  item(uid, rawValue = this.values.get(String(uid))) {
    const feature = this.profile.features[String(uid)] || {};
    const values = feature.values || {};
    const key = feature.name || String(uid);
    const rawKey = String(rawValue);
    const keyResolved = Boolean(feature.name);
    let value = rawValue;
    let valueResolved = false;
    let resolution = keyResolved ? 'unresolved-profile-value' : 'raw-uid';
    const booleanType = /bool(?:ean)?/i.test(String(feature.type || ''));
    const enumDeclared = Boolean(feature.enumDeclared || feature.enumerationType || feature.subsetOf || Object.keys(values).length);
    const scalarDeclared = Boolean(keyResolved && !enumDeclared && (
      feature.type || feature.unit || feature.min !== undefined || feature.max !== undefined || feature.stepSize !== undefined
    ));
    if (Object.hasOwn(values, rawKey)) {
      value = values[rawKey];
      valueResolved = true;
      resolution = 'profile-enum';
      if (booleanType) {
        const boolean = profileBoolean(value);
        if (boolean.matched) {
          value = boolean.value;
          resolution = 'profile-enum-boolean';
        }
      }
    } else if (key === 'BSH.Common.Root.ActiveProgram' || key === 'BSH.Common.Root.SelectedProgram') {
      const program = this.profile.features[rawKey];
      if (program?.name) {
        value = program.name;
        valueResolved = true;
        resolution = 'profile-program';
      } else if (rawValue === undefined || rawValue === null || rawValue === '' || Number(rawValue) === 0) {
        valueResolved = true;
        resolution = 'profile-no-program';
      } else if (typeof rawValue === 'string' && /\.Program\./.test(rawValue)) {
        valueResolved = true;
        resolution = 'semantic-program';
      } else {
        valueResolved = false;
        resolution = 'unresolved-program';
      }
    } else if (enumDeclared) {
      valueResolved = false;
      resolution = 'unresolved-enum';
    } else if (booleanType) {
      const boolean = profileBoolean(rawValue);
      value = boolean.value;
      valueResolved = keyResolved && boolean.matched;
      resolution = boolean.matched && keyResolved ? 'profile-boolean' : 'unresolved-boolean';
    } else if (scalarDeclared) {
      valueResolved = true;
      resolution = 'profile-scalar';
    }
    return {
      key, value, rawValue, uid: Number.isFinite(Number(uid)) ? Number(uid) : uid,
      category: itemCategory(feature, key), resolved: keyResolved, keyResolved, valueResolved, resolution,
      ...(feature.access ? { access: feature.access } : {}),
      ...(feature.unit ? { unit: feature.unit } : {}),
      ...(feature.type ? { type: feature.type } : {}),
      ...(feature.enumName ? { enumName: feature.enumName } : {})
    };
  }

  items() { return [...this.values.entries()].map(([uid, value]) => this.item(uid, value)); }

  _program(value, options = []) {
    if (value === undefined || value === null || value === '' || Number(value) === 0) return null;
    const feature = this.profile.features[String(value)] || {};
    const key = feature.name || (typeof value === 'string' && value.includes('.') ? value : String(value));
    return {
      key,
      uid: Number.isFinite(Number(value)) ? Number(value) : value,
      name: shortName(key),
      options: (Array.isArray(options) ? options : []).map(entry => {
        if (entry && Object.hasOwn(entry, 'uid') && Object.hasOwn(entry, 'value')) return this.item(entry.uid, entry.value);
        return structuredClone(entry);
      })
    };
  }

  _programFromResource(data) {
    const entry = Array.isArray(data) ? data[0] : data;
    if (!entry || typeof entry !== 'object') return null;
    return this._program(entry.program ?? entry.value ?? entry.uid ?? entry.key, entry.options);
  }

  programState(items = this.items()) {
    const options = items.filter(item => item.category === 'option');
    const attach = program => program ? { ...program, options: options.map(item => ({ ...item })) } : null;
    return { active: attach(this.activeProgram), selected: attach(this.selectedProgram), options };
  }

  resolutionSummary(items = this.items()) {
    const resolved = items.filter(item => item.resolved);
    const valueResolved = items.filter(item => item.valueResolved);
    return {
      featureCount: Object.keys(this.profile.features || {}).length,
      itemCount: items.length,
      resolvedItemCount: resolved.length,
      unresolvedItemCount: items.length - resolved.length,
      valueResolvedItemCount: valueResolved.length,
      unresolvedValueCount: items.length - valueResolved.length,
      statusCount: items.filter(item => ['status', 'event'].includes(item.category)).length,
      settingsCount: items.filter(item => item.category === 'setting').length,
      programCount: Object.values(this.profile.features || {}).filter(feature => itemCategory(feature, feature?.name) === 'program').length,
      unresolvedUids: items.filter(item => !item.resolved).map(item => item.uid).slice(0, 20),
      unresolvedValues: items.filter(item => !item.valueResolved).map(item => `${item.uid}:${safeRawDiagnostic(item.rawValue)}`).slice(0, 20)
    };
  }

  _event(event, data, connection = {}) {
    return {
      haId: this.profile.haId,
      event,
      data,
      timestamp: new Date().toISOString(),
      connection: { local: true, readOnly: true, ...connection },
      simulated: false
    };
  }

  _transportError(error) {
    this.trace.event('transport-error', { code: error.code, details: error.details });
    this._emitError(error);
  }

  _emitError(error) {
    if (this.listenerCount('error') > 0) this.emit('error', error);
    else this.emit('warning', error);
  }

  _rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  _transportClosed() {
    const wasConnected = this.connected;
    this.connected = false;
    this.sessionId = null;
    this.nextMessageId = null;
    this.trace.event('transport-closed', { wasConnected });
    const disconnected = new HomeConnectError('Local appliance disconnected.', {
      code: 'LOCAL_DISCONNECTED',
      details: {
        category: 'network',
        hintDe: 'Gerätestrom/Standby, WLAN, VLAN und Firewall prüfen; die Session wird mit Backoff neu aufgebaut.',
        hintEn: 'Check appliance power/standby, Wi-Fi, VLAN, and firewall; the session will be rebuilt with backoff.'
      }
    });
    if (!wasConnected && this.initialized && !this.initialized.settled) {
      this.initialized.settled = true;
      this.initialized.reject(new HomeConnectError('Local appliance disconnected during the handshake.', { code: 'LOCAL_DISCONNECTED', details: disconnected.details }));
    }
    this._rejectPending(disconnected);
    if (wasConnected) this.emit('event', this._event('DISCONNECTED', { items: [] }, { synthetic: true }));
    if (!this.closed && this.watchers > 0) this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this.closed || this.watchers <= 0 || this.connecting) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectAttempt++;
    const jitter = 0.8 + (Math.random() * 0.4);
    const delay = Math.round(this.reconnectDelay * jitter);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60000);
    this.trace.event('reconnect-scheduled', { attempt: this.reconnectAttempt, delayMs: delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ensureConnected().catch(error => {
        this._emitError(error);
        this._scheduleReconnect();
      });
    }, delay);
    this.reconnectTimer.unref?.();
  }

  watch() {
    this.watchers++;
    this.ensureConnected().catch(error => {
      this._emitError(error);
      this._scheduleReconnect();
    });
  }

  unwatch() {
    this.watchers = Math.max(0, this.watchers - 1);
    if (!this.watchers) clearTimeout(this.reconnectTimer);
  }

  close() {
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    this._rejectPending(new HomeConnectError('Local appliance session closed.', { code: 'LOCAL_SESSION_CLOSED' }));
    this.transport?.close();
  }
}

class LocalHomeConnectClient {
  constructor(options = {}) {
    this.environment = 'local';
    this.profiles = options.profiles || loadLocalProfiles({
      profileJson: options.profileJson,
      profilePath: options.profilePath,
      mappings: options.mappings,
      requireMapping: options.requireMapping === true
    });
    this.appName = options.appName || 'node-red-home-connect';
    this.appId = options.appId || crypto.createHash('sha256').update(String(options.identity || 'node-red')).digest('hex').slice(0, 16);
    this.sessionFactory = options.sessionFactory || ((profile, sessionOptions) => new LocalApplianceSession(profile, sessionOptions));
    this.sessions = new Map(this.profiles.map(profile => [profile.haId, this.sessionFactory(profile, {
      timeoutMs: options.requestTimeout,
      appName: this.appName,
      appId: this.appId,
      transportFactory: options.transportFactory,
      diagnostics: options.diagnostics,
      autoRefresh: options.autoRefresh,
      traceEnabled: options.traceEnabled,
      tracePath: options.tracePath
    })]));
    this.eventClosers = new Set();
  }

  get requiresOAuth() { return false; }
  get readOnly() { return true; }
  async getRateLimitStatus() { return { local: true, simulated: false, blocked: false, usedRequests: 0 }; }

  _session(haId) {
    const session = this.sessions.get(haId);
    if (!session) throw new HomeConnectError(`Unknown local appliance: ${haId}`, { code: 'LOCAL_APPLIANCE_NOT_FOUND', status: 404 });
    return session;
  }

  async listHomeAppliances() {
    return this.profiles.map(profile => ({ ...publicProfile(profile), connected: this.sessions.get(profile.haId).connected }));
  }

  async discoverAppliance(haId, force = false) {
    const profile = this.profiles.find(item => item.haId === haId);
    const session = this._session(haId);
    let refresh = [];
    let offlineReason;
    try {
      await session.ensureConnected();
      refresh = force ? await session.refresh() : [];
    } catch (error) {
      if (!isOfflineError(error)) throw error;
      offlineReason = safeOfflineReason(error);
    }
    const items = session.items();
    const settings = items.filter(item => item.category === 'setting');
    const status = items.filter(item => ['status', 'event'].includes(item.category));
    const programs = Object.entries(profile.features)
      .filter(([, feature]) => itemCategory(feature, feature?.name) === 'program')
      .map(([uid, feature]) => ({ key: feature.name, name: shortName(feature.name), uid: Number.isFinite(Number(uid)) ? Number(uid) : uid }));
    const resolution = session.resolutionSummary(items);
    const currentPrograms = session.programState(items);
    return {
      appliance: { ...publicProfile(profile), connected: session.connected },
      status: { items: status }, settings: { items: settings }, values: { items },
      programs: { available: programs, ...currentPrograms },
      commands: { items: [], unsupported: true, readOnly: true },
      services: session.versionInfo, local: true, readOnly: true, transport: profile.connectionType,
      refresh, profileResolution: resolution,
      connection: {
        local: true, readOnly: true, state: session.connected ? 'online' : 'offline',
        ...(offlineReason ? { offlineReason } : {}),
        ...(session.lastValueAt ? { lastValueAt: session.lastValueAt } : {})
      },
      stale: !session.connected && items.length > 0,
      discoveredAt: new Date().toISOString(), simulated: false
    };
  }

  async discoverAll(force = false) {
    const result = [];
    for (const profile of this.profiles) {
      try { result.push(await this.discoverAppliance(profile.haId, force)); }
      catch (error) { result.push({ appliance: { ...publicProfile(profile), connected: false }, error: error.toJSON ? error.toJSON() : { code: error.code, message: error.message }, local: true, readOnly: true }); }
    }
    return result;
  }

  async testConnection(haId) {
    try {
      const session = this._session(haId);
      await session.ensureConnected();
      const refresh = await session.refresh();
      return {
        appliance: { ...publicProfile(this.profiles.find(item => item.haId === haId)), connected: true },
        transport: session.profile.connectionType,
        services: session.versionInfo,
        values: session.items(),
        refresh,
        protocolTrace: session.protocolTrace,
        local: true,
        readOnly: true
      };
    } catch (error) {
      this._session(haId).diagnostics?.failFromError(error);
      throw error;
    }
  }

  getProtocolTrace(haId) { return this._session(haId).protocolTrace; }

  async read(haId, operation = 'snapshot', key) {
    if (!READ_OPERATIONS.includes(operation)) throw new HomeConnectError(`Unsupported read operation: ${operation}`, { code: 'READ_ACTION_NOT_ALLOWED' });
    if (operation === 'appliances') return this.listHomeAppliances();
    const capability = await this.discoverAppliance(haId, ['snapshot', 'capabilities', 'status', 'settings'].includes(operation));
    const byKey = items => items.find(item => item.key === key || String(item.uid) === String(key));
    const operations = {
      snapshot: () => ({ ...capability, snapshotAt: new Date().toISOString() }),
      capabilities: () => capability,
      appliance: () => capability.appliance,
      status: () => capability.status,
      'status-item': () => byKey(capability.status.items),
      settings: () => capability.settings,
      setting: () => byKey(capability.settings.items),
      'all-programs': () => capability.programs,
      programs: () => ({ programs: capability.programs.available }),
      program: () => capability.programs.available.find(item => item.key === key || String(item.uid) === String(key)),
      'active-program': () => capability.programs.active,
      'selected-program': () => capability.programs.selected,
      'active-options': () => ({ items: capability.programs.active?.options || [] }),
      'selected-options': () => ({ items: capability.programs.selected?.options || [] }),
      'active-option': () => (capability.programs.active?.options || []).find(item => item.key === key || String(item.uid) === String(key)),
      'selected-option': () => (capability.programs.selected?.options || []).find(item => item.key === key || String(item.uid) === String(key)),
      commands: () => capability.commands
    };
    if (!operations[operation]) throw new HomeConnectError(`Read operation ${operation} is not available for local profiles.`, { code: 'LOCAL_READ_UNSUPPORTED' });
    return operations[operation]();
  }

  async write() {
    throw new HomeConnectError('Local Home Connect access is deliberately read-only.', { code: 'LOCAL_READ_ONLY', status: 403 });
  }

  openEvents(haId, onEvent, onError = () => {}) {
    const selected = haId && haId !== '*' ? [this._session(haId)] : [...this.sessions.values()];
    const bindings = [];
    for (const session of selected) {
      const event = value => onEvent(value);
      const error = value => {
        if (value && !value.haId) value.haId = session.profile.haId;
        if (isOfflineError(value)) {
          onEvent({
            haId: session.profile.haId,
            event: 'DISCONNECTED',
            data: { items: [] },
            timestamp: new Date().toISOString(),
            connection: { local: true, readOnly: true, synthetic: true, reconnecting: true, offlineReason: safeOfflineReason(value) },
            simulated: false
          });
        }
        onError(value);
      };
      session.on('event', event);
      session.on('error', error);
      session.on('warning', error);
      session.watch();
      bindings.push({ session, event, error });
    }
    const close = () => {
      for (const binding of bindings) {
        binding.session.off('event', binding.event);
        binding.session.off('error', binding.error);
        binding.session.off('warning', binding.error);
        binding.session.unwatch();
      }
      this.eventClosers.delete(close);
    };
    this.eventClosers.add(close);
    return close;
  }

  close() {
    for (const close of [...this.eventClosers]) close();
    for (const session of this.sessions.values()) session.close();
  }
}

module.exports = {
  LocalHomeConnectClient,
  LocalApplianceSession,
  READ_RESOURCES,
  parseMessage,
  shortName,
  messageData,
  serviceVersions,
  protocolResponseError,
  acceptedResponseCode,
  valueEntries,
  aggregateProtocolRejection,
  itemCategory,
  profileBoolean,
  safeRawDiagnostic,
  isOfflineError,
  safeOfflineReason
};
