/**
 * LabApi — the ONLY surface the user interface talks to. The UI never imports engine internals.
 * The real implementation lives in src/engine/lab.ts; the UI may use a mock that satisfies this interface.
 */
import type {
  BriefItem, CableKind, DiagramSpec, FlowResult, FlowSpec, GradeReport, GuideStep, JournalEntry, LabMode,
  PcServices, PortKind, PortRef, RequirementView, ScenarioSummary, SolutionView, World,
} from './types.ts';
import type { ExecStatus, InputEcho, PendingInputView } from './cli/framework.ts';
export type { InputEcho, PendingInputView } from './cli/framework.ts';

/** Guided mode refused an action because it belongs to another step or another device. */
export interface GuideBlock {
  stepId: string;
  stepNo: number;
  stepTitle: string;
  /** Plain explanation for the user: what was tried, why it is stopped, what to do instead. */
  reason: string;
}
export interface ActionResult { ok: boolean; message?: string; blocked?: GuideBlock }

export interface PortStatus {
  ref: PortRef;
  kind: PortKind;
  cableId?: string;
  cableKind?: CableKind;
  /** Port LED: off = nothing usable, amber = cable present but link down, green = link up. */
  led: 'off' | 'amber' | 'green';
  /** IOS-style status for network ports, e.g. 'up/up', 'administratively down/down', 'up/down'. */
  status?: string;
  /** Serial ports: this end holds the DCE connector. */
  dce?: boolean;
  /** Why the link is not up, in plain words. Empty in exam mode. */
  problem?: string;
}

export interface SessionView {
  id: string;
  /** Device whose CLI this is. */
  deviceId: string;
  kind: 'console' | 'telnet';
  /** PC whose terminal program shows the session. */
  pcId: string;
  /** Window title, e.g. 'R1 — console (PC1 COM1, 9600 8N1)' or 'Telnet 60.50.30.2 (from PC1)'. */
  title: string;
  prompt: string;
  /** Next input is a password: do not echo. */
  secret: boolean;
  closed: boolean;
  /** Authoritative IOS screen length (0 disables paging). Missing only on legacy fixtures. */
  termLength?: number;
  /** null at a command prompt. Missing only on legacy fixtures. */
  pendingInput?: PendingInputView | null;
}
export interface ExecView {
  /** Text to append to the terminal after the echoed command. */
  output: string;
  prompt: string;
  secret: boolean;
  closed: boolean;
  /** Authoritative IOS state after this action; optional for older mock fixtures. */
  termLength?: number;
  pendingInput?: PendingInputView | null;
  status?: ExecStatus | 'blocked';
  /** Display-only input classification; hidden input carries no text. */
  echo?: InputEcho;
  /** Pause before printing the prompt (DNS lookup after a typo, ping timeouts). */
  delayMs?: number;
  /** Simulator remarks, shown outside the terminal text. */
  notes: string[];
  /** Guided mode stopped this command (nothing was executed). */
  blocked?: GuideBlock;
}
export type OpenSessionResult = { ok: true; session: SessionView; banner: string } | { ok: false; message: string };

export interface ApplyLineResult { lineNo: number; line: string; ok: boolean; output: string }
export interface ApplyReport { ok: boolean; applied: number; failed: number; lines: ApplyLineResult[]; blocked?: GuideBlock; message?: string }

export interface PcExecView {
  output: string;
  delayMs?: number;
  /** `cls` was typed. */
  clear?: boolean;
  /** `telnet <router>` succeeded: the UI should switch this prompt window into the CLI session. */
  session?: SessionView;
  banner?: string;
}
export interface SnmpRequest { host: string; community: string; op: 'get' | 'set'; oid: string; value?: string }
export interface SnmpReply { ok: boolean; text: string }

export interface QosLoadSpec {
  /** Router and egress interface under test. */
  deviceId: string;
  iface: string;
  /** Offered traffic. Each row is classified like a real packet of that flow. */
  offered: { label: string; flow: FlowSpec; kbps: number }[];
}
export interface QosLoadResult {
  ok: boolean;
  message?: string;
  /** Physical rate (clock rate / bandwidth) and the shaped rate, kbit/s. */
  linkKbps: number;
  shapedKbps: number;
  rows: { label: string; className: string; treatment: string; offeredKbps: number; deliveredKbps: number }[];
}

export interface CommandSheetSection { id: string; title: string; feature: string; lines: { text: string; note?: string; warn?: string }[] }

