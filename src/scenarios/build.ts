/**
 * The one generator: turns a Spec into a ScenarioInstance. Brief, bench, pre-built parts, requirements with
 * behavioural checks, guide steps, model solution and hardware notes all come from the same Spec and the same
 * part builders, so they cannot drift apart. Owned by the scenario agent.
 */
import type {
  Feature, GuideStep, JournalEntry, PcSetup, RequirementResult, RequirementView, ScenarioInstance, ScenarioSummary,
  SolutionCable, SolutionView, World,
} from '../engine/types.ts';
import { shortIfName } from '../engine/ip.ts';
import type { Action, ReqDef, StepDef } from './checks.ts';
import { evalReq, reqPasses } from './checks.ts';
import { makeEnv } from './env.ts';
import type { PartId, Spec } from './spec.ts';
import { PART_ORDER, has, isTask, model, renewCommand } from './spec.ts';
import type { Built, PartFactory } from './parts/common.ts';
import { basicsPart, cablingPart, consolePart, dataCables, pcSetups, pcsPart, routingPart, savePart } from './parts/base.ts';
import { dhcpPart } from './parts/dhcp.ts';
import { natPart } from './parts/nat.ts';
import { aclPart } from './parts/acl.ts';
import { ipsecPart } from './parts/ipsec.ts';
import { qosPart } from './parts/qos.ts';
import { snmpPart, syslogPart, telnetPart } from './parts/mgmt.ts';
import type { Brief } from './brief.ts';
import { benchFor, builtGiven, diagramFor, sheetBrief, sheetReminder } from './brief.ts';
import type { CableOp, Fault, FaultOps, Layer } from './faults.ts';
import { LAYER_ORDER, faultCatalogue } from './faults.ts';
import { hardwareNotesFor } from './hardwareNotes.ts';
import { orderIssues } from './order.ts';

const FACTORY: Record<PartId, PartFactory> = {
  cabling: cablingPart, console: consolePart, basics: basicsPart, pcs: pcsPart, routing: routingPart, dhcp: dhcpPart,
  nat: natPart, acl: aclPart, ipsec: ipsecPart, qos: qosPart, telnet: telnetPart, snmp: snmpPart, syslog: syslogPart, save: savePart,
};

/** Task numbers of the case-study sheet, and the order of the report. */
const SHEET_NO: Record<string, string> = {
  cabling: 'C', dhcp: '1', addressing: '2', reach: '3', pat: '4a', 'static-nat': '4b', routes: '5', 'acl-pc1': '6', 'acl-pc2': '7',
  ipsec: '8', qos: '10', telnet: '11', snmp: '12', syslog: '13', saved: 'S',
};
const SHEET_ORDER = Object.keys(SHEET_NO);
/** NetLab practice weights, not a teacher's mark scheme. Full case: 18 practice points. */
const PRACTICE_POINTS: Record<string, number> = {
  cabling: 1, dhcp: 2, addressing: 1, reach: 1, pat: 1, 'static-nat': 1, routes: 1,
  'acl-pc1': 1, 'acl-pc2': 1, ipsec: 2, qos: 3, telnet: 1, snmp: 1, syslog: 1, saved: 0,
};

const PART_TITLE: Record<PartId, string> = {
  cabling: 'Cabling', console: 'Console', basics: 'Names, addresses, interfaces', pcs: 'PCs', routing: 'Routing', dhcp: 'DHCP', nat: 'NAT',
  acl: 'Access lists', ipsec: 'IPsec', qos: 'QoS', telnet: 'Telnet', snmp: 'SNMP', syslog: 'Syslog', save: 'Save',
};

