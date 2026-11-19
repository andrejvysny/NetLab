# Catalyst C9300L IPv4 NAT — 17.3 classroom profile

**Scope:** NetLab now models basic IPv4 **inside-source** NAT across routed front-panel Ethernet ports on the Catalyst **C9300L-24T-4G**, IOS XE **17.03.04**, **Network Advantage** (the `-A` SKU's base license). This is not IOS emulation or a physical-switch test. The ISR 4331 simulation and the ISR-based default case study/handout are unchanged.

## Cisco evidence and what it permits

| Cisco primary source | Evidence and scope decision |
|---|---|
| [Catalyst 9300 IOS XE 17.3 NAT configuration guide](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/software/release/17-3/configuration_guide/ip/b_173_ip_9300_cg/configuring_network_address_translation.html) | “Configuring Static Translation of Inside Source Addresses” shows literal address and transport-port mappings; “Configuring Dynamic Translation of Inside Source Addresses” shows an IPv4 pool (`netmask` or `prefix-length`). The PAT tasks document both a pool and `interface <name> overload`, with a valid IP address on an operational Layer 3 interface. The guide allows standard and extended ACL selectors, but its “Limitations” explicitly excludes **explicit deny ACEs**, **route-map NAT**, **Port Channel**, **fragment translation**, **ECMP**, **SSO**, and NAT plus PBR **on the same interface**. These are not merely missing examples. |
| [Catalyst 9300 IOS XE 17.3 command reference](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/software/release/17-3/command_reference/b_173_9300_cr.pdf) | The `ip nat inside source`, `ip nat pool`, `show ip nat translations` sections corroborate numbered/named lists, literal TCP/UDP port syntax, `extendable`, pool bounds and mask, table displays and the clear command family. The PDF also includes later `route-map` syntax marked introduced in **17.10.1**; the 17.3 guide's explicit prohibition takes precedence. A display glossary mentioning rotary is not confirmation of the exact Catalyst rotary configuration and forwarding behavior. |
| [Cisco IOS XE 17.4 Application Hosting, Supported Network Types](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/prog/configuration/174/b_174_programmability_cg/application_hosting.html) | The **Cisco IOS NAT** row (not the IOx NAT row) explicitly lists **C9300L since 16.12.1**, with hardware data-port features for **front-panel** ports and AppGigabitEthernet. The latter is not part of this bench. This is the C9300L-specific release/attachment statement; it is not an SVI, management-port, or 9300X entitlement. |
| [16.12 release notes](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/software/release/16-12/release_notes/ol-16-12-9300.html), [17.3 release notes](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/software/release/17-3/release_notes/ol-17-3-9300.html) | “NAT license level change” to **Network Advantage** in 16.12.1; 17.3 supported models table distinguishes `C9300L-24T-4G-A` (Advantage) from `C9300L-24T-4G-E` (Essentials). The lab does not assume a physical `-E` is entitled to run this exercise. |
| [Cisco TAC: Configure and Verify NAT on Catalyst 9000 Switches](https://www.cisco.com/c/en/us/support/docs/switches/catalyst-9300-series-switches/217419-configure-and-verify-nat-on-catalyst-900.html) | Supplemental Catalyst 9300 16.12.4 worked example with routed physical Ethernet, named ACLs and show output. Useful corroboration, not an exact C9300L 17.3 test. |
| [Router IOS XE 17 NAT guide](https://www.cisco.com/c/en/us/td/docs/routers/ios/config/17-x/ip-addressing/b-ip-addressing/m_iadnat-addr-consv-xe.html) | `type rotary` / `ip nat inside destination ...` describe TCP load distribution on routers. The equivalent on the exact C9300L/17.3 is **unresolved**, so the Lab explicitly refuses both forms on Catalyst while preserving them on ISR. |

**Attachment policy.** Enable `ip routing`; use `no switchport` on the physical front-panel ports and configure working IPv4 subnets, `ip nat inside` and `ip nat outside`. An L2 switchport cannot take either role. Reverting a routed port to L2 removes its role. Neither the exact 17.3 guide examples nor the C9300L platform statement establish SVI attachment for this profile; the model refuses an SVI with a scope diagnostic, not an assertion that real C9300L hardware can never do SVI NAT. The same routed-port boundary applies to an interface used as the PAT address. It need not be the egress port, but it must have a valid primary IPv4 address and be up/up to supply that address; upstream routing still has to reach it. Use the documented explicit `overload`; the Catalyst lab does not infer what the ISR parser would do if omitted. No SFP transceivers, management, loopbacks, tunnels, or AppGigabitEthernet are in the Catalyst NAT datapath model.

**Rules and limits.** Use `ip nat inside source static <local> <global>` or its literal TCP/UDP port form; use a named or numbered, permit-only standard/extended ACL and `ip nat inside source list <acl> pool <name> [overload]` with a bounded, same-subnet `ip nat pool`. An implicit deny simply deselects traffic, not a forwarding ACL drop. Explicit deny invalidates the Catalyst NAT selector, not the ACL's other uses. Unsupported static-to-interface forms are not treated as IOS hardware rejections; basic static uses literal global addresses. Avoid overlap between static addresses and dynamic pools, sharing a pool between rules, and overly broad permits (Cisco recommendations, not blanket hardware prohibitions). Only matching dynamic/PAT return tuples reverse on Catalyst; start static connections from either side. Device-originated Catalyst traffic, outside-source/twice NAT, VRF-aware NAT, AOT, application payload rewriting, and timer programming/aging are outside this subset even where Cisco separately documents them. The lab translates TCP, UDP and modeled ICMP; no fragments, platform punt paths, SDM changes or throughput are modeled.

Cisco's **ideal 2,500 hardware sessions / 5,000 TCAM entries (two per translation)** is an ASIC scale figure, not a total NAT cap or a lab guarantee. ICMP, ALG processing, and packets needing both inside-source and outside-source translation are software-handled where applicable; excess flows can be software-switched at reduced throughput, and resource failure can prevent hardware rule programming. No fake TCAM/CEF values are displayed. Catalyst `Hits` counts successful modeled rewrites, `Misses` counts failed allocation; these are not hardware instrumentation. `debug ip nat` remains a no-op notice.

**Entitlement/state.** New Catalyst benches store `networkLicense: network-advantage`; `show version` labels it “Classroom profile: Network Advantage” and `show license` agrees. Schema-1 saves without the field inherit the same Advantage profile (the previous show output already advertised it); an explicitly stored Essentials entitlement is not upgraded. This is bench metadata, unaffected by IOS running-config, reload, or existing passive `license boot level` compatibility syntax. No new global licensing command, assignment, or setup step was introduced.

## Reproduced in a live NetLab `Lab` instance

```sh
node --test tests/lab/catalyst-nat.test.ts tests/content/coverage.test.ts
node scripts/command-coverage.mjs --section C --device c9300l
npm run typecheck
```

The [Lab test](../tests/lab/catalyst-nat.test.ts) plugs real modeled cables and consoles, applies configurations through the Lab API, connects A/B (`192.168.40.10/.11`) to the Catalyst inside port, and puts C (`192.0.2.10`) behind an **ISR peer** reached through the Catalyst outside port (`198.51.100.1`). The peer has a route to the global NAT block but **no route to the inside private LAN**. It issues real NetLab PC `curl -I` requests (`HTTP/1.1 200 OK`), verifies forward and reverse headers with Trace, and then reads the *live* translations and counters created by `curl`. Trace alone does not affect the live table.

| Live mode | Observed translated source(s) and verified behavior |
|---|---|
| Static | A appears to C as `203.0.113.10`; the reply reaches `192.168.40.10`. A new `curl` from C to the global address reaches A's server, with the answer appearing from the global address. The table shows a static row and the two TCP sessions. |
| Dynamic pool | A uses `203.0.113.10`, B uses `203.0.113.11`; both connections return to the correct hosts. `show ip nat statistics` reports `total addresses 2, allocated 2 (100%)`. |
| Pool PAT | Both hosts use `203.0.113.10`, with separate ports. A probe with B deliberately reusing A's existing external port is translated to another port and restored to B's original port on return. |
| Interface PAT | Same reverse and collision assertions, but the two live global endpoints use `198.51.100.1` (the routed interface address). |
| Negative | `ip nat inside`/`outside` rejected on L2 ports; TCP still bridges through the Catalyst in VLAN 1 with no rewrite and `Hits: 0  Misses: 0`. No routed external flow is possible before L3 setup or after converting the inside port back to `switchport`. An SVI receives a separate not-modeled diagnostic. |

Interface PAT console excerpt **after** the two live connections:

```text
Pro  Inside global         Inside local          Outside local         Outside global
tcp  198.51.100.1:49155    192.168.40.10:49155   192.0.2.10:80         192.0.2.10:80
tcp  198.51.100.1:49156    192.168.40.11:49156   192.0.2.10:80         192.0.2.10:80
Total number of translations: 2
...
Outside interfaces:
  GigabitEthernet1/0/2
Inside interfaces:
  GigabitEthernet1/0/1
Hits: 4  Misses: 0
Dynamic mappings:
-- Inside Source
[Id: 1] access-list INSIDE interface GigabitEthernet1/0/2 refcount 2
```

The tests additionally verify ICMP ping and a UDP SNMP GET reply through an on-link pool address (the ISR has to resolve that address on its outside segment). An extended permit-only TCP ACL selects the intended traffic; a one-address non-PAT pool produces a real exhaustion drop and `Misses: 1`; adding an explicit deny disables that previously valid selector, and an unconnected PAT target does not translate. Wildcard clear empties flow state, then traffic repopulates it without deleting configuration. Running-config replacement and lab export/import preserve the configuration/profile; Essentials refuses the NAT CLI and does not translate preserved configuration. The [CSV](command-coverage.csv) records both model/profile outcomes, including literal static port translation, interface PAT, unsupported attachment/ACL/route-map cases, and the unresolved rotary/SVI forms; the [A–G coverage report](COMMAND_COVERAGE.md) explains the verdicts.
