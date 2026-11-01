# Contributing

1. Use Node.js 18 or newer.
2. Keep runtime dependencies at zero unless a change is clearly justified.
3. Add tests for each behavior or bug fix.
4. Run `npm run validate`.
5. Do not include credentials, tokens, real appliance IDs or personal event data.
6. Preserve the finite read/write operation allowlists and capability validation.
7. Update both English and German user documentation for user-visible changes.

Use the built-in simulator for deterministic tests. Integration tests against the live Home Connect service must be opt-in and must never run with repository secrets on untrusted contributions.
