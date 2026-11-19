/**
 * Test helper: the course's reference configurations (docs/COURSE.md) as hand-built IosConfig objects,
 * the configuration text exactly as the course lists it, and the expected `show running-config` listings.
 */
import type { Ace, Acl, AddrMatch, IosConfig, PortMatch } from '../../src/engine/types.ts';
import { defaultIosConfig, portsFor } from '../../src/engine/world.ts';

export const any: AddrMatch = { kind: 'any' };
export const host = (address: string): AddrMatch => ({ kind: 'host', address });
export const net = (address: string, wildcard: string): AddrMatch => ({ kind: 'net', address, wildcard });
export const eq = (...ports: number[]): PortMatch => ({ op: 'eq', ports });

type AceSpec = Omit<Ace, 'seq'>;
export function acl(id: string, type: 'standard' | 'extended', named: boolean, entries: AceSpec[]): Acl {
  return { id, type, named, entries: entries.map((e, i) => ({ ...e, seq: (i + 1) * 10 })) };
}
export const sp = (action: 'permit' | 'deny', src: AddrMatch): AceSpec => ({ action, protocol: 'ip', src, dst: any });
export const xp = (action: 'permit' | 'deny', protocol: Ace['protocol'], src: AddrMatch, dst: AddrMatch, more: Partial<Ace> = {}): AceSpec =>
  ({ action, protocol, src, dst, ...more });

function guaranteedEntries(withIcmp: boolean): AceSpec[] {
  const e: AceSpec[] = [
    xp('permit', 'tcp', any, any, { dstPort: eq(23) }),
    xp('permit', 'tcp', any, any, { srcPort: eq(23) }),
    xp('permit', 'tcp', any, any, { dstPort: eq(22) }),
    xp('permit', 'tcp', any, any, { srcPort: eq(22) }),
  ];
  if (withIcmp) e.push(xp('permit', 'icmp', any, any));
  e.push(
    xp('permit', 'udp', any, any, { dstPort: eq(161) }),
    xp('permit', 'udp', any, any, { srcPort: eq(161) }),
    xp('permit', 'udp', any, any, { dstPort: eq(162) }),
    xp('permit', 'udp', any, any, { srcPort: eq(162) }),
  );
  return e;
}

/** Everything R1 and R2 share: ISAKMP policy, transform set, crypto map shape, QoS, ACL 120 and the QoS ACLs, SNMP, vty. */
function common(c: IosConfig, peer: string, pc1: string): void {
  c.ipDomainLookup = false;
  c.crypto.isakmpPolicies = [{ priority: 10, encryption: 'aes', hash: 'sha', authentication: 'pre-share', group: 2, lifetime: 86400 }];
  c.crypto.isakmpKeys = [{ key: 'KSS123', address: peer }];
  c.crypto.transformSets = [{ name: 'TS', transforms: ['esp-aes', 'esp-sha-hmac'], mode: 'tunnel' }];
  c.crypto.maps = [{ name: 'CM', entries: [{ seq: 10, type: 'ipsec-isakmp', matchAcl: '120', peers: [peer], transformSets: ['TS'] }] }];
  c.qos.classMaps = [
    { name: 'classPriority', matchType: 'match-all', matches: [{ kind: 'access-group', acl: 'matchPriority' }] },
    { name: 'classGuaranteed', matchType: 'match-all', matches: [{ kind: 'access-group', acl: 'matchGuaranteed' }] },
  ];
  c.qos.policyMaps = [
    { name: 'output_QE', classes: [
      { className: 'classPriority', priority: { kbps: 16 } },
      { className: 'classGuaranteed', bandwidth: { kbps: 48 } },
      { className: 'class-default', fairQueue: true },
    ] },
    { name: 'output_SE', classes: [{ className: 'class-default', shapeAverage: { percent: 95 }, servicePolicy: 'output_QE' }] },
  ];
  c.acls['120'] = acl('120', 'extended', false, guaranteedEntries(true));
  c.acls['matchGuaranteed'] = acl('matchGuaranteed', 'extended', true, guaranteedEntries(false));
  c.acls['matchPriority'] = acl('matchPriority', 'extended', true, [xp('permit', 'icmp', any, any)]);
  c.acls['allowPC1'] = acl('allowPC1', 'standard', true, [sp('permit', host(pc1))]);
  c.acls['10'] = acl('10', 'standard', false, [sp('permit', host(pc1)), sp('permit', host('60.50.40.2'))]);
  c.acls['11'] = acl('11', 'standard', false, [sp('permit', host(pc1))]);
  c.snmp.communities = [{ name: 'D105read', access: 'ro', acl: '10' }, { name: 'D105write', access: 'rw', acl: '11' }];
  c.logging.sourceInterface = 'Loopback0';
  c.logging.hosts = [pc1];
  c.lines.vty = [
    { first: 0, last: 4, accessClassIn: 'allowPC1', password: 'cisco', login: true },
    { first: 5, last: 14, accessClassIn: 'allowPC1', password: 'cisco', login: true },
  ];
}

