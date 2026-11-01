'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { HomeConnectError } = require('./errors');
const { formatDeviceLabel } = require('./device-label');
const { cleanHost, privateIp } = require('./websocket-transport');

const MAX_PROFILE_FILES = 1000;
const MAX_PROFILE_DEPTH = 5;

const first = (object, keys) => keys.map(key => object?.[key]).find(value => value !== undefined && value !== null && value !== '');
const hasProfileKey = value => Boolean(first(value, ['psk64', 'psk', 'key', 'encryptionKey', 'aesKey']));

function profileConnectionType(declaredValue, iv64) {
  const declared = String(declaredValue || '').trim().toUpperCase();
  // The downloader's declared connectionType is authoritative. Some exports
  // retain an IV while declaring PSK/TLS; treating every present IV as AES
  // sends the WebSocket upgrade to the wrong port.
  if (declared.includes('AES')) return 'AES';
  if (declared.includes('TLS') || declared.includes('PSK')) return 'TLS';
  return iv64 ? 'AES' : 'TLS';
}

function issue(code, message, messageDe, source, details = {}) {
  return { code, message, messageDe, ...(source ? { source } : {}), ...details };
}

function attributes(text) {
  const result = {};
  for (const match of String(text).matchAll(/([\w:-]+)\s*=\s*["']([^"']*)["']/g)) result[match[1].toLowerCase()] = match[2];
  return result;
}

