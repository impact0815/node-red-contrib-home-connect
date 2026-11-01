# node-red-contrib-home-connect 0.2.0

Version 0.2.0 adds experimental, hard-read-only local Home Connect access alongside the official cloud API, plus German/English Dashboard 2.0 localization.

## Highlights

- Read local appliance profiles over AES-CBC/HMAC or TLS-PSK with a strict local-network allowlist and unconditional write barrier.
- Resolve real profile enums, booleans, programs, and options using hexadecimal identifiers, nested enum references, and inherited subsets.
- Keep raw unresolved values visible without deriving false semantic warnings.
- Use one localized Dashboard for cloud and local read-only data, with German/English selection saved in the browser.
- Preserve last-known state across offline/reconnect events and merge partial updates without clearing omitted fields.
- Use guarded cloud writes only; local write requests always fail before network I/O.
- Import the credential-free screenshot example or the isolated FlowFuse Dashboard 1.34.1 Demo.

## Safety

This is an unofficial community package. Local protocol support is experimental and firmware-dependent. Test with simulated data first. Keep profile PSK/IV values, OAuth credentials, appliance IDs, hostnames, and private addresses out of repositories, screenshots, issues, and exported flows.

## Compatibility

- Node.js 18+
- Node-RED 3+
- `@flowfuse/node-red-dashboard` 1.34.1 for Dashboard examples
- OAuth Authorization Code Grant with client secret; no PKCE
- Zero runtime dependencies

## Verification

Before publication, `npm run release:check` and `npm run validate` must both pass. The release check requires the two reviewed PNG documentation screenshots in `docs/images/`.
