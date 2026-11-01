# First GitHub push

Target repository: `impact0815/node-red-contrib-home-connect`

The repository is intentionally prepared without a `.git` directory. Create an empty GitHub repository with that name, without adding a README, license, or `.gitignore`, then run from the extracted source directory:

```bash
git init -b main
git add .
git status
git commit -m "Release: Home Connect nodes v0.2.0"
git remote add origin https://github.com/impact0815/node-red-contrib-home-connect.git
git push -u origin main
```

If Git is already initialized locally:

```bash
git branch -M main
git remote get-url origin 2>/dev/null \
  && git remote set-url origin https://github.com/impact0815/node-red-contrib-home-connect.git \
  || git remote add origin https://github.com/impact0815/node-red-contrib-home-connect.git
git add .
git commit -m "Release: Home Connect nodes v0.2.0"
git push -u origin main
```

Optional annotated release tag after CI succeeds:

```bash
git tag -a v0.2.0 -m "node-red-contrib-home-connect v0.2.0"
git push origin v0.2.0
```

Before pushing, run:

```bash
npm ci
npm run validate
```

Never commit Client IDs, Client Secrets, refresh/access tokens, authorization codes, real Redirect URIs, hostnames, appliance IDs, serial numbers, or private event/debug data.