function decodeXml(value) {
  return String(value || '').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function localTag(value) {
  return String(value || '').split(':').pop().toLowerCase();
}

function xmlUid(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;
  const hexadecimal = /^0x[0-9a-f]+$/i.test(unsigned)
    || /[a-f]/i.test(unsigned)
    || (/^0[0-9]+$/.test(unsigned) && unsigned.length > 1);
  const parsed = Number.parseInt(unsigned.replace(/^0x/i, ''), hexadecimal ? 16 : 10);
  if (!Number.isSafeInteger(parsed)) return text;
  return String(negative ? -parsed : parsed);
}

function xmlIdentifier(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const parsed = Number.parseInt(text.replace(/^0x/i, ''), 16);
  return Number.isSafeInteger(parsed) ? String(parsed) : text;
}

function enumValue(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (/^-?0x[0-9a-f]+$/i.test(text)) {
    const negative = text.startsWith('-');
    const parsed = Number.parseInt(text.replace(/^-?0x/i, ''), 16);
    return String(negative ? -parsed : parsed);
  }
  const parsed = Number(text);
  return Number.isFinite(parsed) ? String(parsed) : text;
}

function textContent(value) {
  return decodeXml(String(value || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim());
}

function categoryFrom(tag, name) {
  const element = localTag(tag).replace(/s$/, '');
  if (['status', 'setting', 'event', 'option', 'program', 'command'].includes(element)) return element;
  const key = String(name || '');
  if (/\.Status\./.test(key)) return 'status';
  if (/\.Setting\./.test(key)) return 'setting';
  if (/\.Event\./.test(key)) return 'event';
  if (/\.Option\./.test(key)) return 'option';
  if (/\.Program\./.test(key)) return 'program';
  if (/\.Command\./.test(key)) return 'command';
  return 'value';
}

function semanticEnumLabel(enumName, memberName) {
  const name = decodeXml(String(memberName || '').trim());
  const parent = decodeXml(String(enumName || '').trim());
  if (!name) return '';
  if (name.includes('.') || !parent) return name;
  return `${parent}.${name}`;
}

function enumMembers(body, enumName) {
  const values = {};
  const memberPattern = /(?:<!--\s*([\s\S]*?)\s*-->\s*)?<(?:[\w-]+:)?(?:value|enum|enumMember|enumeration|enumerationValue)\b([^>]*)(?:\/>|>([\s\S]*?)<\/(?:[\w-]+:)?(?:value|enum|enumMember|enumeration|enumerationValue)>)/gi;
  for (const match of String(body || '').matchAll(memberPattern)) {
    const attrs = attributes(match[2]);
    const key = enumValue(attrs.refvalue ?? attrs.value ?? attrs.key ?? attrs.id);
    const rawLabel = attrs.name || attrs.label || textContent(match[3]) || textContent(match[1]);
    const label = semanticEnumLabel(enumName, rawLabel);
    if (key !== '' && label) values[key] = label;
  }
  return values;
}

function parseXmlTree(xml) {
  const root = { tag: '#document', attrs: {}, children: [], text: '', leadingComment: '' };
  const stack = [root];
  let pendingComment = '';
  const tokens = String(xml || '').match(/<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<[^>]+>|[^<]+/g) || [];
  for (const token of tokens) {
    if (token.startsWith('<!--')) {
      pendingComment = decodeXml(token.slice(4, -3).trim());
      continue;
    }
    if (token.startsWith('<?') || token.startsWith('<!')) continue;
    if (token.startsWith('</')) {
      if (stack.length > 1) stack.pop();
      pendingComment = '';
      continue;
    }
    if (token.startsWith('<')) {
      const selfClosing = /\/\s*>$/.test(token);
      const match = token.match(/^<\s*([^\s/>]+)([\s\S]*?)\/?\s*>$/);
      if (!match) continue;
      const node = {
        tag: localTag(match[1]),
        attrs: attributes(match[2]),
        children: [],
        text: '',
        leadingComment: pendingComment
      };
      pendingComment = '';
      stack.at(-1).children.push(node);
      if (!selfClosing) stack.push(node);
      continue;
    }
    if (token.trim()) {
      stack.at(-1).text += decodeXml(token).trim();
      pendingComment = '';
    }
  }
  return root;
}

function descendants(node) {
  return (node?.children || []).flatMap(child => [child, ...descendants(child)]);
}

function directText(node) {
  return decodeXml(String(node?.text || '').replace(/\s+/g, ' ').trim());
}

function nodeName(node) {
  const namedChild = (node?.children || []).find(child => ['name', 'key'].includes(child.tag));
  return decodeXml(node?.attrs?.name || node?.attrs?.key || node?.attrs?.enumkey || directText(namedChild) || directText(node) || node?.leadingComment || '');
}

function enumMembersFromNode(node, enumName) {
  const values = {};
  const memberTags = new Set(['value', 'enum', 'enummember', 'enumeration', 'enumerationvalue']);
  for (const member of descendants(node)) {
    if (!memberTags.has(member.tag)) continue;
    const raw = member.attrs.refvalue ?? member.attrs.value ?? member.attrs.key ?? member.attrs.id;
    const key = enumValue(raw);
    const rawLabel = member.attrs.name || member.attrs.label || directText(member) || member.leadingComment;
    const label = semanticEnumLabel(enumName, rawLabel);
    if (key !== '' && label) values[key] = label;
  }
  return values;
}

function enumReference(node) {
  const candidates = [node, ...descendants(node).filter(child => /enum/.test(child.tag))];
  for (const candidate of candidates) {
    const attrs = candidate.attrs || {};
    const value = attrs.enumerationtype ?? attrs.refenid ?? attrs.enid;
    if (value !== undefined && value !== '') return xmlIdentifier(value);
  }
  return '';
}

function mergeEnumeration(enumerations, id, name, values, extra = {}) {
  if (!id) return;
  const current = enumerations[id] || {};
  enumerations[id] = {
    ...current,
    ...extra,
    name: decodeXml(name || current.name || id),
    values: { ...(current.values || {}), ...(values || {}) }
  };
}

function parseFeatureXml(...documents) {
  const features = {};
  const enumerations = {};
  const xmlDocuments = documents.filter(Boolean).map(String);

  const trees = xmlDocuments.map(parseXmlTree);
  for (const tree of trees) {
    for (const node of descendants(tree)) {
      const attrs = node.attrs || {};
      const hasMembers = Object.keys(enumMembersFromNode(node, '')).length > 0;
      const isEnumContainer = node.tag === 'enumerationtype'
        || (node.tag === 'enumeration' && attrs.refenid && hasMembers);
      if (!isEnumContainer) continue;
      const id = xmlIdentifier(attrs.enid || attrs.refenid);
      if (!id) continue;
      const name = nodeName(node) || id;
      mergeEnumeration(enumerations, id, name, enumMembersFromNode(node, name), {
        source: node.tag === 'enumerationtype' ? 'device-description' : 'feature-mapping',
        ...(attrs.subsetof ? { subsetOf: xmlIdentifier(attrs.subsetof) } : {})
      });
    }
  }

  const inheritedValues = (id, seen = new Set()) => {
    const enumeration = enumerations[id];
    if (!enumeration || seen.has(id)) return {};
    seen.add(id);
    const parent = enumeration.subsetOf ? inheritedValues(enumeration.subsetOf, seen) : {};
    return { ...parent, ...(enumeration.values || {}) };
  };

  for (const tree of trees) {
    for (const node of descendants(tree)) {
      const attrs = node.attrs || {};
      const uid = xmlIdentifier(attrs.uid || attrs.refuid);
      if (!uid) continue;
      const mappedName = nodeName(node);
      const current = features[uid] || {};
      const feature = { ...current };
      if (mappedName && (mappedName.includes('.') || !feature.name)) feature.name = mappedName;
      const access = attrs.access || attrs.accessmode;
      if (access) feature.access = access;
      for (const [source, target] of [
        ['type', 'type'], ['unit', 'unit'], ['min', 'min'], ['max', 'max'], ['stepSize', 'stepSize'],
        ['handling', 'handling'], ['refcid', 'refCID'], ['refdid', 'refDID']
      ]) {
        const value = attrs[source.toLowerCase()] ?? attrs[source];
        if (value !== undefined) feature[target] = decodeXml(value);
      }
      const enumerationType = enumReference(node);
      const subsetOf = attrs.subsetof ? xmlIdentifier(attrs.subsetof) : '';
      if (enumerationType) feature.enumerationType = enumerationType;
      if (subsetOf) feature.subsetOf = subsetOf;
      if (enumerationType || subsetOf) feature.enumDeclared = true;
      const values = { ...(feature.values || {}) };
      Object.assign(values, enumMembersFromNode(node, ''));
      if (Object.keys(values).length) feature.values = values;
      feature.category = categoryFrom(node.tag, feature.name);
      features[uid] = feature;
    }
  }

  for (const feature of Object.values(features)) {
    const enumId = feature.enumerationType || feature.subsetOf;
    const enumeration = enumerations[enumId];
    const values = inheritedValues(enumId);
    if (Object.keys(values).length) feature.values = { ...values, ...(feature.values || {}) };
    if (enumeration) {
      feature.enumName = enumeration.name;
      feature.enumSource = enumeration.source;
      feature.enumDeclared = true;
    }
    feature.category = categoryFrom(feature.category, feature.name);
  }
  return features;
}

function inferType(value, features = {}) {
  const text = `${value || ''} ${Object.values(features).map(item => item?.name || '').join(' ')}`.toLowerCase();
  if (/dishwasher|dishcare|geschirr/.test(text)) return 'Dishwasher';
  if (/washer|laundry|waschmaschine/.test(text)) return 'Washer';
  if (/oven|backofen|cooking\.oven/.test(text)) return 'Oven';
  return 'Unknown';
}

function normalizeFeatures(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  for (const [uid, entry] of Object.entries(value)) {
    const key = xmlUid(uid) || String(uid);
    const normalized = entry && typeof entry === 'object' && !Array.isArray(entry)
      ? { ...entry, ...(entry.values && typeof entry.values === 'object' ? { values: { ...entry.values } } : {}) }
      : { name: String(entry || uid) };
    normalized.category = categoryFrom(normalized.category, normalized.name);
    result[key] = { ...(result[key] || {}), ...normalized };
  }
  return result;
}

function profileCandidates(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  for (const key of ['devices', 'appliances', 'homeappliances', 'profiles']) if (Array.isArray(value[key])) return value[key];
  const values = Object.entries(value).filter(([, entry]) => entry && typeof entry === 'object');
  if (!hasProfileKey(value) && values.some(([, entry]) => hasProfileKey(entry))) {
    return values.map(([id, entry]) => ({ id, ...entry }));
  }
  return [value];
}

function parseLocalDeviceMappings(value) {
  if (value === undefined || value === null || value === '') return [];
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); }
    catch (cause) { throw new HomeConnectError('Local device assignments are not valid JSON.', { code: 'LOCAL_MAPPING_JSON_INVALID', cause }); }
  }
  if (!Array.isArray(parsed)) throw new HomeConnectError('Local device assignments must be an array.', { code: 'LOCAL_MAPPING_INVALID' });
  if (parsed.length > 100) throw new HomeConnectError('A maximum of 100 local device assignments is allowed.', { code: 'LOCAL_MAPPING_TOO_MANY' });
  const result = [];
  const seen = new Set();
  for (const entry of parsed) {
    const profileId = String(entry?.profileId || entry?.haId || entry?.id || '').trim();
    const rawHost = String(entry?.host || entry?.ip || '').trim();
    const requested = String(entry?.connectionType || entry?.transport || 'auto').trim().toUpperCase();
    if (!profileId) throw new HomeConnectError('A local device assignment is missing profileId.', { code: 'LOCAL_MAPPING_PROFILE_REQUIRED' });
    if (seen.has(profileId)) throw new HomeConnectError(`Duplicate local device assignment: ${profileId}`, { code: 'LOCAL_MAPPING_DUPLICATE' });
    if (!['AUTO', 'AES', 'TLS'].includes(requested)) throw new HomeConnectError(`Unsupported local connection type for ${profileId}.`, { code: 'LOCAL_MAPPING_CONNECTION_INVALID' });
    let host = '';
    if (rawHost) {
      host = cleanHost(rawHost);
      const literal = host.split('%')[0];
      if (net.isIP(literal) && !privateIp(literal)) {
        throw new HomeConnectError(`The host for ${profileId} is not a private or link-local address.`, { code: 'LOCAL_HOST_NOT_PRIVATE' });
      }
    }
    seen.add(profileId);
    result.push({ profileId, host, connectionType: requested === 'AUTO' ? 'auto' : requested });
  }
  return result;
}