export interface ScenarioView {
  summary: ScenarioSummary;
  seed: number;
  mode: LabMode;
  brief: { intro: string; items: BriefItem[]; given?: { label: string; value: string }[] };
  diagram: DiagramSpec;
  requirements: RequirementView[];
  /** Guided and free mode: every step with its status. Exam mode: empty. */
  guide: (GuideStep & { status: 'done' | 'active' | 'locked' })[];
  /** Epoch milliseconds. */
  startedAt: number;
  /** null = no timer. */
  timerMinutes: number | null;
  finished: boolean;
  hintsUsed: number;
}

export interface UiSettings {
  strictCables: boolean;
  /** Active WAN QoS profile in a lab; default for new labs on the start page. */
  qosClassifiesInnerHeader: boolean;
  /** 0.85 … 1.4 */
  fontScale: number;
  font: 'lexend' | 'atkinson' | 'system';
  terminalFontPx: number;
  /** Honor the session's IOS screen length with --More-- pauses. */
  terminalPaging: boolean;
  reduceMotion: boolean;
}
export interface SavedLabSummary { id: string; title: string; mode: LabMode; savedAt: number; percent?: number }

export interface LabState {
  /** Increases on every change; use it as the React snapshot key. */
  rev: number;
  scenario: ScenarioView | null;
  world: World | null;
  sessions: SessionView[];
  journal: JournalEntry[];
  /** Last grading result (free/guided: last Check; exam: final report). */
  report: GradeReport | null;
  settings: UiSettings;
  storage: { available: boolean; saved: SavedLabSummary[] };
}

export interface LabApi {
  // ── state ──
  getState(): LabState;
  subscribe(listener: () => void): () => void;

  // ── scenarios ──
  listScenarios(): ScenarioSummary[];
  startScenario(id: string, mode: LabMode, opts?: { seed?: number; timerMinutes?: number | null }): ActionResult;
  restartScenario(): void;
  /** Back to the home screen (the lab is auto-saved when storage is available). */
  leaveScenario(): void;

  // ── bench: cables and devices ──
  moveDevice(deviceId: string, x: number, y: number): void;
  connectCable(kind: CableKind, a: PortRef, b: PortRef, opts?: { dceEnd?: 'a' | 'b' }): ActionResult;
  removeCable(cableId: string): ActionResult;
  portStatus(ref: PortRef): PortStatus;

  // ── terminals ──
  /** Device reachable through the console cable plugged into this PC, or null. */
  consoleTargetOf(pcId: string): string | null;
  /** PC whose console cable is plugged into this device, or null. */
  consolePcOf(deviceId: string): string | null;
  /** Open the console session of `deviceId` (needs a console cable from a PC). Reuses an open session. */
  openConsole(deviceId: string): OpenSessionResult;
  sessionExec(sessionId: string, line: string): ExecView;
  /** Preview safe input locally while editing, without executing it or expanding aliases for display. */
  sessionInputEcho?(sessionId: string, line: string): InputEcho;
  /** Output of pressing '?' after `line`. */
  sessionHelp(sessionId: string, line: string): string;
  sessionComplete(sessionId: string, line: string): { line: string; candidates: string[] };
  sessionKey(sessionId: string, key: 'ctrl-z' | 'ctrl-c'): ExecView;
  sessionHistory(sessionId: string): string[];
  closeSession(sessionId: string): void;

  // ── file-style configuration ──
  getConfigText(deviceId: string, which: 'running' | 'startup'): string;
  /** merge = like pasting the lines into configuration mode; replace = erase the device configuration first. */
  applyConfigText(deviceId: string, text: string, how: 'merge' | 'replace'): ApplyReport;

  // ── PCs ──
  setPcNic(pcId: string, nic: { mode: 'static' | 'dhcp'; address?: string; mask?: string; gateway?: string; dns?: string }): ActionResult;
  setPcService(pcId: string, service: keyof PcServices, on: boolean): void;
  pcExec(pcId: string, line: string): PcExecView;
  pcSnmp(pcId: string, req: SnmpRequest): SnmpReply;
  clearPcLog(pcId: string, which: 'syslog' | 'traps'): void;

  // ── learning tools (not available in exam mode: they return an error result) ──
  trace(spec: FlowSpec): FlowResult | { error: string };
  qosLoad(spec: QosLoadSpec): QosLoadResult;
  noteHintUsed(stepId: string): void;
  /** null in exam mode until the exam is finished. */
  solution(): SolutionView | null;
  commandSheet(): CommandSheetSection[];

  // ── grading ──
  /** Guided/free: grade now. Exam: same as finishExam(). */
  check(): GradeReport;
  finishExam(): GradeReport;

  // ── settings and persistence ──
  updateSettings(patch: Partial<UiSettings>): void;
  exportLab(): string;
  importLab(json: string): ActionResult;
  loadSaved(id: string): ActionResult;
  deleteSaved(id: string): void;
}
