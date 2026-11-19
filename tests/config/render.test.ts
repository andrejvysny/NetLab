import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Acl, IosConfig, World } from '../../src/engine/types.ts';
import { addDevice, createWorld, getIos } from '../../src/engine/world.ts';
import {
  formatAce, formatAcl, renderInterface, renderRunningConfig, renderStartupDiff, simSecretDecode, simSecretEncode,
  type7Decode, type7Encode,
} from '../../src/engine/config/render.ts';
import { R1_RUNNING, R2_RUNNING, acl, any, eq, host, net, r1Config, r2Config, sp, xp } from './reference.ts';

function routerWorld(config?: IosConfig): World {
  const w = createWorld();
  addDevice(w, { id: 'r1', model: 'isr4331', label: 'R1', x: 0, y: 0 });
  if (config) getIos(w, 'r1').config = config;
  return w;
}
function switchWorld(): World {
  const w = createWorld();
  addDevice(w, { id: 'sw1', model: 'c9300l', label: 'SW1', x: 0, y: 0 });
  return w;
}
/** Split rendered text into header (3 lines) and body; check the byte count like IOS computes it. */
function body(text: string): string {
  const lines = text.split('\n');
  assert.equal(lines[0], 'Building configuration...');
  assert.equal(lines[1], '');
  const rest = lines.slice(3).join('\n');
  assert.equal(lines[2], `Current configuration : ${Buffer.byteLength(rest)} bytes`);
  return rest;
}
function assertLines(actual: string, expected: string): void {
  const a = actual.split('\n'), e = expected.split('\n');
  for (let i = 0; i < Math.max(a.length, e.length); i++) {
    assert.equal(a[i], e[i], `line ${i + 1} differs\n--- expected ---\n${e.slice(Math.max(0, i - 3), i + 3).join('\n')}\n--- actual ---\n${a.slice(Math.max(0, i - 3), i + 3).join('\n')}`);
  }
}

test('R1 reference configuration renders like IOS XE show running-config', () => {
  const text = renderRunningConfig(routerWorld(r1Config()), 'r1');
  assertLines(body(text), R1_RUNNING);
  assert.ok(text.endsWith('\nend\n'));
});

test('R2 reference configuration renders like IOS XE show running-config', () => {
  assertLines(body(renderRunningConfig(routerWorld(r2Config()), 'r1')), R2_RUNNING);
});

test('factory-default ISR 4331', () => {
  const expected = `!
version 17.3
service timestamps debug datetime msec
service timestamps log datetime msec
!
hostname Router
!
boot-start-marker
boot-end-marker
!
no aaa new-model
!
interface GigabitEthernet0/0/0
 no ip address
 shutdown
 negotiation auto
!
interface GigabitEthernet0/0/1
 no ip address
 shutdown
 negotiation auto
!
interface GigabitEthernet0/0/2
 no ip address
 shutdown
 negotiation auto
!
interface Serial0/1/0
 no ip address
 shutdown
!
interface Serial0/1/1
 no ip address
 shutdown
!
ip forward-protocol nd
!
control-plane
!
line con 0
 stopbits 1
line aux 0
 stopbits 1
line vty 0 4
 login
!
end
`;
  assertLines(body(renderRunningConfig(routerWorld(), 'r1')), expected);
});