// ───────────────────────────── example text of a guide step ─────────────────────────────
const CABLE_WORD: Record<string, string> = { straight: 'Ethernet straight-through', crossover: 'Ethernet crossover', serial: 'serial', console: 'console (rollover)' };
function portWord(deviceId: string, port: string): string {
  const short = port === 'Console' ? 'CON' : port === 'Ethernet0' ? 'Ethernet' : shortIfName(port);
  return `${deviceId} ${short}`;
}
export function cableText(c: SolutionCable): string {
  const dce = c.kind === 'serial' ? `, DCE end on ${(c.dceEnd ?? 'a') === 'a' ? c.a.deviceId : c.b.deviceId}` : '';
  return `${portWord(c.a.deviceId, c.a.port)}  <->  ${portWord(c.b.deviceId, c.b.port)}   ${CABLE_WORD[c.kind]} cable${dce}`;
}
function pcText(pcId: string, p: PcSetup): string[] {
  const out: string[] = [];
  const sv = p.services ?? {};
  // A setup that only carries services does not touch the adapter: say nothing about the address then.
  if (p.mode === 'static' && p.address) out.push(`${pcId}: static address ${p.address}, mask ${p.mask ?? ''}, default gateway ${p.gateway ?? 'none'}`);
  else if (p.mode === 'dhcp' && Object.keys(sv).length === 0) out.push(`${pcId}: obtain the address automatically (DHCP)`);
  const on = Object.entries(sv).filter(([, v]) => v === true).map(([k]) => k);
  const off = Object.entries(sv).filter(([, v]) => v === false).map(([k]) => k);
  const word = (k: string): string => (k === 'syslog' ? 'syslog server' : k === 'http' ? 'web server (HTTP)' : k === 'ftp' ? 'FTP server' : 'Telnet server');
  if (on.length) out.push(`${pcId}: switch on the ${on.map(word).join(' and the ')}`);
  if (off.length) out.push(`${pcId}: switch off the ${off.map(word).join(' and the ')}`);
  return out;
}
/** The example of a step as text: IOS lines can be pasted as they are (lines that start with ! are comments). */
export function exampleText(script: Action[]): string {
  const out: string[] = [];
  for (const a of script) {
    switch (a.kind) {
      case 'cable': out.push(`Cable: ${cableText(a.cable)}`); break;
      case 'uncable': out.push(`Unplug the cable at ${portWord(a.ref.deviceId, a.ref.port)}`); break;
      case 'config': out.push(`! ----- ${a.deviceId}: in configuration mode (enable, configure terminal) -----`, ...a.lines, 'end'); break;
      case 'exec': out.push(`! ----- ${a.deviceId}: in privileged mode (prompt ends with #) -----`, ...a.lines.filter((l) => l !== '')); break;
      case 'pc': out.push(...pcText(a.pcId, a.setup)); break;
      case 'renew': out.push(`${a.pcId}: ${renewCommand(a.pcId)}`); break;
      case 'note': out.push(a.text); break;
    }
  }
  return out.join('\n');
}

// ───────────────────────────── PCs ─────────────────────────────
/** A PC setup that is complete on its own: address fields from the model plan. */
function fullPc(base: Record<string, PcSetup>, pcId: string): PcSetup {
  return { ...(base[pcId] ?? { mode: 'dhcp' as const }) };
}
/** PC setups of several parts: addresses always come from the model plan, later parts only add services. */
function mergePcs(base: Record<string, PcSetup>, parts: Built[]): Record<string, PcSetup> {
  const out: Record<string, PcSetup> = {};
  for (const part of parts) {
    for (const [pcId, setup] of Object.entries(part.pcs)) {
      const prev = out[pcId] ?? fullPc(base, pcId);
      const services = { ...(prev.services ?? {}), ...(setup.services ?? {}) };
      out[pcId] = Object.keys(services).length ? { ...prev, services } : { ...prev };
    }
  }
  return out;
}

// ───────────────────────────── configuration text ─────────────────────────────
function configText(parts: Built[], deviceId: string): string {
  const out: string[] = [];
  for (const part of parts) {
    const lines = part.config[deviceId];
    if (!lines || lines.length === 0) continue;
    out.push(`! ${PART_TITLE[part.id]}`, ...lines);
  }
  return out.length ? out.join('\n') + '\n' : '';
}
function configsOf(parts: Built[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of ['R1', 'R2']) {
    const text = configText(parts, id);
    if (text) out[id] = text;
  }
  return out;
}

