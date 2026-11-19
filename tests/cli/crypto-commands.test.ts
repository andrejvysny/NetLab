import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createWorld, addDevice, getIos } from '../../src/engine/world.ts';
import { registerCommands, startSession, execLine, helpFor, inspectLine } from '../../src/engine/cli/framework.ts';
import type { CommandDef, ExecOutcome } from '../../src/engine/cli/framework.ts';
import type { IkeSa, IpsecSa } from '../../src/engine/types.ts';
import * as cryptoMod from '../../src/engine/cli/commands/crypto.ts';
import { MSG } from '../../src/engine/cli/commands/crypto.ts';

// Minimal navigation owned by other modules, so this suite only depends on the crypto module.
const nav: CommandDef[] = [
  { modes: 'user', pattern: 'enable', feature: 'system', run: (e) => e.setMode('priv') },
  { modes: 'priv', pattern: 'configure terminal', feature: 'system', run: (e) => e.setMode('config') },
  {
    modes: 'config', pattern: 'interface <ifname:if>', feature: 'interface', mutates: false,
    run: (e, a) => { if (!e.device.config.interfaces[a.ifname]) e.reject('% Invalid interface'); e.setMode('config-if', { ifNames: [a.ifname] }); },
  },
];
registerCommands(nav);
cryptoMod.install();

function lab(id = 'r1') {
  const w = createWorld();
  addDevice(w, { id, model: 'isr4331', label: id.toUpperCase(), x: 0, y: 0 });
  const { session } = startSession(w, id, 'console');
  const dev = getIos(w, id);
  const run = (l: string): ExecOutcome => execLine(w, session, l);
  const runAll = (lines: string[]): ExecOutcome[] => lines.map((l) => {
    const o = run(l);
    assert.ok(o.status === 'ok' || o.status === 'empty', `"${l}" → ${o.status}: ${o.output}`);
    return o;
  });
  run('enable'); run('configure terminal');
  return { w, s: session, dev, run, runAll };
}

const COURSE = readFileSync(new URL('../../docs/COURSE.md', import.meta.url), 'utf8');

const R1_CRYPTO = [
  'crypto isakmp policy 10',
  ' encryption aes',
  ' hash sha',
  ' authentication pre-share',
  ' group 2',
  'crypto isakmp key KSS123 address 60.50.30.2',
  'crypto ipsec transform-set TS esp-aes esp-sha-hmac',
  ' mode tunnel',
  'crypto map CM 10 ipsec-isakmp',
  ' set peer 60.50.30.2',
  ' set transform-set TS',
  ' match address 120',
];
const R2_CRYPTO = R1_CRYPTO.map((l) => l.replace('60.50.30.2', '60.50.30.1'));
const IF_LINES = ['interface Serial0/1/0', ' crypto map CM'];

function expectedCrypto(peer: string) {
  return {
    isakmpEnabled: true,
    isakmpPolicies: [{ priority: 10, encryption: 'aes', hash: 'sha', authentication: 'pre-share', group: 2, lifetime: 86400 }],
    isakmpKeys: [{ key: 'KSS123', address: peer }],
    transformSets: [{ name: 'TS', transforms: ['esp-aes', 'esp-sha-hmac'], mode: 'tunnel' }],
    maps: [{ name: 'CM', entries: [{ seq: 10, type: 'ipsec-isakmp', peers: [peer], transformSets: ['TS'], matchAcl: '120' }] }],
  };
}

test('reference lines are quoted exactly from docs/COURSE.md', () => {
  for (const l of [...R1_CRYPTO, ...R2_CRYPTO, ...IF_LINES]) assert.ok(COURSE.includes(l + '\n'), `not in COURSE.md: "${l}"`);
});

test('R1 reference IPsec configuration typed exactly as written', () => {
  const { dev, run, runAll } = lab();
  const outs = runAll(R1_CRYPTO);
  assert.equal(outs[0].prompt, 'Router(config-isakmp)#');
  assert.equal(outs[5].prompt, 'Router(config)#', 'global command from config-isakmp falls back to global mode');
  assert.equal(outs[6].prompt, 'Router(cfg-crypto-trans)#');
  assert.equal(outs[8].prompt, 'Router(config-crypto-map)#');
  assert.equal(outs[8].output, MSG.newMapNote + '\n');
  assert.equal(MSG.newMapNote, '% NOTE: This new crypto map will remain disabled until a peer\n        and a valid access list have been configured.');
  assert.deepEqual(dev.config.crypto, expectedCrypto('60.50.30.2'));
  const o1 = run(IF_LINES[0]);
  assert.equal(o1.prompt, 'Router(config-if)#');
  const o2 = run(IF_LINES[1]);
  assert.equal(o2.status, 'ok');
  assert.equal(o2.output, '%CRYPTO-6-ISAKMP_ON_OFF: ISAKMP is ON\n');
  assert.equal(dev.config.interfaces['Serial0/1/0'].cryptoMap, 'CM');
  for (const o of outs) assert.equal(o.feature, 'ipsec');
  assert.equal(o2.feature, 'ipsec');
});

