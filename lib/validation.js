'use strict';

const { HomeConnectError } = require('./errors');
const { WRITE_ACTIONS } = require('./constants');

function constraintsOf(item) {
  return (item && item.constraints) || {};
}

function assertType(value, type, label) {
  if (!type) return;
  const normalized = String(type).toLowerCase();
  let valid = true;
  if (normalized === 'boolean') valid = typeof value === 'boolean';
  else if (['integer', 'int'].includes(normalized)) valid = Number.isInteger(value);
  else if (['double', 'float', 'number'].includes(normalized)) valid = typeof value === 'number' && Number.isFinite(value);
  else if (normalized === 'string') valid = typeof value === 'string';
  if (!valid) {
    throw new HomeConnectError(`${label} must have type ${type}.`, {
      code: 'VALUE_INVALID_TYPE', details: { value, expectedType: type }
    });
  }
}

function assertValue(value, constraints, label, type) {
  if (value === undefined) {
    throw new HomeConnectError(`${label} requires a value.`, { code: 'VALUE_REQUIRED' });
  }
  assertType(value, type, label);
  const c = constraints || {};
  const allowed = c.allowedvalues || c.allowedValues;
  if (Array.isArray(allowed) && !allowed.includes(value)) {
    throw new HomeConnectError(`${label} must be one of: ${allowed.join(', ')}`, {
      code: 'VALUE_NOT_ALLOWED', details: { value, allowed }
    });
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new HomeConnectError(`${label} must be a finite number.`, { code: 'VALUE_INVALID_TYPE' });
    }
    if (Number.isFinite(c.min) && value < c.min) {
      throw new HomeConnectError(`${label} must be >= ${c.min}`, { code: 'VALUE_BELOW_MINIMUM' });
    }
    if (Number.isFinite(c.max) && value > c.max) {
      throw new HomeConnectError(`${label} must be <= ${c.max}`, { code: 'VALUE_ABOVE_MAXIMUM' });
    }
    const step = c.stepsize ?? c.stepSize;
    if (Number.isFinite(step) && step > 0) {
      const origin = Number.isFinite(c.min) ? c.min : 0;
      const quotient = (value - origin) / step;
      if (Math.abs(quotient - Math.round(quotient)) > 1e-8) {
        throw new HomeConnectError(`${label} must follow step size ${step}`, { code: 'VALUE_INVALID_STEP' });
      }
    }
  }
}

function assertWritable(item, label) {
  const access = constraintsOf(item).access;
  if (access && String(access).toLowerCase() !== 'readwrite' && String(access).toLowerCase() !== 'write') {
    throw new HomeConnectError(`${label} is read-only.`, {
      code: 'RESOURCE_READ_ONLY', details: { access }
    });
  }
}

function mapItems(section) {
  const items = section && Array.isArray(section.items) ? section.items : [];
  return new Map(items.map(item => [item.key, item]));
}

function statusValue(capability, key) {
  return mapItems(capability.status).get(key)?.value;
}

function findProgram(capability, key) {
  const programs = capability.programs && Array.isArray(capability.programs.available)
    ? capability.programs.available : [];
  return programs.find(program => program.key === key);
}

function assertConnected(capability) {
  if (capability.appliance?.connected === false) {
    throw new HomeConnectError('The appliance is offline.', { code: 'APPLIANCE_OFFLINE' });
  }
}

function assertStartPreconditions(capability) {
  assertConnected(capability);
  const remote = statusValue(capability, 'BSH.Common.Status.RemoteControlActive');
  const startAllowed = statusValue(capability, 'BSH.Common.Status.RemoteControlStartAllowed');
  const local = statusValue(capability, 'BSH.Common.Status.LocalControlActive');
  const operation = statusValue(capability, 'BSH.Common.Status.OperationState');
  if (remote === false) throw new HomeConnectError('Remote control is disabled on the appliance.', { code: 'REMOTE_CONTROL_DISABLED' });
  if (startAllowed === false) throw new HomeConnectError('Remote start is not allowed by the appliance.', { code: 'REMOTE_START_DISABLED' });
  if (local === true) throw new HomeConnectError('Local control is currently active.', { code: 'LOCAL_CONTROL_ACTIVE' });
  const readyStates = [
    'BSH.Common.EnumType.OperationState.Ready',
    'BSH.Common.EnumType.OperationState.Inactive',
    'BSH.Common.EnumType.OperationState.Finished'
  ];
  if (operation && !readyStates.includes(operation)) {
    throw new HomeConnectError(`Appliance is not ready (state: ${operation}).`, { code: 'APPLIANCE_NOT_READY' });
  }
  if (capability.programs?.active) {
    throw new HomeConnectError('Another program is already active.', { code: 'PROGRAM_ALREADY_ACTIVE' });
  }
}

