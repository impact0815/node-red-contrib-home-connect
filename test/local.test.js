'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter, once } = require('node:events');
const { AesMessageCrypto, hmac } = require('../lib/local-crypto');
const {
  HomeConnectWebSocketTransport, FrameDecoder, frame, privateIp, assertLocalHost, transportError,
  assertTlsPskSupport, WEBSOCKET_PATH
} = require('../lib/websocket-transport');
const { LocalConnectionDiagnostics } = require('../lib/local-diagnostics');
const {
  loadLocalProfiles,
  parseFeatureXml,
  parseLocalDeviceMappings,
  publicProfile,
  scanLocalProfileDirectory,
  exportLocalProfileJson
} = require('../lib/local-profile');
const {
  LocalHomeConnectClient,
  LocalApplianceSession,
  protocolResponseError,
  serviceVersions,
  acceptedResponseCode
} = require('../lib/local-client');
const { LocalProtocolTrace } = require('../lib/local-trace');
const { formatDeviceLabel } = require('../lib/device-label');
const { resolveLocalTestProfile } = require('../nodes/home-connect');

const realDeviceFixtures = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'local-real-devices.anonymized.json'),
  'utf8'
));
const dishwasherMandatoryFixture = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'sx678x36te-local-payload.anonymized.json'),
  'utf8'
));
const dishwasherEnumFixture = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'dishwasher-real-enum-payload.anonymized.json'),
  'utf8'
));

function serverEncryptor(psk, iv) {
  const encryptionKey = hmac(psk, Buffer.from('ENC'));
  const authenticationKey = hmac(psk, Buffer.from('MAC'));
  const cipher = crypto.createCipheriv('aes-256-cbc', encryptionKey, iv);
  cipher.setAutoPadding(false);
  let previous = Buffer.alloc(16);
  return value => {
    const clear = Buffer.from(value);
    let length = 16 - (clear.length % 16);
    if (length === 1) length += 16;
    const padding = Buffer.concat([Buffer.from([0]), Buffer.alloc(length - 2, 0x5a), Buffer.from([length])]);
    const ciphertext = cipher.update(Buffer.concat([clear, padding]));
    previous = hmac(authenticationKey, iv, Buffer.from([0x43]), previous, ciphertext).subarray(0, 16);
    return Buffer.concat([ciphertext, previous]);
  };
}

function serverDecryptor(psk, iv) {
  const encryptionKey = hmac(psk, Buffer.from('ENC'));
  const authenticationKey = hmac(psk, Buffer.from('MAC'));
  const decipher = crypto.createDecipheriv('aes-256-cbc', encryptionKey, iv);
  decipher.setAutoPadding(false);
  let previous = Buffer.alloc(16);
  return value => {
    const frame = Buffer.from(value);
    const ciphertext = frame.subarray(0, -16);
    const received = frame.subarray(-16);
    const expected = hmac(authenticationKey, iv, Buffer.from([0x45]), previous, ciphertext).subarray(0, 16);
    assert.deepEqual(received, expected);
    previous = Buffer.from(received);
    const clear = decipher.update(ciphertext);
    return clear.subarray(0, -clear.at(-1)).toString('utf8');
  };
}

test('AES local transport derives keys, keeps CBC/HMAC state and fails closed on tampering', () => {
  const psk = Buffer.alloc(32, 0x11);
  const iv = Buffer.alloc(16, 0x22);
  const receiver = new AesMessageCrypto({ psk, iv, randomBytes: length => Buffer.alloc(length, 0x33) });
  const encryptIncoming = serverEncryptor(psk, iv);
  assert.equal(receiver.decrypt(encryptIncoming('{"one":1}')), '{"one":1}');
  assert.equal(receiver.decrypt(encryptIncoming('{"two":2}')), '{"two":2}');

  const sender = new AesMessageCrypto({ psk, iv, randomBytes: length => Buffer.alloc(length, 0x44) });
  const outbound = sender.encrypt('{"read":true}');
  const ciphertext = outbound.subarray(0, -16);
  const expected = hmac(hmac(psk, Buffer.from('MAC')), iv, Buffer.from([0x45]), Buffer.alloc(16), ciphertext).subarray(0, 16);
  assert.deepEqual(outbound.subarray(-16), expected);

  const tampered = encryptIncoming('{"bad":true}');
  tampered[0] ^= 1;
  assert.throws(() => receiver.decrypt(tampered), { code: 'LOCAL_CRYPTO_AUTH_FAILED' });
});

test('minimal RFC6455 codec handles masked text and control frames', async () => {
  const decoder = new FrameDecoder();
  const message = once(decoder, 'message');
  decoder.push(frame(0x1, Buffer.from('hello'), true));
  const [payload, binary] = await message;
  assert.equal(payload.toString(), 'hello');
  assert.equal(binary, false);
  const ping = once(decoder, 'ping');
  decoder.push(frame(0x9, Buffer.from('x'), false));
  assert.equal((await ping)[0].toString(), 'x');
});

test('WebSocket upgrade matches websocket-client headers on the exact /homeconnect path', async () => {
  const socket = new EventEmitter();
  socket.destroyed = false;
  socket.off = socket.removeListener.bind(socket);
  socket.destroy = () => { socket.destroyed = true; };
  socket.write = request => {
    socket.request = String(request);
    const key = socket.request.match(/Sec-WebSocket-Key: ([^\r\n]+)/)[1];
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    queueMicrotask(() => socket.emit('data', Buffer.from(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
    )));
    return true;
  };
  const transport = new HomeConnectWebSocketTransport({
    host: '192.168.1.20', mode: 'AES', psk64: Buffer.alloc(32, 1).toString('base64url')
  });
  transport.socket = socket;
  await transport._upgrade();
  assert.match(socket.request, new RegExp(`^GET ${WEBSOCKET_PATH} HTTP/1\\.1\\r\\n`));
  assert.match(socket.request, /\r\nUpgrade: websocket\r\n/);
  assert.match(socket.request, /\r\nHost: 192\.168\.1\.20\r\n/);
  assert.match(socket.request, /\r\nOrigin: http:\/\/192\.168\.1\.20\r\n/);
  assert.match(socket.request, /\r\nSec-WebSocket-Version: 13\r\n/);
  assert.match(socket.request, /\r\nConnection: Upgrade\r\n\r\n$/);
});

test('WebSocket rejection retains the HTTP status as a single actionable root cause', async () => {
  const socket = new EventEmitter();
  socket.destroyed = false;
  socket.off = socket.removeListener.bind(socket);
  socket.destroy = () => { socket.destroyed = true; };
  socket.write = () => queueMicrotask(() => socket.emit('data', Buffer.from('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n')));
  const transport = new HomeConnectWebSocketTransport({
    host: '192.168.1.20', mode: 'AES', psk64: Buffer.alloc(32, 1).toString('base64url')
  });
  transport.socket = socket;
  await assert.rejects(() => transport._upgrade(), error => {
    assert.equal(error.code, 'LOCAL_WEBSOCKET_UPGRADE_FAILED');
    assert.equal(error.details.httpStatus, 403);
    assert.equal(error.details.path, '/homeconnect');
    return true;
  });
  assert.equal(socket.destroyed, true);
});

test('TLS diagnostics reject a runtime without any configured PSK cipher', () => {
  assert.throws(() => assertTlsPskSupport('NOT-A-REAL-PSK-CIPHER'), { code: 'LOCAL_TLS_PSK_UNAVAILABLE' });
});

test('local host guard accepts private/link-local addresses and rejects public DNS results', async () => {
  assert.equal(privateIp('192.168.10.3'), true);
  assert.equal(privateIp('10.0.0.2'), true);
  assert.equal(privateIp('fe80::1'), true);
  assert.equal(privateIp('8.8.8.8'), false);
  assert.equal(privateIp('127.0.0.1'), false);
  assert.equal(privateIp('::1'), false);
  assert.equal(await assertLocalHost('appliance.local', async () => [{ address: '192.168.1.20' }]), 'appliance.local');
  await assert.rejects(() => assertLocalHost('example.invalid', async () => [{ address: '203.0.113.10' }]), { code: 'LOCAL_HOST_NOT_PRIVATE' });
});

