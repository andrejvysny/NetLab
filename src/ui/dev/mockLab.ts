/**
 * MockLab — an in-memory LabApi with fixture data so every screen of the UI can be exercised before the
 * real engine (src/engine/lab.ts) exists. It is deliberately shallow: a tiny fake CLI, canned packet traces,
 * a simple QoS calculator and a fixture grade report. Swap it out in src/ui/dev/createLab.ts.
 * Owned by the app-shell agent.
 */
import type {
  ActionResult, ApplyReport, CommandSheetSection, ExecView, GuideBlock, LabApi, LabState, OpenSessionResult,
  PcExecView, PortStatus, QosLoadResult, QosLoadSpec, SavedLabSummary, ScenarioView, SessionView, SnmpReply,
  SnmpRequest, UiSettings,
} from '../../engine/labapi.ts';
import type {
  BenchDeviceSeed, BriefItem, CableKind, DiagramSpec, Feature, FlowResult, FlowSpec, GradeReport, GuideStep,
  IosDevice, JournalEntry, LabMode, PcDevice, PcServices, PortRef, RequirementView, ScenarioSummary, SolutionView,
  TraceStep, World,
} from '../../engine/types.ts';
import { addDevice, createWorld } from '../../engine/world.ts';
import {
  CABLING_BRIEF, CABLING_DIAGRAM, CABLING_GUIDE, CASE_BRIEF, CASE_DIAGRAM, CASE_GIVEN, CASE_GUIDE, CASE_INTRO,
  CASE_REQUIREMENTS, COMMAND_SHEET, JOURNAL, SCENARIOS, SOLUTION, STUDENT_R1, makeReport,
} from './fixtures.ts';

export interface MockOptions {
  /** false simulates a sandbox without localStorage. */
  storage?: boolean;
  /** Open the first saved lab right away (handy for UI testing). */
  resume?: boolean;
  /** Start this scenario right away in this mode. */
  start?: { id: string; mode: LabMode };
}

interface Content { brief: ScenarioView['brief']; diagram: DiagramSpec; requirements: RequirementView[]; guide: GuideStep[] }
interface CliState { mode: string; iface?: string; history: string[] }
interface Snapshot {
  scenarioId: string; mode: LabMode; seed: number; startedAt: number; timerMinutes: number | null; finished: boolean;
  hintsUsed: number; guideIndex: number; world: World; journal: JournalEntry[]; report: GradeReport | null; inProgress: boolean;
}

const DEFAULT_SETTINGS: UiSettings = { strictCables: true, qosClassifiesInnerHeader: true, fontScale: 1, font: 'lexend', terminalFontPx: 14, terminalPaging: true, reduceMotion: false };

function probeStorage(): boolean {
  try {
    const k = '__kss_probe__';
    window.localStorage.setItem(k, '1');
    window.localStorage.removeItem(k);
    return true;
  } catch {
    return false;
  }
}

function contentFor(s: ScenarioSummary): Content {
  if (s.id === 'lab-cabling') {
    return {
      brief: { intro: 'Cable the bench as in the picture. Then open a terminal on R1 through the console cable.', items: CABLING_BRIEF },
      diagram: CABLING_DIAGRAM,
      requirements: [CASE_REQUIREMENTS[0], { id: 'r-console', no: '4', title: 'A terminal is open on R1', feature: 'console', points: 1 }],
      guide: CABLING_GUIDE,
    };
  }
  const feats = new Set<Feature>(s.features);
  let items: BriefItem[] = CASE_BRIEF.filter((b) => feats.has(b.feature));
  if (items.length < 2) items = CASE_BRIEF;
  let reqs = CASE_REQUIREMENTS.filter((r) => feats.has(r.feature));
  if (reqs.length < 2) reqs = CASE_REQUIREMENTS;
  const guide = CASE_GUIDE.filter((g) => feats.has(g.feature) || g.feature === 'verify' || (g.feature === 'pc' && feats.has('dhcp')))
    .map((g, i) => ({ ...g, no: i + 1 }));
  return { brief: { intro: CASE_INTRO, items, given: CASE_GIVEN }, diagram: CASE_DIAGRAM, requirements: reqs, guide: guide.length ? guide : CASE_GUIDE };
}

function benchFor(s: ScenarioSummary): BenchDeviceSeed[] {
  const base: BenchDeviceSeed[] = [
    { id: 'R1', model: 'isr4331', label: 'R1', x: 420, y: 120 },
    { id: 'R2', model: 'isr4331', label: 'R2', x: 720, y: 120 },
    { id: 'SW1', model: 'c9300l', label: 'SW1', x: 180, y: 260 },
    { id: 'PC1', model: 'pc-windows', label: 'PC1', x: 80, y: 460 },
    { id: 'PC2', model: 'pc-windows', label: 'PC2', x: 300, y: 460 },
    { id: 'PC3', model: 'pc-windows', label: 'PC3', x: 760, y: 420 },
  ];
  if (s.id === 'lab-cabling') return base;
  return [...base, { id: 'SW2', model: 'c9300l', label: 'SW2', x: 520, y: 330 }, { id: 'PC4', model: 'pc-macos', label: 'MacBook', x: 540, y: 500 }];
}

function freshWorld(s: ScenarioSummary, strict: boolean): World {
  const w = createWorld({ strictCables: strict });
  for (const seed of benchFor(s)) addDevice(w, seed);
  return w;
}

function ios(w: World, id: string): IosDevice | undefined {
  const d = w.devices[id];
  return d && d.kind !== 'pc' ? (d as IosDevice) : undefined;
}
function pc(w: World, id: string): PcDevice | undefined {
  const d = w.devices[id];
  return d && d.kind === 'pc' ? (d as PcDevice) : undefined;
}

/** World of a lab that is about two thirds done (used for resumed labs). */
function inProgressWorld(s: ScenarioSummary, strict: boolean): World {
  const w = freshWorld(s, strict);
  const cable = (kind: CableKind, a: PortRef, b: PortRef, dceEnd?: 'a' | 'b') => { w.cables.push({ id: `c${w.nextId++}`, kind, a, b, dceEnd }); };
  cable('straight', { deviceId: 'PC1', port: 'Ethernet0' }, { deviceId: 'SW1', port: 'GigabitEthernet1/0/1' });
  cable('straight', { deviceId: 'PC2', port: 'Ethernet0' }, { deviceId: 'SW1', port: 'GigabitEthernet1/0/2' });
  cable('straight', { deviceId: 'SW1', port: 'GigabitEthernet1/0/24' }, { deviceId: 'R1', port: 'GigabitEthernet0/0/0' });
  cable('serial', { deviceId: 'R1', port: 'Serial0/1/0' }, { deviceId: 'R2', port: 'Serial0/1/0' }, 'a');
  cable('crossover', { deviceId: 'R2', port: 'GigabitEthernet0/0/0' }, { deviceId: 'PC3', port: 'Ethernet0' });
  cable('console', { deviceId: 'PC1', port: 'COM1' }, { deviceId: 'R1', port: 'Console' });
  const r1 = ios(w, 'R1');
  const r2 = ios(w, 'R2');
  if (r1) {
    r1.config.hostname = 'R1';
    r1.runtime.setupDialogDone = true;
    r1.config.interfaces['GigabitEthernet0/0/0'] = { name: 'GigabitEthernet0/0/0', ip: { address: '192.168.100.1', mask: '255.255.255.0' }, shutdown: false, aclIn: '110', natRole: 'inside' };
    r1.config.interfaces['Serial0/1/0'] = { name: 'Serial0/1/0', ip: { address: '60.50.30.1', mask: '255.255.255.252' }, shutdown: false, bandwidthKbps: 128, clockRate: 128000, natRole: 'outside', cryptoMap: 'CM', servicePolicyOut: 'output_SE' };
    r1.config.interfaces['Loopback0'] = { name: 'Loopback0', ip: { address: '1.1.1.1', mask: '255.255.255.255' }, shutdown: false };
    r1.config.interfaces['Loopback100'] = { name: 'Loopback100', ip: { address: '60.50.50.100', mask: '255.255.255.255' }, shutdown: false };
    r1.config.staticRoutes = [{ prefix: '0.0.0.0', mask: '0.0.0.0', exitInterface: 'Serial0/1/0', nextHop: '60.50.30.2' }];
  }
  if (r2) {
    r2.config.hostname = 'R2';
    r2.runtime.setupDialogDone = true;
    r2.config.interfaces['GigabitEthernet0/0/0'] = { name: 'GigabitEthernet0/0/0', ip: { address: '60.50.40.1', mask: '255.255.255.192' }, shutdown: false };
    r2.config.interfaces['Serial0/1/0'] = { name: 'Serial0/1/0', ip: { address: '60.50.30.2', mask: '255.255.255.252' }, shutdown: false, bandwidthKbps: 128, servicePolicyOut: 'output_SE' };
    r2.config.interfaces['Loopback0'] = { name: 'Loopback0', ip: { address: '2.2.2.2', mask: '255.255.255.255' }, shutdown: false };
    r2.config.staticRoutes = [{ prefix: '0.0.0.0', mask: '0.0.0.0', exitInterface: 'Serial0/1/0', nextHop: '60.50.30.1' }];
  }
  const p1 = pc(w, 'PC1');
  if (p1) { p1.nic = { ...p1.nic, mode: 'static', address: '192.168.100.10', mask: '255.255.255.0', gateway: '192.168.100.1' }; p1.services.syslog = true; }
  const p2 = pc(w, 'PC2');
  if (p2) p2.nic = { ...p2.nic, mode: 'dhcp', address: '192.168.100.101', mask: '255.255.255.0', gateway: '192.168.100.1', dhcpServer: '192.168.100.1' };
  const p3 = pc(w, 'PC3');
  if (p3) p3.services = { http: true, ftp: true, telnet: false, syslog: false };
  w.tick = 25;
  return w;
}

