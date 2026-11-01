'use strict';

const LOCAL_TEST_STAGES = Object.freeze([
  Object.freeze({ id: 'ip-reachable', label: 'IP reachable', labelDe: 'IP erreichbar' }),
  Object.freeze({ id: 'profile-loaded', label: 'Profile loaded', labelDe: 'Profil geladen' }),
  Object.freeze({ id: 'transport-recognized', label: 'Transport detected', labelDe: 'Transport erkannt' }),
  Object.freeze({ id: 'websocket-connected', label: 'WebSocket connected', labelDe: 'WebSocket verbunden' }),
  Object.freeze({ id: 'session-initialized', label: 'Session initialized', labelDe: 'Session initialisiert' }),
  Object.freeze({ id: 'services-recognized', label: 'Services detected', labelDe: 'Services erkannt' }),
  Object.freeze({ id: 'readonly-data-received', label: 'Read-only data received', labelDe: 'Read-only-Daten empfangen' })
]);

const ERROR_STAGE = Object.freeze({
  LOCAL_PROFILE_PATH_REQUIRED: 'profile-loaded',
  LOCAL_PROFILE_REQUIRED: 'profile-loaded',
  LOCAL_PROFILE_KEY_MISSING: 'profile-loaded',
  LOCAL_PROFILE_KEY_INVALID: 'profile-loaded',
  LOCAL_PROFILE_KEY_LENGTH_INVALID: 'profile-loaded',
  LOCAL_PROFILE_IV_MISSING: 'profile-loaded',
  LOCAL_PROFILE_IV_INVALID: 'profile-loaded',
  LOCAL_MAPPING_PROFILE_NOT_FOUND: 'profile-loaded',
  LOCAL_MAPPING_HOST_REQUIRED: 'ip-reachable',
  LOCAL_HOST_INVALID: 'ip-reachable',
  LOCAL_HOST_NOT_PRIVATE: 'ip-reachable',
  LOCAL_NETWORK_ERROR: 'ip-reachable',
  LOCAL_CONNECT_TIMEOUT: 'ip-reachable',
  LOCAL_CONNECT_FAILED: 'ip-reachable',
  LOCAL_TLS_PSK_UNAVAILABLE: 'transport-recognized',
  LOCAL_PROFILE_KEY_REJECTED: 'transport-recognized',
  LOCAL_TRANSPORT_UNSUPPORTED: 'transport-recognized',
  LOCAL_WEBSOCKET_TIMEOUT: 'websocket-connected',
  LOCAL_WEBSOCKET_UPGRADE_FAILED: 'websocket-connected',
  LOCAL_DISCONNECTED: 'session-initialized',
  LOCAL_HANDSHAKE_TIMEOUT: 'session-initialized',
  LOCAL_HANDSHAKE_INVALID: 'session-initialized',
  LOCAL_PROFILE_AUTHENTICATION_FAILED: 'session-initialized',
  LOCAL_SERVICES_INVALID: 'services-recognized',
  LOCAL_PROTOCOL_RESPONSE_MISMATCH: 'readonly-data-received',
  LOCAL_PROTOCOL_REJECTED: 'services-recognized',
  LOCAL_REQUEST_TIMEOUT: 'readonly-data-received',
  LOCAL_HEARTBEAT_TIMEOUT: 'readonly-data-received',
  LOCAL_VALUES_UNAVAILABLE: 'readonly-data-received'
});

function safeDetails(details) {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return undefined;
  const allowed = [
    'transport', 'port', 'path', 'protocol', 'cipher', 'httpStatus', 'httpStatusText',
    'services', 'serviceCount', 'valueCount', 'profileTransport', 'declaredTransport',
    'category', 'causeCode', 'resource', 'expectedResource', 'action', 'version', 'deviceCode',
    'hintDe', 'hintEn', 'readResponses', 'readSource', 'rejectedResources',
    'featureCount', 'resolvedItemCount', 'unresolvedItemCount', 'valueResolvedItemCount', 'unresolvedValueCount',
    'statusCount', 'settingsCount', 'programCount', 'unresolvedValues'
  ];
  const result = {};
  for (const key of allowed) {
    const value = details[key];
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) result[key] = value.map(item => String(item)).slice(0, 20);
    else if (['string', 'number', 'boolean'].includes(typeof value)) result[key] = value;
  }
  return Object.keys(result).length ? result : undefined;
}

class LocalConnectionDiagnostics {
  constructor() {
    this.states = new Map(LOCAL_TEST_STAGES.map(stage => [stage.id, {
      ...stage,
      status: 'pending'
    }]));
  }

  pass(id, details) {
    const stage = this.states.get(id);
    if (!stage || stage.status === 'failed') return;
    stage.status = 'ok';
    const safe = safeDetails(details);
    if (safe) stage.details = safe;
  }

  fail(id, error) {
    const stage = this.states.get(id);
    if (!stage) return;
    stage.status = 'failed';
    stage.code = error?.code || 'UNEXPECTED_ERROR';
    stage.message = error?.message || String(error);
    const safe = safeDetails(error?.details);
    if (safe) stage.details = safe;
    let afterFailure = false;
    for (const definition of LOCAL_TEST_STAGES) {
      if (definition.id === id) {
        afterFailure = true;
        continue;
      }
      const current = this.states.get(definition.id);
      if (afterFailure && current.status === 'pending') current.status = 'skipped';
    }
  }

  failFromError(error) {
    const explicit = String(error?.details?.stage || '');
    const resource = String(error?.details?.resource || '');
    const protocolReadFailure = error?.code === 'LOCAL_PROTOCOL_REJECTED' && resource.startsWith('/ro/');
    const id = this.states.has(explicit)
      ? explicit
      : (protocolReadFailure ? 'readonly-data-received' : (ERROR_STAGE[error?.code] || 'session-initialized'));
    this.fail(id, error);
  }

  snapshot() {
    return LOCAL_TEST_STAGES.map(stage => ({ ...this.states.get(stage.id) }));
  }
}

module.exports = { LOCAL_TEST_STAGES, LocalConnectionDiagnostics, ERROR_STAGE };