test('profile import supports downloader-style JSON/XML without exposing keys', () => {
  const xml = '<features><feature uid="0200" name="BSH.Common.Status.OperationState"><value key="1" name="Inactive"/><value key="3" name="Run"/></feature></features>';
  const features = parseFeatureXml(xml);
  assert.equal(features['512'].name, 'BSH.Common.Status.OperationState');
  assert.equal(features['512'].values['3'], 'Run');
  const profileJson = JSON.stringify({
    devices: [{ id: 'dishwasher-local', host: '192.168.1.30', connectionType: 'AES', psk64: 'ERERERERERERERERERERERERERERERERERERERERERE', iv64: 'IiIiIiIiIiIiIiIiIiIiIg', name: 'Kitchen Dishwasher', features }]
  });
  const [profile] = loadLocalProfiles({ profileJson });
  assert.equal(profile.type, 'Dishwasher');
  assert.equal(profile.connectionType, 'AES');
  assert.deepEqual(publicProfile(profile), {
    haId: 'dishwasher-local', name: 'Kitchen Dishwasher', type: 'Dishwasher', brand: 'Siemens',
    host: '192.168.1.30', connectionType: 'AES', profileSource: 'credential-json',
    displayLabel: 'Dishwasher — Kitchen Dishwasher — Siemens — …ocal'
  });
  assert.equal(JSON.stringify(publicProfile(profile)).includes('ERER'), false);
});

test('real FeatureMapping and DeviceDescription shapes resolve hex UIDs, enum references and categories', () => {
  const featureMapping = `
    <featureMapping xmlns="urn:bsh:homeconnect:featuremapping">
      <features>
        <feature refUID="0x0003">BSH.Common.Status.OperationState</feature>
        <feature refUID="0x0005">BSH.Common.Status.DoorState</feature>
        <feature refUID="0x0015">BSH.Common.Setting.PowerState</feature>
        <feature refUID="0x0100">BSH.Common.Root.ActiveProgram</feature>
        <feature refUID="0x0101">BSH.Common.Root.SelectedProgram</feature>
        <feature refUID="0x0203">BSH.Common.Option.RemainingProgramTime</feature>
        <feature refUID="0x2100">Dishcare.Dishwasher.Program.Eco50</feature>
      </features>
      <errors />
      <enumerations>
        <enumeration refENID="0x0001" enumKey="BSH.Common.EnumType.OperationState">
          <enumMember refValue="1">BSH.Common.EnumType.OperationState.Inactive</enumMember>
          <enumMember refValue="3">BSH.Common.EnumType.OperationState.Run</enumMember>
        </enumeration>
        <enumeration refENID="0x0002" enumKey="BSH.Common.EnumType.DoorState">
          <enumMember refValue="0">BSH.Common.EnumType.DoorState.Closed</enumMember>
          <enumMember refValue="1">BSH.Common.EnumType.DoorState.Open</enumMember>
        </enumeration>
        <enumeration refENID="0x0003" enumKey="BSH.Common.EnumType.PowerState">
          <enumMember refValue="1">BSH.Common.EnumType.PowerState.On</enumMember>
        </enumeration>
      </enumerations>
    </featureMapping>`;
  const deviceDescription = `
    <deviceDescription xmlns="urn:bsh:homeconnect:devicedescription">
      <status uid="0x0003" access="read" enumerationType="0x0001" />
      <status uid="0x0005" access="read" enumerationType="0x0002" />
      <settings><setting uid="0x0015" access="read" enumerationType="0x0003" /></settings>
      <options>
        <option uid="0x0100" access="read" type="Int" />
        <option uid="0x0101" access="read" type="Int" />
        <option uid="0x0203" access="read" type="Int" unit="seconds" />
      </options>
      <programs><program uid="0x2100" access="read" /></programs>
    </deviceDescription>`;
  const features = parseFeatureXml(deviceDescription, featureMapping);
  assert.equal(features['3'].name, 'BSH.Common.Status.OperationState');
  assert.equal(features['3'].values['3'], 'BSH.Common.EnumType.OperationState.Run');
  assert.equal(features['3'].category, 'status');
  assert.equal(features['21'].category, 'setting');
  assert.equal(features['515'].unit, 'seconds');
  assert.equal(features['8448'].name, 'Dishcare.Dishwasher.Program.Eco50');
  assert.equal(Object.hasOwn(features, '0x0003'), false);
});

test('DeviceDescription comment enums resolve raw zero and profile-typed booleans without global mappings', () => {
  const featureMapping = `
    <featureMapping><features>
      <feature refUID="0003">BSH.Common.Status.OperationState</feature>
      <feature refUID="0005">BSH.Common.Status.DoorState</feature>
      <feature refUID="0006">BSH.Common.Status.RemoteControlActive</feature>
      <feature refUID="0007">BSH.Common.Status.RemoteControlStartAllowed</feature>
      <feature refUID="0008">BSH.Common.Status.LocalControlActive</feature>
      <feature refUID="0100">BSH.Common.Root.ActiveProgram</feature>
      <feature refUID="0101">BSH.Common.Root.SelectedProgram</feature>
      <feature refUID="0203">BSH.Common.Option.RemainingProgramTime</feature>
      <feature refUID="0204">Dishcare.Dishwasher.Option.VarioSpeedPlus</feature>
      <feature refUID="2100">Dishcare.Dishwasher.Program.Intensiv70</feature>
    </features></featureMapping>`;
  const deviceDescription = `
    <deviceDescription>
      <!--BSH.Common.EnumType.OperationState -->
      <enumerationtype enid="0203">
        <!--Inactive --><enumeration value="0"></enumeration>
        <!--Ready --><enumeration value="1"></enumeration>
        <!--Run --><enumeration value="3"></enumeration>
      </enumerationtype>
      <!--BSH.Common.EnumType.DoorState -->
      <enumerationtype enid="0204">
        <!--Closed --><enumeration value="0"></enumeration>
        <!--Open --><enumeration value="1"></enumeration>
      </enumerationtype>
      <status uid="0003" type="Int" enumerationType="0203" access="read" />
      <status uid="0005" type="Int" enumerationType="0204" access="read" />
      <status uid="0006" type="Boolean" access="read" />
      <status uid="0007" type="Boolean" access="read" />
      <status uid="0008" type="Boolean" access="read" />
      <option uid="0100" type="Int" access="read" />
      <option uid="0101" type="Int" access="read" />
      <option uid="0203" type="Int" unit="seconds" access="read" />
      <option uid="0204" type="Boolean" access="read" />
      <program uid="2100" access="read" />
    </deviceDescription>`;
  const features = parseFeatureXml(deviceDescription, featureMapping);
  assert.equal(features['3'].values['0'], 'BSH.Common.EnumType.OperationState.Inactive');
  assert.equal(features['5'].values['0'], 'BSH.Common.EnumType.DoorState.Closed');
  assert.equal(features['3'].enumSource, 'device-description');

  const session = new LocalApplianceSession({
    haId: 'profile-only', host: '192.168.4.72', connectionType: 'TLS',
    psk64: Buffer.alloc(32, 1).toString('base64url'), name: 'Dishwasher', type: 'Dishwasher', brand: 'Siemens', features
  }, { autoRefresh: false });
  assert.deepEqual(
    [session.item(3, 0).value, session.item(5, 0).value],
    ['BSH.Common.EnumType.OperationState.Inactive', 'BSH.Common.EnumType.DoorState.Closed']
  );
  assert.equal(session.item(6, 1).value, true);
  assert.equal(session.item(7, 0).value, false);
  assert.equal(session.item(8, 0).value, false);
  assert.equal(session.item(515, 3720).unit, 'seconds');
  assert.equal(session.item(516, 1).value, true);
  assert.equal(session.item(3, 99).valueResolved, false);
  assert.equal(session.item(3, 99).rawValue, 99);

  session._applyResource({ resource: '/ro/allMandatoryValues', action: 'RESPONSE', data: [
    { uid: 3, value: 0 }, { uid: 5, value: 0 }, { uid: 6, value: 1 }, { uid: 7, value: 0 },
    { uid: 8, value: 0 }, { uid: 256, value: 8448 }, { uid: 257, value: 8448 },
    { uid: 515, value: 3720 }, { uid: 516, value: 1 }
  ] });
  const programs = session.programState();
  assert.equal(programs.active.key, 'Dishcare.Dishwasher.Program.Intensiv70');
  assert.equal(programs.selected.key, 'Dishcare.Dishwasher.Program.Intensiv70');
  assert.equal(programs.options.find(item => item.key === 'BSH.Common.Option.RemainingProgramTime').value, 3720);
  assert.equal(programs.options.find(item => item.key === 'Dishcare.Dishwasher.Option.VarioSpeedPlus').value, true);
  session.close();
});

