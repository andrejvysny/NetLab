/**
 * Lab — the single stateful controller between the user interface (through LabApi) and the pure engine.
 *
 * It owns: the open scenario and its World, the terminal sessions (one persistent console session per device, vty
 * sessions opened by `telnet` on a PC), the journal, guided-mode gating, grading, settings and persistence.
 * Everything runs under plain Node: no DOM, no timers. Wall-clock time and storage are injected.
 *
 * STATE. getState() returns the same object until something changes; every action that changes something publishes a
 * new LabState with rev + 1 and tells the subscribers. The World is mutated in place, but state.world is a new top-level
 * object in every new state. One exception to "publish": when the scenario's guideProgress is expensive it is not run
 * after every action but when the state is next read; getState() then returns a newer state (rev + 1 again) without a
 * second notification — the reader already has it, and useSyncExternalStore is happy with that.
 *
 * TERMINALS. A console terminal needs a console cable from a PC's COM port to the device's CON port. Each device has
 * ONE console CLI session that lives as long as the lab: unplugging the cable only closes the terminal view, plugging it
 * back and opening the console resumes where the device was. Console messages (%LINK-…, %LINEPROTO-…, %SYS-5-CONFIG_I)
 * are delivered inside ExecView.output: after the output of the command that caused them, or — when something else
 * caused them (a cable, another device, a config file) — in front of the output of the next line sent to that console
 * (an empty line is enough). Nothing is kept for a console that is not open.
 *
 * AFTER EVERY ACTION (settle): interface states before/after → IOS messages and enabled SNMP link traps; PCs whose DHCP client
 * was started ask again while they have no lease, and lose the lease with the link; guide progress; auto-save; publish.
 *
 * GUIDED MODE stops the student from jumping ahead (see ./lab/guide.ts): finished steps stay finished, and work that
 * belongs to the active step or to any step before it is allowed. Free and exam mode never stop anything.
 *
 * DHCP CLIENTS. A PC asks for an address when it is told to (network settings, `ipconfig /renew`, a pre-built
 * scenario) and keeps asking after every action until it has one. A PC nobody has set up stays quiet, so the first PC
 * that is put on DHCP gets the first free address (the reference plan depends on that).
 *
 * Helpers live in ./lab/: storage.ts (guarded adapter, settings), persist.ts (lab file), guide.ts (step status, gating
 * rule, refusal texts), linkevents.ts (interface up/down messages), fileapply.ts (dry run of config files),
 * validate.ts (input checks).
 */
import type {
  ActionResult, ApplyReport, CommandSheetSection, ExecView, GuideBlock, InputEcho, LabApi, LabState, OpenSessionResult, PcExecView,
  PortStatus, QosLoadResult, QosLoadSpec, SavedLabSummary, ScenarioView, SessionView, SnmpReply, SnmpRequest, UiSettings,
} from './labapi.ts';
import type {
  Cable, CableKind, Device, Feature, FlowResult, FlowSpec, GradeReport, GuideStep, IosDevice, JournalEntry, LabMode, ModeledSnmpTrap, PcDevice,
  PcServices, PcSetup, PortRef, PortSpec, RequirementResult, ScenarioDef, ScenarioInstance, ScenarioSummary, SolutionView, World,
} from './types.ts';
import type { CliSession, ExecOutcome } from './cli/framework.ts';
import {
  completeLine, execLine, helpFor, inspectInput, inspectLine, installCli, interrupt, isConfigMode, pendingInputView, promptFor, startSession,
} from './cli/index.ts';
import { PRESS_RETURN } from './cli/commands/exec.ts';
import { applyConfigText, saveStartupConfig, type ConfigStep } from './config/apply.ts';
import { REDACTED, redactCredentialLine, redactPcCommand, UNSUPPORTED_CREDENTIAL } from './config/credentials.ts';
import { renderConfigLines } from './config/render.ts';
import { addDevice, cloneWorld, createWorld, isIos, isPc, nextId } from './world.ts';
import { isIp } from './ip.ts';
import {
  canPlug, consolePeer, dhcpAcquire, dhcpRelease, emitSnmpTrap, emitSyslog, interfaceState, isUp, linkInfo, portLed, probeFlow,
  qosLoad as simQosLoad, snmpRequest,
} from './sim/index.ts';
import type { PcCmdResult } from './pc/cmd.ts';
import { pcExec as realPcExec } from './pc/cmd.ts';
import { COMMAND_SHEET } from '../content/commandSheet.ts';
import { SCENARIOS } from '../scenarios/index.ts';
import type { LabStorage } from './lab/storage.ts';
import { DEFAULT_SETTINGS, INDEX_KEY, SETTINGS_KEY, SLOT_PREFIX, SafeStore, mergeSettings, sameSettings } from './lab/storage.ts';
import type { SavedLab } from './lab/persist.ts';
import { LAB_FORMAT, LAB_VERSION, parseIndex, parseSavedLab, summaryOf } from './lab/persist.ts';
import type { GateResult } from './lab/guide.ts';
import { advance, blockFor, gate, stepStatuses } from './lab/guide.ts';
import type { IfSnapshot } from './lab/linkevents.ts';
import { consoleLogLine, diffInterfaces, snapshotInterfaces } from './lab/linkevents.ts';
import { classifyConfigFile, replaceEqualsMerge } from './lab/fileapply.ts';
import { CABLE_KINDS, CABLE_WORDS, checkStaticNic, isPortRef } from './lab/validate.ts';

export type { LabStorage } from './lab/storage.ts';

/** Runs one line typed in a PC's command prompt (src/engine/pc/cmd.ts by default). */
export type PcRunner = (world: World, pcId: string, line: string) => PcCmdResult;

export interface LabOptions {
  /** Default: SCENARIOS from src/scenarios/index.ts. */
  scenarios?: ScenarioDef[];
  /** Where settings and saved labs go. null / missing: nothing is saved (state.storage.available = false). */
  storage?: LabStorage | null;
  /** Wall clock in epoch milliseconds. Default: Date.now. */
  now?: () => number;
  /** Replaces src/engine/pc/cmd.ts pcExec (tests). */
  pcExec?: PcRunner;
}

// ───────────────────────────── internal records ─────────────────────────────
interface ConsoleRec {
  deviceId: string;
  /** Session id the UI knows. Stable for the device while the lab runs. */
  id: string;
  /** The device's console EXEC. null: the line is idle (after logout); the next open starts a new EXEC. */
  cli: CliSession | null;
  /** Shown in state.sessions. */
  listed: boolean;
  /** The terminal view is closed (cable unplugged, logout). The device keeps `cli`. */
  closed: boolean;
  pcId: string;
  /** Console text waiting for the terminal: log messages caused by actions elsewhere. */
  queue: string;
}
interface TelnetRec { id: string; deviceId: string; pcId: string; host: string; cli: CliSession }
type SessionRef = { kind: 'console'; rec: ConsoleRec; cli: CliSession } | { kind: 'telnet'; rec: TelnetRec; cli: CliSession };

interface Run {
  def: ScenarioDef;
  instance: ScenarioInstance;
  mode: LabMode;
  seed: number;
  startedAt: number;
  timerMinutes: number | null;
  finished: boolean;
  hintSteps: string[];
  world: World;
  journal: JournalEntry[];
  report: GradeReport | null;
  /** Result of instance.guideProgress (see refreshProgress / progressDirty). */
  progress: Record<string, boolean>;
  /** Guided mode: number of guide steps finished so far. Only ever grows (see lab/guide.ts). */
  reached: number;
  /** The world changed since `progress` was computed. Brought up to date when the state is read or a block is decided. */
  progressDirty: boolean;
  /** Wall-clock milliseconds the last guideProgress call took. */
  progressCost: number;
  /** Fingerprint of what the last guideProgress call looked at ('' = never asked). Same fingerprint, same answer. */
  progressKey: string;
  /** The scenario's guideProgress reads the journal (found out by watching it), so the journal is part of the fingerprint. */
  progressReadsJournal: boolean;
  /** PCs whose DHCP client is switched on: they ask again after every action until they hold a lease. */
  dhcpClients: Set<string>;
  consoles: Map<string, ConsoleRec>;
  telnets: Map<string, TelnetRec>;
}

const MODES: LabMode[] = ['guided', 'free', 'exam'];
const SERVICES: (keyof PcServices)[] = ['http', 'ftp', 'telnet', 'syslog'];
const OK_STATUS = new Set(['ok', 'empty', 'pending']);
const EMPTY_JOURNAL: JournalEntry[] = [];
const EMPTY_EXPORT = JSON.stringify({ format: LAB_FORMAT, version: LAB_VERSION, empty: true });
const QUEUE_MAX = 20000;
/**
 * A scenario's guideProgress may be expensive (it probes the network). When one call takes longer than this, it is no
 * longer run after every single action but once, when the state is next read — so a pasted configuration of a hundred
 * lines costs one progress check, not a hundred.
 */
const LAZY_PROGRESS_MS = 12;
const round1 = (n: number): number => Math.round(n * 10) / 10;
const round2 = (n: number): number => Math.round(n * 100) / 100;

function errText(e: unknown): string { return e instanceof Error ? e.message : String(e); }
function deadView(): ExecView {
  return { output: '', prompt: '', secret: false, closed: true, notes: [], status: 'rejected', echo: { kind: 'hidden' }, pendingInput: null };
}
function emptyReport(): GradeReport {
  return { scenarioId: '', mode: 'free', tick: 0, maxPoints: 0, points: 0, scaled18: 0, requirements: [], orderIssues: [], hardwareNotes: [] };
}
function sameRef(a: PortRef, b: PortRef): boolean { return a.deviceId === b.deviceId && a.port === b.port; }
/** The device with this id — never something inherited from Object.prototype ('constructor', '__proto__' …). */
function deviceOf(world: World | null | undefined, id: unknown): Device | undefined {
  if (!world || typeof id !== 'string' || !Object.prototype.hasOwnProperty.call(world.devices, id)) return undefined;
  return world.devices[id];
}
function specOf(world: World, ref: PortRef): PortSpec | undefined {
  return deviceOf(world, ref.deviceId)?.ports.find((p) => p.name === ref.port);
}
/** Config-file text without the "Building configuration..." / "Current configuration : N bytes" header. */
function stripConfigHeader(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  if (/^Building configuration/.test(lines[0] ?? '')) {
    i = 1;
    while (i < lines.length && lines[i].trim() === '') i++;
    if (/^Current configuration\s*:/.test(lines[i] ?? '')) i++;
  }
  return lines.slice(i).join('\n').replace(/\n*$/, '\n');
}

