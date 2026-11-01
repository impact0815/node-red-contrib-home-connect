# Changelog

## 0.2.0 - 2026-11-01

Version 0.2.0 is feature-frozen for publication as build `hc-0.2.0-final`.

### Added

- Experimental direct LAN reads and events using Home Connect Profile Downloader data, with AES-256-CBC/HMAC on port 80 and TLS 1.2 PSK on port 443.
- Recursive profile-set discovery, one central profile-to-host mapping, private/link-local target validation, staged connection diagnostics, sanitized protocol tracing, and an unconditional `LOCAL_READ_ONLY` write barrier.
- Profile-driven resolution of hexadecimal `uid`/`refUID`/`enid`/`refENID` identifiers, nested `enumerationType` references, and `subsetOf` inheritance across `DeviceDescription.xml` and `FeatureMapping.xml`.
- Local snapshot classification for status, settings, values, programs, options, remaining time, and safe `profileResolution` diagnostics. Unknown enum members preserve `rawValue`, remain unresolved, and do not create semantic health warnings.
- Dashboard 2.0 overview and appliance-detail examples for Dishwasher, Washer, and Oven, including initial snapshots, partial-event merging, last-known state, offline/reconnect handling, guarded cloud controls, and local read-only presentation.
- German/English dashboard localization for UI labels, appliance types, health/warnings, known enums, programs, and options. Technical keys and raw values remain unchanged.
- A deterministic credential-free screenshot flow and the isolated user-supplied `demo-home-connect-flowfuse-1.34.1-scriptless.json` Demo flow.
- Bilingual Local LAN, Dashboard, troubleshooting, architecture, security, and message/API documentation.

### Changed

- Local transport selection now honors an explicit profile AES/TLS/PSK declaration before using IV presence as a fallback.
- Local handshakes and resource reads are driven by negotiated service versions, tolerate unsupported optional resources, process unsolicited values, respond to housekeeping requests, and rebuild complete sessions with bounded jittered backoff.
- Appliance selectors show type, friendly name, brand/model, and only a shortened display suffix while retaining the full internal ID unchanged.
- Dashboard local read-only cards show semantic status/program/option information without rendering write controls. Cloud writes remain guarded by global enablement, appliance allowlists, confirmation tokens, dry-run, and live capability checks.
- Dashboard localization now binds a collision-resistant computed `hcLabels` object for compatibility with `@flowfuse/node-red-dashboard` 1.34.1.

### Fixed

- Made the protected JSONL trace regression test platform-aware: POSIX continues to require the enforced `0600` mode, while Windows verifies file creation and secret redaction without asserting permission bits that Windows cannot represent reliably. The trace implementation still creates/appends with mode `0600` and explicitly applies `0600` on POSIX-capable filesystems.
- Corrected real-profile enum handling for digit-only hexadecimal IDs, comment-named `enumerationType` tables, inherited enum subsets, profile booleans, program UIDs, and unknown members.
- Corrected local WebSocket upgrade headers and `/homeconnect` path handling, AES/TLS profile validation, legacy authentication fallback, `/ci/services` versioning, `deviceReady`, keepalive handling, and success-code interpretation.
- Prevented optional local-read failures from discarding appliance-pushed or previously successful values.
- Prevented unresolved enum values and neutral local `RemoteControlStartAllowed=false` status from generating false warnings.
- Prevented FlowFuse Dashboard scope values named `tr` from breaking localized template rendering.

### Security and privacy

- Local writes are rejected before network I/O.
- Profile PSK/IV values remain in protected profile data or Node-RED credentials and are never included in exported examples, messages, traces, or diagnostics.
- Protocol traces redact keys, authentication/OAuth material, nonces, appliance/network identifiers, serial/MAC/SSID data, and IP fields.
- Examples and regression fixtures are simulated or anonymized; release checks reject exported credentials, credential-like values, numeric private IP addresses, and missing documentation screenshots.

### Compatibility

- Node.js 18 or newer.
- Node-RED 3 or newer.
- Dashboard examples tested for `@flowfuse/node-red-dashboard` 1.34.1.
- OAuth remains Authorization Code Grant with client secret and without PKCE.
- Runtime dependencies remain zero.
