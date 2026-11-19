/**
 * Every verification command must work on a factory-fresh router and switch (and on a half-configured one),
 * user EXEC gets the IOS subset, unknown `show` sub-commands keep the normal invalid-input error.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installCli, execLine, startSession, helpFor } from '../../src/engine/cli/index.ts';
import type { ExecOutcome } from '../../src/engine/cli/framework.ts';
import { addDevice, createWorld, getIos } from '../../src/engine/world.ts';
import type { World } from '../../src/engine/types.ts';

installCli();

const ROUTER_SHOWS = [
  'show ip interface brief', 'show ip interface', 'show ip interface g0/0/0', 'show interfaces', 'show interfaces Serial0/1/0',
  'show interfaces description', 'show controllers', 'show controllers serial 0/1/0', 'show controllers g0/0/1', 'show protocols',
  'show ip route', 'show ip route static', 'show ip route connected', 'show ip route 10.0.0.1', 'show ip route 0.0.0.0',
  'show ip route 10.0.0.0 255.0.0.0', 'show ip protocols', 'show ip static route',
  'show ip dhcp binding', 'show ip dhcp pool', 'show ip dhcp conflict', 'show ip dhcp server statistics',
  'show access-lists', 'show access-lists 110', 'show ip access-lists', 'show ip nat translations', 'show ip nat translations verbose',
  'show ip nat statistics', 'show crypto isakmp policy', 'show crypto isakmp sa', 'show crypto isakmp sa detail', 'show crypto isakmp key',
  'show crypto ipsec sa', 'show crypto ipsec transform-set', 'show crypto map', 'show crypto session', 'show crypto session detail',
  'show class-map', 'show policy-map', 'show policy-map interface', 'show policy-map interface Serial0/1/0 output',
  'show snmp', 'show snmp community', 'show snmp host', 'show logging', 'show users', 'show line', 'show line vty 0', 'show line console 0',
  'show line 0', 'show terminal', 'show privilege', 'show sessions', 'show version', 'show clock', 'show clock detail', 'show history',
  'show hosts', 'show arp', 'show ip arp', 'show cdp', 'show cdp neighbors', 'show cdp neighbors detail', 'show cdp entry *',
  'show inventory', 'show platform', 'show flash:', 'show license', 'show license summary', 'show aliases', 'show debugging',
];
const SWITCH_SHOWS = [
  'show ip interface brief', 'show interfaces', 'show interfaces status', 'show interfaces trunk', 'show interfaces vlan 1', 'show vlan',
  'show vlan brief', 'show mac address-table', 'show mac address-table dynamic', 'show ip route', 'show ip interface', 'show arp',
  'show cdp neighbors', 'show version', 'show inventory', 'show users', 'show line', 'show logging', 'show access-lists', 'show class-map',
  'show policy-map interface', 'show protocols', 'show controllers', 'show snmp', 'show flash:', 'show license',
  'show ip nat translations', 'show ip nat translations verbose', 'show ip nat statistics',
];

function fresh(model: 'isr4331' | 'c9300l', serialModule = true) {
  const w = createWorld();
  addDevice(w, { id: 'D', model, label: 'D', x: 0, y: 0, serialModule });
  const { session, outcome } = startSession(w, 'D', 'console');
  assert.match(outcome.output, /System Configuration Dialog/);
  execLine(w, session, 'no');
  execLine(w, session, '');
  const run = (l: string): ExecOutcome => execLine(w, session, l);
  return { w, session, run };
}
function runAll(run: (l: string) => ExecOutcome, cmds: string[]): void {
  for (const c of cmds) {
    const o = run(c);
    assert.equal(o.status, 'ok', `${c} → ${o.status}\n${o.output}`);
    assert.equal(o.mutated, false, c);
    assert.equal(o.feature, 'verify', c);
  }
}

test('every show command works on a factory-fresh ISR 4331 (with and without the NIM-2T)', () => {
  const r = fresh('isr4331');
  r.run('enable');
  runAll(r.run, ROUTER_SHOWS);
  assert.match(r.run('show ip route').output, /Gateway of last resort is not set\n\n$/);
  assert.match(r.run('show ip interface brief').output, /^GigabitEthernet0\/0\/0 {3}unassigned {6}YES unset  administratively down down$/m);
  assert.match(r.run('show controllers serial 0/1/0').output, /No serial cable attached/);
  assert.match(r.run('show snmp').output, /^%SNMP agent not enabled$/m);
  assert.match(r.run('show ip nat translations').output, /^Total number of translations: 0$/m);
  assert.match(r.run('show crypto isakmp policy').output, /^Default protection suite$/m);
  assert.match(r.run('show cdp neighbors').output, /Total cdp entries displayed : 0/);
  assert.match(r.run('show version').output, /^Router uptime is /m);
  const noNim = fresh('isr4331', false);
  noNim.run('enable');
  runAll(noNim.run, ROUTER_SHOWS.filter((c) => !/[Ss]erial/.test(c)));
  assert.doesNotMatch(noNim.run('show version').output, /Serial interfaces/);
  assert.doesNotMatch(noNim.run('show inventory').output, /NIM-2T/);
  assert.equal(noNim.run('show interfaces Serial0/1/0').status, 'rejected');
});

test('every show command works on a factory-fresh Catalyst 9300L', () => {
  const s = fresh('c9300l');
  s.run('enable');
  runAll(s.run, SWITCH_SHOWS);
  assert.match(s.run('show ip nat translations').output, /Total number of translations: 0/);
  assert.match(s.run('show version').output, /Classroom profile: Network Advantage/);
  assert.match(s.run('show interfaces status').output, /^Gi1\/0\/24 {24}notconnect/m);
  assert.match(s.run('show mac address-table dynamic').output, /Total Mac Addresses for this criterion: 0/);
});

test('half-configured router: undefined ACL / policy-map / crypto map references do not crash', () => {
  const r = fresh('isr4331');
  const cfg = getIos(r.w, 'D').config;
  const gi = cfg.interfaces['GigabitEthernet0/0/0'];
  Object.assign(gi, { shutdown: false, ip: { address: '10.0.0.1', mask: '255.255.255.0' }, aclIn: '199', servicePolicyOut: 'NOPE', cryptoMap: 'NOMAP', natRole: 'inside', helperAddresses: ['1.1.1.1', '2.2.2.2'] });
  cfg.qos.policyMaps.push({ name: 'P', classes: [{ className: 'missing', bandwidth: { percent: 20 } }, { className: 'class-default', servicePolicy: 'ghost', shapeAverage: { bps: 64000 } }] });
  cfg.interfaces['Serial0/1/0'].servicePolicyOut = 'P';
  cfg.crypto.maps.push({ name: 'M', entries: [{ seq: 10, type: 'ipsec-isakmp', peers: [], transformSets: ['none'] }] });
  cfg.nat.dynamicRules.push({ acl: '7', pool: 'nopool', overload: false });
  cfg.dhcp.pools.push({ name: 'EMPTY', defaultRouters: [], dnsServers: [] });
  cfg.staticRoutes.push({ prefix: '10.9.0.0', mask: '255.255.0.0', nextHop: '172.16.0.1' });
  r.run('enable');
  runAll(r.run, ROUTER_SHOWS);
  assert.match(r.run('show ip interface g0/0/0').output, /^ {2}Helper addresses are 1\.1\.1\.1\n {23}2\.2\.2\.2$/m);
  assert.match(r.run('show policy-map interface Serial0/1/0').output, /\(policy-map ghost is not defined\)/);
  assert.match(r.run('show policy-map interface Serial0/1/0').output, /shape \(average\) cir 64000/);
  assert.match(r.run('show ip static route').output, /^M {2}10\.9\.0\.0\/16 \[1\/0\] via 172\.16\.0\.1 \[N\]$/m);
  assert.match(r.run('show crypto map').output, /No matching address list set\./);
});

test('user EXEC subset, privileged-only commands, do-show from configuration mode, unknown show sub-commands', () => {
  const r = fresh('isr4331');
  for (const c of ['show version', 'show ip interface brief', 'show ip route', 'show interfaces', 'show clock', 'show cdp neighbors', 'show users', 'show privilege', 'show arp']) {
    assert.equal(r.run(c).status, 'ok', c);
  }
  assert.match(r.run('show privilege').output, /Current privilege level is 1/);
  for (const c of ['show access-lists', 'show ip nat translations', 'show crypto ipsec sa', 'show policy-map interface', 'show logging']) {
    assert.equal(r.run(c).status, 'invalid', c);
  }
  r.run('enable');
  // unknown show sub-commands: normal IOS caret error, nothing swallowed
  const o = r.run('show ip foo');
  assert.equal(o.status, 'invalid');
  assert.equal(o.output.split('\n')[0], ' '.repeat('Router#show ip '.length) + '^');
  assert.equal(r.run('show frobnicate').status, 'invalid');
  assert.equal(r.run('show crypto ipsec bogus').status, 'invalid');
  // abbreviations
  assert.equal(r.run('sh ip int br').status, 'ok');
  assert.equal(r.run('sh run').status, 'ok');
  assert.equal(r.run('sh ip ro').status, 'ok');
  assert.equal(r.run('sh cry isa sa').status, 'ok');
  assert.equal(r.run('sh policy-map int').status, 'ok');
  // do show from configuration mode, with the caret in the right column
  r.run('configure terminal');
  const d = r.run('do show ip interface brief');
  assert.equal(d.status, 'ok');
  assert.equal(d.prompt, 'Router(config)#');
  const bad = r.run('do show interfaces gi0/0/9');
  assert.equal(bad.status, 'rejected');
  assert.equal(bad.output.split('\n')[0], ' '.repeat('Router(config)#do show interfaces gi'.length) + '^');
  // ? help lists the show keywords
  const s = r.session;
  r.run('end');
  assert.match(helpFor(r.w, s, 'show '), /policy-map/);
  assert.match(helpFor(r.w, s, 'show ip '), /interface\s+Interface status and configuration/);
  // the output filters of the framework apply
  const f = r.run('show ip interface brief | include Serial');
  assert.equal(f.output.trim().split('\n').length, 2);
});

test('show output reflects live changes (shutdown, cabling)', () => {
  const r = fresh('isr4331');
  r.run('enable');
  const w: World = r.w;
  getIos(w, 'D').config.interfaces['Loopback5'] = { name: 'Loopback5', shutdown: false, ip: { address: '5.5.5.5', mask: '255.255.255.255' } };
  assert.match(r.run('show ip interface brief').output, /^Loopback5 {14}5\.5\.5\.5 {9}YES manual up {20}up$/m);
  getIos(w, 'D').config.interfaces['Loopback5'].shutdown = true;
  assert.match(r.run('show ip interface brief').output, /^Loopback5 {14}5\.5\.5\.5 {9}YES manual administratively down down$/m);
  assert.match(r.run('show ip route').output, /Gateway of last resort is not set\n\n$/);
});
