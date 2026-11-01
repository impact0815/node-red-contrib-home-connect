'use strict';

const TYPE_NAMES = Object.freeze({
  Dishwasher: { de: 'Geschirrspüler', en: 'Dishwasher' },
  Washer: { de: 'Waschmaschine', en: 'Washer' },
  Oven: { de: 'Backofen', en: 'Oven' }
});

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function shortTechnicalId(value, visible = 4) {
  const id = text(value);
  if (!id) return '';
  return `…${id.slice(-Math.max(4, Number(visible) || 4))}`;
}

function applianceModel(appliance = {}) {
  const value = text(appliance.model || appliance.vib || appliance.eNumber || appliance.enumber);
  return value ? value.split('/')[0] : '';
}

function formatDeviceLabel(appliance = {}, language = 'de') {
  const type = text(appliance.type || appliance.applianceType || appliance.deviceType) || 'Appliance';
  const localizedType = TYPE_NAMES[type]?.[String(language).toLowerCase().startsWith('de') ? 'de' : 'en'] || '';
  const name = text(appliance.name || appliance.displayName);
  const brand = text(appliance.brand);
  const model = applianceModel(appliance);
  const brandModel = [brand, model].filter(Boolean).join(' ');
  const id = shortTechnicalId(appliance.haId || appliance.id || appliance.identifier);
  const parts = [type];
  for (const value of [name || localizedType, brandModel, id]) {
    if (value && !parts.some(part => part.toLowerCase() === value.toLowerCase())) parts.push(value);
  }
  return parts.join(' — ');
}

module.exports = { TYPE_NAMES, applianceModel, formatDeviceLabel, shortTechnicalId };