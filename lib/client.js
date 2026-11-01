'use strict';

const { apiError, HomeConnectError } = require('./errors');
const { parseSSE } = require('./sse');
const { validateWrite } = require('./validation');
const { API_MEDIA_TYPE, DEFAULT_SCOPE, ENVIRONMENTS, READ_OPERATIONS } = require('./constants');
const { SlidingWindowRateLimiter } = require('./rate-limiter');

const sleep = ms => new Promise(resolve => {
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
});

function errorJSON(error) {
  return error?.toJSON ? error.toJSON() : { name: error?.name || 'Error', message: error?.message || String(error) };
}

async function settle(resource, promise, fallback) {
  try {
    return { ok: true, resource, value: await promise };
  } catch (error) {
    return { ok: false, resource, value: fallback, error: { resource, ...errorJSON(error) } };
  }
}

function retryDelay(value, fallback, now = Date.now()) {
  if (value == null || value === '') return fallback;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.min(seconds * 1000, 60000));
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, Math.min(date - now, 60000));
  return fallback;
}

function timedSignal(externalSignal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) abort();
  else externalSignal?.addEventListener?.('abort', abort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      externalSignal?.removeEventListener?.('abort', abort);
    }
  };
}

class HomeConnectClient {
  constructor(options = {}) {
    this.environment = options.environment || 'production';
    this.baseUrl = options.baseUrl || ENVIRONMENTS[this.environment];
    if (!this.baseUrl) throw new HomeConnectError(`Unsupported environment: ${this.environment}`, { code: 'INVALID_ENVIRONMENT' });
    if (typeof (options.fetch || globalThis.fetch) !== 'function') {
      throw new HomeConnectError('A Fetch API implementation is required.', { code: 'FETCH_UNAVAILABLE' });
    }
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.redirectUri = options.redirectUri;
    this.scope = options.scope || DEFAULT_SCOPE;
    this.language = options.language || 'en-GB';
    this.fetch = options.fetch || globalThis.fetch;
    this.onToken = options.onToken || (() => {});
    this.accessToken = options.accessToken;
    this.refreshToken = options.refreshToken;
    this.expiresAt = options.expiresAt || 0;
    this.refreshPromise = null;
    this.capabilityCache = new Map();
    this.requestTimeout = Math.max(1000, Number(options.requestTimeout || 15000));
    this.rateLimiter = options.rateLimiter || new SlidingWindowRateLimiter({
      maxRequests: options.maxRequestsPerDay,
      minimumIntervalMs: options.minimumRequestInterval,
      store: options.rateLimitStore
    });
    this.supportsCommands = options.supportsCommands ?? this.environment !== 'official-simulator';
    this.eventClosers = new Set();
  }

  get requiresOAuth() { return true; }

  setTokens(tokens) {
    if (!tokens?.access_token) {
      throw new HomeConnectError('The token response did not contain an access token.', { code: 'TOKEN_RESPONSE_INVALID' });
    }
    this.accessToken = tokens.access_token;
    this.refreshToken = tokens.refresh_token || this.refreshToken;
    this.expiresAt = Date.now() + Math.max(30, Number(tokens.expires_in || 3600) - 30) * 1000;
    this.onToken({ accessToken: this.accessToken, refreshToken: this.refreshToken, expiresAt: this.expiresAt });
  }

  async _fetchWithTimeout(url, options = {}) {
    const timeout = timedSignal(options.signal, options.timeout || this.requestTimeout);
    try {
      return await this.fetch(url, { ...options, signal: timeout.signal });
    } catch (cause) {
      if (timeout.timedOut()) {
        throw new HomeConnectError('Home Connect request timed out.', { code: 'REQUEST_TIMEOUT', status: 408, cause });
      }
      if (options.signal?.aborted || cause?.name === 'AbortError') {
        throw new HomeConnectError('Home Connect request was aborted.', { code: 'REQUEST_ABORTED', cause });
      }
      throw new HomeConnectError('Network error while calling Home Connect.', { code: 'NETWORK_ERROR', cause });
    } finally {
      timeout.cleanup();
    }
  }