function applyCableOps(cables: SolutionCable[], ops: CableOp[] | undefined): SolutionCable[] {
  let out = cables.map((c) => ({ ...c }));
  for (const op of ops ?? []) {
    if ('remove' in op) {
      out = out.filter((c) => !((c.a.deviceId === op.remove.deviceId && c.a.port === op.remove.port) || (c.b.deviceId === op.remove.deviceId && c.b.port === op.remove.port)));
    } else out.push({ ...op.add });
  }
  return out;
}
function opsActions(ops: FaultOps): Action[] {
  const out: Action[] = [];
  for (const op of ops.cables ?? []) out.push('remove' in op ? { kind: 'uncable', ref: op.remove } : { kind: 'cable', cable: op.add });
  for (const [dev, lines] of Object.entries(ops.configs ?? {})) out.push({ kind: 'config', deviceId: dev, lines });
  for (const [pc, setup] of Object.entries(ops.pcs ?? {})) out.push({ kind: 'pc', pcId: pc, setup });
  return out;
}

// ───────────────────────────── troubleshooting guide (broken networks) ─────────────────────────────
const LAYER_INFO: Record<Layer, { title: string; feature: Feature; goal: string; why: string; hint: string; shows: string[]; allows: Feature[] }> = {
  physical: {
    title: 'Check the links', feature: 'cabling',
    goal: 'Make sure every link is up: look at the port lights and run show ip interface brief on both routers.',
    why: 'Start at the bottom. One dead link explains many symptoms at once.',
    hint: '"administratively down" means the interface is shut down. "down/down" points to the cable, or to the far end of it.',
    shows: ['show ip interface brief', 'show interfaces <name>', 'show controllers serial <slot/subslot/port>'],
    allows: ['cabling', 'interface', 'console', 'pc'],
  },
  addressing: {
    title: 'Check addresses and routes', feature: 'routing',
    goal: 'Compare the addresses, the masks and the gateways of the PCs with the address plan. Check that each router has its default route.',
    why: 'A wrong mask or a missing route breaks only some destinations. That makes it hard to spot from a single ping.',
    hint: 'Ping one hop at a time: own gateway, far WAN address, far PC. The first ping that fails shows the place.',
    shows: ['show ip interface brief', 'show running-config interface <name>', 'show ip route', 'PC1/PC2: ipconfig /all; PC3 (Mac): ifconfig en0 and ipconfig getoption en0 router'],
    allows: ['interface', 'routing', 'pc', 'console', 'cabling'],
  },
  dhcp: {
    title: 'Check DHCP', feature: 'dhcp',
    goal: 'Check which addresses PC2 and PC3 hold, the pools and the exclusion on R1, and the relay on R2. Then renew the leases.',
    why: 'A PC without a lease, or with a wrong one, fails every other test. So DHCP comes before NAT and the access lists.',
    hint: 'The relay belongs on the interface that hears the request of the PC. The pool decides the mask and the default gateway of the PC.',
    shows: ['show ip dhcp binding', 'show ip dhcp pool', 'show running-config | section dhcp', 'show running-config interface <R2 LAN interface>', 'PC2: ipconfig /renew; PC3 (Mac): sudo ipconfig set en0 DHCP'],
    allows: ['dhcp', 'interface', 'pc', 'console'],
  },
  nat: {
    title: 'Check NAT', feature: 'nat',
    goal: 'Ping from PC1 and PC2 to the WAN address of R2, then read the translation table on R1. Check which interface is inside and which is outside.',
    why: 'When NAT is wrong, R2 sees other source addresses than its access lists expect. Then Telnet, SNMP and syslog fail too.',
    hint: 'show ip nat statistics lists the inside and outside interfaces and the access list of the dynamic rule.',
    shows: ['show ip nat translations', 'show ip nat statistics', 'show access-lists 1', 'show running-config | include ip nat'],
    allows: ['nat', 'acl', 'interface', 'console', 'pc'],
  },
  acl: {
    title: 'Check the access lists', feature: 'acl',
    goal: 'Test what PC1 and PC2 may and may not reach, and read the match counters of the access list. Check on which interface and in which direction the list is applied.',
    why: 'An access list in the wrong place does nothing. A list without its last permit line blocks everything.',
    hint: 'Send one test packet, then look which line of show access-lists counted it.',
    shows: ['show access-lists', 'show ip interface <name>', 'show running-config | include access-group'],
    allows: ['acl', 'interface', 'console', 'pc'],
  },
  ipsec: {
    title: 'Check the IPsec tunnel', feature: 'ipsec',
    goal: 'Ping across the WAN link, then look at the security associations on both routers. Compare policy, key, peer, transform set and crypto access list of both sides.',
    why: 'Traffic that must be encrypted is dropped while the tunnel is down. So a tunnel fault looks like a dead link for some protocols only.',
    hint: 'No ISAKMP SA: look at policy and key. ISAKMP SA but no IPsec SA: look at transform set, crypto access list and where the crypto map is applied.',
    shows: ['show crypto isakmp sa', 'show crypto ipsec sa', 'show crypto isakmp policy', 'show crypto map', 'show running-config | include isakmp key'],
    allows: ['ipsec', 'acl', 'interface', 'console', 'pc'],
  },
  qos: {
    title: 'Check the link speed and QoS', feature: 'qos',
    goal: 'Check the clock rate and the bandwidth of the WAN interfaces. Read the policy counters on both routers while you ping.',
    why: 'QoS faults do not stop traffic. They only show in the numbers, so you have to look for them.',
    hint: 'The shaper percentage is calculated from the interface bandwidth. A policy only works in the output direction.',
    shows: ['show policy-map interface <WAN interface>', 'show policy-map', 'show interfaces <WAN interface>', 'show controllers serial <slot/subslot/port>'],
    allows: ['qos', 'interface', 'acl', 'ipsec', 'console', 'pc'],
  },
  mgmt: {
    title: 'Check Telnet, SNMP and syslog', feature: 'vty',
    goal: 'From PC1 try Telnet and SNMP to both routers and watch its syslog window. Then read the vty lines, the communities and the logging settings.',
    why: 'These services depend on everything below them. Test them last.',
    hint: 'Ask yourself which source address the router sees. Behind NAT it is not the address the PC has.',
    shows: ['show running-config | section line vty', 'show access-lists', 'show snmp community', 'show logging'],
    allows: ['vty', 'snmp', 'syslog', 'acl', 'interface', 'pc', 'console'],
  },
};