function validateOptions(definitions, supplied, context) {
  if (!Array.isArray(supplied)) {
    throw new HomeConnectError('options must be an array.', { code: 'INVALID_OPTIONS' });
  }
  const available = new Map((definitions || []).map(option => [option.key, option]));
  const seen = new Set();
  for (const option of supplied) {
    if (!option || typeof option.key !== 'string' || !option.key) {
      throw new HomeConnectError('Every option requires a non-empty key.', { code: 'OPTION_KEY_REQUIRED' });
    }
    if (seen.has(option.key)) {
      throw new HomeConnectError(`Option occurs more than once: ${option.key}`, { code: 'OPTION_DUPLICATE' });
    }
    seen.add(option.key);
    const definition = available.get(option.key);
    if (!definition) {
      throw new HomeConnectError(`Option is not available for ${context}: ${option.key}`, { code: 'OPTION_NOT_AVAILABLE' });
    }
    assertWritable(definition, option.key);
    assertValue(option.value, constraintsOf(definition), option.key, definition.type);
  }
}

function validateWrite(capability, request) {
  if (!capability || !capability.appliance) {
    throw new HomeConnectError('No capability information is available for this appliance.', { code: 'CAPABILITIES_MISSING' });
  }
  if (!request || !WRITE_ACTIONS.includes(request.action)) {
    throw new HomeConnectError(`Unsupported write action: ${request?.action}`, { code: 'WRITE_ACTION_NOT_ALLOWED' });
  }

  if (request.action === 'start-program' || request.action === 'select-program') {
    if (request.action === 'start-program') assertStartPreconditions(capability);
    else assertConnected(capability);
    const program = findProgram(capability, request.program);
    if (!program) throw new HomeConnectError(`Program is not available: ${request.program}`, { code: 'PROGRAM_NOT_AVAILABLE' });
    assertWritable(program, request.program);
    validateOptions(program.options, request.options || [], request.program);
    return;
  }

  assertConnected(capability);

  if (request.action === 'stop-program') {
    if (!capability.programs?.active) {
      throw new HomeConnectError('No program is active.', { code: 'NO_ACTIVE_PROGRAM' });
    }
    return;
  }

  if (request.action === 'set-setting') {
    const setting = mapItems(capability.settings).get(request.key);
    if (!setting) throw new HomeConnectError(`Setting is not available: ${request.key}`, { code: 'SETTING_NOT_AVAILABLE' });
    assertWritable(setting, request.key);
    assertValue(request.value, constraintsOf(setting), request.key, setting.type);
    return;
  }

  if (request.action === 'command') {
    const command = mapItems(capability.commands).get(request.key);
    if (!command) throw new HomeConnectError(`Command is not available: ${request.key}`, { code: 'COMMAND_NOT_AVAILABLE' });
    assertWritable(command, request.key);
    assertValue(request.value, constraintsOf(command), request.key, command.type);
    return;
  }

  const selected = request.action === 'set-selected-option';
  const program = selected ? capability.programs?.selected : capability.programs?.active;
  if (!program) {
    throw new HomeConnectError(`No ${selected ? 'selected' : 'active'} program is available.`, {
      code: selected ? 'NO_SELECTED_PROGRAM' : 'NO_ACTIVE_PROGRAM'
    });
  }
  validateOptions(program.options, [{ key: request.key, value: request.value }], program.key);
}

module.exports = {
  assertType,
  assertValue,
  assertWritable,
  validateOptions,
  validateWrite,
  statusValue,
  findProgram
};
