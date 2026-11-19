/**
 * The lab file: everything needed to continue a lab later (auto-save slots, Export lab / Open a lab file).
 * Reading is defensive: a file that is not a lab, or a damaged one, gives a plain message instead of an exception.
 */
import type { SavedLabSummary, UiSettings } from '../labapi.ts';
import type { GradeReport, JournalEntry, LabMode, World } from '../types.ts';
import { restoreHardwareInventory } from '../world.ts';

export const LAB_FORMAT = 'kss-netlab-lab';
export const LAB_VERSION = 1;

export interface SavedLab {
  format: typeof LAB_FORMAT;
  version: number;
  scenarioId: string;
  title: string;
  seed: number;
  mode: LabMode;
  /** Epoch ms when the lab was started (on the machine that saved it). */
  startedAt: number;
  /** Working time so far. The clock continues from here when the lab is opened again. */
  elapsedMs: number;
  savedAt: number;
  timerMinutes: number | null;
  finished: boolean;
  /** Guide steps whose hint or example was opened. */
  hintSteps: string[];
  hintsUsed: number;
  /** Guided mode: number of guide steps finished so far (finished steps stay finished). */
  guideReached: number;
  /** PCs whose DHCP client is asking for an address. */
  dhcpClients: string[];
  world: World;
  journal: JournalEntry[];
  report: GradeReport | null;
  settings: UiSettings;
}

export type ParseResult = { ok: true; lab: SavedLab } | { ok: false; message: string };

const MODES: LabMode[] = ['guided', 'free', 'exam'];
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** null when the world is usable, otherwise what is wrong with it (for the developer; the user gets a plain sentence). */
export function worldProblem(w: unknown): string | null {
  if (!isObj(w)) return 'world is missing';
  if (!isObj(w.devices)) return 'world.devices is missing';
  if (!Array.isArray(w.order) || !w.order.every(isStr)) return 'world.order is missing';
  if (!Array.isArray(w.cables)) return 'world.cables is missing';
  if (!isObj(w.settings) || typeof w.settings.strictCables !== 'boolean') return 'world.settings is missing';
  if (w.settings.qosClassifiesInnerHeader !== undefined && typeof w.settings.qosClassifiesInnerHeader !== 'boolean') {
    return 'the WAN QoS profile is invalid';
  }
  if (!isNum(w.tick) || !isNum(w.nextId)) return 'world.tick / world.nextId are missing';
  for (const id of w.order) if (!isObj(w.devices[id])) return `device ${id} is listed but missing`;
  for (const [id, d] of Object.entries(w.devices)) {
    if (!isObj(d) || d.id !== id) return `device ${id} is damaged`;
    if (!Array.isArray(d.ports) || !d.ports.every((p) => isObj(p) && isStr(p.name) && isStr(p.kind))) return `device ${id} has no port list`;
    if (!isStr(d.label) || !isNum(d.x) || !isNum(d.y)) return `device ${id} has no label or position`;
    if (d.kind === 'pc') {
      if (!isObj(d.nic) || !isStr(d.nic.mac) || (d.nic.mode !== 'static' && d.nic.mode !== 'dhcp')) return `PC ${id} has no network adapter`;
      if (!isObj(d.services)) return `PC ${id} has no service list`;
      if (!isObj(d.runtime) || !Array.isArray(d.runtime.syslog) || !Array.isArray(d.runtime.traps)) return `PC ${id} has no runtime state`;
    } else if (d.kind === 'router' || d.kind === 'switch') {
      if (d.networkLicense !== undefined && (d.model !== 'c9300l' || (d.networkLicense !== 'network-advantage' && d.networkLicense !== 'network-essentials'))) {
        return `the network license of ${id} is invalid`;
      }
      const c = d.config;
      if (!isObj(c) || !isStr(c.hostname) || !isObj(c.interfaces) || !isObj(c.acls) || !isObj(c.lines) || !Array.isArray((c.lines as Record<string, unknown>).vty)
        || !isObj(c.nat) || !isObj(c.crypto) || !isObj(c.qos) || !isObj(c.dhcp) || !isObj(c.snmp) || !isObj(c.logging) || !Array.isArray(c.staticRoutes)) {
        return `the configuration of ${id} is damaged`;
      }
      const r = d.runtime;
      if (!isObj(r) || !Array.isArray(r.logBuffer) || !Array.isArray(r.natTranslations) || !Array.isArray(r.dhcpBindings) || !Array.isArray(r.ipsecSas)) {
        return `the runtime state of ${id} is damaged`;
      }
      if (d.startupConfig !== null && !isStr(d.startupConfig)) return `the startup-config of ${id} is damaged`;
    } else return `device ${id} has an unknown kind`;
  }
  for (const c of w.cables) {
    if (!isObj(c) || !isStr(c.id) || !isStr(c.kind) || !isObj(c.a) || !isObj(c.b)) return 'a cable is damaged';
    for (const end of [c.a, c.b] as Record<string, unknown>[]) {
      if (!isStr(end.deviceId) || !isStr(end.port) || !isObj(w.devices[end.deviceId])) return 'a cable is plugged into a device that does not exist';
    }
  }
  return null;
}