const IF_ALIASES: [RegExp, string][] = [
  [/^(g|gi|gig|giga|gigabitethernet)\s*(\d+(?:\/\d+)*)$/i, 'GigabitEthernet'],
  [/^(s|se|ser|serial)\s*(\d+(?:\/\d+)*)$/i, 'Serial'],
  [/^(lo|loop|loopback)\s*(\d+)$/i, 'Loopback'],
];
function normIf(s: string): string | null {
  for (const [re, name] of IF_ALIASES) {
    const m = re.exec(s.trim());
    if (m) return name + m[2];
  }
  return null;
}

function featureOf(line: string, mode: string): Feature {
  const l = line.trim().toLowerCase().replace(/^no\s+/, '');
  if (/^(show|ping|traceroute|trace|debug|undebug)\b/.test(l)) return 'verify';
  if (/^(hostname|enable|banner|ip domain|service|username|alias|copy|write)/.test(l)) return 'system';
  if (/^ip route|^router\b/.test(l) || mode === 'config-router') return 'routing';
  if (/^ip dhcp|^ip helper|^default-router/.test(l) || mode === 'dhcp-config') return 'dhcp';
  if (/^ip nat/.test(l)) return 'nat';
  if (/^(access-list|ip access-list|ip access-group|permit|deny)/.test(l)) return 'acl';
  if (/^crypto/.test(l) || mode.startsWith('crypto')) return 'ipsec';
  if (/^(class-map|policy-map|service-policy|priority|shape|fair-queue|class\b)/.test(l) || mode.startsWith('config-pmap') || mode === 'config-cmap') return 'qos';
  if (/^(line|password|login|access-class|transport)/.test(l)) return 'vty';
  if (/^snmp-server/.test(l)) return 'snmp';
  if (/^logging/.test(l)) return 'syslog';
  if (/^(interface|ip address|shutdown|clock|bandwidth|description|encapsulation|duplex|speed)/.test(l)) return 'interface';
  return 'system';
}

function promptFor(host: string, mode: string): string {
  if (mode === 'exec') return `${host}>`;
  if (mode === 'priv') return `${host}#`;
  return `${host}(${mode})#`;
}

export class MockLab implements LabApi {
  private listeners = new Set<() => void>();
  private state: LabState;
  private settings: UiSettings = { ...DEFAULT_SETTINGS };
  private storageOk: boolean;
  private saved: { summary: SavedLabSummary; snap: Snapshot }[] = [];
  private cur: (Snapshot & { summary: ScenarioSummary; content: Content }) | null = null;
  private sessions: SessionView[] = [];
  private cli = new Map<string, CliState>();
  private nextSession = 1;
  private savedSeq = 3;

  constructor(opts: MockOptions = {}) {
    this.storageOk = opts.storage === false ? false : probeStorage();
    const now = Date.now();
    const s1 = SCENARIOS.find((s) => s.id === 'case-2026')!;
    const s2 = SCENARIOS.find((s) => s.id === 'lab-ipsec')!;
    if (this.storageOk) {
      const c1 = contentFor(s1);
      this.saved.push({
        summary: { id: 'save-1', title: s1.title, mode: 'free', savedAt: now - 26 * 3600_000, percent: 67 },
        snap: { scenarioId: s1.id, mode: 'free', seed: 0, startedAt: now - 2 * 3600_000, timerMinutes: null, finished: false, hintsUsed: 2, guideIndex: 3,
          world: inProgressWorld(s1, true), journal: JOURNAL, report: makeReport(s1.id, 'free', 25, c1.requirements), inProgress: true },
      });
      this.saved.push({
        summary: { id: 'save-2', title: s2.title, mode: 'guided', savedAt: now - 3 * 24 * 3600_000 },
        snap: { scenarioId: s2.id, mode: 'guided', seed: 0, startedAt: now - 40 * 60_000, timerMinutes: null, finished: false, hintsUsed: 0, guideIndex: 1,
          world: inProgressWorld(s2, true), journal: JOURNAL.slice(0, 11), report: null, inProgress: true },
      });
    }
    this.state = this.build(0);
    if (opts.resume && this.saved[0]) this.loadSaved(this.saved[0].summary.id);
    else if (opts.start) this.startScenario(opts.start.id, opts.start.mode, { timerMinutes: opts.start.mode === 'exam' ? 180 : null });
  }

  /** Mock only, for UI testing in sandboxes: pretend storage works and add two saved labs. */
  debugSeedSaved(): void {
    this.storageOk = true;
    if (this.saved.length === 0) {
      const now = Date.now();
      const s1 = SCENARIOS.find((s) => s.id === 'case-2026')!;
      const c1 = contentFor(s1);
      this.saved.push({
        summary: { id: 'save-1', title: s1.title, mode: 'free', savedAt: now - 26 * 3600_000, percent: 67 },
        snap: { scenarioId: s1.id, mode: 'free', seed: 0, startedAt: now - 2 * 3600_000, timerMinutes: null, finished: false, hintsUsed: 2, guideIndex: 3,
          world: inProgressWorld(s1, true), journal: JOURNAL, report: makeReport(s1.id, 'free', 25, c1.requirements), inProgress: true },
      });
    }
    this.emit();
  }

  /** Mock only: corrupt the open scenario so the UI throws (to test the error boundary). */
  debugBreak(): void {
    this.broken = true;
    this.emit();
  }
  private broken = false;

  // ───────── state ─────────
  getState = (): LabState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private build(rev: number): LabState {
    const c = this.cur;
    let scenario: ScenarioView | null = null;
    if (c) {
      scenario = {
        summary: c.summary, seed: c.seed, mode: c.mode, brief: c.content.brief, diagram: c.content.diagram,
        requirements: c.content.requirements,
        guide: c.mode === 'exam' ? [] : c.content.guide.map((g, i) => ({ ...g, status: i < c.guideIndex ? 'done' as const : i === c.guideIndex ? 'active' as const : 'locked' as const })),
        startedAt: c.startedAt, timerMinutes: c.timerMinutes, finished: c.finished, hintsUsed: c.hintsUsed,
      };
      if (this.broken) (scenario as unknown as { summary: unknown }).summary = null;
    }
    return {
      rev, scenario,
      world: c ? structuredClone(c.world) : null,
      sessions: this.sessions.map((s) => ({ ...s })),
      journal: c ? [...c.journal] : [],
      report: c?.report ?? null,
      settings: { ...this.settings, qosClassifiesInnerHeader: c ? c.world.settings.qosClassifiesInnerHeader ?? true : this.settings.qosClassifiesInnerHeader },
      storage: { available: this.storageOk, saved: this.storageOk ? this.saved.map((s) => s.summary).sort((a, b) => b.savedAt - a.savedAt) : [] },
    };
  }
  private emit() {
    this.state = this.build(this.state.rev + 1);
    for (const l of [...this.listeners]) l();
  }

