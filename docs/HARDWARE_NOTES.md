# Hardware notes: real ISR 4331 / Catalyst 9300L vs. the course reference solution

**Purpose.** The course reference solution was written for classic IOS. The exam runs on real hardware:
2× Cisco ISR 4331 routers and 2× Catalyst 9300L switches with IOS XE (exact release unknown, assumed 16.x–17.x).
This file lists the places where the real devices may behave differently, so the simulator can warn the student.

**How to read it.**

- Each question has: a one-line **verdict**, a short **explanation**, **what to type / check** on the real device,
  a **confidence** level, and **sources**.
- **Confidence levels:**
  - **confirmed**: a Cisco document (configuration guide, command reference, field notice, release notes, data sheet) says it directly.
  - **likely**: Cisco documents for a closely related platform or release say it, or several independent observations agree. It has not been stated for this exact box and release.
  - **unconfirmed**: no source found. The student must test it on the device.
- "Community" sources are Cisco Community posts. Unless marked otherwise, the author is **not** Cisco staff.
- Research date: late 2026. Cisco pages change. Re-check URLs before relying on exact wording.

**First thing to do on exam day:** run `show version` on every device. Several answers below depend on the release:

| Release threshold | What changes (details in the sections below) |
|---|---|
| ≤ 16.9 | Classic license model (`license boot level securityk9` + EULA + reload). |
| 16.10 – 17.3.1 | Smart Licensing (an unregistered lab box runs in evaluation mode). |
| 16.12 and later | Numbered ACLs are probably shown as `ip access-list … ` with sequence numbers (likely, see Q11). |
| 17.3.2 and later | Smart Licensing Using Policy (security license not enforced; still needs boot level + reload). |
| 17.6.1 and later | Weak IPsec algorithms give a `%Warning: … deprecated` message. Default PFS group becomes 14. |
| 17.7.1 and later (C9300) | The setup dialog forces a strong `enable secret` on a box with no config. |
| 17.11.1a and later (ISR 4000) | DES, 3DES, MD5 and DH groups 1/2/5 are rejected for IPsec unless `crypto engine compliance shield disable` + reload. |

---

## Q1. Telnet on vty lines: default `transport input`; is `transport input telnet` needed?

**Verdict:** Telnet is allowed on vty lines by default on ISR 4331 and Catalyst 9300L (16.x–17.x). `transport input telnet` is not required, but it is harmless and makes the intent explicit.

**Explanation.** The ISR 4000 IOS XE 16.x and 17.x configuration guides say: "By default, the vtys' transport is Telnet." The IOS XE 17.18 command reference for `ip telnet disable` lists "Telnet access is enabled" as the default on autonomous platforms. The Catalyst 9300 sample default configuration has `line vty 0 4 / login` and `line vty 5 15 / login` with no transport line. Default values are hidden in `show running-config`, so you cannot see the default there. Two warnings: (1) `transport input telnet` *replaces* the list, so SSH stops working on those lines (use `transport input telnet ssh` for both). (2) Some other IOS XE platforms (for example IR8340, cBR-8) ship with Telnet disabled. A pre-used lab box may also still carry `transport input ssh`.

**What to type / check:**
```
show running-config all | section line vty      ! shows the effective "transport input ..." line, even the default
show line vty 0                                  ! look for "Allowed input transports are ..."
line vty 0 4
 transport input telnet ssh                      ! optional, explicit and safe
```
From PC1: `telnet <router address>`.
- "Connection refused": transport is wrong, or the `access-class` blocks you.
- "Password required, but none set": `login` is set but `password` is missing.

**Confidence:** **likely**. Router guides confirm the wording. For the Catalyst 9300 it is inferred from the default config plus community answers.

**Sources:**
- https://www.cisco.com/c/en/us/td/docs/routers/access/isr4400/software/configuration/xe-17/isr4400-sw-config-xe-17/using_cisco_ios_xe_software.html
- https://www.cisco.com/c/en/us/td/docs/routers/access/4400/software/configuration/xe-16-12/isr4400swcfg-xe-16-12-book/using_cisco_ios_xe_software.html
- https://www.cisco.com/c/en/us/td/docs/routers/sdwan/command/iosxe/qualified-cli-command-reference-guide/m-line-commands.html (`ip telnet disable`: "Command Default: Telnet access is enabled")
- https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/software/release/17-18/command_reference/b_1718_9300_cr.pdf (sample config: `line vty 0 4 / login`, `line vty 5 15 / login`)
- https://www.cisco.com/c/en/us/td/docs/routers/ir8340/software/configuration/b_ir8340_cg_17-8.pdf (counter-example: Telnet off by default on IR8340)
- Community (not staff): https://community.cisco.com/t5/switching/after-upgrading-to-iosxe-17-xx-xx-telnet-no-longer-works/td-p/4412652 , https://community.cisco.com/t5/switching/which-protocol-is-enabled-if-nothing-is-mentioned/td-p/5292260

---

## Q2. QoS and a crypto map on the same interface: inner header or `qos pre-classify`?

**Verdict:** Without `qos pre-classify`, the output policy sees the *encrypted* ESP packet. ACL-based classes (ICMP, Telnet, SSH, SNMP) will not match traffic that the crypto map protects. Put `qos pre-classify` **under the crypto map entry**.

**Explanation.** Cisco's IOS XE "QoS for VPNs" and "IPv6 IPsec QoS" documents describe pre-classify as the feature that keeps a copy of the original L3/L4 header, so that QoS can classify on it after encryption. For crypto maps it is configured inside the crypto map entry. (For tunnel interfaces it goes on the tunnel interface.) The ToS/DSCP byte is copied to the outer header anyway. So DSCP-based classes would work without pre-classify, but the reference solution classifies with ACLs. Traffic that is *not* encrypted (IKE on UDP 500, relayed DHCP, anything outside the crypto ACL) is classified normally. Note: the 16.12 classification guide's step list mentions the interface, but its own example puts the command under the crypto map.

**What to type / check:**
```
crypto map CMAP 10 ipsec-isakmp
 qos pre-classify
!
show policy-map interface Serial0/1/0 output     ! ping / telnet across the link, then watch the counters
```
If the ICMP or Telnet class counters stay at 0 while class-default grows, pre-classify is missing.

**Confidence:** **likely**. The feature and where it goes are confirmed. That the ISR 4331 classifies on the outer header *by default* for an IPv4 crypto map is inferred from the docs, not stated word for word.

