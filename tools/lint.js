'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const failures = [];
function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(directory, entry.name);
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) return [];
    return entry.isDirectory() ? walk(full) : [full];
  });
}
const files = walk(root);
for (const file of files.filter(file => file.endsWith('.js'))) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) failures.push(`${path.relative(root, file)}: ${result.stderr.trim()}`);
}
for (const file of files.filter(file => file.endsWith('.json'))) {
  try { JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { failures.push(`${path.relative(root, file)}: invalid JSON (${error.message})`); }
}
for (const file of files.filter(file => /\.(js|json|md|html)$/.test(file))) {
  const content = fs.readFileSync(file, 'utf8');
  if (/\r/.test(content)) failures.push(`${path.relative(root, file)}: CRLF line endings`);
  if (content.split('\n').some(line => /[ \t]+$/.test(line))) failures.push(`${path.relative(root, file)}: trailing whitespace`);
}
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
if (!pkg['node-red']?.nodes?.['home-connect']) failures.push('package.json: Node-RED node entry missing');
if (!pkg.engines?.node || !pkg.engines?.['node-red']) failures.push('package.json: engine requirements missing');
if (pkg.version !== '0.2.0') failures.push('package.json: expected release version 0.2.0');
if (pkg.repository?.url !== 'git+https://github.com/impact0815/node-red-contrib-home-connect.git') failures.push('package.json: GitHub repository metadata missing');

const exampleNames = [
  '01-first-steps-device-list.json',
  '02-events.json',
  '03-safe-read-write.json',
  '04-local-read-only.json',
  'dashboard-dishwasher-washer-oven.json',
  'dashboard-screenshot-simulated.json',
  'demo-home-connect-flowfuse-1.34.1-scriptless.json'
];
for (const name of exampleNames) {
  const flow = JSON.parse(fs.readFileSync(path.join(root, 'examples', name)));
  if (!Array.isArray(flow) || !flow.length) failures.push(`${name}: flow must be a non-empty array`);
  const ids = flow.map(node => node.id).filter(Boolean);
  if (new Set(ids).size !== ids.length) failures.push(`${name}: duplicate node ids`);
  if (flow.some(node => Object.hasOwn(node, 'credentials'))) failures.push(`${name}: exported credentials are not allowed`);
}
const dashboard = JSON.parse(fs.readFileSync(path.join(root, 'examples/dashboard-dishwasher-washer-oven.json')));
for (const type of ['ui-base', 'ui-page', 'ui-group', 'ui-template', 'home-connect-read', 'home-connect-events', 'home-connect-write']) {
  if (!dashboard.some(node => node.type === type)) failures.push(`dashboard example: missing ${type}`);
}
for (const device of ['dishwasher-001', 'washer-001', 'oven-001']) {
  if (!dashboard.some(node => node.haId === device)) failures.push(`dashboard example: missing ${device}`);
}
if (!dashboard.some(node => node.type === 'ui-page' && node.path === '/overview')) failures.push('dashboard example: missing overview page');
if (!dashboard.some(node => node.type === 'ui-page' && node.path === '/home-connect')) failures.push('dashboard example: missing detail page');
if (!dashboard.some(node => node.id === 'hc-ui-overview' && /openDetails/.test(node.format || ''))) failures.push('dashboard example: missing click-through overview card');
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`lint ok: ${files.length} files checked`);
