# Local LAN connection (read-only)

Back to the [English README](../README.md) · [Deutsch](LOCAL-LAN.de.md)

## Scope and safety boundary

Version 0.2.0 adds an **experimental, unofficial local transport** for Home Connect appliances. Node-RED connects directly to the appliance's private/link-local LAN address. Normal runtime reads and events do not call the Home Connect cloud.

The local protocol is not an official public API. Device firmware may change it without notice. This implementation therefore has a hard boundary:

- local resources are **read-only**;
- the local client exposes no write method;
- a Write node connected to a local configuration always returns `LOCAL_READ_ONLY` before validation or network I/O;
- no program, option, setting, command, pairing, registration, deregistration, firmware, or update request is sent locally.

The existing cloud client is unchanged: confidential OAuth Authorization Code flow, no PKCE, rate-limit protection, SSE, health/warnings, dry-run, and guarded cloud writes remain available in separate cloud configuration nodes.

## Supported transports

The `connectionType` and keys come from the appliance profile:

| Profile | Endpoint | Protection |
|---|---|---|
| `AES` plus IV | `ws://<private-host>:80/homeconnect` | persistent AES-256-CBC stream plus chained truncated HMAC-SHA256 |
| `TLS`/`PSK` | `wss://<private-host>:443/homeconnect` | TLS 1.2 PSK (profile identity or `HCCOM_Local_App`; PSK cipher suites) |

Both variants use RFC 6455 WebSocket framing and the local Home Connect session handshake. The upgrade matches the hcpy/homeconnect-websocket clients: exact `GET /homeconnect HTTP/1.1`, `Upgrade: websocket`, `Connection: Upgrade`, `Host`, URL-derived `Origin`, RFC 6455 key, and version 13. A 20-second ping/pong heartbeat is enabled. A disconnect builds an entirely new session with fresh AES/HMAC state; exponential backoff with jitter grows from about one second to at most 60 seconds. The first HMAC, padding, or UTF-8 failure closes the socket immediately because the stream cannot safely resynchronize.

## Obtain profiles