function troubleSteps(s: Spec, faults: Fault[], reqs: ReqDef[], save: Built | undefined): StepDef[] {
  const byId = new Map(reqs.map((r) => [r.id, r]));
  const dhcpPcs = has(s, 'dhcp') ? [...(s.hasPc2 ? ['PC2'] : []), 'PC3'] : [];
  const steps: StepDef[] = [];
  for (const layer of LAYER_ORDER) {
    const info = LAYER_INFO[layer];
    const mine = faults.filter((f) => f.layer === layer);
    const script: Action[] = [{ kind: 'note', text: `Look first:\n${info.shows.map((x) => `  ${x}`).join('\n')}` }];
    if (mine.length === 0) script.push({ kind: 'note', text: 'In this lab nothing is wrong in this area.' });
    for (const f of mine) {
      script.push({ kind: 'note', text: `Cause: ${f.title}` });
      script.push(...opsActions(f.fix));
    }
    if (mine.length && dhcpPcs.length && ['physical', 'addressing', 'dhcp', 'acl'].includes(layer)) {
      script.push({ kind: 'note', text: `Then renew DHCP: ${dhcpPcs.map((id) => `${id}: ${renewCommand(id)}`).join('; ')}.` });
    }
    steps.push({
      id: `t-${layer}`, title: info.title, feature: info.feature, devices: ['R1', 'R2', 'SW1', 'PC1', ...(s.hasPc2 ? ['PC2'] : []), 'PC3'],
      goal: info.goal, why: info.why, hint: info.hint, allows: info.allows,
      script,
      done: (env) => mine.every((f) => !f.present(env) || f.mustFail.every((id) => reqPasses(env, byId.get(id)))),
    });
  }
  if (save) {
    const st = save.steps[0];
    steps.push({
      ...st, id: 't-save', title: 'Test again and save',
      goal: 'Renew the DHCP leases and repeat the tests from the tickets. When everything works, save the configuration on both routers.',
      devices: ['R1', 'R2', ...dhcpPcs], allows: ['system', 'console', 'pc'],
      // every fix is in place now, so the leases can be renewed for good
      script: [...dhcpPcs.map((pc) => ({ kind: 'renew' as const, pcId: pc })), ...st.script],
    });
  }
  return steps;
}