  // ───────── scenarios ─────────
  listScenarios(): ScenarioSummary[] { return SCENARIOS.map((s) => ({ ...s })); }

  startScenario(id: string, mode: LabMode, opts?: { seed?: number; timerMinutes?: number | null }): ActionResult {
    return this.startFreshScenario(id, mode, opts, this.settings.qosClassifiesInnerHeader);
  }
  private startFreshScenario(id: string, mode: LabMode, opts: Parameters<LabApi['startScenario']>[2], qos: boolean): ActionResult {
    const summary = SCENARIOS.find((s) => s.id === id);
    if (!summary) return { ok: false, message: `There is no scenario called "${id}".` };
    this.sessions = [];
    this.cli.clear();
    this.cur = {
      summary, content: contentFor(summary), scenarioId: id, mode, seed: summary.seedable ? opts?.seed ?? 0 : 0,
      startedAt: Date.now(), timerMinutes: mode === 'exam' ? opts?.timerMinutes ?? null : null, finished: false, hintsUsed: 0,
      guideIndex: 0, world: summary.family === 'broken' ? inProgressWorld(summary, this.settings.strictCables) : freshWorld(summary, this.settings.strictCables),
      journal: [], report: null, inProgress: summary.family === 'broken',
    };
    this.cur.world.settings.qosClassifiesInnerHeader = qos;
    this.emit();
    return { ok: true };
  }
  restartScenario(): void {
    const c = this.cur;
    if (!c) return;
    this.startFreshScenario(c.scenarioId, c.mode, { seed: c.seed, timerMinutes: c.timerMinutes }, c.world.settings.qosClassifiesInnerHeader ?? true);
  }
  leaveScenario(): void {
    const c = this.cur;
    if (c && this.storageOk) {
      const existing = this.saved.find((s) => s.snap.scenarioId === c.scenarioId && s.snap.mode === c.mode);
      const pct = c.report && c.report.maxPoints ? Math.round((c.report.points / c.report.maxPoints) * 100) : undefined;
      const snap: Snapshot = { ...c, world: structuredClone(c.world), journal: [...c.journal] };
      const summary: SavedLabSummary = { id: existing?.summary.id ?? `save-${this.savedSeq++}`, title: c.summary.title, mode: c.mode, savedAt: Date.now(), percent: pct };
      if (existing) { existing.summary = summary; existing.snap = snap; } else this.saved.push({ summary, snap });
    }
    this.cur = null;
    this.broken = false;
    this.sessions = [];
    this.cli.clear();
    this.emit();
  }

  // ───────── bench ─────────
  private guideBlock(feature: Feature, what: string): GuideBlock | undefined {
    const c = this.cur;
    if (!c || c.mode !== 'guided') return undefined;
    const active = c.content.guide[c.guideIndex];
    if (!active || active.allows.includes(feature) || feature === 'verify') return undefined;
    const owner = c.content.guide.find((g) => g.feature === feature) ?? active;
    return {
      stepId: owner.id, stepNo: owner.no, stepTitle: owner.title,
      reason: `${what} belongs to step ${owner.no} (${owner.title}). You are on step ${active.no}: ${active.title}. Finish that first — nothing was changed.`,
    };
  }
  private journal(e: Omit<JournalEntry, 'tick'>) {
    const c = this.cur;
    if (!c) return;
    c.world.tick += 1;
    c.journal.push({ ...e, tick: c.world.tick });
  }

  moveDevice(deviceId: string, x: number, y: number): void {
    const d = this.cur?.world.devices[deviceId];
    if (!d) return;
    d.x = x; d.y = y;
    this.emit();
  }
  connectCable(kind: CableKind, a: PortRef, b: PortRef, opts?: { dceEnd?: 'a' | 'b' }): ActionResult {
    const c = this.cur;
    if (!c) return { ok: false, message: 'No lab is open.' };
    const w = c.world;
    const pa = w.devices[a.deviceId]?.ports.find((p) => p.name === a.port);
    const pb = w.devices[b.deviceId]?.ports.find((p) => p.name === b.port);
    if (!pa || !pb) return { ok: false, message: 'That port does not exist.' };
    if (a.deviceId === b.deviceId && a.port === b.port) return { ok: false, message: 'Both ends are the same port.' };
    const used = (r: PortRef) => w.cables.some((x) => (x.a.deviceId === r.deviceId && x.a.port === r.port) || (x.b.deviceId === r.deviceId && x.b.port === r.port));
    if (used(a) || used(b)) return { ok: false, message: 'One of these ports already has a cable. Remove it first.' };
    if ((kind === 'serial') !== (pa.kind === 'serial' && pb.kind === 'serial') && (kind === 'serial' || pa.kind === 'serial' || pb.kind === 'serial'))
      return { ok: false, message: 'A serial cable only fits serial ports, and serial ports only take a serial cable.' };
    if ((pa.kind === 'rs232' || pb.kind === 'rs232') && kind !== 'console') return { ok: false, message: 'The PC serial port only takes a console cable.' };
    const feature: Feature = kind === 'console' ? 'console' : 'cabling';
    const blocked = this.guideBlock(feature, 'Plugging in a cable');
    if (blocked) {
      this.journal({ deviceId: a.deviceId, via: 'bench', line: `Cable ${kind}: ${a.deviceId} ${a.port} ↔ ${b.deviceId} ${b.port}`, feature, ok: false, mutated: false, blocked: true, stepId: blocked.stepId });
      this.emit();
      return { ok: false, message: blocked.reason, blocked };
    }
    w.cables.push({ id: `c${w.nextId++}`, kind, a, b, dceEnd: kind === 'serial' ? opts?.dceEnd ?? 'a' : undefined });
    this.journal({ deviceId: a.deviceId, via: 'bench', line: `Cable ${kind}: ${a.deviceId} ${a.port} ↔ ${b.deviceId} ${b.port}`, feature, ok: true, mutated: true });
    this.emit();
    return { ok: true };
  }
  removeCable(cableId: string): ActionResult {
    const c = this.cur;
    if (!c) return { ok: false, message: 'No lab is open.' };
    const cable = c.world.cables.find((x) => x.id === cableId);
    if (!cable) return { ok: false, message: 'That cable is already gone.' };
    c.world.cables = c.world.cables.filter((x) => x.id !== cableId);
    this.sessions = this.sessions.map((s) => (s.kind === 'console' && (s.deviceId === cable.a.deviceId || s.deviceId === cable.b.deviceId) ? { ...s, closed: true } : s));
    this.journal({ deviceId: cable.a.deviceId, via: 'bench', line: `Cable removed: ${cable.a.deviceId} ${cable.a.port} ↔ ${cable.b.deviceId} ${cable.b.port}`, feature: 'cabling', ok: true, mutated: true });
    this.emit();
    return { ok: true };
  }
  portStatus(ref: PortRef): PortStatus {
    const w = this.cur?.world;
    const spec = w?.devices[ref.deviceId]?.ports.find((p) => p.name === ref.port);
    const kind = spec?.kind ?? 'ethernet';
    const cable = w?.cables.find((x) => (x.a.deviceId === ref.deviceId && x.a.port === ref.port) || (x.b.deviceId === ref.deviceId && x.b.port === ref.port));
    if (!w || !cable) return { ref, kind, led: 'off', status: kind === 'ethernet' || kind === 'serial' ? 'down/down' : undefined, problem: cable ? undefined : 'No cable.' };
    const myEnd = cable.a.deviceId === ref.deviceId && cable.a.port === ref.port ? 'a' : 'b';
    const peer = myEnd === 'a' ? cable.b : cable.a;
    const peerKind = w.devices[peer.deviceId]?.ports.find((p) => p.name === peer.port)?.kind;
    const base = { ref, kind, cableId: cable.id, cableKind: cable.kind, dce: cable.kind === 'serial' ? cable.dceEnd === myEnd : undefined };
    if (cable.kind === 'console') {
      const good = (kind === 'console' && peerKind === 'rs232') || (kind === 'rs232' && peerKind === 'console');
      return { ...base, led: good ? 'green' : 'amber', problem: good ? undefined : 'A console cable needs a PC serial port at one end and a CON port at the other.' };
    }
    if (kind === 'console' || peerKind === 'console') return { ...base, led: 'amber', status: 'down/down', problem: 'An Ethernet cable in a console port gives no link.' };
    const d = w.devices[ref.deviceId];
    const shut = d && d.kind !== 'pc' ? (d as IosDevice).config.interfaces[ref.port]?.shutdown : false;
    const peerDev = w.devices[peer.deviceId];
    const peerShut = peerDev && peerDev.kind !== 'pc' ? (peerDev as IosDevice).config.interfaces[peer.port]?.shutdown : false;
    if (shut) return { ...base, led: 'amber', status: 'administratively down/down', problem: 'This port is shut down. Type no shutdown on it.' };
    if (peerShut) return { ...base, led: 'amber', status: 'down/down', problem: 'The port at the other end is shut down.' };
    return { ...base, led: 'green', status: 'up/up' };
  }

