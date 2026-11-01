'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const filename = path.join(__dirname, '..', 'examples', 'dashboard-dishwasher-washer-oven.json');
const dashboard = JSON.parse(fs.readFileSync(filename, 'utf8'));
const reducer = dashboard.find(node => node.id === 'hc-dashboard-state');

function componentOptions(format) {
  const script = format.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, 'ui-template must contain one script block');
  return new Function(script.replace(/export\s+default/, 'return'))();
}

function componentContext(options, msg = { payload: {} }) {
  // FlowFuse ui-template extends the user component with its own template-scope values.
  // Keep a deliberately non-callable `tr` value here to reproduce the R9 name collision.
  const context = { msg, tr: 'flowfuse-template-scope-value', send() {} };
  Object.assign(context, options.data?.call(context) || {});
  for (const [name, method] of Object.entries(options.methods || {})) context[name] = method.bind(context);
  for (const [name, getter] of Object.entries(options.computed || {})) {
    Object.defineProperty(context, name, { configurable: true, enumerable: true, get: getter.bind(context) });
  }
  return context;
}

function harness() {
  const state = new Map();
  const flow = {
    get(key) { return state.get(key); },
    set(key, value) { state.set(key, value); }
  };
  const run = new Function('msg', 'flow', reducer.func);
  return { flow, run: msg => run(msg, flow) };
}

test('dashboard example is directly importable and requests an initial snapshot', () => {
  assert.ok(Array.isArray(dashboard) && dashboard.length > 0);
  assert.ok(reducer);
  assert.equal(reducer.outputs, 4);
  const inject = dashboard.find(node => node.id === 'hc-refresh');
  assert.equal(inject.once, true);
  assert.ok(Number(inject.onceDelay) >= 0);
  const ids = new Set(dashboard.map(node => node.id).filter(Boolean));
  for (const node of dashboard) {
    for (const output of node.wires || []) for (const target of output) assert.ok(ids.has(target), `${node.id} wires missing ${target}`);
  }
  for (const id of ['hc-ui-dw', 'hc-ui-wm', 'hc-ui-ov']) {
    const format = dashboard.find(node => node.id === id).format;
    assert.match(format, /v-if="statusOnly" class="hc-readonly-panel"/);
    assert.match(format, /<template v-else>/);
    assert.match(format, /<template v-if="!statusOnly">/);
    assert.match(format, /HC\.semantic\(item,this\.locale\)/);
    assert.match(format, /home-connect-dashboard-language/);
    assert.doesNotMatch(format, /Verbindung \/ Connection|Tür \/ Door|Ja \/ Yes|Unaufgelöst \/ unresolved/);
  }
  const overview = dashboard.find(node => node.id === 'hc-ui-overview').format;
  assert.match(overview, /@update:model-value="setLanguage"/);
  assert.match(overview, /warningText\(device\.warning\)/);
  assert.doesNotMatch(overview, /text\?\.de[\s\S]*text\?\.en/);
});

test('dashboard reducer merges local snapshots and STATUS/NOTIFY patches without losing prior state', () => {
  const { run } = harness();
  const snapshot = run({
    haId: 'local-dishwasher', health: 'running', warnings: [],
    payload: {
      appliance: { haId: 'local-dishwasher', name: 'Dishwasher', type: 'Dishwasher', connected: true },
      local: true, readOnly: true,
      status: { items: [{ key: 'BSH.Common.Status.OperationState', value: 'BSH.Common.EnumType.OperationState.Run', category: 'status' }] },
      settings: { items: [{ key: 'BSH.Common.Setting.PowerState', value: 'On', category: 'setting' }] },
      values: { items: [{ key: 'BSH.Common.Option.RemainingProgramTime', value: 3600, category: 'option' }] },
      programs: { available: [{ key: 'Dishcare.Dishwasher.Program.Eco50' }], active: { key: 'Dishcare.Dishwasher.Program.Eco50' }, selected: null },
      connection: { local: true, readOnly: true, state: 'online' }
    }
  });
  assert.equal(snapshot[0].payload.remaining, 3600);
  assert.equal(snapshot[0].payload.readOnly, true);
  assert.equal(snapshot[0].payload.state, 'BSH.Common.EnumType.OperationState.Run');

  const patch = run({
    haId: 'local-dishwasher', health: 'running', warnings: [],
    payload: {
      haId: 'local-dishwasher', event: 'STATUS',
      data: { items: [{ key: 'BSH.Common.Option.RemainingProgramTime', value: 3540, category: 'option' }] },
      connection: { local: true, readOnly: true, action: 'NOTIFY' }
    }
  });
  assert.equal(patch[0].payload.remaining, 3540);
  assert.equal(patch[0].payload.state, 'BSH.Common.EnumType.OperationState.Run');
  assert.equal(patch[0].payload.settings['BSH.Common.Setting.PowerState'], 'On');
  assert.equal(patch[3].payload.dishwasher.remaining, 3540);
});