test('real dishwasher nested enum references outrank scalar fallback across snapshot and event values', () => {
  const features = parseFeatureXml(dishwasherEnumFixture.deviceDescription, dishwasherEnumFixture.featureMapping);
  assert.equal(features['3'].enumerationType, String(Number.parseInt('0203', 16)));
  assert.equal(features['5'].enumerationType, String(Number.parseInt('0205', 16)));
  assert.equal(features['5'].values['1'], 'BSH.Common.EnumType.DoorState.Open');
  assert.equal(features['21'].values['1'], 'BSH.Common.EnumType.PowerState.On');
  assert.equal(features['22'].values['7'], 'BSH.Common.EnumType.Language.DE');
  assert.equal(features['35'].values['4'], 'Dishcare.Dishwasher.EnumType.ProgramPhase.Cleaning');

  const session = new LocalApplianceSession({
    haId: 'real-enum-dishwasher', host: '192.168.4.72', connectionType: 'TLS',
    psk64: Buffer.alloc(32, 1).toString('base64url'), name: 'Dishwasher', type: 'Dishwasher',
    brand: 'Siemens', features
  }, { autoRefresh: false });
  session._applyResource({
    resource: '/ro/allMandatoryValues', action: 'RESPONSE', data: dishwasherEnumFixture.items
  });
  const items = new Map(session.items().map(item => [item.key, item]));
  for (const [key, value] of Object.entries(dishwasherEnumFixture.expected)) {
    assert.equal(items.get(key).value, value, key);
    assert.equal(items.get(key).valueResolved, true, key);
    assert.notEqual(items.get(key).resolution, 'profile-scalar', key);
  }
  assert.equal(items.get('BSH.Common.Status.OperationState').rawValue, 0);
  assert.equal(items.get('BSH.Common.Status.DoorState').resolution, 'profile-enum');
  assert.equal(items.get('BSH.Common.Status.RemoteControlActive').value, true);
  assert.equal(items.get('BSH.Common.Status.RemoteControlStartAllowed').value, false);
  assert.equal(items.get('BSH.Common.Status.LocalControlActive').value, false);

  const unresolvedEvent = items.get('Dishcare.Dishwasher.Event.RinseAidNearlyEmpty');
  assert.equal(unresolvedEvent.value, 9);
  assert.equal(unresolvedEvent.rawValue, 9);
  assert.equal(unresolvedEvent.valueResolved, false);
  assert.equal(unresolvedEvent.resolution, 'unresolved-enum');
  assert.equal(session.programState().selected.key, 'Dishcare.Dishwasher.Program.Auto2');
  session.close();
});

test('declared TLS/PSK transport wins over a retained IV while Auto uses IV only as fallback', () => {
  const base = {
    id: 'declared-transport', host: '192.168.1.25',
    psk64: Buffer.alloc(32, 1).toString('base64url'), iv64: Buffer.alloc(16, 2).toString('base64url')
  };
  assert.equal(loadLocalProfiles({ profileJson: JSON.stringify({ ...base, connectionType: 'TLS-PSK' }) })[0].connectionType, 'TLS');
  assert.equal(loadLocalProfiles({ profileJson: JSON.stringify(base) })[0].connectionType, 'AES');
});

test('profile folder scan groups companion files and applies one central host mapping', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-profiles-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const nested = path.join(root, 'download', 'appliances');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, 'SN123.json'), JSON.stringify({
    id: 'dishwasher-local',
    name: 'Kitchen Dishwasher',
    host: '192.168.1.30',
    psk64: 'ERERERERERERERERERERERERERERERERERERERERERE',
    iv64: 'IiIiIiIiIiIiIiIiIiIiIg'
  }));
  fs.writeFileSync(path.join(nested, 'SN123_DeviceDescription.xml'), '<features><feature uid="0200" name="BSH.Common.Status.OperationState"/></features>');
  fs.writeFileSync(path.join(nested, 'SN123_FeatureMapping.xml'), '<features><feature uid="2000" name="Dishcare.Dishwasher.Program.Auto"/></features>');
  fs.writeFileSync(path.join(root, 'unrelated.json'), JSON.stringify({ hello: 'world' }));

  const scan = scanLocalProfileDirectory(root);
  assert.equal(scan.profiles.length, 1);
  assert.deepEqual(scan.profiles[0], {
    profileId: 'dishwasher-local',
    name: 'Kitchen Dishwasher',
    type: 'Dishwasher',
    brand: 'Siemens',
    displayLabel: 'Dishwasher — Kitchen Dishwasher — Siemens — …ocal',
    profileSource: path.join('download', 'appliances', 'SN123.json'),
    detectedHost: '192.168.1.30',
    detectedConnectionType: 'AES',
    files: {
      deviceJson: path.join('download', 'appliances', 'SN123.json'),
      deviceDescription: [path.join('download', 'appliances', 'SN123_DeviceDescription.xml')],
      featureMapping: [path.join('download', 'appliances', 'SN123_FeatureMapping.xml')]
    }
  });
  assert.equal(JSON.stringify(scan).includes('ERERER'), false);

  const mappings = [{ profileId: 'dishwasher-local', host: '192.168.1.77', connectionType: 'auto' }];
  const [profile] = loadLocalProfiles({ profilePath: root, mappings, requireMapping: true });
  assert.equal(profile.host, '192.168.1.77');
  assert.equal(profile.connectionType, 'AES');
  assert.equal(profile.features['512'].name, 'BSH.Common.Status.OperationState');
  assert.equal(profile.features['8192'].name, 'Dishcare.Dishwasher.Program.Auto');
  const [overridden] = loadLocalProfiles({
    profilePath: root,
    mappings: [{ profileId: 'dishwasher-local', host: '192.168.1.77', connectionType: 'TLS' }],
    requireMapping: true
  });
  assert.equal(overridden.connectionType, 'TLS');
  assert.throws(() => loadLocalProfiles({ profilePath: root, mappings: [], requireMapping: true }), { code: 'LOCAL_MAPPING_HOST_REQUIRED' });

  const generated = JSON.parse(exportLocalProfileJson({ profilePath: root, mappings }));
  assert.equal(generated.devices.length, 1);
  assert.equal(generated.devices[0].id, 'dishwasher-local');
  assert.equal(generated.devices[0].host, '192.168.1.77');
  assert.equal(generated.devices[0].connectionType, 'AES');
  assert.equal(generated.devices[0].psk64.startsWith('ERER'), true);
});