// ───────────────────────────── the generator ─────────────────────────────
const scripts = new WeakMap<ScenarioInstance, { stepId: string; script: Action[] }[]>();
const specs = new WeakMap<ScenarioInstance, Spec>();
/** What each guide step's example does, in a form that tests can replay. */
export function stepScripts(inst: ScenarioInstance): { stepId: string; script: Action[] }[] { return scripts.get(inst) ?? []; }
export function specOf(inst: ScenarioInstance): Spec | undefined { return specs.get(inst); }
/** The planted faults of a broken-network instance. */
export function faultsOf(inst: ScenarioInstance): Fault[] {
  const s = specs.get(inst);
  if (!s || !s.faults) return [];
  const all = faultCatalogue(s);
  return s.faults.map((id) => all.find((f) => f.id === id)).filter((f): f is Fault => !!f);
}

export function summaryOf(s: Spec): ScenarioSummary {
  const feat: Feature[] = [];
  const addF = (f: Feature): void => { if (!feat.includes(f)) feat.push(f); };
  const map: Record<PartId, Feature[]> = {
    cabling: ['cabling'], console: ['console'], basics: ['system', 'interface'], pcs: ['pc'], routing: ['routing'], dhcp: ['dhcp'], nat: ['nat'],
    acl: ['acl'], ipsec: ['ipsec'], qos: ['qos'], telnet: ['vty'], snmp: ['snmp'], syslog: ['syslog'], save: [],
  };
  for (const p of PART_ORDER) if (s.style === 'ticket' ? s.parts.includes(p) : isTask(s, p)) map[p].forEach(addF);
  if (s.style === 'ticket') addF('verify');
  return { id: s.id, title: s.title, family: s.family, features: feat, minutes: s.minutes, level: s.level, blurb: s.blurb, seedable: s.seedable };
}

