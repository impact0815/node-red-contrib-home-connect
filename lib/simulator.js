'use strict';

const { EventEmitter } = require('node:events');
const { validateWrite } = require('./validation');
const { HomeConnectError } = require('./errors');

const clone = value => value == null ? value : structuredClone(value);
const item = (key, value, extra = {}) => ({ key, value, ...extra });
const bool = allowed => ({ type: 'Boolean', constraints: { allowedvalues: allowed } });

function makeDevices() {
  return [
    {
      appliance: { haId: 'dishwasher-001', name: 'Geschirrspülmaschine', type: 'Dishwasher', brand: 'Bosch', vib: 'SIM-DW-001', connected: true },
      status: { items: [
        item('BSH.Common.Status.RemoteControlActive', true),
        item('BSH.Common.Status.RemoteControlStartAllowed', true),
        item('BSH.Common.Status.LocalControlActive', false),
        item('BSH.Common.Status.OperationState', 'BSH.Common.EnumType.OperationState.Ready'),
        item('BSH.Common.Status.DoorState', 'BSH.Common.EnumType.DoorState.Closed')
      ] },
      settings: { items: [item('BSH.Common.Setting.PowerState', 'BSH.Common.EnumType.PowerState.On', { constraints: { allowedvalues: ['BSH.Common.EnumType.PowerState.On', 'BSH.Common.EnumType.PowerState.Standby'] } })] },
      programs: { available: [
        { key: 'Dishcare.Dishwasher.Program.Eco50', name: 'Eco 50 °C', options: [
          item('BSH.Common.Option.StartInRelative', 0, { unit: 'seconds', constraints: { min: 0, max: 86400, stepsize: 60, default: 0 } }),
          item('Dishcare.Dishwasher.Option.VarioSpeedPlus', false, bool([true, false])),
          item('Dishcare.Dishwasher.Option.IntensivZone', false, bool([true, false]))
        ] },
        { key: 'Dishcare.Dishwasher.Program.Auto2', name: 'Auto 45–65 °C', options: [item('Dishcare.Dishwasher.Option.VarioSpeedPlus', false, bool([true, false]))] },
        { key: 'Dishcare.Dishwasher.Program.Intensiv70', name: 'Intensiv 70 °C', options: [item('Dishcare.Dishwasher.Option.IntensivZone', true, bool([true, false]))] }
      ], active: null, selected: null },
      commands: { items: [
        item('BSH.Common.Command.PauseProgram', true, bool([true])),
        item('BSH.Common.Command.ResumeProgram', true, bool([true]))
      ] }
    },
    {
      appliance: { haId: 'washer-001', name: 'Waschmaschine', type: 'Washer', brand: 'Siemens', vib: 'SIM-WM-001', connected: true },
      status: { items: [
        item('BSH.Common.Status.RemoteControlActive', true), item('BSH.Common.Status.RemoteControlStartAllowed', true),
        item('BSH.Common.Status.LocalControlActive', false), item('BSH.Common.Status.OperationState', 'BSH.Common.EnumType.OperationState.Ready'),
        item('BSH.Common.Status.DoorState', 'BSH.Common.EnumType.DoorState.Closed')
      ] },
      settings: { items: [item('BSH.Common.Setting.PowerState', 'BSH.Common.EnumType.PowerState.On', { constraints: { allowedvalues: ['BSH.Common.EnumType.PowerState.On', 'BSH.Common.EnumType.PowerState.Standby'] } })] },
      programs: { available: [
        { key: 'LaundryCare.Washer.Program.Cotton', name: 'Baumwolle', options: [
          item('LaundryCare.Washer.Option.Temperature', 'LaundryCare.Washer.EnumType.Temperature.GC40', { constraints: { allowedvalues: ['LaundryCare.Washer.EnumType.Temperature.GC30', 'LaundryCare.Washer.EnumType.Temperature.GC40', 'LaundryCare.Washer.EnumType.Temperature.GC60'] } }),
          item('LaundryCare.Washer.Option.SpinSpeed', 'LaundryCare.Washer.EnumType.SpinSpeed.RPM1400', { constraints: { allowedvalues: ['LaundryCare.Washer.EnumType.SpinSpeed.RPM800', 'LaundryCare.Washer.EnumType.SpinSpeed.RPM1200', 'LaundryCare.Washer.EnumType.SpinSpeed.RPM1400'] } })
        ] },
        { key: 'LaundryCare.Washer.Program.EasyCare', name: 'Pflegeleicht', options: [] },
        { key: 'LaundryCare.Washer.Program.Mix', name: 'Mix', options: [] }
      ], active: null, selected: null },
      commands: { items: [item('BSH.Common.Command.PauseProgram', true, bool([true])), item('BSH.Common.Command.ResumeProgram', true, bool([true]))] }
    },
    {
      appliance: { haId: 'oven-001', name: 'Backofen', type: 'Oven', brand: 'Neff', vib: 'SIM-OV-001', connected: true },
      status: { items: [
        item('BSH.Common.Status.RemoteControlActive', true), item('BSH.Common.Status.RemoteControlStartAllowed', true),
        item('BSH.Common.Status.LocalControlActive', false), item('BSH.Common.Status.OperationState', 'BSH.Common.EnumType.OperationState.Ready'),
        item('BSH.Common.Status.DoorState', 'BSH.Common.EnumType.DoorState.Closed'),
        item('Cooking.Oven.Status.CurrentCavityTemperature', 22, { unit: '°C' })
      ] },
      settings: { items: [item('BSH.Common.Setting.PowerState', 'BSH.Common.EnumType.PowerState.On', { constraints: { allowedvalues: ['BSH.Common.EnumType.PowerState.On', 'BSH.Common.EnumType.PowerState.Standby'] } })] },
      programs: { available: [
        { key: 'Cooking.Oven.Program.HeatingMode.HotAir', name: 'Heißluft', options: [
          item('Cooking.Oven.Option.SetpointTemperature', 180, { unit: '°C', constraints: { min: 30, max: 250, stepsize: 5, default: 180 } }),
          item('BSH.Common.Option.Duration', 1800, { unit: 'seconds', constraints: { min: 60, max: 10800, stepsize: 60, default: 1800 } }),
          item('Cooking.Oven.Option.FastPreHeat', false, bool([true, false]))
        ] },
        { key: 'Cooking.Oven.Program.HeatingMode.TopBottomHeating', name: 'Ober-/Unterhitze', options: [item('Cooking.Oven.Option.SetpointTemperature', 180, { unit: '°C', constraints: { min: 30, max: 275, stepsize: 5, default: 180 } })] },
        { key: 'Cooking.Oven.Program.HeatingMode.PreHeating', name: 'Vorheizen', options: [item('Cooking.Oven.Option.SetpointTemperature', 200, { unit: '°C', constraints: { min: 50, max: 250, stepsize: 5, default: 200 } })] }
      ], active: null, selected: null },
      commands: { items: [item('BSH.Common.Command.PauseProgram', true, bool([true])), item('BSH.Common.Command.ResumeProgram', true, bool([true]))] }
    }
  ];
}

