'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { HealthMonitor, HEALTH_SCHEMA } = require('../lib/health');
const { HomeConnectError } = require('../lib/errors');

const status = (operation, extra = []) => ({ items: [
  { key: 'BSH.Common.Status.OperationState', value: `BSH.Common.EnumType.OperationState.${operation}` },
  { key: 'BSH.Common.Status.DoorState', value: 'BSH.Common.EnumType.DoorState.Closed' },
  { key: 'BSH.Common.Status.RemoteControlActive', value: true },
  { key: 'BSH.Common.Status.RemoteControlStartAllowed', value: true },
  { key: 'BSH.Common.Status.LocalControlActive', value: false },
  ...extra
] });

const snapshot = (operation = 'Ready', extra = {}) => ({
  appliance: { haId: 'appliance-1', name: 'Test appliance', type: 'Oven', brand: 'Example', vib: 'EXAMPLE-VIB', connected: true },
  status: status(operation, extra.status || []),
  programs: { available: [], active: null, selected: null }
});

test('snapshot health maps normal, running and action-required operation states', () => {
  const monitor = new HealthMonitor();
  const ready = snapshot('Ready');
  assert.equal(monitor.assessPayload(ready, { operation: 'snapshot' }).health, 'ok');
  assert.equal(ready.healthSchema, HEALTH_SCHEMA);
  assert.deepEqual(ready.warnings, []);

  const running = snapshot('Run');
  assert.equal(monitor.assessPayload(running, { operation: 'snapshot' }).health, 'running');

  const action = snapshot('ActionRequired');
  const assessment = monitor.assessPayload(action, { operation: 'snapshot' });
  assert.equal(assessment.health, 'action_required');
  assert.equal(assessment.warnings[0].code, 'HC_OPERATION_ACTION_REQUIRED');
  assert.equal(typeof assessment.warnings[0].text.de, 'string');
  assert.equal(typeof assessment.warnings[0].text.en, 'string');
});

test('door, delayed start, pause and remote-control states are normalized without duplicate noise', () => {
  const monitor = new HealthMonitor();
  let value = snapshot('Run', { status: [
    { key: 'BSH.Common.Status.DoorState', value: 'BSH.Common.EnumType.DoorState.Open' }
  ] });
  let assessment = monitor.assessPayload(value, { operation: 'snapshot' });
  assert.equal(assessment.health, 'action_required');
  assert.ok(assessment.warnings.some(item => item.code === 'HC_DOOR_OPEN'));

  value = snapshot('DelayedStart');
  assessment = monitor.assessPayload(value, { operation: 'snapshot' });
  assert.equal(assessment.health, 'info');
  assert.ok(assessment.warnings.some(item => item.code === 'HC_OPERATION_DELAYED_START'));

  value = snapshot('Pause', { status: [
    { key: 'BSH.Common.Status.LocalControlActive', value: true },
    { key: 'BSH.Common.Status.RemoteControlActive', value: false },
    { key: 'BSH.Common.Status.RemoteControlStartAllowed', value: false }
  ] });
  assessment = monitor.assessPayload(value, { operation: 'snapshot' });
  assert.equal(assessment.health, 'warning');
  assert.ok(assessment.warnings.some(item => item.code === 'HC_LOCAL_CONTROL_ACTIVE'));
  assert.ok(!assessment.warnings.some(item => item.code === 'HC_REMOTE_CONTROL_INACTIVE'));
  assert.ok(!assessment.warnings.some(item => item.code === 'HC_REMOTE_START_NOT_ALLOWED'));
});

