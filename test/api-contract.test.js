'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const contract = require('../docs/official-api-contract.json');
const { API_MEDIA_TYPE, ENVIRONMENTS, READ_OPERATIONS, WRITE_ACTIONS } = require('../lib/constants');

function operations(specification) {
  return new Set(specification.operations.map(operation => `${operation.method} ${operation.path}`));
}

test('generated contract inventory is pinned to both supplied official specifications', () => {
  assert.deepEqual(contract.specifications.map(specification => specification.file), [
    'hcsdk-simulation.yaml', 'hcsdk-production.yaml'
  ]);
  assert.deepEqual(contract.specifications.map(specification => specification.sha256), [
    '5942f5ca450a46fa9a6f53ff6d13627972040f105dcd786efddcf9a44ce376a3',
    'a0704118d429eb1a7becf9d624068a2c48ce8d7c0a2250128be2487ff0758c57'
  ]);
});

test('environment hosts and vendor media type match the supplied specifications', () => {
  const [simulation, production] = contract.specifications;
  assert.equal(ENVIRONMENTS['official-simulator'], `https://${simulation.host}`);
  assert.equal(ENVIRONMENTS.production, `https://${production.host}`);
  assert.equal(simulation.basePath, '/api');
  assert.equal(production.basePath, '/api');
  assert.ok(simulation.consumes.includes(API_MEDIA_TYPE));
  assert.ok(production.produces.includes(API_MEDIA_TYPE));
});

test('OAuth endpoints and access-code flow match both supplied specifications', () => {
  const [simulation, production] = contract.specifications;
  assert.deepEqual(simulation.oauth, {
    type: 'oauth2',
    flow: 'accessCode',
    authorizationUrl: 'https://simulator.home-connect.com/security/oauth/authorize',
    tokenUrl: 'https://simulator.home-connect.com/security/oauth/token'
  });
  assert.deepEqual(production.oauth, {
    type: 'oauth2',
    flow: 'accessCode',
    authorizationUrl: 'https://api.home-connect.com/security/oauth/authorize',
    tokenUrl: 'https://api.home-connect.com/security/oauth/token'
  });
});

test('bounded read and write API covers the official generic appliance resources', () => {
  const [simulation, production] = contract.specifications.map(operations);
  const required = [
    'GET /api/homeappliances',
    'GET /api/homeappliances/{haId}',
    'GET /api/homeappliances/{haId}/status',
    'GET /api/homeappliances/{haId}/status/{statuskey}',
    'GET /api/homeappliances/{haId}/settings',
    'GET /api/homeappliances/{haId}/settings/{settingkey}',
    'GET /api/homeappliances/{haId}/programs',
    'GET /api/homeappliances/{haId}/programs/available',
    'GET /api/homeappliances/{haId}/programs/active/options/{optionkey}',
    'PUT /api/homeappliances/{haId}/programs/active/options/{optionkey}',
    'GET /api/homeappliances/events'
  ];
  for (const operation of required) {
    assert.ok(simulation.has(operation), `simulation missing ${operation}`);
    assert.ok(production.has(operation), `production missing ${operation}`);
  }
  assert.ok(production.has('GET /api/homeappliances/{haId}/commands'));
  assert.equal(simulation.has('GET /api/homeappliances/{haId}/commands'), false);
  assert.ok(production.has('GET /api/homeappliances/{haId}/map/maps'));
  assert.equal(simulation.has('GET /api/homeappliances/{haId}/map/maps'), false);
  for (const operation of ['status-item', 'setting', 'all-programs', 'active-option', 'selected-option', 'images', 'maps', 'map']) {
    assert.ok(READ_OPERATIONS.includes(operation));
  }
  for (const action of ['start-program', 'stop-program', 'select-program', 'set-setting', 'command', 'set-active-option', 'set-selected-option']) {
    assert.ok(WRITE_ACTIONS.includes(action));
  }
});


test('public operation inventory and node action lists expose no firmware endpoint', () => {
  const searchable = JSON.stringify({ contract, READ_OPERATIONS, WRITE_ACTIONS }).toLowerCase();
  assert.equal(searchable.includes('firmware'), false);
});