test('Catalyst 9300L: factory default, vlan blocks, switchport lines, Vlan1, ip default-gateway', () => {
  const w = switchWorld();
  const text = body(renderRunningConfig(w, 'sw1'));
  assert.match(text, /\nhostname Switch\n/);
  assert.match(text, /\nno aaa new-model\nswitch 1 provision c9300l-24t-4g\n!\nspanning-tree mode rapid-pvst\nspanning-tree extend system-id\n!\ninterface GigabitEthernet1\/0\/1\n!\ninterface GigabitEthernet1\/0\/2\n!/);
  assert.match(text, /\ninterface GigabitEthernet1\/1\/4\n!\ninterface Vlan1\n no ip address\n shutdown\n!\nip forward-protocol nd\n/);
  assert.match(text, /\ncontrol-plane\n service-policy input system-cpp-policy\n!\nline con 0\n stopbits 1\nline vty 0 4\n login\n!\nend\n$/);
  assert.doesNotMatch(text, /line aux 0/);
  assert.doesNotMatch(text, /negotiation auto/);
  assert.doesNotMatch(text, /^vlan 1$/m);

  const c = getIos(w, 'sw1').config;
  c.hostname = 'SW1';
  c.vlans['10'] = { name: 'Users' };
  c.vlans['20'] = { name: 'VLAN0020' };
  c.interfaces['GigabitEthernet1/0/1'] = { name: 'GigabitEthernet1/0/1', shutdown: false, description: 'PC1', switchport: { mode: 'access', accessVlan: 10 } };
  c.interfaces['GigabitEthernet1/0/24'] = { name: 'GigabitEthernet1/0/24', shutdown: true, switchport: { mode: 'trunk', accessVlan: 1 } };
  c.interfaces['Vlan1'] = { name: 'Vlan1', shutdown: false, ip: { address: '192.168.100.2', mask: '255.255.255.0' } };
  c.defaultGateway = '192.168.100.1';
  const t2 = body(renderRunningConfig(w, 'sw1'));
  assert.match(t2, /\n!\nvlan 10\n name Users\n!\nvlan 20\n!\ninterface GigabitEthernet1\/0\/1\n/);
  assert.match(t2, /\ninterface GigabitEthernet1\/0\/1\n description PC1\n switchport access vlan 10\n switchport mode access\n!\n/);
  assert.match(t2, /\ninterface GigabitEthernet1\/0\/24\n switchport mode trunk\n shutdown\n!\n/);
  assert.match(t2, /\ninterface Vlan1\n ip address 192.168.100.2 255.255.255.0\n!\nip default-gateway 192.168.100.1\nip forward-protocol nd\n/);
});

test('interface blocks: IOS order, only non-default values, Loopbacks first', () => {
  const w = routerWorld();
  const d = getIos(w, 'r1');
  d.config.interfaces['Loopback5'] = { name: 'Loopback5', shutdown: true };
  d.config.interfaces['Serial0/1/1'] = {
    name: 'Serial0/1/1', description: 'WAN to R9', bandwidthKbps: 64, ip: { address: '10.0.0.1', mask: '255.255.255.252' },
    secondary: [{ address: '10.9.9.1', mask: '255.255.255.0' }], aclIn: 'IN', aclOut: '101', helperAddresses: ['10.1.1.1', '10.1.1.2'],
    noIpUnreachables: true, natRole: 'outside', encapsulation: 'ppp', shutdown: true, clockRate: 64000, cryptoMap: 'CM',
    servicePolicyIn: 'PIN', servicePolicyOut: 'POUT', extraLines: ['ip virtual-reassembly in', '  ppp authentication chap'],
  };
  assert.deepEqual(renderInterface(d, 'Serial0/1/1'), [
    'interface Serial0/1/1', ' description WAN to R9', ' bandwidth 64', ' ip address 10.9.9.1 255.255.255.0 secondary',
    ' ip address 10.0.0.1 255.255.255.252', ' ip access-group IN in', ' ip access-group 101 out', ' ip helper-address 10.1.1.1',
    ' ip helper-address 10.1.1.2', ' no ip unreachables', ' ip nat outside', ' encapsulation ppp', ' shutdown', ' clock rate 64000',
    ' crypto map CM', ' service-policy input PIN', ' service-policy output POUT', ' ip virtual-reassembly in', ' ppp authentication chap',
  ]);
  d.config.interfaces['GigabitEthernet0/0/1'] = { name: 'GigabitEthernet0/0/1', shutdown: false, speed: '100', duplex: 'full', extraLines: ['negotiation auto'] };
  assert.deepEqual(renderInterface(d, 'GigabitEthernet0/0/1'), ['interface GigabitEthernet0/0/1', ' no ip address', ' duplex full', ' speed 100', ' no negotiation auto']);
  d.config.interfaces['GigabitEthernet0/0/1'].speed = undefined; d.config.interfaces['GigabitEthernet0/0/1'].duplex = 'auto';
  assert.deepEqual(renderInterface(d, 'GigabitEthernet0/0/1'), ['interface GigabitEthernet0/0/1', ' no ip address', ' negotiation auto']);
  d.config.interfaces['GigabitEthernet0/0/1'].extraLines = ['no negotiation auto', 'mtu 1400'];
  assert.deepEqual(renderInterface(d, 'GigabitEthernet0/0/1'), ['interface GigabitEthernet0/0/1', ' no ip address', ' no negotiation auto', ' mtu 1400']);
  assert.deepEqual(renderInterface(d, 'GigabitEthernet9/9/9'), []);
  const text = renderRunningConfig(w, 'r1');
  const order = [...text.matchAll(/^interface (\S+)$/gm)].map((m) => m[1]);
  assert.deepEqual(order, ['Loopback5', 'GigabitEthernet0/0/0', 'GigabitEthernet0/0/1', 'GigabitEthernet0/0/2', 'Serial0/1/0', 'Serial0/1/1']);
  assert.match(text, /\ninterface Loopback5\n no ip address\n shutdown\n!\n/);
});

