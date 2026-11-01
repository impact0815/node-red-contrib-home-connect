'use strict';

const HEALTH_SCHEMA = 'home-connect-health/v1';
const HEALTH_ORDER = Object.freeze({
  ok: 0,
  info: 1,
  running: 2,
  warning: 3,
  action_required: 4,
  offline: 5,
  error: 6
});

const STATUS_KEYS = Object.freeze({
  operation: 'BSH.Common.Status.OperationState',
  door: 'BSH.Common.Status.DoorState',
  remote: 'BSH.Common.Status.RemoteControlActive',
  remoteStart: 'BSH.Common.Status.RemoteControlStartAllowed',
  local: 'BSH.Common.Status.LocalControlActive'
});

const STATUS_KEY_SET = new Set(Object.values(STATUS_KEYS));

function shortValue(value) {
  if (value === undefined || value === null) return '';
  const text = String(value);
  return text.includes('.') ? text.slice(text.lastIndexOf('.') + 1) : text;
}

function safeCode(value) {
  return String(value || 'UNKNOWN').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase() || 'UNKNOWN';
}

function severityRank(value) {
  return ({ info: 0, warning: 1, error: 2, critical: 3 })[value] ?? 0;
}

function warning(source, code, severity, de, en, extra = {}) {
  return {
    source,
    code,
    severity,
    text: { de, en },
    transient: false,
    ...extra
  };
}

function cloneWarning(value) {
  return {
    ...value,
    text: value.text ? { ...value.text } : value.text
  };
}

function healthFromWarnings(warnings, base = 'ok') {
  let health = base;
  for (const item of warnings) {
    const candidate = item.health || (
      item.severity === 'critical' ? 'action_required'
        : item.severity === 'error' ? 'error'
          : item.severity === 'warning' ? 'warning'
            : 'info'
    );
    if ((HEALTH_ORDER[candidate] ?? 0) > (HEALTH_ORDER[health] ?? 0)) health = candidate;
  }
  return health;
}

function publicWarning(value) {
  const result = cloneWarning(value);
  delete result.health;
  return result;
}

function deduplicate(warnings) {
  const result = new Map();
  for (const item of warnings) {
    const id = `${item.source}:${item.code}:${item.key || ''}`;
    const current = result.get(id);
    if (!current || severityRank(item.severity) > severityRank(current.severity)) result.set(id, item);
  }
  return [...result.values()].sort((left, right) => {
    const rank = severityRank(right.severity) - severityRank(left.severity);
    if (rank) return rank;
    return String(left.code).localeCompare(String(right.code));
  });
}

function itemsFrom(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.items)) return value.items;
  return [];
}

class HealthMonitor {
  constructor(options = {}) {
    this.now = options.now || (() => Date.now());
    this.transientTtlMs = Math.max(1000, Number(options.transientTtlMs || 5 * 60 * 1000));
    this.states = new Map();
  }

  _state(haId = '*') {
    const id = haId || '*';
    if (!this.states.has(id)) {
      this.states.set(id, {
        haId: id,
        appliance: {},
        status: new Map(),
        statusMetadata: new Map(),
        transients: new Map(),
        connected: undefined,
        connectionCode: undefined,
        local: false,
        readOnly: false,
        lastOperation: undefined
      });
    }
    return this.states.get(id);
  }

  _addTransient(state, value, ttlMs = this.transientTtlMs, observedAt) {
    const now = this.now();
    const id = `${value.source}:${value.code}:${value.key || ''}`;
    const previous = state.transients.get(id);
    const firstSeenAt = previous?.firstSeenAt || observedAt || new Date(now).toISOString();
    state.transients.set(id, {
      ...value,
      transient: true,
      firstSeenAt,
      lastSeenAt: observedAt || new Date(now).toISOString(),
      expiresAt: new Date(now + ttlMs).toISOString(),
      expiresAtMs: now + ttlMs
    });
  }

  _removeTransient(state, code) {
    for (const [id, item] of state.transients) if (item.code === code) state.transients.delete(id);
  }

  _prune(state) {
    const now = this.now();
    for (const [id, item] of state.transients) if (item.expiresAtMs <= now) state.transients.delete(id);
  }

  _updateAppliance(state, appliance) {
    if (!appliance || typeof appliance !== 'object') return;
    state.appliance = { ...state.appliance, ...appliance };
    if (typeof appliance.connected === 'boolean') {
      state.connected = appliance.connected;
      state.connectionCode = appliance.connected ? undefined : 'HC_APPLIANCE_OFFLINE';
      if (appliance.connected) this._removeTransient(state, 'HC_STREAM_CONNECTED');
    }
  }