test('scanner accepts one-device directory names and reports incomplete and duplicate profiles clearly', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-profile-groups-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const complete = path.join(root, 'complete');
  const incomplete = path.join(root, 'incomplete');
  const duplicate = path.join(root, 'duplicate');
  fs.mkdirSync(complete, { recursive: true });
  fs.mkdirSync(incomplete, { recursive: true });
  fs.mkdirSync(duplicate, { recursive: true });
  const profile = id => JSON.stringify({ id, name: id, psk64: 'ERERERERERERERERERERERERERERERERERERERERERE', iv64: 'IiIiIiIiIiIiIiIiIiIiIg' });
  fs.writeFileSync(path.join(complete, 'device.json'), profile('complete-one'));
  fs.writeFileSync(path.join(complete, 'DeviceDescription.xml'), '<features/>');
  fs.writeFileSync(path.join(complete, 'FeatureMapping.xml'), '<features/>');
  fs.writeFileSync(path.join(incomplete, 'missing.xml.json'), profile('incomplete-one'));
  fs.writeFileSync(path.join(incomplete, 'missing.xml_DeviceDescription.xml'), '<features/>');
  fs.writeFileSync(path.join(duplicate, 'a.json'), profile('duplicate-id'));
  fs.writeFileSync(path.join(duplicate, 'a_DeviceDescription.xml'), '<features/>');
  fs.writeFileSync(path.join(duplicate, 'a_FeatureMapping.xml'), '<features/>');
  fs.writeFileSync(path.join(duplicate, 'b.json'), profile('duplicate-id'));
  fs.writeFileSync(path.join(duplicate, 'b_DeviceDescription.xml'), '<features/>');
  fs.writeFileSync(path.join(duplicate, 'b_FeatureMapping.xml'), '<features/>');

  const scan = scanLocalProfileDirectory(root);
  assert.deepEqual(scan.profiles.map(value => value.profileId), ['complete-one']);
  assert.equal(scan.summary.found, 1);
  assert.equal(scan.summary.duplicates, 1);
  assert.ok(scan.errors.some(error => error.code === 'LOCAL_PROFILE_FILES_INCOMPLETE' && /unvollständig/.test(error.messageDe)));
  assert.ok(scan.errors.some(error => error.code === 'LOCAL_PROFILE_DUPLICATE' && /Doppelte Profil-ID/.test(error.messageDe)));
});

test('local device mappings accept Auto/AES/TLS and reject duplicates or arbitrary transports', () => {
  assert.deepEqual(parseLocalDeviceMappings('[{"profileId":"one","host":"192.168.1.2","connectionType":"Auto"}]'), [
    { profileId: 'one', host: '192.168.1.2', connectionType: 'auto' }
  ]);
  assert.throws(() => parseLocalDeviceMappings([
    { profileId: 'one', host: '192.168.1.2' },
    { profileId: 'one', host: '192.168.1.3' }
  ]), { code: 'LOCAL_MAPPING_DUPLICATE' });
  assert.throws(() => parseLocalDeviceMappings([
    { profileId: 'one', host: '192.168.1.2', connectionType: 'HTTP' }
  ]), { code: 'LOCAL_MAPPING_CONNECTION_INVALID' });
  assert.throws(() => parseLocalDeviceMappings([
    { profileId: 'one', host: '8.8.8.8', connectionType: 'auto' }
  ]), { code: 'LOCAL_HOST_NOT_PRIVATE' });
  assert.throws(() => parseLocalDeviceMappings([
    { profileId: 'one', host: 'http://192.168.1.2', connectionType: 'auto' }
  ]), { code: 'LOCAL_HOST_INVALID' });
});

test('single-device test uses the current card mapping and ignores unfilled sibling profiles', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-current-mapping-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const fixture of realDeviceFixtures) {
    const id = `fixture-${fixture.fixture}`;
    fs.writeFileSync(path.join(root, `${fixture.fixture}.json`), JSON.stringify({
      id,
      name: fixture.name,
      type: fixture.type,
      brand: fixture.brand,
      vib: fixture.model,
      connectionType: fixture.transport,
      psk64: 'ERERERERERERERERERERERERERERERERERERERERERE',
      ...(fixture.transport === 'AES' ? { iv64: 'IiIiIiIiIiIiIiIiIiIiIg' } : {})
    }));
    fs.writeFileSync(path.join(root, `${fixture.fixture}_DeviceDescription.xml`), '<features/>');
    fs.writeFileSync(path.join(root, `${fixture.fixture}_FeatureMapping.xml`), '<features/>');
  }
  const target = 'fixture-siemens-washer';
  const profile = resolveLocalTestProfile({
    profilePath: root,
    profileId: target,
    host: '192.168.50.77',
    connectionType: 'AES',
    mappings: [
      { profileId: 'fixture-siemens-dishwasher', host: '', connectionType: 'auto' },
      { profileId: target, host: '192.168.50.10', connectionType: 'TLS' },
      { profileId: 'fixture-siemens-oven', host: '', connectionType: 'auto' }
    ]
  });
  assert.equal(profile.haId, target);
  assert.equal(profile.host, '192.168.50.77');
  assert.equal(profile.connectionType, 'AES');
  assert.equal(profile.model, 'WM4YH740');
});

test('device labels keep full IDs as values but display type, friendly name, brand/model and a short suffix', () => {
  const appliances = [
    { type: 'Dishwasher', name: 'Geschirrspüler', brand: 'Siemens', model: 'SX678X36TE', haId: 'SYNTHETIC-DEVICE-4576' },
    { type: 'Washer', name: 'Waschmaschine', brand: 'Siemens', model: 'WM4YH740', haId: 'SYNTHETIC-DEVICE-029D' },
    { type: 'Oven', name: 'Backofen', brand: 'Siemens', model: 'HS658GXS7', haId: 'SYNTHETIC-DEVICE-9C7C' }
  ];
  assert.deepEqual(appliances.map(formatDeviceLabel), [
    'Dishwasher — Geschirrspüler — Siemens SX678X36TE — …4576',
    'Washer — Waschmaschine — Siemens WM4YH740 — …029D',
    'Oven — Backofen — Siemens HS658GXS7 — …9C7C'
  ]);
  assert.deepEqual(appliances.map(appliance => appliance.haId), [
    'SYNTHETIC-DEVICE-4576', 'SYNTHETIC-DEVICE-029D', 'SYNTHETIC-DEVICE-9C7C'
  ]);
});

test('anonymized real-device fixtures contain no network address, device identity or key material', () => {
  const text = JSON.stringify(realDeviceFixtures);
  assert.doesNotMatch(text, /(?:host|ipAddress|haId|serialNumber|deviceID|psk|iv64|encryptionKey)/i);
  assert.doesNotMatch(text, /(?:\d{1,3}\.){3}\d{1,3}|[A-F0-9]{12,}/i);
  assert.deepEqual(realDeviceFixtures.map(fixture => fixture.type), ['Dishwasher', 'Washer', 'Oven']);
});

test('transport failures distinguish network, profile-key and unsupported-protocol errors', () => {
  assert.equal(transportError(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }), 'TLS').code, 'LOCAL_NETWORK_ERROR');
  assert.equal(transportError(Object.assign(new Error('unknown psk identity'), { code: 'ERR_SSL_PSK_IDENTITY_NOT_FOUND' }), 'TLS').code, 'LOCAL_PROFILE_KEY_REJECTED');
  assert.equal(transportError(new Error('no shared cipher'), 'TLS').code, 'LOCAL_TRANSPORT_UNSUPPORTED');
});

test('an unreachable local appliance returns an offline snapshot instead of a generic read failure', async () => {
  class OfflineTransport extends EventEmitter {
    async connect() { throw Object.assign(new Error('host unreachable'), { code: 'EHOSTUNREACH' }); }
    close() {}
  }
  const client = new LocalHomeConnectClient({
    profiles: [{
      id: 'offline-washer', haId: 'offline-washer', host: '192.168.4.71', connectionType: 'TLS',
      psk64: Buffer.alloc(32, 0x11).toString('base64url'), name: 'Older washer', type: 'Washer',
      brand: 'Siemens', source: 'anonymized-fixture', features: {}
    }],
    autoRefresh: false,
    transportFactory: () => new OfflineTransport()
  });
  const snapshot = await client.read('offline-washer', 'snapshot');
  assert.equal(snapshot.appliance.connected, false);
  assert.equal(snapshot.connection.state, 'offline');
  assert.equal(snapshot.connection.offlineReason.code, 'LOCAL_NETWORK_ERROR');
  assert.equal(snapshot.local, true);
  assert.equal(snapshot.readOnly, true);
  assert.equal(Object.hasOwn(snapshot, 'error'), false);
  client.close();
});