  // ───────── terminals ─────────
  consoleTargetOf(pcId: string): string | null {
    const w = this.cur?.world;
    const cable = w?.cables.find((x) => x.kind === 'console' && (x.a.deviceId === pcId || x.b.deviceId === pcId));
    if (!w || !cable) return null;
    const other = cable.a.deviceId === pcId ? cable.b : cable.a;
    return w.devices[other.deviceId]?.ports.find((p) => p.name === other.port)?.kind === 'console' ? other.deviceId : null;
  }
  consolePcOf(deviceId: string): string | null {
    const w = this.cur?.world;
    if (!w) return null;
    for (const x of w.cables) {
      if (x.kind !== 'console') continue;
      const mine = x.a.deviceId === deviceId ? x.a : x.b.deviceId === deviceId ? x.b : null;
      if (!mine) continue;
      const other = mine === x.a ? x.b : x.a;
      if (w.devices[other.deviceId]?.kind === 'pc') return other.deviceId;
    }
    return null;
  }
  openConsole(deviceId: string): OpenSessionResult {
    const w = this.cur?.world;
    const d = w ? ios(w, deviceId) : undefined;
    if (!w || !d) return { ok: false, message: 'This device has no console.' };
    const pcId = this.consolePcOf(deviceId);
    if (!pcId) return { ok: false, message: `No console cable is plugged into ${d.label}. Connect one from a PC's COM port to the CON port first.` };
    const open = this.sessions.find((s) => s.deviceId === deviceId && s.kind === 'console' && !s.closed);
    const host = d.config.hostname;
    if (open) return { ok: true, session: open, banner: '' };
    const s: SessionView = { id: `s${this.nextSession++}`, deviceId, kind: 'console', pcId, title: `${d.label} — console (${w.devices[pcId]?.label ?? pcId} COM1, 9600 8N1)`, prompt: promptFor(host, 'exec'), secret: false, closed: false };
    this.sessions = [...this.sessions, s];
    this.cli.set(s.id, { mode: 'exec', history: [] });
    this.emit();
    return { ok: true, session: s, banner: d.runtime.setupDialogDone ? '\nPress RETURN to get started!\n\n' : `\n         --- System Configuration Dialog ---\n\n(mock: dialog skipped)\n\nPress RETURN to get started!\n\n` };
  }
  sessionExec(sessionId: string, raw: string): ExecView {
    const s = this.sessions.find((x) => x.id === sessionId);
    const st = this.cli.get(sessionId);
    const w = this.cur?.world;
    const d = s && w ? ios(w, s.deviceId) : undefined;
    if (!s || !st || !d || s.closed) return { output: '', prompt: '', secret: false, closed: true, notes: [] };
    const line = raw.trim();
    if (line) st.history.push(line);
    const lower = line.toLowerCase();
    const feature = featureOf(line, st.mode);
    const inConfig = st.mode !== 'exec' && st.mode !== 'priv';
    const nav = /^(interface|int|line|router|exit|end|do|ip dhcp pool|class-map|policy-map|class |crypto map|crypto isakmp policy)\b/.test(lower);
    const mutates = inConfig && !nav && line.length > 0;
    let output = '';
    const notes: string[] = [];
    const view = (): ExecView => ({ output, prompt: promptFor(d.config.hostname, st.mode), secret: false, closed: s.closed, notes });

    if (mutates) {
      const blocked = this.guideBlock(feature, `"${line}"`);
      if (blocked) {
        this.journal({ deviceId: s.deviceId, via: s.kind === 'telnet' ? 'vty' : 'console', mode: st.mode, line, feature, ok: false, mutated: false, blocked: true, stepId: blocked.stepId });
        this.emit();
        return { ...view(), blocked };
      }
    }
    let ok = true;
    if (!line) { /* empty */ }
    else if (st.mode === 'exec') {
      if (/^en(able)?$/.test(lower)) st.mode = 'priv';
      else if (/^(exit|logout|quit)$/.test(lower)) this.closeSessionInner(s);
      else if (/^(sh|show)\s/.test(lower) || /^ping\s/.test(lower)) output = this.fakeShow(d, lower);
      else { ok = false; output = `Translating "${line.split(/\s+/)[0]}"...domain server (255.255.255.255)\n% Unknown command or computer name, or unable to find computer address`; }
    } else if (st.mode === 'priv') {
      if (/^(conf|config|configure)(\s+t(erminal)?)?$/.test(lower)) { st.mode = 'config'; output = 'Enter configuration commands, one per line.  End with CNTL/Z.'; }
      else if (/^disable$/.test(lower)) st.mode = 'exec';
      else if (/^(exit|logout)$/.test(lower)) this.closeSessionInner(s);
      else if (/^(copy run|copy running-config startup-config|wr|write)/.test(lower)) {
        d.startupConfig = this.getConfigText(s.deviceId, 'running');
        output = 'Destination filename [startup-config]? \nBuilding configuration...\n[OK]';
      } else if (/^(sh|show)\s/.test(lower) || /^(ping|traceroute)\s/.test(lower)) output = this.fakeShow(d, lower);
      else { ok = false; output = `                 ^\n% Invalid input detected at '^' marker.`; }
    } else {
      if (lower === 'end') st.mode = 'priv';
      else if (lower === 'exit') st.mode = st.mode === 'config' ? 'priv' : 'config';
      else if (/^(int|interface)\s+/.test(lower)) {
        const name = normIf(line.replace(/^\S+\s+/, ''));
        if (!name) { ok = false; output = `                    ^\n% Invalid input detected at '^' marker.`; }
        else {
          if (!d.config.interfaces[name]) d.config.interfaces[name] = { name, shutdown: !name.startsWith('Loopback') ? true : false };
          st.mode = 'config-if'; st.iface = name;
        }
      } else if (/^line\s/.test(lower)) st.mode = 'config-line';
      else if (/^router\s/.test(lower)) st.mode = 'config-router';
      else if (/^ip dhcp pool\s/.test(lower)) st.mode = 'dhcp-config';
      else if (/^hostname\s+\S+$/.test(lower)) d.config.hostname = line.split(/\s+/)[1];
      else if (/^no ip domain[- ]lookup$/.test(lower)) d.config.ipDomainLookup = false;
      else if (/^(priority-list|queue-list|custom-queue-list|priority-group|fair-queue$)/.test(lower) && st.mode !== 'config-pmap-c') {
        ok = false;
        output = `${' '.repeat(Math.max(0, d.config.hostname.length + 9))}^\n% Invalid input detected at '^' marker.`;
        notes.push('Legacy queueing does not exist on IOS XE. Use class-map and policy-map (see the QoS section of the command sheet).');
      } else if (st.mode === 'config-if' && st.iface) {
        const ifc = d.config.interfaces[st.iface];
        const m = /^ip add(?:ress)?\s+(\S+)\s+(\S+)$/.exec(lower);
        if (m) ifc.ip = { address: m[1], mask: m[2] };
        else if (/^no sh(ut(down)?)?$/.test(lower)) {
          ifc.shutdown = false;
          output = `%LINK-3-UPDOWN: Interface ${st.iface}, changed state to up`;
        } else if (/^sh(ut(down)?)?$/.test(lower)) ifc.shutdown = true;
        else if (/^clock rate\s+\d+$/.test(lower)) ifc.clockRate = Number(lower.split(/\s+/)[2]);
        else if (/^bandwidth\s+\d+$/.test(lower)) ifc.bandwidthKbps = Number(lower.split(/\s+/)[1]);
        else if (/^ip adress/.test(lower)) { ok = false; output = `   ^\n% Invalid input detected at '^' marker.`; }
        else notes.push('Mock lab: accepted but not simulated.');
      } else {
        d.config.extraLines.push(line);
        notes.push('Mock lab: accepted but not simulated.');
      }
    }
    if (line) this.journal({ deviceId: s.deviceId, via: s.kind === 'telnet' ? 'vty' : 'console', mode: st.mode, line, feature, ok, mutated: mutates && ok });
    this.emit();
    return view();
  }
  private fakeShow(d: IosDevice, lower: string): string {
    if (/ip int(erface)? br/.test(lower)) {
      const rows = Object.values(d.config.interfaces).map((i) => {
        const st = i.shutdown ? 'administratively down' : 'up';
        return `${i.name.padEnd(23)}${(i.ip?.address ?? 'unassigned').padEnd(16)}YES ${i.ip ? 'manual' : 'unset '} ${st.padEnd(22)}${i.shutdown ? 'down' : 'up'}`;
      });
      return ['Interface              IP-Address      OK? Method Status                Protocol', ...rows].join('\n');
    }
    if (/run/.test(lower)) return this.getConfigText(d.id, 'running');
    if (/^ping/.test(lower)) return 'Type escape sequence to abort.\nSending 5, 100-byte ICMP Echos to target, timeout is 2 seconds:\n!!!!!\nSuccess rate is 100 percent (5/5), round-trip min/avg/max = 1/2/4 ms';
    return '(mock lab: no output for this show command)';
  }
  private closeSessionInner(s: SessionView) {
    this.sessions = this.sessions.map((x) => (x.id === s.id ? { ...x, closed: true } : x));
    s.closed = true;
  }
  sessionHelp(sessionId: string, line: string): string {
    const st = this.cli.get(sessionId);
    if (!st) return '';
    if (line.trim()) return '  <cr>    (mock help)';
    if (st.mode === 'exec') return 'Exec commands:\n  enable     Turn on privileged commands\n  ping       Send echo messages\n  show       Show running system information\n  telnet     Open a telnet connection';
    if (st.mode === 'priv') return 'Exec commands:\n  configure  Enter configuration mode\n  copy       Copy from one file to another\n  disable    Turn off privileged commands\n  ping       Send echo messages\n  show       Show running system information';
    return 'Configure commands:\n  access-list   Add an access list entry\n  crypto        Encryption module\n  hostname      Set system\'s network name\n  interface     Select an interface to configure\n  ip            Global IP configuration subcommands\n  line          Configure a terminal line\n  snmp-server   Modify SNMP engine parameters';
  }
  sessionComplete(sessionId: string, line: string): { line: string; candidates: string[] } {
    const st = this.cli.get(sessionId);
    const words: Record<string, string[]> = {
      exec: ['enable', 'exit', 'ping', 'show', 'telnet'],
      priv: ['configure', 'copy', 'disable', 'exit', 'ping', 'show', 'traceroute', 'write'],
    };
    const list = words[st?.mode ?? ''] ?? ['access-list', 'crypto', 'end', 'exit', 'hostname', 'interface', 'ip', 'line', 'logging', 'snmp-server'];
    const last = line.split(/\s+/).pop() ?? '';
    const hits = list.filter((w) => w.startsWith(last.toLowerCase()));
    if (hits.length === 1 && !line.includes(' ')) return { line: hits[0] + ' ', candidates: [] };
    return { line, candidates: hits };
  }
  sessionKey(sessionId: string, key: 'ctrl-z' | 'ctrl-c'): ExecView {
    const s = this.sessions.find((x) => x.id === sessionId);
    const st = this.cli.get(sessionId);
    const d = s && this.cur ? ios(this.cur.world, s.deviceId) : undefined;
    if (!s || !st || !d) return { output: '', prompt: '', secret: false, closed: true, notes: [] };
    if (st.mode !== 'exec' && st.mode !== 'priv') st.mode = 'priv';
    return { output: key === 'ctrl-z' ? '^Z' : '^C', prompt: promptFor(d.config.hostname, st.mode), secret: false, closed: false, notes: [] };
  }
  sessionHistory(sessionId: string): string[] { return [...(this.cli.get(sessionId)?.history ?? [])]; }
  closeSession(sessionId: string): void {
    this.sessions = this.sessions.filter((s) => s.id !== sessionId);
    this.cli.delete(sessionId);
    this.emit();
  }