class BuiltinSimulator extends EventEmitter {
  constructor(options = {}) {
    super();
    this.language = options.language || 'de-DE';
    this.devices = new Map(makeDevices().map(device => [device.appliance.haId, device]));
    this.timers = new Map();
  }

  get environment() { return 'builtin-simulator'; }
  get requiresOAuth() { return false; }

  _device(haId) {
    const device = this.devices.get(haId);
    if (!device) throw new HomeConnectError(`Unknown simulated appliance: ${haId}`, { code: 'APPLIANCE_NOT_FOUND', status: 404 });
    return device;
  }

  _emit(haId, event, items) {
    const payload = { haId, event, data: { items: clone(items) }, simulated: true, timestamp: new Date().toISOString() };
    this.emit(`event:${haId}`, payload);
    this.emit('event:*', payload);
  }

  _setStatus(device, key, value, extra = {}) {
    const existing = device.status.items.find(entry => entry.key === key);
    if (existing) Object.assign(existing, { value, ...extra });
    else device.status.items.push(item(key, value, extra));
    this._emit(device.appliance.haId, 'STATUS', [item(key, value, extra)]);
  }

  async listHomeAppliances() { return clone(Array.from(this.devices.values(), device => device.appliance)); }
  async getHomeAppliance(haId) { return clone(this._device(haId).appliance); }
  async getStatus(haId) { return clone(this._device(haId).status); }
  async getStatusValue(haId, key) {
    const value = this._device(haId).status.items.find(entry => entry.key === key);
    if (!value) throw new HomeConnectError(`Status not found: ${key}`, { code: 'STATUS_NOT_AVAILABLE', status: 404 });
    return clone(value);
  }
  async getSettings(haId) { return clone(this._device(haId).settings); }
  async getSetting(haId, key) {
    const value = this._device(haId).settings.items.find(entry => entry.key === key);
    if (!value) throw new HomeConnectError(`Setting not found: ${key}`, { code: 'SETTING_NOT_AVAILABLE', status: 404 });
    return clone(value);
  }
  async getAllPrograms(haId) {
    const programs = this._device(haId).programs;
    return clone({ programs: programs.available, active: programs.active, selected: programs.selected });
  }
  async getAvailablePrograms(haId) { return { programs: clone(this._device(haId).programs.available.map(({ key, name }) => ({ key, name }))) }; }
  async getAvailableProgram(haId, key) {
    const program = this._device(haId).programs.available.find(entry => entry.key === key);
    if (!program) throw new HomeConnectError(`Program not found: ${key}`, { code: 'PROGRAM_NOT_AVAILABLE', status: 404 });
    return clone(program);
  }
  async getActiveProgram(haId) { return clone(this._device(haId).programs.active); }
  async getSelectedProgram(haId) { return clone(this._device(haId).programs.selected); }
  async getProgramOptions(haId, kind) {
    const program = this._device(haId).programs[kind];
    if (!program) throw new HomeConnectError(`No ${kind} program is available.`, { code: kind === 'active' ? 'NO_ACTIVE_PROGRAM' : 'NO_SELECTED_PROGRAM', status: 409 });
    return { options: clone(program.options || []) };
  }
  async getProgramOption(haId, kind, key) {
    const options = await this.getProgramOptions(haId, kind);
    const option = options.options.find(entry => entry.key === key);
    if (!option) throw new HomeConnectError(`Option not found: ${key}`, { code: 'OPTION_NOT_AVAILABLE', status: 404 });
    return clone(option);
  }
  async getCommands(haId) { return clone(this._device(haId).commands); }
  async getImages(haId) { this._device(haId); return { images: [] }; }
  async getImage(haId, imageKey) { this._device(haId); throw new HomeConnectError(`Image not found: ${imageKey}`, { code: 'IMAGE_NOT_AVAILABLE', status: 404 }); }
  async getMaps(haId) { this._device(haId); return []; }
  async getMap(haId, mapId) { this._device(haId); throw new HomeConnectError(`Map not found: ${mapId}`, { code: 'MAP_NOT_AVAILABLE', status: 404 }); }
  async getMapResource(haId, mapId) { return this.getMap(haId, mapId); }
  async getMapGlobalResource(haId, resource) { this._device(haId); throw new HomeConnectError(`Map resource not found: ${resource}`, { code: 'MAP_RESOURCE_NOT_AVAILABLE', status: 404 }); }