export function r1Config(): IosConfig {
  const c = defaultIosConfig('router', portsFor('isr4331'));
  c.hostname = 'R1';
  c.dhcp.excluded = [{ low: '192.168.100.1', high: '192.168.100.100' }];
  c.dhcp.pools = [
    { name: 'LAN1', network: { address: '192.168.100.0', mask: '255.255.255.0' }, defaultRouters: ['192.168.100.1'], dnsServers: [] },
    { name: 'LAN2', network: { address: '60.50.40.0', mask: '255.255.255.192' }, defaultRouters: ['60.50.40.1'], dnsServers: [] },
  ];
  common(c, '60.50.30.2', '192.168.100.10');
  c.interfaces['Loopback0'] = { name: 'Loopback0', shutdown: false, ip: { address: '1.1.1.1', mask: '255.255.255.255' } };
  c.interfaces['Loopback100'] = { name: 'Loopback100', shutdown: false, ip: { address: '60.50.50.100', mask: '255.255.255.255' } };
  Object.assign(c.interfaces['GigabitEthernet0/0/0'], {
    ip: { address: '192.168.100.1', mask: '255.255.255.0' }, aclIn: '110', natRole: 'inside', shutdown: false,
  });
  Object.assign(c.interfaces['Serial0/1/0'], {
    bandwidthKbps: 128, ip: { address: '60.50.30.1', mask: '255.255.255.252' }, natRole: 'outside', clockRate: 128000,
    cryptoMap: 'CM', servicePolicyOut: 'output_SE', shutdown: false,
  });
  c.nat.staticRules = [{ local: '192.168.100.10', global: '60.50.50.100' }];
  c.nat.dynamicRules = [{ acl: '1', interface: 'Serial0/1/0', overload: true }];
  c.staticRoutes = [{ prefix: '0.0.0.0', mask: '0.0.0.0', exitInterface: 'Serial0/1/0', nextHop: '60.50.30.2' }];
  const lan2 = net('60.50.40.0', '0.0.0.63');
  c.acls['1'] = acl('1', 'standard', false, [sp('permit', net('192.168.100.0', '0.0.0.255'))]);
  c.acls['110'] = acl('110', 'extended', false, [
    xp('deny', 'ip', host('192.168.100.10'), host('2.2.2.2')),
    xp('permit', 'icmp', host('192.168.100.101'), lan2),
    xp('permit', 'tcp', host('192.168.100.101'), lan2, { dstPort: eq(80) }),
    xp('deny', 'ip', host('192.168.100.101'), lan2),
    xp('permit', 'ip', any, any),
  ]);
  return c;
}

