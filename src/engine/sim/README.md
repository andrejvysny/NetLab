# Simulation engine (`src/engine/sim`)

Decides what the network actually does. Reads the structured configuration (`IosConfig`) and runtime tables of a `World`;
never parses CLI text. Pure TypeScript, deterministic, no hidden state. Import everything from `./index.ts`.

## Files
| File | What it does |
|---|---|
| `index.ts` | Public API (ARCHITECTURE §4.2) and extras |
| `model.ts` | Result types that are not in `types.ts` (`RouteEntry`, `SimFlowResult`, `VtyDecision`, `QosPlan` …) and internal types |
| `physical.ts` | Cable/port compatibility, link state, `interfaceState`, console access, port LED |
| `switching.ts` | Broadcast domains through switches (VLAN-aware), neighbour resolution, "why does nobody answer" |
| `routing.ts` | C/L/S routes, simplified RIP and OSPF, longest-prefix lookup, why a static route is not installed |
| `acl.ts` | `aclEvaluate`, entry text, hit counters, mirror/cover helpers for crypto ACLs |
| `nat.ts` | Static, dynamic pool, overload/PAT, translation table; ISR-specific interface static and rotary destination forms, Catalyst boundary in `../natProfile.ts` |
| `ipsec.ts` | Crypto map matching, IKE/IPsec negotiation conditions, SA tables, ESP encrypt/decrypt, clear-text check |
| `qos.ts` | MQC classification (hierarchical), counters, `qosPlan` |
| `qosload.ts` | `qosLoad`: fluid model of a congested interface for the QoS learning tool |
| `services.ts` | Local delivery: ping, vty/Telnet (`vtyDecision`), SNMP agent, IKE listener, PC servers, syslog/trap receivers |
| `pipeline.ts` | The packet walk: §6.1 order of operations on every router, traces, TTL and loop handling |
| `flow.ts` | `sendFlow` / `probeFlow`, traceroute, SNMP requests, syslog, traps |
| `dhcp.ts` | `dhcpAcquire` / `dhcpRelease`: local pools, relay, exclusions, ping-before-offer, bindings |
| `text.ts` | Wording helpers: packet headers, rates, device labels |

## API in one glance
```ts
linkInfo(world, ref)                         → { cabled, cable?, peer?, usable, dce?, problem? }
interfaceState(world, deviceId, ifName)      → { status, protocol, problem? }            // routers, switches, SVIs, PC Ethernet0
routingTable(world, deviceId)                → RouteEntry[]                                // sorted like show ip route
lookupRoute(world, deviceId, dst)            → RouteEntry | null
ownAddresses(world, deviceId)                → { address, mask, iface, up }[]
sendFlow(world, spec)                        → SimFlowResult                               // mutates counters, NAT table, SAs, logs
probeFlow(world, spec)                       → SimFlowResult                               // on a clone; never mutates
traceroute(world, from, dst, opts?)          → { hops: { ttl, address?, symbol }[], reached }
dhcpAcquire(world, pcId)                     → { ok, address?, mask?, gateway?, server?, reasonText?, steps }
dhcpRelease(world, pcId)
snmpRequest(world, from, { host, community, op, oid, value? }) → { ok, text, flow }
emitSyslog(world, deviceId, severity, mnemonic, text)
aclEvaluate(acl, packet)                     → { permit, ace?, implicit }
// extras
qosPlan(world, deviceId, ifName)             → QosPlan           // physical rate, bandwidth, shaper, leaf classes
qosLoad(world, QosLoadSpec)                  → QosLoadResult     // LabApi.qosLoad
vtyDecision(world, deviceId, sourceAddr, service = 'telnet', lineNumber?) → VtyDecision // optionally inspect a particular line
staticRouteStatus(world, deviceId)           → { route, installed, reason? }[]
syslogProbe(world, deviceId)                 → { host, received, seenFrom?, flow }[]       // non-mutating; [] if not sending
syslogBlockReason(device, severity?)        → 'logging-off' | 'trap-off' | 'severity' | undefined
dhcpServiceEnabled(device)                  → boolean
emitSnmpTrap(world, deviceId, trapType, text)→ SimFlowResult[]
checkCable / canPlug / consolePeer / portLed / serialClock / requiredEthernetCable
routeText / aceText / aclEvidence / translationRow / describePacket / qosCounter / qosCounterKey / normalizeOid / oidLabel
```
`SimFlowResult` = `FlowResult` + `outcome: 'ok' | 'refused' | 'unreachable' | 'timeout'`, `vty?`, `unreachableFrom?`, `repliedFrom?`.
`traceroute` hop symbols: `!` answered, `*` silent, `!H` / `!N` / `!A` unreachable (stops there; also after 3 silent hops).