test('finished and connected notices expire while disconnected remains offline until recovery', () => {
  let clock = Date.parse('2026-01-01T00:00:00Z');
  const monitor = new HealthMonitor({ now: () => clock, transientTtlMs: 5000 });
  monitor.assessPayload(snapshot('Run'), { operation: 'snapshot' });
  let assessment = monitor.assessEvent({
    haId: 'appliance-1', event: 'STATUS', timestamp: new Date(clock).toISOString(),
    data: { items: [{ key: 'BSH.Common.Status.OperationState', value: 'BSH.Common.EnumType.OperationState.Finished' }] }
  });
  assert.equal(assessment.health, 'info');
  assert.ok(assessment.warnings.some(item => item.code === 'HC_OPERATION_FINISHED' && item.transient));

  clock += 6000;
  assessment = monitor.current('appliance-1');
  assert.ok(!assessment.warnings.some(item => item.code === 'HC_OPERATION_FINISHED'));

  assessment = monitor.assessEvent({ haId: 'appliance-1', event: 'DISCONNECTED', data: { items: [] } });
  assert.equal(assessment.health, 'offline');
  assert.ok(assessment.warnings.some(item => item.code === 'HC_STREAM_DISCONNECTED'));

  assessment = monitor.assessEvent({ haId: 'appliance-1', event: 'CONNECTED', data: { items: [] } });
  assert.equal(assessment.health, 'info');
  assert.ok(assessment.warnings.some(item => item.code === 'HC_STREAM_CONNECTED'));
});

test('unresolved local raw status values remain diagnostic but do not create semantic warnings', () => {
  const monitor = new HealthMonitor();
  const payload = snapshot('Ready');
  payload.status.items = [
    { key: 'BSH.Common.Status.OperationState', value: 0, rawValue: 0, valueResolved: false },
    { key: 'BSH.Common.Status.DoorState', value: 1, rawValue: 1, valueResolved: false },
    { key: 'BSH.Common.Status.RemoteControlActive', value: 0, rawValue: 0, valueResolved: false },
    { key: 'BSH.Common.Status.RemoteControlStartAllowed', value: 0, rawValue: 0, valueResolved: false },
    { key: 'BSH.Common.Status.LocalControlActive', value: 1, rawValue: 1, valueResolved: false }
  ];
  const assessment = monitor.assessPayload(payload, { operation: 'snapshot' });
  assert.equal(assessment.health, 'ok');
  assert.equal(assessment.warnings.some(item => item.code === 'HC_OPERATION_UNKNOWN'), false);
  assert.equal(assessment.warnings.some(item => item.code === 'HC_DOOR_OPEN'), false);
  assert.equal(assessment.warnings.some(item => item.code === 'HC_REMOTE_CONTROL_INACTIVE'), false);
  assert.equal(assessment.warnings.some(item => item.code === 'HC_REMOTE_START_NOT_ALLOWED'), false);
  assert.equal(assessment.warnings.some(item => item.code === 'HC_LOCAL_CONTROL_ACTIVE'), false);
  assert.equal(payload.status.items[0].rawValue, 0);
});

test('resolved real-profile inactive state and local read-only remote-start false remain healthy', () => {
  const monitor = new HealthMonitor();
  const payload = snapshot('Ready');
  payload.local = true;
  payload.readOnly = true;
  payload.connection = { local: true, readOnly: true };
  payload.status.items = [
    { key: 'BSH.Common.Status.OperationState', value: 'BSH.Common.EnumType.OperationState.Inactive', rawValue: 0, valueResolved: true, resolution: 'profile-enum' },
    { key: 'BSH.Common.Status.DoorState', value: 'BSH.Common.EnumType.DoorState.Open', rawValue: 1, valueResolved: true, resolution: 'profile-enum' },
    { key: 'BSH.Common.Status.RemoteControlActive', value: true, rawValue: 1, valueResolved: true, resolution: 'profile-boolean' },
    { key: 'BSH.Common.Status.RemoteControlStartAllowed', value: false, rawValue: 0, valueResolved: true, resolution: 'profile-boolean' },
    { key: 'BSH.Common.Status.LocalControlActive', value: false, rawValue: 0, valueResolved: true, resolution: 'profile-boolean' }
  ];
  const assessment = monitor.assessPayload(payload, { operation: 'snapshot' });
  assert.equal(assessment.warnings.some(item => item.code === 'HC_OPERATION_UNKNOWN'), false);
  assert.equal(assessment.warnings.some(item => item.code === 'HC_REMOTE_START_NOT_ALLOWED'), false);
  assert.ok(assessment.warnings.some(item => item.code === 'HC_DOOR_OPEN'));
  assert.equal(assessment.health, 'info');
});

