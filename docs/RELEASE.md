# Release procedure for 0.2.0

The feature set is frozen at build `hc-0.2.0-final`. Only release-blocking corrections are allowed, followed by the complete validation sequence.

## Package identity

- npm package: `@impact0815/node-red-contrib-home-connect`
- version: `0.2.0`
- GitHub repository: `impact0815/node-red-contrib-home-connect`
- npm homepage: `https://www.npmjs.com/package/@impact0815/node-red-contrib-home-connect`
- npm TGZ filename: `impact0815-node-red-contrib-home-connect-0.2.0.tgz`

## Required local checks

```bash
npm ci --ignore-scripts
npm run release:check
npm run validate
npm pack --json
sha256sum impact0815-node-red-contrib-home-connect-0.2.0.tgz
tar -tzf impact0815-node-red-contrib-home-connect-0.2.0.tgz | sort
npm publish --dry-run ./impact0815-node-red-contrib-home-connect-0.2.0.tgz --access public --registry https://registry.npmjs.org/
```

The screenshots in `docs/images/` must remain the reviewed simulated images. The examples and package payload must not contain credentials, account data, real appliance identifiers, or private network data.

## Existing GitHub repository: normal additional commit

Follow [GITHUB-UPDATE.md](GITHUB-UPDATE.md). In summary:

```bash
git switch main
git pull --ff-only origin main
npm ci --ignore-scripts
npm run release:check
npm run validate
git add -A
git diff --cached --check
git commit -m "Use scoped npm package and finalize 0.2.0"
git push origin main
```

Do not force-push. Wait until GitHub Actions CI succeeds on `main`.

## Tag and GitHub Release

Confirm that `v0.2.0` does not already exist. Then:

```bash
git tag -a v0.2.0 -m "@impact0815/node-red-contrib-home-connect v0.2.0"
git push origin v0.2.0

ARTIFACT_DIR="/absolute/path/to/release-files"
gh release create v0.2.0 \
  "$ARTIFACT_DIR/impact0815-node-red-contrib-home-connect-0.2.0-source.zip" \
  "$ARTIFACT_DIR/impact0815-node-red-contrib-home-connect-0.2.0.tgz" \
  "$ARTIFACT_DIR/SHA256SUMS.txt" \
  --repo impact0815/node-red-contrib-home-connect \
  --verify-tag \
  --title "@impact0815/node-red-contrib-home-connect 0.2.0" \
  --notes-file ./RELEASE_NOTES.md
```

## npm publication

```bash
ARTIFACT_DIR="/absolute/path/to/release-files"
npm config get registry
npm whoami --registry https://registry.npmjs.org/
npm view @impact0815/node-red-contrib-home-connect versions --json --registry https://registry.npmjs.org/ || true
npm publish "$ARTIFACT_DIR/impact0815-node-red-contrib-home-connect-0.2.0.tgz" --access public --registry https://registry.npmjs.org/
npm view @impact0815/node-red-contrib-home-connect@0.2.0 name version dist.integrity dist.tarball --registry https://registry.npmjs.org/
```

If npm requires two-factor authentication, complete its prompt or add a current one-time password with `--otp=<code>`. Never put an npm token or OTP into the repository.

## Post-publication smoke test

```bash
TMPDIR="$(mktemp -d)"
cd "$TMPDIR"
npm init -y
npm install @impact0815/node-red-contrib-home-connect@0.2.0
node -p "require('@impact0815/node-red-contrib-home-connect/BUILD-INFO.json')"
```

The package name must be `@impact0815/node-red-contrib-home-connect`, the version `0.2.0`, and the build ID `hc-0.2.0-final`.

## Node-RED Flow Library

After npm publication, sign in at `https://flows.nodered.org/add/node`, enter the exact package name `@impact0815/node-red-contrib-home-connect`, and submit it. The package must already be public on npm and must retain the `node-red` keyword, README, license, and `node-red.nodes` metadata.