**Sources:**
- https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/qos_classn/configuration/xe-16-12/qos-classn-xe-16-12-book/qos-classn-vpn.html
- https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/sec_conn_dplane/configuration/xe-17/sec-ipsec-data-plane-xe-17/ip6-ipsec-qos.html ("QoS pre-classify is configured under a crypto map to enable IPsec to save the original Layer 3 and Layer 4 header before the encryption")
- https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/qos_mqc/configuration/xe-16-6/qos-mqc-xe-16-6-book/qos-apply.html (fair-queue and pre-classify)
- https://www.cisco.com/c/en/us/products/collateral/ios-nx-os-software/ios-ipsec/white-paper-c11-744879.html
- Cisco Learning Network discussion: https://learningnetwork.cisco.com/s/question/0D53i00000KsyEBCAZ/conflicting-information-on-tunnel-qos

---

## Q3. Hierarchical policy on ISR 4000: child `fair-queue`, `priority` + `bandwidth`, `shape average percent` on serial

**Verdict:** The reference policy is valid on IOS XE: child class-default with `fair-queue`, `priority 16` and `bandwidth 48`. The percent shaper is computed from the interface bandwidth value, so `bandwidth 128` on the serial interface is essential. Check the resulting rate.

**Explanation.**
- `priority <kbps>` on IOS XE is a priority queue with a *conditional* policer. It polices only when the parent is congested.
- IOS XE rejects `bandwidth` guarantees only next to an *unconstrained* `priority` (no rate). With a rate, as in the reference, they can be combined.
- `fair-queue` is allowed in class-default. It is **flow-based fair queuing** (16 flow queues per class), not classic weighted WFQ.
- `bandwidth` is allowed only in the leaf (child) policy. The reference already does this.
- Percent-based shaping uses "percentage × the interface BW shown by `show interfaces`". With `bandwidth 128`: 95 % × 128 = 121.6 kbps.
- If `bandwidth` is missing, the NIM serial default BW is used. A Cisco NIM sample shows `BW 8000 Kbit`. The shaper would then be far above the real link speed and do nothing.
- IOS XE has no 75 % `max-reserved-bandwidth` limit (that command was removed). Excess bandwidth is shared *equally* between classes, not in proportion, unless `bandwidth remaining` is used.
- Unconfirmed: whether changing `bandwidth` *after* attaching the policy recalculates the rate.

**What to type / check:**
```
interface Serial0/1/0
 bandwidth 128                 ! configure this BEFORE "service-policy output PARENT"
 service-policy output PARENT
!
show interfaces Serial0/1/0 | include BW
show policy-map interface Serial0/1/0 output
```
Expect something like `shape (average) cir 121600` / `target shape rate 121600`, the 16 kbps priority, the 48 kbps bandwidth, and flow-based fair queuing in the child class-default. If the router rejects a line, write down the exact error.

**Confidence:** **confirmed** for the syntax and the combination rules. **likely** that the percent is based on the `bandwidth` value on an ISR 4331 NIM serial port.

**Sources:**
- https://www.cisco.com/c/en/us/td/docs/routers/ios/config/17-x/qos/b-quality-of-service/m_qos-scheduling.html (conditional policer; "You cannot use minimum bandwidth guarantees … in conjunction with unconstrained priority queues"; fair-queue example in class-default; percentage of the BW shown by `show interface`)
- https://www.cisco.com/c/en/us/td/docs/routers/ios/config/17-x/qos/b-quality-of-service/m-3-level-user-defined-queuing-policy-support.html ("bandwidth … is only allowed at the leaf node"; 3-parameter scheduler; "ISR 4000 platforms share the same design")
- https://www.cisco.com/c/en/us/td/docs/routers/ios/config/17-x/qos/b-quality-of-service/m_qos-hierarchical_scheduling.html
- https://www.cisco.com/c/en/us/td/docs/routers/ios/config/17-x/qos/b-quality-of-service/m_qos-plcshp-pct-shp.html (CIR = percent × BW of the interface)
- https://www.cisco.com/c/en/us/td/docs/ios/qos/command/reference/qos_book/qos_a1.html (`bandwidth qos-reference` overrides the reference)
- NIM sample `BW 8000 Kbit`: https://www.cisco.com/c/dam/global/ja_jp/td/docs/ciam/high-speedwaninterfacecards/high-speedwaninterfacecar/cg/002/snim-config.pdf

---

## Q4. Legacy queueing (`priority-list`/`priority-group`, `queue-list`/`custom-queue-list`, interface `fair-queue`)

**Verdict:** Not available on the ISR 4331. IOS XE only supports MQC queueing.

**Explanation.** Cisco's "Legacy QoS Command Deprecation" document says these commands were **removed in IOS XE 3.2S**, long before 16.x: `custom-queue-list`, interface `fair-queue` (WFQ), `max-reserved-bandwidth`, `show queueing`, `show queue`, `show interfaces fair-queue`. `priority-group` is listed as hidden/removed/unsupported, with MQC `priority` as the replacement. The global `priority-list` and `queue-list` commands only feed `priority-group` and `custom-queue-list`, so they are expected to be gone too. That last point is likely, but not listed by name. A serial interface on IOS XE shows `Queueing strategy: fifo`. Classic IOS turned on WFQ by default on slow serial links; IOS XE does not. All cheat-sheet commands `show queueing priority|custom|fair` are replaced by `show policy-map interface`.

**What to type / check:**
```
priority-list ?                          ! expect "% Invalid input detected"
interface Serial0/1/0
 fair-queue ?                            ! expect "% Invalid input detected"
show interfaces Serial0/1/0 | include Queueing
```

**Confidence:** **confirmed** for interface `fair-queue`, `custom-queue-list`, `show queueing`. **likely** for `priority-list`, `queue-list`, `priority-group`. The exact error text is **unconfirmed**.

**Sources:**
- https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/qos_mqc/configuration/xe-16-12/qos-mqc-xe-16-12-book/qos-leg.html
- https://www.cisco.com/c/en/us/td/docs/routers/ios-xe/quality-of-service/quality-of-service/m_qos-leg.html
- https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/qos/command/qos-cr-book/qos-d1.html ("Effective with Cisco IOS XE Release 3.2S, the fair-queue command is replaced by … MQC")
- "Queueing strategy: fifo" on a NIM serial port: https://www.cisco.com/c/dam/global/ja_jp/td/docs/ciam/high-speedwaninterfacecards/high-speedwaninterfacecar/cg/002/snim-config.pdf
- Community: https://community.cisco.com/t5/routing-and-sd-wan/isr4331-fair-queue/td-p/3825304