export function buildInstance(spec: Spec): ScenarioInstance {
  const s = spec;
  const all: Built[] = PART_ORDER.filter((p) => has(s, p)).map((p) => FACTORY[p](s));
  const tasks = all.filter((b) => isTask(s, b.id));
  const prebuilt = all.filter((b) => s.prebuilt.includes(b.id));
  const graded = all.filter((b) => s.parts.includes(b.id));
  const basePcs = pcSetups(s);
  const m = model(s);

  // requirements
  const sheet = s.style !== 'lab';
  let reqs: ReqDef[] = graded.flatMap((b) => b.requirements);
  if (sheet) reqs = [...reqs].sort((x, y) => SHEET_ORDER.indexOf(x.id) - SHEET_ORDER.indexOf(y.id))
    .map((r) => ({ ...r, points: PRACTICE_POINTS[r.id] ?? r.points }));
  const noOf = (r: ReqDef, i: number): string => (sheet ? SHEET_NO[r.id] ?? String(i + 1) : String(i + 1));
  const requirements: RequirementView[] = reqs.map((r, i) => ({ id: r.id, no: noOf(r, i), title: r.title, feature: r.feature, points: r.points }));

  // faults (broken networks)
  const catalogue = s.faults && s.faults.length ? faultCatalogue(s) : [];
  const faults = (s.faults ?? []).map((id) => catalogue.find((f) => f.id === id)).filter((f): f is Fault => !!f);

  // model cabling, configuration and PC setups
  const fullCables = all.flatMap((b) => b.cables);
  const fullPcs = mergePcs(basePcs, all);
  for (const id of Object.keys(basePcs)) fullPcs[id] ??= fullPc(basePcs, id);

  // initial state
  let initial: ScenarioInstance['initial'];
  if (prebuilt.length) {
    const pcs = mergePcs(basePcs, prebuilt);
    if (s.prebuilt.includes('pcs')) for (const id of Object.keys(basePcs)) pcs[id] ??= fullPc(basePcs, id);
    for (const [pcId, services] of Object.entries(s.servers ?? {})) {
      if (pcs[pcId]) pcs[pcId] = { ...pcs[pcId], services: { ...(pcs[pcId].services ?? {}), ...services } };
    }
    initial = { cables: prebuilt.flatMap((b) => b.cables), configs: configsOf(prebuilt), pcs };
    // A wrong cable type is only a fault while the bench is strict about cable types.
    if (faults.some((f) => f.id.startsWith('cable-type'))) initial.settings = { strictCables: true };
    for (const f of faults) {
      initial.cables = applyCableOps(initial.cables ?? [], f.break.cables);
      for (const [dev, lines] of Object.entries(f.break.configs ?? {})) {
        initial.configs![dev] = `${initial.configs![dev] ?? ''}${lines.join('\n')}\n`;
      }
      for (const [pc, setup] of Object.entries(f.break.pcs ?? {})) {
        const prev = initial.pcs![pc] ?? fullPc(basePcs, pc);
        const services = { ...(prev.services ?? {}), ...(setup.services ?? {}) };
        initial.pcs![pc] = Object.keys(services).length ? { ...prev, ...setup, services } : { ...prev, ...setup };
      }
    }
  }

  // guide
  const saveBuilt = all.find((b) => b.id === 'save');
  const stepDefs: StepDef[] = s.style === 'ticket' ? troubleSteps(s, faults, reqs, saveBuilt) : tasks.flatMap((b) => b.steps);
  // Every lab ends with saving, also where saving is not graded: it is the habit the exam needs.
  if (s.style === 'lab' && !saveBuilt) stepDefs.push({ ...savePart(s).steps[0], goal: 'Save the configuration on both routers.' });
  // The save step only counts once the work before it is done (a pre-built network starts out saved).
  const last = stepDefs[stepDefs.length - 1];
  if (last && (last.id === 'save' || last.id === 't-save')) {
    const before = stepDefs.slice(0, -1);
    const saved = last.done;
    stepDefs[stepDefs.length - 1] = { ...last, done: (env) => before.every((st) => st.done(env)) && saved(env) };
  }
  const guide: GuideStep[] = stepDefs.map((st, i) => ({
    id: st.id, no: i + 1, title: st.title, feature: st.feature, devices: st.devices, goal: st.goal, why: st.why, hint: st.hint,
    example: exampleText(st.script), allows: st.allows,
  }));

  // solution
  let solution: SolutionView;
  if (s.style === 'ticket') {
    const configs: Record<string, string> = {};
    for (const f of faults) {
      for (const [dev, lines] of Object.entries(f.fix.configs ?? {})) configs[dev] = `${configs[dev] ?? ''}! Fix: ${f.fixText}\n${lines.join('\n')}\n`;
    }
    const pcs: Record<string, PcSetup> = {};
    for (const id of Object.keys(fullPcs)) pcs[id] = { ...fullPcs[id] };
    solution = {
      cables: fullCables, configs, pcs,
      notes: [
        ...faults.map((f, i) => `Fault ${i + 1}: ${f.title} Fix: ${f.fixText}`),
        'After the fixes, renew the DHCP leases (PC2: ipconfig /renew; PC3 (Mac): sudo ipconfig set en0 DHCP).',
        'Save both routers: copy running-config startup-config.',
        'The cable list shows the correct cabling of the whole network.',
      ],
    };
  } else {
    const notes: string[] = [];
    if (isTask(s, 'ipsec')) {
      notes.push('IKE values: this solution uses encryption aes, hash sha256 and group 14, because some IOS XE releases refuse older values. The teacher\'s sheet shows older values (hash sha, group 2). Both routers must use the same values.');
    }
    if (isTask(s, 'qos') && has(s, 'ipsec')) {
      notes.push('The course profile classifies the inner header for QoS automatically, as assumed by the teacher’s sheet. On an ESP-only classifier, enable qos pre-classify in the active crypto-map entry to classify the original packet.');
    }
    if (isTask(s, 'acl') && has(s, 'dhcp')) {
      notes.push(`The access lists use the addresses the DHCP server hands out first: PC2 ${m.pc2}, PC3 ${m.pc3}. Use the addresses currently leased: ipconfig on PC2, ifconfig en0 on PC3.`);
    } else if (has(s, 'dhcp') && (isTask(s, 'snmp'))) {
      notes.push(`The SNMP access list uses the address PC3 gets from DHCP (${m.pc3}). Check the real address with ifconfig en0 on PC3.`);
    }
    if (!s.addrGiven && isTask(s, 'basics')) notes.push('The addresses are one valid choice. Other addresses that follow the rules of the sheet are graded as correct too.');
    if (isTask(s, 'cabling')) notes.push('Any free ports are fine. Grading finds the roles from the cabling.');
    if (isTask(s, 'console')) notes.push('The console cables are only needed for typing. They are not graded.');
    if (isTask(s, 'save')) notes.push('Finish on each router with copy running-config startup-config.');
    if (sheet) notes.push('Practice scoring only: NetLab weights are not an official marking scheme. Task 9 is crossed out and ungraded.');
    if (prebuilt.length) notes.push('Only the lines for this lab are listed. The rest of the network was already configured.');
    const pcs = mergePcs(basePcs, tasks);
    if (isTask(s, 'pcs')) for (const id of Object.keys(basePcs)) pcs[id] ??= fullPc(basePcs, id);
    solution = { cables: tasks.flatMap((b) => b.cables), configs: configsOf(tasks), pcs, notes };
  }

  // brief
  let brief: Brief;
  if (s.style === 'ticket') {
    brief = {
      intro: 'This network was built for the case study and it worked. Now the help desk has tickets. Find the cause of each problem and fix it. Do not rebuild the network: change only what is wrong. Tip: first repeat the test from the ticket, so you see the symptom yourself.',
      items: [
        ...faults.map((f, i) => ({ no: `T${i + 1}`, text: f.ticket, feature: f.ticketFeature })),
        { no: 'S', text: 'When everything works again, save the configuration on both routers.', feature: 'system' as Feature },
        { no: 'i', text: 'For reference: the rules this network was built for.', feature: 'verify' as Feature, optional: true, subItems: sheetReminder(s) },
      ],
      given: builtGiven(s),
    };
  } else if (s.style === 'lab' && s.lab) {
    brief = {
      intro: s.lab.intro,
      items: [...s.lab.items, ...(saveBuilt ? [] : [{ text: 'Save the configuration on both routers.', feature: 'system' as Feature }])]
        .map((it, i) => ({ no: String(i + 1), text: it.text, feature: it.feature, ...('subItems' in it && it.subItems ? { subItems: it.subItems } : {}) })),
      given: prebuilt.length || s.addrGiven ? builtGiven(s) : undefined,
    };
  } else {
    brief = sheetBrief(s);
  }

  const initialConfigs = initial?.configs;
  // Results depend only on devices, cables and settings (not on the clock), so the last result is reused while nothing changed.
  const stateKey = (world: World): string => JSON.stringify([world.devices, world.cables, world.settings, world.order]);
  let lastGrade: { key: string; reqs: RequirementResult[] } | undefined;
  let lastProgress: { key: string; done: Record<string, boolean> } | undefined;
  const inst: ScenarioInstance = {
    summary: summaryOf(s),
    seed: s.seed,
    brief,
    diagram: diagramFor(s),
    bench: benchFor(s),
    ...(initial ? { initial } : {}),
    requirements,
    guide,
    solution,
    hardwareNotes: hardwareNotesFor(s),
    grade(world: World, journal: JournalEntry[]) {
      const key = stateKey(world);
      if (!lastGrade || lastGrade.key !== key) {
        const env = makeEnv(world, s);
        lastGrade = { key, reqs: reqs.map((r, i) => evalReq(env, r, noOf(r, i))) };
      }
      return {
        requirements: structuredClone(lastGrade.reqs),
        orderIssues: orderIssues(world, journal ?? [], { initialConfigs, cablingIsTask: isTask(s, 'cabling'), cablesNeeded: dataCables(s).length }),
      };
    },
    guideProgress(world: World, _journal: JournalEntry[]) {
      const key = stateKey(world);
      if (!lastProgress || lastProgress.key !== key) {
        const env = makeEnv(world, s);
        const done: Record<string, boolean> = {};
        for (const st of stepDefs) {
          try { done[st.id] = st.done(env) === true; } catch { done[st.id] = false; }
        }
        lastProgress = { key, done };
      }
      return { ...lastProgress.done };
    },
  };
  scripts.set(inst, stepDefs.map((st) => ({ stepId: st.id, script: st.script })));
  specs.set(inst, s);
  return inst;
}
