/**
 * The base parts of the course's reference configuration (docs/COURSE.md), typed line by line the way a student types
 * them in the console — first verbatim, then with typical abbreviations — must run without a single error.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDevice, createWorld, getIos } from '../../src/engine/world.ts';
import { execLine, startSession } from '../../src/engine/cli/framework.ts';
import { installCli } from '../../src/engine/cli/index.ts';
import { applyConfigText } from '../../src/engine/config/apply.ts';
import type { IosConfig, World } from '../../src/engine/types.ts';

installCli();

const R1_BASE = `hostname R1
no ip domain-lookup
ip dhcp excluded-address 192.168.100.1 192.168.100.100
ip dhcp pool LAN1
 network 192.168.100.0 255.255.255.0
 default-router 192.168.100.1
ip dhcp pool LAN2
 network 60.50.40.0 255.255.255.192
 default-router 60.50.40.1
interface Loopback0
 ip address 1.1.1.1 255.255.255.255
interface Loopback100
 ip address 60.50.50.100 255.255.255.255
interface GigabitEthernet0/0/0
 ip address 192.168.100.1 255.255.255.0
 no shutdown
interface Serial0/1/0
 bandwidth 128
 ip address 60.50.30.1 255.255.255.252
 clock rate 128000
 no shutdown
ip route 0.0.0.0 0.0.0.0 Serial0/1/0 60.50.30.2
line vty 0 4
 access-class allowPC1 in
 password cisco
 login
line vty 5 14
 access-class allowPC1 in
 password cisco
 login
end`;

const R2_BASE = `hostname R2
no ip domain-lookup
interface Loopback0
 ip address 2.2.2.2 255.255.255.255
interface GigabitEthernet0/0/0
 ip address 60.50.40.1 255.255.255.192
 ip helper-address 60.50.30.1
 no shutdown
interface Serial0/1/0
 bandwidth 128
 ip address 60.50.30.2 255.255.255.252
 no shutdown
ip route 0.0.0.0 0.0.0.0 Serial0/1/0 60.50.30.1
line vty 0 4
 access-class allowPC1 in
 password cisco
 login
line vty 5 14
 access-class allowPC1 in
 password cisco
 login
end`;

/** The same R1 configuration with the abbreviations students really type. */
const R1_ABBREVIATED = `host R1
no ip domain-lo
ip dhcp excl 192.168.100.1 192.168.100.100
ip dhcp pool LAN1
net 192.168.100.0 255.255.255.0
def 192.168.100.1
ip dhcp pool LAN2
network 60.50.40.0 /26
default-router 60.50.40.1
int lo0
ip add 1.1.1.1 255.255.255.255
int lo100
ip add 60.50.50.100 255.255.255.255
int g0/0/0
ip add 192.168.100.1 255.255.255.0
no sh
int s0/1/0
band 128
ip add 60.50.30.1 255.255.255.252
clock rate 128000
no shut
exit
ip route 0.0.0.0 0.0.0.0 s0/1/0 60.50.30.2
line vty 0 4
access-class allowPC1 in
pass cisco
login
line vty 5 14
access-class allowPC1 in
pass cisco
login
end`;

function bench(): World {
  const w = createWorld();
  addDevice(w, { id: 'r1', model: 'isr4331', label: 'R1', x: 0, y: 0 });
  addDevice(w, { id: 'r2', model: 'isr4331', label: 'R2', x: 0, y: 0 });
  w.cables.push({ id: 'c1', kind: 'serial', a: { deviceId: 'r1', port: 'Serial0/1/0' }, b: { deviceId: 'r2', port: 'Serial0/1/0' }, dceEnd: 'a' });
  return w;
}
/** Console session on a factory-fresh router: answer the dialog, enable, configure terminal, then type every line. */
function type(w: World, id: string, text: string): void {
  const { session, outcome } = startSession(w, id, 'console');
  assert.match(outcome.prompt, /initial configuration dialog/);
  const steps = ['no', 'enable', 'configure terminal', ...text.split('\n').map((l) => l.trim())];
  for (const line of steps) {
    const o = execLine(w, session, line);
    assert.ok(o.status === 'ok' || (o.status === 'pending' && line === 'no'), `"${line}" → ${o.status}\n${o.output}`);
    assert.ok(!/^%|Invalid|Bad mask|overlaps/m.test(o.output), `"${line}" printed an error:\n${o.output}`);
  }
  assert.equal(session.mode, 'priv');
}
function base(cfg: IosConfig) {
  const ifs = Object.fromEntries(Object.values(cfg.interfaces).filter((i) => i.ip).map((i) => [i.name, {
    ip: i.ip, shutdown: i.shutdown, bandwidth: i.bandwidthKbps, clock: i.clockRate, helpers: i.helperAddresses,
  }]));
  return { hostname: cfg.hostname, lookup: cfg.ipDomainLookup, dhcp: cfg.dhcp, ifs, routes: cfg.staticRoutes, vty: cfg.lines.vty };
}