---

## Q5. Crypto on the ISR 4331: licensing, and which IKEv1/ESP algorithms are refused

**Verdict:** IPsec needs the **securityk9** technology package. Configure `license boot level securityk9`, save, and reload. Weak algorithms behave by release:
- **16.x:** accepted silently.
- **17.6 – 17.10:** accepted with a deprecation warning.
- **17.11.1a and later:** rejected, unless `crypto engine compliance shield disable` + reload.

**Explanation.**
- **No license:** if securityk9 is not active, the crypto commands do not exist. Cisco's example: `crypto map` → `% Invalid input detected`.
- **License history:**
  - Up to 16.9: CSL/RTU. Evaluation converts to Right-to-Use after 60 days.
  - 16.10 – 17.3.1: Smart Licensing.
  - 17.3.2 and later: Smart Licensing Using Policy. securityk9 is "not enforced", but the boot level and a reload are still required. HSECK9 is only needed for high encryption throughput, not for a lab.
- **Algorithms:** field notice FN72510 lists what 17.11.1a+ refuses on ISR 4000:
  - IKEv1 policy: `encryption des|3des`, `hash md5`, `group 1|2|5`.
  - Transform-set: `esp-des`, `esp-3des`, `esp-md5-hmac`, `esp-null`, `ah-md5-hmac`, `esp-gmac`.
  - `set pfs group1|2|5|24`.
- **From 17.6.1:** the same commands give `%Warning: weaker encryption algorithm is deprecated` (or `weaker dh-group is deprecated`) and still work. `set pfs` with no group defaults to group 14 (it was group 1 before).
- **Defaults are hidden.** Defaults do not appear in `show running-config`. The classic default for an IKEv1 policy is DES and DH group 1. What an unset value becomes on 17.11+ is **unconfirmed**, so set every parameter.
- **Mixed releases:** both routers must agree. If they run different releases, the stricter one decides what works.

**What to type / check:**
```
show version                         ! release + "Technology Package License Information" table
show license summary                 ! 16.10+ ; on older releases: show license feature
configure terminal
 license boot level securityk9
end
write memory
reload
!
crypto isakmp policy 10
 encryption aes
 hash sha256                         ! or "hash sha"
 authentication pre-share            ! default is rsa-sig, so this line is required for a pre-shared key
 group 14
crypto ipsec transform-set TS esp-aes esp-sha256-hmac
!
show crypto isakmp policy            ! shows the real values, including defaults
```
If the teacher's lines (for example `group 2`, `encryption 3des`) are refused or give a warning, that is the release, not a typo.

**Confidence:** **confirmed** for the licensing behaviour and the algorithm changes. **unconfirmed** for the exact rejection text and the default values on 17.11+.

**Sources:**
- https://www.cisco.com/c/en/us/td/docs/routers/access/4400/software/configuration/xe-16-11/isr4400swcfg-xe-16-11-book/installing_the_software.html (unlicensed `crypto map` → `% Invalid input detected`)
- https://www.cisco.com/c/en/us/td/docs/routers/access/4400/software/configuration/xe-16-12/isr4400swcfg-xe-16-12-book/installing_the_software.html (securityk9 contents; HSECK9)
- https://www.cisco.com/c/en/us/support/docs/ios-nx-os-software/ios-xe-16/217898-configure-smart-licensing-for-cisco-ios.html (16.10–17.3.1 Smart Licensing; 17.3.2+ SLP)
- https://www.cisco.com/c/en/us/td/docs/routers/sl_using_policy/b-sl-using-policy/introduction.html
- https://www.cisco.com/c/en/us/td/docs/cloud-systems-management/network-automation-and-management/terminal-services-gateways/sw-config/tg1100swcfg-xe-17-2-book/smart_licensing_tg.pdf (boot-level license procedure on 17.x, reload required)
- https://www.cisco.com/c/en/us/support/docs/field-notices/725/fn72510.html (FN72510; ISR4000 17.11.1a+; `crypto engine compliance shield disable`, available from 17.7.1, takes effect after reboot)
- https://www.cisco.com/c/en/us/td/docs/routers/ios/config/17-x/sec-vpn/b-security-vpn/m_sec-cfg-vpn-ipsec-0.html (17.6 warnings, weak-algorithm table, PFS default group 14 from 17.6.1)
- https://www.cisco.com/c/en/us/td/docs/routers/ios/config/17-x/sec-vpn/b-security-vpn/m_sec-key-exch-ipsec-0.html (defaults not shown in running-config)
- https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/security/d1/sec-d1-cr-book/sec-cr-e1.html (classic default: 56-bit DES)
- Bug CSCwm67178 (md5 keyword refused with `% Invalid input`): https://quickview.cloudapps.cisco.com/quickview/bug/CSCwm67178
- Community: https://community.cisco.com/t5/network-management/isr-4000-ios-xe-ztp-and-license/td-p/4748993 (router rejects crypto lines until `license boot level securityk9` + reload)

---

## Q6. Serial on the ISR 4331: module, `clock rate 128000`, DTE end, default DCE clock, `show controllers`

**Verdict:** Serial0/1/0 is port 0 of a NIM-1T, NIM-2T or NIM-4T in NIM bay 0/1. `clock rate` only matters on the DCE end. **128000 is not in Cisco's documented list of NIM clock rates**, so the router may refuse or round it (unconfirmed).

**Explanation.**
- **Numbering:** ISR 4331 names are slot/bay/port. Slot 0 is the motherboard: bay 0 = onboard GE ports, bays 1 and 2 = the two NIM slots. A serial module in the SM-X slot would be Serial1/0/x.
- **Clock rates:** Cisco's NIM serial configuration document (OL-31531-01, Japanese edition on cisco.com) gives the range 1200–8000000 bps and a list of supported values. The list includes 115200, 125000, 148000, 192000, 250000 and 256000, but **not 128000**. The generic IOS command reference says some hardware rounds a non-supported value and prints `%Clockrate rounded to nearest value that your hardware can support`.
- **DTE end:** the same NIM document says the clock rate setting applies only to DCE interfaces. With a DTE cable, the external clock is used automatically.
- **Default DCE clock:** the command reference says `no clock rate` on a DCE "sets the clock rate to the hardware-dependent default value". So a DCE port probably clocks at *some* default even without the command. The NIM default value is unknown. (Classic WIC-2T used 2 Mbps.) The 128 kbps "physical" limit only exists if a real clock rate is applied.
- **`show controllers` output** on a NIM was not found in Cisco docs. Do not hard-code the classic `DCE V.35, clock rate 128000` line.