  async discoverAppliance(haId) {
    const device = this._device(haId);
    return clone({ ...device, discoveredAt: new Date().toISOString(), simulated: true });
  }

  async discoverAll() {
    return Promise.all(Array.from(this.devices.keys(), id => this.discoverAppliance(id)));
  }

  async read(haId, operation = 'snapshot', key, subKey) {
    if (operation === 'appliances') return this.listHomeAppliances();
    if (operation === 'snapshot' || operation === 'capabilities') return this.discoverAppliance(haId);
    if (operation === 'appliance') return this.getHomeAppliance(haId);
    if (operation === 'status') return this.getStatus(haId);
    if (operation === 'status-item') return this.getStatusValue(haId, key);
    if (operation === 'settings') return this.getSettings(haId);
    if (operation === 'setting') return this.getSetting(haId, key);
    if (operation === 'all-programs') return this.getAllPrograms(haId);
    if (operation === 'programs') return this.getAvailablePrograms(haId);
    if (operation === 'program') return this.getAvailableProgram(haId, key);
    if (operation === 'active-program') return this.getActiveProgram(haId);
    if (operation === 'active-options') return this.getProgramOptions(haId, 'active');
    if (operation === 'active-option') return this.getProgramOption(haId, 'active', key);
    if (operation === 'selected-program') return this.getSelectedProgram(haId);
    if (operation === 'selected-options') return this.getProgramOptions(haId, 'selected');
    if (operation === 'selected-option') return this.getProgramOption(haId, 'selected', key);
    if (operation === 'commands') return this.getCommands(haId);
    if (operation === 'images') return this.getImages(haId);
    if (operation === 'image') return this.getImage(haId, key);
    if (operation === 'maps') return this.getMaps(haId);
    if (operation === 'map') return this.getMap(haId, key);
    if (operation === 'map-occupancy-grid') return this.getMapResource(haId, key, 'occupancyGrid');
    if (operation === 'map-layout') return this.getMapResource(haId, key, 'layout');
    if (operation === 'map-cleaning-status') return this.getMapResource(haId, key, 'cleaningStatus');
    if (operation === 'map-detected-objects') return this.getMapResource(haId, key, 'cleaningStatus/objects');
    if (operation === 'map-detected-object') return this.getMapResource(haId, key, 'cleaningStatus/objects', subKey);
    if (operation === 'map-rooms') return this.getMapResource(haId, key, 'rooms');
    if (operation === 'map-room') return this.getMapResource(haId, key, 'rooms', subKey);
    if (operation === 'map-zones') return this.getMapResource(haId, key, 'zones');
    if (operation === 'map-zone') return this.getMapResource(haId, key, 'zones', subKey);
    if (operation === 'map-robot-position') return this.getMapGlobalResource(haId, 'robot/position');
    if (operation === 'map-config-restrictions') return this.getMapGlobalResource(haId, 'config/restrictions');
    if (operation === 'map-cleaning-summaries') return this.getMapGlobalResource(haId, 'cleaningSummary');
    if (operation === 'map-cleaning-summary') return this.getMapGlobalResource(haId, 'cleaningSummary', key);
    throw new HomeConnectError(`Unsupported read operation: ${operation}`, { code: 'READ_ACTION_NOT_ALLOWED' });
  }

