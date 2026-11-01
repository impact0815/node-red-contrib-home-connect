# Dashboard 2.0: overview and appliance details

## Import

1. Install `node-red-contrib-home-connect` and `@flowfuse/node-red-dashboard`.
2. In Node-RED choose **Import → Clipboard** and load `examples/dashboard-dishwasher-washer-oven.json`.
3. Deploy.
4. Open `/dashboard/overview`; the exact prefix follows the Dashboard configuration.

The flow runs immediately with the built-in simulator and contains no real appliance or credential data.

## Language and display values

The Dashboard displays exactly **one** language at a time. Resolution order is: an explicit `msg.uiLocale`/`msg.locale`, the selection saved by the Dashboard language selector, the Dashboard/Vuetify locale, the HTML document language, and finally the browser language. `de` and `en` are supported; English is the fallback. The selector on the overview and detail pages stores the choice in browser-local storage under `home-connect-dashboard-language` and synchronizes all cards on the open page.

Localization covers UI labels, appliance types, health states, warning text, known common and appliance-specific enum values, and known program and option names. Brands, model numbers, `haId`, VIB/E-numbers, Home Connect keys, and raw values are never changed. An unknown unresolved profile enum is shown, for example, as **Unknown value (raw value: 91)**. An unknown but already semantic key is humanized from its last key segment. These fallbacks never modify the internal value.

The imported Node-RED pages use the language-neutral names **Home Connect** and **Home Connect · Details**. Group titles are hidden; all visible card, navigation, and action labels come from runtime localization.

### FlowFuse Dashboard 1.34.1

FlowFuse's `ui-template` component extends user Vue components with its own template-scope values and built-in methods. The corrected templates therefore no longer expose or call a short translation method such as `tr`. All visible text is held in the reactive computed property `hcLabels`, and templates bind values such as `hcLabels.connection`. A Dashboard-scope value named `tr` can no longer replace the translation function or be called during rendering. The regression test constructs both flows with an intentionally non-callable `tr` scope value and evaluates every `hcLabels` render binding.

## Included pages

### Overview

- one compact card for dishwasher, washer, and oven
- normalized health state, most important warning in the selected language, operation state, active program, and remaining time
- documented appliance information: name, brand, and type
- responsive layout for phone, tablet, and desktop
- clicking a card, or pressing Enter while focused, opens the detail page

### Appliance details

- separate cards for dishwasher, washer, and oven
- health chip and deduplicated warnings in the selected language
- name, brand, type, `vib`/E-number, and connection state when supplied by the API
- an initial snapshot after deploy and conservative polling every 30 minutes
- one shared local-WebSocket/cloud-SSE event stream; partial `STATUS`/`NOTIFY` updates are merged into only the affected appliance
- last-known fields remain visible while a device is offline and are refreshed automatically after reconnect
- program selection from discovered capabilities
- dishwasher VarioSpeed, washer temperature, and oven setpoint controls
- start/stop through guarded write nodes
- start is disabled while offline/error/action_required, locally controlled, or remote start is unavailable
- a link back to the overview
- structured errors in the Debug sidebar

## State and update path

`Snapshot/Event → merge state` is the single reducer for Read results, Events results, and structured errors. It keeps one state object per unchanged `haId` in flow context. A full snapshot merges appliance metadata, `status.items`, `settings.items`, all `values.items`, programs, health, and warnings. A partial event changes only the keys present in `event.data.items`; omitted status, setting, option, and program fields are retained.

The deploy-time Inject node requests the initial snapshots. Local `STATUS` events with `connection.action: "NOTIFY"` and cloud `STATUS` events use the same reducer. `DISCONNECTED` or an offline read marks the device offline/stale without deleting the last values; `CONNECTED` clears the stale marker, while the local client refreshes and continues delivering events. The reducer has four outputs: dishwasher, washer, oven, and the combined overview.

Local snapshots carry `readOnly: true`. The detail cards render these devices as read-only status views: operation and door state, active/selected program, remaining time, the three remote/local-control flags, current options, and available programs. Unresolved values are shown explicitly with their raw value. Program selectors, option editors, and Start/Stop buttons are not rendered at all for local read-only devices, so the UI does not suggest an available control path. The Refresh button remains available. The simulator and cloud path still use the same flow; cloud controls remain connected to the guarded Write nodes.

Remaining time is displayed only when a corresponding item exists. Local conversion uses the unit from the appliance profile; a missing item is `—`, not `0 min`. OperationState raw `0` is displayed as the semantic member defined by that profile. If an enum member is genuinely absent from the profile, the card shows an unresolved raw value and the health layer does not derive a semantic warning from it.

## Reproducible documentation screenshot

