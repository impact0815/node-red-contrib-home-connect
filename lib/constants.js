'use strict';

const API_MEDIA_TYPE = 'application/vnd.bsh.sdk.v1+json';
const DEFAULT_SCOPE = 'IdentifyAppliance';

const ENVIRONMENTS = Object.freeze({
  production: 'https://api.home-connect.com',
  china: 'https://api.home-connect.cn',
  'official-simulator': 'https://simulator.home-connect.com'
});

const READ_OPERATIONS = Object.freeze([
  'snapshot',
  'capabilities',
  'appliances',
  'appliance',
  'status',
  'status-item',
  'settings',
  'setting',
  'all-programs',
  'programs',
  'program',
  'active-program',
  'active-options',
  'active-option',
  'selected-program',
  'selected-options',
  'selected-option',
  'commands',
  'images',
  'image',
  'maps',
  'map',
  'map-occupancy-grid',
  'map-layout',
  'map-cleaning-status',
  'map-detected-objects',
  'map-detected-object',
  'map-rooms',
  'map-room',
  'map-zones',
  'map-zone',
  'map-robot-position',
  'map-config-restrictions',
  'map-cleaning-summaries',
  'map-cleaning-summary'
]);

const WRITE_ACTIONS = Object.freeze([
  'start-program',
  'stop-program',
  'select-program',
  'set-setting',
  'command',
  'set-active-option',
  'set-selected-option'
]);

module.exports = {
  API_MEDIA_TYPE,
  DEFAULT_SCOPE,
  ENVIRONMENTS,
  READ_OPERATIONS,
  WRITE_ACTIONS
};