test('formatAce: IOS-normalised text', () => {
  const ext: Acl = acl('150', 'extended', false, []);
  const std: Acl = acl('5', 'standard', false, []);
  const f = (a: Acl, spec: Parameters<typeof xp>) => formatAce(a, { seq: 10, ...xp(...spec) });
  assert.equal(f(ext, ['permit', 'tcp', any, any, { dstPort: eq(80) }]), 'permit tcp any any eq www');
  assert.equal(f(ext, ['deny', 'ip', host('1.1.1.1'), net('10.0.0.0', '0.255.255.255')]), 'deny   ip host 1.1.1.1 10.0.0.0 0.255.255.255');
  assert.equal(f(ext, ['permit', 'ip', net('10.1.2.3', '0.0.0.255'), net('2.2.2.2', '0.0.0.0')]), 'permit ip 10.1.2.0 0.0.0.255 host 2.2.2.2');
  assert.equal(f(ext, ['permit', 'ip', net('10.1.2.3', '255.255.255.255'), any]), 'permit ip any any');
  assert.equal(f(ext, ['permit', 'tcp', any, host('9.9.9.9'), { srcPort: eq(23), dstPort: { op: 'range', ports: [20, 21] } }]), 'permit tcp any eq telnet host 9.9.9.9 range ftp-data ftp');
  assert.equal(f(ext, ['permit', 'tcp', any, any, { dstPort: eq(22), established: true, log: true }]), 'permit tcp any any eq 22 established log');
  assert.equal(f(ext, ['permit', 'tcp', any, any, { dstPort: { op: 'gt', ports: [1023] } }]), 'permit tcp any any gt 1023');
  assert.equal(f(ext, ['permit', 'udp', any, any, { dstPort: { op: 'neq', ports: [53] } }]), 'permit udp any any neq domain');
  assert.equal(f(ext, ['permit', 'udp', any, host('1.1.1.1'), { dstPort: eq(161, 162) }]), 'permit udp any host 1.1.1.1 eq snmp snmptrap');
  assert.equal(f(ext, ['permit', 'udp', any, any, { dstPort: eq(80) }]), 'permit udp any any eq 80');
  assert.equal(f(ext, ['permit', 'udp', any, any, { dstPort: eq(500) }]), 'permit udp any any eq isakmp');
  assert.equal(f(ext, ['deny', 'icmp', any, any, { icmpType: 8 }]), 'deny   icmp any any echo');
  assert.equal(f(ext, ['deny', 'icmp', any, any, { icmpType: 'echo-reply' }]), 'deny   icmp any any echo-reply');
  assert.equal(f(ext, ['permit', 'icmp', any, any, { icmpType: '3' }]), 'permit icmp any any unreachable');
  assert.equal(f(ext, ['permit', 'icmp', any, any, { icmpType: 99 }]), 'permit icmp any any 99');
  assert.equal(f(ext, ['permit', 50, host('1.1.1.1'), host('2.2.2.2')]), 'permit esp host 1.1.1.1 host 2.2.2.2');
  assert.equal(f(ext, ['permit', 'esp', any, any]), 'permit esp any any');
  assert.equal(f(ext, ['permit', 115, any, any]), 'permit 115 any any');
  assert.equal(formatAce(ext, { seq: 10, action: 'remark', remark: 'block PC1', protocol: 'ip', src: any, dst: any }), 'remark block PC1');
  assert.equal(formatAce(std, { seq: 10, ...sp('permit', host('192.168.100.10')) }), 'permit 192.168.100.10');
  assert.equal(formatAce(std, { seq: 10, ...sp('permit', net('192.168.100.7', '0.0.0.255')) }), 'permit 192.168.100.0 0.0.0.255');
  assert.equal(formatAce(std, { seq: 10, ...sp('permit', net('192.168.100.7', '0.0.0.0')) }), 'permit 192.168.100.7');
  assert.equal(formatAce(std, { seq: 10, ...sp('deny', any), log: true }), 'deny   any log');
});