  async write(request, capability) {
    const device = this._device(request.haId);
    const cap = capability || await this.discoverAppliance(request.haId);
    validateWrite(cap, request);
    if (request.action === 'set-setting') {
      const target = device.settings.items.find(entry => entry.key === request.key);
      target.value = request.value;
      this._emit(request.haId, 'NOTIFY', [clone(target)]);
    } else if (request.action === 'select-program') {
      const program = device.programs.available.find(entry => entry.key === request.program);
      const supplied = new Map((request.options || []).map(option => [option.key, option]));
      const options = (program.options || []).map(option => ({
        ...clone(option),
        value: supplied.get(option.key)?.value ?? option.constraints?.default ?? option.value
      }));
      device.programs.selected = { key: program.key, name: program.name, options };
      this._emit(request.haId, 'NOTIFY', [item('BSH.Common.Root.SelectedProgram', program.key)]);
    } else if (request.action === 'start-program') {
      const program = device.programs.available.find(entry => entry.key === request.program);
      const defaults = (program.options || []).map(option => ({
        ...clone(option), value: option.constraints?.default ?? option.value
      }));
      const supplied = new Map((request.options || []).map(option => [option.key, option]));
      const options = defaults.map(option => supplied.has(option.key)
        ? { ...option, value: supplied.get(option.key).value }
        : option);
      for (const option of request.options || []) if (!options.some(entry => entry.key === option.key)) options.push(option);
      device.programs.active = { key: program.key, name: program.name, options };
      device.programs.selected = clone(device.programs.active);
      this._setStatus(device, 'BSH.Common.Status.OperationState', 'BSH.Common.EnumType.OperationState.Run');
      const duration = options.find(option => option.key === 'BSH.Common.Option.Duration')?.value || 5400;
      this._startTimer(device, duration);
    } else if (request.action === 'stop-program') {
      this._stopTimer(request.haId);
      device.programs.active = null;
      this._setStatus(device, 'BSH.Common.Status.OperationState', 'BSH.Common.EnumType.OperationState.Ready');
    } else if (request.action === 'command') {
      this._emit(request.haId, 'EVENT', [item(request.key, request.value)]);
    } else if (request.action === 'set-active-option' || request.action === 'set-selected-option') {
      const kind = request.action === 'set-active-option' ? 'active' : 'selected';
      const program = device.programs[kind];
      const target = program.options.find(entry => entry.key === request.key);
      target.value = request.value;
      this._emit(request.haId, 'NOTIFY', [clone(target)]);
    }
    return { accepted: true, simulated: true, request: clone(request), at: new Date().toISOString() };
  }