function detectedHost(value) {
  if (!value) return '';
  try {
    const host = cleanHost(value);
    const literal = host.split('%')[0];
    return net.isIP(literal) && !privateIp(literal) ? '' : host;
  } catch { return ''; }
}

function normalizeProfile(value, extra = {}) {
  const source = { ...value };
  const mapping = extra.mapping || null;
  const sourceHost = first(source, ['host', 'ipAddress', 'ip', 'hostname', 'address']);
  const mappedHost = mapping ? mapping.host : undefined;
  const hostText = extra.requireMapping ? mappedHost : (mappedHost || sourceHost);
  const host = hostText ? cleanHost(hostText) : '';
  const literal = host.split('%')[0];
  if (host && net.isIP(literal) && !privateIp(literal)) {
    throw new HomeConnectError('A local appliance host must be private or link-local.', { code: 'LOCAL_HOST_NOT_PRIVATE' });
  }
  const psk64 = first(source, ['psk64', 'psk', 'key', 'encryptionKey', 'aesKey']);
  const iv64 = first(source, ['iv64', 'iv', 'initializationVector']);
  const declared = first(source, ['connectionType', 'connection_type', 'protocol', 'encryption']);
  const automaticConnectionType = profileConnectionType(declared, iv64);
  const requestedConnectionType = String(mapping?.connectionType || 'auto').toUpperCase();
  const connectionType = requestedConnectionType === 'AUTO' ? automaticConnectionType : requestedConnectionType;
  if (!psk64) throw new HomeConnectError('A local appliance profile is missing its PSK.', { code: 'LOCAL_PROFILE_KEY_MISSING' });
  if (!host && !extra.allowMissingHost) throw new HomeConnectError('A local appliance profile has no central Host/IP assignment.', { code: 'LOCAL_MAPPING_HOST_REQUIRED' });
  if (connectionType === 'AES' && !iv64) throw new HomeConnectError('An AES appliance profile is missing its IV.', { code: 'LOCAL_PROFILE_IV_MISSING' });
  const features = { ...normalizeFeatures(extra.features), ...normalizeFeatures(source.features || source.featureMap || source.deviceDescription) };
  const id = String(first(source, ['haId', 'haID', 'id', 'serialNumber', 'serial', 'deviceId', 'identifier']) || extra.id || sourceHost || 'local-profile');
  const name = String(first(source, ['name', 'deviceName', 'displayName']) || `Home Connect ${id.slice(-4)}`);
  const type = String(first(source, ['type', 'applianceType', 'deviceType']) || inferType(`${name} ${extra.filename || ''}`, features));
  const rawModel = first(source, ['model', 'modelNumber', 'vib', 'eNumber', 'enumber']);
  const model = rawModel ? String(rawModel).split('/')[0] : '';
  return Object.freeze({
    id, haId: id, host, psk64: String(psk64), ...(iv64 ? { iv64: String(iv64) } : {}), connectionType,
    automaticConnectionType, declaredConnectionType: declared ? String(declared) : '',
    pskIdentity: String(first(source, ['pskIdentity', 'psk_identity', 'identity']) || 'HCCOM_Local_App'),
    name, type, brand: String(first(source, ['brand']) || 'Siemens'), ...(model ? { model } : {}), features,
    source: extra.filename ? path.relative(extra.rootDirectory || path.dirname(extra.filename), extra.filename) : 'credential-json',
    detectedHost: detectedHost(sourceHost)
  });
}