test('formatAcl: numbered vs named form', () => {
  const numbered = acl('110', 'extended', false, [xp('deny', 'ip', host('1.1.1.1'), any), xp('permit', 'ip', any, any)]);
  assert.deepEqual(formatAcl(numbered), ['access-list 110 deny   ip host 1.1.1.1 any', 'access-list 110 permit ip any any']);
  const named = acl('allowPC1', 'standard', true, [sp('permit', host('192.168.100.10')), sp('deny', any)]);
  named.entries[1].seq = 25;
  assert.deepEqual(formatAcl(named), ['ip access-list standard allowPC1', ' 10 permit 192.168.100.10', ' 25 deny   any']);
  const remark = acl('X', 'extended', true, [{ action: 'remark', remark: 'hello', protocol: 'ip', src: any, dst: any }]);
  assert.deepEqual(formatAcl(remark), ['ip access-list extended X', ' 10 remark hello']);
});

test('ACL placement: named standard before extended, numbered ACLs sorted after logging', () => {
  const c = r1Config();
  c.acls['2'] = acl('2', 'standard', false, [sp('permit', any)]);
  c.acls['Zed'] = acl('Zed', 'standard', true, [sp('permit', any)]);
  const text = renderRunningConfig(routerWorld(c), 'r1');
  const heads = [...text.matchAll(/^(?:ip access-list \S+ (\S+)|access-list (\d+) )/gm)].map((m) => m[1] ?? m[2]);
  const uniq = heads.filter((h, i) => heads.indexOf(h) === i);
  assert.deepEqual(uniq, ['Zed', 'allowPC1', 'matchGuaranteed', 'matchPriority', '1', '2', '10', '11', '110', '120']);
});

test('secrets: Cisco type 7 vectors and the simulator type 9 form', () => {
  assert.equal(type7Decode('0822455D0A16'), 'cisco');
  assert.equal(type7Decode('094F471A1A0A'), 'cisco');
  assert.equal(type7Encode('cisco', 8), '0822455D0A16');
  assert.equal(type7Encode('cisco', 9), '094F471A1A0A');
  assert.equal(type7Decode('XYZ'), null);
  assert.equal(type7Decode('99AA'), null);
  for (const p of ['cisco', 'class', 'A b C 1 2 3 !@#$%^&*()', 'x', 'heslo-123']) {
    assert.equal(type7Decode(type7Encode(p)), p);
    const s = simSecretEncode(p);
    assert.match(s, /^\$9\$sim\$[./0-9A-Za-z]+$/);
    assert.equal(simSecretDecode(s), p);
  }
  assert.equal(simSecretDecode('$9$abc$def'), null);
});