test('R2 reference IPsec configuration typed exactly as written', () => {
  const { dev, runAll } = lab('r2');
  runAll([...R2_CRYPTO, ...IF_LINES]);
  assert.deepEqual(dev.config.crypto, expectedCrypto('60.50.30.1'));
  assert.equal(dev.config.interfaces['Serial0/1/0'].cryptoMap, 'CM');
});

test('R1 reference IPsec configuration in common abbreviated forms', () => {
  const { dev, runAll } = lab();
  runAll([
    'cry isa pol 10', ' encr aes', ' ha sha', ' auth pre', ' gr 2',
    'cry isa key KSS123 add 60.50.30.2',
    'cry ips trans TS esp-aes esp-sha-hmac', ' mo tun',
    'cry map CM 10 ipsec-i', ' set pe 60.50.30.2', ' set tr TS', ' mat add 120',
    'int s0/1/0', ' cry map CM',
  ]);
  assert.deepEqual(dev.config.crypto, expectedCrypto('60.50.30.2'));
  assert.equal(dev.config.interfaces['Serial0/1/0'].cryptoMap, 'CM');
  // the other common spellings
  const b = lab();
  b.runAll(['crypto isakmp policy 10', 'encryption aes 128', 'authentication pre-share', 'group 2', 'crypto isakmp key 0 KSS123 address 60.50.30.2',
    'crypto ipsec transform-set TS esp-aes 128 esp-sha-hmac', 'crypto map CM 10', 'set peer 60.50.30.2', 'set transform-set TS', 'match address 120']);
  assert.deepEqual(b.dev.config.crypto, expectedCrypto('60.50.30.2'));
});

test('a new ISAKMP policy starts with the IOS defaults; no/default forms restore them', () => {
  const { dev, run, runAll } = lab();
  run('crypto isakmp policy 20');
  assert.deepEqual(dev.config.crypto.isakmpPolicies, [{ priority: 20, encryption: 'des', hash: 'sha', authentication: 'rsa-sig', group: 1, lifetime: 86400 }]);
  runAll(['encryption aes 256', 'hash sha256', 'authentication rsa-encr', 'group 14', 'lifetime 3600']);
  assert.deepEqual(dev.config.crypto.isakmpPolicies[0], { priority: 20, encryption: 'aes 256', hash: 'sha256', authentication: 'rsa-encr', group: 14, lifetime: 3600 });
  runAll(['encryption 3des', 'encryption aes 192']);
  assert.equal(dev.config.crypto.isakmpPolicies[0].encryption, 'aes 192');
  runAll(['no encryption', 'no hash', 'default authentication', 'no group 14', 'no lifetime']);
  assert.deepEqual(dev.config.crypto.isakmpPolicies[0], { priority: 20, encryption: 'des', hash: 'sha', authentication: 'rsa-sig', group: 1, lifetime: 86400 });
  // invalid values are parser errors, like IOS
  assert.equal(run('group 3').status, 'invalid');
  assert.equal(run('lifetime 30').status, 'invalid');
  assert.equal(run('encryption des 256').status, 'invalid');
  assert.equal(run('hash sha1').status, 'invalid');
  // policies are kept in priority order; no form removes
  runAll(['exit', 'crypto isakmp policy 5', 'exit', 'crypto isakmp policy 10000']);
  assert.deepEqual(dev.config.crypto.isakmpPolicies.map((p) => p.priority), [5, 20, 10000]);
  assert.equal(run('crypto isakmp policy 10001').status, 'invalid');
  runAll(['no crypto isakmp policy 20']);
  assert.deepEqual(dev.config.crypto.isakmpPolicies.map((p) => p.priority), [5, 10000]);
});