Use the community [Home Connect Profile Downloader](https://github.com/bruestel/homeconnect-profile-downloader). It performs the required account sign-in and downloads, for each registered appliance:

- `<serial>.json` — host/device metadata and PSK/IV;
- `<serial>_DeviceDescription.xml`;
- `<serial>_FeatureMapping.xml`.

The account/cloud step is required only to obtain or refresh those profiles. The Node-RED local runtime does not automate account login, scrape passwords, or download profiles itself.

Treat the resulting files as secrets. Do not commit them, put them in flows, attach them to issues, or copy them into screenshots.

## Configure Node-RED

1. Extract the Profile Downloader archive on the Node-RED host.
2. Restrict the directory to the Node-RED service account, for example `chmod 700 /data/homeconnect-profiles` and `chmod 600 /data/homeconnect-profiles/*`.
3. Create a new Home Connect configuration and choose **Local LAN (read-only)**.
4. Enter the server-side **Profile folder**, then click **Scan profiles / Detect devices**. This is a path seen by the Node-RED process; for Docker it is the path inside the container. The scanner searches subfolders and groups `<base>.json`, `<base>_DeviceDescription.xml`, and `<base>_FeatureMapping.xml`. It also accepts the unprefixed XML names when one appliance JSON is alone in its directory.
5. Read the result, such as **3 device profiles found**. An incomplete set, invalid JSON/key, orphan companion file, or duplicate profile ID is listed clearly and is not turned into an ambiguous device card. Keep the three files from the same download together and scan again.
6. For every detected device card, enter exactly one **Host/IP**. Missing/malformed values and public IP literals are marked immediately. A hostname is resolved by the server during the connection test and must resolve exclusively to private/link-local addresses. A host detected inside a profile is only an initial suggestion.
7. Leave **Connection type** at **Auto (recommended)**. Auto first honors an explicit profile declaration of `AES`, `TLS`, or `PSK`; only when it is absent does an IV select AES and no IV select TLS-PSK. A retained IV in an explicitly TLS profile therefore no longer selects the wrong transport. Use AES/TLS only as a deliberate override.
8. Click **Test connection** on every card. The test posts the Host/IP and Auto/AES/TLS value currently visible in that card, merges it over any older hidden/deployed mapping, and loads only the selected profile. Its stages are **IP reachable → Profile loaded → Transport detected → WebSocket connected → Session initialized → Services detected → Read-only data received**. It stops at the first root cause, marks later stages skipped, and never adds a misleading `LOCAL_VALUES_UNAVAILABLE` follow-up. Unfilled sibling cards cannot cause a false `LOCAL_MAPPING_HOST_REQUIRED`, and the test cannot call a write method.
9. Click **Done → Deploy**. Every input change updates `localDeviceMappings`, and Done serializes all cards once more. The same assignments are therefore restored after reopening/deploy; users never edit mapping JSON.
10. In a Read node, select the configured appliance and the desired read resource. There is no Host/IP field. In an Events node, select one configured appliance or **All configured appliances**.

The profile-to-Host/IP/transport assignment is serialized once as `localDeviceMappings` in the configuration node. Read and Events nodes store only the profile/appliance ID.

All appliance selectors show a descriptive display label in the form `type — friendly name — brand/model — …last four ID characters`. The complete technical ID remains the option value and is never shortened in runtime state or requests.

**Advanced fallback:** **Paste profile JSON manually (optional)** accepts a complete profile only when no folder is active. With a folder set, the section is collapsed/disabled by default and folder data takes precedence. **Generate from detected profiles and assignments** can create the credential JSON after all cards are valid. This prevents beginners from writing mapping/profile JSON and never presents a credential placeholder as sample data.

The **safe protocol trace** is also under **Advanced** and disabled by default. Without a file path, a bounded ring buffer remains in memory and is shown in a collapsible section after a connection test. An absolute server-side path writes JSONL with mode `0600`. It records decrypted RX/TX protocol messages and lifecycle events, but removes PSKs, IVs, keys, OAuth data, nonces, and appliance/network identifiers. Enable it only while diagnosing, inspect the file before sharing, then disable it again.

Example central assignment in an exported, anonymized config node (all values fictional; keys remain in the protected profile folder and are not exported):

```json
"localDeviceMappings": "[{\"profileId\":\"dishwasher-local\",\"host\":\"192.168.x.x\",\"connectionType\":\"auto\"}]"
```

For Docker, mount the directory read-only and use the path inside the container:

```yaml
volumes:
  - ./homeconnect-profiles:/data/homeconnect-profiles:ro
```

## Read and event mapping

After the session handshake, the client reads only these `ro` resources, in this order and by `GET`:

- `/ro/allMandatoryValues`
- `/ro/values`
- `/ro/allDescriptionChanges`
- `/ro/activeProgram`
- `/ro/selectedProgram`

Numeric runtime UIDs are resolved against both profile files. `FeatureMapping.xml` supplies semantic feature names and, where present, enum members; `DeviceDescription.xml` supplies hexadecimal `uid` values, categories, access/type/unit metadata, and enum references. The resolver follows direct `enumerationType` attributes, nested `<enumerationType refENID="…"/>` elements, `enid` references, and `subsetOf` inheritance. Some real profiles place the authoritative enum table in `DeviceDescription.xml` as `<enumerationType enid="…">`, with enum/member names in the immediately preceding XML comments. All XML identifiers (`uid`, `refUID`, `enid`, `refENID`, `enumerationType`, and `subsetOf`) are hexadecimal even when they contain digits only: `2100` therefore means decimal UID 8448, not 2100.

No global appliance UID or enum table is used. For example, OperationState raw value `0` is translated only when the selected appliance profile defines that member. A profile enum always takes precedence over scalar handling. Profile-typed Boolean values are normalized for RemoteControlActive, RemoteControlStartAllowed, LocalControlActive, and Boolean options. Every local item keeps `rawValue`; `valueResolved` is true only for an actual enum member, a valid profile Boolean/program, or an explicitly typed scalar. If an enum member is missing, the raw value remains visible with `valueResolved: false`, and no status or event warning is inferred from it. On a local read-only connection without an active control context, `RemoteControlStartAllowed=false` remains neutral status rather than a persistent warning.

Resolved status/event features become `status.items`, settings become `settings.items`, and every received item—including unresolved numeric UIDs—remains in `values.items`. Program definitions come from profile features. `BSH.Common.Root.ActiveProgram` and `BSH.Common.Root.SelectedProgram` values are resolved back to program feature names, and currently received option items are attached to program state. A 404 from the optional `/ro/activeProgram` or `/ro/selectedProgram` path therefore does not erase program/options already present in `/ro/allMandatoryValues`.

Snapshots expose a safe `profileResolution` summary (feature/item/resolved/unresolved/status/setting/program counts and at most 20 unresolved numeric UIDs). It contains no host, appliance identity, PSK, IV, nonce, or credential. A rejected optional read is listed under `refresh`, but data received from another successful response or appliance `NOTIFY` remains authoritative and is not discarded.

The local Events node emits normalized `CONNECTED`, `DISCONNECTED`, and `STATUS` messages through the same health/warning layer used by cloud data. Local outputs include `connection.local: true` and `connection.readOnly: true`.

If a configured host is unreachable, snapshot/capability reads return the appliance with `connected: false`, `connection.state: "offline"`, and only a safe network reason instead of converting the device into an unrelated generic error. Values already held by the session are marked stale and retained. An active Events node keeps reconnecting with bounded backoff and emits recovery updates after the appliance becomes reachable again.

The complete sequence follows hcpy and homeconnect-websocket:

1. The appliance sends `POST /ei/initialValues`. The response uses the same `sID`, the same `msgID`, and the EI-version-specific application structure. The client's next counter starts exactly at `data.edMsgID`.
2. `/ci/services` is always requested as `GET`, version 1, with **no** `data` member. Device code `0`, `200`, or no code is accepted as success.
3. Every returned service version is used for its service. For `ci < 3`, `/ci/authentication` first follows hcpy and sends `POST` with a 32-byte nonce; only a concrete rejection triggers the documented `GET` fallback.
4. `NOTIFY /ei/deviceReady` uses the negotiated EI version and omits an empty `data` array.
5. Device information is optionally read from `/iz/info` when `iz` is advertised, otherwise `/ci/info`; `/ni/info` is used only when `ni` exists. Rejection of these optional diagnostic paths does not block the read-only session.
6. The five `/ro/*` GETs use the advertised `ro` version. Not every model supports every resource: an individual code 400 is recorded while the remaining read paths continue.

Unsolicited appliance `NOTIFY` and `RESPONSE` messages are processed immediately. Initial/mandatory/value data already delivered by the appliance counts as successful read-only reception even if a later fallback GET is rejected. Appliance-originated housekeeping `GET`/`POST` requests (for example `/ei/keepAlive`) receive a `RESPONSE` with the same session and appliance `msgID`; this does not advance the client's `edMsgID` counter. WebSocket ping/pong remains separate. The connection remains technically read-only: the nonce, device-ready notification, and protocol responses cannot change settings or programs.

## Network restrictions

Before opening a socket, the configured hostname must resolve **only** to RFC1918, IPv4 link-local, IPv6 unique-local, or IPv6 link-local addresses. Loopback, URLs, paths, credentials in hostnames, and public DNS results are rejected. This prevents the local profile field from becoming an arbitrary Internet socket target.

## Troubleshooting

| Code/symptom | Meaning/action |
|---|---|
| `LOCAL_PROFILE_REQUIRED` | Set a profile folder or optional manual profile JSON, then save and deploy. |
| `LOCAL_PROFILE_FOLDER_REQUIRED` | Automatic discovery needs a directory, not an individual file. |
| `LOCAL_PROFILE_FILES_INCOMPLETE` | Keep the appliance JSON, `DeviceDescription.xml`, and `FeatureMapping.xml` from the same download together, then scan again. |
| `LOCAL_PROFILE_ORPHAN_COMPANION` | An XML/JSON companion cannot be paired by folder/base name; restore the original downloader filenames. |
| `LOCAL_MAPPING_HOST_REQUIRED` | The selected card itself has no Host/IP. Enter it; unfilled sibling cards do not block an individual test. |
| `LOCAL_MAPPING_DUPLICATE` | Keep exactly one central assignment for each profile ID. |
| `LOCAL_MAPPING_PROFILE_NOT_FOUND` | The folder changed after mapping; rescan to remove stale assignments. |
| `LOCAL_PROFILE_KEY_MISSING` / `LOCAL_PROFILE_IV_MISSING` | Re-download the complete profile; do not invent keys. |
| `LOCAL_HOST_NOT_PRIVATE` | Correct DNS/IP; the appliance must resolve only to a private/link-local address. |
| `LOCAL_NETWORK_ERROR` / `LOCAL_CONNECT_TIMEOUT` | Check same-LAN reachability, DNS/IP, VLAN/firewall, appliance Wi-Fi, and port 80/443. `EHOSTUNREACH` means there is no network path, commonly because the appliance is off/asleep, the IP is stale, VLAN routing is missing, or a firewall blocks it. |
| `LOCAL_HANDSHAKE_TIMEOUT` / `LOCAL_REQUEST_TIMEOUT` | The socket opened, but the appliance did not complete the protocol/read response. Check profile, transport, firmware compatibility, and packet loss. |
| `LOCAL_TRANSPORT_UNSUPPORTED` | Keep Auto, or correct an explicit AES/TLS override; also verify Node.js/OpenSSL PSK support. |
| `LOCAL_TLS_PSK_UNAVAILABLE` | The Node.js/OpenSSL runtime exposes none of the required TLS 1.2 PSK cipher suites; use a runtime/OpenSSL build with PSK support. |
| `LOCAL_PROFILE_KEY_REJECTED` / `LOCAL_PROFILE_AUTHENTICATION_FAILED` | The profile/key does not match this appliance or is incomplete. Re-download and assign the correct profile; never guess keys. |
| `LOCAL_PROTOCOL_REJECTED` | The appliance returned a protocol code (for example 400). Diagnostics identify the exact resource, action, negotiated version, and device code; a completely rejected read sequence lists every attempt. Enable the sanitized trace and compare transport/profile/firmware. |
| `LOCAL_CONNECT_FAILED` | Connection failed without a more specific network/key/transport classification. Check the preceding items. |
| `LOCAL_WEBSOCKET_UPGRADE_FAILED` | TCP/TLS succeeded, but the appliance rejected the RFC 6455 upgrade on `/homeconnect`. Verify profile assignment, Auto/AES/TLS, IP, and proxies; a returned HTTP status is reported without exposing headers or keys. |
| `LOCAL_CRYPTO_AUTH_FAILED` / `LOCAL_CRYPTO_PADDING_INVALID` | PSK/IV mismatch or lost AES-CBC/HMAC stream state; the client closes immediately. Re-download profiles if persistent. |
| `LOCAL_HEARTBEAT_TIMEOUT` / `LOCAL_DISCONNECTED` | The connection was established but stopped responding. Check appliance power/standby, Wi-Fi, VLAN, and firewall; the client rebuilds the complete session with backoff. |
| `LOCAL_TRACE_PATH_INVALID` | Use an absolute path inside the Node-RED host/container for file tracing. With no path, only the safe in-memory ring buffer is used. |
| TLS handshake failure | Confirm the profile says TLS, Node.js/OpenSSL exposes PSK cipher suites, and no TLS-inspecting proxy is present. |
| raw numeric UIDs | XML mapping was absent or did not match the profile. Keep the three downloader files together. |
| `LOCAL_READ_ONLY` | Expected security behavior. Use a separate cloud connection only if guarded cloud writes are required. |

## Community protocol references

The implementation was independently written for this Node-RED package using publicly available community protocol observations, especially:

- `chris-mc1/homeconnect_local_hass` and `chris-mc1/homeconnect_websocket`
- `hcpy2-0/hcpy`
- `zibous/homeconnect-hcpy`
- `Asmir1975/homeconnect_local_hass-UI`
- `SukramJ/go-homeconnect2mqtt` protocol notes

No appliance profile, user credential, serial number, host, PSK, IV, or code copied from those projects is included in this package. See [NOTICE](../NOTICE) for attribution and license reminders.