**What to type / check:**
```
show platform                          ! expect NIM-1T/2T/4T in 0/1
show interfaces Serial0/1/0            ! "Hardware is NIM-2T", BW value
show controllers serial 0/1/0          ! look for DCE/DTE, cable type, clock
interface Serial0/1/0
 clock rate ?                          ! see which values this NIM offers
 clock rate 128000
 do show running-config interface Serial0/1/0
```
If 128000 is refused or rounded, use 125000 (the nearest listed value), keep `bandwidth 128`, and tell the examiner.

**Confidence:** **confirmed** for numbering, NIM models and DCE-only clocking. **unconfirmed** for 128000 being accepted, the default DCE rate, and the `show controllers` format.

**Sources:**
- https://www.cisco.com/c/en/us/td/docs/routers/access/4400/hardware/installation/guide4400-4300/C4400_isr/Overview.html (slot/bay/port numbering)
- https://www.cisco.com/c/en/us/products/collateral/routers/4000-series-integrated-services-routers-isr/datasheet-c78-732155.html (NIM-1T/2T/4T, Smart Serial cables, 8 Mbps)
- https://www.cisco.com/c/en/us/products/routers/4000-series-integrated-services-routers-isr/relevant-interfaces-and-modules.html (NIM support per model and release)
- https://www.cisco.com/c/dam/global/ja_jp/td/docs/ciam/high-speedwaninterfacecards/high-speedwaninterfacecar/cg/002/snim-config.pdf (NIM clock-rate list; DCE only; DTE uses external clock)
- https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/interface/command/ir-cr-book/ir-c2.html (`clock rate`: rounding message; `no clock rate` → hardware default)
- Cisco "Serial Interface Cards" OL-12843-01 (third-party mirror): https://timanex.com/extra-files/documents/cisco/cisco-module-serial-interface-cards.pdf (classic WIC-2T default 2 Mbps)

---

## Q7. Static NAT whose global address is also the router's Loopback100 /32

**Verdict:** It is very likely accepted, and traffic from outside to 60.50.50.100 is sent to PC1. Side effect: R1 itself no longer answers on 60.50.50.100 for traffic coming in on the outside interface.

**Explanation.** A Cisco Community report (not staff) describes an ISR 4331 on 16.3/16.9 using static NAT to loopback /32 addresses, reachable from the Internet. Cisco's IOS XE NAT guide says to use different addresses for *NAT-enabled interfaces* and static inside global addresses. Loopback100 has no `ip nat inside/outside`, so this rule does not apply directly. Do not put `ip nat` on the loopback. Outside-to-inside translation happens *before* routing. So a packet to 60.50.50.100 that arrives on the serial interface is rewritten to 192.168.100.10 before the router can treat it as "for me". A ping or telnet from R2 to 60.50.50.100 therefore reaches PC1, not R1. NAT creates IP aliases (for ARP) only when the global address is in a connected subnet. On a serial-only design this has no visible effect. Whether IOS XE prints a warning when the loopback and the static NAT share an address is **unconfirmed**.

**What to type / check:**
```
show ip nat translations          ! expect: ---  60.50.50.100  192.168.100.10  ---  ---
show ip aliases
R2# ping 60.50.50.100             ! PC1 must answer (its firewall may block ping)
R2# telnet 60.50.50.100           ! only if PC1 runs a telnet server
```
Configure the loopback and the static NAT, and write down any message the router prints.

**Confidence:** **likely** that it works. **unconfirmed** for warnings and exact alias behaviour.

**Sources:**
- https://www.cisco.com/c/en/us/td/docs/routers/ios/config/17-x/ip-addressing/b-ip-addressing/m_iadnat-addr-consv-xe.html (static translation task; IP aliases for connected global addresses)
- https://www.cisco.com/c/en/us/support/docs/ip/network-address-translation-nat/6209-5.html (NAT order: outside→inside translation before routing)
- https://www.cisco.com/c/en/us/td/docs/routers/ios-xe/ip-addressing/ip-addressing/m_iadnat-ha-xe.html (NAT answers ARP for owned static addresses)
- Community: https://community.cisco.com/t5/routing-and-sd-wan/nat-issue-on-loopback-interface-isr4300/td-p/4302380/page/3 (ISR4331, static NAT to loopback addresses works from outside)
- Community: https://community.cisco.com/t5/switching/ip-4-dupaddr-hsrp-and-static-nat/m-p/4024671 (alias / `no-alias` behaviour)

---

## Catalyst 9300L basic IPv4 NAT (supplement to Q7)

**Verdict:** The in-scope **C9300L-24T-4G-A (Network Advantage)** can do basic IPv4 NAT on routed front-panel data ports in IOS XE 17.3. The `-E` Network Essentials entitlement is not sufficient. New virtual benches use the Advantage profile; `show version` and `show license` show it. No license command is required, and the ISR-based handout remains unchanged.

**What to check:** `ip routing`; use `no switchport`, IPv4 addressing and `ip nat inside` / `ip nat outside` on the routed ports. For interface PAT, specify `overload` and use an addressed, operational routed port. Use a permit-only selector ACL and a valid global-address pool (mask or prefix length); make sure the peer can reach translated addresses. Check actual traffic with `show ip nat translations` and `show ip nat statistics`.

**Boundaries:** L2 switchports do not attach routed NAT. Port Channel, explicit deny ACEs in a NAT selector, and route-map NAT are excluded by the 17.3 guide. SVI and rotary on the exact SKU/image are not established for this profile; their lab refusal is not proof that every Catalyst release rejects them. Cisco's hardware limit is about 2,500 translations in ideal conditions (5,000 TCAM entries, two per translation); ICMP and some other operations are software-forwarded. These are hardware notes, not simulated throughput or a hard session cap.

**Confidence:** **confirmed** for the license, routed-port basic forms and explicit guide restrictions. See [sources, limits, and executed lab evidence](final-catalyst.md).

---

