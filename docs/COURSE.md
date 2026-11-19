# Course facts: the exam, the case study and the reference solution

Sources in this folder: `course/case-study-2026.sk.txt` (assignment + teacher's solution, Slovak),
`course/cheat-sheet.txt` (the command sheet the student may use during the real test).
More course material (labs for ACL, NAT, IPsec, QoS, management) is extracted as text under
`/agent/workspace/kss_course/KSS/` (read-only reference; Slovak/English mix).

## The real test
- Course KSS (Communication Services and Networks), practical test "network functions", 18 points, about 3 hours.
- The student gets unconnected, unconfigured devices and must cable and configure everything from scratch.
- Lab hardware: 2× Cisco ISR 4331 (IOS XE), 2× Catalyst 9300L, Windows PCs plus one macOS laptop.
  Course labs use serial links between routers (`interface serial slot/subunit/port`, `clock rate 128000` on the DCE end).
- The command sheet (cheat-sheet.txt) is allowed. Topics: basic config, ACL, NAT, IPsec, QoS, DHCP, management (syslog, SNMP, Telnet).

## Case study 2026 (English summary of the assignment)
Topology: PC1 (management station "MS", static IP, host .10) and PC2 connect through one switch to R1 (LAN1 /24, private).
R1 connects to R2 over WAN1 (/30). PC3 connects directly to R2 (LAN2 /26). R1 has Loopback0 /32 and Loopback100 /32,
R2 has Loopback0 /32. Routers use host address .1 in their LANs. "Tunnel 1" = R1–R2 (IPsec). ("Tunnel 2", PC1–PC3 host IPsec, is task 9 and is crossed out.)

1. PC2 and PC3 get addresses from DHCP, PC1 is static. Only ONE router is the DHCP server (choose with task 4 in mind → R1).
   In LAN1 the first 100 usable addresses must not be leased.
2. WAN1 is a point-to-point /30, LAN1 is /24, LAN2 is /26.
3. Communication must work inside LAN1 and LAN2, between LAN1 and LAN2, and between the routers' loopback interfaces.
4. LAN1 uses a private class C network but appears outside with public address(es): all PCs use a public address
   from WAN1 with many parallel sessions (PAT/overload on the WAN address), and PC1 must be reachable when the
   session is started from outside (static NAT to the address of Loopback100).
5. No routing protocol. Besides connected networks each routing table may hold exactly one more entry (a default route).
6. PC1 must not communicate with R2's Loopback0 network.
7. PC2 must not communicate with LAN2 other than by ICMP or HTTP.
8. Between R1 and R2 encrypt: Telnet, SSH, ICMP, network management (UDP 161, 162).
9. (CROSSED OUT — optional) ICMP and FTP between PC1 and PC3 leave the hosts already encrypted (Windows IPsec).
10. Physically limit the R1–R2 link to 128 kbit/s. QoS in both directions: ICMP gets a 16 kbit/s priority guarantee;
    Telnet, SSH and network management get at least 48 kbit/s; everything else shares the rest by WFQ;
    shape all traffic to 95 % of the physical rate.
11. Telnet access to both routers, allowed only from PC1.
12. SNMP on both routers: read from PC1 and PC3, write only from PC1.
13. Both routers send syslog messages to PC1 with the source address of Loopback0.

Teacher's solution notes (see the Slovak file for the listing): DHCP server on R1 with `ip helper-address <R1 WAN IP>` on
R2's LAN interface; PAT on the WAN interface + static NAT for PC1 to the Loopback100 address; a default route on both routers
(`ip route 0.0.0.0 0.0.0.0 <exit interface> <next hop>`); tasks 6 and 7 as ONE extended ACL inbound on R1's LAN interface;
IPsec crypto ACL with protocol-only entries and `any any` addresses; QoS as a two-level policy (parent shaper 95 % with a child
LLQ policy: priority 16, bandwidth 48, class-default fair-queue), `bandwidth 128` on both WAN interfaces, `clock rate 128000`
on the DCE end; vty lines 0–4 and 5–14 with `access-class allowPC1 in`, password cisco, login; SNMP communities
D105read (RO, ACL 10) and D105write (RW, ACL 11); `logging <PC1>` + `logging source-interface Loopback0`.
From R2's point of view PC1 is its NAT address (the Loopback100 address), so R2's ACLs and logging use that address.

The task 11 listing shows one working Telnet login setup, not an assigned password for the case. NetLab grades usable access on all Telnet-enabled VTY ranges of both routers, only from PC1. The focused management lab explicitly names a password and grades it; see [practice grading](final-grading.md).

## Reference address plan (default numbers used by the model solution and by tests)
| Where | Value |
|---|---|
| LAN1 | 192.168.100.0/24 — R1 Gi0/0/0 = .1, PC1 static .10 (gateway .1), PC2 by DHCP → 192.168.100.101 |
| WAN1 | 60.50.30.0/30 — R1 Se0/1/0 = 60.50.30.1 (DCE end), R2 Se0/1/0 = 60.50.30.2 |
| LAN2 | 60.50.40.0/26 — R2 Gi0/0/0 = .1, PC3 by DHCP → 60.50.40.2 |
| Loopbacks | R1 Lo0 1.1.1.1/32, R1 Lo100 60.50.50.100/32 (PC1's public address), R2 Lo0 2.2.2.2/32 |

## Reference cabling
| Cable | From | To |
|---|---|---|
| Ethernet straight-through | PC1 Ethernet0 | SW1 Gi1/0/1 |
| Ethernet straight-through | PC2 Ethernet0 | SW1 Gi1/0/2 |
| Ethernet straight-through | SW1 Gi1/0/24 | R1 Gi0/0/0 |
| Serial (DCE end on R1) | R1 Se0/1/0 | R2 Se0/1/0 |
| Ethernet crossover | R2 Gi0/0/0 | PC3 Ethernet0 |
| Console (rollover) | a PC's COM1 | the CON port of the device being configured (moved as needed) |
Any free ports are acceptable; grading discovers roles from the cabling (which router port leads to which neighbour).
SW2 stays unused. The switch needs no configuration (all ports VLAN 1).

## Reference configuration — R1
```
hostname R1
no ip domain-lookup
ip dhcp excluded-address 192.168.100.1 192.168.100.100
ip dhcp pool LAN1
 network 192.168.100.0 255.255.255.0
 default-router 192.168.100.1
ip dhcp pool LAN2
 network 60.50.40.0 255.255.255.192
 default-router 60.50.40.1
crypto isakmp policy 10
 encryption aes
 hash sha
 authentication pre-share
 group 2
crypto isakmp key KSS123 address 60.50.30.2
crypto ipsec transform-set TS esp-aes esp-sha-hmac
 mode tunnel
crypto map CM 10 ipsec-isakmp
 set peer 60.50.30.2
 set transform-set TS
 match address 120
class-map match-all classPriority
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
  service-policy output_QE
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
access-list 120 permit tcp any any eq telnet
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
 permit icmp any any
ip access-list standard allowPC1
 permit 192.168.100.10
snmp-server community D105read RO 10
snmp-server community D105write RW 11
logging source-interface Loopback0
logging 192.168.100.10
line vty 0 4
 access-class allowPC1 in
 password cisco
 login
line vty 5 14
 access-class allowPC1 in
 password cisco
 login
end
```

## Reference configuration — R2
```
hostname R2
no ip domain-lookup
crypto isakmp policy 10
 encryption aes
 hash sha
 authentication pre-share
 group 2
crypto isakmp key KSS123 address 60.50.30.1
crypto ipsec transform-set TS esp-aes esp-sha-hmac
 mode tunnel
crypto map CM 10 ipsec-isakmp
 set peer 60.50.30.1
 set transform-set TS
 match address 120
(class-maps, policy-maps, ACL 120, matchGuaranteed, matchPriority: identical to R1)
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
ip access-list standard allowPC1
 permit 60.50.50.100
snmp-server community D105read RO 10
snmp-server community D105write RW 11
logging source-interface Loopback0
logging 60.50.50.100
line vty 0 4
 access-class allowPC1 in
 password cisco
 login
line vty 5 14
 access-class allowPC1 in
 password cisco
 login
end
```
PCs: PC1 static 192.168.100.10 / 255.255.255.0 / gateway 192.168.100.1, syslog server on. PC2 and PC3: DHCP. PC3 runs HTTP and FTP servers.

## What must be true when this solution is loaded (acceptance facts for tests)
- PC2 leases 192.168.100.101 (R1 excludes .1–.100). PC3 leases 60.50.40.2 through the relay (the server pings a candidate
  address before offering it, so 60.50.40.1, which R2 already uses, is skipped).
- Routing tables: connected/local routes plus exactly one static default route on each router.
- PC1 ↔ PC2 ping works (same LAN). PC1 → PC3 ping works; PC3 sees source 60.50.50.100. PC2 → PC3 ping works; PC3 sees 60.50.30.1.
- PC3 → 60.50.50.100 (ping, any TCP service PC1 runs) reaches PC1 (static NAT, session started from outside).
- R1 `ping 2.2.2.2 source Loopback0` works; PC1 → 2.2.2.2 is dropped by ACL 110 on R1 (symbol U).
- PC2 → PC3: ICMP and TCP 80 pass; TCP 21 (FTP) and TCP 23 are dropped by ACL 110. PC2 → PC1 and PC2 → R2's WAN address are unaffected.
- On the WAN link ICMP, TCP 22/23 and UDP 161/162 travel inside modeled ESP; HTTP (TCP 80), FTP, DHCP relay and syslog travel in clear. TCP 22 tests the forwarded path and classification; NetLab does not implement an SSH server.
- WAN egress QoS on both routers: ICMP → classPriority (priority 16 kbit/s); Telnet/SSH/SNMP → classGuaranteed (bandwidth 48);
  anything else → class-default (fair-queue); parent shaper = 95 % of 128 = 121.6 kbit/s.
- Telnet with the worked configuration: PC1 → R1 (192.168.100.1) and PC1 → R2 (60.50.30.2) reach a password prompt; PC2 and PC3 are refused by both routers.
- SNMP: PC1 read+write on both routers; PC3 read only (write with D105write gets no answer); PC2 gets no answer.
- Syslog: PC1 receives messages from 1.1.1.1 (R1) and 2.2.2.2 (R2).