  _updateConnectionContext(state, payload) {
    if (!payload || typeof payload !== 'object') return;
    const connection = payload.connection && typeof payload.connection === 'object' ? payload.connection : {};
    if (typeof payload.local === 'boolean') state.local = payload.local;
    if (typeof connection.local === 'boolean') state.local = connection.local;
    if (typeof payload.readOnly === 'boolean') state.readOnly = payload.readOnly;
    if (typeof connection.readOnly === 'boolean') state.readOnly = connection.readOnly;
  }

  _replaceStatus(state, items) {
    const previousOperation = state.status.get(STATUS_KEYS.operation);
    state.status.clear();
    state.statusMetadata.clear();
    for (const item of items) {
      if (!item?.key) continue;
      state.status.set(item.key, item.value);
      state.statusMetadata.set(item.key, { ...item });
    }
    this._operationTransition(
      state,
      previousOperation,
      state.status.get(STATUS_KEYS.operation),
      undefined,
      this._isSemantic(state, STATUS_KEYS.operation)
    );
  }

  _mergeStatus(state, items) {
    const previousOperation = state.status.get(STATUS_KEYS.operation);
    for (const item of items) {
      if (!item?.key || !STATUS_KEY_SET.has(item.key)) continue;
      state.status.set(item.key, item.value);
      state.statusMetadata.set(item.key, { ...item });
    }
    this._operationTransition(
      state,
      previousOperation,
      state.status.get(STATUS_KEYS.operation),
      undefined,
      this._isSemantic(state, STATUS_KEYS.operation)
    );
  }

  _isSemantic(state, key) {
    const metadata = state.statusMetadata.get(key);
    return metadata?.valueResolved !== false;
  }

  _operationTransition(state, previous, current, observedAt, semantic = true) {
    state.lastOperation = current;
    if (!semantic) {
      this._removeTransient(state, 'HC_OPERATION_FINISHED');
      return;
    }
    if (shortValue(current) === 'Finished' && current !== previous) {
      this._addTransient(state, warning(
        'status',
        'HC_OPERATION_FINISHED',
        'info',
        'Das Programm ist beendet.',
        'The program has finished.',
        { health: 'info', key: STATUS_KEYS.operation, value: current }
      ), this.transientTtlMs, observedAt);
    }
    if (shortValue(current) !== 'Finished') this._removeTransient(state, 'HC_OPERATION_FINISHED');
  }