test('passwords: clear text without service password-encryption, type 7 with it; enable secret always hashed', () => {
  const c = r1Config();
  c.enableSecret = 'class';
  c.enablePassword = 'enpass';
  c.lines.console.password = 'conpass';
  c.lines.console.login = true;
  c.users = [{ name: 'admin', privilege: 15, secret: 'adminpw' }, { name: 'guest', secret: 'g' }];
  let text = renderRunningConfig(routerWorld(c), 'r1');
  assert.doesNotMatch(text, /service password-encryption/);
  assert.match(text, /\nboot-end-marker\n!\nenable secret 9 (\$9\$sim\$\S+)\nenable password enpass\n!\nno aaa new-model\n/);
  const secret = /enable secret 9 (\S+)/.exec(text)![1];
  assert.equal(simSecretDecode(secret), 'class');
  assert.match(text, /\nusername admin privilege 15 secret 9 \$9\$sim\$\S+\nusername guest secret 9 \$9\$sim\$\S+\n/);
  assert.match(text, /\nline con 0\n password conpass\n login\n stopbits 1\n/);
  assert.match(text, /\nline vty 0 4\n access-class allowPC1 in\n password cisco\n login\n/);

  c.servicePasswordEncryption = true;
  text = renderRunningConfig(routerWorld(c), 'r1');
  assert.match(text, /\nservice timestamps log datetime msec\nservice password-encryption\n!\nhostname R1\n/);
  const enable7 = /\nenable password 7 ([0-9A-F]+)\n/.exec(text);
  assert.ok(enable7);
  assert.equal(type7Decode(enable7[1]), 'enpass');
  const vty7 = [...text.matchAll(/\n password 7 ([0-9A-F]+)\n/g)].map((m) => type7Decode(m[1]));
  assert.deepEqual(vty7, ['conpass', 'cisco', 'cisco']);
  assert.doesNotMatch(text, /password cisco/);
  // already-hashed secrets are printed as they are
  c.enableSecret = '$1$abcd$0123456789abcdefghijkl';
  assert.match(renderRunningConfig(routerWorld(c), 'r1'), /\nenable secret 5 \$1\$abcd\$0123456789abcdefghijkl\n/);
});