test('dashboard reducer keeps profile-resolved raw zero semantics, read-only options and explicit missing values', () => {
  const { run } = harness();
  const output = run({
    haId: 'real-dishwasher', health: 'ok', warnings: [],
    payload: {
      appliance: { haId: 'real-dishwasher', type: 'Dishwasher', connected: true }, local: true, readOnly: true,
      values: { items: [
        { key: 'BSH.Common.Status.OperationState', value: 'BSH.Common.EnumType.OperationState.Inactive', rawValue: 0, valueResolved: true, category: 'status' },
        { key: 'BSH.Common.Status.DoorState', value: 'BSH.Common.EnumType.DoorState.Closed', rawValue: 0, valueResolved: true, category: 'status' },
        { key: 'BSH.Common.Status.RemoteControlActive', value: true, rawValue: 1, valueResolved: true, category: 'status' },
        { key: 'BSH.Common.Status.RemoteControlStartAllowed', value: false, rawValue: 0, valueResolved: true, category: 'status' },
        { key: 'BSH.Common.Status.LocalControlActive', value: false, rawValue: 0, valueResolved: true, category: 'status' },
        { key: 'BSH.Common.Option.RemainingProgramTime', value: 0, rawValue: 0, valueResolved: true, category: 'option', unit: 'seconds' }
      ] },
      status: { items: [] }, settings: { items: [] },
      programs: {
        available: [{ key: 'Dishcare.Dishwasher.Program.Intensiv70', name: 'Intensiv70' }],
        active: null,
        selected: { key: 'Dishcare.Dishwasher.Program.Intensiv70' },
        options: [{ key: 'Dishcare.Dishwasher.Option.VarioSpeedPlus', value: false, rawValue: 0, valueResolved: true, category: 'option' }]
      },
      connection: { local: true, readOnly: true, state: 'online' }
    }
  });
  const view = output[0].payload;
  assert.equal(view.state, 'BSH.Common.EnumType.OperationState.Inactive');
  assert.equal(view.stateItem.rawValue, 0);
  assert.equal(view.stateItem.valueResolved, true);
  assert.equal(view.door, 'BSH.Common.EnumType.DoorState.Closed');
  assert.equal(view.remoteControlItem.value, true);
  assert.equal(view.remoteStartItem.value, false);
  assert.equal(view.localControlItem.value, false);
  assert.equal(view.remaining, 0);
  assert.equal(view.remainingItem.unit, 'seconds');
  assert.equal(view.active, null);
  assert.equal(view.selected.key, 'Dishcare.Dishwasher.Program.Intensiv70');
  assert.equal(view.options[0].key, 'Dishcare.Dishwasher.Option.VarioSpeedPlus');
  assert.equal(view.readOnly, true);
});