  _startTimer(device, seconds) {
    this._stopTimer(device.appliance.haId);
    let remaining = seconds;
    this._setStatus(device, 'BSH.Common.Option.RemainingProgramTime', remaining, { unit: 'seconds' });
    const timer = setInterval(() => {
      remaining = Math.max(0, remaining - 60);
      this._setStatus(device, 'BSH.Common.Option.RemainingProgramTime', remaining, { unit: 'seconds' });
      if (device.appliance.type === 'Oven') {
        const target = device.programs.active?.options?.find(option => option.key === 'Cooking.Oven.Option.SetpointTemperature')?.value || 180;
        const current = device.status.items.find(entry => entry.key === 'Cooking.Oven.Status.CurrentCavityTemperature');
        const next = Math.min(target, (current?.value || 22) + 10);
        this._setStatus(device, 'Cooking.Oven.Status.CurrentCavityTemperature', next, { unit: '°C' });
        if (next === target) this._emit(device.appliance.haId, 'EVENT', [item('Cooking.Oven.Event.PreheatFinished', true)]);
      }
      if (remaining === 0) {
        this._stopTimer(device.appliance.haId);
        device.programs.active = null;
        this._setStatus(device, 'BSH.Common.Status.OperationState', 'BSH.Common.EnumType.OperationState.Finished');
      }
    }, 5000);
    timer.unref?.();
    this.timers.set(device.appliance.haId, timer);
  }

  _stopTimer(haId) {
    if (this.timers.has(haId)) clearInterval(this.timers.get(haId));
    this.timers.delete(haId);
  }

  openEvents(haId, onEvent) {
    const channel = `event:${haId || '*'}`;
    this.on(channel, onEvent);
    queueMicrotask(() => onEvent({ haId: haId || '*', event: 'CONNECTED', data: { items: [] }, simulated: true, timestamp: new Date().toISOString() }));
    return () => this.off(channel, onEvent);
  }

  close() {
    for (const id of this.timers.keys()) this._stopTimer(id);
    this.removeAllListeners();
  }
}

module.exports = { BuiltinSimulator, makeDevices };
