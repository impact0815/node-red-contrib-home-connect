# Home Connect troubleshooting and FAQ

Back to the [English README](../README.md).

Start with the visible symptom. Never include credentials, hostnames, appliance IDs, or OAuth codes in a bug report.

## 1. Two-minute preflight check

1. Is the expected build installed?
   ```bash
   cd ~/.node-red
   node -p "require('./node_modules/node-red-contrib-home-connect/BUILD-INFO.json')"
   ```
   Expect version `0.2.0`, build `hc-0.2.0-final`, and `pkce: false`.
2. Is the correct connection selected and clearly named?
3. Did you click **Done → Deploy** after the latest change?
4. Are the Redirect URIs in the Developer Portal and Node-RED exactly identical?
5. Can the browser reach the configured Node-RED address?
6. Did OAuth finish on the **Home Connect authorized** page?
7. Do scopes include `IdentifyAppliance` and the required appliance-specific permissions?

## 2. Authorize is disabled

This is intentional: the configuration node checks whether this exact saved configuration exists in the running Node-RED runtime.

- **New or changed connection:** click Done, deploy, and reopen the connection.
- **Built-in simulator:** OAuth is not required.
- **Still disabled:** restart Node-RED completely and hard-reload the browser. Check for an old or duplicate package installation.

## 3. `CONFIG_NOT_FOUND`

**Meaning:** the URL contains the ID of a configuration node that the running runtime does not know.

Typical causes:

- an example or simulator configuration was referenced;
- the connection was created in the editor but not deployed;
- an old browser tab contains an authorization URL for a deleted configuration;
- another runtime instance is still active after a package or flow change.

**Fix:**

1. Close the old authorization tab.
2. Select the correct connection in the Home Connect node.
3. Give it an unambiguous name.
4. Click Done → Deploy.
5. Reopen the connection.
6. Start a new authorization from that connection.

## 4. Misleading connection name

The **Environment** field controls the API host; the name does not. A name such as `Simulator` with the Production environment is still risky. The editor now warns about this combination. Rename, save, and deploy it.

## 5. Exact Redirect URI comparison

These parts must match:

| Part | Common mistake |
|---|---|
| Protocol | `http` in the portal, `https` in Node-RED |
| Host | DNS name in one place, IP address in the other |
| Port | port omitted in one place |
| Path | typo in `/home-connect/oauth/callback` |
| Ending | extra slash `/callback/` |
| Case | different characters in the path |

Copy the complete URI from one field to the other instead of retyping it.

## 6. After sign-in: localhost, `ERR_EMPTY_RESPONSE`, connection failed

From the browser's perspective, `localhost` is the browser's own computer. If Node-RED runs on a NAS, server, Raspberry Pi, Home Assistant, ioBroker, or another computer/container, the browser cannot reach Node-RED there via localhost.

1. Choose a Node-RED hostname or IP address reachable from the browser.
2. Append `/home-connect/oauth/callback`.
3. Change the URI in the Developer Portal.
4. Enter the identical URI in Node-RED.
5. Click Done → Deploy.
6. Start OAuth again.

## 7. `unauthorized_client` / `client or redirection URI not authorized`

Check in this order:

1. Was the Client ID copied from the correct Developer Portal Application?
2. Does the Redirect URI match character for character?
3. Does the Application use the Authorization Code Grant?
4. Is PKCE disabled for that Application?
5. Is build `hc-0.2.0-final` running?
6. Did you start a new authorization after each change?

If the Client Secret was exposed, stop troubleshooting with that value: regenerate it, replace it in Node-RED, deploy, and authorize again.

## 8. Old code still runs after an update

A flow deploy does not reload Node.js runtime code. Use BUILD-INFO in addition to the npm version when checking for duplicate installs.

```bash
cd ~/.node-red
npm uninstall node-red-contrib-home-connect
rm -rf node_modules/node-red-contrib-home-connect
npm install --force /absolute/path/node-red-contrib-home-connect-0.2.0.tgz
node -p "require('./node_modules/node-red-contrib-home-connect/BUILD-INFO.json')"
```

Then restart Node-RED or the container completely, hard-reload the browser, and begin OAuth again. Authorization codes and state links are short-lived and single-use.

## 9. `No refresh token is stored. Complete OAuth authorization first.`

The refresh token is saved only after a successful callback.

