# Update the existing GitHub repository

Target repository: `impact0815/node-red-contrib-home-connect`

This release is already present on `main`. Apply the scoped-package revision as a normal additional commit. Do not rewrite history and do not force-push.

## Safe update sequence

Run these commands from the existing local clone after copying the revised source files into it:

```bash
git switch main
git pull --ff-only origin main
git status --short
npm ci --ignore-scripts
npm run release:check
npm run validate
git add -A
git diff --cached --check
git diff --cached --stat
git commit -m "Use scoped npm package and finalize 0.2.0"
git push origin main
```

Review the staged diff before `git commit`. The push must be a normal `git push origin main`; never use `--force` or `--force-with-lease`.

## Tag only after CI is green

Before creating the tag, verify that it does not already exist locally or remotely:

```bash
git fetch --tags origin
if git rev-parse -q --verify refs/tags/v0.2.0 >/dev/null; then
  echo "STOP: local tag v0.2.0 already exists"
  exit 1
fi
if git ls-remote --exit-code --tags origin refs/tags/v0.2.0 >/dev/null 2>&1; then
  echo "STOP: remote tag v0.2.0 already exists"
  exit 1
fi
git tag -a v0.2.0 -m "@impact0815/node-red-contrib-home-connect v0.2.0"
git push origin v0.2.0
```

Never move or replace a published release tag.

## Repository About metadata

Description:

```text
Node-RED nodes for Home Connect: OAuth authorization, automatic appliance discovery, events, reading and safeguarded writing via the official cloud API, plus experimental read-only local LAN access.
```

Website:

```text
https://www.npmjs.com/package/@impact0815/node-red-contrib-home-connect
```

Topics:

```text
node-red, home-connect, home-automation, iot, smart-home, appliances, oauth2, websocket, server-sent-events, bosch, siemens, neff, gaggenau
```

Set all values with GitHub CLI:

```bash
gh repo edit impact0815/node-red-contrib-home-connect \
  --description "Node-RED nodes for Home Connect: OAuth authorization, automatic appliance discovery, events, reading and safeguarded writing via the official cloud API, plus experimental read-only local LAN access." \
  --homepage "https://www.npmjs.com/package/@impact0815/node-red-contrib-home-connect" \
  --add-topic node-red,home-connect,home-automation,iot,smart-home,appliances,oauth2,websocket,server-sent-events,bosch,siemens,neff,gaggenau
```

Never commit Client IDs, Client Secrets, access/refresh tokens, authorization codes, real Redirect URIs, hostnames, appliance IDs, serial numbers, PSK/IV values, or private event/debug data.
