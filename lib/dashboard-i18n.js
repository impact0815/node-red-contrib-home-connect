'use strict';

function createDashboardI18n(environment = {}, options = {}) {
  const STORAGE_KEY = options.storageKey || 'home-connect-dashboard-language';
  const EVENT_NAME = options.eventName || 'home-connect-language-changed';
  const supported = ['de', 'en'];

  const labels = {
    de: {
      overview: 'Übersicht', applianceDetails: 'Gerätedetails', connection: 'Verbindung', status: 'Status', door: 'Tür', active: 'Aktiv',
      selected: 'Ausgewählt', remaining: 'Restzeit', localProfileReadOnly: 'Lokale Profilwerte · nur lesend', remoteControl: 'Fernsteuerung',
      remoteStart: 'Fernstart', localControl: 'Lokale Bedienung', currentOptions: 'Aktuelle Optionen', availablePrograms: 'Verfügbare Programme',
      program: 'Programm', targetTemperature: 'Solltemperatur', temperature: 'Temperatur', refresh: 'Aktualisieren', start: 'Start', stop: 'Stopp',
      openDetails: 'Details öffnen', backToOverview: 'Zur Übersicht', lastKnownState: 'letzter bekannter Stand', remoteStartUnavailable: 'Fernstart ist aktuell nicht verfügbar.',
      language: 'Sprache', german: 'Deutsch', english: 'Englisch', online: 'online', offline: 'offline', yes: 'Ja', no: 'Nein',
      unavailable: '—', unknownValue: 'Unbekannter Wert', rawValue: 'Rohwert', unknownWarning: 'Unbekannter Hinweis',
      readOnly: 'nur lesend', simulated: 'SIMULIERT', simulatedValues: 'Simulierte Beispielwerte · nur Anzeige'
    },
    en: {
      overview: 'Overview', applianceDetails: 'Appliance details', connection: 'Connection', status: 'Status', door: 'Door', active: 'Active',
      selected: 'Selected', remaining: 'Remaining', localProfileReadOnly: 'Local profile values · read-only', remoteControl: 'Remote control',
      remoteStart: 'Remote start', localControl: 'Local control', currentOptions: 'Current options', availablePrograms: 'Available programs',
      program: 'Program', targetTemperature: 'Target temperature', temperature: 'Temperature', refresh: 'Refresh', start: 'Start', stop: 'Stop',
      openDetails: 'Open details', backToOverview: 'Back to overview', lastKnownState: 'last known state', remoteStartUnavailable: 'Remote start is currently unavailable.',
      language: 'Language', german: 'German', english: 'English', online: 'online', offline: 'offline', yes: 'Yes', no: 'No',
      unavailable: '—', unknownValue: 'Unknown value', rawValue: 'raw value', unknownWarning: 'Unknown notice',
      readOnly: 'read-only', simulated: 'SIMULATED', simulatedValues: 'Simulated example values · display only'
    }
  };

  const healthNames = {
    ok: { de: 'OK', en: 'OK' }, running: { de: 'Läuft', en: 'Running' }, info: { de: 'Info', en: 'Info' },
    warning: { de: 'Warnung', en: 'Warning' }, action_required: { de: 'Aktion nötig', en: 'Action required' },
    offline: { de: 'Offline', en: 'Offline' }, error: { de: 'Fehler', en: 'Error' }
  };

  const deviceTypes = {
    Dishwasher: { de: 'Geschirrspüler', en: 'Dishwasher' }, Washer: { de: 'Waschmaschine', en: 'Washer' },
    Oven: { de: 'Backofen', en: 'Oven' }, Dryer: { de: 'Trockner', en: 'Dryer' },
    WasherDryer: { de: 'Waschtrockner', en: 'Washer-dryer' }, Refrigerator: { de: 'Kühlschrank', en: 'Refrigerator' },
    Freezer: { de: 'Gefrierschrank', en: 'Freezer' }, FridgeFreezer: { de: 'Kühl-Gefrier-Kombination', en: 'Fridge-freezer' },
    CoffeeMaker: { de: 'Kaffeevollautomat', en: 'Coffee maker' }, Hood: { de: 'Dunstabzugshaube', en: 'Hood' },
    Hob: { de: 'Kochfeld', en: 'Hob' }
  };

  const valueNames = {
    Inactive: { de: 'Inaktiv', en: 'Inactive' }, Ready: { de: 'Bereit', en: 'Ready' }, Run: { de: 'Läuft', en: 'Running' },
    Finished: { de: 'Beendet', en: 'Finished' }, DelayedStart: { de: 'Startzeitvorwahl', en: 'Delayed start' },
    Pause: { de: 'Pausiert', en: 'Paused' }, Paused: { de: 'Pausiert', en: 'Paused' },
    ActionRequired: { de: 'Aktion erforderlich', en: 'Action required' }, Aborting: { de: 'Wird abgebrochen', en: 'Aborting' },
    Error: { de: 'Fehler', en: 'Error' }, Open: { de: 'Offen', en: 'Open' }, Closed: { de: 'Geschlossen', en: 'Closed' },
    Locked: { de: 'Verriegelt', en: 'Locked' }, On: { de: 'Ein', en: 'On' }, Off: { de: 'Aus', en: 'Off' },
    Standby: { de: 'Standby', en: 'Standby' }, Present: { de: 'Vorhanden', en: 'Present' }, Absent: { de: 'Nicht vorhanden', en: 'Absent' },
    Confirmed: { de: 'Bestätigt', en: 'Confirmed' }, Enabled: { de: 'Aktiviert', en: 'Enabled' }, Disabled: { de: 'Deaktiviert', en: 'Disabled' },
    Cleaning: { de: 'Reinigen', en: 'Cleaning' }, Rinsing: { de: 'Spülen', en: 'Rinsing' }, Drying: { de: 'Trocknen', en: 'Drying' },
    PreWash: { de: 'Vorspülen', en: 'Pre-wash' }, MainWash: { de: 'Hauptspülen', en: 'Main wash' },
    Heating: { de: 'Aufheizen', en: 'Heating' }, Cooling: { de: 'Abkühlen', en: 'Cooling' },
    DE: { de: 'Deutsch', en: 'German' }, EN: { de: 'Englisch', en: 'English' }
  };

  const displayNames = {
    ProgramProgress: { de: 'Programmfortschritt', en: 'Program progress' }, RemainingProgramTime: { de: 'Restzeit', en: 'Remaining program time' },
    EnergyForecast: { de: 'Energieprognose', en: 'Energy forecast' }, WaterForecast: { de: 'Wasserprognose', en: 'Water forecast' },
    StartInRelative: { de: 'Start in', en: 'Start in' }, Duration: { de: 'Dauer', en: 'Duration' },
    RemoteControlActive: { de: 'Fernsteuerung aktiv', en: 'Remote control active' },
    RemoteControlStartAllowed: { de: 'Fernstart erlaubt', en: 'Remote start allowed' }, LocalControlActive: { de: 'Lokale Bedienung aktiv', en: 'Local control active' },
    OperationState: { de: 'Betriebszustand', en: 'Operation state' }, DoorState: { de: 'Türzustand', en: 'Door state' },
    PowerState: { de: 'Betriebsart', en: 'Power state' }, ProgramPhase: { de: 'Programmphase', en: 'Program phase' },
    Language: { de: 'Sprache', en: 'Language' }, SaltNearlyEmpty: { de: 'Salz fast leer', en: 'Salt nearly empty' },
    RinseAidNearlyEmpty: { de: 'Klarspüler fast leer', en: 'Rinse aid nearly empty' },
    HygienePlus: { de: 'Hygiene Plus', en: 'Hygiene Plus' }, IntensivZone: { de: 'Intensivzone', en: 'Intensive zone' },
    VarioSpeedPlus: { de: 'varioSpeed Plus', en: 'varioSpeed Plus' }, BrillianceDry: { de: 'Glanztrocknen', en: 'Brilliance dry' },
    ExtraDry: { de: 'Extra trocknen', en: 'Extra dry' }, HalfLoad: { de: 'Halbe Beladung', en: 'Half load' },
    SilenceOnDemand: { de: 'Leisebetrieb', en: 'Silence on demand' }, Temperature: { de: 'Temperatur', en: 'Temperature' },
    SpinSpeed: { de: 'Schleuderdrehzahl', en: 'Spin speed' }, Stains: { de: 'Flecken', en: 'Stains' },
    SetpointTemperature: { de: 'Solltemperatur', en: 'Target temperature' }, FastPreHeat: { de: 'Schnellaufheizen', en: 'Fast preheat' },
    AddedSteam: { de: 'Dampfzugabe', en: 'Added steam' },

    Intensiv70: { de: 'Intensiv 70 °C', en: 'Intensive 70 °C' }, Auto2: { de: 'Automatik 45–65 °C', en: 'Auto 45–65 °C' },
    Eco50: { de: 'Eco 50 °C', en: 'Eco 50 °C' }, Glas40: { de: 'Glas 40 °C', en: 'Glass 40 °C' },
    Quick45: { de: 'Kurz 45 °C', en: 'Quick 45 °C' }, PreRinse: { de: 'Vorspülen', en: 'Pre-rinse' },
    MachineCare: { de: 'Maschinenpflege', en: 'Machine care' },
    Cotton: { de: 'Baumwolle', en: 'Cotton' }, EasyCare: { de: 'Pflegeleicht', en: 'Easy-care' }, Mix: { de: 'Mix', en: 'Mix' },
    DelicatesSilk: { de: 'Fein/Seide', en: 'Delicates/Silk' }, Wool: { de: 'Wolle', en: 'Wool' }, DarkWash: { de: 'Dunkle Wäsche', en: 'Dark wash' },
    ShirtsBlouses: { de: 'Hemden/Blusen', en: 'Shirts/Blouses' }, Curtains: { de: 'Gardinen', en: 'Curtains' }, Super15: { de: 'Super 15', en: 'Super 15' },
    Dessous: { de: 'Dessous', en: 'Lingerie' }, Outdoor: { de: 'Outdoor', en: 'Outdoor' }, Sensitive: { de: 'Sensitiv', en: 'Sensitive' },
    DrumClean: { de: 'Trommel reinigen', en: 'Drum clean' }, Rinse: { de: 'Spülen', en: 'Rinse' }, Spin: { de: 'Schleudern', en: 'Spin' },
    Drain: { de: 'Abpumpen', en: 'Drain' }, NightWash: { de: 'Nachtwäsche', en: 'Night wash' }, CottonEco: { de: 'Baumwolle Eco', en: 'Cotton Eco' },
    Memory1: { de: 'Favorit 1', en: 'Memory 1' }, JustStart: { de: 'Nur Start', en: 'Just start' },
    HotAir: { de: 'Heißluft', en: 'Hot air' }, TopBottomHeating: { de: 'Ober-/Unterhitze', en: 'Top/bottom heat' },
    PreHeating: { de: 'Vorheizen', en: 'Preheating' }, HotAirEco: { de: 'Heißluft Eco', en: 'Hot air Eco' },
    TopBottomHeatingEco: { de: 'Ober-/Unterhitze Eco', en: 'Top/bottom heat Eco' }, HotAirGrilling: { de: 'Umluftgrill', en: 'Hot-air grilling' },
    PizzaSetting: { de: 'Pizzastufe', en: 'Pizza setting' }, IntensiveHeat: { de: 'Intensivhitze', en: 'Intensive heat' },
    GrillLargeArea: { de: 'Großflächengrill', en: 'Large-area grill' }, GrillSmallArea: { de: 'Kleinflächengrill', en: 'Small-area grill' },
    SlowCook: { de: 'Sanftgaren', en: 'Slow cook' }, BottomHeating: { de: 'Unterhitze', en: 'Bottom heat' },
    KeepWarm: { de: 'Warmhalten', en: 'Keep warm' }, PreheatOvenware: { de: 'Geschirr vorwärmen', en: 'Preheat ovenware' },
    FrozenHeatupSpecial: { de: 'Tiefkühl-Spezial', en: 'Frozen food special' }, SabbathProgramme: { de: 'Sabbatprogramm', en: 'Sabbath program' },
    Steam: { de: 'Dampf', en: 'Steam' }, Reheat: { de: 'Aufwärmen', en: 'Reheat' }, DoughProving: { de: 'Gärstufe', en: 'Dough proving' },
    Defrosting: { de: 'Auftauen', en: 'Defrosting' }, Ecolysis: { de: 'Ecolyse', en: 'Ecolysis' }, Descale: { de: 'Entkalken', en: 'Descale' },
    Flushing: { de: 'Spülen', en: 'Flushing' }, Draining: { de: 'Abpumpen', en: 'Draining' }, SubsequentCooking: { de: 'Nachgaren', en: 'Subsequent cooking' },
    KuchenInFormen: { de: 'Kuchen in Formen', en: 'Cakes in tins' }, KuchenAufBackblech: { de: 'Kuchen auf Backblech', en: 'Tray-baked cakes' },
    Strudel: { de: 'Strudel', en: 'Strudel' }, Pavlova: { de: 'Pavlova', en: 'Pavlova' }, WaeheOderTart: { de: 'Wähe/Tarte', en: 'Flan/Tart' },
    Blaetterteiggebaeck: { de: 'Blätterteiggebäck', en: 'Puff pastry' }, Brandteiggebaeck: { de: 'Brandteiggebäck', en: 'Choux pastry' },
    Muffins: { de: 'Muffins', en: 'Muffins' }, Plundergebaeck: { de: 'Plundergebäck', en: 'Danish pastry' },
    Hefeteiggebaeck: { de: 'Hefeteiggebäck', en: 'Yeast pastries' }, Muerbeteiggebaeck: { de: 'Mürbeteiggebäck', en: 'Shortcrust pastry' },
    Baiser: { de: 'Baiser', en: 'Meringue' }, Makronen: { de: 'Makronen', en: 'Macaroons' }, Spritzgebaeck: { de: 'Spritzgebäck', en: 'Spritz biscuits' },
    Plaetzchen: { de: 'Plätzchen', en: 'Biscuits' }, Vollkornbrot: { de: 'Vollkornbrot', en: 'Wholegrain bread' },
    WeizenbrotWeizenmischbrotAufBackblech: { de: 'Weizen-/Weizenmischbrot auf Backblech', en: 'Wheat/mixed-wheat bread on tray' }
  };

  function unwrap(value) {
    if (value && typeof value === 'object' && Object.hasOwn(value, 'value')) return value.value;
    return value;
  }

  function normalizeLocale(value) {
    const text = String(unwrap(value) || '').trim().toLowerCase().replace('_', '-');
    if (text === 'de' || text.startsWith('de-')) return 'de';
    if (text === 'en' || text.startsWith('en-')) return 'en';
    return '';
  }

  function readStoredLocale() {
    try { return normalizeLocale(environment.localStorage?.getItem(STORAGE_KEY)); }
    catch { return ''; }
  }

  function detectLocale(component, message) {
    const msg = message || component?.msg || {};
    const candidates = [
      msg.uiLocale, msg.locale, readStoredLocale(), component?.$i18n?.locale, component?.$vuetify?.locale?.current,
      environment.document?.documentElement?.lang, ...(environment.navigator?.languages || []), environment.navigator?.language
    ];
    for (const candidate of candidates) {
      const locale = normalizeLocale(candidate);
      if (locale) return locale;
    }
    return 'en';
  }

  function setLocale(value, notify = true) {
    const locale = normalizeLocale(value) || 'en';
    try { environment.localStorage?.setItem(STORAGE_KEY, locale); }
    catch { /* Storage can be blocked by browser policy. */ }
    if (notify) {
      try { environment.dispatchEvent?.(new environment.CustomEvent(EVENT_NAME, { detail: { locale } })); }
      catch { /* CustomEvent may be unavailable in non-browser tests. */ }
    }
    return locale;
  }

  function t(key, locale) {
    const lang = normalizeLocale(locale) || 'en';
    return labels[lang][key] ?? labels.en[key] ?? key;
  }

  function token(value) {
    return String(value ?? '').split('.').pop();
  }

  function humanize(value) {
    const leaf = token(value)
      .replace(/[_-]+/g, ' ')
      .replace(/([a-zäöüß])([A-Z])/g, '$1 $2')
      .replace(/([A-Za-z])([0-9])/g, '$1 $2')
      .replace(/([0-9])([A-Za-z])/g, '$1 $2')
      .replace(/\s+/g, ' ')
      .trim();
    return leaf || '—';
  }

  function localized(entry, locale) {
    const lang = normalizeLocale(locale) || 'en';
    return entry?.[lang] ?? entry?.en;
  }

  function deviceType(value, locale) {
    const leaf = token(value);
    const known = localized(deviceTypes[leaf], locale);
    if (known) return known;
    if (!leaf) return t('unavailable', locale);
    const prefix = normalizeLocale(locale) === 'de' ? 'Gerätetyp' : 'Appliance type';
    return `${prefix}: ${humanize(leaf)}`;
  }

  function displayKey(value, locale) {
    const leaf = token(value);
    return localized(displayNames[leaf], locale) || localized(valueNames[leaf], locale) || humanize(leaf);
  }

  function displayName(value, locale) {
    const source = value && typeof value === 'object' ? (value.key || value.name) : value;
    if (source === undefined || source === null || source === '' || source === '—') return t('unavailable', locale);
    const leaf = token(source);
    const known = localized(displayNames[leaf], locale) || localized(valueNames[leaf], locale);
    if (known) return known;
    const fallbackSource = value && typeof value === 'object' && value.name && !String(value.name).includes('.') ? value.name : leaf;
    return humanize(fallbackSource);
  }

  function unknown(rawValue, locale) {
    const printable = rawValue === undefined ? '?' : String(rawValue);
    return `${t('unknownValue', locale)} (${t('rawValue', locale)}: ${printable})`;
  }

  function semantic(item, locale) {
    if (!item) return t('unavailable', locale);
    if (item.valueResolved === false) return unknown(item.rawValue, locale);
    const value = item.value;
    if (value === undefined || value === null || value === '') return t('unavailable', locale);
    if (value === true) return t('yes', locale);
    if (value === false) return t('no', locale);
    if (typeof value === 'number') return new Intl.NumberFormat(normalizeLocale(locale) === 'de' ? 'de-DE' : 'en-US').format(value);
    return displayName(value, locale);
  }

  function booleanText(item, locale) {
    return semantic(item, locale);
  }

  function healthLabel(value, locale) {
    return localized(healthNames[value], locale) || humanize(value);
  }

  function warningText(value, locale) {
    if (!value) return '';
    const lang = normalizeLocale(locale) || 'en';
    return value.text?.[lang] || value.text?.en || value.text?.de || `${t('unknownWarning', lang)} (${value.code || '?'})`;
  }

  function remaining(model, locale) {
    const value = model?.remaining;
    const item = model?.remainingItem;
    if (value === undefined || value === null || value === '') return t('unavailable', locale);
    if (item?.valueResolved === false) return unknown(item.rawValue, locale);
    const number = Number(value);
    if (!Number.isFinite(number)) return String(value);
    const unit = String(item?.unit || '').toLowerCase();
    if (unit.includes('min')) return `${Math.ceil(number)} min`;
    if (unit.includes('sec') || !model?.connection?.local) return `${Math.ceil(number / 60)} min`;
    const formatted = new Intl.NumberFormat(normalizeLocale(locale) === 'de' ? 'de-DE' : 'en-US').format(number);
    return item?.unit ? `${formatted} ${item.unit}` : formatted;
  }

  function programItems(programs, locale) {
    return (Array.isArray(programs) ? programs : []).map(item => ({ ...item, title: displayName(item, locale) }));
  }

  return {
    STORAGE_KEY, EVENT_NAME, supported, normalizeLocale, detectLocale, setLocale, t, token, humanize,
    deviceType, displayKey, displayName, semantic, booleanText, healthLabel, warningText, remaining, programItems
  };
}

module.exports = { createDashboardI18n };