/** Read lab-file text. Never throws. */
export function parseSavedLab(json: unknown): ParseResult {
  if (typeof json !== 'string' || json.trim() === '') return { ok: false, message: 'The file is empty. Choose a lab file that was made with Export lab.' };
  let data: unknown;
  try { data = JSON.parse(json); } catch {
    return { ok: false, message: 'This is not a lab file. It could not be read. Choose a file that was made with Export lab.' };
  }
  if (!isObj(data) || data.format !== LAB_FORMAT) {
    return { ok: false, message: 'This is not a KSS NetLab lab file. Choose a file that was made with Export lab.' };
  }
  if (data.empty === true) return { ok: false, message: 'This lab file is empty. It was exported while no lab was open.' };
  if (!isNum(data.version) || data.version > LAB_VERSION) {
    return { ok: false, message: 'This lab file was made by a newer version of KSS NetLab. This version cannot open it.' };
  }
  if (!isStr(data.scenarioId) || !MODES.includes(data.mode as LabMode)) {
    return { ok: false, message: 'This lab file is damaged: it does not say which assignment and mode it belongs to.' };
  }
  const problem = worldProblem(data.world);
  if (problem) return { ok: false, message: `This lab file is damaged (${problem}). It cannot be opened.` };
  const now = isNum(data.savedAt) ? data.savedAt : 0;
  const report = isObj(data.report) && Array.isArray(data.report.requirements) && isNum(data.report.points) && isNum(data.report.maxPoints)
    ? (data.report as unknown as GradeReport) : null;
  const journal = Array.isArray(data.journal)
    ? (data.journal.filter((e) => isObj(e) && isStr(e.line) && isStr(e.deviceId) && isNum(e.tick)) as unknown as JournalEntry[]) : [];
  const hintSteps = Array.isArray(data.hintSteps) ? [...new Set(data.hintSteps.filter(isStr))] : [];
  const world = data.world as unknown as World;
  // A v1 world with no profile uses the course rule, not the browser's current preference.
  // An explicit saved choice (including false) is authoritative over the UI settings mirror.
  world.settings.qosClassifiesInnerHeader ??= true;
  restoreHardwareInventory(world);
  const lab: SavedLab = {
    format: LAB_FORMAT,
    version: LAB_VERSION,
    scenarioId: data.scenarioId,
    title: isStr(data.title) ? data.title : data.scenarioId,
    seed: isNum(data.seed) ? data.seed : 0,
    mode: data.mode as LabMode,
    startedAt: isNum(data.startedAt) ? data.startedAt : now,
    elapsedMs: isNum(data.elapsedMs) && data.elapsedMs >= 0 ? data.elapsedMs : 0,
    savedAt: now,
    timerMinutes: isNum(data.timerMinutes) && data.timerMinutes > 0 ? data.timerMinutes : null,
    finished: data.finished === true,
    hintSteps,
    hintsUsed: hintSteps.length,
    guideReached: isNum(data.guideReached) && data.guideReached > 0 ? Math.floor(data.guideReached) : 0,
    dhcpClients: Array.isArray(data.dhcpClients) ? data.dhcpClients.filter(isStr) : [],
    world,
    journal,
    report,
    settings: data.settings as UiSettings,
  };
  return { ok: true, lab };
}

/** Row for the "Continue where you left off" list. */
export function summaryOf(slot: string, lab: SavedLab): SavedLabSummary {
  const s: SavedLabSummary = { id: slot, title: lab.title, mode: lab.mode, savedAt: lab.savedAt };
  if (lab.report && lab.report.maxPoints > 0) s.percent = Math.round((lab.report.points / lab.report.maxPoints) * 100);
  return s;
}

/** Read the saved index (list of summaries). Damaged entries are dropped. */
export function parseIndex(json: string | null): SavedLabSummary[] {
  if (!json) return [];
  let data: unknown;
  try { data = JSON.parse(json); } catch { return []; }
  if (!Array.isArray(data)) return [];
  const out: SavedLabSummary[] = [];
  for (const e of data) {
    if (!isObj(e) || !isStr(e.id) || !isStr(e.title) || !MODES.includes(e.mode as LabMode) || !isNum(e.savedAt)) continue;
    const s: SavedLabSummary = { id: e.id, title: e.title, mode: e.mode as LabMode, savedAt: e.savedAt };
    if (isNum(e.percent)) s.percent = e.percent;
    if (!out.some((x) => x.id === s.id)) out.push(s);
  }
  return out;
}
