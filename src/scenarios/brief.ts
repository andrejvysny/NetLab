/**
 * The assignment as the student receives it: intro, numbered tasks, the facts the sheet fixes, and the logical
 * topology picture (networks, loopbacks, which PC is where: never port numbers or cable types). Owned by the scenario agent.
 */
import type { BenchDeviceSeed, BriefItem, DiagramSpec } from '../engine/types.ts';
import type { PartId, Spec } from './spec.ts';
import { SVC, cidr, dhcpClients, has, isTask, joinAnd, maskOf, model, svcShort } from './spec.ts';

export type Brief = { intro: string; items: BriefItem[]; given?: { label: string; value: string }[] };

function cap(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1); }

// ───────────────────────────── the sheet of the case study and its variations ─────────────────────────────
export function sheetItems(s: Spec): BriefItem[] {
  const a = s.addr;
  const items: BriefItem[] = [];
  const n = s.dhcp?.excludeFirst ?? 100;
  items.push({
    no: '1', feature: 'dhcp',
    text: `PC2 and PC3 get their IP address from a DHCP server. PC1 has a static IP address. Configure only one router as the DHCP server. Think of task 4 when you choose it. In LAN1, do not hand out the first ${n} usable addresses.`,
  });
  items.push({
    no: '2', feature: 'interface',
    text: `The two routers are joined by a point-to-point link (WAN1) with the mask /${a.wan.len}. LAN1 has the mask /${a.lan1.len}. LAN2 has the mask /${a.lan2.len}.`,
  });
  items.push({
    no: '3', feature: 'routing',
    text: 'Communication must work inside LAN1, inside LAN2, between LAN1 and LAN2, and between the loopback interfaces of the two routers.',
  });
  items.push({
    no: '4', feature: 'nat',
    text: 'The PCs in LAN1 use a private class C network. To the outside they must appear with public addresses.',
    subItems: [
      'LAN1 hosts share R1’s public WAN1 address for concurrent outside sessions (PAT). PC1 is the exception below: its fixed public mapping also takes precedence for outbound traffic.',
      'PC1 (MS) must be reachable even when a session starts outside. Use the address of R1 Loopback100 for its fixed public mapping.',
    ],
  });
  items.push({
    no: '5', feature: 'routing',
    text: 'The routers do not use a routing protocol. Besides the directly connected networks, each routing table may hold only one more entry.',
  });
  const acl = s.acl?.mode === 'case' ? s.acl : undefined;
  if (acl) {
    const h = { net: a.lan2.net, len: a.lan2.len + 1 };
    items.push({
      no: '6', feature: 'acl',
      text: acl.pc1.kind === 'r2-lo0'
        ? 'PC1 must not communicate with the Loopback0 network on router R2.'
        : s.addrGiven
          ? `PC1 must not communicate with the first half of LAN2 (the network ${cidr(h)}).`
          : 'PC1 must not communicate with the first half of the LAN2 network (the lower half of its addresses).',
    });
    items.push({
      no: '7', feature: 'acl',
      text: `PC2 must not communicate with LAN2 in any way other than ${joinAnd(acl.pc2Allow.map(svcShort), 'or')}.`,
    });
  }
  if (s.ipsec?.mode === 'services') {
    items.push({ no: '8', feature: 'ipsec', text: 'Encrypt this traffic between the routers R1 and R2:', subItems: s.ipsec.services.map((x) => cap(SVC[x].name)) });
  }
  items.push({
    no: '9', feature: 'ipsec', optional: true,
    text: 'ICMP and FTP between PC1 and PC3 leave the PCs already encrypted (Windows IPsec). This task is crossed out on the sheet. It is not graded here.',
  });
  if (s.qos) {
    const q = s.qos;
    items.push({
      no: '10', feature: 'qos',
      text: s.wan === 'serial'
        ? `Limit the link between R1 and R2 physically to ${q.linkKbps} kbit/s. On this link, provide quality of service in both directions:`
        : `This variant uses an Ethernet WAN. Its physical speed is unchanged; use ${q.linkKbps} kbit/s as the practice reference for shaping in both directions:`,
      subItems: [
        `${cap(joinAnd(q.priority.services.map(svcShort)))} gets ${q.priority.kbps} kbit/s, guaranteed, with priority.`,
        `${cap(joinAnd(q.guaranteed.services.map(svcShort)))} get${q.guaranteed.services.length === 1 ? 's' : ''} a guaranteed bandwidth of at least ${q.guaranteed.kbps} kbit/s.`,
        'All other traffic shares the remaining bandwidth by WFQ.',
        `Shape all traffic to ${q.shapePercent} % of the ${s.wan === 'serial' ? 'physical speed' : 'practice reference rate'}.`,
      ],
    });
  }
  items.push({ no: '11', feature: 'vty', text: 'Allow remote access by Telnet on both routers. It must be possible only from PC1 (MS).' });
  if (s.snmp) {
    items.push({
      no: '12', feature: 'snmp',
      text: `Make the SNMP MIB available for reading and writing on both routers. Reading is allowed from PC1 and PC3. Writing is allowed only from PC1.${s.snmp.namesGiven ? ` Use the community ${s.snmp.ro} for reading and ${s.snmp.rw} for writing.` : ''}`,
    });
  }
  if (s.syslog) {
    items.push({
      no: '13', feature: 'syslog',
      text: `Both routers send their system messages to PC1 (MS). The source address is the address of ${s.syslog.source === 'Loopback0' ? 'interface Loopback0' : "the router's LAN interface"}.`,
    });
  }
  return items;
}