test('ISAKMP keys: address, mask, type 0/6, hostname form, removal, enable', () => {
  const { dev, run, runAll } = lab();
  runAll(['crypto isakmp key KSS123 address 60.50.30.2', 'crypto isakmp key 0 any address 0.0.0.0 0.0.0.0']);
  assert.deepEqual(dev.config.crypto.isakmpKeys, [{ key: 'KSS123', address: '60.50.30.2' }, { key: 'any', address: '0.0.0.0', mask: '0.0.0.0' }]);
  runAll(['crypto isakmp key NEWKEY address 60.50.30.2']);
  assert.equal(dev.config.crypto.isakmpKeys[0].key, 'NEWKEY', 're-entering a key for the same address replaces it');
  const o6 = run('crypto isakmp key 6 Encrypted address 10.0.0.1');
  assert.equal(o6.status, 'ok'); assert.equal(o6.notes.length, 1);
  const oh = run('crypto isakmp key KSS123 hostname R2');
  assert.equal(oh.status, 'ok');
  assert.match(oh.notes[0], /^Accepted, but not simulated/);
  assert.deepEqual(dev.config.extraLines, ['crypto isakmp key KSS123 hostname R2']);
  runAll(['no crypto isakmp key NEWKEY address 60.50.30.2', 'no crypto isakmp key KSS123 hostname R2']);
  assert.deepEqual(dev.config.crypto.isakmpKeys.map((k) => k.address), ['0.0.0.0', '10.0.0.1']);
  assert.deepEqual(dev.config.extraLines, []);
  assert.equal(run('crypto isakmp key KSS123 address 60.50.30').status, 'invalid');
  // enable
  runAll(['no crypto isakmp enable']);
  assert.equal(dev.config.crypto.isakmpEnabled, false);
  runAll(['crypto isakmp enable']);
  assert.equal(dev.config.crypto.isakmpEnabled, true);
});