  // ───────── config files ─────────
  getConfigText(deviceId: string, which: 'running' | 'startup'): string {
    const c = this.cur;
    const d = c ? ios(c.world, deviceId) : undefined;
    if (!c || !d) return '';
    if (which === 'startup') return d.startupConfig ?? 'startup-config is not present';
    if (deviceId === 'R1' && c.inProgress) return STUDENT_R1;
    const out: string[] = ['Building configuration...', '', 'Current configuration : 1024 bytes', '!', 'version 17.3', '!', `hostname ${d.config.hostname}`, '!'];
    if (!d.config.ipDomainLookup) out.push('no ip domain lookup', '!');
    for (const i of Object.values(d.config.interfaces)) {
      out.push(`interface ${i.name}`);
      if (i.bandwidthKbps) out.push(` bandwidth ${i.bandwidthKbps}`);
      out.push(i.ip ? ` ip address ${i.ip.address} ${i.ip.mask}` : ' no ip address');
      if (i.aclIn) out.push(` ip access-group ${i.aclIn} in`);
      if (i.natRole) out.push(` ip nat ${i.natRole}`);
      if (i.cryptoMap) out.push(` crypto map ${i.cryptoMap}`);
      if (i.servicePolicyOut) out.push(` service-policy output ${i.servicePolicyOut}`);
      if (i.clockRate) out.push(` clock rate ${i.clockRate}`);
      if (i.shutdown) out.push(' shutdown');
      out.push('!');
    }
    for (const r of d.config.staticRoutes) out.push(`ip route ${r.prefix} ${r.mask}${r.exitInterface ? ' ' + r.exitInterface : ''}${r.nextHop ? ' ' + r.nextHop : ''}`);
    out.push(...d.config.extraLines, '!', 'line con 0', ' stopbits 1', 'line vty 0 4', ' login', '!', 'end');
    return out.join('\n');
  }
  applyConfigText(deviceId: string, text: string, how: 'merge' | 'replace'): ApplyReport {
    const c = this.cur;
    const d = c ? ios(c.world, deviceId) : undefined;
    if (!c || !d) return { ok: false, applied: 0, failed: 0, lines: [], message: 'Unknown device.' };
    if (how === 'replace') { d.config.extraLines = []; }
    const lines = text.split(/\r?\n/).map((l, i) => ({ lineNo: i + 1, line: l })).filter((l) => l.line.trim() && !l.line.trim().startsWith('!'));
    const results = lines.map((l) => {
      const bad = /^(priority-list|queue-list|custom-queue-list)/.test(l.line.trim());
      const hn = /^hostname\s+(\S+)/.exec(l.line.trim());
      if (hn) d.config.hostname = hn[1];
      return { ...l, ok: !bad, output: bad ? "% Invalid input detected at '^' marker." : '' };
    });
    for (const r of results) this.journal({ deviceId, via: 'file', line: r.line, feature: featureOf(r.line, 'config'), ok: r.ok, mutated: r.ok });
    this.emit();
    const failed = results.filter((r) => !r.ok).length;
    return { ok: failed === 0, applied: results.length - failed, failed, lines: results };
  }