test('unresolved local event values do not produce event health warnings', () => {
  const monitor = new HealthMonitor();
  monitor.assessPayload(snapshot('Ready'), { operation: 'snapshot' });
  const assessment = monitor.assessEvent({
    haId: 'appliance-1', event: 'EVENT', connection: { local: true, readOnly: true }, data: { items: [
      {
        key: 'Dishcare.Dishwasher.Event.RinseAidNearlyEmpty', value: 9, rawValue: 9,
        valueResolved: false, resolution: 'unresolved-enum', level: 'warning', handling: 'acknowledge'
      }
    ] }
  });
  assert.equal(assessment.health, 'ok');
  assert.equal(assessment.warnings.some(item => item.code.startsWith('HC_EVENT_')), false);
});

test('event level and handling become a bilingual, deduplicated action warning', () => {
  const monitor = new HealthMonitor();
  monitor.assessPayload(snapshot('Ready'), { operation: 'snapshot' });
  const event = {
    haId: 'appliance-1', event: 'EVENT', data: { items: [
      { key: 'Example.Event.RefillWater', value: true, level: 'warning', handling: 'acknowledge' },
      { key: 'Example.Event.RefillWater', value: true, level: 'warning', handling: 'acknowledge' }
    ] }
  };
  const assessment = monitor.assessEvent(event);
  assert.equal(assessment.health, 'action_required');
  assert.equal(assessment.warnings.filter(item => item.code === 'HC_EVENT_EXAMPLE_EVENT_REFILLWATER').length, 1);
  assert.equal(event.health, 'action_required');
  const item = assessment.warnings.find(entry => entry.code === 'HC_EVENT_EXAMPLE_EVENT_REFILLWATER');
  assert.equal(item.handling, 'acknowledge');
  assert.equal(item.level, 'warning');
});

test('API and OAuth errors map to stable health codes and preserve retry-after', () => {
  const monitor = new HealthMonitor();
  let assessment = monitor.assessError(new HomeConnectError('Missing scope', { code: 'insufficient_scope', status: 403 }));
  assert.equal(assessment.health, 'action_required');
  assert.equal(assessment.warnings[0].code, 'HC_OAUTH_INSUFFICIENT_SCOPE');

  assessment = monitor.assessError(new HomeConnectError('Too many requests', { code: 'HTTP_429', status: 429, retryAfter: '12' }));
  assert.equal(assessment.health, 'warning');
  assert.equal(assessment.warnings[0].code, 'HC_API_RATE_LIMITED');
  assert.equal(assessment.warnings[0].retryAfter, '12');

  assessment = monitor.assessError(new HomeConnectError('Network down', { code: 'NETWORK_ERROR' }));
  assert.equal(assessment.health, 'offline');
  assert.equal(assessment.warnings[0].code, 'HC_NETWORK_ERROR');
});

test('multiple appliance discovery returns worst aggregate health and decorates each snapshot', () => {
  const monitor = new HealthMonitor();
  const online = snapshot('Run');
  const offline = snapshot('Ready');
  offline.appliance = { ...offline.appliance, haId: 'appliance-2', connected: false };
  const assessment = monitor.assessPayload([online, offline], { operation: 'discover' });
  assert.equal(assessment.health, 'offline');
  assert.equal(assessment.appliances, 2);
  assert.equal(online.health, 'running');
  assert.equal(offline.health, 'offline');
});