export function sheetGiven(s: Spec): { label: string; value: string }[] {
  const a = s.addr;
  const m = model(s);
  if (s.addrGiven) {
    const rows = [
      { label: 'LAN1 (private)', value: cidr(a.lan1) },
      { label: 'WAN1 (R1 to R2)', value: `${cidr(a.wan)}: R1 ${m.r1Wan}, R2 ${m.r2Wan}` },
      { label: 'LAN2', value: cidr(a.lan2) },
      { label: 'R1 in LAN1', value: m.r1Lan },
      { label: 'R2 in LAN2', value: m.r2Lan },
      { label: 'PC1 (MS), static', value: m.pc1 },
      { label: 'R1 Loopback0', value: `${a.r1Lo0}/32` },
    ];
    if (a.r1Lo100) rows.push({ label: 'R1 Loopback100', value: `${a.r1Lo100}/32` });
    rows.push({ label: 'R2 Loopback0', value: `${a.r2Lo0}/32` });
    if (dhcpClients(s)) rows.push({ label: 'PC2 and PC3', value: 'address from DHCP' });
    return rows;
  }
  const rows = [
    { label: 'LAN1', value: `private class C network, mask /${a.lan1.len}` },
    { label: 'WAN1 (R1 to R2)', value: `public point-to-point network, mask /${a.wan.len}` },
    { label: 'LAN2', value: `mask /${a.lan2.len}` },
    { label: 'Router address in each LAN', value: 'host number 1 (the first address)' },
    { label: 'PC1 (MS), static', value: `host number ${a.pc1Host} in LAN1` },
    { label: 'PC2 and PC3', value: 'address from DHCP' },
    { label: 'R1', value: a.r1Lo100 ? 'Loopback0 and Loopback100, each with a /32 address' : 'Loopback0 with a /32 address' },
    { label: 'R2', value: 'Loopback0 with a /32 address' },
  ];
  return rows;
}

/** Which part of the work each task of the sheet belongs to. */
const ITEM_PART: Record<string, PartId> = {
  '1': 'dhcp', '2': 'basics', '3': 'routing', '4': 'nat', '5': 'routing', '6': 'acl', '7': 'acl', '8': 'ipsec', '9': 'ipsec',
  '10': 'qos', '11': 'telnet', '12': 'snmp', '13': 'syslog',
};

export function sheetBrief(s: Spec): Brief {
  const items = sheetItems(s).filter((it) => isTask(s, ITEM_PART[it.no] ?? 'basics'));
  if (s.prebuilt.length) {
    return {
      intro: 'The network is already cabled and the first tasks of the case study are done: addresses, DHCP, NAT and the default routes work. Add the tasks below. They keep their numbers from the sheet. Console cables are in place: PC1 reaches R1, PC3 reaches R2. NetLab awards practice points, not official marks.',
      items, given: builtGiven(s),
    };
  }
  const free = s.addrGiven
    ? 'The address table gives every address. You may use any free ports.'
    : 'You choose the addresses yourself, inside the rules of the table. You may use any free ports.';
  const part = items.length < 12 ? ' This is the first half of the case study. The tasks keep their numbers from the sheet.' : '';
  const scoring = ' NetLab awards practice points, not official marks.';
  const examFacts = s.id === 'case-study-2026' ? ' The course test lasts about 180 minutes and is worth 18 points.' : '';
  const intro = s.style === 'exam'
    ? `Practice exam: 18 practice points, ${s.minutes} minutes. The devices are not connected and not configured. Cable them as the topology shows. Then configure everything so that each task below holds. You may use the command sheet. ${free} SW2 is a spare.${scoring}`
    : `Cable the devices as the topology shows. Then configure them so that each task below holds. The routers and the switch start empty. ${free} SW2 is a spare: you do not need it.${part}${examFacts}${scoring}`;
  return { intro, items, given: sheetGiven(s) };
}

/** One line per task of the case study, as a reminder inside a trouble ticket. */
export function sheetReminder(s: Spec): string[] {
  const out: string[] = [];
  for (const it of sheetItems(s)) {
    if (it.optional) continue;
    const subs = it.subItems ?? [];
    const list = subs.length && subs.every((x) => !x.endsWith('.')) ? ` ${subs.join(', ')}.` : subs.length ? ` ${subs.join(' ')}` : '';
    out.push(`Task ${it.no}: ${it.text}${list}`);
  }
  return out;
}

