/** Named lists (config-std-nacl / config-ext-nacl), sequence-number editing, type conflicts, ip access-group, clear counters. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, addDevice, getIos } from '../../src/engine/world.ts';
import { startSession, execLine, helpFor } from '../../src/engine/cli/framework.ts';
import * as acl from '../../src/engine/cli/commands/acl.ts';
acl.install();

function lab(model: 'isr4331' | 'c9300l' = 'isr4331') {
  const w = createWorld();
  addDevice(w, { id: 'r1', model, label: 'R1', x: 0, y: 0 });
  const { session: s } = startSession(w, 'r1', 'console');
  s.mode = 'config';
  const dev = getIos(w, 'r1');
  const run = (l: string) => execLine(w, s, l);
  const ok = (l: string) => { const o = run(l); assert.equal(o.status, 'ok', `"${l}" → ${o.status}\n${o.output}`); return o; };
  const seqs = (id: string) => dev.config.acls[id].entries.map((e) => `${e.seq} ${e.action}${e.remark ? ' ' + e.remark : ''}`);
  return { w, s, dev, run, ok, seqs };
}

test('entering a named list creates it and sets the mode context', () => {
  const { s, dev, ok } = lab();
  let o = ok('ip access-list extended matchGuaranteed');
  assert.equal(o.prompt, 'Router(config-ext-nacl)#');
  assert.equal(o.mutated, false, 'navigation');
  assert.deepEqual(s.ctx, { acl: 'matchGuaranteed', type: 'extended' });
  assert.deepEqual(dev.config.acls.matchGuaranteed, { id: 'matchGuaranteed', type: 'extended', named: true, entries: [] });
  o = ok('exit');
  assert.equal(o.prompt, 'Router(config)#');
  o = ok('ip access-list standard allowPC1');
  assert.equal(o.prompt, 'Router(config-std-nacl)#');
  assert.deepEqual(s.ctx, { acl: 'allowPC1', type: 'standard' });
  o = ok('permit 192.168.100.10');
  assert.equal(o.mutated, true);
  assert.equal(o.feature, 'acl');
  assert.deepEqual(dev.config.acls.allowPC1.entries, [{ seq: 10, action: 'permit', protocol: 'ip', src: { kind: 'host', address: '192.168.100.10' }, dst: { kind: 'any' } }]);
  ok('end');
  assert.equal(s.mode, 'priv');
});

test('sequence numbers: append, insert, duplicate, remove', () => {
  const { dev, ok, run, seqs } = lab();
  ok('ip access-list extended TEST');
  ok('permit tcp any any eq www');
  ok('deny ip any any');
  ok('15 permit icmp any any echo');
  assert.deepEqual(seqs('TEST'), ['10 permit', '15 permit', '20 deny']);
  let o = run('15 permit udp any any');
  assert.equal(o.status, 'rejected');
  assert.equal(o.output, '% Duplicate sequence number\n');
  ok('permit udp any any eq 53');
  assert.deepEqual(seqs('TEST'), ['10 permit', '15 permit', '20 deny', '30 permit'], 'next number = highest + 10');
  ok('no 15');
  ok('no deny ip any any');
  assert.deepEqual(seqs('TEST'), ['10 permit', '30 permit']);
  ok('no permit tcp any any eq 80');
  assert.deepEqual(seqs('TEST'), ['30 permit'], '"no permit …" matches the entry written with a port name');
  ok('no 99');
  o = run('no permit tcp any any eq ssh');
  assert.equal(o.status, 'rejected', 'the removed entry is parsed like a new one');
  ok('5 remark web traffic');
  ok('5 permit tcp any any eq www');
  ok('remark the rest');
  ok('deny ip any any log');
  assert.deepEqual(seqs('TEST'), ['5 remark web traffic', '5 permit', '30 permit', '40 remark the rest', '40 deny']);
  dev.runtime.aclHits = { 'TEST:5': 3, 'TEST:30': 1 };
  ok('no 5');
  assert.deepEqual(seqs('TEST'), ['30 permit', '40 remark the rest', '40 deny'], 'an entry goes with its remark');
  assert.deepEqual(dev.runtime.aclHits, { 'TEST:30': 1 });
  ok('no remark the rest');
  assert.deepEqual(seqs('TEST'), ['30 permit', '40 deny']);
});

test('standard named list entries', () => {
  const { dev, ok, run } = lab();
  ok('ip access-list standard MGMT');
  ok('permit host 192.168.100.10');
  ok('permit 10.0.0.0 0.255.255.255 log');
  ok('deny any');
  assert.deepEqual(dev.config.acls.MGMT.entries.map((e) => e.src), [
    { kind: 'host', address: '192.168.100.10' }, { kind: 'net', address: '10.0.0.0', wildcard: '0.255.255.255' }, { kind: 'any' },
  ]);
  assert.equal(dev.config.acls.MGMT.entries[1].log, true);
  const o = run('permit tcp any any');
  assert.equal(o.status, 'invalid', 'extended syntax in a standard list');
  assert.equal(o.output.split('\n')[0], ' '.repeat('Router(config-std-nacl)#permit '.length) + '^');
});

test('numbered and named forms edit the same list', () => {
  const { dev, ok, seqs } = lab();
  ok('access-list 110 permit tcp any any eq www');
  ok('access-list 110 permit ip any any');
  ok('ip access-list extended 110');
  ok('15 deny tcp any any eq 23');
  assert.deepEqual(seqs('110'), ['10 permit', '15 deny', '20 permit']);
  assert.equal(dev.config.acls['110'].named, false, 'a list made with access-list N stays numbered');
  ok('exit');
  ok('ip access-list standard 10');
  ok('permit 192.168.100.10');
  assert.equal(dev.config.acls['10'].named, true, 'a list made with ip access-list is named');
  ok('access-list 10 permit host 60.50.40.2');
  assert.deepEqual(seqs('10'), ['10 permit', '20 permit']);
  assert.equal(dev.config.acls['10'].named, true);
  ok('ip access-list standard 1300');
  ok('exit');
  assert.equal(dev.config.acls['1300'].type, 'standard');
});

test('type conflicts and invalid names are refused', () => {
  const { s, dev, ok, run } = lab();
  ok('ip access-list standard allowPC1');
  ok('exit');
  let o = run('ip access-list extended allowPC1');
  assert.equal(o.status, 'rejected');
  assert.equal(o.output, 'Access-list type conflicts with prior definition\n% A named standard IP access list with this name already exists\n');
  assert.equal(s.mode, 'config');
  ok('ip access-list extended WEB');
  ok('exit');
  o = run('ip access-list standard WEB');
  assert.equal(o.output, 'Access-list type conflicts with prior definition\n% A named extended IP access list with this name already exists\n');
  o = run('ip access-list standard 110');
  assert.equal(o.status, 'rejected');
  assert.equal(o.output, '% Invalid access list name.\n');
  assert.equal(run('ip access-list extended 10').output, '% Invalid access list name.\n');
  assert.equal(run('ip access-list extended 250').output, '% Invalid access list name.\n');
  assert.equal(dev.config.acls['110'], undefined);
  o = run('no ip access-list extended allowPC1');
  assert.equal(o.status, 'rejected');
  assert.ok(dev.config.acls.allowPC1);
  ok('no ip access-list standard allowPC1');
  assert.equal(dev.config.acls.allowPC1, undefined);
  ok('no ip access-list extended NOPE');
});

test('resequence renumbers entries, remarks and counters', () => {
  const { dev, ok, seqs } = lab();
  ok('ip access-list extended R');
  ok('permit icmp any any echo-reply');
  ok('remark web');
  ok('permit tcp any any eq www');
  ok('56 deny tcp 192.168.0.0 0.0.255.255 any eq 80');
  dev.runtime.aclHits = { 'R:10': 5 };
  ok('exit');
  ok('ip access-list resequence R 50 25');
  assert.deepEqual(seqs('R'), ['50 permit', '75 remark web', '75 permit', '100 deny']);
  assert.deepEqual(dev.runtime.aclHits, { 'R:50': 5 });
});

test('a global command typed in a named-ACL mode runs in global configuration', () => {
  const { s, dev, ok } = lab();
  ok('ip access-list extended X');
  const o = ok('access-list 1 permit any');
  assert.equal(o.prompt, 'Router(config)#');
  assert.equal(s.mode, 'config');
  assert.ok(dev.config.acls['1']);
  ok('ip access-list ext X');
  ok('ip access-list st Y');
  assert.equal(s.mode, 'config-std-nacl');
});

test('? help in named-ACL modes', () => {
  const { w, s, ok } = lab();
  ok('ip access-list extended X');
  const root = helpFor(w, s, '');
  for (const k of ['<1-2147483647>', 'deny', 'permit', 'remark', 'no', 'exit']) assert.ok(root.includes(k), k);
  assert.match(helpFor(w, s, '10 '), /deny[\s\S]*permit[\s\S]*remark/);
  assert.match(helpFor(w, s, 'permit tcp any any eq '), /WORD\s+Port number/);
  ok('exit');
  assert.match(helpFor(w, s, 'ip access-list '), /extended\s+Extended Access List[\s\S]*resequence[\s\S]*standard\s+Standard Access List/);
  assert.match(helpFor(w, s, 'ip access-list standard '), /<1-99>[\s\S]*<1300-1999>[\s\S]*WORD\s+Access-list name/);
});

test('ip access-group on interfaces (and interface ranges, switches)', () => {
  const { s, dev, ok, run } = lab();
  s.mode = 'config-if'; s.ctx = { ifNames: ['GigabitEthernet0/0/0'] };
  let o = ok('ip access-group 110 in');
  assert.equal(o.feature, 'acl');
  assert.equal(o.mutated, true);
  assert.ok(o.notes.some((n) => /does not exist yet/.test(n)), 'applying an undefined list is accepted, with a remark');
  assert.equal(dev.config.interfaces['GigabitEthernet0/0/0'].aclIn, '110');
  ok('ip access-group allowWeb out');
  ok('ip access-group 120 in');
  assert.equal(dev.config.interfaces['GigabitEthernet0/0/0'].aclIn, '120', 'a second list replaces the first');
  assert.equal(dev.config.interfaces['GigabitEthernet0/0/0'].aclOut, 'allowWeb');
  ok('no ip access-group in');
  ok('no ip access-group allowWeb out');
  assert.equal(dev.config.interfaces['GigabitEthernet0/0/0'].aclIn, undefined);
  assert.equal(dev.config.interfaces['GigabitEthernet0/0/0'].aclOut, undefined);
  assert.equal(run('ip access-group 110').status, 'incomplete');
  assert.equal(run('ip access-group 110 both').status, 'invalid');
  s.ctx = { ifNames: ['GigabitEthernet0/0/1', 'GigabitEthernet0/0/2'], range: true };
  ok('ip access-g 1 i');
  assert.equal(dev.config.interfaces['GigabitEthernet0/0/1'].aclIn, '1');
  assert.equal(dev.config.interfaces['GigabitEthernet0/0/2'].aclIn, '1');

  const sw = lab('c9300l');
  sw.s.mode = 'config-if'; sw.s.ctx = { ifNames: ['GigabitEthernet1/0/1'] };
  sw.ok('ip access-group 10 in');
  assert.equal(sw.dev.config.interfaces['GigabitEthernet1/0/1'].aclIn, '10');
  sw.s.mode = 'config';
  sw.ok('access-list 10 permit any');
});

test('clear access-list counters', () => {
  const { s, dev, ok, w } = lab();
  s.mode = 'priv';
  dev.runtime.aclHits = { '110:10': 5, '110:20': 1, '120:10': 3, allowPC1: 0 };
  let o = ok('clear access-list counters 110');
  assert.equal(o.mutated, false);
  assert.equal(o.feature, 'acl');
  assert.deepEqual(dev.runtime.aclHits, { '120:10': 3, allowPC1: 0 });
  ok('clear ip access-list counters 120');
  assert.deepEqual(dev.runtime.aclHits, { allowPC1: 0 });
  dev.runtime.aclHits = { '1:10': 2 };
  o = ok('clear access-list counters');
  assert.deepEqual(dev.runtime.aclHits, {});
  s.mode = 'config';
  o = execLine(w, s, 'do clear access-list counters');
  assert.equal(o.status, 'ok');
  assert.equal(o.prompt, 'Router(config)#');
});