`examples/dashboard-screenshot-simulated.json` is a separate directly importable flow for screenshots and UI checks. It requires only Node-RED and `@flowfuse/node-red-dashboard`; it contains and requires no Home Connect credentials, real appliance IDs, IP addresses, or local profiles. Every flow, tab, page, group, UI, and demo-node name starts with **Demo**. Dedicated IDs prefixed with `demo-hc-r9-fix1-`, the Dashboard base route `/demo-home-connect-r9-fix1`, and separate subpages prevent confusion with or references to a production installation. On every deploy, one Function node deterministically creates three devices clearly marked **SIMULATED**/**SIMULIERT**: a running dishwasher, a ready washer with a warning, and a running oven. The screenshot flow exposes no start/stop controls.

1. Install `@flowfuse/node-red-dashboard`.
2. Import `dashboard-screenshot-simulated.json` with **Import → Clipboard**, then deploy.
3. Open `/demo-home-connect-r9-fix1/demo-overview`.
4. Select **Deutsch** or **English** in the language selector. The choice remains active on the detail page.
5. For comparable captures, use an approximately 1440 × 900 browser viewport, 100% zoom, and the included light theme. Wait about one second after deploy, then capture **Demo Overview** or **Demo appliance details**.

Every name, ID, and model value in this flow visibly begins with `Studio`, `simulated-`, or `DEMO-`. It performs no network access and **Refresh/Aktualisieren** restores the same initial state at any time.

## Isolated FlowFuse 1.34.1 Demo

`examples/demo-home-connect-flowfuse-1.34.1-scriptless.json` is the isolated, user-supplied Demo flow retained as a separate import. It has fix-specific IDs and its own `/demo-home-connect-ff1341-fix2` route, browser storage, pages, groups, theme, and deterministic simulated data. Its `ui-template` nodes contain presentation markup only; localization and state are prepared before rendering, so no `tr(...)` helper can collide with Dashboard scope. It contains no Home Connect configuration node, credentials, real IDs, addresses, profiles, or network calls.

## Included documentation captures

- `docs/images/dashboard-overview-en.png` — English simulated overview
- `docs/images/dashboard-details-en.png` — English simulated appliance details

The release gate verifies that both files are PNGs. A human must also inspect the complete frame for private browser/account context before publication.

## Move to real cloud appliances

1. Create a Production connection and complete authorization.
2. Use `01-first-steps-device-list` to discover the real appliances.
3. Replace `hc-sim-config` in every Read, Events, and Write node with the Production connection.
4. Replace the three simulator IDs in Read and Write nodes with the respective discovered `haId`. There is no separate event switch; the reducer routes by the appliance type from the initial snapshot.
5. Do not place real IDs in screenshots, issues, or public flows.
6. Keep write nodes in dry-run and test every Dashboard button.
7. Verify local remote-control and remote-start enablement on each appliance.
8. Disable dry-run one node at a time only after verification.
9. Replace the demonstration confirmation token with a deployment-specific value.
10. Protect the Dashboard with authentication, HTTPS, and network controls.

## Move to local read-only appliances

1. Create and deploy a **Local LAN (read-only)** connection as described in the Local LAN guide.
2. Replace `hc-sim-config` in the three Read nodes and the shared Events node with that local connection.
3. Replace the three simulator IDs in the Read nodes with the configured local profile IDs. Write nodes may be removed; if retained, the templates keep their controls disabled because snapshots declare `readOnly: true` and the runtime still enforces `LOCAL_READ_ONLY`.
4. Keep the deploy-time initial snapshot enabled. An appliance that is currently unreachable appears as offline instead of blocking the other devices.
5. Do not publish profile IDs, hosts, profile files, PSKs, or IVs with an exported production flow.

## Scopes

Displayed values require `IdentifyAppliance` plus suitable appliance-specific `*-Monitor` scopes. Start/stop additionally needs the relevant `*-Control`; settings need `*-Settings`. Authorize again after changing scopes.

## Model differences

Not every model provides every program or option. Program lists are loaded dynamically. The three optional controls use common API keys; the Write node safely rejects unavailable options. If necessary, adapt option construction in each `ui-template` to the capabilities actually discovered for that appliance.

## Health, warnings, and refresh behavior

The reducer passes `payload.health` and `payload.warnings` into the compact view model and uses already-resolved semantic keys; it does not invent appliance enums. The shared configuration node maintains health state per appliance. Events update only supplied fields and do not force five local fallback reads for every change. Short-lived notices expire automatically; offline remains until a confirmed reconnect/snapshot, while last-known display values are retained.

## No firmware feature

The Dashboard intentionally contains no firmware version, firmware history, or update button. These capabilities are not part of the publicly documented Home Connect API. No undocumented endpoints are used.

## Safety

Never expose start/stop controls anonymously to the internet. Check an oven cavity before remote start. For washers and dishwashers, verify doors, water supply, and manufacturer instructions. Appliance remote-control and remote-start flags remain authoritative.