## Q8. NAT on IOS XE vs. classic IOS: what the student will notice

**Verdict:** Same commands and same logic. Small visible differences: the table output ends with a total line, NAT ACLs have stricter rules, and the outside interface has a gotcha. NAT still happens before IPsec, as on classic IOS.

**Explanation / list:**
- **`show ip nat translations`:** same columns (Pro / Inside global / Inside local / Outside local / Outside global). IOS XE adds a final line `Total number of translations: N`. `show ip nat translations verbose` shows flags and mapping IDs. **confirmed**
- **NAT ACL rules (IOS XE guide):** NAT does not support `permit ip any any` in the NAT ACL. "This platform does not support an access list with a port range." Use the exact LAN1 network in `access-list 1`. **confirmed**
- **Outside interface (IOS XE guide):** "NAT outside interfaces show up in the translations tables, by default … connection that originates from the outside interface … [can] fail". Fix: deny the outside interface address in the NAT ACL. This only matters if the NAT ACL is too broad. **confirmed**
- **NAT before encryption:** inside→outside order is routing → NAT → crypto check. The crypto ACL sees *translated* addresses. The reference's protocol-only `any any` crypto ACL is not affected. **confirmed**
- **R2 sees translated addresses:** ACL 1 matches LAN1, so LAN1→LAN2 traffic is translated too. R2 sees PC1 as 60.50.50.100, and other LAN1 PCs as R1's serial address. The `access-class` and SNMP ACLs on R2 must permit the post-NAT address. This is not IOS-XE-specific. **likely**
- **PAT ports:** do not expect the inside global port to equal the original source port. **unconfirmed**
- **ICMP entries:** they show the ICMP identifier as the "port" and age out after a short timer (classic default about 60 s). **unconfirmed** for IOS XE.
- **"Interfaces must be up":** no Cisco statement was found. Logically, `interface Serial0/1/0 overload` needs the serial interface to have an address and be up. **unconfirmed**
- **NVI:** `ip nat enable` is not supported on IOS XE. It is not used in the reference. **confirmed**

**What to type / check:**
```
show ip nat translations
show ip nat translations verbose
show ip nat statistics             ! lists inside/outside interfaces, hits and misses
clear ip nat translation *
```

**Confidence:** per bullet (see above).

**Sources:**
- https://www.cisco.com/c/en/us/td/docs/routers/ios-xe/ip-addressing/ip-addressing/m_iadnat-addr-consv-xe.html (restrictions: NVI, outside interface, `permit ip any any`, port ranges)
- https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipaddr_nat/configuration/xe-16-11/nat-xe-16-11-book/iadnat-addr-consv.html
- https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipaddr_nat/configuration/xe-16-9/nat-xe-16-9-book/iadnat-monmain.html (sample output with "Total number of translations")
- https://www.cisco.com/c/en/us/support/docs/ip/network-address-translation-nat/6209-5.html (order of operations)
- https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/sec_conn_vpnips/configuration/xe-16/sec-sec-for-vpns-w-ipsec-xe-16-book/sec-cfg-vpn-ipsec.html ("NAT should occur before the router performs IPsec encapsulation")

---

## Q9. Auto-MDIX on ISR 4331 GE ports and Catalyst 9300L ports

**Verdict:** Catalyst 9300L copper ports have auto-MDIX on by default, so straight-through and crossover cables both work. For ISR 4331 onboard ports, no Cisco statement was found. Router↔switch links still work with either cable, because the switch end corrects it.

**Explanation.** The Catalyst 9300 interface guide says: "Auto-MDIX is enabled by default." It is supported on 10/100/1000 copper ports and on 1000BASE-T SFPs, but not on other SFP/SFP+ uplinks. Its link table shows "link up" with wrong cabling as long as one side has auto-MDIX. It needs speed/duplex auto, so do not hard-set both. The ISR 4000 hardware guide does not mention MDIX for the onboard ports. A direct PC↔router cable without a switch is the only risky case. Also: the ISR 4331 has 3 onboard GE ports but only 2 RJ-45 jacks and 2 SFP cages (data sheet). One port is SFP-only (per community: Gi0/0/2), so a copper cable cannot go there without an SFP.

**What to type / check:**
```
show interfaces status                    ! switch: link up?
show interfaces GigabitEthernet0/0/1      ! router: up/up, media type
show running-config interface Gi1/0/x     ! switch: no "no mdix auto", speed/duplex not both forced
```
If a PC↔router link stays down, swap the cable type.

**Confidence:** **confirmed** for the switch. **unconfirmed** for router auto-MDIX. **likely** for the 4331 port layout.

**Sources:**
- https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/software/release/17-18/configuration_guide/int_hw/b_1718_int_and_hw_9300_cg/configuring_auto_mdix.html
- https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/software/release/16-9/command_reference/b_169_9300_cr/interface_and_hardware_commands.html (`mdix auto`: default enabled)
- https://www.cisco.com/c/en/us/td/docs/routers/access/4400/hardware/installation/guide4400-4300/C4400_isr/Install_Connect.html (no MDIX statement)
- https://www.cisco.com/c/en/us/products/collateral/routers/4000-series-integrated-services-routers-isr/data_sheet-c78-732542.html (4331: 3 onboard ports, 2 RJ-45, 2 SFP)
- Community: https://community.cisco.com/t5/other-network-architecture-subjects/isr-4331-k9-cabling-options/td-p/3958070 (G0/0/0 combo, G0/0/1 copper, G0/0/2 SFP only)

---

## Q10. Factory-fresh console behaviour and console settings

**Verdict:** Both devices show the "System Configuration Dialog" and run autoinstall/PnP. Answer `no`, then `yes` to terminate autoinstall. On the Catalyst 9300 from 17.7.1, the dialog forces a strong enable secret. Console is 9600 8N1, no flow control, on RJ-45 or USB mini-B.