test('dashboard keeps enum-resolved settings/events and unresolved event raw values without warning carry-over', () => {
  const { run } = harness();
  run({
    haId: 'real-dishwasher', health: 'ok', warnings: [], payload: {
      appliance: { haId: 'real-dishwasher', type: 'Dishwasher', connected: true }, local: true, readOnly: true,
      values: { items: [
        { key: 'BSH.Common.Status.OperationState', value: 'BSH.Common.EnumType.OperationState.Inactive', rawValue: 0, valueResolved: true, resolution: 'profile-enum', category: 'status' },
        { key: 'BSH.Common.Status.RemoteControlStartAllowed', value: false, rawValue: 0, valueResolved: true, resolution: 'profile-boolean', category: 'status' },
        { key: 'BSH.Common.Setting.Language', value: 'BSH.Common.EnumType.Language.DE', rawValue: 7, valueResolved: true, resolution: 'profile-enum', category: 'setting' },
        { key: 'Dishcare.Dishwasher.Status.ProgramPhase', value: 'Dishcare.Dishwasher.EnumType.ProgramPhase.Cleaning', rawValue: 4, valueResolved: true, resolution: 'profile-enum', category: 'status' }
      ] },
      status: { items: [] }, settings: { items: [] }, programs: { available: [], active: null, selected: { key: 'Dishcare.Dishwasher.Program.Auto2', uid: 8195 }, options: [] },
      connection: { local: true, readOnly: true, state: 'online' }
    }
  });
  const event = run({
    haId: 'real-dishwasher', health: 'ok', warnings: [], payload: {
      haId: 'real-dishwasher', event: 'EVENT', connection: { local: true, readOnly: true, action: 'NOTIFY' }, data: { items: [
        { key: 'Dishcare.Dishwasher.Event.SaltNearlyEmpty', value: 'BSH.Common.EnumType.EventState.Present', rawValue: 1, valueResolved: true, resolution: 'profile-enum', category: 'event' },
        { key: 'Dishcare.Dishwasher.Event.RinseAidNearlyEmpty', value: 9, rawValue: 9, valueResolved: false, resolution: 'unresolved-enum', category: 'event' }
      ] }
    }
  })[0].payload;
  assert.equal(event.settings['BSH.Common.Setting.Language'], 'BSH.Common.EnumType.Language.DE');
  assert.equal(event.status['Dishcare.Dishwasher.Status.ProgramPhase'], 'Dishcare.Dishwasher.EnumType.ProgramPhase.Cleaning');
  assert.equal(event.status['Dishcare.Dishwasher.Event.SaltNearlyEmpty'], 'BSH.Common.EnumType.EventState.Present');
  assert.equal(event.itemMeta['Dishcare.Dishwasher.Event.RinseAidNearlyEmpty'].rawValue, 9);
  assert.equal(event.itemMeta['Dishcare.Dishwasher.Event.RinseAidNearlyEmpty'].valueResolved, false);
  assert.equal(event.remoteStartItem.value, false);
  assert.deepEqual(event.warnings, []);
  assert.equal(event.selected.key, 'Dishcare.Dishwasher.Program.Auto2');
});

test('dashboard reducer keeps last known values while offline and recovers on reconnect', () => {
  const { run } = harness();
  run({
    haId: 'local-washer', health: 'ok', warnings: [],
    payload: {
      appliance: { haId: 'local-washer', type: 'Washer', connected: true }, readOnly: true,
      status: { items: [{ key: 'BSH.Common.Status.OperationState', value: 'Ready', category: 'status' }] },
      values: { items: [{ key: 'BSH.Common.Option.RemainingProgramTime', value: 1200, category: 'option' }] },
      settings: { items: [] }, programs: { available: [], active: null, selected: null }
    }
  });
  const offline = run({
    haId: 'local-washer', health: 'offline', warnings: [{ code: 'HC_STREAM_DISCONNECTED' }],
    payload: { haId: 'local-washer', event: 'DISCONNECTED', data: { items: [] }, connection: { local: true, readOnly: true, reconnecting: true } }
  });
  assert.equal(offline[1].payload.health, 'offline');
  assert.equal(offline[1].payload.appliance.connected, false);
  assert.equal(offline[1].payload.remaining, 1200);
  assert.equal(offline[1].payload.state, 'Ready');
  assert.equal(offline[1].payload.stale, true);

  const online = run({
    haId: 'local-washer', health: 'info', warnings: [],
    payload: { haId: 'local-washer', event: 'CONNECTED', data: { items: [] }, connection: { local: true, readOnly: true } }
  });
  assert.equal(online[1].payload.appliance.connected, true);
  assert.equal(online[1].payload.remaining, 1200);
  assert.equal(online[1].payload.stale, false);
});