/** The address plan of a network that already exists (course labs and broken networks). */
export function builtGiven(s: Spec): { label: string; value: string }[] {
  const a = s.addr;
  const m = model(s);
  const dyn = dhcpClients(s);
  const rows = [
    { label: 'LAN1', value: `${cidr(a.lan1)}: R1 ${m.r1Lan}, PC1 ${m.pc1}${s.hasPc2 ? `, PC2 ${dyn ? 'by DHCP' : m.pc2}` : ''}` },
    { label: 'WAN1', value: `${cidr(a.wan)}: R1 ${m.r1Wan}, R2 ${m.r2Wan}` },
    { label: 'LAN2', value: `${cidr(a.lan2)}: R2 ${m.r2Lan}, PC3 ${dyn ? 'by DHCP' : m.pc3}` },
    { label: 'Loopbacks', value: `R1 Loopback0 ${a.r1Lo0}${a.r1Lo100 ? `, R1 Loopback100 ${a.r1Lo100}` : ''}, R2 Loopback0 ${a.r2Lo0}` },
  ];
  if (s.prebuilt.includes('console')) rows.push({ label: 'Console', value: 'PC1 is on the console of R1. PC3 is on the console of R2.' });
  return rows;
}

// ───────────────────────────── topology picture ─────────────────────────────
export function diagramFor(s: Spec): DiagramSpec {
  const a = s.addr;
  const m = model(s);
  const known = s.addrGiven || s.style === 'lab' || s.style === 'ticket';
  const dyn = dhcpClients(s);
  const pc1Note = known ? [`static ${m.pc1}`] : [`static, host .${a.pc1Host}`];
  const lo1 = known
    ? [`Lo0 ${a.r1Lo0}/32`, ...(a.r1Lo100 ? [`Lo100 ${a.r1Lo100}/32`] : [])]
    : ['Loopback0 /32', ...(a.r1Lo100 ? ['Loopback100 /32'] : [])];
  const nodes: DiagramSpec['nodes'] = [
    { id: 'PC1', label: 'PC1 (MS)', kind: 'pc', x: 100, y: s.hasPc2 ? 150 : 290, notes: pc1Note },
  ];
  if (s.hasPc2) nodes.push({ id: 'PC2', label: 'PC2', kind: 'pc', x: 100, y: 430, notes: [dyn ? 'DHCP' : known ? `static ${m.pc2}` : 'static'] });
  nodes.push(
    { id: 'SW1', label: 'SW1', kind: 'switch', x: 290, y: 290 },
    { id: 'R1', label: 'R1', kind: 'router', x: 470, y: 290, notes: lo1 },
    { id: 'R2', label: 'R2', kind: 'router', x: 700, y: 290, notes: [known ? `Lo0 ${a.r2Lo0}/32` : 'Loopback0 /32'] },
    { id: 'PC3', label: 'PC3', kind: 'pc', x: 885, y: 290, notes: [dyn ? 'DHCP' : known ? `static ${m.pc3}` : 'static'] },
  );
  const links: DiagramSpec['links'] = [{ a: 'PC1', b: 'SW1' }];
  if (s.hasPc2) links.push({ a: 'PC2', b: 'SW1' });
  links.push(
    { a: 'SW1', b: 'R1', label: '.1' },
    { a: 'R1', b: 'R2', label: known ? `WAN1 ${cidr(a.wan)}` : `WAN1 /${a.wan.len}` },
  );
  if (has(s, 'ipsec')) links.push({ a: 'R1', b: 'R2', label: 'Tunnel 1', dashed: true });
  links.push({ a: 'R2', b: 'PC3', label: '.1' });
  return {
    nodes, links,
    areas: [
      { label: known ? `LAN1  ${cidr(a.lan1)}` : `LAN1  /${a.lan1.len}  private`, x: 20, y: 50, w: 370, h: 500 },
      { label: known ? `LAN2  ${cidr(a.lan2)}` : `LAN2  /${a.lan2.len}`, x: 790, y: 140, w: 190, h: 320 },
    ],
  };
}

// ───────────────────────────── the bench ─────────────────────────────
/** Devices on the table, uncabled. x/y is the centre of each face; rows are far enough apart for the cables to hang. */
export function benchFor(s: Spec): BenchDeviceSeed[] {
  const serial = s.wan === 'serial';
  const out: BenchDeviceSeed[] = [
    { id: 'R1', model: 'isr4331', label: 'R1', x: 420, y: 140, serialModule: serial },
    { id: 'R2', model: 'isr4331', label: 'R2', x: 1110, y: 140, serialModule: serial },
    { id: 'SW1', model: 'c9300l', label: 'SW1', x: 420, y: 430 },
    { id: 'SW2', model: 'c9300l', label: 'SW2', x: 1110, y: 720 },
    { id: 'PC1', model: 'pc-windows', label: 'PC1', x: 230, y: 720 },
  ];
  if (s.hasPc2) out.push({ id: 'PC2', model: 'pc-windows', label: 'PC2', x: 530, y: 720 });
  out.push({ id: 'PC3', model: 'pc-macos', label: 'PC3', x: 1110, y: 430 });
  return out;
}

export { maskOf };