class RealDeviceFixtureTransport extends EventEmitter {
  constructor(fixture, psk, iv) {
    super();
    this.fixture = fixture;
    this.sent = [];
    this.encrypt = fixture.transport === 'AES' ? serverEncryptor(psk, iv) : null;
    this.decrypt = fixture.transport === 'AES' ? serverDecryptor(psk, iv) : null;
  }
  wire(message) {
    const clear = Buffer.from(JSON.stringify(message));
    return this.encrypt ? [this.encrypt(clear), true] : [clear, false];
  }
  async connect() {
    queueMicrotask(() => this.emit('message', ...this.wire({
      sID: 17,
      msgID: 1,
      resource: '/ei/initialValues',
      version: this.fixture.initialVersion,
      action: 'POST',
      data: [{ edMsgID: 100 }]
    })));
  }
  respond(request, data, code) {
    queueMicrotask(() => this.emit('message', ...this.wire({
      sID: request.sID,
      msgID: request.msgID,
      resource: request.resource,
      version: request.version,
      action: 'RESPONSE',
      ...(data !== undefined ? { data } : {}),
      ...(code !== undefined ? { code } : {})
    })));
  }
  send(payload, binary) {
    assert.equal(binary, this.fixture.transport === 'AES');
    const clear = this.decrypt ? this.decrypt(payload) : Buffer.from(payload).toString('utf8');
    const message = JSON.parse(clear);
    this.sent.push(message);
    if (message.action === 'RESPONSE' || message.action === 'NOTIFY') return;
    if (message.resource === '/ci/services') {
      if (this.fixture.rejectsEmptyDataOnCiServices && Object.hasOwn(message, 'data')) return this.respond(message, undefined, 400);
      const entries = Object.entries(this.fixture.services).map(([service, version]) => ({ service, version }));
      return this.respond(message, this.fixture.servicesShape === 'nested' ? { services: entries } : entries);
    }
    if (message.resource === '/ci/authentication') {
      const expected = this.fixture.authentication;
      if (!expected || message.action !== expected.action || message.version !== expected.version || !message.data?.[0]?.nonce) {
        return this.respond(message, undefined, 400);
      }
      return this.respond(message, [{ authenticated: true }]);
    }
    if (message.resource === '/ro/values') return this.respond(message, this.fixture.values);
    return this.respond(message, []);
  }
  close() { this.emit('close'); }
}

test('Siemens dishwasher, washer and oven fixtures accept parameterless /ci/services and negotiated handshakes', async () => {
  const psk = Buffer.alloc(32, 0x11);
  const iv = Buffer.alloc(16, 0x22);
  for (const fixture of realDeviceFixtures) {
    const transports = [];
    const id = `fixture-${fixture.fixture}`;
    const client = new LocalHomeConnectClient({
      profiles: [{
        id,
        haId: id,
        host: '192.168.50.20',
        connectionType: fixture.transport,
        psk64: psk.toString('base64url'),
        ...(fixture.transport === 'AES' ? { iv64: iv.toString('base64url') } : {}),
        name: fixture.name,
        type: fixture.type,
        brand: fixture.brand,
        model: fixture.model,
        source: 'anonymized-fixture',
        features: { 512: { name: 'BSH.Common.Status.OperationState' } }
      }],
      requestTimeout: 1000,
      transportFactory: () => {
        const transport = new RealDeviceFixtureTransport(fixture, psk, iv);
        transports.push(transport);
        return transport;
      }
    });
    const snapshot = await client.read(id, 'snapshot');
    assert.equal(snapshot.appliance.type, fixture.type);
    assert.equal(snapshot.transport, fixture.transport);
    assert.deepEqual(snapshot.services, fixture.services);
    const servicesRequest = transports[0].sent.find(message => message.resource === '/ci/services');
    assert.ok(servicesRequest);
    assert.equal(servicesRequest.action, 'GET');
    assert.equal(servicesRequest.version, 1);
    assert.equal(Object.hasOwn(servicesRequest, 'data'), false);
    const ready = transports[0].sent.find(message => message.resource === '/ei/deviceReady');
    assert.equal(ready.version, fixture.services.ei);
    assert.equal(Object.hasOwn(ready, 'data'), false);
    assert.ok(transports[0].sent.every(message => ['GET', 'POST', 'NOTIFY', 'RESPONSE'].includes(message.action)));
    client.close();
  }
});

test('service negotiation accepts both flat and nested response structures', () => {
  assert.deepEqual(serviceVersions({ data: [{ service: 'CI', version: '3' }, { service: 'ro', version: 2 }] }), { ci: 3, ro: 2 });
  assert.deepEqual(serviceVersions({ data: { services: [{ name: '/ei', serviceVersion: 2 }] } }), { ei: 2 });
});

test('device code 400 is reported as a rejected protocol request with safe request metadata', () => {
  const error = protocolResponseError(
    { resource: '/ci/services', code: 400 },
    { resource: '/ci/services', action: 'GET', version: 1 }
  );
  assert.equal(error.code, 'LOCAL_PROTOCOL_REJECTED');
  assert.equal(error.status, 400);
  assert.equal(error.details.resource, '/ci/services');
  assert.equal(error.details.action, 'GET');
  assert.equal(error.details.version, 1);
  assert.equal(error.details.deviceCode, 400);
  assert.equal(error.details.category, 'protocol');
});

class FakeTransport extends EventEmitter {
  constructor() { super(); this.sent = []; }
  async connect() {
    queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify({
      sID: 7, msgID: 1, resource: '/ei/initialValues', version: 2, action: 'POST', data: [{ edMsgID: 40 }]
    })), false));
  }
  send(payload, binary) {
    assert.equal(binary, false);
    const message = JSON.parse(Buffer.from(payload).toString());
    this.sent.push(message);
    if (message.action !== 'GET') return;
    const data = {
      '/ci/services': [{ service: 'ci', version: 3 }, { service: 'ei', version: 2 }, { service: 'ni', version: 1 }, { service: 'ro', version: 1 }],
      '/ni/info': [{ interfaceID: 1 }],
      '/ro/values': [{ uid: 512, value: 3 }, { uid: 513, value: 1 }],
      '/ro/allDescriptionChanges': [],
      '/ro/allMandatoryValues': [],
      '/ro/activeProgram': [{ program: 8192, options: [] }],
      '/ro/selectedProgram': [{ program: 8192, options: [] }]
    }[message.resource] || [];
    queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify({
      sID: message.sID, msgID: message.msgID, resource: message.resource,
      version: message.version, action: 'RESPONSE', data
    })), false));
  }
  close() { this.emit('close'); }
}