- Start authorization from the deployed connection.
- Complete sign-in and consent.
- Wait for **Home Connect authorized**.
- Only then use Test, Discover, Read, or Events.

If it still fails, record the callback's error code but never publish codes or tokens.

## 10. `insufficient_scope`

The token may not access the requested resource.

1. Keep `IdentifyAppliance`.
2. Add the relevant appliance-specific scope, such as `Dishwasher-Monitor`, `Washer-Monitor`, or `Oven-Monitor`.
3. Add only the required `*-Control` and/or `*-Settings` for actions.
4. Click Done → Deploy.
5. Authorize again; an existing refresh token does not gain new permissions automatically.

The generic `Monitor` scope can be insufficient for some Applications/accounts.

## 11. Events stays on `reconnecting`

`reconnecting` is a consequence, not the root cause. Connect the Events node's second output to Debug.

Common causes:

- no refresh token;
- missing monitor scope;
- expired or revoked authorization;
- network/proxy interruption of the SSE stream;
- too many parallel event streams.

Repair Test/appliance discovery first, then prefer one Events node with appliance ID `*`.

## 12. Successful end state

Setup is complete when:

1. the browser page displays **Home Connect authorized**;
2. Test reports an appliance count without an error;
3. **Load appliances** populates the selector;
4. the Events node emits events instead of reconnecting indefinitely.

## 13. Safe bug reports

Safe to include:

- package version and build ID;
- Node.js and Node-RED versions;
- environment type (Production/Simulator), without a private hostname;
- error code and sanitized message;
- simulator-based reproduction steps.

Never include:

- Client ID or Client Secret;
- access or refresh tokens;
- authorization code or OAuth state;
- real Redirect URI, hostname, or IP address;
- real `haId`, serial number, or appliance number;
- complete events or debug output containing personal data.


## 14. Understanding health and warning codes

Every functional output uses schema `home-connect-health/v1`:

- `ok`: no current concern
- `running`: a program is running
- `info`: useful, non-urgent notice
- `warning`: restriction or paused/aborting state
- `action_required`: local intervention or renewed authorization required
- `offline`: appliance, event stream, or network unavailable
- `error`: appliance/API error

`warnings` is deduplicated. Every entry contains at least `source`, `code`, `severity`, `text.de`, `text.en`, and `transient`. Short-lived notices also include timing fields and disappear after expiry. Status conditions remain only while the current status confirms them.

Important codes:

| Code | Meaning | Action |
|---|---|---|
| `HC_OPERATION_ACTION_REQUIRED` | appliance requests local intervention | inspect appliance display, door, and supplies |
| `HC_STREAM_DISCONNECTED` | SSE connection disconnected | wait for reconnect; inspect output 2 if persistent |
| `HC_OAUTH_INSUFFICIENT_SCOPE` | token has insufficient rights | correct scope, deploy, authorize again |
| `HC_OAUTH_AUTHORIZATION_EXPIRED` | authorization missing/expired/revoked | authorize again |
| `HC_API_RATE_LIMITED` | HTTP 429/API limit | reduce polling and observe `retryAfter` |
| `HC_NETWORK_ERROR` | network/timeout | check DNS, proxy, TLS, and reachability |

The Events node also emits synthetic `CONNECTED`/`DISCONNECTED` lifecycle events for the actual SSE stream. They contain no credentials.

## 15. HTTP 429 / `1000 calls in 1 day`

By default, the local limiter prevents this package from sending more than 900 API attempts in a rolling 24-hour window. The connection editor displays current usage and any active block. When the budget is exhausted, output 2 receives `LOCAL_RATE_LIMITED`; `retryAfter` and `resetAt` state the remaining wait.

If Home Connect has already returned HTTP 429 with text such as `remaining period of 75502 seconds`, the package adopts that block period and sends no further API calls until it expires. The state survives deploys and restarts. Do not repeatedly click **Test** or Inject nodes. Reduce polling substantially, prefer one all-appliance event stream, and do not request snapshots every 15 seconds. Check other computers or programs using the same Developer Portal Application because their calls are outside the local counter.

## 16. Firmware version or update is missing

This is not a configuration error. The publicly documented Home Connect API does not provide firmware version, firmware history, or firmware update. The package does not use undocumented endpoints and intentionally provides no firmware button. It displays only documented appliance information such as name, brand, type, `vib`/E-number, and connection state when supplied. Check firmware only through official manufacturer/Home Connect channels.

