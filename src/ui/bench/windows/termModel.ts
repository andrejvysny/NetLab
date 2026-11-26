/**
 * Terminal model: scrollback, input line, paging, delays, paste queue and the calls into LabApi.
 * It lives outside React so that a terminal keeps its text when its window is closed, minimised or shown twice
 * (the R1 console can be visible in R1's terminal window and in the PC's "Terminal" tab at the same time).
 */
import type { ExecView, GuideBlock, InputEcho, LabApi, PcExecView, PendingInputView, SessionView } from '../../../engine/labapi.ts';
import { splitLines } from '../util.ts';

export type TermItem =
  | { id: number; t: 'out'; text: string }
  /** A line from the simulator itself, not from the device (connection state, errors). */
  | { id: number; t: 'sys'; text: string }
  | { id: number; t: 'note'; text: string }
  | { id: number; t: 'guide'; block: GuideBlock; line: string };
type NewItem =
  | { t: 'out'; text: string } | { t: 'sys'; text: string } | { t: 'note'; text: string }
  | { t: 'guide'; block: GuideBlock; line: string };
export interface TermChunk { id: number; items: TermItem[] }
/** idle: no session yet · input: waiting for a line · busy: delay running · more: paused at --More-- · closed: session ended */
export type TermPhase = 'idle' | 'input' | 'busy' | 'more' | 'closed';
export type TermTarget =
  | { kind: 'console'; deviceId: string }
  | { kind: 'pc'; pcId: string; os: 'windows' | 'macos'; label: string };

interface NormView {
  output: string;
  prompt: string;
  secret: boolean;
  closed: boolean;
  delayMs: number;
  notes: string[];
  blocked?: GuideBlock;
  status?: ExecView['status'];
  echo?: InputEcho;
  termLength?: number;
  pendingInput?: PendingInputView | null;
  clear: boolean;
  session?: SessionView;
  banner?: string;
}