test('local client performs read-only handshake and maps Siemens appliance state', async () => {
  const transports = [];
  const client = new LocalHomeConnectClient({
    profiles: [{
      id: 'washer-local', haId: 'washer-local', host: '192.168.1.31', connectionType: 'TLS',
      psk64: 'ERERERERERERERERERERERERERERERERERERERERERE', name: 'Utility Washer', type: 'Washer', brand: 'Siemens', source: 'test',
      features: {
        512: { name: 'BSH.Common.Status.OperationState', values: { 3: 'Run' } },
        513: { name: 'BSH.Common.Setting.PowerState', values: { 1: 'On' } },
        8192: { name: 'LaundryCare.Washer.Program.Cotton' }
      }
    }],
    identity: 'test-node', requestTimeout: 1000,
    transportFactory: () => { const transport = new FakeTransport(); transports.push(transport); return transport; }
  });
  const snapshot = await client.read('washer-local', 'snapshot');
  assert.equal(snapshot.local, true);
  assert.equal(snapshot.readOnly, true);
  assert.deepEqual(snapshot.status.items.map(item => [item.key, item.value]), [['BSH.Common.Status.OperationState', 'Run']]);
  assert.deepEqual(snapshot.settings.items.map(item => [item.key, item.value]), [['BSH.Common.Setting.PowerState', 'On']]);
  assert.equal(snapshot.programs.available[0].key, 'LaundryCare.Washer.Program.Cotton');
  assert.ok(transports[0].sent.every(message => ['GET', 'NOTIFY', 'RESPONSE'].includes(message.action)));
  assert.ok(transports[0].sent.some(message => message.resource === '/ro/values' && message.action === 'GET'));
  await assert.rejects(() => client.write({}), { code: 'LOCAL_READ_ONLY' });

  const received = [];
  const close = client.openEvents('washer-local', event => received.push(event));
  const transport = transports[0];
  transport.emit('message', Buffer.from(JSON.stringify({
    sID: 7, msgID: 99, resource: '/ro/values', version: 1, action: 'NOTIFY', data: [{ uid: 512, value: 3 }]
  })), false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(received.at(-1).connection.readOnly, true);
  close();
  client.close();
});

class ValuesRejectedTransport extends FakeTransport {
  constructor(options) {
    super();
    this.onStage = options.onStage;
  }
  async connect() {
    this.onStage('transport-recognized', { transport: 'TLS', port: 443, path: '/homeconnect' });
    this.onStage('ip-reachable', { transport: 'TLS', port: 443, path: '/homeconnect' });
    this.onStage('websocket-connected', { transport: 'TLS', port: 443, path: '/homeconnect' });
    return super.connect();
  }
  send(payload, binary) {
    const message = JSON.parse(Buffer.from(payload).toString('utf8'));
    if (message.resource !== '/ro/values') return super.send(payload, binary);
    this.sent.push(message);
    queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify({
      sID: message.sID, msgID: message.msgID, resource: message.resource,
      version: message.version, action: 'RESPONSE', code: 400
    })), false));
  }
}

test('connection test tolerates one rejected read resource when other read-only responses succeed', async () => {
  const diagnostics = new LocalConnectionDiagnostics();
  diagnostics.pass('profile-loaded', { transport: 'TLS' });
  const client = new LocalHomeConnectClient({
    profiles: [{
      id: 'reject-values', haId: 'reject-values', host: '192.168.1.31', connectionType: 'TLS',
      psk64: Buffer.alloc(32, 0x11).toString('base64url'), pskIdentity: 'HCCOM_Local_App',
      name: 'Test appliance', type: 'Washer', brand: 'Siemens', source: 'test', features: {}
    }],
    requestTimeout: 1000,
    diagnostics,
    autoRefresh: false,
    transportFactory: options => new ValuesRejectedTransport(options)
  });
  const snapshot = await client.testConnection('reject-values');
  assert.equal(snapshot.refresh.find(item => item.resource === '/ro/values').code, 'LOCAL_PROTOCOL_REJECTED');
  assert.ok(snapshot.refresh.some(item => item.ok));
  const stages = diagnostics.snapshot();
  assert.deepEqual(stages.map(stage => stage.id), [
    'ip-reachable', 'profile-loaded', 'transport-recognized', 'websocket-connected',
    'session-initialized', 'services-recognized', 'readonly-data-received'
  ]);
  assert.equal(stages.find(stage => stage.id === 'readonly-data-received').status, 'ok');
  client.close();
});

class MandatoryDishwasherTransport extends EventEmitter {
  constructor(fixture, psk, iv) {
    super();
    this.fixture = fixture;
    this.sent = [];
    this.encrypt = serverEncryptor(psk, iv);
    this.decrypt = serverDecryptor(psk, iv);
  }
  wire(message) { return [this.encrypt(Buffer.from(JSON.stringify(message))), true]; }
  async connect() {
    queueMicrotask(() => this.emit('message', ...this.wire({
      sID: 31, msgID: 7, resource: '/ei/initialValues', version: 2, action: 'POST', data: [{ edMsgID: 600 }]
    })));
  }
  response(request, data, code) {
    queueMicrotask(() => this.emit('message', ...this.wire({
      sID: request.sID, msgID: request.msgID, resource: request.resource,
      version: request.version, action: 'RESPONSE',
      ...(data !== undefined ? { data } : {}), ...(code !== undefined ? { code } : {})
    })));
  }
  send(payload, binary) {
    assert.equal(binary, true);
    const message = JSON.parse(this.decrypt(payload));
    this.sent.push(message);
    if (message.action === 'RESPONSE' || message.action === 'NOTIFY') return;
    if (message.resource === '/ci/services') {
      return this.response(message, Object.entries(this.fixture.services).map(([service, version]) => ({ service, version })), 200);
    }
    if (message.resource === '/ci/authentication') return this.response(message, [{ authenticated: true }], 200);
    if (message.resource === '/ci/info') return this.response(message, [{ deviceType: 'Dishwasher' }], 200);
    const configured = this.fixture.resources[message.resource];
    if (!configured) return this.response(message, [], 200);
    return this.response(message, configured.items, configured.code);
  }
  notify(uid, value) {
    this.emit('message', ...this.wire({
      sID: 31, msgID: 999, resource: '/ro/values', version: 1, action: 'NOTIFY', data: [{ uid, value }]
    }));
  }
  close() { this.emit('close'); }
}

test('SX678X36TE-style 89-item mandatory snapshot survives unsupported reads and updates through NOTIFY', async () => {
  const featureMapping = `
    <featureMapping><features>
      <feature refUID="0x0003">BSH.Common.Status.OperationState</feature>
      <feature refUID="0x0005">BSH.Common.Status.DoorState</feature>
      <feature refUID="0x0015">BSH.Common.Setting.PowerState</feature>
      <feature refUID="0x0100">BSH.Common.Root.ActiveProgram</feature>
      <feature refUID="0x0101">BSH.Common.Root.SelectedProgram</feature>
      <feature refUID="0x0203">BSH.Common.Option.RemainingProgramTime</feature>
      <feature refUID="0x2100">Dishcare.Dishwasher.Program.Eco50</feature>
    </features><errors/><enumerations>
      <enumeration refENID="0x0002" enumKey="DoorState">
        <enumMember refValue="0">BSH.Common.EnumType.DoorState.Closed</enumMember>
      </enumeration>
      <enumeration refENID="0x0003" enumKey="PowerState">
        <enumMember refValue="1">BSH.Common.EnumType.PowerState.On</enumMember>
      </enumeration>
    </enumerations></featureMapping>`;
  const deviceDescription = `
    <deviceDescription>
      <!--BSH.Common.EnumType.OperationState -->
      <enumerationtype enid="0203">
        <!--Inactive --><enumeration value="0"></enumeration>
        <!--Ready --><enumeration value="1"></enumeration>
        <!--Run --><enumeration value="3"></enumeration>
      </enumerationtype>
      <status uid="0x0003" access="read" enumerationType="0203" />
      <status uid="0x0005" access="read" enumerationType="0x0002" />
      <setting uid="0x0015" access="read" enumerationType="0x0003" />
      <option uid="0x0100" access="read" type="Int" />
      <option uid="0x0101" access="read" type="Int" />
      <option uid="0x0203" access="read" type="Int" unit="seconds" />
      <program uid="0x2100" access="read" />
    </deviceDescription>`;
  const features = parseFeatureXml(deviceDescription, featureMapping);
  const psk = Buffer.alloc(32, 0x31);
  const iv = Buffer.alloc(16, 0x42);
  const transport = new MandatoryDishwasherTransport(dishwasherMandatoryFixture, psk, iv);
  const client = new LocalHomeConnectClient({
    profiles: [{
      id: 'dishwasher-anonymized', haId: 'dishwasher-anonymized', host: '192.168.4.72', connectionType: 'AES',
      psk64: psk.toString('base64url'), iv64: iv.toString('base64url'), name: 'Dishwasher', type: 'Dishwasher',
      brand: 'Siemens', model: dishwasherMandatoryFixture.model, source: 'anonymized-fixture', features
    }],
    requestTimeout: 1000,
    autoRefresh: false,
    transportFactory: () => transport
  });
  const received = [];
  const close = client.openEvents('dishwasher-anonymized', event => received.push(event));
  const snapshot = await client.read('dishwasher-anonymized', 'snapshot');
  assert.equal(snapshot.appliance.connected, true);
  assert.equal(snapshot.values.items.length, 89);
  assert.deepEqual(snapshot.services, { ro: 1, ei: 2, ci: 2 });
  assert.equal(snapshot.status.items.find(item => item.key === 'BSH.Common.Status.OperationState').value, 'BSH.Common.EnumType.OperationState.Inactive');
  assert.equal(snapshot.status.items.find(item => item.key === 'BSH.Common.Status.OperationState').rawValue, 0);
  assert.equal(snapshot.settings.items.find(item => item.key === 'BSH.Common.Setting.PowerState').value, 'BSH.Common.EnumType.PowerState.On');
  assert.equal(snapshot.programs.active.key, 'Dishcare.Dishwasher.Program.Eco50');
  assert.equal(snapshot.programs.selected.key, 'Dishcare.Dishwasher.Program.Eco50');
  assert.equal(snapshot.profileResolution.itemCount, 89);
  assert.equal(snapshot.profileResolution.resolvedItemCount, 6);
  assert.equal(snapshot.refresh.find(item => item.resource === '/ro/allMandatoryValues').itemCount, 89);
  assert.equal(snapshot.refresh.find(item => item.resource === '/ro/values').deviceCode, 400);
  assert.equal(snapshot.refresh.find(item => item.resource === '/ro/activeProgram').deviceCode, 404);

  transport.notify(3, 1);
  await new Promise(resolve => setImmediate(resolve));
  const update = received.findLast(event => event.event === 'STATUS' && event.connection.action === 'NOTIFY');
  assert.equal(update.data.items[0].key, 'BSH.Common.Status.OperationState');
  assert.equal(update.data.items[0].value, 'BSH.Common.EnumType.OperationState.Ready');
  const afterNotify = await client.read('dishwasher-anonymized', 'appliance');
  assert.equal(afterNotify.connected, true);
  close();
  client.close();
});

