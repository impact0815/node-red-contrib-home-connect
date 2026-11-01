# Architecture

## Components

```text
Node-RED editor/runtime
  ├─ Home Connect API configuration
  │    ├─ OAuth state (confidential client, no PKCE)
  │    ├─ access-token memory cache
  │    ├─ refresh token in Node-RED credentials
  │    ├─ shared API/simulator client
  │    └─ per-appliance HealthMonitor
  ├─ discover ── capability cache (5 minutes)
  ├─ read ────── finite operation router
  ├─ events ──── SSE parser + Last-Event-ID reconnect loop
  └─ write ───── security gates + live validation

Client abstraction
  ├─ HomeConnectClient (production, China, official simulator)
  ├─ LocalHomeConnectClient (LAN profiles, hard read-only)
  │    └─ LocalApplianceSession
  │         ├─ RFC 6455 transport (private/link-local targets only)
  │         ├─ AES-CBC + chained HMAC or TLS 1.2 PSK
  │         ├─ negotiated /ei, /ci, /iz, /ni and /ro versions
  │         ├─ sanitized optional protocol trace
  │         └─ /ro/* values + full-session reconnect/heartbeat
  └─ BuiltinSimulator (offline, deterministic, event-capable)
```

## OAuth lifecycle

1. An authenticated Node-RED editor user starts authorization through an admin route.
2. A random, short-lived `state` is generated in memory. No PKCE parameters are created or sent.
3. The browser is redirected to the selected Home Connect authorization endpoint.
4. The public callback validates state and its ten-minute lifetime.
5. The authorization code is exchanged for tokens. `client_id`, `client_secret`, the unchanged `redirect_uri` and the code are form-encoded only in the token request.
6. The refresh token is saved with `RED.nodes.addCredentials`; the access token remains in memory. Client ID and client secret are never added to the browser authorization URL beyond the required client ID.
7. Access tokens refresh before use when expired and once after an HTTP 401.

No password grant, automated login or credential scraping is used.

## Local LAN lifecycle and read-only boundary

The local profile scanner recursively loads Profile Downloader appliance JSON and groups matching DeviceDescription/FeatureMapping XML files by base name within the same directory. It returns only non-secret profile metadata to the editor. The configuration node owns the single `profileId` → Host/IP/connection assignment; Read and Events nodes store only a profile/appliance ID. Legacy encrypted profile JSON remains in the Node-RED credential store. PSK and IV never enter messages, diagnostics, logs, examples, or exported flows.

Before a socket is opened, DNS must resolve exclusively to private RFC1918, IPv4 link-local, IPv6 unique-local, or IPv6 link-local addresses. `Auto` first honors an explicit profile declaration of AES, TLS, or PSK and uses IV presence only as a fallback; a per-profile override is possible only in the central mapping. The editor posts the current card value to the test route and re-serializes all mappings on Done, so testing before deploy and runtime after deploy use the same Host/IP/transport assignment. The transport performs a direct RFC 6455 upgrade on the exact `/homeconnect` path with websocket-client-compatible `Host`, URL-derived `Origin`, `Upgrade`, `Connection`, key, and version headers; it sends no subprotocol, cookie, or authorization header. AES profiles use port 80 and persistent AES-256-CBC/HMAC state. TLS profiles use port 443 with TLS 1.2 PSK and a profile identity or `HCCOM_Local_App`. The first AES integrity/padding/decode error closes the connection; reconnect creates fresh cipher and HMAC chains. The editor test exposes seven deterministic stages and stops on the first root cause, so a transport/handshake failure cannot be followed by a synthetic values-unavailable error.

The appliance sends `/ei/initialValues`; the session responds with the same session/message IDs and the EI-version-specific application structure, then starts its own message counter at the advertised `edMsgID`. It requests `/ci/services` at version 1 **without a `data` member**, parses flat or nested service lists, negotiates legacy `/ci/authentication` (`POST` first, documented `GET` fallback) when `ci < 3`, and announces `/ei/deviceReady` at the negotiated EI version, also without `data`. Optional identity/network reads select `/iz/info` versus `/ci/info` and `/ni/info` from the service inventory. It then sends only `GET`, using the advertised `ro` version, in this order: `/ro/allMandatoryValues`, `/ro/values`, `/ro/allDescriptionChanges`, `/ro/activeProgram`, and `/ro/selectedProgram`.

Incoming unsolicited `NOTIFY`/`RESPONSE` messages are applied before matching pending requests. Successful or device-pushed initial/mandatory/value payloads count as read-only evidence, so one unsupported fallback resource does not invalidate data already delivered by the appliance. Device-originated housekeeping `GET`/`POST` messages receive `RESPONSE` with the same appliance `msgID` and do not advance the client counter. Non-zero/non-200 response codes retain resource, action, version, and device code; if every read path is rejected, all attempts are returned in sanitized diagnostics.