test('dashboard reducer retains the cloud snapshot and event path', () => {
  const { run } = harness();
  run({
    haId: 'cloud-oven', health: 'ok', warnings: [],
    payload: {
      appliance: { haId: 'cloud-oven', type: 'Oven', connected: true }, readOnly: false,
      status: { items: [{ key: 'BSH.Common.Status.OperationState', value: 'Ready' }] },
      settings: { items: [] }, values: { items: [] }, programs: { available: [{ key: 'Cooking.Oven.Program.HeatingMode.HotAir' }], active: null, selected: null }
    }
  });
  const event = run({
    haId: 'cloud-oven', health: 'running', warnings: [],
    payload: { haId: 'cloud-oven', event: 'STATUS', data: { items: [{ key: 'BSH.Common.Status.OperationState', value: 'Run' }] }, connection: {} }
  });
  assert.equal(event[2].payload.health, 'running');
  assert.equal(event[2].payload.state, 'Run');
  assert.equal(event[2].payload.readOnly, false);
  assert.equal(event[2].payload.programs[0].key, 'Cooking.Oven.Program.HeatingMode.HotAir');
});


test('screenshot flow is directly importable, deterministic, and credential-free', () => {
  const screenshotFilename = path.join(__dirname, '..', 'examples', 'dashboard-screenshot-simulated.json');
  const screenshot = JSON.parse(fs.readFileSync(screenshotFilename, 'utf8'));
  assert.ok(Array.isArray(screenshot) && screenshot.length > 0);
  const productionIds = new Set(dashboard.map(node => node.id));
  const demoIds = screenshot.map(node => node.id);
  assert.equal(new Set(demoIds).size, demoIds.length);
  assert.ok(demoIds.every(id => id.startsWith('demo-hc-r9-fix1-')));
  assert.equal(demoIds.some(id => productionIds.has(id)), false);
  for (const node of screenshot) {
    const visibleName = node.type === 'tab' ? node.label : node.name;
    if (visibleName) assert.match(visibleName, /^Demo\b/, `${node.id} must have an unmistakable Demo name`);
    for (const output of node.wires || []) for (const target of output) assert.ok(demoIds.includes(target), `${node.id} references non-demo node ${target}`);
  }
  assert.equal(screenshot.find(node => node.type === 'ui-base').path, '/demo-home-connect-r9-fix1');
  assert.equal(screenshot.find(node => node.type === 'ui-page' && node.name === 'Demo Übersicht').path, '/demo-overview');
  assert.equal(screenshot.find(node => node.type === 'ui-page' && node.name === 'Demo Gerätedetails').path, '/demo-details');
  const demoTemplates = screenshot.filter(node => node.type === 'ui-template').map(node => node.format).join('\n');
  assert.match(demoTemplates, /title:'Demo '\+HC\.deviceType/);
  assert.match(demoTemplates, /'\/demo-details'/);
  assert.match(demoTemplates, /'\/demo-overview'/);
  assert.doesNotMatch(demoTemplates, /'\/home-connect'|'\/overview'/);
  const forbiddenTypes = new Set(['home-connect-config', 'home-connect-read', 'home-connect-events', 'home-connect-write']);
  assert.equal(screenshot.some(node => forbiddenTypes.has(node.type)), false);
  assert.equal(screenshot.some(node => Object.hasOwn(node, 'credentials')), false);
  const inject = screenshot.find(node => node.id === 'demo-hc-r9-fix1-inject');
  const demo = screenshot.find(node => node.id === 'demo-hc-r9-fix1-data');
  assert.equal(inject.once, true);
  assert.ok(demo);
  const messages = new Function('msg', demo.func)({ payload: Date.now() });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].length, 3);
  assert.deepEqual(messages[0].map(message => message.payload.appliance.type), ['Dishwasher', 'Washer', 'Oven']);
  for (const message of messages[0]) {
    assert.equal(message.payload.simulated, true);
    assert.match(message.haId, /^demo-simulated-/);
    assert.match(message.payload.appliance.name, /^Demo\b/);
    assert.equal(message.payload.appliance.connected, true);
  }
  const serialized = JSON.stringify(screenshot);
  assert.doesNotMatch(serialized, /clientSecret|refreshToken|accessToken|localDeviceMappings|profileDirectory/);
  assert.match(serialized, /SIMULIERT/);
  assert.match(serialized, /SIMULATED/);
});