export function r2Config(): IosConfig {
  const c = defaultIosConfig('router', portsFor('isr4331'));
  c.hostname = 'R2';
  common(c, '60.50.30.1', '60.50.50.100');
  c.interfaces['Loopback0'] = { name: 'Loopback0', shutdown: false, ip: { address: '2.2.2.2', mask: '255.255.255.255' } };
  Object.assign(c.interfaces['GigabitEthernet0/0/0'], {
    ip: { address: '60.50.40.1', mask: '255.255.255.192' }, helperAddresses: ['60.50.30.1'], shutdown: false,
  });
  Object.assign(c.interfaces['Serial0/1/0'], {
    bandwidthKbps: 128, ip: { address: '60.50.30.2', mask: '255.255.255.252' }, cryptoMap: 'CM', servicePolicyOut: 'output_SE', shutdown: false,
  });
  c.staticRoutes = [{ prefix: '0.0.0.0', mask: '0.0.0.0', exitInterface: 'Serial0/1/0', nextHop: '60.50.30.1' }];
  return c;
}

// ───────────────────────────── Expected `show running-config` listings ─────────────────────────────
const HEAD = `!
version 17.3
service timestamps debug datetime msec
service timestamps log datetime msec
!`;
const QOS = `class-map match-all classPriority
 match access-group name matchPriority
class-map match-all classGuaranteed
 match access-group name matchGuaranteed
!
policy-map output_QE
 class classPriority
  priority 16
 class classGuaranteed
  bandwidth 48
 class class-default
  fair-queue
policy-map output_SE
 class class-default
  shape average percent 95
   service-policy output_QE
!`;
const NAMED_QOS_ACLS = `ip access-list extended matchGuaranteed
 10 permit tcp any any eq telnet
 20 permit tcp any eq telnet any
 30 permit tcp any any eq 22
 40 permit tcp any eq 22 any
 50 permit udp any any eq snmp
 60 permit udp any eq snmp any
 70 permit udp any any eq snmptrap
 80 permit udp any eq snmptrap any
ip access-list extended matchPriority
 10 permit icmp any any
!`;
const ACL120 = `access-list 120 permit tcp any any eq telnet
access-list 120 permit tcp any eq telnet any
access-list 120 permit tcp any any eq 22
access-list 120 permit tcp any eq 22 any
access-list 120 permit icmp any any
access-list 120 permit udp any any eq snmp
access-list 120 permit udp any eq snmp any
access-list 120 permit udp any any eq snmptrap
access-list 120 permit udp any eq snmptrap any`;
const TAIL = `snmp-server community D105read RO 10
snmp-server community D105write RW 11
!
control-plane
!
line con 0
 stopbits 1
line aux 0
 stopbits 1
line vty 0 4
 access-class allowPC1 in
 password cisco
 login
line vty 5 14
 access-class allowPC1 in
 password cisco
 login
!
end`;
const UNUSED_PORTS = `interface GigabitEthernet0/0/1
 no ip address
 shutdown
 negotiation auto
!
interface GigabitEthernet0/0/2
 no ip address
 shutdown
 negotiation auto
!`;