The optional local protocol trace records decrypted, sanitized protocol envelopes and lifecycle events in a bounded memory buffer and, when an absolute path is configured, JSONL mode `0600`. Recursive redaction removes PSK/IV/key/authentication/OAuth material, nonces, and device/network identifiers. It never records ciphertext or transport headers. Trace I/O failure cannot weaken the read-only boundary or crash the session.

Read-only is enforced at three levels: the local client has no write route, its `write()` always throws `LOCAL_READ_ONLY`, and the Write node rejects a local configuration before cloud capability validation or network I/O. `allowWrite` is forced false for local configurations.

## Discovery model

Discovery starts with `/api/homeappliances`. For each appliance it reads status, settings, available/active/selected programs and, where the supplied contract defines it, commands. Every available program is then opened individually so its actual options and constraints are captured. Unsupported endpoints and failed program details become resource-labelled `discoveryErrors`; they do not erase the rest of the snapshot. Successful discovery is cached for five minutes and invalidated after every write.

## Write threat model and gates

A request must pass all applicable gates:

1. **Configuration gate** – `allowWrite` is enabled.
2. **Node action gate** – only seven named actions can reach the client; no arbitrary HTTP path or method is accepted.
3. **Confirmation gate** – optional exact token on each message; the configured token is a Node-RED credential.
4. **Type gate** – optional appliance-type allowlist.
5. **Fresh capability gate** – programs, options, settings and commands are reloaded.
6. **Constraint gate** – value type, access (`readWrite`), allowed values, min, max, step size and duplicate options.
7. **Operational gate** – connected, remote control active, remote start allowed, local control inactive and ready state for program starts.
8. **Retry gate** – writes are sent once and never retried automatically.

Dry-run performs gates 1–7 without sending the request. If dry-run is selected in the editor, an input message cannot turn it off.

## SSE lifecycle

The event node opens an all-appliance or per-appliance stream. The parser supports comments/keep-alive, event, data, id and retry fields and arbitrary chunk boundaries. The latest event ID is sent as `Last-Event-ID` after reconnect. The client emits synthetic `CONNECTED`/`DISCONNECTED` lifecycle events and promotes an all-appliance event's `data.haId` to the normalized event envelope. Network/API errors go to output 2. The node reconnects from one to thirty seconds and aborts immediately when removed, redeployed or when the shared configuration closes.

For local configurations, the same node subscribes to per-appliance WebSocket sessions instead. Sessions emit `CONNECTED`, `DISCONNECTED`, and normalized `STATUS`; ping/pong runs every 20 seconds. Reconnect uses jittered exponential backoff from about one to at most 60 seconds and rebuilds the transport, crypto state, session ID, message counter, services, authentication, device-ready notification, optional info reads, and read-only snapshot.

## Health normalization

One `HealthMonitor` belongs to each configuration node, so Discover, Read, Events and Write nodes sharing that connection also share current appliance state. It maps known operation, door, remote/local-control and connection signals to seven stable health values. Event `level`/`handling`, API/OAuth errors and rate limits become bilingual warning records. Current status conditions replace previous conditions; transient event/Finished/Connected notices are deduplicated and time-bounded. Error-output assessments are not retained, preventing one failed request from poisoning later successful output. Unknown enum values remain in the raw payload and produce at most one informational warning.

## Transport controls

Cloud JSON requests use the vendor media type from the supplied Swagger contracts. API reads have a configurable timeout and bounded retries for network errors and temporary 5xx responses. Writes and HTTP 429 responses are never automatically retried. Binary image reads return a `Buffer`; SSE intentionally uses a long-lived connection instead of the normal request timeout.

Every REST attempt and SSE connection attempt first acquires a permit from a persisted sliding-window limiter. The default is 900 permits per rolling 24 hours and a 250 ms minimum spacing; both are configurable within safety bounds, and config nodes with the same environment and Client ID share the strictest active settings. The state file below the Node-RED `userDir` contains only timestamps and a blocked-until value. When the local budget is exhausted, the request fails locally. A vendor HTTP 429 opens a persistent circuit breaker using `Retry-After` or a remaining-seconds value extracted from the API error description; if neither exists, the limiter conservatively blocks for one configured window.

Direct LAN sessions do not consume the cloud limiter. Their controls are private-address validation, request/handshake timeouts, WebSocket heartbeat, bounded reconnect, strict message parsing, per-direction serialized cipher state, and fail-closed integrity handling.

## Simulator

The built-in simulator implements the same high-level client interface. It includes a dishwasher, washer and oven, validates the same constraints, changes active program state, emits SSE-like events, counts down time and simulates oven temperature. It performs no external I/O.
