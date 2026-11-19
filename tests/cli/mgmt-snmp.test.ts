/** snmp-server commands: reference lines, course lab lines, abbreviations, normalisation, `no` forms, help. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, addDevice, getIos } from '../../src/engine/world.ts';
import { startSession, execLine, helpFor } from '../../src/engine/cli/framework.ts';
import * as snmp from '../../src/engine/cli/commands/snmp.ts';
snmp.install();

function lab(model: 'isr4331' | 'c9300l' = 'isr4331') {
  const w = createWorld();
  addDevice(w, { id: 'r1', model, label: 'R1', x: 0, y: 0 });
  const { session: s } = startSession(w, 'r1', 'console');
  s.mode = 'config';
  const dev = getIos(w, 'r1');
  if (model === 'isr4331') dev.config.interfaces['Loopback100'] = { name: 'Loopback100', shutdown: false };
  const run = (l: string) => execLine(w, s, l);
  const ok = (l: string) => {
    const o = run(l);
    assert.equal(o.status, 'ok', `"${l}" → ${o.status}\n${o.output}`);
    assert.equal(o.feature, 'snmp', l);
    assert.equal(o.mutated, true, l);
    return o;
  };
  return { w, s, dev, run, ok };
}

test('reference configuration lines (R1 and R2) and abbreviations', () => {
  const a = lab();
  a.ok('snmp-server community D105read RO 10');
  a.ok('snmp-server community D105write RW 11');
  assert.deepEqual(a.dev.config.snmp, {
    communities: [{ name: 'D105read', access: 'ro', acl: '10' }, { name: 'D105write', access: 'rw', acl: '11' }],
    hosts: [], enableTraps: [], views: [],
  });
  const b = lab();
  b.ok('snmp-s comm D105read ro 10');
  b.ok('snmp com D105write rw 11');
  assert.deepEqual(b.dev.config.snmp, a.dev.config.snmp);
});

test('community forms: default RO, views, named ACLs, replacement', () => {
  const { dev, ok, run } = lab();
  ok('snmp-server community public');
  ok('snmp-server community private rw');
  ok('snmp-server community D105system view onlysystemdetails RO');
  ok('snmp-server community mgmt RO allowPC1');
  ok('snmp-server community legacy 10');
  assert.deepEqual(dev.config.snmp.communities, [
    { name: 'public', access: 'ro' },
    { name: 'private', access: 'rw' },
    { name: 'D105system', access: 'ro', view: 'onlysystemdetails' },
    { name: 'mgmt', access: 'ro', acl: 'allowPC1' },
    { name: 'legacy', access: 'ro', acl: '10' },
  ]);
  ok('snmp-server community public RW 11');
  assert.deepEqual(dev.config.snmp.communities[0], { name: 'public', access: 'rw', acl: '11' }, 'same community string replaces');
  assert.equal(dev.config.snmp.communities.length, 5);
  assert.equal(run('snmp-server community').status, 'incomplete');
  assert.equal(run('snmp-server community x view').status, 'rejected');
  assert.equal(run('snmp-server community x r').status, 'ambiguous');
  ok('no snmp-server community legacy');
  ok('no snmp-server community mgmt RO allowPC1');
  assert.deepEqual(dev.config.snmp.communities.map((c) => c.name), ['public', 'private', 'D105system']);
});

test('course lab solution lines (Sietovy_manazment_LAB)', () => {
  const { dev, ok } = lab();
  ok('snmp-server community D105read RO 10');
  ok('snmp-server community D105write RW 11');
  let o = ok('snmp-server location D105');
  ok('snmp-server contact d105@fiit.stuba.sk');
  o = ok('snmp-server system-shutdown');
  assert.ok(o.notes.some((n) => /Accepted, but not simulated/.test(n)));
  ok('snmp-server packetsize 1000');
  ok('snmp-server ifindex persist');
  ok('snmp-server host 192.168.100.10 version 2c D105read');
  o = ok('snmp-server trap-source Loopback100');
  assert.deepEqual(o.notes, []);
  ok('snmp-server enable traps config');
  ok('snmp-server enable traps bgp');
  ok('snmp-server enable traps hsrp');
  ok('snmp-server enable traps vrrp');
  ok('snmp-server enable traps ospf lsa lsa-originate');
  ok('snmp-server view onlysystemdetails system included');
  ok('snmp-server community D105system view onlysystemdetails RO');
  assert.deepEqual(dev.config.snmp, {
    communities: [
      { name: 'D105read', access: 'ro', acl: '10' }, { name: 'D105write', access: 'rw', acl: '11' },
      { name: 'D105system', access: 'ro', view: 'onlysystemdetails' },
    ],
    hosts: [{ address: '192.168.100.10', community: 'D105read', version: '2c', type: 'traps' }],
    enableTraps: ['config', 'bgp', 'hsrp', 'vrrp', 'ospf lsa lsa-originate'],
    views: [{ name: 'onlysystemdetails', oid: 'system', included: true }],
    location: 'D105', contact: 'd105@fiit.stuba.sk', trapSource: 'Loopback100',
    extraLines: ['snmp-server system-shutdown', 'snmp-server packetsize 1000', 'snmp-server ifindex persist'],
  });
});

test('host forms', () => {
  const { dev, ok, run } = lab();
  ok('snmp-server host 192.168.100.10 public');
  const inform = ok('snmp-server host 192.168.100.10 informs version 2c private');
  assert.ok(inform.notes.some((n) => /does not send a notification/.test(n)));
  ok('snmp-server host 10.0.0.1 traps version 1 public');
  let o = ok('snmp-server host 10.0.0.2 version 3 priv admin');
  assert.ok(o.notes.some((n) => /does not send a notification/.test(n)));
  ok('snmp-server host 10.0.0.3 public CONFIG snmp');
  assert.deepEqual(dev.config.snmp.hosts, [
    { address: '192.168.100.10', community: 'public', type: 'traps' },
    { address: '192.168.100.10', community: 'private', version: '2c', type: 'informs' },
    { address: '10.0.0.1', community: 'public', version: '1', type: 'traps' },
    { address: '10.0.0.2', community: 'admin', version: '3', type: 'traps', securityLevel: 'priv' },
    { address: '10.0.0.3', community: 'public', type: 'traps', notificationTypes: ['config', 'snmp'] },
  ]);
  ok('snmp-server host 10.0.0.1 version 2c replacement');
  assert.equal(dev.config.snmp.hosts[2].community, 'replacement', 'same host and notification kind replaces');
  let e = run('snmp-server host 10.0.0.1 version 2c');
  assert.equal(e.output, '% Incomplete command.\n', 'community missing');
  assert.equal(run('snmp-server host 10.0.0.1').status, 'incomplete');
  ok('snmp-server host 10.0.0.1 version 3 admin');
  assert.equal(dev.config.snmp.hosts[2].securityLevel, 'noauth');
  assert.match(run('snmp-server host 10.0.0.1 version 3 auth').output, /Incomplete command/);
  for (const version of ['', ' version 1']) {
    assert.match(run(`snmp-server host 10.0.0.1 informs${version} public`).output, /SNMPv1 does not support informs/);
  }
  ok('no snmp-server host 192.168.100.10');
  assert.equal(dev.config.snmp.hosts[0].type, 'informs', 'bare no form removes only traps');
  e = run('snmp-server host 10.0.0.1 version 4 public');
  assert.equal(e.output.split('\n')[1], "% Invalid input detected at '^' marker.");
  assert.equal(dev.config.snmp.hosts.length, 4, 'nothing stored by failed lines');
  ok('no snmp-server host 192.168.100.10 informs version 2c private');
  assert.equal(dev.config.snmp.hosts.length, 3);
  ok('no snmp-server host 10.0.0.1');
  assert.deepEqual(dev.config.snmp.hosts.map((h) => h.address), ['10.0.0.2', '10.0.0.3']);
});

test('enable traps, trap-source, view and their no forms', () => {
  const { dev, ok, run } = lab();
  ok('snmp-server enable traps');
  ok('snmp-server enable traps');
  ok('snmp-server enable traps snmp authentication linkdown linkup coldstart warmstart');
  ok('snmp-server enable traps ospf');
  assert.deepEqual(dev.config.snmp.enableTraps, ['all', 'snmp authentication linkdown linkup coldstart warmstart', 'ospf']);
  assert.equal(run('snmp-server enable traps nonsense').status, 'invalid');
  ok('no snmp-server enable traps snmp');
  assert.deepEqual(dev.config.snmp.enableTraps, ['all', 'ospf']);
  ok('no snmp-server enable traps');
  assert.deepEqual(dev.config.snmp.enableTraps, []);
  // trap source: canonical name; a port the router does not have is invalid; a loopback not created yet gets a remark
  ok('snmp-server trap-source lo100');
  assert.equal(dev.config.snmp.trapSource, 'Loopback100');
  const o = ok('snmp-server trap-source Loopback5');
  assert.ok(o.notes.some((n) => /Loopback5 does not exist yet/.test(n)));
  assert.equal(run('snmp-server trap-source GigabitEthernet0/0/9').status, 'rejected');
  ok('no snmp-server trap-source');
  assert.equal(dev.config.snmp.trapSource, undefined);
  ok('snmp-server view V1 1.3.6.1.2.1.1 included');
  ok('snmp-server view V1 1.3.6.1.2.1.1.5 excluded');
  ok('snmp-server view V1 1.3.6.1.2.1.1.5 included');
  assert.deepEqual(dev.config.snmp.views, [{ name: 'V1', oid: '1.3.6.1.2.1.1', included: true }, { name: 'V1', oid: '1.3.6.1.2.1.1.5', included: true }]);
  ok('no snmp-server view V1 1.3.6.1.2.1.1.5');
  assert.equal(dev.config.snmp.views.length, 1);
  ok('no snmp-server view V1');
  assert.equal(dev.config.snmp.views.length, 0);
  ok('snmp-server location Room D105');
  ok('snmp-server contact admin');
  ok('no snmp-server location');
  ok('no snmp-server contact admin');
  assert.equal(dev.config.snmp.location, undefined);
  assert.equal(dev.config.snmp.contact, undefined);
});

test('accepted extras and no snmp-server', () => {
  const { dev, ok, run } = lab();
  ok('snmp-server community D105read RO 10');
  ok('snmp-server host 192.168.100.10 D105read');
  ok('snmp-server enable traps');
  ok('snmp-server location D105');
  ok('snmp-server packetsize 1000');
  ok('snmp-server packetsize 1400');
  ok('snmp-server chassis-id R1 chassis');
  ok('snmp-server queue-length 20');
  ok('snmp-server trap timeout 30');
  ok('snmp-server manager');
  assert.deepEqual(dev.config.snmp.extraLines, ['snmp-server packetsize 1400', 'snmp-server chassis-id R1 chassis',
    'snmp-server queue-length 20', 'snmp-server trap timeout 30', 'snmp-server manager']);
  assert.equal(run('snmp-server packetsize 100').status, 'invalid');
  ok('no snmp-server packetsize');
  ok('no snmp-server manager');
  assert.equal(dev.config.snmp.extraLines?.length, 3);
  ok('no snmp-server');
  assert.deepEqual(dev.config.snmp, { communities: [], hosts: [], enableTraps: [], views: [], extraLines: [] });
});

test('works on the Catalyst switch too, and ? help reads like IOS', () => {
  const sw = lab('c9300l');
  sw.ok('snmp-server community public RO');
  assert.equal(sw.dev.config.snmp.communities.length, 1);
  const { w, s } = lab();
  assert.match(helpFor(w, s, 'snmp-server '), /community\s+Enable SNMP; set community string and access privs/);
  assert.match(helpFor(w, s, 'snmp-server '), /view\s+Define an SNMPv2 MIB view/);
  assert.match(helpFor(w, s, 'snmp-server community X '), /WORD\s+Std IP accesslist[\s\S]*ro\s+Read-only[\s\S]*rw\s+Read-write[\s\S]*view\s+Restrict/);
  assert.match(helpFor(w, s, 'snmp-server host 1.1.1.1 '), /informs[\s\S]*traps\s+Send Trap messages[\s\S]*version/);
  assert.match(helpFor(w, s, 'snmp-server host 1.1.1.1 version '), /1\s+Use SNMPv1\n\s+2c\s+Use SNMPv2c\n\s+3\s+Use the SNMPv3 security model/);
  assert.match(helpFor(w, s, 'snmp-server enable '), /traps\s+Enable SNMP Traps/);
  assert.match(helpFor(w, s, 'snmp-server enable traps '), /config\s+Enable SNMP config traps[\s\S]*<cr>/);
});