function parseJson(text, label) {
  try { return JSON.parse(text); }
  catch (cause) { throw new HomeConnectError(`Invalid local profile JSON (${label}).`, { code: 'LOCAL_PROFILE_JSON_INVALID', cause }); }
}

function profileFiles(directory, depth = 0, files = []) {
  if (depth > MAX_PROFILE_DEPTH) return files;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (files.length >= MAX_PROFILE_FILES) throw new HomeConnectError('The local profile folder contains too many files.', { code: 'LOCAL_PROFILE_FOLDER_TOO_LARGE' });
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) profileFiles(filename, depth + 1, files);
    else if (entry.isFile()) files.push(filename);
  }
  return files;
}

function companionFiles(filename, names, deviceJsonCount) {
  const directory = path.dirname(filename);
  const base = path.basename(filename).replace(/\.json$/i, '');
  const escapedBase = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sameDirectory = names.filter(candidate => path.dirname(candidate) === directory);
  const prefixed = kind => new RegExp(`^${escapedBase}_${kind}\\.(?:xml|json)$`, 'i');
  const generic = kind => new RegExp(`^${kind}\\.(?:xml|json)$`, 'i');
  const pick = kind => {
    const exact = sameDirectory.filter(candidate => prefixed(kind).test(path.basename(candidate)));
    if (exact.length) return exact;
    return deviceJsonCount === 1 ? sameDirectory.filter(candidate => generic(kind).test(path.basename(candidate))) : [];
  };
  return { deviceDescription: pick('DeviceDescription'), featureMapping: pick('FeatureMapping') };
}