  // ───────── PCs ─────────
  setPcNic(pcId: string, nic: { mode: 'static' | 'dhcp'; address?: string; mask?: string; gateway?: string; dns?: string }): ActionResult {
    const p = this.cur ? pc(this.cur.world, pcId) : undefined;
    if (!p) return { ok: false, message: 'Unknown PC.' };
    p.nic = { ...p.nic, ...nic };
    this.journal({ deviceId: pcId, via: 'pc', line: nic.mode === 'static' ? `NIC static ${nic.address ?? ''} ${nic.mask ?? ''} gateway ${nic.gateway ?? ''}` : 'NIC DHCP', feature: 'pc', ok: true, mutated: true });
    this.emit();
    return { ok: true };
  }
  setPcService(pcId: string, service: keyof PcServices, on: boolean): void {
    const p = this.cur ? pc(this.cur.world, pcId) : undefined;
    if (!p) return;
    p.services[service] = on;
    this.emit();
  }
  pcExec(pcId: string, line: string): PcExecView {
    const p = this.cur ? pc(this.cur.world, pcId) : undefined;
    if (!p) return { output: '' };
    const l = line.trim().toLowerCase();
    if (l === 'cls') return { output: '', clear: true };
    if (l === 'ipconfig' || l === 'ipconfig /all') {
      return { output: `\nEthernet adapter Ethernet0:\n\n   IPv4 Address. . . . . . . . . . . : ${p.nic.address ?? '169.254.12.7'}\n   Subnet Mask . . . . . . . . . . . : ${p.nic.mask ?? '255.255.0.0'}\n   Default Gateway . . . . . . . . . : ${p.nic.gateway ?? ''}\n` };
    }
    if (/^ping\s+\S+/.test(l)) {
      const dst = l.split(/\s+/)[1];
      this.journal({ deviceId: pcId, via: 'pc', line, feature: 'verify', ok: true, mutated: false });
      this.emit();
      return { delayMs: 600, output: `\nPinging ${dst} with 32 bytes of data:\nReply from ${dst}: bytes=32 time=2ms TTL=254\nReply from ${dst}: bytes=32 time=1ms TTL=254\nReply from ${dst}: bytes=32 time=1ms TTL=254\nReply from ${dst}: bytes=32 time=1ms TTL=254\n\nPing statistics for ${dst}:\n    Packets: Sent = 4, Received = 4, Lost = 0 (0% loss),\n` };
    }
    return { output: `'${line.split(/\s+/)[0]}' is not recognized as an internal or external command,\noperable program or batch file.` };
  }
  pcSnmp(_pcId: string, req: SnmpRequest): SnmpReply {
    return req.op === 'get' ? { ok: true, text: `${req.oid} = STRING: "Cisco IOS XE Software, Version 17.03.04a"` } : { ok: false, text: 'Timeout: no response from ' + req.host };
  }
  clearPcLog(pcId: string, which: 'syslog' | 'traps'): void {
    const p = this.cur ? pc(this.cur.world, pcId) : undefined;
    if (!p) return;
    p.runtime[which] = [];
    this.emit();
  }

  // ───────── learning tools ─────────
  trace(spec: FlowSpec): FlowResult | { error: string } {
    const c = this.cur;
    if (!c) return { error: 'No lab is open.' };
    if (c.mode === 'exam') return { error: 'The packet walkthrough is not available in exam mode.' };
    return mockTrace(c.world, spec);
  }
  qosLoad(spec: QosLoadSpec): QosLoadResult {
    const c = this.cur;
    if (!c || c.mode === 'exam') return { ok: false, message: 'The QoS load test is not available in exam mode.', linkKbps: 0, shapedKbps: 0, rows: [] };
    const d = ios(c.world, spec.deviceId);
    const ifc = d?.config.interfaces[spec.iface];
    if (!d || !ifc) return { ok: false, message: 'Pick a router interface first.', linkKbps: 0, shapedKbps: 0, rows: [] };
    const linkKbps = ifc.bandwidthKbps ?? (spec.iface.startsWith('Serial') ? 1544 : 1000000);
    if (!ifc.servicePolicyOut) {
      const total = spec.offered.reduce((s, r) => s + r.kbps, 0);
      const f = total > linkKbps ? linkKbps / total : 1;
      return { ok: true, message: `${spec.iface} has no output service-policy. Traffic is sent first come, first served.`, linkKbps, shapedKbps: linkKbps,
        rows: spec.offered.map((r) => ({ label: r.label, className: '(none)', treatment: 'No QoS: one queue for everything', offeredKbps: r.kbps, deliveredKbps: round1(r.kbps * f) })) };
    }
    const shaped = round1(linkKbps * 0.95);
    const cls = spec.offered.map((r) => {
      const f = r.flow;
      if (f.proto === 'icmp') return 'classPriority';
      if ((f.proto === 'tcp' && (f.dport === 22 || f.dport === 23)) || (f.proto === 'udp' && (f.dport === 161 || f.dport === 162))) return 'classGuaranteed';
      return 'class-default';
    });
    const delivered = spec.offered.map(() => 0);
    const idx = (k: string) => spec.offered.map((_, i) => i).filter((i) => cls[i] === k);
    const share = (ids: number[], budget: number) => {
      // max-min fair share
      let left = budget;
      let open = ids.filter((i) => spec.offered[i].kbps - delivered[i] > 0);
      while (left > 0.01 && open.length) {
        const each = left / open.length;
        for (const i of open) {
          const want = spec.offered[i].kbps - delivered[i];
          const give = Math.min(want, each);
          delivered[i] += give;
          left -= give;
        }
        open = open.filter((i) => spec.offered[i].kbps - delivered[i] > 0.01);
      }
      return budget - left;
    };
    let budget = shaped;
    const total = spec.offered.reduce((s, r) => s + r.kbps, 0);
    if (total <= shaped) spec.offered.forEach((r, i) => { delivered[i] = r.kbps; });
    else {
      budget -= share(idx('classPriority'), Math.min(16, budget));
      budget -= share(idx('classGuaranteed'), Math.min(48, budget));
      share([...idx('classGuaranteed'), ...idx('class-default')], budget);
    }
    const treat: Record<string, string> = {
      classPriority: 'Priority queue: sent first, up to 16 kbit/s when the link is busy',
      classGuaranteed: 'Guaranteed at least 48 kbit/s, may use more when free',
      'class-default': 'Fair queue (WFQ): shares whatever is left',
    };
    return { ok: true, linkKbps, shapedKbps: shaped, rows: spec.offered.map((r, i) => ({ label: r.label, className: cls[i], treatment: treat[cls[i]], offeredKbps: r.kbps, deliveredKbps: round1(delivered[i]) })) };
  }
  noteHintUsed(_stepId: string): void {
    if (!this.cur) return;
    this.cur.hintsUsed += 1;
    this.emit();
  }
  solution(): SolutionView | null {
    const c = this.cur;
    if (!c) return null;
    if (c.mode === 'exam' && !c.finished) return null;
    return SOLUTION;
  }
  commandSheet(): CommandSheetSection[] { return COMMAND_SHEET; }

  // ───────── grading ─────────
  check(): GradeReport {
    const c = this.cur;
    if (!c) throw new Error('No lab is open.');
    if (c.mode === 'exam') return this.finishExam();
    c.report = makeReport(c.scenarioId, c.mode, c.world.tick, c.content.requirements);
    if (c.guideIndex < c.content.guide.length) c.guideIndex += 1;
    this.emit();
    return c.report;
  }
  finishExam(): GradeReport {
    const c = this.cur;
    if (!c) throw new Error('No lab is open.');
    c.finished = true;
    c.report = makeReport(c.scenarioId, c.mode, c.world.tick, c.content.requirements);
    this.emit();
    return c.report;
  }