test('transform sets: real transform names, combination rules and key sizes', () => {
  const { dev, s, w, run, runAll } = lab();
  const ok = (line: string, transforms: string[]) => {
    const o = run(line);
    assert.equal(o.status, 'ok', `${line}: ${o.output}`);
    assert.equal(o.prompt, 'Router(cfg-crypto-trans)#');
    const name = line.split(/\s+/)[3];
    assert.deepEqual(dev.config.crypto.transformSets.find((t) => t.name === name)?.transforms, transforms);
    run('exit');
  };
  ok('crypto ipsec transform-set A esp-3des esp-md5-hmac', ['esp-3des', 'esp-md5-hmac']);
  ok('crypto ipsec transform-set B esp-aes 256 esp-sha256-hmac', ['esp-aes 256', 'esp-sha256-hmac']);
  ok('crypto ipsec transform-set C ah-sha-hmac esp-des esp-sha-hmac', ['ah-sha-hmac', 'esp-des', 'esp-sha-hmac']);
  ok('crypto ipsec transform-set D esp-sha-hmac esp-aes 192', ['esp-sha-hmac', 'esp-aes 192']);
  ok('crypto ipsec transform-set E esp-gcm 256', ['esp-gcm 256']);
  ok('crypto ipsec transform-set F ah-sha512-hmac', ['ah-sha512-hmac']);
  ok('crypto ipsec transform-set G esp-null esp-sha384-hmac', ['esp-null', 'esp-sha384-hmac']);
  ok('crypto ipsec transform-set H ah-md5-hmac esp-aes esp-sha512-hmac comp-lzs', ['ah-md5-hmac', 'esp-aes', 'esp-sha512-hmac', 'comp-lzs']);
  ok('crypto ipsec transform-set I esp-3 esp-md5', ['esp-3des', 'esp-md5-hmac']);

  const bad = (line: string, word: string) => {
    const o = run(line);
    assert.equal(o.status, 'invalid', line);
    const caret = o.output.split('\n')[0];
    assert.equal(caret, ' '.repeat('Router(config)#'.length + line.indexOf(word)) + '^', line);
    assert.match(o.output, /% Invalid input detected at '\^' marker\./);
  };
  bad('crypto ipsec transform-set X esp-des esp-3des', 'esp-3des');            // two ESP ciphers
  bad('crypto ipsec transform-set X esp-aes esp-sha-hmac esp-md5-hmac', 'esp-md5-hmac'); // two ESP authenticators
  bad('crypto ipsec transform-set X ah-sha-hmac ah-md5-hmac', 'ah-md5-hmac');  // two AH transforms
  bad('crypto ipsec transform-set X esp-gcm esp-sha-hmac', 'esp-sha-hmac');    // GCM has its own integrity
  bad('crypto ipsec transform-set X esp-3des 256', '256');                     // key size only for AES/GCM/GMAC
  bad('crypto ipsec transform-set X esp-aes 512', '512');
  bad('crypto ipsec transform-set X esp-blowfish', 'esp-blowfish');
  assert.equal(run('crypto ipsec transform-set X esp-sha').status, 'ambiguous');
  assert.equal(run('crypto ipsec transform-set X').status, 'incomplete');
  assert.equal(run('crypto ipsec transform-set X comp-lzs').status, 'incomplete', 'compression alone is not a transform set');
  assert.equal(dev.config.crypto.transformSets.some((t) => t.name === 'X'), false);

  // '?' after a cipher offers only what may still follow
  const h = helpFor(w, s, 'crypto ipsec transform-set X esp-aes ');
  assert.match(h, /256\s+256 bit keys\./);
  assert.match(h, /esp-sha-hmac\s+ESP transform using HMAC-SHA auth/);
  assert.doesNotMatch(h, /esp-des|esp-3des|esp-gcm/);
  assert.match(helpFor(w, s, 'crypto ipsec transform-set X '), /esp-3des\s+ESP transform using 3DES\(EDE\) cipher \(168 bits\)/);

  // mode
  runAll(['crypto ipsec transform-set T esp-aes esp-sha-hmac', 'mode transport']);
  assert.equal(dev.config.crypto.transformSets.find((t) => t.name === 'T')?.mode, 'transport');
  runAll(['no mode']);
  assert.equal(dev.config.crypto.transformSets.find((t) => t.name === 'T')?.mode, 'tunnel');
  // re-entering with other transforms replaces them and keeps the mode
  runAll(['mode transport', 'crypto ipsec transform-set T esp-3des esp-sha-hmac']);
  assert.deepEqual(dev.config.crypto.transformSets.find((t) => t.name === 'T'), { name: 'T', transforms: ['esp-3des', 'esp-sha-hmac'], mode: 'transport' });
  // global SA lifetime: accepted, kept for the running-config
  const lo = run('crypto ipsec security-association lifetime seconds 3600');
  assert.equal(lo.status, 'ok'); assert.match(lo.notes[0], /not simulated/);
  runAll(['crypto ipsec security-association lifetime kilobytes 4608000', 'crypto ipsec security-association lifetime seconds 7200']);
  assert.deepEqual(dev.config.extraLines, ['crypto ipsec security-association lifetime kilobytes 4608000', 'crypto ipsec security-association lifetime seconds 7200']);
  runAll(['no crypto ipsec security-association lifetime seconds']);
  assert.deepEqual(dev.config.extraLines, ['crypto ipsec security-association lifetime kilobytes 4608000']);
});

