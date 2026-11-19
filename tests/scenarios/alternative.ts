/**
 * A correct solution of the case study that looks nothing like the model solution: other ports, other addresses,
 * PC3 behind the spare switch, the DCE end on R2, named access lists everywhere, other names for crypto map,
 * classes and policies, protocol matches instead of QoS access lists, a fixed shaper rate, one vty range,
 * other SNMP community names, and default routes with the next hop only.
 */
import type { PcSetup, SolutionCable } from '../../src/engine/types.ts';

const eth = (deviceId: string, n: string) => ({ deviceId, port: n });

export const ALT_CABLES: SolutionCable[] = [
  { kind: 'straight', a: eth('PC1', 'Ethernet0'), b: eth('SW1', 'GigabitEthernet1/0/5') },
  { kind: 'straight', a: eth('PC2', 'Ethernet0'), b: eth('SW1', 'GigabitEthernet1/0/6') },
  { kind: 'straight', a: eth('SW1', 'GigabitEthernet1/0/12'), b: eth('R1', 'GigabitEthernet0/0/1') },
  { kind: 'serial', a: eth('R1', 'Serial0/1/1'), b: eth('R2', 'Serial0/1/1'), dceEnd: 'b' },
  { kind: 'straight', a: eth('R2', 'GigabitEthernet0/0/1'), b: eth('SW2', 'GigabitEthernet1/0/3') },
  { kind: 'straight', a: eth('SW2', 'GigabitEthernet1/0/4'), b: eth('PC3', 'Ethernet0') },
  { kind: 'console', a: eth('PC2', 'COM1'), b: eth('R1', 'Console') },
  { kind: 'console', a: eth('PC3', 'COM1'), b: eth('R2', 'Console') },
];

const VPN_ACL = `
ip access-list extended VPN-TRAFFIC
 permit tcp any any eq 23
 permit tcp any eq 23 any
 permit tcp any any eq 22
 permit tcp any eq 22 any
 permit icmp any any
 permit udp any any eq 161
 permit udp any eq 161 any
 permit udp any any eq 162
 permit udp any eq 162 any
`;
const QOS = `
class-map match-any PRIO
 match protocol icmp
class-map match-any MGMT
 match protocol telnet
 match protocol ssh
 match protocol snmp
policy-map LLQ
 class PRIO
  priority 16
 class MGMT
  bandwidth 48
 class class-default
  fair-queue
policy-map SHAPE
 class class-default
  shape average 121600
  service-policy LLQ
`;

export const ALT_R1 = `
hostname EDGE
no ip domain-lookup
interface Loopback0
 ip address 10.10.10.10 255.255.255.255
interface Loopback100
 ip address 99.9.9.9 255.255.255.255
interface GigabitEthernet0/0/1
 ip address 192.168.7.1 255.255.255.0
 no shutdown
interface Serial0/1/1
 ip address 81.2.3.6 255.255.255.252
 bandwidth 128
 no shutdown
ip route 0.0.0.0 0.0.0.0 81.2.3.5
ip dhcp excluded-address 192.168.7.1 192.168.7.100
ip dhcp pool OFFICE
 network 192.168.7.0 255.255.255.0
 default-router 192.168.7.1
ip dhcp pool REMOTE
 network 99.1.1.64 255.255.255.192
 default-router 99.1.1.65
ip access-list standard NAT-SRC
 permit 192.168.7.0 0.0.0.255
interface GigabitEthernet0/0/1
 ip nat inside
interface Serial0/1/1
 ip nat outside
ip nat inside source list NAT-SRC interface Serial0/1/1 overload
ip nat inside source static 192.168.7.10 99.9.9.9
ip access-list extended LAN1-IN
 deny ip host 192.168.7.10 host 20.20.20.20
 permit icmp host 192.168.7.101 99.1.1.64 0.0.0.63
 permit tcp host 192.168.7.101 99.1.1.64 0.0.0.63 eq 80
 deny ip host 192.168.7.101 99.1.1.64 0.0.0.63
 permit ip any any
interface GigabitEthernet0/0/1
 ip access-group LAN1-IN in
crypto isakmp policy 5
 encryption aes 256
 hash sha
 authentication pre-share
 group 5
crypto isakmp key Secret99 address 81.2.3.5
crypto ipsec transform-set STRONG esp-aes 256 esp-sha256-hmac
${VPN_ACL}
crypto map VPN 20 ipsec-isakmp
 set peer 81.2.3.5
 set transform-set STRONG
 match address VPN-TRAFFIC
interface Serial0/1/1
 crypto map VPN
${QOS}
interface Serial0/1/1
 service-policy output SHAPE
ip access-list standard MGMT-ONLY
 permit host 192.168.7.10
line vty 0 15
 access-class MGMT-ONLY in
 password S3cret
 login
ip access-list standard SNMP-READ
 permit host 192.168.7.10
 permit host 99.1.1.66
ip access-list standard SNMP-WRITE
 permit host 192.168.7.10
snmp-server community lookRO ro SNMP-READ
snmp-server community changeRW rw SNMP-WRITE
logging host 192.168.7.10
logging source-interface Loopback0
`;

export const ALT_R2 = `
hostname BRANCH
no ip domain-lookup
interface Loopback0
 ip address 20.20.20.20 255.255.255.255
interface GigabitEthernet0/0/1
 ip address 99.1.1.65 255.255.255.192
 ip helper-address 81.2.3.6
 no shutdown
interface Serial0/1/1
 ip address 81.2.3.5 255.255.255.252
 bandwidth 128
 clock rate 128000
 no shutdown
ip route 0.0.0.0 0.0.0.0 81.2.3.6
crypto isakmp policy 5
 encryption aes 256
 hash sha
 authentication pre-share
 group 5
crypto isakmp key Secret99 address 81.2.3.6
crypto ipsec transform-set STRONG esp-aes 256 esp-sha256-hmac
${VPN_ACL}
crypto map VPN 20 ipsec-isakmp
 set peer 81.2.3.6
 set transform-set STRONG
 match address VPN-TRAFFIC
interface Serial0/1/1
 crypto map VPN
${QOS}
interface Serial0/1/1
 service-policy output SHAPE
ip access-list standard MGMT-ONLY
 permit host 99.9.9.9
line vty 0 15
 access-class MGMT-ONLY in
 password S3cret
 login
ip access-list standard SNMP-READ
 permit host 99.9.9.9
 permit host 99.1.1.66
ip access-list standard SNMP-WRITE
 permit host 99.9.9.9
snmp-server community lookRO ro SNMP-READ
snmp-server community changeRW rw SNMP-WRITE
logging host 99.9.9.9
logging source-interface Loopback0
`;

export const ALT_PCS: Record<string, PcSetup> = {
  PC1: { mode: 'static', address: '192.168.7.10', mask: '255.255.255.0', gateway: '192.168.7.1', services: { syslog: true } },
  PC2: { mode: 'dhcp' },
  PC3: { mode: 'dhcp', services: { http: true } },
};