  // ───────── settings and persistence ─────────
  updateSettings(patch: Partial<UiSettings>): void {
    const { qosClassifiesInnerHeader: qos, ...other } = patch;
    this.settings = { ...this.settings, ...other };
    if (patch.strictCables !== undefined && this.cur) this.cur.world.settings.strictCables = patch.strictCables;
    if (this.cur?.mode !== 'exam' && typeof qos === 'boolean') {
      this.settings.qosClassifiesInnerHeader = qos;
      if (this.cur && this.cur.world.settings.qosClassifiesInnerHeader !== qos) {
        this.cur.world.settings.qosClassifiesInnerHeader = qos;
        this.cur.report = null;
      }
    }
    this.emit();
  }
  exportLab(): string {
    const c = this.cur;
    if (!c) return JSON.stringify({ format: 'kss-netlab-lab', version: 1, empty: true });
    const { summary: _s, content: _c, ...snap } = c;
    return JSON.stringify({ format: 'kss-netlab-lab', version: 1, ...snap }, null, 2);
  }
  importLab(json: string): ActionResult {
    let data: unknown;
    try { data = JSON.parse(json); } catch { return { ok: false, message: 'This file is not a lab file. It could not be read as JSON.' }; }
    const d = data as Partial<Snapshot> & { format?: string };
    if (!d || d.format !== 'kss-netlab-lab' || !d.scenarioId || !d.world) return { ok: false, message: 'This file is not a KSS NetLab lab file.' };
    const summary = SCENARIOS.find((s) => s.id === d.scenarioId);
    if (!summary) return { ok: false, message: 'This lab uses a scenario this version does not know.' };
    this.restore(summary, d as Snapshot);
    return { ok: true, message: `Opened "${summary.title}".` };
  }
  private restore(summary: ScenarioSummary, snap: Snapshot) {
    this.sessions = [];
    this.cli.clear();
    this.cur = { ...snap, summary, content: contentFor(summary), world: structuredClone(snap.world), journal: [...(snap.journal ?? [])], report: snap.report ?? null };
    this.emit();
  }
  loadSaved(id: string): ActionResult {
    const s = this.saved.find((x) => x.summary.id === id);
    if (!s) return { ok: false, message: 'That saved lab is gone.' };
    const summary = SCENARIOS.find((x) => x.id === s.snap.scenarioId);
    if (!summary) return { ok: false, message: 'Unknown scenario.' };
    this.restore(summary, s.snap);
    return { ok: true };
  }
  deleteSaved(id: string): void {
    this.saved = this.saved.filter((x) => x.summary.id !== id);
    this.emit();
  }
}

function round1(n: number): number { return Math.round(n * 10) / 10; }

// ───────────────────────── canned packet walkthrough ─────────────────────────

interface Where { deviceId: string; iface?: string }

function locate(w: World, addr: string): Where | null {
  for (const id of w.order) {
    const d = w.devices[id];
    if (d.kind === 'pc') { if ((d as PcDevice).nic.address === addr) return { deviceId: id }; continue; }
    for (const i of Object.values((d as IosDevice).config.interfaces)) if (i.ip?.address === addr) return { deviceId: id, iface: i.name };
  }
  return null;
}
const SIDE_A = new Set(['PC1', 'PC2', 'SW1', 'R1']);

function describe(spec: FlowSpec): string {
  if (spec.proto === 'icmp') return 'a ping (ICMP echo)';
  const names: Record<number, string> = { 80: 'HTTP', 21: 'FTP', 23: 'Telnet', 22: 'SSH', 161: 'SNMP', 514: 'syslog' };
  return `${names[spec.dport ?? 0] ?? spec.proto.toUpperCase()} (${spec.proto.toUpperCase()} port ${spec.dport ?? '?'})`;
}
function hdr(spec: FlowSpec, src: string, dst: string, reply = false): string {
  if (spec.proto === 'icmp') return `ICMP ${reply ? 'echo-reply' : 'echo'} ${src} → ${dst}`;
  const sp = spec.sport ?? 49152;
  return reply ? `${spec.proto.toUpperCase()} ${src}:${spec.dport ?? 0} → ${dst}:${sp}` : `${spec.proto.toUpperCase()} ${src}:${sp} → ${dst}:${spec.dport ?? 0}${spec.proto === 'tcp' ? ' SYN' : ''}`;
}

