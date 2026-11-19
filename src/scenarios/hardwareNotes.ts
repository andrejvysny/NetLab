/**
 * Hardware notes for the student: the short rows of the final table in docs/HARDWARE_NOTES.md (wording kept, back-ticks removed),
 * and the choice of rows that fit one scenario. Numbers in a few rows follow the scenario (link speed, addresses).
 * Owned by the scenario agent.
 */
import type { Feature, HardwareNote } from '../engine/types.ts';
import type { PartId, Spec } from './spec.ts';
import { has, isTask, model } from './spec.ts';

interface Row { id: string; feature: Feature; title: string; text: string; confidence: 'confirmed' | 'likely' | 'unconfirmed' }

export const HARDWARE_ROWS: Row[] = [
  { id: 'vty-telnet-default', feature: 'vty', title: "Telnet works on vty by default", text: "You do not need transport input telnet on these devices. If Telnet is refused, run show running-config all | section line vty.", confidence: 'likely' },
  { id: 'vty-transport-replaces', feature: 'vty', title: "transport input telnet turns SSH off", text: "The command replaces the list of protocols. Type transport input telnet ssh if you want both.", confidence: 'likely' },
  { id: 'vty-line-15', feature: 'vty', title: "line vty 5 14 skips line 15", text: "The switch has vty lines 0 to 15. Prefer line vty 5 15 so every line gets the same settings.", confidence: 'likely' },
  { id: 'vty-type0-warning', feature: 'vty', title: "Type 0 password warning is harmless", text: "IOS XE may warn about \"type 0 passwords\". The command was still saved.", confidence: 'confirmed' },
  { id: 'qos-preclassify', feature: 'qos', title: "Add qos pre-classify to the crypto map", text: "An ESP-only classifier needs pre-classification to match inner ports and protocols. Use the active crypto-map entry. The course profile already sees the inner header.", confidence: 'likely' },
  { id: 'qos-child-valid', feature: 'qos', title: "priority, bandwidth and fair-queue work together", text: "priority 16, bandwidth 48 and fair-queue in class-default are accepted. A priority with no number would block bandwidth.", confidence: 'confirmed' },
  { id: 'qos-bandwidth-first', feature: 'qos', title: "Set bandwidth 128 before the policy", text: "The 95 % shaper is calculated from the interface bandwidth. Check the rate in show policy-map interface.", confidence: 'likely' },
  { id: 'qos-fair-queue-flow', feature: 'qos', title: "fair-queue is flow-based, not classic WFQ", text: "On IOS XE, fair-queue puts each flow into one of 16 queues and serves them fairly. It is not the classic WFQ of older routers.", confidence: 'confirmed' },
  { id: 'qos-legacy-gone', feature: 'qos', title: "Old queueing commands do not exist", text: "priority-list, queue-list, custom-queue-list and interface fair-queue give an error. Use class-map and policy-map only.", confidence: 'likely' },
  { id: 'qos-show-queueing', feature: 'qos', title: "Use show policy-map interface", text: "show queueing was removed from IOS XE. The serial interface shows \"Queueing strategy: fifo\".", confidence: 'confirmed' },
  { id: 'ipsec-license', feature: 'ipsec', title: "Crypto needs the security license", text: "If crypto isakmp gives \"Invalid input\", the license is off. Type license boot level securityk9, save, and reload.", confidence: 'confirmed' },
  { id: 'ipsec-weak-rejected', feature: 'ipsec', title: "DES, 3DES, MD5, groups 1/2/5 refused", text: "From release 17.11 the router refuses them for IPsec. Use encryption aes, hash sha256 and group 14.", confidence: 'confirmed' },
  { id: 'ipsec-weak-warning', feature: 'ipsec', title: "Weak algorithm warning from 17.6", text: "Between 17.6 and 17.10 you see \"deprecated\". The command still works.", confidence: 'confirmed' },
  { id: 'ipsec-set-everything', feature: 'ipsec', title: "Set every ISAKMP value yourself", text: "Defaults are hidden and may be weak. Check them with show crypto isakmp policy.", confidence: 'likely' },
  { id: 'ipsec-acl-mirror', feature: 'ipsec', title: "Port-based crypto ACLs need both directions", text: "eq telnet matches only one direction. Add the reverse line, for example permit tcp any eq telnet any.", confidence: 'likely' },
  { id: 'interface-serial-name', feature: 'interface', title: "Serial0/1/0 is the NIM in bay 1", text: "The serial port is on a NIM-1T, NIM-2T or NIM-4T card. show platform shows which card it is.", confidence: 'confirmed' },
  { id: 'interface-clock-128k', feature: 'interface', title: "clock rate 128000 may be refused", text: "Cisco's NIM list has 125000 but not 128000. Type clock rate ? and use the closest value it offers.", confidence: 'unconfirmed' },
  { id: 'interface-clock-dce-only', feature: 'interface', title: "clock rate only works on DCE", text: "The DTE end takes the clock from the cable. Check which end is DCE with show controllers serial 0/1/0.", confidence: 'confirmed' },
  { id: 'interface-dce-default', feature: 'interface', title: "DCE may run at a default speed", text: "Without clock rate, the DCE port may still clock at a hardware default. Then the link is not 128 kbps.", confidence: 'unconfirmed' },
  { id: 'interface-ge-names', feature: 'interface', title: "Router ports are Gi0/0/0, not Gi0/0", text: "The ISR 4331 ports are GigabitEthernet0/0/0 to 0/0/2. Do not use GigabitEthernet0: it is the management port.", confidence: 'confirmed' },
  { id: 'cabling-sfp-only', feature: 'cabling', title: "One router port has no RJ-45", text: "The ISR 4331 has only two copper jacks. Plug copper cables into ports with an RJ-45 socket.", confidence: 'likely' },
  { id: 'cabling-switch-mdix', feature: 'cabling', title: "Switch ports accept either cable", text: "Catalyst 9300L copper ports fix a wrong cable type by themselves. Keep speed and duplex on auto.", confidence: 'confirmed' },
  { id: 'cabling-router-mdix', feature: 'cabling', title: "Router-to-PC cable: try crossover", text: "Auto-MDIX is not documented for the ISR 4331 ports. If a direct PC link stays down, swap the cable.", confidence: 'unconfirmed' },
  { id: 'console-settings', feature: 'console', title: "Console is 9600, 8N1, no flow", text: "Use 9600 baud, 8 data bits, no parity, 1 stop bit. Turn flow control off.", confidence: 'confirmed' },
  { id: 'console-usb-driver', feature: 'console', title: "USB console may need a driver", text: "On Windows, install the Cisco or Silicon Labs USB console driver if no COM port appears. A plugged-in USB console cable disables the RJ-45 console port.", confidence: 'confirmed' },
  { id: 'console-setup-dialog', feature: 'console', title: "Answer no, then yes", text: "Answer no to the setup dialog. Then answer yes to terminate autoinstall.", confidence: 'confirmed' },
  { id: 'console-send-break', feature: 'console', title: "Console ignores typing: send a Break", text: "One user's 9300L ignored typing during autoinstall. Sending a Break (Tera Term: Control > Send Break) fixed it.", confidence: 'unconfirmed' },
  { id: 'console-switch-secret', feature: 'console', title: "Switch forces a strong enable secret", text: "From 17.7 the switch asks for a 10+ character secret without \"cisco\". Choose [0] to skip saving it.", confidence: 'confirmed' },
  { id: 'console-router-secret', feature: 'console', title: "Router may also force a secret", text: "This is not documented for the ISR 4331. Be ready for the same prompt as on the switch.", confidence: 'unconfirmed' },
  { id: 'acl-numbered-display', feature: 'acl', title: "Numbered ACLs look like named ACLs", text: "On 16.12 and newer, access-list 110 may show as ip access-list extended 110 with line numbers. The ACL works the same.", confidence: 'likely' },
  { id: 'acl-standard-order', feature: 'acl', title: "Standard ACL lines may be reordered", text: "Host entries can be listed before network entries. The result of the ACL does not change.", confidence: 'likely' },
  { id: 'nat-static-loopback', feature: 'nat', title: "Static NAT to the loopback address works", text: "Traffic from outside to 60.50.50.100 goes to PC1. The router itself stops answering on that address.", confidence: 'likely' },
  { id: 'nat-total-line', feature: 'nat', title: "NAT table ends with a total", text: "show ip nat translations ends with \"Total number of translations\". The columns are the same as before.", confidence: 'confirmed' },
  { id: 'nat-acl-exact', feature: 'nat', title: "NAT ACL must list your LAN", text: "Do not use permit any in the NAT access list. Permit only the LAN1 network.", confidence: 'likely' },
  { id: 'nat-before-crypto', feature: 'nat', title: "NAT happens before encryption", text: "The crypto ACL sees translated addresses. With any any crypto lines this does not matter.", confidence: 'confirmed' },
  { id: 'nat-r2-sees-global', feature: 'nat', title: "R2 sees PC1 as 60.50.50.100", text: "Traffic from LAN1 is translated before it reaches R2. R2's Telnet and SNMP ACLs must allow the translated address.", confidence: 'likely' },
  { id: 'dhcp-ping-check', feature: 'dhcp', title: "DHCP server pings before giving an address", text: "The router pings each address twice before it offers it. So the first address can take a moment.", confidence: 'confirmed' },
  { id: 'dhcp-relay-clear', feature: 'dhcp', title: "Relayed DHCP is not encrypted", text: "DHCP is not in the crypto ACL, so it crosses the serial link in clear. That is normal and it still works.", confidence: 'likely' },
  { id: 'snmp-acl-ok', feature: 'snmp', title: "Community with ACL number works", text: "snmp-server community X RO 10 is valid on IOS XE. Check it with show snmp community.", confidence: 'confirmed' },
  { id: 'syslog-logging-host', feature: 'syslog', title: "logging IP becomes logging host IP", text: "The router saves logging 1.2.3.4 as logging host 1.2.3.4. It is the same setting.", confidence: 'likely' },
];