  async _tokenRequest(parameters, options = {}) {
    if (!this.clientId) throw new HomeConnectError('Client ID is required.', { code: 'CLIENT_ID_REQUIRED' });
    if (!this.clientSecret) throw new HomeConnectError('Client secret is required for the configured confidential-client flow.', { code: 'CLIENT_SECRET_REQUIRED' });
    const clean = Object.fromEntries(Object.entries({
      ...parameters,
      client_id: this.clientId,
      client_secret: this.clientSecret
    }).filter(([, value]) => value !== undefined && value !== ''));
    const response = await this._fetchWithTimeout(new URL('/security/oauth/token', this.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(clean)
    });
    const text = await response.text();
    const payload = text ? (() => { try { return JSON.parse(text); } catch { return { raw: text }; } })() : {};
    if (!response.ok) throw apiError(response, payload);
    if (options.requireRefreshToken && !payload.refresh_token) {
      throw new HomeConnectError('The authorization-code token response did not contain a refresh token.', {
        code: 'REFRESH_TOKEN_MISSING',
        status: 502
      });
    }
    this.setTokens(payload);
    return payload;
  }

  async exchangeCode(code) {
    if (!code) throw new HomeConnectError('Authorization code is required.', { code: 'AUTHORIZATION_CODE_REQUIRED' });
    if (!this.redirectUri) throw new HomeConnectError('Redirect URI is required.', { code: 'REDIRECT_URI_REQUIRED' });
    return this._tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri
    }, { requireRefreshToken: true });
  }

  async refreshAccessToken() {
    if (!this.refreshToken) throw new HomeConnectError('No refresh token is stored. Complete OAuth authorization first.', { code: 'NOT_AUTHORIZED' });
    if (!this.refreshPromise) {
      this.refreshPromise = this._tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: this.refreshToken
      }).finally(() => { this.refreshPromise = null; });
    }
    return this.refreshPromise;
  }

  async ensureAccessToken() {
    if (this.accessToken && Date.now() < this.expiresAt) return this.accessToken;
    await this.refreshAccessToken();
    return this.accessToken;
  }

  async _rateLimit() {
    return this.rateLimiter.acquire();
  }

  async getRateLimitStatus() {
    return this.rateLimiter.status();
  }

  async request(method, path, options = {}) {
    const verb = String(method).toUpperCase();
    const isRead = verb === 'GET';
    const maxAttempts = isRead ? 4 : 1;
    let unauthorizedRetry = false;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await this._rateLimit();
      const token = await this.ensureAccessToken();
      const headers = {
        ...options.headers,
        authorization: 'Bearer ' + token,
        accept: options.accept || API_MEDIA_TYPE,
        'accept-language': this.language
      };
      let body;
      if (options.body !== undefined) {
        headers['content-type'] = API_MEDIA_TYPE;
        body = JSON.stringify(options.body);
      }
      let response;
      try {
        response = await this._fetchWithTimeout(new URL(path, this.baseUrl), {
          method: verb, headers, body, signal: options.signal
        });
      } catch (error) {
        if (isRead && ['NETWORK_ERROR', 'REQUEST_TIMEOUT'].includes(error.code) && attempt + 1 < maxAttempts) {
          await sleep(250 * 2 ** attempt);
          continue;
        }
        throw error;
      }
      if (response.ok && options.binary) {
        return {
          contentType: response.headers.get('content-type') || options.accept || 'application/octet-stream',
          data: Buffer.from(await response.arrayBuffer())
        };
      }
      const text = response.status === 204 ? '' : await response.text();
      const payload = text ? (() => { try { return JSON.parse(text); } catch { return { raw: text }; } })() : {};
      if (response.ok) return payload.data === undefined ? payload : payload.data;
      if (response.status === 401 && !unauthorizedRetry) {
        unauthorizedRetry = true;
        this.accessToken = null;
        await this.refreshAccessToken();
        attempt--;
        continue;
      }
      const error = apiError(response, payload);
      if (response.status === 429) {
        await this.rateLimiter.recordServerLimit(error.retryAfter || error.message);
        throw error;
      }
      if (isRead && response.status >= 500 && attempt + 1 < maxAttempts) {
        await sleep(retryDelay(response.headers.get('retry-after'), 300 * 2 ** attempt));
        continue;
      }
      throw error;
    }
    throw new HomeConnectError('Request failed after all retries.', { code: 'RETRY_EXHAUSTED' });
  }

  _path(haId, suffix = '') {
    if (!haId) throw new HomeConnectError('haId is required.', { code: 'HAID_REQUIRED' });
    return `/api/homeappliances/${encodeURIComponent(haId)}${suffix}`;
  }

  _key(key, label = 'key') {
    if (typeof key !== 'string' || !key) throw new HomeConnectError(`${label} is required.`, { code: 'KEY_REQUIRED' });
    return encodeURIComponent(key);
  }

  _identifier(value, label) {
    if (value === undefined || value === null || value === '') {
      throw new HomeConnectError(`${label} is required.`, { code: 'KEY_REQUIRED' });
    }
    return encodeURIComponent(String(value));
  }

  async listHomeAppliances() {
    const data = await this.request('GET', '/api/homeappliances');
    return data.homeappliances || [];
  }

  async getHomeAppliance(haId) {
    const data = await this.request('GET', this._path(haId));
    return data.homeappliance || data;
  }

  async getStatus(haId) {
    const data = await this.request('GET', this._path(haId, '/status'));
    return { items: data.status || data.items || [] };
  }

  async getStatusValue(haId, key) {
    return this.request('GET', this._path(haId, `/status/${this._key(key, 'status key')}`));
  }

  async getSettings(haId) {
    const data = await this.request('GET', this._path(haId, '/settings'));
    return { items: data.settings || data.items || [] };
  }

  async getSetting(haId, key) {
    return this.request('GET', this._path(haId, `/settings/${this._key(key, 'setting key')}`));
  }

  async getAllPrograms(haId) {
    return this.request('GET', this._path(haId, '/programs'));
  }

  async getAvailablePrograms(haId) {
    const data = await this.request('GET', this._path(haId, '/programs/available'));
    return { programs: data.programs || [] };
  }

  async getAvailableProgram(haId, key) {
    return this.request('GET', this._path(haId, `/programs/available/${this._key(key, 'program key')}`));
  }

  async getActiveProgram(haId) { return this.request('GET', this._path(haId, '/programs/active')); }
  async getSelectedProgram(haId) { return this.request('GET', this._path(haId, '/programs/selected')); }

  async getProgramOptions(haId, kind) {
    return this.request('GET', this._path(haId, `/programs/${kind}/options`));
  }

  async getProgramOption(haId, kind, key) {
    return this.request('GET', this._path(haId, `/programs/${kind}/options/${this._key(key, 'option key')}`));
  }

  async getCommands(haId) {
    if (!this.supportsCommands) return { items: [], unsupported: true };
    const data = await this.request('GET', this._path(haId, '/commands'));
    return { items: data.commands || data.items || [] };
  }

  async getImages(haId) {
    const data = await this.request('GET', this._path(haId, '/images'));
    return { images: data.images || [] };
  }

  async getImage(haId, imageKey) {
    return this.request('GET', this._path(haId, `/images/${this._key(imageKey, 'image key')}`), {
      accept: 'image/jpeg', binary: true
    });
  }

  async getMaps(haId) {
    return this.request('GET', this._path(haId, '/map/maps'), { accept: 'application/json' });
  }

  async getMap(haId, mapId) {
    return this.request('GET', this._path(haId, `/map/maps/${this._identifier(mapId, 'map ID')}`), { accept: 'application/json' });
  }

  async getMapResource(haId, mapId, resource, itemId) {
    const map = this._identifier(mapId, 'map ID');
    const suffix = itemId === undefined
      ? `/map/maps/${map}/${resource}`
      : `/map/maps/${map}/${resource}/${this._identifier(itemId, 'resource ID')}`;
    return this.request('GET', this._path(haId, suffix), { accept: 'application/json' });
  }

  async getMapGlobalResource(haId, resource, itemId) {
    const suffix = itemId === undefined
      ? `/map/${resource}`
      : `/map/${resource}/${this._identifier(itemId, 'resource ID')}`;
    return this.request('GET', this._path(haId, suffix), { accept: 'application/json' });
  }

  async discoverAppliance(haId, force = false) {
    const cached = this.capabilityCache.get(haId);
    if (!force && cached && Date.now() - cached.cachedAt < 300000) return structuredClone(cached.value);
    const appliance = await this.getHomeAppliance(haId);
    const resources = await Promise.all([
      settle('status', this.getStatus(haId), { items: [] }),
      settle('settings', this.getSettings(haId), { items: [] }),
      settle('available-programs', this.getAvailablePrograms(haId), { programs: [] }),
      settle('active-program', this.getActiveProgram(haId), null),
      settle('selected-program', this.getSelectedProgram(haId), null),
      settle('commands', this.getCommands(haId), { items: [], unsupported: !this.supportsCommands })
    ]);
    const [status, settings, availableList, active, selected, commands] = resources;
    const available = [];
    const detailErrors = [];
    for (let index = 0; index < availableList.value.programs.length; index += 3) {
      const batch = availableList.value.programs.slice(index, index + 3);
      const details = await Promise.all(batch.map(program => settle(
        `program:${program.key}`,
        this.getAvailableProgram(haId, program.key),
        program
      )));
      available.push(...details.map(detail => detail.value));
      detailErrors.push(...details.filter(detail => !detail.ok).map(detail => detail.error));
    }
    const value = {
      appliance,
      status: status.value,
      settings: settings.value,
      programs: { available, active: active.value, selected: selected.value },
      commands: commands.value,
      discoveryErrors: [...resources.filter(entry => !entry.ok).map(entry => entry.error), ...detailErrors],
      discoveredAt: new Date().toISOString(),
      simulated: false
    };
    this.capabilityCache.set(haId, { cachedAt: Date.now(), value });
    return structuredClone(value);
  }

  async discoverAll(force = false) {
    const appliances = await this.listHomeAppliances();
    const result = [];
    for (const appliance of appliances) {
      try {
        result.push(await this.discoverAppliance(appliance.haId, force));
      } catch (error) {
        result.push({ appliance, error: errorJSON(error) });
      }
    }
    return result;
  }

  async getSnapshot(haId) {
    const capability = await this.discoverAppliance(haId, false);
    const resources = await Promise.all([
      settle('status', this.getStatus(haId), capability.status),
      settle('settings', this.getSettings(haId), capability.settings),
      settle('active-program', this.getActiveProgram(haId), capability.programs.active),
      settle('selected-program', this.getSelectedProgram(haId), capability.programs.selected)
    ]);
    capability.status = resources[0].value;
    capability.settings = resources[1].value;
    capability.programs.active = resources[2].value;
    capability.programs.selected = resources[3].value;
    capability.snapshotAt = new Date().toISOString();
    capability.snapshotErrors = resources.filter(entry => !entry.ok).map(entry => entry.error);
    return capability;
  }

  async read(haId, operation = 'snapshot', key, subKey) {
    if (!READ_OPERATIONS.includes(operation)) {
      throw new HomeConnectError(`Unsupported read operation: ${operation}`, { code: 'READ_ACTION_NOT_ALLOWED' });
    }
    if (operation === 'appliances') return this.listHomeAppliances();
    if (!haId) throw new HomeConnectError('haId is required.', { code: 'HAID_REQUIRED' });
    const operations = {
      snapshot: () => this.getSnapshot(haId),
      capabilities: () => this.discoverAppliance(haId, true),
      appliance: () => this.getHomeAppliance(haId),
      status: () => this.getStatus(haId),
      'status-item': () => this.getStatusValue(haId, key),
      settings: () => this.getSettings(haId),
      setting: () => this.getSetting(haId, key),
      'all-programs': () => this.getAllPrograms(haId),
      programs: () => this.getAvailablePrograms(haId),
      program: () => this.getAvailableProgram(haId, key),
      'active-program': () => this.getActiveProgram(haId),
      'active-options': () => this.getProgramOptions(haId, 'active'),
      'active-option': () => this.getProgramOption(haId, 'active', key),
      'selected-program': () => this.getSelectedProgram(haId),
      'selected-options': () => this.getProgramOptions(haId, 'selected'),
      'selected-option': () => this.getProgramOption(haId, 'selected', key),
      commands: () => this.getCommands(haId),
      images: () => this.getImages(haId),
      image: () => this.getImage(haId, key),
      maps: () => this.getMaps(haId),
      map: () => this.getMap(haId, key),
      'map-occupancy-grid': () => this.getMapResource(haId, key, 'occupancyGrid'),
      'map-layout': () => this.getMapResource(haId, key, 'layout'),
      'map-cleaning-status': () => this.getMapResource(haId, key, 'cleaningStatus'),
      'map-detected-objects': () => this.getMapResource(haId, key, 'cleaningStatus/objects'),
      'map-detected-object': () => this.getMapResource(haId, key, 'cleaningStatus/objects', subKey),
      'map-rooms': () => this.getMapResource(haId, key, 'rooms'),
      'map-room': () => this.getMapResource(haId, key, 'rooms', subKey),
      'map-zones': () => this.getMapResource(haId, key, 'zones'),
      'map-zone': () => this.getMapResource(haId, key, 'zones', subKey),
      'map-robot-position': () => this.getMapGlobalResource(haId, 'robot/position'),
      'map-config-restrictions': () => this.getMapGlobalResource(haId, 'config/restrictions'),
      'map-cleaning-summaries': () => this.getMapGlobalResource(haId, 'cleaningSummary'),
      'map-cleaning-summary': () => this.getMapGlobalResource(haId, 'cleaningSummary', key)
    };
    return operations[operation]();
  }

  async write(request, capability) {
    const cap = capability || await this.discoverAppliance(request.haId, true);
    validateWrite(cap, request);
    const id = encodeURIComponent(request.haId);
    let result;
    if (request.action === 'set-setting') {
      result = await this.request('PUT', `/api/homeappliances/${id}/settings/${this._key(request.key, 'setting key')}`, {
        body: { data: { key: request.key, value: request.value } }
      });
    } else if (request.action === 'select-program') {
      result = await this.request('PUT', `/api/homeappliances/${id}/programs/selected`, {
        body: { data: { key: request.program, options: request.options || [] } }
      });
    } else if (request.action === 'start-program') {
      result = await this.request('PUT', `/api/homeappliances/${id}/programs/active`, {
        body: { data: { key: request.program, options: request.options || [] } }
      });
    } else if (request.action === 'stop-program') {
      result = await this.request('DELETE', `/api/homeappliances/${id}/programs/active`);
    } else if (request.action === 'command') {
      result = await this.request('PUT', `/api/homeappliances/${id}/commands/${this._key(request.key, 'command key')}`, {
        body: { data: { key: request.key, value: request.value } }
      });
    } else {
      const kind = request.action === 'set-active-option' ? 'active' : 'selected';
      result = await this.request('PUT', `/api/homeappliances/${id}/programs/${kind}/options/${this._key(request.key, 'option key')}`, {
        body: { data: { key: request.key, value: request.value } }
      });
    }
    this.capabilityCache.delete(request.haId);
    return result;
  }

  openEvents(haId, onEvent, onError = () => {}) {
    let closed = false;
    let controller;
    let lastEventId;
    const path = haId && haId !== '*' ? `/api/homeappliances/${encodeURIComponent(haId)}/events` : '/api/homeappliances/events';
    const close = () => {
      closed = true;
      controller?.abort();
      this.eventClosers.delete(close);
    };
    this.eventClosers.add(close);
    const run = async () => {
      let backoff = 1000;
      while (!closed) {
        controller = new AbortController();
        let announcedConnected = false;
        try {
          await this._rateLimit();
          const token = await this.ensureAccessToken();
          const headers = {
            authorization: 'Bearer ' + token,
            accept: 'text/event-stream',
            'accept-language': this.language
          };
          if (lastEventId) headers['last-event-id'] = lastEventId;
          const response = await this.fetch(new URL(path, this.baseUrl), { headers, signal: controller.signal });
          if (response.status === 401) {
            this.accessToken = null;
            await this.refreshAccessToken();
            continue;
          }
          if (!response.ok) {
            const payload = await response.json().catch(() => ({}));
            const error = apiError(response, payload);
            if (response.status === 429) await this.rateLimiter.recordServerLimit(error.retryAfter || error.message);
            throw error;
          }
          backoff = 1000;
          announcedConnected = true;
          onEvent({
            haId: haId || '*',
            event: 'CONNECTED',
            data: { items: [] },
            timestamp: new Date().toISOString(),
            connection: { synthetic: true },
            simulated: false
          });
          for await (const frame of parseSSE(response.body)) {
            if (closed) break;
            let data = frame.data;
            if (data) { try { data = JSON.parse(data); } catch { /* keep text */ } }
            if (frame.id) lastEventId = frame.id;
            const eventHaId = data && typeof data === 'object' && typeof data.haId === 'string'
              ? data.haId
              : (haId || '*');
            onEvent({ haId: eventHaId, event: frame.event, data, id: frame.id, timestamp: new Date().toISOString(), simulated: false });
            if (frame.retry) backoff = Math.max(1000, Math.min(frame.retry, 30000));
          }
          if (!closed && announcedConnected) {
            onEvent({
              haId: haId || '*',
              event: 'DISCONNECTED',
              data: { items: [] },
              timestamp: new Date().toISOString(),
              connection: { synthetic: true, reason: 'stream-ended' },
              simulated: false
            });
          }
        } catch (error) {
          if (!closed && error.name !== 'AbortError') {
            if (error.status === 429 && Number(error.retryAfter) > 0) {
              backoff = Math.max(backoff, Math.min(Number(error.retryAfter) * 1000, 300000));
            }
            onEvent({
              haId: haId || '*',
              event: 'DISCONNECTED',
              data: { items: [] },
              timestamp: new Date().toISOString(),
              connection: { synthetic: true, reason: error.code || error.name || 'error' },
              simulated: false
            });
            onError(error);
          }
        }
        if (!closed) {
          await sleep(backoff);
          backoff = Math.min(backoff * 2, 30000);
        }
      }
    };
    run().catch(error => { if (!closed) onError(error); });
    return close;
  }

  close() {
    for (const close of [...this.eventClosers]) close();
    this.capabilityCache.clear();
  }
}

module.exports = {
  HomeConnectClient,
  ENVIRONMENTS,
  API_MEDIA_TYPE,
  READ_OPERATIONS,
  retryDelay,
  timedSignal
};
