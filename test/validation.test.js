'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assertValue, validateWrite } = require('../lib/validation');

const capability = {
  appliance: { haId: 'oven', type: 'Oven', connected: true },
  status: { items: [
    { key: 'BSH.Common.Status.RemoteControlActive', value: true },
    { key: 'BSH.Common.Status.RemoteControlStartAllowed', value: true },
    { key: 'BSH.Common.Status.LocalControlActive', value: false },
    { key: 'BSH.Common.Status.OperationState', value: 'BSH.Common.EnumType.OperationState.Ready' }
  ] },
  settings: { items: [
    { key: 'Power', value: 'On', type: 'String', constraints: { allowedvalues: ['On', 'Standby'], access: 'readWrite' } },
    { key: 'Serial', value: '123', type: 'String', constraints: { access: 'read' } }
  ] },
  programs: {
    available: [{
      key: 'HotAir',
      constraints: { access: 'readWrite' },
      options: [
        { key: 'Temperature', type: 'Integer', constraints: { min: 30, max: 250, stepsize: 5, access: 'readWrite' } },
        { key: 'Telemetry', type: 'Integer', constraints: { access: 'read' } }
      ]
    }],
    active: null,
    selected: null
  },
  commands: { items: [{ key: 'Pause', type: 'Boolean', constraints: { allowedvalues: [true], access: 'readWrite' } }] }
};

test('numeric constraints enforce type, min, max and step', () => {
  assert.doesNotThrow(() => assertValue(180, { min: 30, max: 250, stepsize: 5 }, 'temperature', 'Integer'));
  assert.throws(() => assertValue(180.5, { min: 30, max: 250 }, 'temperature', 'Integer'), { code: 'VALUE_INVALID_TYPE' });
  assert.throws(() => assertValue(181, { min: 30, max: 250, stepsize: 5 }, 'temperature'), { code: 'VALUE_INVALID_STEP' });
  assert.throws(() => assertValue(260, { min: 30, max: 250 }, 'temperature'), { code: 'VALUE_ABOVE_MAXIMUM' });
});

test('start and select validate program options against live capabilities', () => {
  const request = { program: 'HotAir', options: [{ key: 'Temperature', value: 180 }] };
  assert.doesNotThrow(() => validateWrite(capability, { action: 'start-program', ...request }));
  assert.doesNotThrow(() => validateWrite(capability, { action: 'select-program', ...request }));
  assert.throws(() => validateWrite(capability, { action: 'start-program', program: 'Grill', options: [] }), { code: 'PROGRAM_NOT_AVAILABLE' });
  assert.throws(() => validateWrite(capability, {
    action: 'select-program', program: 'HotAir', options: [{ key: 'Temperature', value: 181 }]
  }), { code: 'VALUE_INVALID_STEP' });
});

test('duplicate and read-only options are rejected', () => {
  assert.throws(() => validateWrite(capability, {
    action: 'start-program', program: 'HotAir', options: [
      { key: 'Temperature', value: 180 }, { key: 'Temperature', value: 185 }
    ]
  }), { code: 'OPTION_DUPLICATE' });
  assert.throws(() => validateWrite(capability, {
    action: 'start-program', program: 'HotAir', options: [{ key: 'Telemetry', value: 1 }]
  }), { code: 'RESOURCE_READ_ONLY' });
});

test('remote-start and active-program preconditions are enforced', () => {
  const blocked = structuredClone(capability);
  blocked.status.items.find(entry => entry.key.endsWith('RemoteControlStartAllowed')).value = false;
  assert.throws(() => validateWrite(blocked, { action: 'start-program', program: 'HotAir', options: [] }), { code: 'REMOTE_START_DISABLED' });
  const active = structuredClone(capability);
  active.programs.active = { key: 'HotAir', options: [] };
  assert.throws(() => validateWrite(active, { action: 'start-program', program: 'HotAir', options: [] }), { code: 'PROGRAM_ALREADY_ACTIVE' });
});

test('settings and commands are allowlisted, typed and checked for write access', () => {
  assert.doesNotThrow(() => validateWrite(capability, { action: 'set-setting', key: 'Power', value: 'Standby' }));
  assert.throws(() => validateWrite(capability, { action: 'set-setting', key: 'Unknown', value: true }), { code: 'SETTING_NOT_AVAILABLE' });
  assert.throws(() => validateWrite(capability, { action: 'set-setting', key: 'Serial', value: '456' }), { code: 'RESOURCE_READ_ONLY' });
  assert.throws(() => validateWrite(capability, { action: 'command', key: 'Pause', value: 'true' }), { code: 'VALUE_INVALID_TYPE' });
  assert.throws(() => validateWrite(capability, { action: 'command', key: 'Pause', value: false }), { code: 'VALUE_NOT_ALLOWED' });
});

test('stop and active-option writes require current program state', () => {
  assert.throws(() => validateWrite(capability, { action: 'stop-program' }), { code: 'NO_ACTIVE_PROGRAM' });
  const active = structuredClone(capability);
  active.programs.active = structuredClone(active.programs.available[0]);
  assert.doesNotThrow(() => validateWrite(active, { action: 'stop-program' }));
  assert.doesNotThrow(() => validateWrite(active, { action: 'set-active-option', key: 'Temperature', value: 185 }));
});