function featuresFromCompanions(companions, rootDirectory) {
  const all = [...companions.deviceDescription, ...companions.featureMapping];
  const xml = all.filter(candidate => candidate.toLowerCase().endsWith('.xml')).map(candidate => fs.readFileSync(candidate, 'utf8'));
  const json = all.filter(candidate => candidate.toLowerCase().endsWith('.json'));
  const features = parseFeatureXml(...xml);
  for (const filename of json) {
    const parsed = parseJson(fs.readFileSync(filename, 'utf8'), path.relative(rootDirectory, filename));
    Object.assign(features, normalizeFeatures(parsed.features || parsed));
  }
  return features;
}

function directoryProfiles(directory, options = {}) {
  const names = profileFiles(directory);
  const mappings = new Map(parseLocalDeviceMappings(options.mappings).map(entry => [entry.profileId, entry]));
  const profiles = [];
  const groups = [];
  const errors = [];
  const usedCompanions = new Set();
  const records = [];
  for (const filename of names.filter(value => value.toLowerCase().endsWith('.json') && !/devicedescription|featuremapping/i.test(value)).sort()) {
    const source = path.relative(directory, filename);
    try {
      const parsed = parseJson(fs.readFileSync(filename, 'utf8'), source);
      records.push({ filename, source, parsed, candidates: profileCandidates(parsed) });
    } catch (error) {
      errors.push(issue(error.code, error.message, `Ungültiges Geräte-JSON: ${source}`, source));
    }
  }
  const deviceJsonCounts = new Map();
  const targetProfileId = String(options.targetProfileId || '').trim();
  const selectedRecords = targetProfileId
    ? records.filter(record => record.candidates.some(candidate => String(first(candidate, ['haId', 'haID', 'id', 'serialNumber', 'serial', 'deviceId', 'identifier']) || path.basename(record.filename, path.extname(record.filename))) === targetProfileId))
    : records;

  for (const record of selectedRecords) {
    if (record.candidates.some(hasProfileKey)) deviceJsonCounts.set(path.dirname(record.filename), (deviceJsonCounts.get(path.dirname(record.filename)) || 0) + 1);
  }

  for (const record of selectedRecords) {
    const companions = companionFiles(record.filename, names, deviceJsonCounts.get(path.dirname(record.filename)) || 0);
    const companionList = [...companions.deviceDescription, ...companions.featureMapping];
    const keyedCandidates = record.candidates.filter(hasProfileKey);
    const looksLikeDevice = record.candidates.some(candidate => first(candidate, ['haId', 'haID', 'id', 'serialNumber', 'serial', 'deviceId', 'identifier', 'name', 'deviceName'])) || companionList.length > 0;
    if (!keyedCandidates.length) {
      if (looksLikeDevice) errors.push(issue(
        'LOCAL_PROFILE_KEY_MISSING',
        `The appliance profile ${record.source} does not contain a PSK.`,
        `Das Geräteprofil „${record.source}“ enthält keinen PSK-Schlüssel. Bitte das Profil vollständig neu herunterladen.`,
        record.source
      ));
      continue;
    }
    const missing = [];
    if (!companions.deviceDescription.length) missing.push('DeviceDescription.xml');
    if (!companions.featureMapping.length) missing.push('FeatureMapping.xml');
    companionList.forEach(filename => usedCompanions.add(filename));
    if (missing.length) {
      errors.push(issue(
        'LOCAL_PROFILE_FILES_INCOMPLETE',
        `The appliance profile ${record.source} is incomplete; missing ${missing.join(' and ')}.`,
        `Das Geräteprofil „${record.source}“ ist unvollständig. Es fehlt: ${missing.join(' und ')}. Bitte die drei Dateien aus demselben Download zusammenlassen.`,
        record.source,
        { missing }
      ));
      if (options.requireComplete === true) continue;
    }
    let features;
    try { features = featuresFromCompanions(companions, directory); }
    catch (error) {
      errors.push(issue(error.code, error.message, `Begleitdatei zu „${record.source}“ ist ungültig.`, record.source));
      if (options.requireComplete === true) continue;
      features = {};
    }
    const base = path.basename(record.filename).replace(/\.json$/i, '');
    for (const candidate of keyedCandidates) {
      try {
        const preliminaryId = String(first(candidate, ['haId', 'haID', 'id', 'serialNumber', 'serial', 'deviceId', 'identifier']) || base);
        const profile = normalizeProfile(candidate, {
          id: base,
          filename: record.filename,
          rootDirectory: directory,
          features,
          mapping: mappings.get(preliminaryId),
          requireMapping: options.requireMapping === true || options.allowMissingHost === true,
          allowMissingHost: options.allowMissingHost === true
        });
        profiles.push(profile);
        groups.push({
          profileId: profile.haId,
          source: profile.source,
          deviceJson: profile.source,
          deviceDescription: companions.deviceDescription.map(value => path.relative(directory, value)),
          featureMapping: companions.featureMapping.map(value => path.relative(directory, value)),
          complete: missing.length === 0
        });
      } catch (error) {
        errors.push(issue(error.code, error.message, error.message, record.source));
      }
    }
  }

  for (const filename of (targetProfileId ? [] : names).filter(value => /(?:^|_)(?:DeviceDescription|FeatureMapping)\.(?:xml|json)$/i.test(path.basename(value)))) {
    if (usedCompanions.has(filename)) continue;
    const source = path.relative(directory, filename);
    errors.push(issue(
      'LOCAL_PROFILE_ORPHAN_COMPANION',
      `The companion file ${source} could not be assigned to an appliance JSON file.`,
      `Die Begleitdatei „${source}“ konnte keinem Geräte-JSON zugeordnet werden. Dateinamen und Ordner prüfen.`,
      source
    ));
  }
  return { profiles, groups, errors };
}