function mockTrace(w: World, spec: FlowSpec): FlowResult {
  const from = w.devices[spec.fromDeviceId];
  const label = (id: string) => w.devices[id]?.label ?? id;
  const steps: TraceStep[] = [];
  if (!from) return { ok: false, symbol: '.', summary: 'Pick a source device.', forward: { ok: false, steps: [], encrypted: false, qos: [] } };
  let src = spec.srcAddr;
  if (!src) {
    if (from.kind === 'pc') src = (from as PcDevice).nic.address;
    else src = from.id === 'R1' ? (spec.dst.startsWith('192.168.100.') ? '192.168.100.1' : '60.50.30.1') : (spec.dst.startsWith('60.50.40.') ? '60.50.40.1' : '60.50.30.2');
  }
  if (!src) {
    steps.push({ deviceId: from.id, stage: 'drop', feature: 'pc', verdict: 'drop', text: `${label(from.id)} has no IP address yet, so it cannot send anything.`, detail: 'Set a static address, or use DHCP and renew.' });
    return { ok: false, symbol: '.', summary: `${label(from.id)} has no IP address, so nothing was sent.`, forward: { ok: false, reason: 'no-ip', reasonText: 'No IP address.', atDeviceId: from.id, steps, encrypted: false, qos: [] } };
  }
  const target = locate(w, spec.dst) ?? (spec.dst === '60.50.50.100' ? { deviceId: 'R1', iface: 'Loopback100' } : null);
  const what = describe(spec);
  steps.push({ deviceId: from.id, stage: 'origin', feature: from.kind === 'pc' ? 'pc' : 'verify', verdict: 'info', text: `${label(from.id)} sends ${what} to ${spec.dst}.`, header: hdr(spec, src, spec.dst) });

  const encryptable = spec.proto === 'icmp' || (spec.proto === 'tcp' && (spec.dport === 22 || spec.dport === 23)) || (spec.proto === 'udp' && (spec.dport === 161 || spec.dport === 162));
  const qosClass = spec.proto === 'icmp' ? 'classPriority' : encryptable ? 'classGuaranteed' : 'class-default';
  const fromA = SIDE_A.has(from.id);
  const toA = target ? SIDE_A.has(target.deviceId) : !fromA;
  let curSrc = src;
  const qos: FlowResult['forward']['qos'] = [];
  let encrypted = false;

  const fail = (deviceId: string, feature: Feature, text: string, detail: string | undefined, reason: FlowResult['forward']['reason'], symbol: '.' | 'U', summary: string): FlowResult => {
    steps.push({ deviceId, stage: 'drop', feature, verdict: 'drop', text, detail });
    return { ok: false, symbol, summary, forward: { ok: false, reason, reasonText: text, atDeviceId: deviceId, steps, encrypted, qos } };
  };

  // up to the first router
  if (from.kind === 'pc') {
    steps.push({ deviceId: from.id, stage: 'link', feature: 'cabling', verdict: 'ok', iface: 'Ethernet0', text: 'The cable is up. The packet goes to the default gateway.' });
    if (fromA) steps.push({ deviceId: 'SW1', stage: 'switch', feature: 'switching', verdict: 'ok', text: 'SW1 forwards the frame towards R1 (VLAN 1).', iface: 'GigabitEthernet1/0/24' });
  }
  const firstRouter = fromA ? 'R1' : 'R2';
  if (from.kind === 'pc') {
    steps.push({ deviceId: firstRouter, stage: 'ingress', feature: 'interface', verdict: 'ok', iface: 'GigabitEthernet0/0/0', text: `${firstRouter} receives the packet on its LAN port.` });
    if (firstRouter === 'R1') {
      if (src === '192.168.100.10' && spec.dst === '2.2.2.2')
        return fail('R1', 'acl', 'ACL 110 inbound drops the packet. R1 answers with "administratively prohibited".', 'access-list 110 deny ip host 192.168.100.10 host 2.2.2.2   (line 10)', 'acl-in', 'U', 'The packet stops at R1: ACL 110 blocks PC1 from reaching 2.2.2.2. That is what task 6 asks for.');
      const allowLine = src === '192.168.100.101' && spec.dst.startsWith('60.50.40.') && spec.proto === 'icmp' ? 'access-list 110 permit icmp host 192.168.100.101 60.50.40.0 0.0.0.63   (line 20)' : 'access-list 110 permit ip any any   (line 30)';
      steps.push({ deviceId: 'R1', stage: 'acl-in', feature: 'acl', verdict: 'ok', iface: 'GigabitEthernet0/0/0', text: 'ACL 110 inbound: the first matching line permits the packet.', detail: allowLine });
    }
  }
  if (target && target.deviceId === firstRouter && from.kind === 'pc') {
    steps.push({ deviceId: firstRouter, stage: 'local', feature: 'interface', verdict: 'ok', text: `${spec.dst} is an address of ${firstRouter} (${target.iface}). ${firstRouter} answers itself.` });
  } else if (target && target.deviceId === from.id) {
    steps.push({ deviceId: from.id, stage: 'local', feature: 'interface', verdict: 'ok', text: `${spec.dst} is an address of ${label(from.id)} itself.` });
  } else {
    if (toA === fromA && target) {
      // same side
      if (firstRouter === 'R1' && from.kind !== 'pc') steps.push({ deviceId: 'R1', stage: 'route', feature: 'routing', verdict: 'ok', text: 'LAN1 is directly connected on GigabitEthernet0/0/0.' });
    } else {
      const r = firstRouter;
      const other = r === 'R1' ? 'R2' : 'R1';
      const peerIp = r === 'R1' ? '60.50.30.2' : '60.50.30.1';
      steps.push({ deviceId: r, stage: 'route', feature: 'routing', verdict: 'ok', text: `Default route: out of Serial0/1/0 to ${peerIp}.`, detail: `S* 0.0.0.0/0 [1/0] via ${peerIp}, Serial0/1/0` });
      if (r === 'R1' && curSrc.startsWith('192.168.100.')) {
        curSrc = '60.50.30.1';
        steps.push({ deviceId: 'R1', stage: 'nat-inside', feature: 'nat', verdict: 'changed', iface: 'Serial0/1/0', text: 'PAT changes the source to the WAN address.', detail: 'ip nat inside source list 1 interface Serial0/1/0 overload', header: hdr(spec, curSrc, spec.dst) });
      }
      if (encryptable) {
        encrypted = true;
        steps.push({ deviceId: r, stage: 'crypto', feature: 'ipsec', verdict: 'changed', iface: 'Serial0/1/0', text: `The packet matches crypto ACL 120, so it is encrypted and sent inside ESP to ${peerIp}.`, detail: 'crypto map CM 10 → match address 120', header: `ESP ${r === 'R1' ? '60.50.30.1' : '60.50.30.2'} → ${peerIp}` });
      } else {
        steps.push({ deviceId: r, stage: 'crypto', feature: 'ipsec', verdict: 'info', iface: 'Serial0/1/0', text: 'Not in crypto ACL 120, so it leaves in clear text.' });
      }
      const rDev = ios(w, r);
      if (rDev?.config.interfaces['Serial0/1/0']?.servicePolicyOut) {
        qos.push({ deviceId: r, iface: 'Serial0/1/0', policy: 'output_SE', className: 'class-default', childPolicy: 'output_QE', childClass: qosClass });
        steps.push({ deviceId: r, stage: 'qos', feature: 'qos', verdict: 'info', iface: 'Serial0/1/0', text: `QoS puts it in ${qosClass} (inside the 95 % shaper).`, detail: 'service-policy output output_SE → output_QE' });
      }
      steps.push({ deviceId: r, stage: 'egress', feature: 'interface', verdict: 'ok', iface: 'Serial0/1/0', text: 'Sent on the serial link (128 kbit/s).' });
      steps.push({ deviceId: other, stage: 'ingress', feature: 'interface', verdict: 'ok', iface: 'Serial0/1/0', text: `${other} receives it on Serial0/1/0.` });
      if (encrypted) steps.push({ deviceId: other, stage: 'decrypt', feature: 'ipsec', verdict: 'changed', iface: 'Serial0/1/0', text: 'ESP is decrypted. The original packet comes out.', header: hdr(spec, curSrc, spec.dst) });
      if (!target) return fail(other, 'routing', `Nothing on the bench has the address ${spec.dst}. ${other} drops the packet.`, undefined, 'host-unreachable', '.', `No device answers at ${spec.dst}. Check the address.`);
      if (target.deviceId === other) {
        steps.push({ deviceId: other, stage: 'local', feature: 'interface', verdict: 'ok', text: `${spec.dst} is an address of ${other} (${target.iface}).` });
      } else {
        steps.push({ deviceId: other, stage: 'route', feature: 'routing', verdict: 'ok', text: `${other === 'R2' ? 'LAN2' : 'LAN1'} is directly connected on GigabitEthernet0/0/0.` });
        if (other === 'R1') steps.push({ deviceId: 'SW1', stage: 'switch', feature: 'switching', verdict: 'ok', text: 'SW1 forwards the frame to the PC.' });
      }
    }
    if (!target) return fail(firstRouter, 'routing', `Nothing answers at ${spec.dst}.`, undefined, 'host-unreachable', '.', `No device answers at ${spec.dst}.`);
    const tDev = w.devices[target.deviceId];
    if (tDev?.kind === 'pc' && spec.proto === 'tcp') {
      const svc = tDev as PcDevice;
      const need = spec.dport === 80 ? 'http' : spec.dport === 21 ? 'ftp' : spec.dport === 23 ? 'telnet' : null;
      if (need && !svc.services[need as keyof PcServices])
        return fail(target.deviceId, 'pc', `${label(target.deviceId)} does not run a ${need.toUpperCase()} server. It refuses the connection.`, `Turn the ${need.toUpperCase()} service on in the PC window.`, 'port-closed', 'U', `The packet arrives, but ${label(target.deviceId)} has no ${need.toUpperCase()} server running.`);
    }
    steps.push({ deviceId: target.deviceId, stage: 'deliver', feature: tDev?.kind === 'pc' ? 'pc' : 'verify', verdict: 'ok', text: `${label(target.deviceId)} receives the packet from ${curSrc}.`, header: hdr(spec, curSrc, spec.dst) });
  }

  const fwd = { ok: true, atDeviceId: target?.deviceId, steps, encrypted, qos, received: { src: curSrc, dst: spec.dst, proto: spec.proto, ttl: 62, bytes: spec.bytes ?? 100 } };
  const rsteps: TraceStep[] = [];
  const tId = target?.deviceId ?? from.id;
  rsteps.push({ deviceId: tId, stage: 'origin', feature: 'verify', verdict: 'info', text: `${label(tId)} answers.`, header: hdr(spec, spec.dst, curSrc, true) });
  if (curSrc !== src) rsteps.push({ deviceId: 'R1', stage: 'nat-outside', feature: 'nat', verdict: 'changed', iface: 'Serial0/1/0', text: 'R1 finds the PAT entry and changes the destination back to the PC.', header: hdr(spec, spec.dst, src, true) });
  if (encrypted) rsteps.push({ deviceId: fromA ? 'R2' : 'R1', stage: 'crypto', feature: 'ipsec', verdict: 'changed', iface: 'Serial0/1/0', text: 'The reply matches the mirror entry of ACL 120 and is encrypted too.' });
  rsteps.push({ deviceId: from.id, stage: 'deliver', feature: 'verify', verdict: 'ok', text: `${label(from.id)} gets the reply.`, header: hdr(spec, spec.dst, src, true) });
  const name = spec.proto === 'icmp' ? 'Ping' : describe(spec).split(' ')[0];
  return {
    ok: true, symbol: '!',
    summary: `${name} from ${label(from.id)} to ${spec.dst} works, and the reply comes back.${encrypted ? ' It crossed WAN1 encrypted.' : ''}`,
    forward: fwd,
    reverse: { ok: true, atDeviceId: from.id, steps: rsteps, encrypted, qos: [] },
  };
}
