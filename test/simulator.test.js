'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { BuiltinSimulator } = require('../lib/simulator');

test('built-in simulator discovers dishwasher, washer and oven', async t => {
  const simulator = new BuiltinSimulator(); t.after(() => simulator.close());
  const devices = await simulator.discoverAll();
  assert.deepEqual(devices.map(entry => entry.appliance.type), ['Dishwasher', 'Washer', 'Oven']);
  assert.ok(devices.every(entry => entry.programs.available.length >= 3));
});

test('simulator emits an event and updates active program on start', async t => {
  const simulator = new BuiltinSimulator(); t.after(() => simulator.close());
  const events = [];
  const close = simulator.openEvents('oven-001', event => events.push(event));
  t.after(close);
  const cap = await simulator.discoverAppliance('oven-001');
  const result = await simulator.write({
    action: 'start-program', haId: 'oven-001', program: 'Cooking.Oven.Program.HeatingMode.HotAir',
    options: [{ key: 'Cooking.Oven.Option.SetpointTemperature', value: 180 }]
  }, cap);
  assert.equal(result.accepted, true);
  assert.equal((await simulator.getActiveProgram('oven-001')).key, 'Cooking.Oven.Program.HeatingMode.HotAir');
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(events.some(event => event.event === 'STATUS'));
});

test('simulator rejects invalid option values', async t => {
  const simulator = new BuiltinSimulator(); t.after(() => simulator.close());
  const cap = await simulator.discoverAppliance('oven-001');
  await assert.rejects(() => simulator.write({
    action: 'start-program', haId: 'oven-001', program: 'Cooking.Oven.Program.HeatingMode.HotAir',
    options: [{ key: 'Cooking.Oven.Option.SetpointTemperature', value: 999 }]
  }, cap), { code: 'VALUE_ABOVE_MAXIMUM' });
});

test('simulator stop returns appliance to Ready', async t => {
  const simulator = new BuiltinSimulator(); t.after(() => simulator.close());
  let cap = await simulator.discoverAppliance('dishwasher-001');
  await simulator.write({ action: 'start-program', haId: 'dishwasher-001', program: 'Dishcare.Dishwasher.Program.Eco50', options: [] }, cap);
  cap = await simulator.discoverAppliance('dishwasher-001');
  await simulator.write({ action: 'stop-program', haId: 'dishwasher-001', options: [] }, cap);
  const state = (await simulator.getStatus('dishwasher-001')).items.find(entry => entry.key.endsWith('OperationState')).value;
  assert.equal(state, 'BSH.Common.EnumType.OperationState.Ready');
});

test('simulator supports official singular reads and active option writes', async t => {
  const simulator = new BuiltinSimulator(); t.after(() => simulator.close());
  const status = await simulator.read('oven-001', 'status-item', 'BSH.Common.Status.OperationState');
  assert.equal(status.value, 'BSH.Common.EnumType.OperationState.Ready');
  let cap = await simulator.discoverAppliance('oven-001');
  await simulator.write({
    action: 'start-program', haId: 'oven-001', program: 'Cooking.Oven.Program.HeatingMode.HotAir',
    options: [{ key: 'Cooking.Oven.Option.SetpointTemperature', value: 180 }]
  }, cap);
  cap = await simulator.discoverAppliance('oven-001');
  await simulator.write({
    action: 'set-active-option', haId: 'oven-001',
    key: 'Cooking.Oven.Option.SetpointTemperature', value: 185
  }, cap);
  const option = await simulator.read('oven-001', 'active-option', 'Cooking.Oven.Option.SetpointTemperature');
  assert.equal(option.value, 185);
});