test('all FlowFuse 1.34.1 ui-templates avoid the injected tr name and resolve computed i18n labels', () => {
  for (const [flowName, flow] of [['production', dashboard], ['demo', JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'examples', 'dashboard-screenshot-simulated.json'), 'utf8'))]]) {
    for (const node of flow.filter(item => item.type === 'ui-template')) {
      const format = node.format || '';
      const template = format.match(/<template>([\s\S]*?)<\/template>/)?.[1] || '';
      assert.doesNotMatch(template, /(?<![\w$])tr\s*\(/, `${flowName}:${node.id} calls the colliding tr value`);
      const options = componentOptions(format);
      assert.equal(Object.hasOwn(options.methods || {}, 'tr'), false, `${flowName}:${node.id} exposes a colliding tr method`);
      const context = componentContext(options);
      assert.equal(typeof context.hcLabels, 'object', `${flowName}:${node.id} lacks computed hcLabels`);
      assert.equal(typeof context.hcLabels.language, 'string');

      const allExpressions = [
        ...[...template.matchAll(/{{\s*([\s\S]*?)\s*}}/g)].map(match => match[1]),
        ...[...template.matchAll(/(?:v-[\w:-]+|:[\w-]+|@[\w.:-]+)="([^"]+)"/g)].map(match => match[1])
      ];
      const localizedExpressions = allExpressions.filter(expression => expression.includes('hcLabels'));
      assert.ok(localizedExpressions.length > 0, `${flowName}:${node.id} must bind localized labels`);
      for (const expression of localizedExpressions) {
        assert.doesNotThrow(() => new Function('ctx', `with(ctx){return (${expression})}`)(context), `${flowName}:${node.id} cannot render ${expression}`);
      }
      for (const expression of allExpressions) {
        for (const match of expression.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
          const name = match[1];
          assert.equal(typeof context[name], 'function', `${flowName}:${node.id} render function ${name} is not callable`);
        }
      }
    }
  }
});

test('screenshot flow reducer renders all three simulated appliances in the overview', () => {
  const screenshotFilename = path.join(__dirname, '..', 'examples', 'dashboard-screenshot-simulated.json');
  const screenshot = JSON.parse(fs.readFileSync(screenshotFilename, 'utf8'));
  const demo = screenshot.find(node => node.id === 'demo-hc-r9-fix1-data');
  const screenshotReducer = screenshot.find(node => node.id === 'demo-hc-r9-fix1-dashboard-state');
  const state = new Map();
  const flow = { get: key => state.get(key), set: (key, value) => state.set(key, value) };
  const runReducer = new Function('msg', 'flow', screenshotReducer.func);
  const messages = new Function('msg', demo.func)({ payload: 0 })[0];
  let output;
  for (const message of messages) output = runReducer(message, flow);
  assert.deepEqual(Object.keys(output[3].payload).sort(), ['dishwasher', 'oven', 'washer']);
  assert.equal(output[3].payload.dishwasher.simulated, true);
  assert.equal(output[3].payload.washer.warnings[0].text.de, 'Dosierbehälter fast leer.');
  assert.equal(output[3].payload.oven.remaining, 1680);
});
