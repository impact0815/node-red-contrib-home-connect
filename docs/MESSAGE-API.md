# Message API

All functional nodes preserve unrelated incoming properties. Output 2 contains a structured error in `msg.payload`. Confirmation values are removed from success and error output.

## Normalized health envelope

Every functional output includes:

```js
msg.health = 'ok'; // ok | running | info | warning | action_required | offline | error
msg.warnings = [{
  source: 'status',       // status | event | connection | api | oauth
  code: 'HC_...',         // stable integration code
  severity: 'warning',    // info | warning | error | critical
  text: { de: '...', en: '...' },
  transient: false
}];
msg.homeConnect.health = msg.health;
msg.homeConnect.warnings = msg.warnings;
msg.homeConnect.healthSchema = 'home-connect-health/v1';
msg.homeConnect.healthAt = '...';
```

Snapshots and discovery entries also carry `payload.health`, `payload.warnings`, `payload.healthSchema`, and `payload.healthAt`. Raw API status and event values are retained. Transient notices are deduplicated and expire; disconnected/offline state remains until a later connection or snapshot confirms recovery. Errors are assessed for that error output and do not poison later successful messages.

## discover

```js
msg.haId = '...';   // single mode
msg.force = true;   // bypass five-minute capability cache
```

No real appliance ID, name, program or capability is built into the package. The editor's **Load devices** button and discovery output use the appliances returned by the connected account or protected local profiles. For local connections, Host/IP and the optional Auto/AES/TLS choice exist only in `home-connect-config`; Read and Events nodes store only a selected appliance/profile ID.

Documented appliance fields such as `name`, `brand`, `type`, `vib` and `connected` remain available under `appliance`. Firmware version/history/update is not part of the public API and has no message operation.

## read

```js
msg.haId = '...';
msg.operation = 'snapshot';
msg.key = '...';       // resource key, map ID or cleaning-summary counter
msg.subKey = '...';    // detected object, room or zone ID
```

Operations:

- `snapshot`, `capabilities`, `appliances`, `appliance`
- `status`, `status-item`, `settings`, `setting`
- `all-programs`, `programs`, `program`
- `active-program`, `active-options`, `active-option`
- `selected-program`, `selected-options`, `selected-option`
- `commands`, `images`, `image`
- `maps`, `map`, `map-occupancy-grid`, `map-layout`, `map-cleaning-status`
- `map-detected-objects`, `map-detected-object`, `map-rooms`, `map-room`, `map-zones`, `map-zone`
- `map-robot-position`, `map-config-restrictions`, `map-cleaning-summaries`, `map-cleaning-summary`

`image` returns:

```js
msg.payload = {
  contentType: 'image/jpeg',
  data: Buffer.from(/* JPEG bytes */)
};
```

The operation may select only a predefined resource; it cannot provide a URL or HTTP method. Local connections support appliance/snapshot/status/settings/program reads derived from `/ro/*` values. Cloud-only image/map operations return `LOCAL_READ_UNSUPPORTED` locally.

## events

An input message with `msg.haId` restarts the stream for that appliance. Use `*` for all configured appliances. The cloud client reconnects SSE with bounded exponential backoff and sends `Last-Event-ID` when supplied. The local client maintains per-appliance WebSockets and emits `STATUS`. Both emit synthetic `CONNECTED` and `DISCONNECTED` lifecycle events. Local event envelopes include `connection.local: true` and `connection.readOnly: true`.

## write

A request can be supplied in `msg.payload`; top-level `msg.haId`, `msg.action`, `msg.program`, `msg.key`, `msg.value` and `msg.options` take precedence.

### Start a program

```js
msg.payload = {
  action: 'start-program',
  haId: '...',
  program: 'Cooking.Oven.Program.HeatingMode.HotAir',
  options: [{ key: 'Cooking.Oven.Option.SetpointTemperature', value: 180 }],
  confirm: 'CONFIRM'
};
```

### Other actions

```js
msg.payload = { action: 'stop-program', haId: '...', confirm: 'CONFIRM' };
msg.payload = { action: 'select-program', haId: '...', program: '...', options: [], confirm: 'CONFIRM' };
msg.payload = { action: 'set-setting', haId: '...', key: 'BSH.Common.Setting.PowerState', value: 'BSH.Common.EnumType.PowerState.Standby', confirm: 'CONFIRM' };
msg.payload = { action: 'command', haId: '...', key: 'BSH.Common.Command.PauseProgram', value: true, confirm: 'CONFIRM' };
msg.payload = { action: 'set-active-option', haId: '...', key: 'BSH.Common.Option.Duration', value: 600, confirm: 'CONFIRM' };
msg.payload = { action: 'set-selected-option', haId: '...', key: '...', value: '...', confirm: 'CONFIRM' };
```

Options may also be an object shorthand:

```js
msg.options = {
  'Cooking.Oven.Option.SetpointTemperature': 180,
  'BSH.Common.Option.Duration': { value: 1800, unit: 'seconds' }
};
```

Arbitrary methods, paths, body envelopes and bulk writes are intentionally unsupported. The confirmation token is stored in Node-RED credentials rather than in the flow JSON.

Local configurations reject every write with `LOCAL_READ_ONLY` before capability validation or network I/O. This cannot be overridden by `msg`, editor fields, or `allowWrite`.