test('crypto map entry sub-commands and the lab sheet syntax', () => {
  const { dev, run, runAll } = lab();
  // lab sheet (LAB2-IPsec_konfiguracia.txt, North router) — with an ISR 4331 interface name
  runAll([
    'crypto isakmp policy 1', 'encryption 3des', 'hash sha', 'authentication pre-share', 'group 2', 'lifetime 86400', 'exit',
    'crypto ipsec transform-set set1 esp-3des esp-sha-hmac', 'mode tunnel', 'end', 'configure terminal',
    'crypto map pipe-1 1 ipsec-isakmp', 'match address 161', 'set peer 7.12.1.20', 'set transform-set set1',
    'set security-assoc lifetime kilo 80000', 'set security-assoc lifetime sec 26400', 'exit',
    'interface GigabitEthernet0/0/0', 'crypto map pipe-1', 'end',
  ]);
  assert.deepEqual(dev.config.crypto.maps, [{
    name: 'pipe-1',
    entries: [{ seq: 1, type: 'ipsec-isakmp', peers: ['7.12.1.20'], transformSets: ['set1'], matchAcl: '161', saLifetimeKilobytes: 80000, saLifetimeSeconds: 26400 }],
  }]);
  assert.deepEqual(dev.config.crypto.isakmpPolicies, [{ priority: 1, encryption: '3des', hash: 'sha', authentication: 'pre-share', group: 2, lifetime: 86400 }]);
  run('configure terminal');
  // re-entering an existing entry: no NOTE, same entry
  const again = run('crypto map pipe-1 1 ipsec-isakmp');
  assert.equal(again.output, '');
  runAll([
    'set peer 7.12.1.21', 'set peer 7.12.1.21', 'set pfs group14', 'qos pre-classify', 'description to Remote',
    'crypto ipsec transform-set set2 esp-aes esp-sha-hmac', 'crypto map pipe-1 1', 'set transform-set set2 set1',
  ]);
  let e = dev.config.crypto.maps[0].entries[0];
  assert.deepEqual(e.peers, ['7.12.1.20', '7.12.1.21']);
  assert.deepEqual(e.transformSets, ['set2', 'set1']);
  assert.equal(e.pfsGroup, 14); assert.equal(e.qosPreClassify, true); assert.equal(e.description, 'to Remote');
  runAll(['set pfs']);
  assert.equal(dev.config.crypto.maps[0].entries[0].pfsGroup, 1);
  runAll(['no set peer 7.12.1.20', 'no set pfs', 'no qos pre-classify', 'no description', 'no set security-association lifetime seconds',
    'no set security-association lifetime kilobytes', 'no match address', 'no set transform-set']);
  e = dev.config.crypto.maps[0].entries[0];
  assert.deepEqual(e, { seq: 1, type: 'ipsec-isakmp', peers: ['7.12.1.21'], transformSets: [] });
  // set transform-set needs existing transform sets (IOS error, nothing changed)
  runAll(['set transform-set set1']);
  const missing = run('set transform-set set1 NOPE');
  assert.equal(missing.status, 'rejected');
  assert.equal(missing.output, 'ERROR: transform set with tag "NOPE" does not exist.\n');
  assert.deepEqual(dev.config.crypto.maps[0].entries[0].transformSets, ['set1']);
  assert.equal(missing.prompt, 'Router(config-crypto-map)#');
  // out-of-range lifetimes are parser errors
  assert.equal(run('set security-association lifetime seconds 60').status, 'invalid');
  // a second entry in the same map, kept in sequence order
  run('crypto map pipe-1 20 ipsec-isakmp');
  run('crypto map pipe-1 5 ipsec-isakmp');
  assert.deepEqual(dev.config.crypto.maps[0].entries.map((x) => x.seq), [1, 5, 20]);
  assert.equal(run('crypto map pipe-1 0 ipsec-isakmp').status, 'invalid');
});

test('removal guards: transform set in use, crypto map applied, empty map on interface', () => {
  const { dev, run, runAll } = lab();
  runAll(R1_CRYPTO);
  // transform set used by a crypto map
  const t = run('no crypto ipsec transform-set TS');
  assert.equal(t.status, 'rejected');
  assert.equal(t.output, MSG.transformSetInUse('TS', ['CM']) + '\n');
  assert.equal(dev.config.crypto.transformSets.length, 1);
  // undefined map on an interface: IOS refuses
  runAll(['interface Serial0/1/0']);
  const e = run('crypto map NOPE');
  assert.equal(e.status, 'rejected');
  assert.equal(e.output, 'Cannot apply empty map to interface\n');
  assert.equal(dev.config.interfaces['Serial0/1/0'].cryptoMap, undefined);
  runAll(['crypto map CM']);
  // crypto map applied to an interface cannot be deleted
  const m = run('no crypto map CM');
  assert.equal(m.status, 'ok', 'in config-if, "no crypto map CM" removes the map from the interface');
  assert.equal(m.output, '%CRYPTO-6-ISAKMP_ON_OFF: ISAKMP is OFF\n');
  runAll(['crypto map CM', 'exit']);
  const g = run('no crypto map CM');
  assert.equal(g.status, 'rejected');
  assert.equal(g.output, MSG.mapApplied('CM', ['Serial0/1/0']) + '\n');
  assert.equal(run('no crypto map CM 10').status, 'rejected', 'removing the last entry would delete the map');
  // a second entry may be removed while applied
  runAll(['crypto map CM 20 ipsec-isakmp', 'exit', 'no crypto map CM 20']);
  assert.deepEqual(dev.config.crypto.maps[0].entries.map((x) => x.seq), [10]);
  // remove from the interface (name is ignored by IOS), then everything can go
  runAll(['interface Serial0/1/0', 'no crypto map', 'exit', 'no crypto map CM', 'no crypto ipsec transform-set TS']);
  assert.deepEqual(dev.config.crypto.maps, []);
  assert.deepEqual(dev.config.crypto.transformSets, []);
  assert.equal(dev.config.interfaces['Serial0/1/0'].cryptoMap, undefined);
  // removing things that do not exist is silent
  for (const l of ['no crypto map NOPE', 'no crypto ipsec transform-set NOPE', 'no crypto isakmp policy 99']) assert.equal(run(l).output, '', l);
});