function resolveProfilePath(profilePath) {
  const filename = path.resolve(String(profilePath || '').trim());
  let stat;
  try { stat = fs.statSync(filename); }
  catch (cause) { throw new HomeConnectError('The local profile path cannot be read.', { code: 'LOCAL_PROFILE_PATH_UNREADABLE', cause }); }
  return { filename, stat };
}

function scanLocalProfileDirectory(profilePath) {
  if (!String(profilePath || '').trim()) throw new HomeConnectError('The local profile folder is required.', { code: 'LOCAL_PROFILE_PATH_REQUIRED' });
  const { filename, stat } = resolveProfilePath(profilePath);
  if (!stat.isDirectory()) throw new HomeConnectError('Automatic profile discovery requires a folder.', { code: 'LOCAL_PROFILE_FOLDER_REQUIRED' });
  const loaded = directoryProfiles(filename, { allowMissingHost: true, requireComplete: true });
  const byId = new Map();
  for (const profile of loaded.profiles) {
    if (!byId.has(profile.haId)) byId.set(profile.haId, []);
    byId.get(profile.haId).push(profile);
  }
  const duplicateIds = [...byId.entries()].filter(([, values]) => values.length > 1).map(([id]) => id);
  const errors = [...loaded.errors];
  for (const profileId of duplicateIds) {
    const sources = byId.get(profileId).map(profile => profile.source);
    errors.push(issue(
      'LOCAL_PROFILE_DUPLICATE',
      `Duplicate local appliance ID ${profileId}: ${sources.join(', ')}`,
      `Doppelte Profil-ID „${profileId}“ in ${sources.join(', ')}. Jede Profil-ID darf nur einmal vorkommen.`,
      sources[0],
      { profileId, sources }
    ));
  }
  const profiles = [...byId.entries()].filter(([, values]) => values.length === 1).map(([, values]) => values[0]);
  return {
    directory: filename,
    profiles: profiles.map(profile => {
      const group = loaded.groups.find(entry => entry.profileId === profile.haId && entry.source === profile.source) || {};
      return {
        profileId: profile.haId,
        name: profile.name,
        type: profile.type,
        brand: profile.brand,
        ...(profile.model ? { model: profile.model } : {}),
        displayLabel: formatDeviceLabel(profile),
        profileSource: profile.source,
        detectedHost: profile.detectedHost,
        detectedConnectionType: profile.automaticConnectionType,
        files: {
          deviceJson: group.deviceJson || profile.source,
          deviceDescription: group.deviceDescription || [],
          featureMapping: group.featureMapping || []
        }
      };
    }),
    errors,
    summary: {
      found: profiles.length,
      incomplete: errors.filter(error => ['LOCAL_PROFILE_FILES_INCOMPLETE', 'LOCAL_PROFILE_KEY_MISSING', 'LOCAL_PROFILE_ORPHAN_COMPANION'].includes(error.code)).length,
      duplicates: duplicateIds.length
    }
  };
}