/** Body of the expected R1 running-config (everything after the "Current configuration" line). */
export const R1_RUNNING = `${HEAD}
hostname R1
!
boot-start-marker
boot-end-marker
!
no aaa new-model
!
no ip domain lookup
ip dhcp excluded-address 192.168.100.1 192.168.100.100
!
ip dhcp pool LAN1
 network 192.168.100.0 255.255.255.0
 default-router 192.168.100.1
!
ip dhcp pool LAN2
 network 60.50.40.0 255.255.255.192
 default-router 60.50.40.1
!
${QOS}
crypto isakmp policy 10
 encr aes
 authentication pre-share
 group 2
crypto isakmp key KSS123 address 60.50.30.2
!
crypto ipsec transform-set TS esp-aes esp-sha-hmac
 mode tunnel
!
crypto map CM 10 ipsec-isakmp
 set peer 60.50.30.2
 set transform-set TS
 match address 120
!
interface Loopback0
 ip address 1.1.1.1 255.255.255.255
!
interface Loopback100
 ip address 60.50.50.100 255.255.255.255
!
interface GigabitEthernet0/0/0
 ip address 192.168.100.1 255.255.255.0
 ip access-group 110 in
 ip nat inside
 negotiation auto
!
${UNUSED_PORTS}
interface Serial0/1/0
 bandwidth 128
 ip address 60.50.30.1 255.255.255.252
 ip nat outside
 clock rate 128000
 crypto map CM
 service-policy output output_SE
!
interface Serial0/1/1
 no ip address
 shutdown
!
ip forward-protocol nd
ip nat inside source list 1 interface Serial0/1/0 overload
ip nat inside source static 192.168.100.10 60.50.50.100
ip route 0.0.0.0 0.0.0.0 Serial0/1/0 60.50.30.2
!
ip access-list standard allowPC1
 10 permit 192.168.100.10
${NAMED_QOS_ACLS}
logging source-interface Loopback0
logging host 192.168.100.10
access-list 1 permit 192.168.100.0 0.0.0.255
access-list 10 permit 192.168.100.10
access-list 10 permit 60.50.40.2
access-list 11 permit 192.168.100.10
access-list 110 deny   ip host 192.168.100.10 host 2.2.2.2
access-list 110 permit icmp host 192.168.100.101 60.50.40.0 0.0.0.63
access-list 110 permit tcp host 192.168.100.101 60.50.40.0 0.0.0.63 eq www
access-list 110 deny   ip host 192.168.100.101 60.50.40.0 0.0.0.63
access-list 110 permit ip any any
${ACL120}
!
${TAIL}
`;

export const R2_RUNNING = `${HEAD}
hostname R2
!
boot-start-marker
boot-end-marker
!
no aaa new-model
!
no ip domain lookup
!
${QOS}
crypto isakmp policy 10
 encr aes
 authentication pre-share
 group 2
crypto isakmp key KSS123 address 60.50.30.1
!
crypto ipsec transform-set TS esp-aes esp-sha-hmac
 mode tunnel
!
crypto map CM 10 ipsec-isakmp
 set peer 60.50.30.1
 set transform-set TS
 match address 120
!
interface Loopback0
 ip address 2.2.2.2 255.255.255.255
!
interface GigabitEthernet0/0/0
 ip address 60.50.40.1 255.255.255.192
 ip helper-address 60.50.30.1
 negotiation auto
!
${UNUSED_PORTS}
interface Serial0/1/0
 bandwidth 128
 ip address 60.50.30.2 255.255.255.252
 crypto map CM
 service-policy output output_SE
!
interface Serial0/1/1
 no ip address
 shutdown
!
ip forward-protocol nd
ip route 0.0.0.0 0.0.0.0 Serial0/1/0 60.50.30.1
!
ip access-list standard allowPC1
 10 permit 60.50.50.100
${NAMED_QOS_ACLS}
logging source-interface Loopback0
logging host 60.50.50.100
access-list 10 permit 60.50.50.100
access-list 10 permit 60.50.40.2
access-list 11 permit 60.50.50.100
${ACL120}
!
${TAIL}
`;

// ───────────────────────────── The course listings (what a student types) ─────────────────────────────
const COURSE_QOS = `class-map match-all classPriority
 match access-group name matchPriority
class-map match-all classGuaranteed
 match access-group name matchGuaranteed
policy-map output_QE
 class classPriority
  priority 16
 class classGuaranteed
  bandwidth 48
 class class-default
  fair-queue
policy-map output_SE
 class class-default
  shape average percent 95
  service-policy output_QE`;
const COURSE_ACLS = `access-list 120 permit tcp any any eq telnet
access-list 120 permit tcp any eq telnet any
access-list 120 permit tcp any any eq 22
access-list 120 permit tcp any eq 22 any
access-list 120 permit icmp any any
access-list 120 permit udp any any eq snmp
access-list 120 permit udp any eq snmp any
access-list 120 permit udp any any eq snmptrap
access-list 120 permit udp any eq snmptrap any
ip access-list extended matchGuaranteed
 permit tcp any any eq telnet
 permit tcp any eq telnet any
 permit tcp any any eq 22
 permit tcp any eq 22 any
 permit udp any any eq snmp
 permit udp any eq snmp any
 permit udp any any eq snmptrap
 permit udp any eq snmptrap any
ip access-list extended matchPriority
 permit icmp any any`;