export class Lab implements LabApi {
  private scenarios: ScenarioDef[];
  private store: SafeStore;
  private clock: () => number;
  private pcRun: PcRunner;
  private listeners = new Set<() => void>();
  /** The user's preferences (bench rules here are defaults for new labs). */
  private settings: UiSettings;
  private saved: SavedLabSummary[] = [];
  private run: Run | null = null;
  /** A CLI configuration session emits at most one config trap on exit, and only after its own edits. */
  private editedConfig = new WeakSet<CliSession>();
  /** Counter for session ids. Never reset, so an id from an earlier lab is never reused. */
  private seq = 0;
  private lastStart = 0;
  /** True while listeners are being told about a new state (they must get exactly that state). */
  private publishing = false;
  private state: LabState;

  constructor(opts: LabOptions = {}) {
    installCli();
    const list = Array.isArray(opts.scenarios) ? opts.scenarios : SCENARIOS;
    this.scenarios = (Array.isArray(list) ? list : []).filter((s) => !!s && !!s.summary && typeof s.summary.id === 'string' && typeof s.build === 'function');
    this.store = new SafeStore(opts.storage);
    this.clock = typeof opts.now === 'function' ? opts.now : () => Date.now();
    this.pcRun = typeof opts.pcExec === 'function' ? opts.pcExec : realPcExec;
    let rawSettings: unknown = null;
    try { rawSettings = JSON.parse(this.store.get(SETTINGS_KEY) ?? 'null'); } catch { rawSettings = null; }
    this.settings = mergeSettings(DEFAULT_SETTINGS, rawSettings);
    this.saved = this.loadIndex();
    this.state = this.buildState(0);
  }