const CHUNK_SIZE = 200;
const MAX_LINES = 5000;
const DEFAULT_PAGE = 24;
// Only legacy views have no status. Real IOS output can contain the same text in a banner or show command.
const LEGACY_REJECTED = /^\s*%\s*(?:Invalid input detected|Ambiguous command:|Incomplete command\.|Unknown command or computer name|This encrypted credential is not supported|The simulator could not run)/mi;
const IOS_PROMPT = /^[A-Za-z0-9][\w.\-]*(?:\([\w\-]+\))?[#>]/;

function normExec(v: ExecView | null | undefined, fallbackPrompt: string): NormView {
  const x = (v ?? {}) as Partial<ExecView>;
  return {
    output: typeof x.output === 'string' ? x.output : '',
    prompt: typeof x.prompt === 'string' ? x.prompt : fallbackPrompt,
    secret: !!x.secret || x.pendingInput?.kind === 'password',
    closed: !!x.closed,
    delayMs: typeof x.delayMs === 'number' && x.delayMs > 0 ? Math.min(x.delayMs, 60000) : 0,
    notes: Array.isArray(x.notes) ? x.notes.filter((n) => typeof n === 'string') : [],
    blocked: x.blocked && typeof x.blocked === 'object' ? x.blocked : undefined,
    status: x.status, echo: x.echo, termLength: x.termLength, pendingInput: x.pendingInput,
    clear: false,
  };
}
function normPc(v: PcExecView | null | undefined, prompt: string): NormView {
  const x = (v ?? {}) as Partial<PcExecView>;
  return {
    output: typeof x.output === 'string' ? x.output : '',
    prompt,
    secret: false,
    closed: false,
    delayMs: typeof x.delayMs === 'number' && x.delayMs > 0 ? Math.min(x.delayMs, 60000) : 0,
    notes: [],
    clear: !!x.clear,
    session: x.session && typeof x.session === 'object' && typeof x.session.id === 'string' ? x.session : undefined,
    banner: typeof x.banner === 'string' ? x.banner : undefined,
  };
}

function echoText(echo: InputEcho): string { return echo.kind === 'hidden' ? '' : echo.text; }
function rejected(view: NormView): boolean {
  return view.status === undefined
    ? LEGACY_REJECTED.test(view.output)
    : view.status !== 'ok' && view.status !== 'empty' && view.status !== 'pending';
}

export class TermModel {
  readonly target: TermTarget;
  private lab: LabApi;
  private listeners = new Set<() => void>();
  private itemId = 1;
  private chunkId = 1;
  private lineTotal = 0;
  private batching = 0;
  private dirty = false;

  version = 0;
  chunks: TermChunk[] = [];
  phase: TermPhase = 'idle';
  prompt = '';
  secret = false;
  line = '';
  cursor = 0;
  /** Current IOS session: the console session, or the Telnet session inside a PC's command prompt. */
  session: SessionView | null = null;
  closedReason = '';

  private pending: string[] = [];
  private afterPending: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private afterDelay: (() => void) | null = null;
  private histList: string[] = [];
  private histIdx: number | null = null;
  private histDraft = '';
  private pcHistory: string[] = [];
  private queue: string[] = [];
  private queueTail = '';
  private pasting = false;
  private executing = false;

  constructor(lab: LabApi, target: TermTarget) {
    this.lab = lab;
    this.target = target;
    if (target.kind === 'pc') {
      this.prompt = this.pcPrompt();
      this.phase = 'input';
      this.push(target.os === 'macos'
        ? [`Last login on ttys000`, '']
        : ['Microsoft Windows [Version 10.0.19045.3803]', '(c) Microsoft Corporation. All rights reserved.', ''], 'out');
    }
  }

  // ───────── subscription ─────────
  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  getVersion = (): number => this.version;
  private touch(): void {
    if (this.batching > 0) { this.dirty = true; return; }
    this.version++;
    for (const l of [...this.listeners]) l();
  }
  private batch(fn: () => void): void {
    this.batching++;
    try { fn(); } finally {
      this.batching--;
      if (this.batching === 0 && this.dirty) { this.dirty = false; this.touch(); }
    }
  }
  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null; this.afterDelay = null; this.listeners.clear();
  }

  // ───────── scrollback ─────────
  private pushItems(items: NewItem[]): void {
    if (!items.length) return;
    let chunks = this.chunks;
    let last = chunks[chunks.length - 1];
    let fresh = false; // `last` is a private copy we may keep filling
    const out = chunks.slice();
    for (const it of items) {
      const item = { ...it, id: this.itemId++ } as TermItem;
      if (!last || last.items.length >= CHUNK_SIZE) {
        last = { id: this.chunkId++, items: [item] };
        out.push(last); fresh = true;
      } else if (fresh) {
        last.items.push(item);
      } else {
        last = { id: last.id, items: [...last.items, item] };
        out[out.length - 1] = last; fresh = true;
      }
    }
    this.lineTotal += items.length;
    while (this.lineTotal > MAX_LINES && out.length > 1) { this.lineTotal -= out[0].items.length; out.shift(); }
    chunks = out;
    this.chunks = chunks;
    this.touch();
  }
  private push(lines: string[], t: 'out' | 'sys' | 'note'): void { this.pushItems(lines.map((text) => ({ t, text }))); }
  get isEmpty(): boolean { return this.chunks.length === 0; }
  clear(): void { this.chunks = []; this.lineTotal = 0; this.touch(); }
  plainText(): string {
    const out: string[] = [];
    for (const c of this.chunks) for (const it of c.items) {
      if (it.t === 'guide') out.push(`[Guide — step ${it.block.stepNo}: ${it.block.stepTitle}] ${it.block.reason}`);
      else if (it.t === 'note') out.push(`[Simulator note] ${it.text}`);
      else out.push(it.text);
    }
    if (this.phase === 'input') {
      const echo = this.inputEcho(this.line);
      out.push(this.prompt + echoText(echo));
    }
    return out.join('\n');
  }

  // ───────── settings ─────────
  private pcPrompt(): string {
    if (this.target.kind !== 'pc') return '';
    return this.target.os === 'macos' ? 'student@MacBook ~ % ' : 'C:\\Users\\student>';
  }
  private pageLength(): number {
    if (!this.session || this.pasting) return 0;
    let paging = true;
    try { paging = this.lab.getState().settings?.terminalPaging !== false; } catch { /* keep default */ }
    if (!paging) return 0;
    const length = this.session.termLength;
    // Legacy fixtures are fixed at the default; don't infer session state from the command's spelling.
    return typeof length === 'number' && Number.isInteger(length) && length >= 0 ? length : DEFAULT_PAGE;
  }
  private examMode(): boolean {
    try { return this.lab.getState().scenario?.mode === 'exam'; } catch { return false; }
  }

  // ───────── sessions ─────────
  /** Show a console session (after lab.openConsole succeeded). Re-attaching the same open session changes nothing. */
  attach(session: SessionView, banner: string | undefined): void {
    this.batch(() => {
      const same = this.session && this.session.id === session.id && this.phase !== 'closed' && this.phase !== 'idle';
      if (same) {
        this.session = session;
        if (this.phase === 'input') this.takePrompt(session);
        this.touch();
        return;
      }
      this.cancelTimers();
      if (!this.isEmpty) this.push(['', '── connected again ──'], 'sys');
      this.push(splitLines(banner), 'out');
      this.session = session;
      this.takePrompt(session);
      this.line = ''; this.cursor = 0; this.histIdx = null;
      this.closedReason = '';
      this.phase = session.closed ? 'closed' : 'input';
      if (session.closed) this.closedReason = 'The session is closed.';
      this.touch();
    });
  }
  private cancelTimers(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null; this.afterDelay = null; this.pending = []; this.afterPending = null;
    this.queue = []; this.queueTail = ''; this.pasting = false;
  }
  /** The IOS session ended (logout, cable unplugged, Telnet closed). */
  private sessionEnded(reason: string): void {
    this.cancelTimers();
    this.line = ''; this.cursor = 0; this.histIdx = null; this.secret = false;
    if (this.target.kind === 'pc') {
      this.session = null;
      if (reason) this.push([reason], 'sys');
      this.push([''], 'out');
      this.prompt = this.pcPrompt();
      this.phase = 'input';
    } else {
      this.phase = 'closed';
      this.closedReason = reason || 'The session is closed.';
    }
    this.touch();
  }
  /** Called after every lab change: pick up a new prompt (hostname changed by a config file) or a lost session. */
  sync(): void {
    if (this.executing || !this.session || this.phase === 'closed' || this.phase === 'idle') return;
    const id = this.session.id;
    let listed: SessionView | undefined;
    try { listed = (this.lab.getState().sessions ?? []).find((s) => s && s.id === id); } catch { return; }
    if (this.target.kind === 'console') {
      let pc: string | null | undefined;
      try { pc = this.lab.consolePcOf(this.target.deviceId); } catch { pc = undefined; }
      if (pc === null) { this.batch(() => { this.push(['', 'The console cable was unplugged.'], 'sys'); this.sessionEnded('The console cable is not connected any more.'); }); return; }
    }
    if (!listed || listed.closed) {
      this.batch(() => this.sessionEnded(this.target.kind === 'pc' ? 'Connection to host lost.' : 'The session was closed.'));
      return;
    }
    const previousPending = this.pendingInput;
    this.session = listed;
    if (this.phase === 'input' && this.queue.length === 0) {
      const before = this.prompt;
      const wasSecret = this.secret;
      const pendingChanged = previousPending?.kind !== this.pendingInput?.kind || previousPending?.paste !== this.pendingInput?.paste;
      this.takePrompt(listed);
      if (before !== this.prompt || wasSecret !== this.secret || pendingChanged) {
        if (previousPending || this.pendingInput) { this.line = ''; this.cursor = 0; this.histDraft = ''; this.histIdx = null; }
        this.touch();
      }
    }
  }

  private takePrompt(view: Pick<SessionView, 'prompt' | 'secret' | 'pendingInput'>): void {
    this.prompt = view.prompt ?? '';
    this.secret = !!view.secret || view.pendingInput?.kind === 'password'
      || (view.pendingInput === undefined && /^Password:\s*$/i.test(this.prompt));
  }

  get pendingInput(): PendingInputView | null {
    if (!this.session) return null;
    if (this.session.pendingInput !== undefined) return this.session.pendingInput;
    // Legacy mock views: treat an unfamiliar prompt as manual input, not as a command prompt.
    if (this.secret) return { kind: 'password', paste: 'manual' };
    if (/^Destination filename \[/.test(this.prompt)) return { kind: 'text', paste: 'allow' };
    if (/initial configuration dialog.*\[yes\/no\]/i.test(this.prompt)) return { kind: 'confirm', paste: 'allow' };
    if (/\[confirm\]|\[yes\/no\]/i.test(this.prompt)) return { kind: 'confirm', paste: 'manual' };
    return IOS_PROMPT.test(this.prompt) ? null : { kind: 'text', paste: 'manual' };
  }

  // ───────── input line ─────────
  setLine(line: string, cursor: number): void {
    if (this.phase !== 'input') return;
    const clean = line.replace(/[\r\n]/g, '');
    const c = Math.max(0, Math.min(clean.length, cursor));
    if (clean === this.line && c === this.cursor) return;
    this.line = clean; this.cursor = c;
    this.touch();
  }
  setCursor(cursor: number): void { this.setLine(this.line, cursor); }
  edit(op: 'home' | 'end' | 'kill-start' | 'kill-end' | 'kill-word' | 'left' | 'right' | 'delete'): void {
    if (this.phase !== 'input') return;
    const { line, cursor } = this;
    switch (op) {
      case 'home': this.setLine(line, 0); break;
      case 'end': this.setLine(line, line.length); break;
      case 'left': this.setLine(line, cursor - 1); break;
      case 'right': this.setLine(line, cursor + 1); break;
      case 'kill-start': this.setLine(line.slice(cursor), 0); break;
      case 'kill-end': this.setLine(line.slice(0, cursor), cursor); break;
      case 'delete': this.setLine(line.slice(0, cursor) + line.slice(cursor + 1), cursor); break;
      case 'kill-word': {
        const before = line.slice(0, cursor).replace(/\S+\s*$/, '');
        this.setLine(before + line.slice(cursor), before.length);
        break;
      }
    }
  }

  // ───────── history ─────────
  private history(): string[] {
    if (this.session) {
      try { const h = this.lab.sessionHistory(this.session.id); return Array.isArray(h) ? h.filter((s) => typeof s === 'string') : []; } catch { return []; }
    }
    return this.pcHistory;
  }
  historyPrev(): void {
    if (this.phase !== 'input' || this.secret || this.pendingInput) return;
    if (this.histIdx === null) { this.histList = this.history().slice(); this.histDraft = this.line; this.histIdx = this.histList.length; }
    if (this.histIdx > 0) { this.histIdx--; const l = this.histList[this.histIdx] ?? ''; this.setLine(l, l.length); }
  }
  historyNext(): void {
    if (this.phase !== 'input' || this.secret || this.pendingInput || this.histIdx === null) return;
    this.histIdx++;
    if (this.histIdx >= this.histList.length) { this.histIdx = null; this.setLine(this.histDraft, this.histDraft.length); }
    else { const l = this.histList[this.histIdx] ?? ''; this.setLine(l, l.length); }
  }

  // ───────── running lines ─────────
  enter(): void {
    if (this.phase !== 'input') return;
    const line = this.line;
    this.batch(() => this.submit(line));
    this.pump();
  }
  inputEcho(line = this.line): InputEcho {
    if (this.secret) return { kind: 'hidden' };
    if (this.session && this.lab.sessionInputEcho) {
      try { return this.lab.sessionInputEcho(this.session.id, line); }
      catch { return { kind: 'plain', text: line }; }
    }
    return { kind: 'plain', text: line };
  }
  private pushEcho(echo: InputEcho, suffix = ''): void {
    this.push([this.prompt + echoText(echo) + suffix], 'out');
  }
  private submit(line: string): void {
    const preview = this.inputEcho(line);
    this.line = ''; this.cursor = 0; this.histIdx = null; this.histDraft = '';
    let view: NormView;
    this.executing = true;
    try {
      if (this.session) view = normExec(this.lab.sessionExec(this.session.id, line), this.prompt);
      else if (this.target.kind === 'pc') view = normPc(this.lab.pcExec(this.target.pcId, line), this.pcPrompt());
      else { this.push(['No session is open.'], 'sys'); return; }
    } catch {
      this.push(['The simulator could not run this line.'], 'sys');
      this.dropQueue();
      return;
    } finally { this.executing = false; }
    // An IOS submission is echoed only after the authoritative result declares it safe.
    const echo = this.secret ? { kind: 'hidden' as const } : view.echo ?? preview;
    this.pushEcho(echo);
    if (!this.session && line.trim() && echo.kind === 'plain') { this.pcHistory.push(line); if (this.pcHistory.length > 200) this.pcHistory.shift(); }
    this.present(view, echoText(echo));
  }
  private present(view: NormView, line: string): void {
    if (view.clear) { this.chunks = []; this.lineTotal = 0; }
    if (this.session) this.session = {
      ...this.session, prompt: view.prompt, secret: view.secret, closed: view.closed,
      termLength: view.termLength ?? this.session.termLength, pendingInput: view.pendingInput,
    };
    const finish = () => {
      if (view.notes.length) this.push(view.notes, 'note');
      if (view.blocked) { this.pushItems([{ t: 'guide', block: view.blocked, line }]); this.dropQueue(); }
      else if (this.session && this.pasting && (view.closed || rejected(view))) this.dropQueue();
      if (view.delayMs > 0) this.startDelay(view.delayMs, () => this.settle(view));
      else this.settle(view);
    };
    this.page(splitLines(view.output), finish);
  }
  private page(lines: string[], finish: () => void): void {
    const len = this.pageLength();
    const rows = Math.max(1, len - 1);
    if (len > 0 && lines.length > rows) {
      this.push(lines.slice(0, rows), 'out');
      this.pending = lines.slice(rows);
      this.afterPending = finish;
      this.phase = 'more';
      this.touch();
    } else {
      this.push(lines, 'out');
      finish();
    }
  }
  private settle(view: NormView): void {
    if (view.session) {
      // `telnet <router>` from the PC prompt: this window is the router's session until it closes.
      this.push(splitLines(view.banner), 'out');
      this.session = view.session;
      this.takePrompt(view.session);
      if (view.session.closed) this.sessionEnded('Connection closed by foreign host.');
      else this.phase = 'input';
    } else if (view.closed) {
      this.sessionEnded('');
    } else {
      // sync() may have received a newer session snapshot while output was delayed or paused.
      this.takePrompt(this.session ?? view);
      this.phase = 'input';
    }
    this.touch();
  }
  private startDelay(ms: number, done: () => void): void {
    this.phase = 'busy';
    this.afterDelay = done;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.endDelay(), ms);
    this.touch();
  }
  private endDelay(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const f = this.afterDelay;
    this.afterDelay = null;
    if (!f) return;
    this.batch(f);
    this.pump();
  }
  /** A key pressed while the terminal is waiting (delay) or paused (--More--). Returns true when the key was used. */
  anyKey(key: string): boolean {
    if (this.phase === 'busy') { this.endDelay(); return true; }
    if (this.phase !== 'more') return false;
    this.batch(() => {
      const len = this.pageLength() || DEFAULT_PAGE;
      if (key === ' ') this.push(this.pending.splice(0, Math.max(1, len - 1)), 'out');
      else if (key === 'Enter') this.push(this.pending.splice(0, 1), 'out');
      else if (key === 'Escape' || key.toLowerCase() === 'q') this.pending = [];
      else return;
      if (this.pending.length === 0) {
        const f = this.afterPending;
        this.afterPending = null;
        this.phase = 'input';
        if (f) f();
      }
      this.touch();
    });
    this.pump();
    return true;
  }

  /** '?' asks for help only at IOS command prompts. Else it is regular input. */
  help(): boolean {
    if (this.phase !== 'input' || !this.session || this.secret || this.pendingInput) return false;
    const before = this.line.slice(0, this.cursor);
    let text = '';
    try { const h = this.lab.sessionHelp(this.session.id, before); text = typeof h === 'string' ? h : ''; }
    catch { text = ''; }
    this.batch(() => {
      this.pushEcho(this.inputEcho(before), '?');
      this.page(splitLines(text), () => { this.phase = 'input'; this.touch(); });
    });
    return true;
  }
  /** Tab. Returns false when Tab is not a terminal key right now. */
  complete(): boolean {
    if (this.phase !== 'input' || !this.session || this.secret || this.pendingInput) return false;
    const before = this.line.slice(0, this.cursor);
    const after = this.line.slice(this.cursor);
    let r: { line: string; candidates: string[] } | undefined;
    try { r = this.lab.sessionComplete(this.session.id, before); } catch { /* No completion available. */ }
    if (r && typeof r.line === 'string' && r.line !== before) { this.setLine(r.line + after, r.line.length); return true; }
    const cands = r && Array.isArray(r.candidates) ? r.candidates : [];
    if (cands.length > 1 && !this.examMode()) {
      this.batch(() => {
        this.pushEcho(this.inputEcho());
        this.push([`Tab: more than one command starts like this (${cands.slice(0, 12).join(', ')}${cands.length > 12 ? ', …' : ''}). Type more letters.`], 'note');
      });
    }
    return true;
  }
  interrupt(key: 'ctrl-c' | 'ctrl-z'): void {
    if (this.phase === 'busy' || this.phase === 'more') { this.dropQueue(); this.anyKey('q'); return; }
    if (this.phase !== 'input') return;
    const echo = this.inputEcho();
    const typed = this.prompt + echoText(echo);
    this.batch(() => {
      this.line = ''; this.cursor = 0; this.histIdx = null;
      if (!this.session) { this.pushEcho(echo, '^C'); return; }
      let view: NormView;
      this.executing = true;
      try { view = normExec(this.lab.sessionKey(this.session.id, key), this.prompt); }
      catch { this.push(['The simulator could not handle this key.'], 'sys'); return; }
      finally { this.executing = false; }
      // The device's answer continues the line that was being typed ("R1(config)#^Z").
      const lines = splitLines(typed + view.output);
      this.push([lines.shift() ?? typed], 'out');
      this.push(lines, 'out');
      this.present({ ...view, output: '' }, '');
    });
    this.pump();
  }

  // ───────── paste ─────────
  paste(text: string): void {
    if (this.phase !== 'input') return;
    const norm = text.replace(/\r\n?/g, '\n');
    if (!norm.includes('\n')) {
      const l = this.line.slice(0, this.cursor) + norm + this.line.slice(this.cursor);
      this.setLine(l, this.cursor + norm.length);
      return;
    }
    if (this.pasteRequiresManualInput()) {
      const reason = this.secret ? 'Paste only one line at a password prompt.' : 'Enter this reply separately before pasting more lines.';
      this.push([`${reason} Nothing was sent.`], 'sys');
      return;
    }
    const parts = norm.split('\n');
    const first = this.line.slice(0, this.cursor) + parts[0];
    const tail = (parts[parts.length - 1] ?? '') + this.line.slice(this.cursor);
    const middle = parts.slice(1, -1);
    this.queue = [first, ...middle];
    this.queueTail = tail;
    this.line = ''; this.cursor = 0;
    this.pasting = true;
    this.pump();
  }
  private dropQueue(): void {
    const remaining = this.queue.length + Number(!!this.queueTail);
    if (remaining) this.push([`Paste stopped here. ${remaining} more line${remaining === 1 ? ' was' : 's were'} not sent.`], 'sys');
    this.queue = []; this.queueTail = ''; this.pasting = false;
  }
  private pastedCommand(line: string): string | null {
    if (!this.session || this.pendingInput || !IOS_PROMPT.test(this.prompt)) return line;
    const candidate = line.trimStart();
    const pastedPrompt = IOS_PROMPT.exec(candidate)?.[0];
    if (!pastedPrompt) return line;
    // A copied prompt is context, not a command. Do not silently send a line copied from another device/mode.
    if (pastedPrompt !== this.prompt) {
      this.push(['The pasted prompt does not match this terminal. Review the device and mode, or use the configuration editor for a file.'], 'sys');
      return null;
    }
    return candidate.slice(pastedPrompt.length).trimStart();
  }
  private pasteRequiresManualInput(): boolean { return this.secret || this.pendingInput?.paste === 'manual'; }
  private pump(): void {
    if (!this.pasting) return;
    this.batch(() => {
      while (this.queue.length && this.phase === 'input') {
        if (this.pasteRequiresManualInput()) { this.dropQueue(); return; }
        const next = this.queue[0];
        const command = this.pastedCommand(next);
        if (command === null) { this.dropQueue(); return; }
        this.queue.shift();
        this.submit(command);
      }
      if (!this.queue.length && this.phase === 'input') {
        if (this.pasteRequiresManualInput()) { this.dropQueue(); return; }
        this.pasting = false;
        if (this.queueTail) { const command = this.pastedCommand(this.queueTail); this.line = command ?? ''; this.cursor = this.line.length; this.queueTail = ''; }
        this.touch();
      } else if (!this.queue.length && this.phase === 'closed') {
        this.pasting = false; this.queueTail = '';
      }
    });
  }
}

/** One model per console (keyed by device) and one per PC command prompt. */
export class TermRegistry {
  private lab: LabApi;
  private models = new Map<string, TermModel>();
  constructor(lab: LabApi) { this.lab = lab; }
  console(deviceId: string): TermModel {
    const key = `console:${deviceId}`;
    let m = this.models.get(key);
    if (!m) { m = new TermModel(this.lab, { kind: 'console', deviceId }); this.models.set(key, m); }
    return m;
  }
  pc(pcId: string, os: 'windows' | 'macos', label: string): TermModel {
    const key = `pc:${pcId}`;
    let m = this.models.get(key);
    if (!m) { m = new TermModel(this.lab, { kind: 'pc', pcId, os, label }); this.models.set(key, m); }
    return m;
  }
  syncAll(): void { for (const m of this.models.values()) m.sync(); }
  dispose(): void { for (const m of this.models.values()) m.dispose(); this.models.clear(); }
}