class NotifyOnlyOvenTransport extends EventEmitter {
  constructor(psk, iv) {
    super();
    this.sent = [];
    this.encrypt = serverEncryptor(psk, iv);
    this.decrypt = serverDecryptor(psk, iv);
  }
  wire(message) { return [this.encrypt(Buffer.from(JSON.stringify(message))), true]; }
  async connect() {
    queueMicrotask(() => this.emit('message', ...this.wire({
      sID: 23, msgID: 9, resource: '/ei/initialValues', version: 2, action: 'POST',
      data: [{ edMsgID: 500 }]
    })));
  }
  response(request, data, code = undefined) {
    queueMicrotask(() => this.emit('message', ...this.wire({
      sID: request.sID, msgID: request.msgID, resource: request.resource,
      version: request.version, action: 'RESPONSE',
      ...(data !== undefined ? { data } : {}), ...(code !== undefined ? { code } : {})
    })));
  }
  send(payload, binary) {
    assert.equal(binary, true);
    const message = JSON.parse(this.decrypt(payload));
    this.sent.push(message);
    if (message.resource === '/ci/services' && message.action === 'GET') {
      return this.response(message, [
        { service: 'ci', version: 3 }, { service: 'ei', version: 2 },
        { service: 'iz', version: 1 }, { service: 'ro', version: 2 }
      ], 200);
    }
    if (message.resource === '/ei/deviceReady' && message.action === 'NOTIFY') {
      queueMicrotask(() => {
        this.emit('message', ...this.wire({
          sID: 23, msgID: 77, resource: '/ei/keepAlive', version: 2, action: 'POST'
        }));
        this.emit('message', ...this.wire({
          sID: 23, msgID: 78, resource: '/ro/allMandatoryValues', version: 2, action: 'NOTIFY',
          data: [{ uid: 512, value: 5 }, { uid: 513, value: 1 }]
        }));
      });
      return;
    }
    if (message.resource === '/iz/info') return this.response(message, [{ deviceType: 'Oven' }]);
    if (message.resource?.startsWith('/ro/') && message.action === 'GET') return this.response(message, undefined, 400);
  }
  close() { this.emit('close'); }
}

test('HS658GXS7-style AES dialogue accepts unsolicited mandatory values and diagnoses rejected fallback reads', async () => {
  const psk = Buffer.alloc(32, 0x11);
  const iv = Buffer.alloc(16, 0x22);
  const transport = new NotifyOnlyOvenTransport(psk, iv);
  const diagnostics = new LocalConnectionDiagnostics();
  diagnostics.pass('profile-loaded', { transport: 'AES' });
  const client = new LocalHomeConnectClient({
    profiles: [{
      id: 'oven-aes', haId: 'oven-aes', host: '192.168.50.40', connectionType: 'AES',
      psk64: psk.toString('base64url'), iv64: iv.toString('base64url'),
      name: 'Backofen', type: 'Oven', brand: 'Siemens', model: 'HS658GXS7', source: 'test',
      features: { 512: { name: 'BSH.Common.Status.OperationState' }, 513: { name: 'BSH.Common.Setting.PowerState' } }
    }],
    requestTimeout: 1000,
    diagnostics,
    autoRefresh: false,
    traceEnabled: true,
    transportFactory: () => transport
  });
  const snapshot = await client.testConnection('oven-aes');
  assert.equal(snapshot.transport, 'AES');
  assert.equal(snapshot.services.ro, 2);
  assert.equal(snapshot.values.length, 2);
  assert.ok(snapshot.refresh.every(item => item.code === 'LOCAL_PROTOCOL_REJECTED'));
  assert.equal(diagnostics.snapshot().find(stage => stage.id === 'readonly-data-received').status, 'ok');

  const initialResponse = transport.sent.find(message => message.resource === '/ei/initialValues');
  assert.equal(initialResponse.action, 'RESPONSE');
  assert.equal(initialResponse.msgID, 9);
  const keepAliveResponse = transport.sent.find(message => message.resource === '/ei/keepAlive');
  assert.equal(keepAliveResponse.action, 'RESPONSE');
  assert.equal(keepAliveResponse.msgID, 77);
  const clientRequests = transport.sent.filter(message => message.action === 'GET' || message.action === 'NOTIFY');
  assert.deepEqual(clientRequests.filter(message => message.resource.startsWith('/ro/')).map(message => message.resource), [
    '/ro/allMandatoryValues', '/ro/values', '/ro/allDescriptionChanges', '/ro/activeProgram', '/ro/selectedProgram'
  ]);
  assert.ok(clientRequests.filter(message => message.resource.startsWith('/ro/')).every(message => message.version === 2));
  assert.equal(transport.sent.find(message => message.resource === '/ci/services').msgID, 500);
  assert.equal(transport.sent.find(message => message.resource === '/ei/deviceReady').msgID, 501);
  assert.equal(transport.sent.find(message => message.resource === '/iz/info').msgID, 502);
  assert.ok(snapshot.protocolTrace.entries.some(entry => entry.message.resource === '/ro/allMandatoryValues' && entry.message.action === 'NOTIFY'));
  client.close();
});

class AllReadsRejectedTransport extends FakeTransport {
  send(payload, binary) {
    const message = JSON.parse(Buffer.from(payload).toString('utf8'));
    if (!message.resource?.startsWith('/ro/')) return super.send(payload, binary);
    this.sent.push(message);
    queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify({
      sID: message.sID, msgID: message.msgID, resource: message.resource,
      version: message.version, action: 'RESPONSE', code: 400
    })), false));
  }
}