const COURSE_VTY = `line vty 0 4
 access-class allowPC1 in
 password cisco
 login
line vty 5 14
 access-class allowPC1 in
 password cisco
 login
end`;
const courseCrypto = (peer: string) => `crypto isakmp policy 10
 encryption aes
 hash sha
 authentication pre-share
 group 2
crypto isakmp key KSS123 address ${peer}
crypto ipsec transform-set TS esp-aes esp-sha-hmac
 mode tunnel
crypto map CM 10 ipsec-isakmp
 set peer ${peer}
 set transform-set TS
 match address 120`;

/** docs/COURSE.md "Reference configuration — R1", verbatim. */
export const R1_COURSE = `hostname R1
no ip domain-lookup
ip dhcp excluded-address 192.168.100.1 192.168.100.100
ip dhcp pool LAN1
 network 192.168.100.0 255.255.255.0
 default-router 192.168.100.1
ip dhcp pool LAN2
 network 60.50.40.0 255.255.255.192
 default-router 60.50.40.1
${courseCrypto('60.50.30.2')}
${COURSE_QOS}
interface Loopback0
 ip address 1.1.1.1 255.255.255.255
interface Loopback100
 ip address 60.50.50.100 255.255.255.255
interface GigabitEthernet0/0/0
 ip address 192.168.100.1 255.255.255.0
 ip access-group 110 in
 ip nat inside
 no shutdown
interface Serial0/1/0
 bandwidth 128
 ip address 60.50.30.1 255.255.255.252
 ip nat outside
 clock rate 128000
 crypto map CM
 service-policy output output_SE
 no shutdown
ip nat inside source static 192.168.100.10 60.50.50.100
ip nat inside source list 1 interface Serial0/1/0 overload
ip route 0.0.0.0 0.0.0.0 Serial0/1/0 60.50.30.2
access-list 1 permit 192.168.100.0 0.0.0.255
access-list 10 permit host 192.168.100.10
access-list 10 permit host 60.50.40.2
access-list 11 permit host 192.168.100.10
access-list 110 deny ip host 192.168.100.10 host 2.2.2.2
access-list 110 permit icmp host 192.168.100.101 60.50.40.0 0.0.0.63
access-list 110 permit tcp host 192.168.100.101 60.50.40.0 0.0.0.63 eq www
access-list 110 deny ip host 192.168.100.101 60.50.40.0 0.0.0.63
access-list 110 permit ip any any
${COURSE_ACLS}
ip access-list standard allowPC1
 permit 192.168.100.10
snmp-server community D105read RO 10
snmp-server community D105write RW 11
logging source-interface Loopback0
logging 192.168.100.10
${COURSE_VTY}
`;

/** docs/COURSE.md "Reference configuration — R2", with the "identical to R1" line expanded. */
export const R2_COURSE = `hostname R2
no ip domain-lookup
${courseCrypto('60.50.30.1')}
${COURSE_QOS}
interface Loopback0
 ip address 2.2.2.2 255.255.255.255
interface GigabitEthernet0/0/0
 ip address 60.50.40.1 255.255.255.192
 ip helper-address 60.50.30.1
 no shutdown
interface Serial0/1/0
 bandwidth 128
 ip address 60.50.30.2 255.255.255.252
 crypto map CM
 service-policy output output_SE
 no shutdown
ip route 0.0.0.0 0.0.0.0 Serial0/1/0 60.50.30.1
access-list 10 permit host 60.50.50.100
access-list 10 permit host 60.50.40.2
access-list 11 permit host 60.50.50.100
${COURSE_ACLS}
ip access-list standard allowPC1
 permit 60.50.50.100
snmp-server community D105read RO 10
snmp-server community D105write RW 11
logging source-interface Loopback0
logging 60.50.50.100
${COURSE_VTY}
`;