function uniqueProfiles(profiles) {
  const unique = new Map();
  for (const profile of profiles) {
    if (unique.has(profile.haId)) throw new HomeConnectError(`Duplicate local appliance ID: ${profile.haId}`, { code: 'LOCAL_PROFILE_DUPLICATE' });
    unique.set(profile.haId, profile);
  }
  return [...unique.values()];
}

function loadLocalProfiles(options = {}) {
  const profiles = [];
  const mappings = parseLocalDeviceMappings(options.mappings);
  const mappingById = new Map(mappings.map(entry => [entry.profileId, entry]));
  const requireMapping = options.requireMapping === true;
  const targetProfileId = String(options.targetProfileId || '').trim();
  if (options.profileJson && String(options.profileJson).trim()) {
    for (const candidate of profileCandidates(parseJson(String(options.profileJson), 'credential'))) {
      const profileId = String(first(candidate, ['haId', 'haID', 'id', 'serialNumber', 'serial', 'deviceId', 'identifier']) || 'local-profile');
      if (targetProfileId && profileId !== targetProfileId) continue;
      profiles.push(normalizeProfile(candidate, { mapping: mappingById.get(profileId), requireMapping }));
    }
  }
  if (options.profilePath && String(options.profilePath).trim()) {
    const { filename, stat } = resolveProfilePath(options.profilePath);
    if (stat.isDirectory()) {
      const loaded = directoryProfiles(filename, { mappings, requireMapping, requireComplete: requireMapping, targetProfileId });
      profiles.push(...loaded.profiles);
      const fatalCodes = new Set([
        'LOCAL_MAPPING_HOST_REQUIRED', 'LOCAL_MAPPING_CONNECTION_INVALID', 'LOCAL_PROFILE_IV_MISSING',
        'LOCAL_PROFILE_FILES_INCOMPLETE', 'LOCAL_PROFILE_KEY_MISSING', 'LOCAL_PROFILE_ORPHAN_COMPANION'
      ]);
      const fatal = loaded.errors.find(error => fatalCodes.has(error.code) || String(error.code || '').startsWith('LOCAL_MAPPING_'));
      if (fatal || (!loaded.profiles.length && loaded.errors.length)) {
        const problem = fatal || loaded.errors[0];
        throw new HomeConnectError(problem.message, { code: problem.code });
      }
    } else {
      const parsed = parseJson(fs.readFileSync(filename, 'utf8'), path.basename(filename));
      for (const candidate of profileCandidates(parsed)) {
        const profileId = String(first(candidate, ['haId', 'haID', 'id', 'serialNumber', 'serial', 'deviceId', 'identifier']) || path.basename(filename, path.extname(filename)));
        if (targetProfileId && profileId !== targetProfileId) continue;
        profiles.push(normalizeProfile(candidate, { filename, mapping: mappingById.get(profileId), requireMapping }));
      }
    }
  }
  if (!profiles.length && targetProfileId) {
    throw new HomeConnectError(`The detected profile was not found: ${targetProfileId}`, { code: 'LOCAL_MAPPING_PROFILE_NOT_FOUND' });
  }
  if (!profiles.length) throw new HomeConnectError('No local appliance profiles were configured.', { code: 'LOCAL_PROFILE_REQUIRED' });
  const result = uniqueProfiles(profiles);
  if (requireMapping) {
    const profileIds = new Set(result.map(profile => profile.haId));
    const stale = mappings.find(mapping => !profileIds.has(mapping.profileId));
    if (stale) throw new HomeConnectError(`The local assignment refers to an unknown profile: ${stale.profileId}`, { code: 'LOCAL_MAPPING_PROFILE_NOT_FOUND' });
  }
  return result;
}

