# Security policy

## Local appliance profiles

Local profile PSKs and IVs are equivalent to device credentials. Prefer a server-side profile directory readable only by the Node-RED service account, or use the optional credential-backed manual profile JSON field under **Advanced** with a strong `credentialSecret` in `settings.js`. The configuration node stores the non-secret profile-to-Host/IP assignment once; exported flows can therefore expose private addresses even though they never contain folder-based PSK/IV values. Sanitize both before sharing. Never export profiles in flows, logs, screenshots, support bundles, or bug reports.

The local transport rejects public network targets and is hard read-only. Do not weaken these controls. If a profile is exposed, remove the copy, obtain a fresh profile where the appliance/account supports it, and review LAN access.

The optional local protocol trace is disabled by default. It records decrypted protocol messages only after recursive redaction and never records PSK, IV, derived keys, ciphertext, OAuth data, authentication nonces, appliance IDs, serial numbers, MAC addresses, SSIDs, or IP fields. On POSIX, a configured JSONL trace file is created and enforced with mode `0600`; Windows does not expose equivalent POSIX mode bits reliably, so protect the trace path with an account-restricted NTFS ACL. Without a path, entries remain in a bounded memory buffer. Treat even sanitized traces as private operational data, inspect them before sharing, and disable/delete them after diagnosis.

## Supported version

During the 0.x development phase, security fixes are applied to the latest published release.

## Deployment checklist

- Set a strong `credentialSecret` in Node-RED settings before entering OAuth credentials.
- Serve the editor, Dashboard and OAuth callback over HTTPS.
- Protect the editor and Dashboard with authentication and network controls.
- Expose only the callback path needed by Home Connect; do not expose the Node-RED editor anonymously.
- Request the minimum appliance-specific scopes.
- Keep `allowWrite` off unless a flow needs it.
- Keep every new write node in dry-run until its exact request has been inspected.
- Use a unique confirmation token and an appliance-type allowlist.
- Never place client secret, refresh token, confirmation token or access token in a Function node, flow, Git repository or debug output.
- Never place local profile PSK/IV values or profile archives in a Function node, flow, Git repository or debug output.
- Keep local protocol tracing disabled except during diagnosis; inspect sanitized JSONL before sharing and delete it afterward.
- Never publish a real redirect URI, hostname, appliance ID, serial number, authorization code or OAuth state in screenshots or issues.
- If a client secret is exposed, regenerate it in the Home Connect Developer Portal, replace it in Node-RED and complete a new authorization.
- Review Home Connect Developer Program terms and appliance manufacturer safety instructions.

## Design properties

- OAuth state is random, memory-only, single-use and expires after ten minutes. This confidential-client flow deliberately sends no PKCE parameters.
- Client secrets, refresh tokens and per-writer confirmation tokens use Node-RED credentials; they are not exported with a flow.
- No arbitrary URL/method writer exists.
- Write payloads are checked against refreshed device capabilities, data types, `readWrite` access, ranges and allowed values.
- Program starts check remote-control/start/local-control/operation status.
- Write requests are not automatically retried.
- Normal API requests have a configurable timeout. A persisted sliding-window limiter counts REST and SSE connection attempts before network access; the default is 900 per 24 hours. HTTP 429 opens a local circuit breaker for the reported remaining period instead of being retried.
- OAuth success/error pages disable caching and set restrictive browser headers.
- Built-in simulator performs no external I/O.
- Local transports accept only private/link-local targets and expose only read resources; local writes are rejected before network I/O.

## Reporting a vulnerability

Do not open a public issue containing credentials, private infrastructure data or exploit details. Contact the package maintainer privately and include the affected version, impact, sanitized reproduction and suggested remediation. Revoke affected Home Connect credentials immediately in the Developer Program, deploy the replacement secret and restart Node-RED after rotating secrets.
