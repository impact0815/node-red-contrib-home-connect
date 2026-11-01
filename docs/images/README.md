# Documentation screenshots

The final 0.2.0 release includes two user-provided, visually reviewed English PNG captures from the isolated simulated Demo:

- `dashboard-overview-en.png` — English **Demo Overview** with three simulated summary cards; 2048 × 511; SHA-256 `fda4af394e65bb2cc48eafec152ae04eabe422d4c18a19a5a2152c7e13dce222`
- `dashboard-details-en.png` — English details view with three simulated appliance cards; 2048 × 1063; SHA-256 `35f260f5ef49a8e8afb60c0ef19fb57961e966dbf44ce3f7039879e681a2dff9`

Visual and OCR-assisted privacy review confirmed that both captures show only English Demo content. Every card is marked `SIMULATED`; visible identifiers are synthetic `Demo`/`DEMO-*` values. The frames contain no browser profile or chrome, account name, email address, hostname, IP address, OAuth material, credential, token, QR code, local profile data, real appliance identifier, unrelated tab/window, or private notification.

Do not substitute screenshots from a real installation. `npm run release:check` verifies the exact reviewed SHA-256 hashes as well as PNG structure, minimum dimensions, and sensitive-looking metadata.