/** Which part of the work a row belongs to, and an extra condition where one is needed. */
const WHEN: Record<string, { part: PartId; also?: PartId; if?: (s: Spec) => boolean }> = {
  'vty-telnet-default': { part: 'telnet' },
  'vty-transport-replaces': { part: 'telnet' },
  'vty-line-15': { part: 'telnet' },
  'vty-type0-warning': { part: 'telnet' },
  'qos-preclassify': { part: 'qos', if: (s) => has(s, 'ipsec') },
  'qos-child-valid': { part: 'qos' },
  'qos-bandwidth-first': { part: 'qos', if: (s) => s.wan === 'serial' },
  'qos-fair-queue-flow': { part: 'qos' },
  'qos-legacy-gone': { part: 'qos' },
  'qos-show-queueing': { part: 'qos' },
  'ipsec-license': { part: 'ipsec' },
  'ipsec-weak-rejected': { part: 'ipsec' },
  'ipsec-weak-warning': { part: 'ipsec' },
  'ipsec-set-everything': { part: 'ipsec' },
  'ipsec-acl-mirror': { part: 'ipsec', if: (s) => s.ipsec?.mode === 'services' },
  'interface-serial-name': { part: 'basics', if: (s) => s.wan === 'serial' },
  'interface-clock-128k': { part: 'basics', also: 'qos', if: (s) => s.wan === 'serial' },
  'interface-clock-dce-only': { part: 'basics', also: 'qos', if: (s) => s.wan === 'serial' },
  'interface-dce-default': { part: 'basics', also: 'qos', if: (s) => s.wan === 'serial' },
  'interface-ge-names': { part: 'basics' },
  'cabling-sfp-only': { part: 'cabling' },
  'cabling-switch-mdix': { part: 'cabling' },
  'cabling-router-mdix': { part: 'cabling' },
  'console-settings': { part: 'console' },
  'console-usb-driver': { part: 'console' },
  'console-setup-dialog': { part: 'console' },
  'console-send-break': { part: 'console' },
  'console-switch-secret': { part: 'console' },
  'console-router-secret': { part: 'console' },
  'acl-numbered-display': { part: 'acl' },
  'acl-standard-order': { part: 'acl' },
  'nat-static-loopback': { part: 'nat', if: (s) => s.nat?.mode === 'case' },
  'nat-total-line': { part: 'nat' },
  'nat-acl-exact': { part: 'nat', if: (s) => s.nat?.mode !== 'static' },
  'nat-before-crypto': { part: 'nat', if: (s) => has(s, 'ipsec') },
  'nat-r2-sees-global': { part: 'nat', if: (s) => s.nat?.mode === 'case' },
  'dhcp-ping-check': { part: 'dhcp' },
  'dhcp-relay-clear': { part: 'dhcp', if: (s) => has(s, 'ipsec') },
  'snmp-acl-ok': { part: 'snmp' },
  'syslog-logging-host': { part: 'syslog' },
};