const R1_EXPECTED = {
  hostname: 'R1', lookup: false,
  dhcp: {
    excluded: [{ low: '192.168.100.1', high: '192.168.100.100' }],
    pools: [
      { name: 'LAN1', network: { address: '192.168.100.0', mask: '255.255.255.0' }, defaultRouters: ['192.168.100.1'], dnsServers: [] },
      { name: 'LAN2', network: { address: '60.50.40.0', mask: '255.255.255.192' }, defaultRouters: ['60.50.40.1'], dnsServers: [] },
    ],
  },
  ifs: {
    'GigabitEthernet0/0/0': { ip: { address: '192.168.100.1', mask: '255.255.255.0' }, shutdown: false, bandwidth: undefined, clock: undefined, helpers: undefined },
    'Serial0/1/0': { ip: { address: '60.50.30.1', mask: '255.255.255.252' }, shutdown: false, bandwidth: 128, clock: 128000, helpers: undefined },
    Loopback0: { ip: { address: '1.1.1.1', mask: '255.255.255.255' }, shutdown: false, bandwidth: undefined, clock: undefined, helpers: undefined },
    Loopback100: { ip: { address: '60.50.50.100', mask: '255.255.255.255' }, shutdown: false, bandwidth: undefined, clock: undefined, helpers: undefined },
  },
  routes: [{ prefix: '0.0.0.0', mask: '0.0.0.0', exitInterface: 'Serial0/1/0', nextHop: '60.50.30.2' }],
  vty: [
    { first: 0, last: 4, login: true, password: 'cisco', accessClassIn: 'allowPC1' },
    { first: 5, last: 14, login: true, password: 'cisco', accessClassIn: 'allowPC1' },
  ],
};

test('R1: the reference configuration (base parts) typed verbatim runs without an error', () => {
  const w = bench();
  type(w, 'r1', R1_BASE);
  assert.deepEqual(base(getIos(w, 'r1').config), R1_EXPECTED);
});

test('R1: the same configuration with abbreviations', () => {
  const w = bench();
  type(w, 'r1', R1_ABBREVIATED);
  assert.deepEqual(base(getIos(w, 'r1').config), R1_EXPECTED);
});

test('R2: the reference configuration (base parts) typed verbatim; clock rate is not needed on the DTE end', () => {
  const w = bench();
  type(w, 'r2', R2_BASE);
  const b = base(getIos(w, 'r2').config);
  assert.equal(b.hostname, 'R2');
  assert.deepEqual(b.ifs['GigabitEthernet0/0/0'].helpers, ['60.50.30.1']);
  assert.deepEqual(b.routes, [{ prefix: '0.0.0.0', mask: '0.0.0.0', exitInterface: 'Serial0/1/0', nextHop: '60.50.30.1' }]);
  assert.deepEqual(b.vty, R1_EXPECTED.vty);
});

test('copy run start + reload keeps the base configuration (render.ts/apply.ts round trip)', () => {
  const w = bench();
  type(w, 'r1', R1_BASE);
  const before = base(getIos(w, 'r1').config);
  const { session } = startSession(w, 'r1', 'console');
  const run = (l: string) => execLine(w, session, l);
  run('enable');
  run('copy running-config startup-config');
  assert.equal(run('').output, 'Building configuration...\n[OK]\n');
  assert.match(getIos(w, 'r1').startupConfig!, /^line vty 0 4$/m);
  assert.match(getIos(w, 'r1').startupConfig!, /^line vty 5 14$/m);
  let o = run('reload');
  assert.equal(o.prompt, 'Proceed with reload? [confirm]', 'nothing changed since the save');
  o = run('');
  assert.equal(o.prompt, 'R1>');
  assert.deepEqual(base(getIos(w, 'r1').config), before);
});

test('the full reference configuration applied as a file: none of the base-module lines fail', () => {
  const w = bench();
  const full = `${R1_BASE.replace(/\nend$/, '')}
interface GigabitEthernet0/0/0
 ip access-group 110 in
 ip nat inside
interface Serial0/1/0
 ip nat outside
 crypto map CM
 service-policy output output_SE
banner motd #Authorized access only#
end`;
  const r = applyConfigText(w, 'r1', full, 'merge');
  const mine = /^(hostname|no ip domain|ip dhcp|network|default-router|interface|ip address|no shutdown|bandwidth|clock rate|ip route|line vty|access-class|password|login|banner)\b/;
  const failedMine = r.lines.filter((l) => !l.ok && mine.test(l.line.trim()));
  assert.deepEqual(failedMine, []);
  assert.deepEqual(base(getIos(w, 'r1').config).vty, R1_EXPECTED.vty);
  assert.equal(getIos(w, 'r1').config.bannerMotd, 'Authorized access only');
});
