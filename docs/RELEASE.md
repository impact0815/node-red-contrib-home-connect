# Release procedure for 0.2.0

The feature set is frozen at build `hc-0.2.0-final`. Do not add features after this point; only release-blocking corrections are allowed, followed by the complete validation sequence.

## Required release inputs

- `docs/images/dashboard-overview-en.png`
- `docs/images/dashboard-details-en.png`
- `examples/demo-home-connect-flowfuse-1.34.1-scriptless.json`

The screenshots must come from the isolated simulated Demo and must be visually reviewed for browser/account context, hostnames, addresses, real appliance IDs, tokens, QR codes, profiles, unrelated tabs, and notifications.

## Final local checks

```bash
npm ci --ignore-scripts
npm run release:check
npm run validate
npm pack --json
sha256sum node-red-contrib-home-connect-0.2.0.tgz
```

Inspect the exact package payload:

```bash
tar -tzf node-red-contrib-home-connect-0.2.0.tgz | sort
npm publish --dry-run ./node-red-contrib-home-connect-0.2.0.tgz --access public
```

## First GitHub publication

Create `impact0815/node-red-contrib-home-connect` as an empty public repository, without generated README, license, or `.gitignore`, then run:

```bash
git init -b main
git add .
git status --short
git commit -m "Release node-red-contrib-home-connect 0.2.0"
git remote add origin https://github.com/impact0815/node-red-contrib-home-connect.git
git push -u origin main
```

After GitHub Actions CI succeeds on `main`:

```bash
git tag -a v0.2.0 -m "node-red-contrib-home-connect 0.2.0"
git push origin v0.2.0
gh release create v0.2.0 \
  ./node-red-contrib-home-connect-0.2.0.tgz \
  ./SHA256SUMS.txt \
  --title "node-red-contrib-home-connect 0.2.0" \
  --notes-file RELEASE_NOTES.md
```

## npm publication

Confirm the account and package name before publishing:

```bash
npm whoami
npm view node-red-contrib-home-connect versions --json
npm publish ./node-red-contrib-home-connect-0.2.0.tgz --access public
npm view node-red-contrib-home-connect@0.2.0 version dist.integrity dist.tarball
```

If the unscoped npm name is not controlled by the publisher, stop. Do not silently rename or publish under a different scope; update package metadata, documentation, lockfile, and release plan as one reviewed change.

## Post-publication smoke test

```bash
TMPDIR="$(mktemp -d)"
cd "$TMPDIR"
npm init -y
npm install node-red-contrib-home-connect@0.2.0
node -p "require('node-red-contrib-home-connect/BUILD-INFO.json')"
```

The build ID must be `hc-0.2.0-final`.