**Explanation.**
- **Dialog text:** `--- System Configuration Dialog --- / Would you like to enter the initial configuration dialog? [yes/no]:`, then `Would you like to terminate autoinstall? [yes]:`, then `Press RETURN to get started!`. Before that, a fresh box prints `No startup-config, starting autoinstall/pnp/ztp...` and `Autoinstall will terminate if any input is detected on console`. PnP messages may appear.
- **Catalyst 9300, 17.7.1 and later:** the enable secret is mandatory in the setup wizard, whether you answer yes or no. Rules: 10–32 characters, at least one upper case letter, one lower case letter and one digit, and it must not contain "cisco". You then get a menu; `[0] Go to the IOS command prompt without saving this config` skips saving it.
- **ISR 4331:** Cisco documents this enforcement for ISR 1000 from 17.5.1 and for other routers. It is **not** documented for ISR 4000, so it is unconfirmed there.
- **Stuck console (community, not staff):** a C9300L on 17.12.3 ignored typing during autoinstall until a BREAK was sent (Tera Term: Control → Send Break).
- **Console ports:**
  - ISR 4331: RJ-45 console and USB mini-B console on the front.
  - C9300: USB mini-B on the front, RJ-45 console on the rear.
  - When a USB console cable is plugged in, the RJ-45 console input is disabled.
- **USB drivers:**
  - Cisco USB device: a Cisco driver on Windows (the ISR guide says it is needed before Windows 7; the 9300 guide recommends it even on Windows 10). No driver on macOS or Linux.
  - Newer units with a Silicon Labs CP210x USB chip: the Silicon Labs driver, also on macOS.
- **ROMMON:** on the ISR, pressing Break in the first 60 s of boot gives the `rommon` prompt. The normal configuration register is 0x2102. Boot takes several minutes.

**What to type / check:**
```
Would you like to enter the initial configuration dialog? [yes/no]: no
Would you like to terminate autoinstall? [yes]: yes
Router> enable
Router# show version
Router# write erase  +  reload       ! returns the box to day-0 (the dialog comes back)
```
Whether a weak `enable secret` typed later in normal config mode is refused is **unconfirmed**. It is probably accepted.

**Confidence:** **confirmed** for console settings, USB precedence, drivers, the C9300 enforced secret and the dialog text. **unconfirmed** for the ISR 4331 enforced secret.

**Sources:**
- https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/software/release/17-18/configuration_guide/sec/b_1718_sec_9300_cg/controlling_switch_access_with_passwords_and_privilege_levels.html
- https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/software/release/17-7/release_notes/ol-17-7-9300.html ("Mandatory enable secret password in the initial configuration")
- https://www.cisco.com/c/en/us/td/docs/routers/access/isr1100/software/configuration/guide/isr1100-sw-config/using_iosxe_software.html (17.5.1 enforcement on ISR 1000; menu options [0]/[1]/[2])
- https://www.cisco.com/c/en/us/support/docs/wireless/catalyst-9800-series-wireless-controllers/217368-cooking-recipe-minimum-bootstrap-cli-co.html (autoinstall / dialog transcript)
- https://www.cisco.com/c/en/us/support/docs/switches/catalyst-9600-series-switches/216839-configure-a-catalyst-9600-switch.html
- https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/prog/configuration/1715/b_1715_programmability_cg/zero-touch-provisioning.html (PnP/ZTP boot messages on C9300)
- https://www.cisco.com/c/en/us/td/docs/routers/access/4400/hardware/installation/guide4400-4300/C4400_isr/Preinstall.html (ISR console 9600 8N1, USB precedence, driver note)
- https://www.cisco.com/c/en/us/td/docs/routers/access/4400/hardware/installation/guide4400-4300/C4400_isr/Install_Connect.html (Cisco and Silicon Labs USB drivers, macOS `screen`)
- https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/hardware/install/b_c9300_hig/Configuring-a-switch.html and https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/hardware/install/b_c9300_hig/Product-overview.html
- https://www.cisco.com/c/en/us/td/docs/routers/access/isr4400/software/configuration/xe-17/isr4400-sw-config-xe-17/m_configuration-register.html
- Community: https://community.cisco.com/t5/routing-and-sd-wan/cisco-9300l-switch-autoinstall-feature/td-p/5142396

---

## Q11. How numbered ACLs (and other lines) appear in `show running-config`

**Verdict:** On IOS XE 16.12 and later (all 17.x), `access-list 110 permit …` is probably shown as `ip access-list extended 110` with sequence numbers (`10 permit …`, `20 …`). Earlier releases show classic `access-list 110 …` lines. No Cisco document states this; mark it **likely**.

**Explanation.** Three independent non-Cisco sources agree: a 16.12 change log written by a network engineer, Ansible's IOS ACL module examples tested on 17.3, and a 17.3 Catalyst config listing. All show numbered ACLs in named format with sequence numbers. Remarks also get sequence numbers. A Cisco Catalyst 9400 17.15 guide adds that from 17.5.1, ACEs in `show run` are listed in ascending sequence order. Conflict: Cisco's IOS XE 17.x "IP Access List Entry Sequence Numbering" chapter still says "sequence numbers are not nvgened". That looks like legacy text, but the student should check. Other lines that will look different from what was typed:
- `logging 192.168.1.10` → `logging host 192.168.1.10`.
- `class-map ICMP` → `class-map match-all ICMP`.
- A transform-set gets a ` mode tunnel` line.
- ISAKMP default values are hidden.
- `enable secret` is stored hashed (17.x examples show type 9, `$9$…`).
- Standard ACL host entries may be listed before network entries (hash ordering, also on classic IOS).
- IOS XE adds many default lines (`vrf definition Mgmt-intf`, `license …`, `redundancy`, `negotiation auto` on GE ports …).
- `line vty 5 14` leaves `line vty 15` as a separate block on a 0–15 box.

**What to type / check:**
```
show running-config | section access-list
show ip access-lists                    ! sequence numbers and hit counts
show running-config | include ^logging
```

**Confidence:** **likely** for the ACL format. **confirmed** for `class-map match-all`, `mode tunnel` and hidden ISAKMP defaults (Cisco sample configs). **likely** for `logging host`.