/** Rows whose numbers depend on the assignment. */
function adapt(row: Row, s: Spec): { title: string; text: string } {
  const m = model(s);
  const q = s.qos;
  switch (row.id) {
    case 'qos-child-valid':
      return q ? { title: row.title, text: `priority ${q.priority.kbps}, bandwidth ${q.guaranteed.kbps} and fair-queue in class-default are accepted. A priority with no number would block bandwidth.` } : row;
    case 'qos-bandwidth-first':
      return q ? { title: `Set bandwidth ${q.linkKbps} before the policy`, text: `For a percentage shaper, bandwidth ${q.linkKbps} sets the reference only. It is not a physical speed or rate limit. Check show policy-map interface.` } : row;
    case 'interface-clock-128k':
      return m.clock !== undefined && m.clock !== 128000
        ? { title: `clock rate ${m.clock} may be refused`, text: 'The serial card accepts only certain speeds. Type clock rate ? and use the closest value it offers.' }
        : row;
    case 'nat-static-loopback':
      return { title: row.title, text: `Traffic from outside to ${s.addr.r1Lo100 ?? 'the Loopback100 address'} goes to PC1. The router itself stops answering on that address.` };
    case 'nat-r2-sees-global':
      return { title: `R2 sees PC1 as ${m.pc1Outside}`, text: "Traffic from LAN1 is translated before it reaches R2. R2's Telnet and SNMP ACLs must allow the translated address." };
    default:
      return row;
  }
}

/** The rows that matter for this scenario: the parts the student works on (all graded parts for a broken network). */
export function hardwareNotesFor(s: Spec): HardwareNote[] {
  const relevant = (p: PartId): boolean => (s.style === 'ticket' ? s.parts.includes(p) : isTask(s, p));
  const out: HardwareNote[] = [];
  for (const row of HARDWARE_ROWS) {
    const w = WHEN[row.id];
    if (!w || !(relevant(w.part) || (w.also !== undefined && relevant(w.also))) || (w.if && !w.if(s))) continue;
    const t = adapt(row, s);
    out.push({ id: row.id, feature: row.feature, title: t.title, text: t.text });
  }
  return out;
}