test('every other section: routing protocols, NAT pools, crypto options, QoS options, SNMP, logging, banner, aliases, lines', () => {
  const c = r1Config();
  c.ipRouting = false;
  c.ospf = [{ processId: 1, routerId: '1.1.1.1', networks: [{ address: '10.0.0.0', wildcard: '0.0.0.255', area: '0' }], passive: ['GigabitEthernet0/0/0'], defaultOriginate: true }];
  c.rip = { version: 2, networks: ['192.168.100.7'], autoSummary: false, passive: ['Loopback0'] };
  c.nat.pools = [{ name: 'P', start: '60.50.30.5', end: '60.50.30.6', mask: '255.255.255.252' }];
  c.nat.dynamicRules.push({ acl: '2', pool: 'P', overload: false });
  c.nat.staticRules.push({ local: '192.168.100.20', localPort: 80, global: '60.50.50.100', globalPort: 8080, proto: 'tcp' });
  c.nat.staticRules.push({ local: '192.168.100.21', localPort: 23, interface: 'Serial0/1/0', globalPort: 2323, proto: 'tcp' });
  c.staticRoutes.push({ prefix: '10.0.0.0', mask: '255.0.0.0', nextHop: '60.50.30.2', distance: 200 });
  c.crypto.isakmpEnabled = false;
  c.crypto.isakmpPolicies.push({ priority: 5, encryption: 'aes 256', hash: 'sha256', authentication: 'pre-share', group: 14, lifetime: 3600 });
  c.crypto.isakmpKeys.push({ key: 'ANY', address: '0.0.0.0', mask: '0.0.0.0' });
  Object.assign(c.crypto.maps[0].entries[0], { description: 'to R2', pfsGroup: 14, saLifetimeSeconds: 1800, qosPreClassify: true });
  c.qos.classMaps.push({ name: 'voice', matchType: 'match-any', description: 'VoIP', matches: [{ kind: 'dscp', values: ['ef'] }, { kind: 'access-group', acl: '101' }, { kind: 'protocol', protocol: 'icmp' }] });
  c.qos.policyMaps.push({ name: 'P2', description: 'test', classes: [
    { className: 'class-default', fairQueue: true, queueLimit: 64, extraLines: ['random-detect'] },
    { className: 'voice', priority: { percent: 10 }, police: { bps: 8000 }, setDscp: 'ef' },
    { className: 'x', bandwidth: { remainingPercent: 20 }, servicePolicy: 'child' },
  ] });
  c.snmp = {
    communities: [{ name: 'pub', access: 'ro' }, { name: 'priv', access: 'rw', view: 'V', acl: '11' }], location: 'Lab D105', contact: 'student',
    hosts: [{ address: '192.168.100.10', community: 'pub', type: 'traps' }, { address: '192.168.100.11', community: 'pub', version: '2c', type: 'informs' }],
    enableTraps: ['all'], trapSource: 'Loopback0', views: [{ name: 'V', oid: 'iso', included: true }], extraLines: ['snmp-server ifindex persist'],
  };
  c.logging.trapLevel = 'debugging';
  c.logging.extraLines = ['logging buffered 16384', 'logging facility local5'];
  c.bannerMotd = 'Authorised access only';
  c.aliases = [{ mode: 'exec', name: 'sib', command: 'show ip interface brief' }];
  c.lines.console = { login: true, password: 'c', loggingSynchronous: true, execTimeout: [0, 0], extraLines: ['history size 50'] };
  c.lines.vty = [{ first: 0, last: 4, login: 'local', transportInput: 'telnet', execTimeout: [10, 0], accessClassOut: 'OUT' }, { first: 5, last: 15, login: false }];
  c.dhcp.pools[0] = { ...c.dhcp.pools[0], dnsServers: ['8.8.8.8', '1.1.1.1'], domainName: 'kss.local', lease: 'infinite', extraLines: ['option 150 ip 10.0.0.1'] };
  c.dhcp.pools[1].lease = '1';
  c.dhcp.excluded.push({ low: '192.168.100.254', high: '192.168.100.254' });
  c.lines.vty[1].extraLines = ['stopbits 2'];
  c.extraLines = ['crypto isakmp key K hostname peer.example', 'ip nat translation timeout 60', 'ip domain name kss.local', 'ip ssh version 2', 'ntp server 192.168.100.10', 'security passwords min-length 6', 'service tcp-keepalives-in', 'ip forward-protocol nd', 'clock timezone CET 1 0'];
  const text = body(renderRunningConfig(routerWorld(c), 'r1'));
  const has = (s: string) => assert.ok(text.includes(s), `missing:\n${s}\n--- in ---\n${text}`);
  has('service timestamps log datetime msec\nservice tcp-keepalives-in\n!\nhostname R1\n');
  has('boot-end-marker\n!\nlogging buffered 16384\n!\nno aaa new-model\nclock timezone CET 1 0\n!\nno ip routing\nno ip domain lookup\nip domain name kss.local\nip dhcp excluded-address 192.168.100.1 192.168.100.100\nip dhcp excluded-address 192.168.100.254\n!\n');
  has('ip dhcp pool LAN1\n network 192.168.100.0 255.255.255.0\n default-router 192.168.100.1\n dns-server 8.8.8.8 1.1.1.1\n domain-name kss.local\n lease infinite\n option 150 ip 10.0.0.1\n!\nip dhcp pool LAN2\n network 60.50.40.0 255.255.255.192\n default-router 60.50.40.1\n!\nsecurity passwords min-length 6\n!\n');
  has('class-map match-any voice\n description VoIP\n match dscp ef\n match access-group 101\n match protocol icmp\n!\n');
  has('policy-map P2\n description test\n class voice\n  set dscp ef\n  police 8000\n  priority percent 10\n class x\n  bandwidth remaining percent 20\n  service-policy child\n class class-default\n  fair-queue\n  queue-limit 64 packets\n  random-detect\n!\n');
  has('!\nno crypto isakmp enable\ncrypto isakmp policy 5\n encr aes 256\n hash sha256\n authentication pre-share\n group 14\n lifetime 3600\ncrypto isakmp policy 10\n');
  has('crypto isakmp key KSS123 address 60.50.30.2\ncrypto isakmp key ANY address 0.0.0.0 0.0.0.0\ncrypto isakmp key K hostname peer.example\n!\n');
  has('crypto map CM 10 ipsec-isakmp\n description to R2\n set peer 60.50.30.2\n set security-association lifetime seconds 1800\n set transform-set TS\n set pfs group14\n match address 120\n qos pre-classify\n!\n');
  has('!\nrouter ospf 1\n router-id 1.1.1.1\n passive-interface GigabitEthernet0/0/0\n network 10.0.0.0 0.0.0.255 area 0\n default-information originate\n!\nrouter rip\n version 2\n passive-interface Loopback0\n network 192.168.100.0\n no auto-summary\n!\nip forward-protocol nd\nip ssh version 2\nip nat translation timeout 60\nip nat pool P 60.50.30.5 60.50.30.6 netmask 255.255.255.252\nip nat inside source list 1 interface Serial0/1/0 overload\nip nat inside source list 2 pool P\nip nat inside source static 192.168.100.10 60.50.50.100\nip nat inside source static tcp 192.168.100.20 80 60.50.50.100 8080\nip nat inside source static tcp 192.168.100.21 23 interface Serial0/1/0 2323\nip route 0.0.0.0 0.0.0.0 Serial0/1/0 60.50.30.2\nip route 10.0.0.0 255.0.0.0 60.50.30.2 200\n!\n');
  has('!\nlogging facility local5\nlogging trap debugging\nlogging source-interface Loopback0\nlogging host 192.168.100.10\naccess-list 1 ');
  has('!\nsnmp-server view V iso included\nsnmp-server community pub RO\nsnmp-server community priv view V RW 11\nsnmp-server trap-source Loopback0\nsnmp-server location Lab D105\nsnmp-server contact student\nsnmp-server enable traps\nsnmp-server host 192.168.100.10 pub\nsnmp-server host 192.168.100.11 informs version 2c pub\nsnmp-server ifindex persist\n!\ncontrol-plane\n!\nbanner motd ^CAuthorised access only^C\n!\nalias exec sib show ip interface brief\n!\n');
  has('line con 0\n exec-timeout 0 0\n password c\n logging synchronous\n login\n history size 50\n stopbits 1\nline aux 0\n stopbits 1\nline vty 0 4\n access-class OUT out\n login local\n transport input telnet\nline vty 5 15\n no login\n stopbits 2\n!\nntp server 192.168.100.10\n!\nend\n');
  assert.equal(text.match(/ip forward-protocol nd/g)?.length, 1);
  assert.doesNotMatch(text, /\n!\n!\n/);
});

test('multi-line banner', () => {
  const c = r1Config();
  c.bannerMotd = '\nAuthorised access only\nKSS lab\n';
  assert.match(renderRunningConfig(routerWorld(c), 'r1'), /\n!\nbanner motd \^C\nAuthorised access only\nKSS lab\n\^C\n!\nline con 0\n/);
});

test('renderStartupDiff ignores the header and compares with startup-config (or factory defaults)', () => {
  const w = routerWorld();
  const d = getIos(w, 'r1');
  assert.equal(renderStartupDiff(w, 'r1'), false, 'factory fresh: nothing to save');
  d.config.hostname = 'R1';
  assert.equal(renderStartupDiff(w, 'r1'), true);
  d.startupConfig = renderRunningConfig(w, 'r1');
  assert.equal(renderStartupDiff(w, 'r1'), false);
  d.startupConfig = d.startupConfig.replace(/Current configuration : \d+ bytes/, 'Current configuration : 1 bytes');
  assert.equal(renderStartupDiff(w, 'r1'), false, 'byte count is ignored');
  d.config.interfaces['GigabitEthernet0/0/0'].shutdown = false;
  assert.equal(renderStartupDiff(w, 'r1'), true);
});