  _statusWarnings(state) {
    const result = [];
    const operationValue = state.status.get(STATUS_KEYS.operation);
    const operation = this._isSemantic(state, STATUS_KEYS.operation) ? shortValue(operationValue) : '';
    const doorValue = state.status.get(STATUS_KEYS.door);
    const door = this._isSemantic(state, STATUS_KEYS.door) ? shortValue(doorValue) : '';
    const remote = this._isSemantic(state, STATUS_KEYS.remote) ? state.status.get(STATUS_KEYS.remote) : undefined;
    const remoteStart = this._isSemantic(state, STATUS_KEYS.remoteStart) ? state.status.get(STATUS_KEYS.remoteStart) : undefined;
    const local = this._isSemantic(state, STATUS_KEYS.local) ? state.status.get(STATUS_KEYS.local) : undefined;

    if (operation === 'ActionRequired') {
      result.push(warning('status', 'HC_OPERATION_ACTION_REQUIRED', 'critical',
        'Das Gerät benötigt eine Aktion vor Ort.', 'The appliance requires an action on site.',
        { health: 'action_required', key: STATUS_KEYS.operation, value: operationValue }));
    } else if (operation === 'Pause') {
      result.push(warning('status', 'HC_OPERATION_PAUSED', 'warning',
        'Das Programm ist pausiert.', 'The program is paused.',
        { health: 'warning', key: STATUS_KEYS.operation, value: operationValue }));
    } else if (operation === 'DelayedStart') {
      result.push(warning('status', 'HC_OPERATION_DELAYED_START', 'info',
        'Ein verzögerter Start ist geplant.', 'A delayed start is scheduled.',
        { health: 'info', key: STATUS_KEYS.operation, value: operationValue }));
    } else if (operation === 'Error') {
      result.push(warning('status', 'HC_OPERATION_ERROR', 'error',
        'Das Gerät meldet einen Fehlerzustand.', 'The appliance reports an error state.',
        { health: 'error', key: STATUS_KEYS.operation, value: operationValue }));
    } else if (operation === 'Aborting') {
      result.push(warning('status', 'HC_OPERATION_ABORTING', 'warning',
        'Das Programm wird abgebrochen.', 'The program is being aborted.',
        { health: 'warning', key: STATUS_KEYS.operation, value: operationValue }));
    } else if (operation && !['Inactive', 'Ready', 'Run', 'Finished'].includes(operation)) {
      result.push(warning('status', 'HC_OPERATION_UNKNOWN', 'info',
        `Unbekannter Betriebszustand „${operation}“; Rohwert bleibt erhalten.`,
        `Unknown operation state “${operation}”; the raw value is preserved.`,
        { health: 'info', key: STATUS_KEYS.operation, value: operationValue }));
    }

    if (door === 'Open') {
      const requiresAction = ['Run', 'Pause', 'ActionRequired'].includes(operation);
      result.push(warning('status', 'HC_DOOR_OPEN', requiresAction ? 'warning' : 'info',
        requiresAction ? 'Die Gerätetür ist offen; bitte schließen.' : 'Die Gerätetür ist offen.',
        requiresAction ? 'The appliance door is open; please close it.' : 'The appliance door is open.',
        { health: requiresAction ? 'action_required' : 'info', key: STATUS_KEYS.door, value: doorValue }));
    }

    // Local control is the most useful single message; suppress derivative remote-control noise.
    if (local === true) {
      result.push(warning('status', 'HC_LOCAL_CONTROL_ACTIVE', 'warning',
        'Das Gerät wird gerade lokal bedient; Fernaktionen sind vorübergehend blockiert.',
        'The appliance is being operated locally; remote actions are temporarily blocked.',
        { health: 'warning', key: STATUS_KEYS.local, value: local }));
    } else if (remote === false) {
      result.push(warning('status', 'HC_REMOTE_CONTROL_INACTIVE', 'info',
        'Fernsteuerung ist am Gerät nicht aktiviert.',
        'Remote control is not enabled on the appliance.',
        { health: 'info', key: STATUS_KEYS.remote, value: remote }));
    } else if (remoteStart === false && operation !== 'Run' && !(
      state.local && state.readOnly && !['Pause', 'DelayedStart', 'ActionRequired'].includes(operation)
    )) {
      result.push(warning('status', 'HC_REMOTE_START_NOT_ALLOWED', 'info',
        'Fernstart ist am Gerät derzeit nicht erlaubt.',
        'Remote start is currently not allowed on the appliance.',
        { health: 'info', key: STATUS_KEYS.remoteStart, value: remoteStart }));
    }

    return result;
  }

  _connectionWarnings(state) {
    if (state.connected !== false) return [];
    const stream = state.connectionCode === 'HC_STREAM_DISCONNECTED';
    return [warning('connection', stream ? 'HC_STREAM_DISCONNECTED' : 'HC_APPLIANCE_OFFLINE', 'error',
      stream ? 'Die Event-Verbindung wurde getrennt; Wiederverbindung läuft.' : 'Das Gerät ist offline oder nicht mit Home Connect verbunden.',
      stream ? 'The event connection was disconnected; reconnection is in progress.' : 'The appliance is offline or not connected to Home Connect.',
      { health: 'offline', value: false })];
  }

  _baseHealth(state) {
    if (state.connected === false) return 'offline';
    const operation = this._isSemantic(state, STATUS_KEYS.operation)
      ? shortValue(state.status.get(STATUS_KEYS.operation))
      : '';
    if (operation === 'Run') return 'running';
    if (operation === 'Finished' || operation === 'DelayedStart') return 'info';
    return 'ok';
  }

  _assessment(state) {
    this._prune(state);
    const internalWarnings = deduplicate([
      ...this._connectionWarnings(state),
      ...this._statusWarnings(state),
      ...state.transients.values()
    ]);
    const health = healthFromWarnings(internalWarnings, this._baseHealth(state));
    return {
      schema: HEALTH_SCHEMA,
      health,
      warnings: internalWarnings.map(item => {
        const result = publicWarning(item);
        delete result.expiresAtMs;
        return result;
      }),
      connected: state.connected,
      operationState: state.status.get(STATUS_KEYS.operation),
      updatedAt: new Date(this.now()).toISOString()
    };
  }