**Sources:**
- Third-party: https://swagspace.org/blog/ios-acl-observations/ (IOS XE 16.12 change)
- Third-party: https://docs.ansible.com/projects/ansible/latest/collections/cisco/ios/ios_acls_module.html (tested on 17.3)
- Third-party: https://qiita.com/dan-go/items/5145b0d53ad62e2d1af0 (17.3 Catalyst config)
- https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9400/software/release/17-15/configuration_guide/sec/b_1715_sec_9400_cg/configuring_ipv4_acls.html (17.5.1 ascending order)
- https://www.cisco.com/c/en/us/td/docs/routers/ios/config/17-x/sec-vpn/b-security-vpn/m_sec-acl-seq-num.html (conflicting legacy text)
- https://www.cisco.com/c/en/us/td/docs/routers/ios/config/17-x/sec-vpn/b-security-vpn/m_sec-key-exch-ipsec-0.html (defaults not shown)
- https://www.cisco.com/c/dam/global/ja_jp/td/docs/ciam/high-speedwaninterfacecards/high-speedwaninterfacecar/cg/002/snim-config.pdf (sample config: `class-map match-all`, transform-set + `mode tunnel`)
- https://www.cisco.com/c/en/us/td/docs/routers/access/4400/software/configuration/xe-16-7/isr4400swcfg-xe-16-7-book/basic_router_configuration.html (ISR 4000 default config lines)
- Community: https://community.cisco.com/t5/switching/access-list-wrong-order/td-p/3070419 (standard ACL hash ordering)

---

## Q12. Other commands from the reference that behave differently or need care

| Command / topic | Verdict | Check | Confidence |
|---|---|---|---|
| `logging <ip>` | Accepted; stored as `logging host <ip>`. `logging host` officially replaced `logging` in 12.2(15)T. `logging source-interface Loopback0` is unchanged. | `show running-config \| include logging`, `show logging` | likely |
| `snmp-server community X RO 10` / `RW 11` | Valid, documented syntax on Catalyst 9300 17.x (`snmp-server community comaccess ro 4`). On R2 the ACL must permit PC1's *post-NAT* address (see Q8). | `show snmp community`, `show access-lists 10` | confirmed (syntax) |
| `line vty 5 14` | Accepted. The Catalyst 9300 has vty 0–15 (16 Telnet sessions). vty 15 keeps the default `login` with no password, so Telnet landing on it is refused ("Password required, but none set"). Safer: `line vty 5 15`. ISR 4331 default config shows `line vty 0 4`; extra lines are created when configured. | `show running-config \| section line vty`, `show line` | likely |
| `ip dhcp pool` relayed through the IPsec link | Works. Relayed DHCP (UDP 67/68) is not in the reference crypto ACL, so it crosses the serial link unencrypted. That is normal. | `show ip dhcp binding`, `debug ip dhcp server packet` | likely |
| DHCP ping-before-offer | The IOS XE DHCP server pings each candidate address twice before an OFFER (command reference: 500 ms each; one config guide says 2 s). From R1 those pings to LAN2 are ICMP, so they match `permit icmp any any` and may first trigger IKE. The first lease can be slow. | `show ip dhcp conflict`; `ip dhcp ping packets 0` only to test | confirmed (defaults); likely (crypto interaction) |
| Crypto ACL with port entries (`permit tcp any any eq telnet`) | Not IOS-XE-specific: IKE proxy IDs must mirror. Each router normally needs both directions (`permit tcp any any eq telnet` *and* `permit tcp any eq telnet any`), as the cheat sheet hints ("konfigurovať symetrické ACL"). | `show crypto ipsec sa`, `debug crypto isakmp` ("proxy identities not supported") | likely |
| Type-0 password warnings | IOS XE prints `WARNING: Command has been added to the configuration using a type 0 password…` for e.g. `username … password`. The command is still accepted. Whether a line `password cisco` triggers it is unconfirmed. | Read the message; it is not an error | confirmed (for username) |
| `ip route 0.0.0.0 0.0.0.0 Serial0/1/0 <next-hop>`, `ip helper-address`, `ip dhcp excluded-address` | No known IOS XE difference. | `show ip route`, `show ip interface Gi0/0/x` | likely |
| Cheat-sheet `show queueing …` | Removed (IOS XE 3.2S). Use `show policy-map interface`. | — | confirmed |
| Interface names | ISR 4331: `GigabitEthernet0/0/0–0/0/2`, `Serial0/1/x`. `GigabitEthernet0` is the management port in VRF `Mgmt-intf`; do not use it for the lab. Catalyst 9300L: `GigabitEthernet1/0/x` downlinks, fixed SFP/SFP+ uplinks `Gi1/1/x` or `Te1/1/x` depending on the model, management port `GigabitEthernet0/0`. | `show ip interface brief` | confirmed (router, switch mgmt port); likely (switch uplink names) |

**Sources:**
- https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/esm/command/esm-cr-book/esm-cr-a1.html (`logging host` history)
- https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/software/release/17-18/configuration_guide/nmgmt/b_1718_nmgmt_9300_cg/configuring_simple_network_management_protocol.html
- https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/software/release/26-x/command_reference/b_26x_9300_cr/using_the_command_line_interface.html (16 simultaneous Telnet sessions)
- https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/software/release/17-12/configuration_guide/sys_mgmt/b_1712_sys_mgmt_9300_cg/configuring_system_message_logs.html (vty range 0–15)
- https://www.cisco.com/c/en/us/td/docs/routers/ios-xe/ip-addressing/ip-addressing/m_config-dhcp-server-xe.html , https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipaddr/command/ipaddr-cr-book/ipaddr-i2.html , https://www.cisco.com/c/en/us/support/docs/ip/dynamic-address-allocation-resolution/226237-operate-a-robust-ios-xe-dhcp-server.html
- https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/prog/configuration/1718/b-1718-programmability-cg/zero-touch-provisioning.html (type-0 password warning text)
- https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/qos_mqc/configuration/xe-16-12/qos-mqc-xe-16-12-book/qos-leg.html
- https://www.cisco.com/c/en/us/td/docs/routers/access/4400/hardware/installation/guide4400-4300/C4400_isr/Overview.html (GE 0 management port)

---

## Short notes for the student

