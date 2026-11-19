/** NAT commands: interface roles, pools, static and dynamic rules, IOS errors, "in use" prompts, clear, accepted extras. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, addDevice, getIos } from '../../src/engine/world.ts';
import { startSession, execLine, helpFor } from '../../src/engine/cli/framework.ts';
import type { CliSession } from '../../src/engine/cli/framework.ts';
import type { NatTranslation } from '../../src/engine/types.ts';
import * as acl from '../../src/engine/cli/commands/acl.ts';
import * as nat from '../../src/engine/cli/commands/nat.ts';
acl.install(); nat.install();

function lab(via: CliSession['via'] = 'console') {
  const w = createWorld();
  addDevice(w, { id: 'r1', model: 'isr4331', label: 'R1', x: 0, y: 0 });
  addDevice(w, { id: 'sw1', model: 'c9300l', label: 'SW1', x: 0, y: 0 });
  const { session: s } = startSession(w, 'r1', via);
  s.mode = 'config';
  const dev = getIos(w, 'r1');
  dev.config.interfaces['Serial0/1/0'].ip = { address: '60.50.30.1', mask: '255.255.255.252' };
  dev.config.interfaces['Loopback100'] = { name: 'Loopback100', shutdown: false, ip: { address: '60.50.50.100', mask: '255.255.255.255' } };
  const run = (l: string) => execLine(w, s, l);
  const ok = (l: string) => { const o = run(l); assert.equal(o.status, 'ok', `"${l}" → ${o.status}\n${o.output}`); return o; };
  return { w, s, dev, run, ok };
}
let nextT = 1;
function tr(insideLocal: string, insideGlobal: string, extra: Partial<NatTranslation> = {}): NatTranslation {
  return {
    id: nextT++, proto: 'icmp', insideLocal, insideLocalPort: 7, insideGlobal, insideGlobalPort: 7,
    outsideLocal: '60.50.40.2', outsideLocalPort: 7, outsideGlobal: '60.50.40.2', outsideGlobalPort: 7, createdTick: 1, ...extra,
  };
}

test('interface roles: ip nat inside / outside', () => {
  const { w, s, dev, ok, run } = lab();
  s.mode = 'config-if'; s.ctx = { ifNames: ['GigabitEthernet0/0/0'] };
  let o = ok('ip nat inside');
  assert.equal(o.feature, 'nat'); assert.equal(o.mutated, true);
  assert.equal(dev.config.interfaces['GigabitEthernet0/0/0'].natRole, 'inside');
  ok('ip nat outside');
  assert.equal(dev.config.interfaces['GigabitEthernet0/0/0'].natRole, 'outside', 'one role per interface');
  ok('no ip nat inside');
  assert.equal(dev.config.interfaces['GigabitEthernet0/0/0'].natRole, 'outside', 'no ip nat inside leaves outside alone');
  ok('no ip nat outside');
  assert.equal(dev.config.interfaces['GigabitEthernet0/0/0'].natRole, undefined);
  s.ctx = { ifNames: ['Serial0/1/0'] };
  ok('ip nat out');
  assert.equal(dev.config.interfaces['Serial0/1/0'].natRole, 'outside');
  assert.equal(run('ip nat').status, 'incomplete');
  assert.match(helpFor(w, s, 'ip nat '), /inside\s+Inside interface for address translation\n\s+outside\s+Outside interface for address translation/);
  // Catalyst NAT requires a routed physical port; a factory-default switchport is L2.
  const sw = startSession(w, 'sw1', 'console').session;
  sw.mode = 'config-if'; sw.ctx = { ifNames: ['GigabitEthernet1/0/1'] };
  const rejected = execLine(w, sw, 'ip nat inside');
  assert.equal(rejected.status, 'rejected');
  assert.match(rejected.output, /layer-2 switchport/);
});

test('reference lines and abbreviations', () => {
  const a = lab();
  a.ok('ip nat inside source static 192.168.100.10 60.50.50.100');
  a.ok('ip nat inside source list 1 interface Serial0/1/0 overload');
  const b = lab();
  b.ok('ip nat in so st 192.168.100.10 60.50.50.100');
  const o = b.ok('ip nat in so li 1 int s0/1/0 over');
  assert.equal(o.feature, 'nat');
  assert.deepEqual(b.dev.config.nat, a.dev.config.nat);
  assert.deepEqual(a.dev.config.nat.dynamicRules, [{ acl: '1', interface: 'Serial0/1/0', overload: true }]);
  assert.deepEqual(a.dev.config.nat.staticRules, [{ local: '192.168.100.10', global: '60.50.50.100' }]);
  const c = lab();
  c.ok('ip nat inside source list 1 interface serial 0/1/0 overload');
  assert.deepEqual(c.dev.config.nat.dynamicRules, [{ acl: '1', interface: 'Serial0/1/0', overload: true }]);
});

test('source list: interface implies overload, pool rules, replacement, notes', () => {
  const { dev, ok, run } = lab();
  let o = ok('ip nat inside source list 1 interface Serial0/1/0');
  assert.deepEqual(dev.config.nat.dynamicRules, [{ acl: '1', interface: 'Serial0/1/0', overload: true }], 'IOS XE adds overload');
  assert.ok(o.notes.some((n) => /overload/.test(n)));
  assert.ok(o.notes.some((n) => /Access list 1 does not exist/.test(n)));
  ok('access-list 2 permit 10.0.0.0 0.255.255.255');
  o = ok('ip nat inside source list 2 pool PUBLIC');
  assert.ok(o.notes.some((n) => /Pool PUBLIC does not exist/.test(n)));
  ok('ip nat inside source list 2 pool PUBLIC overload');
  assert.deepEqual(dev.config.nat.dynamicRules, [
    { acl: '1', interface: 'Serial0/1/0', overload: true }, { acl: '2', pool: 'PUBLIC', overload: true },
  ], 'one mapping per access list');
  ok('ip nat inside source list NAT-INSIDE pool PUBLIC');
  assert.equal(dev.config.nat.dynamicRules[2].acl, 'NAT-INSIDE');
  // interface that this router does not have
  const line = 'ip nat inside source list 1 interface Serial0/2/0 overload';
  o = run(line);
  assert.equal(o.status, 'rejected');
  assert.equal(o.output.split('\n')[0], ' '.repeat('Router(config)#'.length + line.indexOf('Serial0/2/0')) + '^');
  assert.equal(run('ip nat inside source list 1').status, 'incomplete');
  // removal without translations
  ok('no ip nat inside source list 2 pool PUBLIC overload');
  ok('no ip nat inside source list NAT-INSIDE');
  ok('no ip nat inside source list 9 pool X');
  assert.deepEqual(dev.config.nat.dynamicRules, [{ acl: '1', interface: 'Serial0/1/0', overload: true }]);
});

test('static rules: forms, duplicates, extendable', () => {
  const { dev, ok, run } = lab();
  ok('ip nat inside source static 192.168.100.10 60.50.50.100');
  ok('ip nat inside source static 192.168.100.10 60.50.50.100');
  assert.equal(dev.config.nat.staticRules.length, 1, 'the same line twice is kept once');
  let o = run('ip nat inside source static 192.168.100.10 60.50.50.101');
  assert.equal(o.status, 'rejected');
  assert.equal(o.output, '% 192.168.100.10 already mapped (192.168.100.10 -> 60.50.50.100)\n');
  o = run('ip nat inside source static 192.168.100.11 60.50.50.100');
  assert.equal(o.output, '%NAT: similar static entry (192.168.100.10 -> 60.50.50.100) in table_id 0 already exists\n');
  ok('ip nat inside source static 192.168.100.20 60.50.50.120 extendable');
  ok('ip nat inside source static 192.168.100.20 60.50.50.121 extendable');
  ok('ip nat inside source static tcp 192.168.100.30 80 60.50.30.1 8080');
  ok('ip nat inside source static udp 192.168.100.30 69 interface Serial0/1/0 69');
  ok('ip nat inside source static 192.168.100.40 interface Loopback100');
  assert.deepEqual(dev.config.nat.staticRules.slice(1), [
    { local: '192.168.100.20', global: '60.50.50.120', extendable: true },
    { local: '192.168.100.20', global: '60.50.50.121', extendable: true },
    { local: '192.168.100.30', global: '60.50.30.1', proto: 'tcp', localPort: 80, globalPort: 8080 },
    { local: '192.168.100.30', proto: 'udp', localPort: 69, globalPort: 69, interface: 'Serial0/1/0' },
    { local: '192.168.100.40', interface: 'Loopback100' },
  ]);
  o = run('ip nat inside source static tcp 192.168.100.31 81 60.50.30.1 8080');
  assert.match(o.output, /^%NAT: similar static entry \(192\.168\.100\.30 -> 60\.50\.30\.1\)/);
  assert.equal(run('ip nat inside source static tcp 192.168.100.30 0 60.50.30.1 80').status, 'invalid', 'ports are 1-65535');
  assert.equal(run('ip nat inside source static 192.168.100.10').status, 'incomplete');
  ok('no ip nat inside source static tcp 192.168.100.30 80 60.50.30.1 8080');
  ok('no ip nat inside source static 192.168.100.10 60.50.50.100');
  assert.equal(dev.config.nat.staticRules.length, 4);
});

test('pools: netmask, prefix-length, rotary and IOS checks', () => {
  const { dev, ok, run } = lab();
  ok('ip nat pool PUBLIC 60.50.30.5 60.50.30.6 netmask 255.255.255.248');
  ok('ip nat pool LB 192.168.100.20 192.168.100.22 prefix-length 24 type rotary');
  assert.deepEqual(dev.config.nat.pools, [
    { name: 'PUBLIC', start: '60.50.30.5', end: '60.50.30.6', mask: '255.255.255.248' },
    { name: 'LB', start: '192.168.100.20', end: '192.168.100.22', mask: '255.255.255.0', rotary: true },
  ]);
  let o = run('ip nat pool BAD 10.0.0.1 10.0.0.65 netmask 255.255.255.192');
  assert.equal(o.status, 'rejected');
  assert.equal(o.output, '%Pool BAD mask 255.255.255.192 too small; should be at least 255.255.255.128\n%Start and end addresses on different subnets\n');
  o = run('ip nat pool BAD 10.0.0.65 10.0.0.1 netmask 255.255.255.0');
  assert.equal(o.output, '%End address less than start address\n');
  o = ok('ip nat pool ONE 1.1.1.1 1.1.1.1 netmask 255.255.255.255');
  assert.equal(o.output, '%Pool ONE mask 255.255.255.255 too small; should be at least 255.255.255.252\n', 'a warning; the pool is still created');
  o = ok('ip nat pool TWO 1.1.1.1 1.1.1.1 prefix-length 32');
  assert.equal(o.output, '%Pool TWO prefix length 32 too large; should be no more than 30\n');
  assert.equal(dev.config.nat.pools.length, 4);
  assert.equal(run('ip nat pool X 1.1.1.1 1.1.1.2 netmask 255.0.255.0').status, 'rejected', 'non-contiguous mask');
  assert.equal(run('ip nat pool X 1.1.1.1 1.1.1.2 prefix-length 33').status, 'invalid');
  assert.equal(run('ip nat pool X 1.1.1.1 1.1.1.2').status, 'incomplete');
  ok('ip nat pool PUBLIC 60.50.30.5 60.50.30.6 prefix-length 29');
  assert.equal(dev.config.nat.pools.filter((p) => p.name === 'PUBLIC').length, 1, 'redefining replaces');
  ok('no ip nat pool ONE');
  ok('no ip nat pool TWO 1.1.1.1 1.1.1.1 prefix-length 32');
  assert.deepEqual(dev.config.nat.pools.map((p) => p.name), ['PUBLIC', 'LB']);
  ok('ip nat inside destination list 2 pool LB');
  assert.deepEqual(dev.config.nat.insideDestinationRules, [{ acl: '2', pool: 'LB' }]);
  ok('no ip nat inside destination list 2 pool LB');
  assert.deepEqual(dev.config.nat.insideDestinationRules, []);
});

test('removing a dynamic rule with translations asks first (console)', () => {
  const { s, dev, ok, run } = lab();
  ok('ip nat inside source list 1 interface Serial0/1/0 overload');
  dev.runtime.natTranslations = [tr('192.168.100.101', '60.50.30.1'), tr('192.168.100.10', '60.50.50.100', { fromStatic: true })];
  let o = ok('no ip nat inside source list 1 interface Serial0/1/0 overload');
  assert.equal(o.prompt, 'Dynamic mapping in use, do you want to delete all entries? [no]: ');
  o = run('');
  assert.equal(o.status, 'pending');
  assert.equal(o.prompt, 'Router(config)#');
  assert.equal(dev.config.nat.dynamicRules.length, 1, 'answer no (Enter) keeps the rule');
  ok('no ip nat inside source list 1 interface Serial0/1/0 overload');
  run('yes');
  assert.deepEqual(dev.config.nat.dynamicRules, []);
  assert.equal(dev.runtime.natTranslations.length, 1, 'its translations are deleted; the static session stays');
  assert.equal(s.pending, undefined);
});

test('removing a rule with translations: clear ip nat translation * first, or a file gets the IOS error', () => {
  const { s, dev, ok, run } = lab('file');
  ok('ip nat inside source list 1 interface Serial0/1/0 overload');
  ok('ip nat inside source static 192.168.100.10 60.50.50.100');
  ok('ip nat pool P 60.50.30.5 60.50.30.6 netmask 255.255.255.248');
  ok('ip nat inside source list 2 pool P');
  dev.runtime.natTranslations = [tr('192.168.100.101', '60.50.30.1'), tr('192.168.100.10', '60.50.50.100', { fromStatic: true }), tr('192.168.100.102', '60.50.30.5')];
  let o = run('no ip nat inside source list 1 interface Serial0/1/0 overload');
  assert.equal(o.status, 'rejected');
  assert.equal(o.output, '%Dynamic mapping in use, cannot remove\n');
  o = run('no ip nat inside source static 192.168.100.10 60.50.50.100');
  assert.equal(o.output, '%Static entry in use, cannot remove\n');
  o = run('no ip nat pool P');
  assert.equal(o.output, '%Pool P in use, cannot destroy\n');
  o = run('ip nat pool P 60.50.30.5 60.50.30.7 netmask 255.255.255.248');
  assert.equal(o.output, '%Pool P in use, cannot redefine\n');
  o = run('ip nat inside source list 1 pool P');
  assert.equal(o.output, '%Dynamic mapping in use, cannot remove\n', 'changing an in-use mapping');
  s.mode = 'priv';
  o = ok('clear ip nat translation *');
  assert.equal(o.feature, 'nat'); assert.equal(o.mutated, false);
  assert.deepEqual(dev.runtime.natTranslations, []);
  s.mode = 'config';
  ok('no ip nat inside source list 1 interface Serial0/1/0 overload');
  ok('no ip nat inside source static 192.168.100.10 60.50.50.100');
  ok('no ip nat inside source list 2 pool P');
  ok('no ip nat pool P');
  assert.deepEqual(dev.config.nat, { pools: [], staticRules: [], dynamicRules: [], insideDestinationRules: [] });
});

test('removing a static rule with sessions asks about child entries', () => {
  const { dev, ok, run } = lab();
  ok('ip nat inside source static 192.168.100.10 60.50.50.100');
  dev.runtime.natTranslations = [tr('192.168.100.10', '60.50.50.100', { fromStatic: true })];
  const o = ok('no ip nat inside source static 192.168.100.10 60.50.50.100');
  assert.equal(o.prompt, 'Static entry in use, do you want to delete child entries? [no]: ');
  run('y');
  assert.deepEqual(dev.config.nat.staticRules, []);
  assert.deepEqual(dev.runtime.natTranslations, []);
});

test('clear ip nat translation forms and statistics', () => {
  const { s, dev, ok, w } = lab();
  s.mode = 'priv';
  dev.runtime.natTranslations = [
    tr('192.168.100.101', '60.50.30.1'),
    tr('192.168.100.102', '60.50.30.1', { proto: 'tcp', insideLocalPort: 1025, insideGlobalPort: 1025 }),
    tr('192.168.100.103', '60.50.30.1', { outsideLocal: '60.50.40.9', outsideGlobal: '60.50.40.9' }),
  ];
  ok('clear ip nat translation inside 60.50.30.1 192.168.100.101');
  assert.equal(dev.runtime.natTranslations.length, 2);
  ok('clear ip nat translation tcp inside 60.50.30.1 1025 192.168.100.102 1025');
  assert.equal(dev.runtime.natTranslations.length, 1);
  ok('clear ip nat translation inside 60.50.30.1 192.168.100.103 outside 60.50.40.1 60.50.40.1');
  assert.equal(dev.runtime.natTranslations.length, 1, 'outside part must match too');
  ok('clear ip nat trans *');
  assert.equal(dev.runtime.natTranslations.length, 0);
  dev.runtime.natHits = 5; dev.runtime.natMisses = 2;
  ok('clear ip nat statistics');
  assert.equal(dev.runtime.natHits, 0); assert.equal(dev.runtime.natMisses, 0);
  assert.match(helpFor(w, s, 'clear ip nat translation '), /\*\s+Delete all dynamic translations/);
  s.mode = 'config';
  dev.runtime.natTranslations = [tr('1.1.1.1', '2.2.2.2')];
  ok('do clear ip nat translation *');
  assert.equal(dev.runtime.natTranslations.length, 0);
});

test('ip nat translation timers are accepted as extra lines', () => {
  const { dev, ok, run } = lab();
  let o = ok('ip nat translation timeout 120');
  assert.ok(o.notes.some((n) => /Accepted, but not simulated/.test(n)));
  ok('ip nat translation udp-timeout 300');
  ok('ip nat translation timeout 240');
  ok('ip nat translation tcp-timeout never');
  ok('ip nat translation port-timeout tcp 80 60');
  ok('ip nat translation max-entries 1000');
  assert.deepEqual(dev.config.extraLines, [
    'ip nat translation udp-timeout 300', 'ip nat translation timeout 240', 'ip nat translation tcp-timeout never',
    'ip nat translation port-timeout tcp 80 60', 'ip nat translation max-entries 1000',
  ]);
  ok('no ip nat translation timeout');
  ok('no ip nat translation max-entries 1000');
  assert.deepEqual(dev.config.extraLines, ['ip nat translation udp-timeout 300', 'ip nat translation tcp-timeout never', 'ip nat translation port-timeout tcp 80 60']);
  assert.equal(run('ip nat translation timeout').status, 'incomplete');
});

test('? help for NAT', () => {
  const { w, s } = lab();
  assert.match(helpFor(w, s, 'ip nat '), /inside\s+Inside address translation[\s\S]*pool\s+Define pool of addresses[\s\S]*translation/);
  assert.match(helpFor(w, s, 'ip nat inside source '), /list\s+Specify access list describing local addresses\n\s+static\s+Specify static local->global mapping/);
  assert.match(helpFor(w, s, 'ip nat inside source list 1 '), /interface\s+Specify interface for global address\n\s+pool\s+Name pool of global addresses/);
  assert.match(helpFor(w, s, 'ip nat inside source list 1 interface Serial0/1/0 '), /overload\s+Overload an address translation\n\s+<cr>/);
  assert.match(helpFor(w, s, 'ip nat pool P 1.1.1.1 1.1.1.9 '), /netmask[\s\S]*prefix-length/);
});
