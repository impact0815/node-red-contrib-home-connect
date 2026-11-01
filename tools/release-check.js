'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const failures = [];
const textExtensions = new Set(['.js', '.json', '.md', '.html', '.yml', '.yaml', '.txt']);

function rel(file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === 'node_modules' || entry.name === '.git') return [];
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function inspectObject(value, file, pointer = '$') {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => inspectObject(entry, file, `${pointer}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value)) {
    const here = `${pointer}.${key}`;
    if (key === 'credentials') failures.push(`${file}: exported credentials at ${here}`);
    if (/^(?:clientSecret|client_secret|accessToken|access_token|refreshToken|refresh_token|confirmationToken|password|psk|psk64|iv|iv64)$/i.test(key)
        && typeof entry === 'string' && entry.trim()) {
      failures.push(`${file}: non-empty credential-like value at ${here}`);
    }
    if (/^(?:host|hostname|ip|address)$/i.test(key) && typeof entry === 'string'
        && /^(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})$/.test(entry)) {
      failures.push(`${file}: numeric private address at ${here}`);
    }
    inspectObject(entry, file, here);
  }
}

function inspectPng(file) {
  const data = fs.readFileSync(file);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (data.length < 33 || !data.subarray(0, 8).equals(signature)) {
    failures.push(`${rel(file)}: missing or invalid PNG signature`);
    return;
  }
  if (data.readUInt32BE(8) !== 13 || data.toString('ascii', 12, 16) !== 'IHDR') {
    failures.push(`${rel(file)}: invalid IHDR chunk`);
    return;
  }
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  if (width < 800 || height < 450) failures.push(`${rel(file)}: expected at least 800x450, got ${width}x${height}`);

  let offset = 8;
  const metadata = [];
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.toString('ascii', offset + 4, offset + 8);
    if (offset + 12 + length > data.length) {
      failures.push(`${rel(file)}: truncated ${type || 'PNG'} chunk`);
      break;
    }
    if (['tEXt', 'zTXt', 'iTXt', 'eXIf'].includes(type)) metadata.push(data.subarray(offset + 8, offset + 8 + length).toString('utf8'));
    offset += 12 + length;
    if (type === 'IEND') break;
  }
  const joined = metadata.join('\n');
  if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(joined)
      || /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/.test(joined)
      || /(?:client.?secret|access.?token|refresh.?token|authorization|password|profile)/i.test(joined)) {
    failures.push(`${rel(file)}: sensitive-looking PNG metadata`);
  }
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const build = JSON.parse(fs.readFileSync(path.join(root, 'BUILD-INFO.json'), 'utf8'));
if (pkg.name !== 'node-red-contrib-home-connect') failures.push('package.json: unexpected package name');
if (pkg.version !== '0.2.0' || build.packageVersion !== '0.2.0') failures.push('release version must be 0.2.0');
if (pkg.homeConnectBuild?.buildId !== 'hc-0.2.0-final' || build.buildId !== 'hc-0.2.0-final') failures.push('build ID must be hc-0.2.0-final');
if (pkg.homeConnectBuild?.releaseStatus !== 'final' || build.releaseStatus !== 'final') failures.push('release status must be final');
if (pkg.homeConnectBuild?.featureFreeze !== '2026-11-01' || build.featureFreeze !== '2026-11-01') failures.push('feature freeze must be 2026-11-01');

const frozenR8 = {
  'lib/local-client.js': '1fc10a7d9b3cc139e7b487192fc91f81525f7eb3867460589c6999b0579cb25a',
  'lib/local-profile.js': '6af32a8fc7b1ce45c6d14a021ce0529dd008615b0811e575a88b9bc2bd654f19',
  'lib/local-crypto.js': 'd8e0e7b818f36035025f7b1c49419e096e1ac26583731a99d7c9ecafb8ffafcc',
  'lib/local-diagnostics.js': '6877951021fb4e98437d3bd18775de4de90fdfa444fba51ae3370319f93e483f',
  'lib/local-trace.js': 'deb58d758d4003b40474580e865cf4d335e474c16865e345c761bfd10faba7d7',
  'lib/websocket-transport.js': '9f9fcbff1dccc5097b8a6d4f0f5f40643eff0ed3452312f2e45d14c95f46faf2',
  'test/local.test.js': 'b7a2137e63f5b9e671b98215cfc66498b4d17799b86089e3a78f56934110b8a6'
};
for (const [name, expected] of Object.entries(frozenR8)) {
  const file = path.join(root, name);
  if (!fs.existsSync(file) || sha256(file) !== expected) failures.push(`${name}: differs from frozen R8 local-enum semantics`);
}

const isolatedDemo = path.join(root, 'examples/demo-home-connect-flowfuse-1.34.1-scriptless.json');
if (!fs.existsSync(isolatedDemo)) failures.push('isolated FlowFuse Demo is missing');
else {
  if (sha256(isolatedDemo) !== '77ace9bbcf1742334f412274abfb0ce59c55a3b5a390f2f9ac44cbed19c51fe3') {
    failures.push('isolated FlowFuse Demo differs from the user-provided file');
  }
  const flow = JSON.parse(fs.readFileSync(isolatedDemo, 'utf8'));
  if (!Array.isArray(flow) || !flow.length) failures.push('isolated FlowFuse Demo must be a non-empty flow');
  if (flow.some(node => /^home-connect-/.test(node.type || ''))) failures.push('isolated FlowFuse Demo must not reference Home Connect runtime nodes');
  inspectObject(flow, rel(isolatedDemo));
}

const frozenScreenshots = {
  'dashboard-overview-en.png': 'fda4af394e65bb2cc48eafec152ae04eabe422d4c18a19a5a2152c7e13dce222',
  'dashboard-details-en.png': '35f260f5ef49a8e8afb60c0ef19fb57961e966dbf44ce3f7039879e681a2dff9'
};
for (const [name, expected] of Object.entries(frozenScreenshots)) {
  const file = path.join(root, 'docs/images', name);
  if (!fs.existsSync(file)) failures.push(`docs/images/${name}: required user-provided screenshot is missing`);
  else {
    inspectPng(file);
    if (sha256(file) !== expected) failures.push(`docs/images/${name}: differs from the reviewed user-provided screenshot`);
  }
}

const forbiddenExtensions = new Set(['.pem', '.key', '.p12', '.pfx', '.ovpn']);
const allFiles = walk(root);
for (const file of allFiles) {
  const name = rel(file);
  if (path.basename(file) === '.env' || forbiddenExtensions.has(path.extname(file).toLowerCase())) failures.push(`${name}: forbidden credential/profile artifact`);
  if (!textExtensions.has(path.extname(file).toLowerCase())) continue;
  const content = fs.readFileSync(file, 'utf8');
  if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(content)) failures.push(`${name}: email address found`);
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(content)) failures.push(`${name}: private key found`);
  if (/\b(?:ghp|github_pat|npm)_[A-Za-z0-9_\-]{20,}\b/.test(content)) failures.push(`${name}: repository/registry token found`);
  const privateIps = content.match(/\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/g) || [];
  if (privateIps.length && name !== 'test/local.test.js') {
    failures.push(`${name}: numeric private address found outside the synthetic validation fixtures`);
  }
}

for (const file of fs.readdirSync(path.join(root, 'examples')).filter(name => name.endsWith('.json'))) {
  const full = path.join(root, 'examples', file);
  inspectObject(JSON.parse(fs.readFileSync(full, 'utf8')), `examples/${file}`);
}

if (failures.length) {
  console.error(`release check failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`release check ok: ${allFiles.length} repository files, frozen R8 semantics, R9 localization, isolated Demo, screenshots, and privacy gates verified`);