| id | feature | title | note | confidence |
|---|---|---|---|---|
| vty-telnet-default | vty | Telnet works on vty by default | You do not need `transport input telnet` on these devices. If Telnet is refused, run `show running-config all \| section line vty`. | likely |
| vty-transport-replaces | vty | transport input telnet turns SSH off | The command replaces the list of protocols. Type `transport input telnet ssh` if you want both. | likely |
| vty-line-15 | vty | line vty 5 14 skips line 15 | The switch has vty lines 0 to 15. Prefer `line vty 5 15` so every line gets the same settings. | likely |
| vty-type0-warning | vty | Type 0 password warning is harmless | IOS XE may warn about "type 0 passwords". The command was still saved. | confirmed |
| qos-preclassify | qos | Add qos pre-classify to the crypto map | Without it, ICMP and Telnet classes do not match encrypted traffic. Type it under `crypto map NAME 10`. | likely |
| qos-child-valid | qos | priority, bandwidth and fair-queue work together | `priority 16`, `bandwidth 48` and `fair-queue` in class-default are accepted. A `priority` with no number would block `bandwidth`. | confirmed |
| qos-bandwidth-first | qos | Set bandwidth 128 before the policy | The 95 % shaper is calculated from the interface bandwidth. Check the rate in `show policy-map interface`. | likely |
| qos-fair-queue-flow | qos | fair-queue is flow-based, not classic WFQ | On IOS XE, fair-queue puts each flow into one of 16 queues and serves them fairly. It is not the classic WFQ of older routers. | confirmed |
| qos-legacy-gone | qos | Old queueing commands do not exist | `priority-list`, `queue-list`, `custom-queue-list` and interface `fair-queue` give an error. Use class-map and policy-map only. | likely |
| qos-show-queueing | qos | Use show policy-map interface | `show queueing` was removed from IOS XE. The serial interface shows "Queueing strategy: fifo". | confirmed |
| ipsec-license | ipsec | Crypto needs the security license | If `crypto isakmp` gives "Invalid input", the license is off. Type `license boot level securityk9`, save, and reload. | confirmed |
| ipsec-weak-rejected | ipsec | DES, 3DES, MD5, groups 1/2/5 refused | From release 17.11 the router refuses them for IPsec. Use `encryption aes`, `hash sha256` and `group 14`. | confirmed |
| ipsec-weak-warning | ipsec | Weak algorithm warning from 17.6 | Between 17.6 and 17.10 you see "deprecated". The command still works. | confirmed |
| ipsec-set-everything | ipsec | Set every ISAKMP value yourself | Defaults are hidden and may be weak. Check them with `show crypto isakmp policy`. | likely |
| ipsec-acl-mirror | ipsec | Port-based crypto ACLs need both directions | `eq telnet` matches only one direction. Add the reverse line, for example `permit tcp any eq telnet any`. | likely |
| interface-serial-name | interface | Serial0/1/0 is the NIM in bay 1 | The serial port is on a NIM-1T, NIM-2T or NIM-4T card. `show platform` shows which card it is. | confirmed |
| interface-clock-128k | interface | clock rate 128000 may be refused | Cisco's NIM list has 125000 but not 128000. Type `clock rate ?` and use the closest value it offers. | unconfirmed |
| interface-clock-dce-only | interface | clock rate only works on DCE | The DTE end takes the clock from the cable. Check which end is DCE with `show controllers serial 0/1/0`. | confirmed |
| interface-dce-default | interface | DCE may run at a default speed | Without `clock rate`, the DCE port may still clock at a hardware default. Then the link is not 128 kbps. | unconfirmed |
| interface-ge-names | interface | Router ports are Gi0/0/0, not Gi0/0 | The ISR 4331 ports are GigabitEthernet0/0/0 to 0/0/2. Do not use GigabitEthernet0: it is the management port. | confirmed |
| cabling-sfp-only | cabling | One router port has no RJ-45 | The ISR 4331 has only two copper jacks. Plug copper cables into ports with an RJ-45 socket. | likely |
| cabling-switch-mdix | cabling | Switch ports accept either cable | Catalyst 9300L copper ports fix a wrong cable type by themselves. Keep speed and duplex on auto. | confirmed |
| cabling-router-mdix | cabling | Router-to-PC cable: try crossover | Auto-MDIX is not documented for the ISR 4331 ports. If a direct PC link stays down, swap the cable. | unconfirmed |
| console-settings | console | Console is 9600, 8N1, no flow | Use 9600 baud, 8 data bits, no parity, 1 stop bit. Turn flow control off. | confirmed |
| console-usb-driver | console | USB console may need a driver | On Windows, install the Cisco or Silicon Labs USB console driver if no COM port appears. A plugged-in USB console cable disables the RJ-45 console port. | confirmed |
| console-setup-dialog | console | Answer no, then yes | Answer `no` to the setup dialog. Then answer `yes` to terminate autoinstall. | confirmed |
| console-send-break | console | Console ignores typing: send a Break | One user's 9300L ignored typing during autoinstall. Sending a Break (Tera Term: Control > Send Break) fixed it. | unconfirmed |
| console-switch-secret | console | Switch forces a strong enable secret | From 17.7 the switch asks for a 10+ character secret without "cisco". Choose [0] to skip saving it. | confirmed |
| console-router-secret | console | Router may also force a secret | This is not documented for the ISR 4331. Be ready for the same prompt as on the switch. | unconfirmed |
| acl-numbered-display | acl | Numbered ACLs look like named ACLs | On 16.12 and newer, `access-list 110` may show as `ip access-list extended 110` with line numbers. The ACL works the same. | likely |
| acl-standard-order | acl | Standard ACL lines may be reordered | Host entries can be listed before network entries. The result of the ACL does not change. | likely |
| nat-static-loopback | nat | Static NAT to the loopback address works | Traffic from outside to 60.50.50.100 goes to PC1. The router itself stops answering on that address. | likely |
| nat-total-line | nat | NAT table ends with a total | `show ip nat translations` ends with "Total number of translations". The columns are the same as before. | confirmed |
| nat-acl-exact | nat | NAT ACL must list your LAN | Do not use `permit any` in the NAT access list. Permit only the LAN1 network. | likely |
| nat-before-crypto | nat | NAT happens before encryption | The crypto ACL sees translated addresses. With `any any` crypto lines this does not matter. | confirmed |
| nat-r2-sees-global | nat | R2 sees PC1 as 60.50.50.100 | Traffic from LAN1 is translated before it reaches R2. R2's Telnet and SNMP ACLs must allow the translated address. | likely |
| dhcp-ping-check | dhcp | DHCP server pings before giving an address | The router pings each address twice before it offers it. So the first address can take a moment. | confirmed |
| dhcp-relay-clear | dhcp | Relayed DHCP is not encrypted | DHCP is not in the crypto ACL, so it crosses the serial link in clear. That is normal and it still works. | likely |
| snmp-acl-ok | snmp | Community with ACL number works | `snmp-server community X RO 10` is valid on IOS XE. Check it with `show snmp community`. | confirmed |
| syslog-logging-host | syslog | logging IP becomes logging host IP | The router saves `logging 1.2.3.4` as `logging host 1.2.3.4`. It is the same setting. | likely |