test('all rejected read paths report concrete resource, action, version and every device code', async () => {
  const client = new LocalHomeConnectClient({
    profiles: [{
      id: 'all-rejected', haId: 'all-rejected', host: '192.168.1.33', connectionType: 'TLS',
      psk64: Buffer.alloc(32, 1).toString('base64url'), name: 'Test', type: 'Dishwasher', brand: 'Siemens', source: 'test', features: {}
    }],
    requestTimeout: 1000, autoRefresh: false, transportFactory: () => new AllReadsRejectedTransport()
  });
  await assert.rejects(() => client.testConnection('all-rejected'), error => {
    assert.equal(error.code, 'LOCAL_PROTOCOL_REJECTED');
    assert.equal(error.details.resource, '/ro/allMandatoryValues');
    assert.equal(error.details.action, 'GET');
    assert.equal(error.details.version, 1);
    assert.equal(error.details.deviceCode, 400);
    assert.equal(error.details.rejections.length, 5);
    assert.match(error.message, /allMandatoryValues.*version 1.*code 400/i);
    return true;
  });
  client.close();
});

test('safe local protocol trace redacts secrets and writes protected JSONL when explicitly enabled', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-trace-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filename = path.join(root, 'protocol.jsonl');
  const trace = new LocalProtocolTrace({ enabled: true, profile: 'full-device-id', path: filename });
  trace.record('rx', {
    sID: 1, msgID: 2, resource: '/ci/authentication', version: 2, action: 'POST',
    psk64: 'TOP-SECRET-PSK', iv64: 'TOP-SECRET-IV', deviceID: 'SERIAL-123',
    data: [{ nonce: 'TOP-SECRET-NONCE', uid: 512, value: 3 }]
  });
  const snapshot = trace.snapshot();
  const serialized = JSON.stringify(snapshot);
  const fileText = fs.readFileSync(filename, 'utf8');
  assert.doesNotMatch(serialized + fileText, /TOP-SECRET|SERIAL-123|full-device-id/);
  assert.equal(snapshot.entries[0].message.psk64, '[REDACTED]');
  assert.equal(snapshot.entries[0].message.iv64, '[REDACTED]');
  assert.equal(snapshot.entries[0].message.deviceID, '[REDACTED_IDENTIFIER]');
  assert.equal(snapshot.entries[0].message.data, '[REDACTED_AUTHENTICATION_DATA]');
  const traceStat = fs.statSync(filename);
  assert.equal(traceStat.isFile(), true);
  if (process.platform !== 'win32') {
    assert.equal(traceStat.mode & 0o777, 0o600);
  }
});

test('success code 200 is accepted and EHOSTUNREACH remains a network error with bilingual hints', () => {
  assert.equal(acceptedResponseCode(200), true);
  assert.equal(acceptedResponseCode('200'), true);
  assert.equal(acceptedResponseCode(400), false);
  const error = transportError(Object.assign(new Error('no route'), { code: 'EHOSTUNREACH' }), 'AES');
  assert.equal(error.code, 'LOCAL_NETWORK_ERROR');
  assert.equal(error.details.category, 'network');
  assert.equal(error.details.causeCode, 'EHOSTUNREACH');
  assert.match(error.details.hintDe, /VLAN|Firewall/);
  assert.match(error.details.hintEn, /VLAN|firewall/i);
});

test('watch reconnect creates a fresh transport and resets the session after a disconnect', async () => {
  const transports = [];
  const session = new LocalApplianceSession({
    id: 'reconnect', haId: 'reconnect', host: '192.168.1.34', connectionType: 'TLS',
    psk64: Buffer.alloc(32, 1).toString('base64url'), name: 'Reconnect', type: 'Washer', brand: 'Siemens', source: 'test', features: {}
  }, {
    timeoutMs: 1000,
    autoRefresh: false,
    transportFactory: () => { const transport = new FakeTransport(); transports.push(transport); return transport; }
  });
  session.reconnectBaseDelay = 1;
  session.reconnectDelay = 1;
  session.watch();
  await once(session, 'event');
  const firstSessionId = session.sessionId;
  transports[0].close();
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.ok(transports.length >= 2);
  assert.equal(session.connected, true);
  assert.equal(session.sessionId, firstSessionId);
  assert.equal(session.reconnectAttempt, 0);
  session.unwatch();
  session.close();
});


test('Node-RED local configuration stores profiles as credentials and forces writes off', () => {
  const types = new Map();
  const instances = new Map();
  const RED = {
    nodes: {
      registerType: (name, ctor, options) => types.set(name, { ctor, options }),
      createNode: (node, config) => {
        const emitter = new EventEmitter();
        node.id = config.id; node.type = config.type; node.credentials = config.credentials || {};
        node.on = emitter.on.bind(emitter); node.emit = emitter.emit.bind(emitter);
        node.status = () => {}; node.error = () => {}; node.send = () => {};
        instances.set(node.id, node);
      },
      getNode: id => instances.get(id), addCredentials: () => {}
    },
    httpAdmin: { get: () => {} }, httpNode: { get: () => {} },
    auth: { needsPermission: () => (_req, _res, next) => next() },
    util: { cloneMessage: value => structuredClone(value) }
  };
  require('../nodes/home-connect')(RED);
  const Config = types.get('home-connect-config').ctor;
  const profileJson = JSON.stringify({ id: 'oven-local', host: '192.168.1.40', connectionType: 'TLS', psk64: 'ERERERERERERERERERERERERERERERERERERERERERE', type: 'Oven' });
  const config = new Config({
    id: 'local-config', type: 'home-connect-config', environment: 'local', allowWrite: true,
    credentials: { localProfileJson: profileJson }
  });
  assert.equal(config.environment, 'local');
  assert.equal(config.allowWrite, false);
  assert.equal(config.client.readOnly, true);
  assert.ok(types.get('home-connect-config').options.credentials.localProfileJson);
  assert.equal(JSON.stringify(config.client.profiles).includes('clientSecret'), false);
  config.client.close();
});

test('a configured profile folder takes precedence over optional manual credential JSON', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-folder-primary-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'folder.json'), JSON.stringify({
    id: 'folder-device', psk64: 'ERERERERERERERERERERERERERERERERERERERERERE', iv64: 'IiIiIiIiIiIiIiIiIiIiIg'
  }));
  fs.writeFileSync(path.join(root, 'folder_DeviceDescription.xml'), '<features/>');
  fs.writeFileSync(path.join(root, 'folder_FeatureMapping.xml'), '<features/>');
  const types = new Map();
  const RED = {
    nodes: {
      registerType: (name, ctor, options) => types.set(name, { ctor, options }),
      createNode: (node, config) => {
        const emitter = new EventEmitter();
        node.id = config.id; node.type = config.type; node.credentials = config.credentials || {};
        node.on = emitter.on.bind(emitter); node.emit = emitter.emit.bind(emitter);
      },
      getNode: () => null, addCredentials: () => {}
    },
    httpAdmin: { get: () => {} }, httpNode: { get: () => {} },
    auth: { needsPermission: () => (_req, _res, next) => next() },
    util: { cloneMessage: value => structuredClone(value) }
  };
  require('../nodes/home-connect')(RED);
  const Config = types.get('home-connect-config').ctor;
  const manual = JSON.stringify({ id: 'manual-device', host: '192.168.1.99', psk64: 'ERERERERERERERERERERERERERERERERERERERERERE' });
  const config = new Config({
    id: 'folder-config', type: 'home-connect-config', environment: 'local', localProfilePath: root,
    localDeviceMappings: JSON.stringify([{ profileId: 'folder-device', host: '192.168.1.55', connectionType: 'auto' }]),
    credentials: { localProfileJson: manual }
  });
  assert.deepEqual(config.client.profiles.map(profile => profile.haId), ['folder-device']);
  assert.equal(config.client.profiles[0].host, '192.168.1.55');
  config.client.close();
});
