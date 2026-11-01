'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDashboardI18n } = require('../lib/dashboard-i18n');

test('dashboard locale follows explicit message, saved, dashboard, document, and browser language', () => {
  const values = new Map([['home-connect-dashboard-language', 'de-DE']]);
  const environment = {
    localStorage: { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) },
    document: { documentElement: { lang: 'en-US' } },
    navigator: { languages: ['en-GB'] }
  };
  const i18n = createDashboardI18n(environment);
  assert.equal(i18n.detectLocale(null, { uiLocale: 'en-US' }), 'en');
  assert.equal(i18n.detectLocale({ $vuetify: { locale: { current: { value: 'en' } } } }), 'de');
  values.delete(i18n.STORAGE_KEY);
  assert.equal(i18n.detectLocale({ $vuetify: { locale: { current: { value: 'de-DE' } } } }), 'de');
  assert.equal(i18n.normalizeLocale('de_AT'), 'de');
  assert.equal(i18n.normalizeLocale('en-GB'), 'en');
  assert.equal(i18n.normalizeLocale('fr-FR'), '');
});

test('language selection is persisted and announced to all dashboard cards', () => {
  const values = new Map();
  const events = [];
  class CustomEvent {
    constructor(type, options) { this.type = type; this.detail = options.detail; }
  }
  const i18n = createDashboardI18n({
    localStorage: { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) },
    CustomEvent,
    dispatchEvent: event => events.push(event)
  });
  assert.equal(i18n.setLocale('de-DE'), 'de');
  assert.equal(values.get(i18n.STORAGE_KEY), 'de');
  assert.equal(events[0].type, i18n.EVENT_NAME);
  assert.deepEqual(events[0].detail, { locale: 'de' });
});

test('German and English labels never require bilingual slash captions', () => {
  const i18n = createDashboardI18n();
  assert.equal(i18n.t('connection', 'de'), 'Verbindung');
  assert.equal(i18n.t('connection', 'en'), 'Connection');
  assert.equal(i18n.t('localProfileReadOnly', 'de'), 'Lokale Profilwerte · nur lesend');
  assert.equal(i18n.t('localProfileReadOnly', 'en'), 'Local profile values · read-only');
  assert.equal(i18n.healthLabel('action_required', 'de'), 'Aktion nötig');
  assert.equal(i18n.healthLabel('action_required', 'en'), 'Action required');
});

test('device types, enum members, programs, and options are localized without changing keys', () => {
  const i18n = createDashboardI18n();
  const program = { key: 'Dishcare.Dishwasher.Program.Auto2', uid: 8195 };
  const items = i18n.programItems([program], 'de');
  assert.equal(i18n.deviceType('Dishwasher', 'de'), 'Geschirrspüler');
  assert.equal(i18n.deviceType('Dishwasher', 'en'), 'Dishwasher');
  assert.equal(i18n.semantic({ value: 'BSH.Common.EnumType.OperationState.Inactive', valueResolved: true }, 'de'), 'Inaktiv');
  assert.equal(i18n.semantic({ value: 'BSH.Common.EnumType.DoorState.Closed', valueResolved: true }, 'de'), 'Geschlossen');
  assert.equal(i18n.displayKey('BSH.Common.Option.ProgramProgress', 'de'), 'Programmfortschritt');
  assert.equal(i18n.displayKey('Dishcare.Dishwasher.Option.BrillianceDry', 'de'), 'Glanztrocknen');
  assert.equal(i18n.displayName(program, 'de'), 'Automatik 45–65 °C');
  assert.equal(i18n.displayName(program, 'en'), 'Auto 45–65 °C');
  assert.equal(items[0].key, program.key);
  assert.equal(items[0].uid, program.uid);
  assert.equal(items[0].title, 'Automatik 45–65 °C');
});

test('warnings select one language and unresolved values get a localized raw fallback', () => {
  const i18n = createDashboardI18n();
  const warning = { code: 'HC_APPLIANCE_OFFLINE', text: { de: 'Gerät ist offline.', en: 'Appliance is offline.' } };
  assert.equal(i18n.warningText(warning, 'de'), 'Gerät ist offline.');
  assert.equal(i18n.warningText(warning, 'en'), 'Appliance is offline.');
  assert.equal(i18n.semantic({ rawValue: 91, valueResolved: false }, 'de'), 'Unbekannter Wert (Rohwert: 91)');
  assert.equal(i18n.semantic({ rawValue: 91, valueResolved: false }, 'en'), 'Unknown value (raw value: 91)');
  assert.equal(i18n.warningText({ code: 'HC_FUTURE_NOTICE' }, 'de'), 'Unbekannter Hinweis (HC_FUTURE_NOTICE)');
});

test('remaining time keeps R8 units and local/cloud conversion semantics', () => {
  const i18n = createDashboardI18n();
  assert.equal(i18n.remaining({ remaining: 3600, remainingItem: { unit: 'seconds' }, connection: { local: true } }, 'de'), '60 min');
  assert.equal(i18n.remaining({ remaining: 61, remainingItem: { unit: 'minutes' }, connection: { local: true } }, 'en'), '61 min');
  assert.equal(i18n.remaining({ remaining: 0, remainingItem: { unit: 'seconds', valueResolved: true }, connection: { local: true } }, 'de'), '0 min');
  assert.equal(i18n.remaining({ remaining: null }, 'de'), '—');
});


test('dashboard i18n supports isolated storage and event names for the demo dashboard', () => {
  const values = new Map();
  const events = [];
  class CustomEvent {
    constructor(type, options) { this.type = type; this.detail = options.detail; }
  }
  const i18n = createDashboardI18n({
    localStorage: { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) },
    CustomEvent,
    dispatchEvent: event => events.push(event)
  }, {
    storageKey: 'demo-home-connect-dashboard-language-r9-fix1',
    eventName: 'demo-home-connect-language-changed-r9-fix1'
  });
  i18n.setLocale('de');
  assert.equal(values.get('demo-home-connect-dashboard-language-r9-fix1'), 'de');
  assert.equal(values.has('home-connect-dashboard-language'), false);
  assert.equal(events[0].type, 'demo-home-connect-language-changed-r9-fix1');
});