## 17. Local LAN profiles and connection failures

For local configurations, OAuth, authorization, refresh-token, and cloud daily-budget sections are intentionally hidden. Setup succeeds when **Test connection** in every device card reports a local read-only connection and Discover/Read/Events return `local: true` and `readOnly: true`.

Check in this order:

1. Confirm the profile folder is mounted at the entered path inside the Node-RED host/container and readable by its service account. Then explicitly click **Scan profiles / Detect devices**.
2. Keep appliance JSON, `DeviceDescription.xml`, and `FeatureMapping.xml` from the same Profile Downloader export together. `LOCAL_PROFILE_FILES_INCOMPLETE` names a missing file; `LOCAL_PROFILE_ORPHAN_COMPANION` indicates mismatched folders/names.
3. A duplicate profile ID lists the affected files. Do not guess an assignment: remove the duplicate/old export and scan again.
4. A successful scan says, for example, **3 device profiles found**, with one card per complete profile. If a card is absent, read the issues directly below the result.
5. Enter Host/IP in every card. Missing, malformed, or public IPs are marked. Hostnames are resolved server-side during testing. Only private/link-local targets are accepted; loopback/public targets return `LOCAL_HOST_NOT_PRIVATE`. An individual card test uses that card's current fields immediately; it does not require Done/Deploy and is not blocked by empty sibling cards.
6. Leave **Connection type: Auto (recommended)**. An explicit AES/TLS/PSK profile declaration wins; IV presence is only the fallback. `LOCAL_PROFILE_IV_MISSING` with an AES override means the original IV is absent.
7. Click **Test connection** and read its seven stages. `LOCAL_NETWORK_ERROR`/timeout stops at **IP reachable**. `EHOSTUNREACH` means no network path and is not a protocol failure: check power/standby, IP, Wi-Fi, VLAN routing, and firewall. `LOCAL_TLS_PSK_UNAVAILABLE`/`LOCAL_TRANSPORT_UNSUPPORTED` stops at **Transport detected**. `LOCAL_WEBSOCKET_UPGRADE_FAILED` means TCP or TLS succeeded but the appliance rejected the upgrade on `/homeconnect`. The test reads local resources only.
8. After all cards are valid, click **Done → Deploy**. `localDeviceMappings` is saved again on Done and restored after deploy. Never copy Host/IP into Read/Events; select the descriptive label while the full ID remains internal.
9. `LOCAL_CRYPTO_AUTH_FAILED`, `LOCAL_PROFILE_KEY_REJECTED`, or `LOCAL_PROFILE_AUTHENTICATION_FAILED` points to the wrong/incomplete profile; re-download it and never edit/guess PSK/IV. `LOCAL_PROTOCOL_REJECTED` is separate and identifies resource, action, negotiated version, and device code. An unsupported `/ro/*` path is tolerated once another read or appliance `NOTIFY` delivered data. If all five paths are rejected, `rejectedResources` contains the complete sequence. `/ci/services` must be version 1 without an empty `data` array.
10. If only numeric UIDs appear, restore the XML files from the same download and scan again.
11. Manual profile JSON is only the optional **Advanced** fallback. It is disabled/ignored while a folder is set. Generate it from detected profiles and assignments instead of writing it manually.
12. For real firmware differences, briefly enable the safe protocol trace under **Advanced**. With no path, the bounded sanitized memory trace is shown only after the test; an absolute path writes JSONL mode `0600` on POSIX. On Windows, restrict the trace path to the Node-RED service account with an NTFS ACL because POSIX mode bits are not reliable there. PSK, IV, keys, nonces, and appliance/network identifiers are removed. Inspect before sharing, then disable tracing and delete the file.
13. `LOCAL_HEARTBEAT_TIMEOUT` or `LOCAL_DISCONNECTED` after an initially successful connection points to power/standby, Wi-Fi roaming, VLAN/firewall, or packet loss. The runtime rebuilds transport, crypto state, `sID`, `msgID`, services, and read session with backoff.

`LOCAL_READ_ONLY` is not a connectivity failure. It proves the local write barrier worked. Use a separate cloud configuration for guarded writes. See [Local LAN connection](LOCAL-LAN.md).