  _combine(assessments) {
    if (!assessments.length) return {
      schema: HEALTH_SCHEMA,
      health: 'ok',
      warnings: [],
      updatedAt: new Date(this.now()).toISOString()
    };
    let health = 'ok';
    for (const item of assessments) if ((HEALTH_ORDER[item.health] ?? 0) > (HEALTH_ORDER[health] ?? 0)) health = item.health;
    return {
      schema: HEALTH_SCHEMA,
      health,
      warnings: deduplicate(assessments.flatMap(item => item.warnings)).map(publicWarning),
      updatedAt: new Date(this.now()).toISOString(),
      appliances: assessments.length
    };
  }

  _decorate(payload, assessment) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
    payload.health = assessment.health;
    payload.warnings = assessment.warnings.map(cloneWarning);
    payload.healthSchema = assessment.schema;
    payload.healthAt = assessment.updatedAt;
  }

  assessPayload(payload, context = {}) {
    if (Array.isArray(payload)) {
      const assessments = payload.map(entry => this.assessPayload(entry, context));
      return this._combine(assessments);
    }

    const candidateAppliance = payload?.appliance || (
      payload && typeof payload === 'object' && payload.haId && (payload.type || Object.hasOwn(payload, 'connected')) ? payload : null
    );
    const haId = candidateAppliance?.haId || payload?.haId || context.haId || '*';
    const state = this._state(haId);

    if (payload?.error) {
      const assessment = this.assessError(payload.error);
      this._decorate(payload, assessment);
      return assessment;
    }

    this._updateAppliance(state, candidateAppliance);
    this._updateConnectionContext(state, payload);
    if (Array.isArray(payload?.status?.items)) this._replaceStatus(state, payload.status.items);
    else if (context.operation === 'status' && Array.isArray(payload?.items)) this._replaceStatus(state, payload.items);
    else if (payload?.key && STATUS_KEY_SET.has(payload.key)) this._mergeStatus(state, [payload]);

    const assessment = this._assessment(state);
    this._decorate(payload, assessment);
    return assessment;
  }

  assessEvent(event = {}) {
    const haId = event.haId || '*';
    const state = this._state(haId);
    const eventName = String(event.event || '').toUpperCase();
    const observedAt = event.timestamp || new Date(this.now()).toISOString();
    this._updateConnectionContext(state, event);

    if (eventName === 'CONNECTED') {
      state.connected = true;
      state.connectionCode = undefined;
      this._removeTransient(state, 'HC_STREAM_DISCONNECTED');
      this._addTransient(state, warning('connection', 'HC_STREAM_CONNECTED', 'info',
        'Die Event-Verbindung ist hergestellt.', 'The event connection is established.',
        { health: 'info', value: true }), 30 * 1000, observedAt);
    } else if (eventName === 'DISCONNECTED') {
      state.connected = false;
      state.connectionCode = 'HC_STREAM_DISCONNECTED';
      this._removeTransient(state, 'HC_STREAM_CONNECTED');
    }

    const items = itemsFrom(event.data);
    this._mergeStatus(state, items);
    for (const item of items) {
      if (item?.valueResolved === false) continue;
      const level = shortValue(item?.level).toLowerCase();
      const handling = shortValue(item?.handling).toLowerCase();
      const handlingRequired = handling && !['none', 'optional'].includes(handling);
      let severity;
      if (['critical', 'alert', 'fatal'].includes(level)) severity = 'critical';
      else if (level === 'error') severity = 'error';
      else if (['warning', 'warn'].includes(level)) severity = 'warning';
      else if (eventName === 'EVENT' && ['hint', 'info', 'information'].includes(level)) severity = 'info';

      if (handlingRequired || severity) {
        const eventWarning = warning('event', `HC_EVENT_${safeCode(item.key)}`, handlingRequired ? 'warning' : severity,
          handlingRequired
            ? `Das Gerät meldet „${shortValue(item.key)}“ und erwartet eine Reaktion.`
            : `Gerätehinweis: ${shortValue(item.key)}.`,
          handlingRequired
            ? `The appliance reports “${shortValue(item.key)}” and expects a response.`
            : `Appliance notice: ${shortValue(item.key)}.`,
          {
            health: handlingRequired ? 'action_required' : undefined,
            key: item.key,
            value: item.value,
            ...(item.level !== undefined ? { level: item.level } : {}),
            ...(item.handling !== undefined ? { handling: item.handling } : {})
          });
        this._addTransient(state, eventWarning, handlingRequired ? 15 * 60 * 1000 : this.transientTtlMs, observedAt);
      } else if (eventName === 'EVENT' && item?.key) {
        this._addTransient(state, warning('event', `HC_EVENT_${safeCode(item.key)}`, 'info',
          `Geräteereignis: ${shortValue(item.key)}.`, `Appliance event: ${shortValue(item.key)}.`,
          { health: 'info', key: item.key, value: item.value }), this.transientTtlMs, observedAt);
      }
    }

    const assessment = this._assessment(state);
    this._decorate(event, assessment);
    return assessment;
  }

  assessError(error = {}) {
    const value = typeof error?.toJSON === 'function' ? error.toJSON() : error;
    const originalCode = String(value?.code || error?.code || 'UNEXPECTED_ERROR');
    const code = originalCode.toLowerCase();
    const status = Number(value?.status || error?.status || 0) || undefined;
    const retryAfter = value?.retryAfter ?? error?.retryAfter;
    let item;

    if (code.includes('insufficient_scope') || code === 'insufficient_scope') {
      item = warning('oauth', 'HC_OAUTH_INSUFFICIENT_SCOPE', 'critical',
        'Der Zugriffsumfang reicht nicht aus. Scopes korrigieren und neu autorisieren.',
        'The authorization scope is insufficient. Correct the scopes and authorize again.',
        { health: 'action_required' });
    } else if (['invalid_grant', 'not_authorized', 'authorization_expired', 'token_response_invalid', 'refresh_token_missing'].some(part => code.includes(part)) || status === 401) {
      item = warning('oauth', 'HC_OAUTH_AUTHORIZATION_EXPIRED', 'critical',
        'Die Autorisierung fehlt, ist abgelaufen oder wurde widerrufen. Bitte neu autorisieren.',
        'Authorization is missing, expired, or revoked. Authorize again.',
        { health: 'action_required' });
    } else if (status === 429 || code.includes('rate_limit') || code.includes('too_many_requests')) {
      item = warning('api', 'HC_API_RATE_LIMITED', 'warning',
        'Das API-Limit wurde erreicht. Weniger häufig abfragen und die Wiederholungszeit beachten.',
        'The API rate limit was reached. Poll less often and observe the retry time.',
        { health: 'warning', ...(retryAfter !== undefined ? { retryAfter } : {}) });
    } else if (['network_error', 'request_timeout', 'request_aborted', 'local_connect', 'local_socket', 'local_disconnected', 'local_heartbeat', 'local_not_connected'].some(part => code.includes(part))) {
      item = warning('connection', 'HC_NETWORK_ERROR', 'error',
        'Home Connect ist über das Netzwerk derzeit nicht erreichbar.',
        'Home Connect is currently unreachable over the network.',
        { health: 'offline' });
    } else if (code.includes('local_read_only')) {
      item = warning('security', 'HC_LOCAL_READ_ONLY', 'warning',
        'Die lokale Home-Connect-Verbindung ist fest schreibgeschützt.',
        'The local Home Connect connection is deliberately read-only.',
        { health: 'warning' });
    } else if (code.startsWith('oauth_') || ['access_denied', 'unauthorized_client'].some(part => code.includes(part))) {
      item = warning('oauth', `HC_OAUTH_${safeCode(originalCode)}`, 'critical',
        'Die OAuth-Autorisierung ist fehlgeschlagen und muss korrigiert werden.',
        'OAuth authorization failed and requires correction.',
        { health: 'action_required' });
    } else {
      item = warning('api', `HC_API_${safeCode(originalCode)}`, 'error',
        'Die Home-Connect-Anfrage ist fehlgeschlagen.',
        'The Home Connect request failed.',
        { health: 'error' });
    }

    const result = publicWarning({
      ...item,
      originalCode,
      ...(status !== undefined ? { status } : {}),
      ...(retryAfter !== undefined ? { retryAfter } : {}),
      transient: true
    });
    return {
      schema: HEALTH_SCHEMA,
      health: item.health,
      warnings: [result],
      updatedAt: new Date(this.now()).toISOString()
    };
  }

  current(haId = '*') {
    return this._assessment(this._state(haId));
  }

  clear(haId) {
    if (haId) this.states.delete(haId);
    else this.states.clear();
  }
}

module.exports = {
  HEALTH_SCHEMA,
  HEALTH_ORDER,
  STATUS_KEYS,
  HealthMonitor,
  shortValue,
  healthFromWarnings
};