## Conventions other modules rely on
- `runtime.qosCounters` key: `${ifName}|out|${policyMap}|${className}`; child classes `${ifName}|out|${parent}/${child}|${className}`
  (use `qosCounterKey` / `qosCounter`). Bytes are the modeled egress packet size (synthetic ESP overhead included).
- `runtime.aclHits` key `${aclId}:${seq}`: interface ACLs, crypto ACL (outbound match), NAT ACL (new translation),
  vty access-class, SNMP community ACL. QoS class-map ACLs are not counted.
- ICMP: the echo identifier is carried in `Packet.sport` (and mirrored in `dport`); PAT treats it as the port.
  Default identifier = 1 + position of the sender in `world.order`; default TCP/UDP source port = 49152 + that position.
- TCP: request `tcpSyn: true`; answers `tcpSyn: false` (`established` matches them). Refusal = reset (`outcome: 'refused'`).
- DHCP binding `clientId` = the PC's `nic.mac`.
- `emitSyslog` mnemonic is stored without the leading `%` (e.g. `SYS-5-CONFIG_I`).
- Log messages raised by the pipeline itself: `CRYPTO-4-RECVD_PKT_NOT_IPSEC`, `SEC-6-IPACCESSLOG{P,DP,S,NP}` (ACE with `log`).
- Trace steps: `text` is exactly one sentence; longer explanations and the deciding config line are in `detail`;
  `header` is the packet after the step. `Delivery.reasonText` = step text + explanation.

## Deliberate simplifications
- SAs and NAT translations never go stale: before reuse they are re-checked against the current configuration and the
  peer's SA table; if the agreement no longer holds they are deleted and renegotiated / recreated.
- IPsec is a forwarding model, not cryptography: IKE is two synthetic UDP 500 packets plus an ESP reachability
  check on a copy. An ESP wrapper contains the original packet object, and the overhead and SPI/counters are modeled.
  No cryptographic handshake, cipher, authenticity checks, anti-replay, NAT-T or packet capture is implemented.
- QoS classifies headers and counts modeled packet sizes; it does not delay, police or queue individual packets.
  QoS Load estimates shares from the nominal Ethernet speed or the serial DCE clock, capped by shaping. Interface
  `bandwidth` is a reference for percentage-based QoS, not a physical rate. The default training profile already has access to the inner
  header on the encrypting router; with the setting off, `qos pre-classify` on its crypto-map entry is what exposes it.
- SSH is TCP 22 probe traffic for ACL, IPsec and QoS practice. No SSH listener, key exchange or login is simulated.
  Telnet can accept TCP and then close the session when credentials are not configured; these are distinct outcomes.
- SNMP has a small modeled MIB and access checks for its OID subtrees, not a full protocol or MIB implementation.
  Host-specific filters apply to modeled v1/v2c config and link traps. SNMPv3 security and inform acknowledgement/retry are not simulated.
- RIP/OSPF: fixed-point computation over routers that share a link and enable the protocol there (see `routing.ts`).
- No spanning tree, no MAC tables, no sub-interfaces (router-on-a-stick), no proxy ARP except for
  exit-interface-only static routes, no timers (leases, SA lifetimes, translation timeouts never expire).
- `OUTBOUND_ACL_FILTERS_LOCAL_PACKETS` (pipeline.ts) is `false`: like IOS, an outbound ACL does not filter packets the
  router creates itself. Flip the constant to apply the literal reading of ARCHITECTURE §6.1.