function profileCredential(profile) {
  return {
    id: profile.haId,
    name: profile.name,
    type: profile.type,
    brand: profile.brand,
    ...(profile.model ? { model: profile.model } : {}),
    host: profile.host,
    connectionType: profile.connectionType,
    psk64: profile.psk64,
    ...(profile.iv64 ? { iv64: profile.iv64 } : {}),
    features: profile.features
  };
}

function exportLocalProfileJson(options = {}) {
  const profiles = loadLocalProfiles({
    profilePath: options.profilePath,
    mappings: options.mappings,
    requireMapping: true
  });
  return JSON.stringify({ devices: profiles.map(profileCredential) }, null, 2);
}

function publicProfile(profile) {
  const value = {
    haId: profile.haId,
    name: profile.name,
    type: profile.type,
    brand: profile.brand,
    ...(profile.model ? { model: profile.model } : {}),
    host: profile.host,
    connectionType: profile.connectionType,
    profileSource: profile.source
  };
  return { ...value, displayLabel: formatDeviceLabel(value) };
}

module.exports = {
  loadLocalProfiles,
  normalizeProfile,
  profileConnectionType,
  parseFeatureXml,
  publicProfile,
  inferType,
  parseLocalDeviceMappings,
  scanLocalProfileDirectory,
  exportLocalProfileJson
};
