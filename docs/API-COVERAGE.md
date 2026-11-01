# Official API contract and coverage

The cloud client in version 0.2.0 is checked against the two supplied official Swagger 2.0 files:

| Specification | SHA-256 | Host | Operations |
| --- | --- | --- | ---: |
| `hcsdk-simulation.yaml` | `5942f5ca450a46fa9a6f53ff6d13627972040f105dcd786efddcf9a44ce376a3` | `simulator.home-connect.com` | 28 |
| `hcsdk-production.yaml` | `a0704118d429eb1a7becf9d624068a2c48ce8d7c0a2250128be2487ff0758c57` | `api.home-connect.com` | 46 |

The generated, machine-readable inventory is `official-api-contract.json`. The original YAML files are not redistributed in the npm package.

## Contract decisions

- API paths use the documented `/api` base path.
- JSON reads and writes use `application/vnd.bsh.sdk.v1+json`.
- OAuth uses the documented `accessCode` flow and the `/security/oauth/authorize` and `/security/oauth/token` endpoints on the selected environment host. The private-application implementation uses a client secret and deliberately omits PKCE parameters.
- Request bodies retain the documented `{ "data": ... }` envelope.
- JPEG image reads return `{ contentType, data }`, where `data` is a Node.js `Buffer`.
- Production-only command and cleaning-robot map resources are not queried during generic official-simulator discovery.
- HTTP 204 write responses become an empty object.

## Read coverage

The read node exposes a finite operation list rather than accepting arbitrary URLs:

- appliances and one appliance
- complete and single status values
- complete and single settings
- all, available, active and selected programs
- complete and single active/selected program options
- production command discovery
- image metadata and JPEG image data
- all production cleaning-robot map GET resources: maps, occupancy grid, layout, cleaning status, detected objects, rooms, zones, robot position, restrictions and cleaning summaries
- capability discovery and combined snapshots

The appliance object is passed through, including documented fields such as name, brand, type, `vib` and connected state when returned by the API.

## Firmware is outside the public contract

Neither the checked public production/simulation contracts nor the documented operation set provides firmware version, firmware history, or firmware update. Version 0.2.0 therefore exposes no firmware operation, does not synthesize firmware data, and does not call undocumented firmware endpoints. Its separate experimental local transport is read-only and limited to the documented-in-project `/ro/*` inventory in [LOCAL-LAN.md](LOCAL-LAN.md).

Map operations use `msg.key` for the map ID or cleaning-summary counter. Operations for one detected object, room or zone additionally use `msg.subKey`.

## Write coverage and intentional restrictions

The writer supports the documented singular endpoints for:

- start and stop program
- select program
- set one setting
- execute one command
- set one option of the active program
- set one option of the selected program

Bulk setting, command and option writes are intentionally not exposed. Singular writes permit tighter per-value validation and avoid partial-success ambiguity. Arbitrary HTTP methods, paths and body envelopes are intentionally unsupported.

## Simulator differences

The supplied simulation contract does not define command or map endpoints, while the production contract does. The client records this difference explicitly: command discovery is skipped for the official simulator, and map operations remain production-only. The built-in offline simulator implements the common high-level interface and returns structured `404` errors for image/map content it does not model.
