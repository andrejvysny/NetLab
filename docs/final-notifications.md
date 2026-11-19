# SNMP and syslog notification verification

## What NetLab now models

- `snmp-server host` saves the notification kind, version, v3 security level, and host notification-family filters. The default is an SNMPv1 trap target; `version 3` without a level saves and renders as `noauth`. Explicit or defaulted v1 informs are rejected. A subsequent command replaces the target for the same IPv4 address and kind; a trap target and an inform target can coexist at one address. Bare `no snmp-server host <ip>` removes the trap entry, while `no snmp-server host <ip> informs` removes the inform entry.
- UDP/162 trap delivery uses the modeled forwarding path, the configured active IPv4 `trap-source` (or the egress address if unavailable), and the PC management receiver. Both the global selector and any host filter must permit the event. For example, a host filtered to `snmp` does not receive `config` traps. `snmp-server enable traps snmp linkdown linkup` matches the two events individually, and `no snmp-server enable traps snmp linkdown` suppresses just linkDown, even after saving and reloading a broader enable rule.
- The Lab dispatches `config` once on exit from a CLI configuration session that made an edit, once when a file apply commits a configuration change, or after a modeled SNMP SET changes configuration. Empty config sessions, repeated no-op commands, GETs, and failed replacements do not generate a config trap. Each up/down transition in the line protocol of an existing interface dispatches one link trap, not one for `%LINK` and another for `%LINEPROTO`.
- `no logging on` disables new syslog buffer entries and remote sends; `no logging trap` disables only remote sends. `show logging` distinguishes both and retains previous buffer history. Neither command disables SNMP traps. Policy-suppressed notifications do not start flows, leave notification trace steps, or increment counters. Forwarding failures on permitted attempts are still observable. Logs raised by forwarding notification datagrams are buffered where logging is enabled, not forwarded as more notifications.
- `show snmp host` displays the saved security level and filter; it labels v3 and inform targets as configuration only. `show snmp` and `show logging` report modeled dispatch attempts and actual PC collection per address. These are simulation observations, not acknowledgments, and the presence of a route in `show logging` does not prove delivery.

## Limits

- No on-wire SNMP encoding, v3 USM/authentication/privacy or delivery, or inform requests, acknowledgments or retries. Only model-level v1/v2c-style traps for `config`, `snmp linkup`, and `snmp linkdown` are emitted. Other notification families and extra commands may be stored without a producer. There are no SNMP request/PDU or queue counters, per-interface link trap controls, coldStart/warmStart or authenticationFailure notifications, or host names, IPv6, custom UDP ports or VRFs for notification targets. Link traps are based on the lab's line-protocol snapshots, not platform-specific IF-MIB rules. The PC receiver uses the existing management service toggle shared with syslog.
- Previously stored v3 hosts without a security field are read as `noauth`; the original level and filters discarded by older versions cannot be reconstructed. If an old saved lab has duplicate host/kind entries, the last one is effective. Legacy invalid v1 inform entries are not rendered or sent.
- This is local simulator verification on modeled ISR 4331 and Catalyst 9300L, not a test on physical IOS XE or an assertion about exact parser/platform options on every image.

## Cisco primary references

- [Cisco IOS SNMP Support Command Reference: `snmp-server host`](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/snmp/command/nm-snmp-cr-book/nm-snmp-cr-s5.html) documents trap/default v1 and default v3 `noauth`, multiple host notification families, last-command-wins per host and notification kind, and the trap versus inform `no` forms. It also documents one-shot traps versus acknowledged informs.
- [Catalyst 9300 IOS XE 17.3: Configuring SNMP](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/software/release/17-3/configuration_guide/nmgmt/b_173_nmgmt_9300_cg/configuring_simple_network_management_protocol.html) explicitly excludes v1 informs and describes the v3 security levels and inform retries.
- [Cisco IOS SNMP Support Command Reference: `snmp-server enable traps`](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/snmp/command/nm-snmp-cr-book/nm-snmp-cr-s4.html) identifies `config` as the CISCO-CONFIG-MAN-MIB notification and describes global selection. [IOS XE 17: Controlling Individual RFC 1157 SNMP Traps](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/snmp/configuration/xe-17-x/snmp-xe-17-book/nm-snmp-cfg-snmp-support.html) shows `snmp linkup linkdown` selectors and separate interface-level controls; check the target platform for its exact link-trap defaults and controls.
- [Cisco IOS Embedded Syslog Manager Command Reference: `logging on` and `logging host`](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/esm/command/esm-cr-book/esm-cr-a1.html) distinguishes global asynchronous logging suppression (console output can remain) from destination configuration. [Cisco System Message Logging: `logging trap`](https://www.cisco.com/c/en/us/td/docs/routers/access/wireless/software/guide/SysMsgLogging.html) documents the remote threshold and how `no logging trap` disables remote logging.

## Local checks

```sh
node scripts/command-coverage.mjs --section G
node scripts/command-coverage.mjs --csv > docs/command-coverage.csv
node --test tests/content/coverage.test.ts tests/cli/mgmt-snmp.test.ts tests/cli/show-variants.test.ts tests/lab/notifications.test.ts tests/sim/notifications.test.ts
npm run typecheck
npm test
```

Verified locally with Node 24: **881/881** tests in the full suite, **19/19** targeted tests, and a clean typecheck. Section G passed **74 probes per model**; the refreshed CSV contains **556** probes across A–G and matches the generated snapshot.