test('ISAKMP ON is logged once, when the first interface gets a crypto map', () => {
  const { run, runAll } = lab();
  runAll(R1_CRYPTO);
  runAll(['interface GigabitEthernet0/0/1']);
  assert.equal(run('crypto map CM').output, '%CRYPTO-6-ISAKMP_ON_OFF: ISAKMP is ON\n');
  assert.equal(run('crypto map CM').output, '');
  runAll(['interface GigabitEthernet0/0/2']);
  assert.equal(run('crypto map CM').output, '', 'already on');
  assert.equal(run('no crypto map').output, '');
  runAll(['interface GigabitEthernet0/0/1']);
  assert.equal(run('no crypto map CM').output, '%CRYPTO-6-ISAKMP_ON_OFF: ISAKMP is OFF\n');
  assert.equal(run('no crypto map').output, '', 'nothing to remove');
});

function seedSas(dev: ReturnType<typeof lab>['dev']): void {
  const ike: IkeSa = { id: 1001, local: '60.50.30.1', remote: '60.50.30.2', state: 'QM_IDLE', createdTick: 1 };
  const sel = { address: '0.0.0.0', mask: '0.0.0.0', protocol: 1, port: 0 };
  const sa: IpsecSa = {
    id: 1002, iface: 'Serial0/1/0', mapName: 'CM', seq: 10, localEndpoint: '60.50.30.1', remoteEndpoint: '60.50.30.2',
    localIdent: sel, remoteIdent: sel, transform: 'esp-aes esp-sha-hmac', mode: 'tunnel', spiIn: 1, spiOut: 2, encaps: 3, decaps: 4, createdTick: 1,
  };
  dev.runtime.ikeSas = [ike];
  dev.runtime.ipsecSas = [sa, { ...sa, id: 1003, mapName: 'OTHER', remoteEndpoint: '9.9.9.9' }];
}

test('clear crypto sa / isakmp / session', () => {
  const { dev, run } = lab();
  run('end');
  seedSas(dev);
  assert.equal(run('clear crypto sa peer 9.9.9.9').status, 'ok');
  assert.deepEqual(dev.runtime.ipsecSas.map((x) => x.id), [1002]);
  seedSas(dev);
  run('clear crypto sa map CM');
  assert.deepEqual(dev.runtime.ipsecSas.map((x) => x.id), [1003]);
  seedSas(dev);
  const o = run('clear crypto sa');
  assert.equal(o.output, ''); assert.equal(o.feature, 'ipsec'); assert.equal(o.mutated, false);
  assert.equal(dev.runtime.ipsecSas.length, 0); assert.equal(dev.runtime.ikeSas.length, 1);
  seedSas(dev);
  run('clear crypto isa');
  assert.equal(dev.runtime.ikeSas.length, 0); assert.equal(dev.runtime.ipsecSas.length, 2);
  seedSas(dev);
  run('clear crypto isakmp 999');
  assert.equal(dev.runtime.ikeSas.length, 1);
  run('clear crypto isakmp 1001');
  assert.equal(dev.runtime.ikeSas.length, 0);
  seedSas(dev);
  run('clear crypto session');
  assert.equal(dev.runtime.ikeSas.length, 0); assert.equal(dev.runtime.ipsecSas.length, 0);
  seedSas(dev);
  run('clear crypto session remote 60.50.30.2');
  assert.equal(dev.runtime.ikeSas.length, 0); assert.deepEqual(dev.runtime.ipsecSas.map((x) => x.id), [1003]);
  // from configuration mode with do
  run('configure terminal');
  seedSas(dev);
  assert.equal(run('do clear crypto sa').prompt, 'Router(config)#');
  assert.equal(dev.runtime.ipsecSas.length, 0);
});