  // ═════════════════════════════ state ═════════════════════════════
  getState = (): LabState => {
    const run = this.run;
    if (run && run.progressDirty && !this.publishing) this.guard(undefined, () => this.flushProgress(run));
    return this.state;
  };
  subscribe = (listener: () => void): (() => void) => {
    if (typeof listener !== 'function') return () => undefined;
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** Run `fn`; anything it throws becomes `fallback` (no LabApi method may throw). */
  private guard<T>(fallback: T, fn: () => T): T {
    try { return fn(); } catch (e) {
      try { if (typeof console !== 'undefined') console.error('[lab]', e); } catch { /* ignore */ }
      return fallback;
    }
  }
  private now(): number {
    try { const t = this.clock(); return Number.isFinite(t) ? t : 0; } catch { return 0; }
  }

  private publish(): void {
    this.state = this.buildState(this.state.rev + 1);
    const outer = this.publishing;
    this.publishing = true;
    try {
      for (const l of [...this.listeners]) { try { l(); } catch { /* a broken listener must not stop the lab */ } }
    } finally {
      this.publishing = outer;
    }
  }
  private buildState(rev: number): LabState {
    const run = this.run;
    return {
      rev,
      scenario: run ? this.scenarioView(run) : null,
      world: run ? { ...run.world } : null,
      sessions: run ? this.sessionViews(run) : [],
      journal: run ? run.journal : EMPTY_JOURNAL,
      report: run ? run.report : null,
      settings: this.effectiveSettings(),
      storage: { available: this.store.available, saved: this.store.available ? [...this.saved].sort((a, b) => b.savedAt - a.savedAt) : [] },
    };
  }
  /** Preferences, with the active world's bench rules when a lab is open. */
  private effectiveSettings(run = this.run): UiSettings {
    if (!run) return { ...this.settings };
    return {
      ...this.settings,
      strictCables: run.world.settings.strictCables,
      qosClassifiesInnerHeader: run.world.settings.qosClassifiesInnerHeader,
    };
  }
  private scenarioView(run: Run): ScenarioView {
    const inst = run.instance;
    const guide = Array.isArray(inst.guide) ? inst.guide : [];
    const status = run.mode === 'exam' ? [] : stepStatuses(guide, run.progress, run.mode, run.reached);
    return {
      summary: inst.summary ?? run.def.summary,
      seed: run.seed,
      mode: run.mode,
      brief: inst.brief,
      diagram: inst.diagram,
      requirements: Array.isArray(inst.requirements) ? inst.requirements : [],
      guide: run.mode === 'exam' ? [] : guide.map((g, i) => ({ ...g, status: status[i] })),
      startedAt: run.startedAt,
      timerMinutes: run.timerMinutes,
      finished: run.finished,
      hintsUsed: run.hintSteps.length,
    };
  }

  // ═════════════════════════════ scenarios ═════════════════════════════
  listScenarios(): ScenarioSummary[] {
    return this.guard<ScenarioSummary[]>([], () => this.scenarios.map((s) => ({ ...s.summary })));
  }

  startScenario(id: string, mode: LabMode, opts?: { seed?: number; timerMinutes?: number | null }): ActionResult {
    return this.startFreshScenario(id, mode, opts);
  }

  private startFreshScenario(id: string, mode: LabMode, opts: Parameters<LabApi['startScenario']>[2], restartQos?: boolean): ActionResult {
    return this.guard<ActionResult>({ ok: false, message: 'The lab could not start. Try again.' }, () => {
      const def = this.scenarios.find((s) => s.summary.id === id);
      if (!def) return { ok: false, message: `There is no assignment called "${String(id)}".` };
      if (!MODES.includes(mode)) return { ok: false, message: 'Choose a mode: guided, free or exam.' };
      const seed = typeof opts?.seed === 'number' && Number.isFinite(opts.seed) ? Math.floor(opts.seed) : 0;
      const t = opts?.timerMinutes;
      const timerMinutes = typeof t === 'number' && Number.isFinite(t) && t > 0 ? t : null;
      let instance: ScenarioInstance;
      try { instance = def.build(seed); } catch (e) {
        return { ok: false, message: `This assignment could not be set up: ${errText(e)}` };
      }
      if (!instance || !Array.isArray(instance.bench)) return { ok: false, message: 'This assignment has no bench. It cannot be started.' };
      if (this.run) this.saveRun(this.run);
      const dhcpClients = new Set<string>();
      const world = this.buildWorld(instance, dhcpClients, restartQos);
      const run: Run = {
        def, instance, mode, seed, startedAt: this.freshStart(this.now()), timerMinutes, finished: false, hintSteps: [],
        world, journal: [], report: null, progress: {}, reached: 0, progressDirty: false, progressCost: 0, progressKey: '', progressReadsJournal: true,
        dhcpClients, consoles: new Map(), telnets: new Map(),
      };
      this.run = run;
      this.refreshProgress(run);
      this.saveRun(run);
      this.publish();
      return { ok: true };
    });
  }

  restartScenario(): void {
    this.guard(undefined, () => {
      const run = this.run;
      if (!run) return;
      this.startFreshScenario(run.def.summary.id, run.mode, { seed: run.seed, timerMinutes: run.timerMinutes }, run.world.settings.qosClassifiesInnerHeader);
    });
  }

  leaveScenario(): void {
    this.guard(undefined, () => {
      const run = this.run;
      if (!run) return;
      this.saveRun(run);
      this.run = null;
      this.publish();
    });
  }

  /** startedAt doubles as the UI's "this is a new bench" key, so a new start never repeats the value before it. */
  private freshStart(t: number): number {
    const v = t === this.lastStart ? t + 1 : t;
    this.lastStart = v;
    return v;
  }

  /** The bench of a scenario with its pre-built parts. Nothing here is journaled. */
  private buildWorld(instance: ScenarioInstance, dhcpClients: Set<string>, restartQos?: boolean): World {
    const init = instance.initial;
    const initialQos = init?.settings?.qosClassifiesInnerHeader;
    const world = createWorld({
      strictCables: this.settings.strictCables,
      qosClassifiesInnerHeader: restartQos ?? (typeof initialQos === 'boolean' ? initialQos : this.settings.qosClassifiesInnerHeader),
    });
    for (const seed of instance.bench) {
      if (seed && typeof seed.id === 'string' && !deviceOf(world, seed.id)) addDevice(world, seed);
    }
    if (!init) return world;
    if (typeof init.settings?.strictCables === 'boolean') world.settings.strictCables = init.settings.strictCables;
    for (const c of init.cables ?? []) {
      if (!c || !CABLE_KINDS.includes(c.kind) || !isPortRef(c.a) || !isPortRef(c.b)) continue;
      if (!canPlug(world, c.kind, c.a, c.b).ok) continue;
      world.cables.push(this.makeCable(world, c.kind, c.a, c.b, c.dceEnd));
    }
    for (const [deviceId, text] of Object.entries(init.configs ?? {})) {
      if (!isIos(deviceOf(world, deviceId)) || typeof text !== 'string') continue;
      applyConfigText(world, deviceId, text, 'merge');
      // A device that comes configured has that configuration saved: a reload must not wipe the assignment.
      saveStartupConfig(world, deviceId);
    }
    for (const [pcId, setup] of Object.entries(init.pcs ?? {})) this.applyPcSetup(world, pcId, setup, dhcpClients);
    // In a pre-built network every PC that is set to DHCP is already asking for an address.
    const prebuilt = (init.cables ?? []).length > 0 || Object.keys(init.configs ?? {}).length > 0;
    if (prebuilt) {
      for (const id of world.order) { const d = world.devices[id]; if (isPc(d) && d.nic.mode === 'dhcp') dhcpClients.add(id); }
    }
    for (const id of world.order) {
      if (!dhcpClients.has(id)) continue;
      try { dhcpAcquire(world, id); } catch { /* the PC keeps asking later */ }
    }
    return world;
  }
  private applyPcSetup(world: World, pcId: string, setup: PcSetup, dhcpClients: Set<string>): void {
    const pc = deviceOf(world, pcId);
    if (!isPc(pc) || !setup) return;
    if (setup.services) {
      for (const k of SERVICES) { const v = setup.services[k]; if (typeof v === 'boolean') pc.services[k] = v; }
    }
    if (setup.mode === 'static') {
      pc.nic = { mode: 'static', mac: pc.nic.mac };
      if (typeof setup.address === 'string' && setup.address) pc.nic.address = setup.address;
      if (typeof setup.mask === 'string' && setup.mask) pc.nic.mask = setup.mask;
      if (typeof setup.gateway === 'string' && setup.gateway) pc.nic.gateway = setup.gateway;
      dhcpClients.delete(pcId);
    } else if (setup.mode === 'dhcp') {
      pc.nic = { mode: 'dhcp', mac: pc.nic.mac };
      dhcpClients.add(pcId);
    }
  }
  private makeCable(world: World, kind: CableKind, a: PortRef, b: PortRef, dceEnd?: 'a' | 'b'): Cable {
    const cable: Cable = { id: `cable-${nextId(world)}`, kind, a: { deviceId: a.deviceId, port: a.port }, b: { deviceId: b.deviceId, port: b.port } };
    if (kind === 'serial') cable.dceEnd = dceEnd === 'b' ? 'b' : 'a';
    return cable;
  }

  // ═════════════════════════════ shared machinery ═════════════════════════════
  private label(run: Run, deviceId: string): string { return deviceOf(run.world, deviceId)?.label ?? String(deviceId); }
  private portText(run: Run, ref: PortRef): string { return `${this.label(run, ref.deviceId)} ${ref.port}`; }

  /** Append to the journal (a new array each time). Entries stay plain JSON: optional fields are left out, not undefined. */
  private addJournal(run: Run, ...entries: JournalEntry[]): void {
    const clean = entries.map((e) => {
      const c: JournalEntry = { ...e };
      if (c.via !== 'bench') c.line = c.via === 'pc' ? redactPcCommand(c.line) : redactCredentialLine(c.line);
      if (c.mode === undefined) delete c.mode;
      if (c.blocked === undefined) delete c.blocked;
      if (c.stepId === undefined) delete c.stepId;
      return c;
    });
    if (clean.length) run.journal = [...run.journal, ...clean];
  }
  /** Id of the step the student is on (guided mode), for journal entries. */
  private stepId(run: Run): string | undefined {
    if (run.mode !== 'guided') return undefined;
    return (run.instance.guide ?? [])[run.reached]?.id;
  }
  /** Guided mode only: the refusal for an action of this feature on these devices, or null when it may run. */
  private refusal(run: Run, feature: Feature, deviceIds: string[]): Extract<GateResult, { allowed: false }> | null {
    if (run.mode !== 'guided') return null;
    let r = gate(run.instance.guide ?? [], run.reached, feature, deviceIds);
    if (!r.allowed && run.progressDirty) {
      // Never refuse on old news: the step may have been finished by the action just before.
      this.refreshProgress(run);
      r = gate(run.instance.guide ?? [], run.reached, feature, deviceIds);
    }
    return r.allowed ? null : r;
  }
  private blockText(run: Run, r: Extract<GateResult, { allowed: false }>, what: string, feature: Feature, deviceId: string, nothing = 'Nothing was changed.'): GuideBlock {
    return blockFor(r, {
      what, feature, deviceLabel: this.label(run, deviceId),
      stepDeviceLabels: r.active.devices.map((d) => this.label(run, d)), nothing,
    });
  }

  /**
   * What guideProgress depends on: the network (everything except the logical clock) and, when the scenario reads it,
   * the journal. guideProgress is pure, so an unchanged fingerprint means an unchanged answer — looking around with show
   * commands or moving between CLI modes never costs a progress check.
   */
  private progressFingerprint(run: Run): string {
    try {
      const { tick: _tick, ...rest } = run.world;
      void _tick;
      return JSON.stringify(rest) + (run.progressReadsJournal ? `#${run.journal.length}` : '');
    } catch {
      return '';
    }
  }
  /** Ask the scenario which guide steps are satisfied now. */
  private refreshProgress(run: Run): void {
    run.progressDirty = false;
    const guide = run.instance.guide;
    if (run.mode === 'exam' || !Array.isArray(guide) || guide.length === 0) { run.progress = {}; return; }
    const key = this.progressFingerprint(run);
    if (key !== '' && key === run.progressKey) return;
    const t0 = this.now();
    try {
      // On copies: a progress check that sends test traffic must never touch the student's network or journal.
      let read = false;
      const watched = new Proxy(run.journal.slice(), { get(target, prop, receiver) { read = true; return Reflect.get(target, prop, receiver); } });
      let p: Record<string, boolean>;
      try {
        p = run.instance.guideProgress(cloneWorld(run.world), watched);
      } catch {
        // Perhaps the scenario cannot work with the watched journal (structuredClone …): once more with a plain array.
        read = true;
        p = run.instance.guideProgress(cloneWorld(run.world), run.journal.slice());
      }
      run.progressReadsJournal = read;
      if (p && typeof p === 'object') {
        const next: Record<string, boolean> = {};
        for (const g of guide) next[g.id] = p[g.id] === true;
        run.progress = next;
        if (run.mode === 'guided') run.reached = advance(guide, next, run.reached);
      }
      run.progressKey = this.progressFingerprint(run);
    } catch {
      // keep the last known progress; ask again next time
      run.progressKey = '';
    }
    run.progressCost = Math.max(0, this.now() - t0);
  }
  /** After an action: a cheap progress check runs at once, an expensive one waits until the state is read. */
  private progressAfterAction(run: Run): void {
    if (run.mode === 'exam') return;
    if (run.progressCost > LAZY_PROGRESS_MS) run.progressDirty = true;
    else this.refreshProgress(run);
  }
  /** Bring a postponed progress check up to date; a new state object only when a step status really changed. */
  private flushProgress(run: Run): void {
    if (!run.progressDirty) return;
    const before = run.progress;
    const reached = run.reached;
    this.refreshProgress(run);
    const after = run.progress;
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    let changed = reached !== run.reached;
    for (const k of keys) if (before[k] !== after[k]) changed = true;
    if (changed) this.state = this.buildState(this.state.rev + 1);
  }

  /** A device logs a message: buffer + logging hosts, and the attached console terminal shows it. */
  private log(run: Run, deviceId: string, severity: number, mnemonic: string, text: string, delay = 0): void {
    try { emitSyslog(run.world, deviceId, severity, mnemonic, text); } catch { /* the message is only lost */ }
    const rec = run.consoles.get(deviceId);
    if (rec && rec.listed && !rec.closed && rec.cli && !rec.cli.closed) {
      rec.queue += consoleLogLine(run.world.tick, mnemonic, text, delay);
      if (rec.queue.length > QUEUE_MAX) rec.queue = rec.queue.slice(rec.queue.indexOf('\n', rec.queue.length - QUEUE_MAX) + 1);
    }
  }
  private notifyTrap(run: Run, deviceId: string, type: ModeledSnmpTrap, text: string): void {
    try { emitSnmpTrap(run.world, deviceId, type, text); } catch { /* a notification cannot undo the action */ }
  }
  private takeQueue(rec: ConsoleRec): string {
    const q = rec.queue;
    rec.queue = '';
    return q;
  }

  /** PCs on DHCP: a lease is lost with the link; a PC without a lease asks again (a real PC keeps asking). */
  private dhcpPass(run: Run): void {
    const world = run.world;
    for (const id of world.order) {
      const pc = world.devices[id];
      if (!isPc(pc) || pc.nic.mode !== 'dhcp') continue;
      const eth = pc.ports.find((p) => p.kind === 'ethernet');
      const up = !!eth && isUp(world, id, eth.name);
      if (pc.nic.address && !up) {
        delete pc.nic.address; delete pc.nic.mask; delete pc.nic.gateway; delete pc.nic.dns; delete pc.nic.dhcpServer;
        continue;
      }
      if (!pc.nic.address && up && run.dhcpClients.has(id)) {
        try { dhcpAcquire(world, id); } catch { /* try again after the next action */ }
      }
    }
  }

  /** After every action that may have changed the world: link messages, DHCP, guide progress, save, publish. */
  private settle(run: Run, before: IfSnapshot): void {
    try {
      const after = snapshotInterfaces(run.world);
      for (const m of diffInterfaces(run.world, before, after)) {
        this.log(run, m.deviceId, m.severity, m.mnemonic, m.text, m.delay);
        if (m.trapType) this.notifyTrap(run, m.deviceId, m.trapType, m.text);
      }
    } catch { /* messages are cosmetic */ }
    try { this.dhcpPass(run); } catch { /* ignore */ }
    this.progressAfterAction(run);
    this.saveRun(run);
    this.publish();
  }

  // ═════════════════════════════ bench ═════════════════════════════
  moveDevice(deviceId: string, x: number, y: number): void {
    this.guard(undefined, () => {
      const run = this.run;
      const d = deviceOf(run?.world, deviceId);
      if (!run || !d || typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return;
      if (d.x === x && d.y === y) return;
      d.x = x; d.y = y;
      this.saveRun(run);
      this.publish();
    });
  }

  connectCable(kind: CableKind, a: PortRef, b: PortRef, opts?: { dceEnd?: 'a' | 'b' }): ActionResult {
    return this.guard<ActionResult>({ ok: false, message: 'The cable could not be plugged in.' }, () => {
      const run = this.run;
      if (!run) return { ok: false, message: 'No lab is open.' };
      if (!CABLE_KINDS.includes(kind)) return { ok: false, message: 'Pick a cable first: Ethernet straight-through, Ethernet crossover, serial or console.' };
      if (!isPortRef(a) || !isPortRef(b)) return { ok: false, message: 'A cable needs two ports. Click one port, then the other.' };
      const world = run.world;
      if (!specOf(world, a) || !specOf(world, b)) return { ok: false, message: 'That port does not exist.' };
      if (sameRef(a, b)) return { ok: false, message: 'Both ends are the same port. A cable needs two different ports.' };
      const plug = canPlug(world, kind, a, b);
      if (!plug.ok) return { ok: false, message: plug.problem ?? 'This cable does not fit these ports.' };
      const feature: Feature = kind === 'console' ? 'console' : 'cabling';
      const dceEnd = opts?.dceEnd === 'b' ? 'b' : 'a';
      const line = `Plug in ${CABLE_WORDS[kind]} cable: ${this.portText(run, a)} to ${this.portText(run, b)}`
        + (kind === 'serial' ? ` (DCE end at ${this.portText(run, dceEnd === 'a' ? a : b)})` : '');
      const no = this.refusal(run, feature, [a.deviceId, b.deviceId]);
      if (no) {
        const blocked = this.blockText(run, no, `You tried to plug in a cable: ${this.portText(run, a)} to ${this.portText(run, b)}.`, feature, a.deviceId, 'The cable was not plugged in.');
        this.addJournal(run, { tick: world.tick, deviceId: a.deviceId, via: 'bench', line, feature, ok: false, mutated: false, blocked: true, stepId: no.active.id });
        this.publish();
        return { ok: false, message: blocked.reason, blocked };
      }
      const before = snapshotInterfaces(world);
      world.tick++;
      world.cables.push(this.makeCable(world, kind, a, b, dceEnd));
      this.addJournal(run, { tick: world.tick, deviceId: a.deviceId, via: 'bench', line, feature, ok: true, mutated: true, stepId: this.stepId(run) });
      this.settle(run, before);
      // In the exam nobody tells you that the cable is the wrong one.
      return plug.warning && run.mode !== 'exam' ? { ok: true, message: plug.warning } : { ok: true };
    });
  }

  removeCable(cableId: string): ActionResult {
    return this.guard<ActionResult>({ ok: false, message: 'The cable could not be unplugged.' }, () => {
      const run = this.run;
      if (!run) return { ok: false, message: 'No lab is open.' };
      const world = run.world;
      const cable = world.cables.find((c) => c.id === cableId);
      if (!cable) return { ok: false, message: 'That cable is not on the bench any more.' };
      const feature: Feature = cable.kind === 'console' ? 'console' : 'cabling';
      const line = `Unplug ${CABLE_WORDS[cable.kind]} cable: ${this.portText(run, cable.a)} to ${this.portText(run, cable.b)}`;
      const no = this.refusal(run, feature, [cable.a.deviceId, cable.b.deviceId]);
      if (no) {
        const blocked = this.blockText(run, no, `You tried to unplug a cable: ${this.portText(run, cable.a)} to ${this.portText(run, cable.b)}.`, feature, cable.a.deviceId, 'The cable stays where it is.');
        this.addJournal(run, { tick: world.tick, deviceId: cable.a.deviceId, via: 'bench', line, feature, ok: false, mutated: false, blocked: true, stepId: no.active.id });
        this.publish();
        return { ok: false, message: blocked.reason, blocked };
      }
      const before = snapshotInterfaces(world);
      world.tick++;
      world.cables = world.cables.filter((c) => c.id !== cableId);
      // A console terminal loses its line; the device keeps its console state for the next connection.
      for (const rec of run.consoles.values()) {
        if (rec.listed && !rec.closed && consolePeer(world, rec.deviceId) === null) { rec.closed = true; rec.queue = ''; }
      }
      this.addJournal(run, { tick: world.tick, deviceId: cable.a.deviceId, via: 'bench', line, feature, ok: true, mutated: true, stepId: this.stepId(run) });
      this.settle(run, before);
      return { ok: true };
    });
  }

  portStatus(ref: PortRef): PortStatus {
    const fallback: PortStatus = { ref, kind: 'ethernet', led: 'off' };
    return this.guard<PortStatus>(fallback, () => {
      const run = this.run;
      if (!run || !isPortRef(ref)) return fallback;
      const world = run.world;
      const spec = specOf(world, ref);
      if (!spec) return fallback;
      const exam = run.mode === 'exam';
      const link = linkInfo(world, ref);
      const st: PortStatus = { ref, kind: spec.kind, led: portLed(world, ref) };
      if (link.cable) { st.cableId = link.cable.id; st.cableKind = link.cable.kind; }
      if (link.dce !== undefined) st.dce = link.dce;
      if (spec.kind === 'ethernet' || spec.kind === 'serial') {
        const s = interfaceState(world, ref.deviceId, ref.port);
        st.status = `${s.status}/${s.protocol}`;
        if (link.cabled && s.problem && !exam) st.problem = s.problem;
      } else if (link.cabled && !link.usable && link.problem && !exam) {
        st.problem = link.problem;
      }
      return st;
    });
  }

  // ═════════════════════════════ terminals ═════════════════════════════
  consoleTargetOf(pcId: string): string | null {
    return this.guard<string | null>(null, () => {
      const world = this.run?.world;
      if (!world || !isPc(deviceOf(world, pcId))) return null;
      const peer = consolePeer(world, pcId);
      return peer && isIos(deviceOf(world, peer)) ? peer : null;
    });
  }
  consolePcOf(deviceId: string): string | null {
    return this.guard<string | null>(null, () => {
      const world = this.run?.world;
      if (!world || !isIos(deviceOf(world, deviceId))) return null;
      const peer = consolePeer(world, deviceId);
      return peer && isPc(deviceOf(world, peer)) ? peer : null;
    });
  }

  /** Why no terminal can be opened on this device, naming exactly what to plug where. */
  private consoleHelp(run: Run, dev: IosDevice): string {
    const world = run.world;
    const name = dev.label;
    const con = dev.ports.find((p) => p.kind === 'console');
    const fix = `Plug a Console (rollover) cable from the COM1 port of a PC into the CON port of ${name}. Then open ${name} again.`;
    if (con) {
      const link = linkInfo(world, { deviceId: dev.id, port: con.name });
      if (link.cable && link.cable.kind !== 'console') {
        return `The cable in the CON port of ${name} is an Ethernet cable. It cannot carry the console. Unplug it. ${fix}`;
      }
    }
    for (const c of world.cables) {
      if (c.kind !== 'console') continue;
      const mine = c.a.deviceId === dev.id ? c.a : c.b.deviceId === dev.id ? c.b : null;
      if (!mine) continue;
      const other = mine === c.a ? c.b : c.a;
      if (specOf(world, mine)?.kind !== 'console') {
        return `The console cable from ${this.portText(run, other)} is plugged into ${mine.port} of ${name}. That is not the console port. Move that end to the port marked CON. Then open ${name} again.`;
      }
    }
    return `No console cable is plugged into ${name}. ${fix}`;
  }
  private noConsoleComment(name: string): string {
    return `! No console cable is connected to ${name}.\n! Plug a Console (rollover) cable from the COM1 port of a PC into the CON port of ${name}.\n! Then load the configuration again.\n`;
  }

  private consoleView(run: Run, rec: ConsoleRec): SessionView {
    const world = run.world;
    const dev = deviceOf(world, rec.deviceId);
    const pc = deviceOf(world, rec.pcId);
    const com = pc?.ports.find((p) => p.kind === 'rs232')?.short ?? 'COM1';
    const live = !rec.closed && !!rec.cli && !rec.cli.closed;
    return {
      id: rec.id, deviceId: rec.deviceId, kind: 'console', pcId: rec.pcId,
      title: `${dev?.label ?? rec.deviceId} — console (${pc?.label ?? rec.pcId} ${com}, 9600 8N1)`,
      prompt: live && rec.cli ? this.promptOf(world, rec.cli) : '',
      secret: live && !!rec.cli?.pending?.secret,
      closed: !live,
      termLength: rec.cli?.termLength,
      pendingInput: live && rec.cli ? pendingInputView(rec.cli) : null,
    };
  }
  private telnetView(run: Run, rec: TelnetRec): SessionView {
    return {
      id: rec.id, deviceId: rec.deviceId, kind: 'telnet', pcId: rec.pcId,
      title: `Telnet ${rec.host} — from ${this.label(run, rec.pcId)}`,
      prompt: rec.cli.closed ? '' : this.promptOf(run.world, rec.cli),
      secret: !rec.cli.closed && !!rec.cli.pending?.secret,
      closed: rec.cli.closed,
      termLength: rec.cli.termLength,
      pendingInput: pendingInputView(rec.cli),
    };
  }
  private promptOf(world: World, cli: CliSession): string {
    try { return promptFor(world, cli); } catch { return ''; }
  }
  private sessionViews(run: Run): SessionView[] {
    const out: SessionView[] = [];
    for (const rec of run.consoles.values()) if (rec.listed) out.push(this.consoleView(run, rec));
    for (const rec of run.telnets.values()) out.push(this.telnetView(run, rec));
    return out;
  }
  private findSession(run: Run, sessionId: string): SessionRef | null {
    const t = run.telnets.get(sessionId);
    if (t) return t.cli.closed ? null : { kind: 'telnet', rec: t, cli: t.cli };
    for (const rec of run.consoles.values()) {
      if (rec.id !== sessionId) continue;
      if (!rec.listed || rec.closed || !rec.cli || rec.cli.closed) return null;
      return { kind: 'console', rec, cli: rec.cli };
    }
    return null;
  }

  openConsole(deviceId: string): OpenSessionResult {
    return this.guard<OpenSessionResult>({ ok: false, message: 'The console could not be opened.' }, () => {
      const run = this.run;
      if (!run) return { ok: false, message: 'No lab is open.' };
      const world = run.world;
      const dev = deviceOf(world, deviceId);
      if (!dev) return { ok: false, message: 'That device is not on the bench.' };
      if (!isIos(dev)) return { ok: false, message: `${dev.label} is a PC. It has no console port. Open the PC itself.` };
      const peer = consolePeer(world, deviceId);
      const pcId = peer && isPc(deviceOf(world, peer)) ? peer : null;
      if (!pcId) return { ok: false, message: this.consoleHelp(run, dev) };
      let rec = run.consoles.get(deviceId);
      if (!rec) {
        rec = { deviceId, id: `con${++this.seq}`, cli: null, listed: false, closed: true, pcId, queue: '' };
        run.consoles.set(deviceId, rec);
      }
      let banner = '';
      let fresh = false;
      if (!rec.cli || rec.cli.closed) {
        // A new EXEC on the console line: the initial dialog on a factory-fresh device, otherwise banner and login.
        const started = startSession(world, deviceId, 'console', { id: rec.id });
        rec.cli = started.session;
        const out = started.outcome.output;
        banner = /System Configuration Dialog/.test(out) ? out : `\n${dev.config.hostname} con0 is now available\n\n\n\nPress RETURN to get started.\n\n${out}`;
        for (const n of started.outcome.notes) banner += `[Simulator note] ${n}\n`;
        fresh = true;
      }
      if (!fresh && rec.listed && !rec.closed) {
        // Already open: the same session, nothing new to show.
        if (rec.pcId !== pcId) { rec.pcId = pcId; this.publish(); }
        return { ok: true, session: this.consoleView(run, rec), banner: '' };
      }
      rec.pcId = pcId;
      rec.listed = true;
      rec.closed = false;
      rec.queue = '';
      this.publish();
      return { ok: true, session: this.consoleView(run, rec), banner };
    });
  }

  sessionExec(sessionId: string, line: string): ExecView {
    return this.guard<ExecView>(deadView(), () => {
      const run = this.run;
      const ref = run ? this.findSession(run, sessionId) : null;
      if (!run || !ref) return deadView();
      const world = run.world;
      const cli = ref.cli;
      const deviceId = cli.deviceId;
      const dev = world.devices[deviceId];
      if (!isIos(dev)) return deadView();
      if (ref.kind === 'console' && consolePeer(world, deviceId) === null) {
        ref.rec.closed = true;
        this.publish();
        return deadView();
      }
      const raw = typeof line === 'string' ? line.replace(/[\r\n]+/g, ' ') : '';
      const wasPending = !!cli.pending;
      const modeBefore = cli.mode;
      const input = inspectInput(dev, cli, raw);
      const auditLine = input.echo.kind === 'hidden' ? REDACTED : input.echo.text.trim();
      const stopped = (status: 'blocked' | 'rejected', output: string): ExecView => ({
        output, status, echo: input.echo, prompt: this.promptOf(world, cli), secret: !!cli.pending?.secret,
        closed: cli.closed, notes: [], termLength: cli.termLength, pendingInput: pendingInputView(cli),
      });

      // Guided mode: a state-changing line must belong to the step the student is on.
      let pre: { status: string; feature: Feature; mutates: boolean } = { status: 'invalid', feature: 'system', mutates: false };
      try { pre = inspectLine(world, cli, raw); } catch { /* the line will fail when it runs */ }
      if (pre.status === 'ok' && pre.mutates) {
        const no = this.refusal(run, pre.feature, [deviceId]);
        if (no) {
          const blocked = this.blockText(run, no, `You typed "${auditLine}"${no.wrongDevice ? ` on ${dev.label}` : ''}.`, pre.feature, deviceId);
          this.addJournal(run, {
            tick: world.tick, deviceId, via: cli.via, mode: modeBefore, line: auditLine, feature: pre.feature,
            ok: false, mutated: false, blocked: true, stepId: no.active.id,
          });
          this.publish();
          return { ...stopped('blocked', ''), blocked };
        }
      }

      if (input.unsupportedCredential) {
        this.addJournal(run, { tick: world.tick, deviceId, via: cli.via, mode: modeBefore, line: auditLine, feature: pre.feature,
          ok: false, mutated: false, stepId: this.stepId(run) });
        this.saveRun(run);
        this.publish();
        return stopped('rejected', UNSUPPORTED_CREDENTIAL);
      }

      const before = snapshotInterfaces(world);
      const runtimeBefore = dev.runtime;
      const configBefore = isConfigMode(modeBefore) && pre.mutates && !this.editedConfig.has(cli) ? JSON.stringify(dev.config) : undefined;
      const early = ref.kind === 'console' ? this.takeQueue(ref.rec) : '';
      let outcome: ExecOutcome;
      try { outcome = execLine(world, cli, raw); } catch {
        outcome = {
          output: '% The simulator could not run this command.\n', prompt: this.promptOf(world, cli), secret: !!cli.pending?.secret,
          status: 'rejected', feature: pre.feature, mutated: false, closed: cli.closed, notes: [],
          termLength: cli.termLength, pendingInput: pendingInputView(cli), echo: input.echo,
        };
      }
      if (!wasPending && outcome.echo.kind === 'redacted' && !OK_STATUS.has(outcome.status)) {
        outcome.output = '% Credential command was rejected. Review the arguments.\n';
      }
      if (!wasPending && outcome.status === 'empty' && !early) return this.execView(outcome);
      if (!wasPending && outcome.status !== 'empty') {
        this.addJournal(run, {
          tick: world.tick, deviceId, via: cli.via, mode: modeBefore, line: auditLine, feature: outcome.feature,
          ok: OK_STATUS.has(outcome.status), mutated: outcome.mutated, stepId: this.stepId(run),
        });
      }
      if (configBefore !== undefined && OK_STATUS.has(outcome.status) && JSON.stringify(dev.config) !== configBefore) this.editedConfig.add(cli);
      this.afterCliStep(run, ref, modeBefore, runtimeBefore);
      this.settle(run, before);
      return this.execView(outcome, early + outcome.output + (ref.kind === 'console' ? this.takeQueue(ref.rec) : ''));
    });
  }

  private execView(outcome: ExecOutcome, output = outcome.output): ExecView {
    const { prompt, secret, closed, notes, status, echo, termLength, pendingInput, delayMs } = outcome;
    return { output, prompt, secret, closed, notes, status, echo, termLength, pendingInput, ...(delayMs ? { delayMs } : {}) };
  }

  sessionInputEcho(sessionId: string, line: string): InputEcho {
    return this.guard<InputEcho>({ kind: 'hidden' }, () => {
      const run = this.run;
      const ref = run ? this.findSession(run, sessionId) : null;
      const dev = ref ? run?.world.devices[ref.cli.deviceId] : undefined;
      return ref && isIos(dev) ? inspectInput(dev, ref.cli, typeof line === 'string' ? line : '').echo : { kind: 'hidden' };
    });
  }

  /** Bookkeeping after a CLI line or control key: leaving configuration mode, reload, closed sessions. */
  private afterCliStep(run: Run, ref: SessionRef, modeBefore: CliSession['mode'], runtimeBefore: IosDevice['runtime']): void {
    const world = run.world;
    const cli = ref.cli;
    const deviceId = cli.deviceId;
    const dev = world.devices[deviceId];
    const reloaded = isIos(dev) && dev.runtime !== runtimeBefore;
    if (!reloaded && !cli.closed && isConfigMode(modeBefore) && !isConfigMode(cli.mode)) {
      const by = ref.kind === 'console' ? 'console' : `vty0 (${cli.remoteAddr ?? 'unknown'})`;
      const text = `Configured from console by ${by}`;
      this.log(run, deviceId, 5, 'SYS-5-CONFIG_I', text);
      if (this.editedConfig.delete(cli)) this.notifyTrap(run, deviceId, 'config', text);
    }
    if (reloaded || cli.closed) this.editedConfig.delete(cli);
    if (reloaded && isIos(dev)) this.afterReload(run, dev, ref);
    if (cli.closed) {
      if (ref.kind === 'telnet') {
        run.telnets.delete(ref.rec.id);
        if (!reloaded && isIos(dev)) dev.runtime.vtyInUse = Math.max(0, dev.runtime.vtyInUse - 1);
      } else {
        // Logout on the console: the line is idle until someone presses RETURN (opens it again).
        ref.rec.cli = null;
        ref.rec.closed = true;
      }
    }
  }

  /** The device restarted: every other session on it is gone and its console starts from the beginning. */
  private afterReload(run: Run, dev: IosDevice, issuer: SessionRef): void {
    const world = run.world;
    for (const t of [...run.telnets.values()]) {
      if (t.deviceId !== dev.id) continue;
      t.cli.closed = true;
      t.cli.pending = undefined;
      if (t !== issuer.rec) run.telnets.delete(t.id);
    }
    dev.runtime.vtyInUse = 0;
    const rec = run.consoles.get(dev.id);
    if (!rec || (issuer.kind === 'console' && issuer.rec === rec)) return; // the CLI already restarted the issuing console
    const attached = rec.listed && !rec.closed && consolePeer(world, dev.id) !== null;
    if (!attached) { rec.cli = null; rec.queue = ''; return; }
    const started = startSession(world, dev.id, 'console', { id: rec.id });
    rec.cli = started.session;
    rec.queue = `\n%SYS-5-RELOAD: Reload requested by vty0 (${issuer.cli.remoteAddr ?? 'unknown'}). Reload Reason: Reload Command.\n`
      + (dev.startupConfig !== null ? PRESS_RETURN : '') + started.outcome.output;
  }

  sessionHelp(sessionId: string, line: string): string {
    return this.guard('', () => {
      const run = this.run;
      const ref = run ? this.findSession(run, sessionId) : null;
      if (!run || !ref) return '';
      return helpFor(run.world, ref.cli, typeof line === 'string' ? line : '');
    });
  }

  sessionComplete(sessionId: string, line: string): { line: string; candidates: string[] } {
    const text = typeof line === 'string' ? line : '';
    return this.guard({ line: text, candidates: [] as string[] }, () => {
      const run = this.run;
      const ref = run ? this.findSession(run, sessionId) : null;
      if (!run || !ref) return { line: text, candidates: [] };
      return completeLine(run.world, ref.cli, text);
    });
  }

  sessionKey(sessionId: string, key: 'ctrl-z' | 'ctrl-c'): ExecView {
    return this.guard<ExecView>(deadView(), () => {
      const run = this.run;
      const ref = run ? this.findSession(run, sessionId) : null;
      if (!run || !ref) return deadView();
      const world = run.world;
      const cli = ref.cli;
      const dev = world.devices[cli.deviceId];
      if (!isIos(dev)) return deadView();
      const before = snapshotInterfaces(world);
      const modeBefore = cli.mode;
      const runtimeBefore = dev.runtime;
      const outcome = interrupt(world, cli, key === 'ctrl-c' ? 'ctrl-c' : 'ctrl-z');
      this.afterCliStep(run, ref, modeBefore, runtimeBefore);
      this.settle(run, before);
      // The answer continues the line being typed ("R1(config)#^Z"), so waiting console messages come after it.
      const queued = ref.kind === 'console' ? this.takeQueue(ref.rec) : '';
      return this.execView(outcome, outcome.output + (queued && !outcome.output.endsWith('\n') ? '\n' : '') + queued);
    });
  }

  sessionHistory(sessionId: string): string[] {
    return this.guard<string[]>([], () => {
      const run = this.run;
      if (!run) return [];
      const t = run.telnets.get(sessionId);
      if (t) return t.cli.history.filter((l) => redactCredentialLine(l) === l);
      for (const rec of run.consoles.values()) if (rec.id === sessionId && rec.cli) return rec.cli.history.filter((l) => redactCredentialLine(l) === l);
      return [];
    });
  }

  closeSession(sessionId: string): void {
    this.guard(undefined, () => {
      const run = this.run;
      if (!run) return;
      const t = run.telnets.get(sessionId);
      if (t) {
        run.telnets.delete(sessionId);
        if (!t.cli.closed) {
          t.cli.closed = true;
          t.cli.pending = undefined;
          const dev = run.world.devices[t.deviceId];
          if (isIos(dev)) dev.runtime.vtyInUse = Math.max(0, dev.runtime.vtyInUse - 1);
        }
        this.saveRun(run);
        this.publish();
        return;
      }
      for (const rec of run.consoles.values()) {
        if (rec.id !== sessionId || !rec.listed) continue;
        // The terminal window goes away; the device keeps its console state.
        rec.listed = false;
        rec.closed = true;
        rec.queue = '';
        this.publish();
        return;
      }
    });
  }

  private openTelnet(run: Run, pcId: string, t: NonNullable<PcCmdResult['telnet']>): { view: SessionView; banner: string } | null {
    const world = run.world;
    const dev = deviceOf(world, t.deviceId);
    if (!isIos(dev)) return null;
    const id = `tel${++this.seq}`;
    const started = startSession(world, t.deviceId, 'vty', { id, remoteAddr: typeof t.remoteAddr === 'string' ? t.remoteAddr : undefined });
    const rec: TelnetRec = { id, deviceId: t.deviceId, pcId, host: typeof t.host === 'string' && t.host ? t.host : dev.label, cli: started.session };
    if (!started.session.closed) {
      dev.runtime.vtyInUse += 1;
      run.telnets.set(id, rec);
    }
    return { view: this.telnetView(run, rec), banner: started.outcome.output };
  }

  // ═════════════════════════════ file-style configuration ═════════════════════════════
  getConfigText(deviceId: string, which: 'running' | 'startup'): string {
    return this.guard('', () => {
      const run = this.run;
      const dev = deviceOf(run?.world, deviceId);
      if (!run || !isIos(dev)) return '';
      // Reading goes through the console like everything else. Once a report exists the lab itself has read the
      // devices, so the report's comparison with the model solution works without a cable.
      if (!run.report && consolePeer(run.world, deviceId) === null) return this.noConsoleComment(dev.label);
      if (which === 'startup') return dev.startupConfig === null ? '' : stripConfigHeader(dev.startupConfig);
      return `${renderConfigLines(dev).join('\n')}\n`;
    });
  }

  applyConfigText(deviceId: string, text: string, how: 'merge' | 'replace'): ApplyReport {
    const fail = (message: string): ApplyReport => ({ ok: false, applied: 0, failed: 0, lines: [], message });
    return this.guard<ApplyReport>(fail('The configuration could not be applied.'), () => {
      const run = this.run;
      if (!run) return fail('No lab is open.');
      const world = run.world;
      const dev = deviceOf(world, deviceId);
      if (!dev) return fail('That device is not on the bench.');
      if (!isIos(dev)) return fail(`${dev.label} is a PC. It has no IOS configuration.`);
      if (typeof text !== 'string') return fail('There is no configuration text to apply.');
      if (consolePeer(world, deviceId) === null) {
        return fail(`No console cable is connected to ${dev.label}. A configuration file is sent through the console. `
          + `Plug a Console (rollover) cable from the COM1 port of a PC into the CON port of ${dev.label}. Then apply again.`);
      }
      if (how !== 'merge' && how !== 'replace') return fail('Choose whether to merge or replace the running configuration.');
      const mode = how;
      if (run.mode === 'guided' && run.progressDirty) this.refreshProgress(run);
      const guided = run.mode === 'guided' ? (run.instance.guide ?? [])[run.reached] : undefined;
      const allowed = (f: Feature): boolean => !guided || this.refusal(run, f, [deviceId]) === null;
      if (guided) {
        const classes = classifyConfigFile(world, deviceId, text);
        const stop = (blocked: GuideBlock, line: string, feature: Feature, lineMode?: string): ApplyReport => {
          this.addJournal(run, { tick: world.tick, deviceId, via: 'file', mode: lineMode, line, feature, ok: false, mutated: false, blocked: true, stepId: guided.id });
          this.saveRun(run);
          this.publish();
          return { ok: false, applied: 0, failed: 0, lines: [], blocked, message: blocked.reason };
        };
        const bad = classes.find((c) => c.changed && !allowed(c.feature));
        if (bad) {
          const no = this.refusal(run, bad.feature, [deviceId]);
          if (no) {
            const what = `Line ${bad.lineNo} of the file is "${bad.line.trim()}"${no.wrongDevice ? `, and the file is for ${dev.label}` : ''}.`;
            return stop(this.blockText(run, no, what, bad.feature, deviceId, 'Nothing was applied. Take that line out, or finish the step first.'), bad.line.trim(), bad.feature, bad.mode);
          }
        }
        if (mode === 'replace' && !replaceEqualsMerge(world, deviceId, text)) {
          const blocked: GuideBlock = {
            stepId: guided.id, stepNo: guided.no, stepTitle: guided.title,
            reason: `"Replace running configuration" discards the old running configuration on ${dev.label}. Your file does not bring all of it back, so work from other steps would be lost. `
              + `You are on step ${guided.no}: ${guided.title}. Use "Apply to running config" instead. It only adds your lines. Nothing was changed.`,
          };
          return stop(blocked, `Replace the configuration of ${dev.label}`, 'system');
        }
      }

      const before = snapshotInterfaces(world);
      const tick0 = world.tick;
      const configBefore = JSON.stringify(dev.config);
      const steps: ConfigStep[] = [];
      const res = applyConfigText(world, deviceId, text, mode, (step) => steps.push(step));
      const committed = mode === 'merge' || res.ok;
      const stepId = this.stepId(run);
      this.addJournal(run, ...steps.map((step, i): JournalEntry => ({
        tick: Math.min(world.tick, tick0 + i + 1), deviceId, via: 'file', mode: step.mode,
        line: step.line.trim(), feature: step.feature, ok: step.ok && committed, mutated: step.mutated && committed, stepId,
      })));
      if (committed && res.applied > 0) {
        // Even a merge can remove the interface or policy a terminal is currently editing. Drop only sub-mode context,
        // not the whole session; clearing a login/confirmation prompt would silently skip authentication or confirmation.
        const resetContext = (cli: CliSession | null | undefined) => {
          if (cli && isConfigMode(cli.mode) && cli.mode !== 'config' && !cli.pending) {
            cli.mode = 'priv'; cli.ctx = {}; this.editedConfig.delete(cli);
          }
        };
        resetContext(run.consoles.get(deviceId)?.cli);
        for (const t of run.telnets.values()) if (t.deviceId === deviceId) resetContext(t.cli);
        const text = 'Configured from console by console';
        this.log(run, deviceId, 5, 'SYS-5-CONFIG_I', text);
        if (JSON.stringify(dev.config) !== configBefore) this.notifyTrap(run, deviceId, 'config', text);
      }
      this.settle(run, before);
      return { ok: res.ok, applied: res.applied, failed: res.failed, lines: res.lines, ...(res.message ? { message: res.message } : {}) };
    });
  }

  // ═════════════════════════════ PCs ═════════════════════════════
  setPcNic(pcId: string, nic: { mode: 'static' | 'dhcp'; address?: string; mask?: string; gateway?: string; dns?: string }): ActionResult {
    return this.guard<ActionResult>({ ok: false, message: 'The network settings could not be changed.' }, () => {
      const run = this.run;
      if (!run) return { ok: false, message: 'No lab is open.' };
      const world = run.world;
      const pc = deviceOf(world, pcId);
      if (!pc) return { ok: false, message: 'That PC is not on the bench.' };
      if (!isPc(pc)) return { ok: false, message: `${pc.label} is not a PC. Its addresses are set in its terminal.` };
      if (!nic || (nic.mode !== 'static' && nic.mode !== 'dhcp')) return { ok: false, message: 'Choose Static or DHCP.' };
      let fixed: Extract<ReturnType<typeof checkStaticNic>, { ok: true }> | null = null;
      if (nic.mode === 'static') {
        const c = checkStaticNic(pc.label, nic);
        if (!c.ok) return { ok: false, message: c.message };
        fixed = c;
      }
      const line = fixed
        ? `Network: static ${fixed.address} ${fixed.mask}${fixed.gateway ? ` gateway ${fixed.gateway}` : ''}${fixed.dns ? ` dns ${fixed.dns}` : ''}`
        : 'Network: DHCP (ask for an address)';
      // Asking again on a PC that is already set to DHCP changes no setting (the PC keeps asking by itself anyway).
      const renewOnly = !fixed && pc.nic.mode === 'dhcp';
      const no = renewOnly ? null : this.refusal(run, 'pc', [pcId]);
      if (no) {
        const blocked = this.blockText(run, no, `You tried to change the network settings of ${pc.label}.`, 'pc', pcId);
        this.addJournal(run, { tick: world.tick, deviceId: pcId, via: 'pc', line, feature: 'pc', ok: false, mutated: false, blocked: true, stepId: no.active.id });
        this.publish();
        return { ok: false, message: blocked.reason, blocked };
      }
      const before = snapshotInterfaces(world);
      world.tick++;
      let result: ActionResult;
      if (fixed) {
        // A PC that switches to a fixed address gives its lease back.
        if (pc.nic.mode === 'dhcp') { try { dhcpRelease(world, pcId); } catch { /* ignore */ } }
        run.dhcpClients.delete(pcId);
        pc.nic = { mode: 'static', mac: pc.nic.mac, address: fixed.address, mask: fixed.mask };
        if (fixed.gateway) pc.nic.gateway = fixed.gateway;
        if (fixed.dns) pc.nic.dns = fixed.dns;
        result = { ok: true };
      } else {
        if (pc.nic.mode !== 'dhcp') pc.nic = { mode: 'dhcp', mac: pc.nic.mac };
        run.dhcpClients.add(pcId);
        const r = dhcpAcquire(world, pcId);
        if (r.ok) {
          result = { ok: true, message: `Address received: ${r.address} with mask ${r.mask}${r.gateway ? `, gateway ${r.gateway}` : ', no gateway'}.` };
        } else if (run.mode === 'exam') {
          result = { ok: false, message: `No DHCP server answered. ${pc.label} has no address. It keeps asking.` };
        } else {
          result = { ok: false, message: `${r.reasonText ?? 'No DHCP server answered.'} ${pc.label} keeps asking. It gets an address as soon as a server answers.` };
        }
      }
      this.addJournal(run, { tick: world.tick, deviceId: pcId, via: 'pc', line, feature: 'pc', ok: true, mutated: true, stepId: this.stepId(run) });
      this.settle(run, before);
      return result;
    });
  }

  setPcService(pcId: string, service: keyof PcServices, on: boolean): void {
    this.guard(undefined, () => {
      const run = this.run;
      const pc = deviceOf(run?.world, pcId);
      if (!run || !isPc(pc) || !SERVICES.includes(service) || typeof on !== 'boolean') return;
      if (pc.services[service] === on) return;
      const before = snapshotInterfaces(run.world);
      run.world.tick++;
      pc.services[service] = on;
      this.addJournal(run, {
        tick: run.world.tick, deviceId: pcId, via: 'pc', line: `Service ${service} ${on ? 'on' : 'off'}`, feature: 'pc', ok: true, mutated: true, stepId: this.stepId(run),
      });
      this.settle(run, before);
    });
  }

  /**
   * Would this command change how the PC's adapter is set up (static ↔ DHCP, or a fixed address)? Tried on a copy of the
   * world. Getting, renewing or releasing a lease on a DHCP adapter is not a change of settings.
   */
  private pcCommandChangesNic(world: World, pcId: string, line: string): boolean {
    try {
      const copy = cloneWorld(world);
      const settings = (pc: PcDevice): string => (pc.nic.mode === 'dhcp' ? 'dhcp' : JSON.stringify(pc.nic));
      const before = settings(copy.devices[pcId] as PcDevice);
      this.pcRun(copy, pcId, line);
      return settings(copy.devices[pcId] as PcDevice) !== before;
    } catch {
      return false;
    }
  }

  pcExec(pcId: string, line: string): PcExecView {
    return this.guard<PcExecView>({ output: '' }, () => {
      const run = this.run;
      const pc = deviceOf(run?.world, pcId);
      if (!run || !isPc(pc)) return { output: '' };
      const world = run.world;
      const raw = typeof line === 'string' ? line.replace(/[\r\n]+/g, ' ') : '';
      const typed = raw.trim();
      const auditLine = redactPcCommand(typed);
      if (!typed) return { output: '' };
      const no = this.refusal(run, 'pc', [pcId]);
      if (no && this.pcCommandChangesNic(world, pcId, raw)) {
        const blocked = this.blockText(run, no, `You typed "${auditLine}" on ${pc.label}. That changes the network settings of the PC.`, 'pc', pcId);
        this.addJournal(run, { tick: world.tick, deviceId: pcId, via: 'pc', line: auditLine, feature: 'pc', ok: false, mutated: false, blocked: true, stepId: no.active.id });
        this.publish();
        return { output: `The guide stopped this command. ${blocked.reason}\n\n` };
      }
      const before = snapshotInterfaces(world);
      const nicBefore = JSON.stringify(pc.nic);
      world.tick++;
      let res: PcCmdResult;
      try { res = this.pcRun(world, pcId, raw) ?? { output: '' }; } catch (e) {
        res = { output: `This command could not be run: ${errText(e)}\n\n` };
      }
      const view: PcExecView = { output: typeof res.output === 'string' ? res.output : '' };
      if (typeof res.delayMs === 'number' && res.delayMs > 0) view.delayMs = res.delayMs;
      if (res.clear) view.clear = true;
      if (res.telnet && typeof res.telnet.deviceId === 'string') {
        const t = this.openTelnet(run, pcId, res.telnet);
        if (t) { view.session = t.view; view.banner = t.banner; }
      }
      const nicChanged = JSON.stringify(pc.nic) !== nicBefore;
      // The PC's DHCP client: "release" stops it, "renew" (or any command that got a lease) starts it.
      const macDhcp = pc.os === 'macos' && /^(?:sudo\s+)?ipconfig\s+set\s+en0\s+dhcp(?:\s|$)/i.test(typed);
      const winDhcp = pc.os !== 'macos' && /^ipconfig(?:\.exe)?(?:\s+[-/]|\/)(release|renew)(?:\s|$)/i.exec(typed)?.[1]?.toLowerCase();
      const legacyDhcp = this.pcRun !== realPcExec && /^(?:dhcp|setip\s+dhcp)\s*$/i.test(typed);
      if (pc.nic.mode !== 'dhcp' || (winDhcp === 'release' && !pc.nic.address && !/operation failed|cannot be performed/i.test(res.output))) run.dhcpClients.delete(pcId);
      else if (macDhcp || legacyDhcp || (winDhcp === 'renew' && !/operation failed|cannot be performed/i.test(res.output))
        || (nicChanged && pc.nic.address)) run.dhcpClients.add(pcId);
      this.addJournal(run, {
        tick: world.tick, deviceId: pcId, via: 'pc', line: auditLine, feature: nicChanged ? 'pc' : 'verify', ok: true, mutated: nicChanged, stepId: this.stepId(run),
      });
      this.settle(run, before);
      return view;
    });
  }

  pcSnmp(pcId: string, req: SnmpRequest): SnmpReply {
    return this.guard<SnmpReply>({ ok: false, text: 'The request could not be sent.' }, () => {
      const run = this.run;
      const pc = deviceOf(run?.world, pcId);
      if (!run || !isPc(pc)) return { ok: false, text: 'This PC is not on the bench.' };
      if (!req || typeof req !== 'object') return { ok: false, text: 'Fill in host, community and OID.' };
      const host = typeof req.host === 'string' ? req.host.trim() : '';
      const community = typeof req.community === 'string' ? req.community.trim() : '';
      const oid = typeof req.oid === 'string' ? req.oid.trim() : '';
      const op = req.op === 'set' ? 'set' : 'get';
      if (!isIp(host)) return { ok: false, text: `"${host}" is not an IP address. Type the address of the router, like 192.168.1.1.` };
      if (!community) return { ok: false, text: 'Type the community (the SNMP password).' };
      if (!oid) return { ok: false, text: 'Type an OID, for example sysName.0.' };
      if (op === 'set' && typeof req.value !== 'string') return { ok: false, text: 'Type the new value for the set request.' };
      const world = run.world;
      const request = { host, community, op, oid, value: op === 'set' ? req.value : undefined } as const;
      const line = `snmp${op} -c ${REDACTED} ${host} ${oid}${op === 'set' ? ` = ${req.value}` : ''}`;
      let target: string | undefined;
      if (run.mode === 'guided' && op === 'set') {
        const copy = cloneWorld(world);
        target = snmpRequest(copy, pcId, request).flow.forward.atDeviceId;
        const old = target ? world.devices[target] : undefined;
        const changed = target ? copy.devices[target] : undefined;
        if (target && isIos(old) && isIos(changed) && JSON.stringify(old.config) !== JSON.stringify(changed.config)) {
          const no = this.refusal(run, 'snmp', [target]);
          if (no) {
            const blocked = this.blockText(run, no, `You tried to update ${oid} on ${old.label} with SNMP.`, 'snmp', target);
            this.addJournal(run, { tick: world.tick, deviceId: target, via: 'pc', line, feature: 'snmp', ok: false,
              mutated: false, blocked: true, stepId: no.active.id });
            this.saveRun(run);
            this.publish();
            return { ok: false, text: blocked.reason };
          }
        }
      }
      const before = snapshotInterfaces(world);
      const configBefore = op === 'set' ? new Map(world.order.map((id) => {
        const d = world.devices[id];
        return [id, isIos(d) ? JSON.stringify(d.config) : ''];
      })) : null;
      world.tick++;
      const r = snmpRequest(world, pcId, request);
      target = r.flow.forward.atDeviceId;
      const dev = target ? world.devices[target] : undefined;
      const changed = !!configBefore && !!target && isIos(dev) && JSON.stringify(dev.config) !== configBefore.get(target);
      this.addJournal(run, {
        tick: world.tick, deviceId: pcId, via: 'pc', line,
        feature: changed ? 'snmp' : 'verify', ok: r.ok, mutated: changed, stepId: this.stepId(run),
      });
      if (changed && target) this.notifyTrap(run, target, 'config', 'Configured by SNMP SET');
      this.settle(run, before);
      return { ok: r.ok, text: r.text };
    });
  }

  clearPcLog(pcId: string, which: 'syslog' | 'traps'): void {
    this.guard(undefined, () => {
      const run = this.run;
      const pc = deviceOf(run?.world, pcId);
      if (!run || !isPc(pc)) return;
      if (which === 'syslog') pc.runtime.syslog = [];
      else if (which === 'traps') pc.runtime.traps = [];
      else return;
      this.saveRun(run);
      this.publish();
    });
  }

  // ═════════════════════════════ learning tools ═════════════════════════════
  private toolsOff(run: Run): boolean { return run.mode === 'exam' && !run.finished; }

  trace(spec: FlowSpec): FlowResult | { error: string } {
    return this.guard<FlowResult | { error: string }>({ error: 'The packet walkthrough could not run.' }, () => {
      const run = this.run;
      if (!run) return { error: 'No lab is open.' };
      if (this.toolsOff(run)) return { error: 'The packet walkthrough is switched off during the exam. Use ping and the show commands.' };
      if (!spec || typeof spec !== 'object') return { error: 'Choose where the packet starts and where it goes.' };
      if (!deviceOf(run.world, spec.fromDeviceId)) return { error: 'Choose the device where the packet starts.' };
      if (typeof spec.dst !== 'string' || !isIp(spec.dst.trim())) return { error: 'Type a destination address like 60.50.40.2.' };
      if (spec.proto !== 'icmp' && spec.proto !== 'tcp' && spec.proto !== 'udp') return { error: 'Choose what to send: ping, TCP or UDP.' };
      if (spec.srcAddr !== undefined && (typeof spec.srcAddr !== 'string' || !isIp(spec.srcAddr))) return { error: 'The source address is not an IP address.' };
      return probeFlow(run.world, { ...spec, dst: spec.dst.trim() });
    });
  }

  qosLoad(spec: QosLoadSpec): QosLoadResult {
    const fail = (message: string): QosLoadResult => ({ ok: false, message, linkKbps: 0, shapedKbps: 0, rows: [] });
    return this.guard<QosLoadResult>(fail('The load test could not run.'), () => {
      const run = this.run;
      if (!run) return fail('No lab is open.');
      if (this.toolsOff(run)) return fail('The tools are switched off during the exam. Use the show commands on the router.');
      if (!spec || typeof spec !== 'object' || !Array.isArray(spec.offered)) return fail('Choose a router, an interface and some traffic.');
      const dev = deviceOf(run.world, spec.deviceId);
      if (!isIos(dev) || dev.kind !== 'router') return fail('Choose a router first.');
      if (typeof spec.iface !== 'string' || !dev.config.interfaces[spec.iface]) return fail(`Choose an interface of ${dev.label}.`);
      const offered = spec.offered.filter((o) => !!o && typeof o.label === 'string' && typeof o.kbps === 'number' && Number.isFinite(o.kbps)
        && !!o.flow && typeof o.flow.dst === 'string' && isIp(o.flow.dst) && !!deviceOf(run.world, o.flow.fromDeviceId));
      return simQosLoad(run.world, { deviceId: spec.deviceId, iface: spec.iface, offered });
    });
  }

  noteHintUsed(stepId: string): void {
    this.guard(undefined, () => {
      const run = this.run;
      if (!run || run.mode === 'exam' || typeof stepId !== 'string') return;
      if (!(run.instance.guide ?? []).some((g: GuideStep) => g.id === stepId) || run.hintSteps.includes(stepId)) return;
      run.hintSteps = [...run.hintSteps, stepId];
      this.saveRun(run);
      this.publish();
    });
  }

  solution(): SolutionView | null {
    return this.guard<SolutionView | null>(null, () => {
      const run = this.run;
      if (!run) return null;
      if (run.mode === 'exam' && !run.finished) return null;
      return run.instance.solution ?? null;
    });
  }

  commandSheet(): CommandSheetSection[] {
    return this.guard<CommandSheetSection[]>([], () => (Array.isArray(COMMAND_SHEET) ? COMMAND_SHEET : []));
  }

  // ═════════════════════════════ grading ═════════════════════════════
  private grade(run: Run): GradeReport {
    const inst = run.instance;
    const declared = Array.isArray(inst.requirements) ? inst.requirements : [];
    let results: RequirementResult[] = [];
    let orderIssues: GradeReport['orderIssues'] = [];
    let failure = '';
    try {
      // The grader works on a copy: grading must never change the student's network.
      const res = inst.grade(cloneWorld(run.world), run.journal.slice());
      if (res && Array.isArray(res.requirements)) results = res.requirements.filter((r) => !!r && typeof r.id === 'string');
      if (res && Array.isArray(res.orderIssues)) orderIssues = res.orderIssues;
    } catch (e) {
      failure = errText(e);
    }
    const byId = new Map(results.map((r) => [r.id, r]));
    const requirements: RequirementResult[] = [];
    for (const d of declared) {
      const r = byId.get(d.id);
      if (r) { requirements.push(r); byId.delete(d.id); continue; }
      requirements.push({
        ...d, earned: 0, pass: false,
        checks: [{
          id: `${d.id}-not-checked`, label: 'This part could not be checked', pass: false, expected: 'A result from the checker',
          observed: failure ? `The checker stopped with an error: ${failure}` : 'The checker gave no result for this part',
        }],
      });
    }
    for (const r of byId.values()) requirements.push(r);
    const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    const maxPoints = round2(requirements.reduce((s, r) => s + num(r.points), 0));
    const points = round2(requirements.reduce((s, r) => s + Math.min(num(r.points), Math.max(0, num(r.earned))), 0));
    return {
      scenarioId: run.def.summary.id,
      mode: run.mode,
      tick: run.world.tick,
      maxPoints,
      points,
      practiceBasis: { revision: 2, qos: run.world.settings.qosClassifiesInnerHeader ? 'course' : 'after-encryption' },
      scaled18: maxPoints > 0 ? round1((points / maxPoints) * 18) : 0,
      requirements,
      orderIssues,
      hardwareNotes: Array.isArray(inst.hardwareNotes) ? inst.hardwareNotes : [],
    };
  }

  check(): GradeReport {
    return this.guard<GradeReport>(emptyReport(), () => {
      const run = this.run;
      if (!run) return emptyReport();
      if (run.mode === 'exam') return this.finishExam();
      const report = this.grade(run);
      run.report = report;
      this.refreshProgress(run);
      this.saveRun(run);
      this.publish();
      return report;
    });
  }

  finishExam(): GradeReport {
    return this.guard<GradeReport>(emptyReport(), () => {
      const run = this.run;
      if (!run) return emptyReport();
      if (run.mode !== 'exam') return this.check();
      // The exam is graded once. The report is final.
      if (run.finished && run.report) return run.report;
      const report = this.grade(run);
      run.report = report;
      run.finished = true;
      this.saveRun(run);
      this.publish();
      return report;
    });
  }

  // ═════════════════════════════ settings and persistence ═════════════════════════════
  updateSettings(patch: Partial<UiSettings>): void {
    this.guard(undefined, () => {
      if (!patch || typeof patch !== 'object') return;
      const run = this.run;
      const wanted = mergeSettings(this.effectiveSettings(), patch);
      const next: UiSettings = {
        ...wanted,
        strictCables: this.settings.strictCables,
        qosClassifiesInnerHeader: this.settings.qosClassifiesInnerHeader,
      };
      let before: IfSnapshot | null = null;
      if (typeof patch.strictCables === 'boolean') {
        // The cable rule belongs to the bench. During an exam it is locked.
        if (!run) next.strictCables = patch.strictCables;
        else if (run.mode !== 'exam') {
          next.strictCables = patch.strictCables;
          if (run.world.settings.strictCables !== patch.strictCables) {
            before = snapshotInterfaces(run.world);
            run.world.tick++;
            run.world.settings.strictCables = patch.strictCables;
            this.addJournal(run, {
              tick: run.world.tick, deviceId: run.world.order[0] ?? '', via: 'bench', feature: 'cabling', ok: true, mutated: true, stepId: this.stepId(run),
              line: patch.strictCables ? 'Bench rule: strict cable types on' : 'Bench rule: strict cable types off (any Ethernet cable works)',
            });
          }
        }
      }
      let qosChanged = false;
      if (run?.mode !== 'exam' && typeof patch.qosClassifiesInnerHeader === 'boolean') {
        const qos = patch.qosClassifiesInnerHeader;
        next.qosClassifiesInnerHeader = qos;
        if (run && run.world.settings.qosClassifiesInnerHeader !== qos) {
          run.world.settings = { ...run.world.settings, qosClassifiesInnerHeader: qos };
          run.world.tick++;
          // The last Check result used a different classifier. Do not present it under the new profile.
          run.report = null;
          qosChanged = true;
        }
      }
      const prefsChanged = !sameSettings(next, this.settings);
      if (!prefsChanged && !before && !qosChanged) return;
      this.settings = next;
      if (prefsChanged) this.store.set(SETTINGS_KEY, JSON.stringify(this.settings));
      if (run && before) { this.settle(run, before); return; }
      if (run && qosChanged) {
        this.progressAfterAction(run);
        this.saveRun(run);
      }
      this.publish();
    });
  }

  private slotOf(run: Run): string { return `${run.def.summary.id}.${run.mode}`; }

  private snapshot(run: Run): SavedLab {
    const now = this.now();
    return {
      format: LAB_FORMAT,
      version: LAB_VERSION,
      scenarioId: run.def.summary.id,
      title: run.instance.summary?.title ?? run.def.summary.title,
      seed: run.seed,
      mode: run.mode,
      startedAt: run.startedAt,
      elapsedMs: Math.max(0, now - run.startedAt),
      savedAt: now,
      timerMinutes: run.timerMinutes,
      finished: run.finished,
      hintSteps: [...run.hintSteps],
      hintsUsed: run.hintSteps.length,
      guideReached: run.reached,
      dhcpClients: [...run.dhcpClients],
      world: run.world,
      journal: run.journal,
      report: run.report,
      settings: this.effectiveSettings(run),
    };
  }

  /**
   * Auto-save into the slot of this scenario and mode. Failures only switch storage off.
   * When the storage works but is full, the oldest other saved labs make room (the lab being worked on matters most).
   */
  private saveRun(run: Run): void {
    if (!this.store.present) return;
    try {
      const lab = this.snapshot(run);
      const slot = this.slotOf(run);
      const json = JSON.stringify(lab);
      let stored = this.store.set(SLOT_PREFIX + slot, json);
      if (!stored && this.store.probe()) {
        const oldest = this.saved.filter((s) => s.id !== slot).sort((a, b) => a.savedAt - b.savedAt);
        for (const victim of oldest) {
          if (!this.store.remove(SLOT_PREFIX + victim.id)) break;
          this.saved = this.saved.filter((s) => s.id !== victim.id);
          stored = this.store.set(SLOT_PREFIX + slot, json);
          if (stored) break;
        }
        if (!stored) this.store.available = false;
      }
      if (!stored) return;
      const summary = summaryOf(slot, lab);
      this.saved = [...this.saved.filter((s) => s.id !== slot), summary];
      this.store.set(INDEX_KEY, JSON.stringify(this.saved));
    } catch {
      this.store.available = false;
    }
  }

  /** The saved-lab list: the index, checked against the keys that really exist. */
  private loadIndex(): SavedLabSummary[] {
    if (!this.store.available) return [];
    const index = parseIndex(this.store.get(INDEX_KEY));
    const keys = this.store.keys().filter((k) => k.startsWith(SLOT_PREFIX));
    if (!this.store.available) return [];
    const have = new Set(keys.map((k) => k.slice(SLOT_PREFIX.length)));
    const out = index.filter((s) => have.has(s.id));
    for (const id of have) {
      if (out.some((s) => s.id === id)) continue;
      // A slot without an index entry (the index was lost): read it once to list it.
      const parsed = parseSavedLab(this.store.get(SLOT_PREFIX + id));
      if (parsed.ok) out.push(summaryOf(id, parsed.lab));
    }
    return out;
  }

  exportLab(): string {
    return this.guard(EMPTY_EXPORT, () => {
      const run = this.run;
      return run ? JSON.stringify(this.snapshot(run)) : EMPTY_EXPORT;
    });
  }

  importLab(json: string): ActionResult {
    return this.guard<ActionResult>({ ok: false, message: 'This lab file could not be opened.' }, () => {
      const parsed = parseSavedLab(json);
      if (!parsed.ok) return { ok: false, message: parsed.message };
      return this.restore(parsed.lab, true);
    });
  }

  loadSaved(id: string): ActionResult {
    return this.guard<ActionResult>({ ok: false, message: 'This saved lab could not be opened.' }, () => {
      if (typeof id !== 'string' || !id) return { ok: false, message: 'That saved lab is not there any more.' };
      const json = this.store.get(SLOT_PREFIX + id);
      if (json === null) {
        if (this.saved.some((s) => s.id === id)) { this.saved = this.saved.filter((s) => s.id !== id); this.publish(); }
        return { ok: false, message: 'That saved lab is not there any more.' };
      }
      const parsed = parseSavedLab(json);
      if (!parsed.ok) return { ok: false, message: `The saved lab is damaged and cannot be opened. ${parsed.message}` };
      return this.restore(parsed.lab, false);
    });
  }

  deleteSaved(id: string): void {
    this.guard(undefined, () => {
      if (typeof id !== 'string' || !id) return;
      this.store.remove(SLOT_PREFIX + id);
      this.saved = this.saved.filter((s) => s.id !== id);
      this.store.set(INDEX_KEY, JSON.stringify(this.saved));
      this.publish();
    });
  }

  /** Open a saved lab. Terminals start fresh: the devices keep their configuration, not their open sessions. */
  private restore(lab: SavedLab, withSettings: boolean): ActionResult {
    const def = this.scenarios.find((s) => s.summary.id === lab.scenarioId);
    if (!def) return { ok: false, message: `This lab belongs to an assignment that this version does not have ("${lab.scenarioId}").` };
    let instance: ScenarioInstance;
    try { instance = def.build(lab.seed); } catch (e) {
      return { ok: false, message: `The assignment of this lab could not be set up: ${errText(e)}` };
    }
    if (!instance) return { ok: false, message: 'The assignment of this lab could not be set up.' };
    if (this.run) this.saveRun(this.run);
    const world = cloneWorld(lab.world);
    const dhcpClients = new Set<string>();
    for (const id of world.order) {
      const d = world.devices[id];
      if (isIos(d)) d.runtime.vtyInUse = 0; // no Telnet session survives
      else if (isPc(d) && d.nic.mode === 'dhcp' && (lab.dhcpClients.includes(id) || !!d.nic.address)) dhcpClients.add(id);
    }
    const stepIds = new Set((instance.guide ?? []).map((g) => g.id));
    const run: Run = {
      def, instance, mode: lab.mode, seed: lab.seed,
      startedAt: this.freshStart(this.now() - lab.elapsedMs),
      timerMinutes: lab.timerMinutes, finished: lab.finished,
      hintSteps: lab.hintSteps.filter((h) => stepIds.has(h)),
      world, journal: lab.journal.map((e) => {
        if (e.via === 'bench') return { ...e };
        if (e.via === 'pc') return { ...e, line: redactPcCommand(e.line) };
        const dev = world.devices[e.deviceId];
        const direct = redactCredentialLine(e.line);
        if (!isIos(dev) || direct !== e.line) return { ...e, line: direct };
        const modes = e.mode ? [e.mode as CliSession['mode']] : (['priv', 'config', 'config-if'] as const);
        // Old journals did not store the resolved command. Use aliases still present in the saved configuration.
        for (const mode of modes) {
          const { echo } = inspectInput(dev, { mode, closed: false }, e.line.trimStart());
          if (echo.kind === 'redacted') return { ...e, line: echo.text };
        }
        return { ...e };
      }), report: lab.report ? structuredClone(lab.report) : null,
      progress: {}, reached: Math.max(0, Math.floor(lab.guideReached) || 0), progressDirty: false, progressCost: 0, progressKey: '', progressReadsJournal: true,
      dhcpClients, consoles: new Map(), telnets: new Map(),
    };
    if (withSettings && lab.settings) {
      const next = mergeSettings(this.settings, {
        ...lab.settings,
        strictCables: this.settings.strictCables,
        qosClassifiesInnerHeader: this.settings.qosClassifiesInnerHeader,
      });
      if (!sameSettings(next, this.settings)) { this.settings = next; this.store.set(SETTINGS_KEY, JSON.stringify(this.settings)); }
    }
    this.run = run;
    this.refreshProgress(run);
    this.saveRun(run);
    this.publish();
    return { ok: true, message: `Opened "${run.instance.summary?.title ?? def.summary.title}".` };
  }
}