test('changing configuration that live SAs depend on clears this device\'s SAs', () => {
  const { dev, run, runAll } = lab();
  runAll([...R1_CRYPTO, ...IF_LINES, 'exit']);
  const changes: [string[], boolean][] = [
    [['crypto map CM 10'], false],                       // navigation only
    [['crypto map CM 10', 'description WAN'], false],     // a description does not matter
    [['crypto map CM 10', 'set peer 60.50.30.2'], false], // same value again
    [['crypto map CM 10', 'set peer 60.50.30.9'], true],
    [['crypto map CM 10', 'match address 121'], true],
    [['crypto map CM 10', 'qos pre-classify'], false], // QoS only; doesn't change what the peers negotiate
    [['crypto isakmp policy 10'], false],
    [['crypto isakmp policy 10', 'group 2'], false],
    [['crypto isakmp policy 10', 'group 5'], true],
    [['crypto isakmp policy 30'], true],
    [['crypto isakmp key KSS123 address 60.50.30.2'], false],
    [['crypto isakmp key OTHER address 60.50.30.2'], true],
    [['crypto ipsec transform-set TS esp-aes esp-sha-hmac'], false],
    [['crypto ipsec transform-set TS esp-3des esp-sha-hmac'], true],
    [['crypto ipsec transform-set TS esp-3des esp-sha-hmac', 'mode transport'], true],
    [['interface Serial0/1/0', 'crypto map CM'], false],
    [['interface Serial0/1/0', 'no crypto map'], true],
    [['no crypto isakmp enable'], true],
  ];
  for (const [lines, clears] of changes) {
    run('configure terminal');
    seedSas(dev);
    runAll(lines);
    run('end');
    assert.equal(dev.runtime.ipsecSas.length === 0 && dev.runtime.ikeSas.length === 0, clears, lines.join(' / '));
  }
});

test('crypto commands exist on the ISR 4331 only, not on the Catalyst 9300L', () => {
  const w = createWorld();
  addDevice(w, { id: 'sw1', model: 'c9300l', label: 'SW1', x: 0, y: 0 });
  const { session } = startSession(w, 'sw1', 'console');
  execLine(w, session, 'enable'); execLine(w, session, 'configure terminal');
  assert.equal(execLine(w, session, 'crypto isakmp policy 10').status, 'invalid');
  execLine(w, session, 'interface GigabitEthernet1/0/1');
  assert.equal(execLine(w, session, 'crypto map CM').status, 'invalid');
  assert.deepEqual(getIos(w, 'sw1').config.crypto.isakmpPolicies, []);
});

test('feature, mutates and help', () => {
  const { w, s, run } = lab();
  assert.deepEqual(inspectLine(w, s, 'crypto isakmp policy 10'), { status: 'ok', feature: 'ipsec', mutates: true });
  assert.deepEqual(inspectLine(w, s, 'crypto map CM 10 ipsec-isakmp'), { status: 'ok', feature: 'ipsec', mutates: true });
  assert.deepEqual(inspectLine(w, s, 'crypto ipsec transform-set TS esp-aes esp-sha-hmac'), { status: 'ok', feature: 'ipsec', mutates: true });
  assert.deepEqual(inspectLine(w, s, 'crypto isakmp key K address 1.1.1.1'), { status: 'ok', feature: 'ipsec', mutates: true });
  assert.deepEqual(inspectLine(w, s, 'do clear crypto sa'), { status: 'ok', feature: 'ipsec', mutates: false });
  run('interface Serial0/1/0');
  assert.deepEqual(inspectLine(w, s, 'crypto map CM'), { status: 'ok', feature: 'ipsec', mutates: true });
  run('exit');
  assert.match(helpFor(w, s, 'crypto '), /isakmp\s+Configure ISAKMP policy/);
  assert.match(helpFor(w, s, 'crypto '), /map\s+Enter a crypto map/);
  assert.match(helpFor(w, s, 'crypto isakmp '), /key\s+Set pre-shared key for remote peer/);
  run('crypto isakmp policy 10');
  assert.match(helpFor(w, s, 'encryption '), /aes\s+AES - Advanced Encryption Standard\./);
  assert.match(helpFor(w, s, 'group '), /2\s+Diffie-Hellman group 2 \(1024 bit\)/);
  assert.match(helpFor(w, s, 'authentication '), /pre-share\s+Pre-Shared Key/);
  run('crypto map CM 10 ipsec-isakmp');
  assert.match(helpFor(w, s, 'set '), /transform-set\s+Specify list of transform sets in priority order/);
  assert.match(helpFor(w, s, ''), /match\s+Match values\./);
});
