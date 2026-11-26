/**
 * IOS-style CLI framework: pattern grammar, abbreviation matching, '?' help, Tab completion,
 * modes, prompts, pending (multi-step) input and error rendering.
 *
 * PATTERN DSL (tokens separated by spaces)
 *   keyword                 literal keyword, may be abbreviated to any unique prefix          ip address
 *   <name:type>             parameter captured as args[name]                                 <addr:ip>
 *        types: ip | mask | wildcard (dotted quad, string) · int | int(1-99) (number) · port (name or number → number)
 *               word (one token) · text (rest of the line, must be last) · if (interface name, 1 or 2 tokens → canonical name)
 *   {name:a|b|c}            keyword choice captured as args[name] (canonical full keyword)    {dir:in|out}
 *   {a|b}                   keyword choice, not captured (test with env.has('a'))
 *   [ ... ]                 optional group (may nest)                                         [secondary]
 * A command may list several patterns. `no` forms are written as explicit patterns: 'no ip address [<addr:ip> <mask:mask>]'.
 */
import type { DeviceKind, Feature, InterfaceConfig, IosDevice, World } from '../types.ts';
import { isIp, parseIfName, parsePort } from '../ip.ts';
import { unsupportedCredentialType } from '../config/credentials.ts';
import { getIos } from '../world.ts';

// ───────────────────────────── Modes ─────────────────────────────
export type ModeName =
  | 'user' | 'priv' | 'config' | 'config-if' | 'config-line' | 'config-router' | 'dhcp-config'
  | 'config-std-nacl' | 'config-ext-nacl' | 'config-isakmp' | 'cfg-crypto-trans' | 'config-crypto-map'
  | 'config-cmap' | 'config-pmap' | 'config-pmap-c' | 'config-vlan';

export const DEFAULT_TERMINAL_LENGTH = 24;
export const EXEC_MODES: ModeName[] = ['user', 'priv'];
export const SUB_CONFIG_MODES: ModeName[] = [
  'config-if', 'config-line', 'config-router', 'dhcp-config', 'config-std-nacl', 'config-ext-nacl', 'config-isakmp',
  'cfg-crypto-trans', 'config-crypto-map', 'config-cmap', 'config-pmap', 'config-pmap-c', 'config-vlan',
];
export const CONFIG_MODES: ModeName[] = ['config', ...SUB_CONFIG_MODES];

const PROMPT_SUFFIX: Record<ModeName, string> = {
  user: '>', priv: '#', config: '(config)#', 'config-if': '(config-if)#', 'config-line': '(config-line)#',
  'config-router': '(config-router)#', 'dhcp-config': '(dhcp-config)#', 'config-std-nacl': '(config-std-nacl)#',
  'config-ext-nacl': '(config-ext-nacl)#', 'config-isakmp': '(config-isakmp)#', 'cfg-crypto-trans': '(cfg-crypto-trans)#',
  'config-crypto-map': '(config-crypto-map)#', 'config-cmap': '(config-cmap)#', 'config-pmap': '(config-pmap)#',
  'config-pmap-c': '(config-pmap-c)#', 'config-vlan': '(config-vlan)#',
};

// ───────────────────────────── Sessions ─────────────────────────────
export interface PendingInput {
  /** Key of the handler registered with registerPending(). */
  kind: string;
  /** Shown instead of the normal prompt, e.g. 'Password: ' or 'Proceed with reload? [confirm]'. */
  prompt: string;
  /** Input must not be echoed. */
  secret?: boolean;
  /** Non-secret confirmation/choice rather than free text. */
  response?: 'confirm';
  /** Pending replies require manual entry unless this question explicitly accepts queued input. */
  paste?: 'allow';
  /** A control key may discard input, but not dismiss this prompt (e.g. line login). */
  interrupt?: 'keep';
  data?: Record<string, unknown>;
}
export interface CliSession {
  id: string;
  deviceId: string;
  via: 'console' | 'vty' | 'file';
  /** vty only: client address as the device sees it (after NAT). */
  remoteAddr?: string;
  mode: ModeName;
  /** Mode context: config-if → { ifNames: string[], range?: boolean }; other modes define their own keys. */
  ctx: Record<string, unknown>;
  pending?: PendingInput;
  history: string[];
  termLength: number;
  /** Starting screen length for the selected line (before a terminal length override). */
  defaultTermLength: number;
  closed: boolean;
}

/** Only the shape of the next input is public; never expose handler state/data or accumulated text. */
export interface PendingInputView {
  kind: 'password' | 'text' | 'confirm';
  paste: 'manual' | 'allow';
}
export function pendingInputView(session: CliSession): PendingInputView | null {
  const p = session.pending;
  if (session.closed || !p) return null;
  return { kind: p.secret ? 'password' : p.response ?? 'text', paste: !p.secret && p.paste === 'allow' ? 'allow' : 'manual' };
}
export type InputEcho = { kind: 'plain'; text: string } | { kind: 'hidden' };

export type ExecStatus = 'ok' | 'invalid' | 'incomplete' | 'ambiguous' | 'rejected' | 'empty' | 'pending';
export interface ExecOutcome {
  /** Text printed by the command ('' when none). Lines end with '\n'. */
  output: string;
  /** Prompt to show next (the pending prompt while a multi-step input is open). */
  prompt: string;
  /** The next input line must not be echoed (password). */
  secret: boolean;
  status: ExecStatus;
  termLength: number;
  pendingInput: PendingInputView | null;
  /** Display-safe submitted input, never the alias expansion. */
  echo: InputEcho;
  feature: Feature;
  /** A state-changing command ran successfully. */
  mutated: boolean;
  /** The UI may wait this long before showing the output's end/prompt (DNS lookup of a typo, ping timeouts…). */
  delayMs?: number;
  closed: boolean;
  /** Simulator remarks that are NOT part of real IOS output (e.g. 'accepted, not simulated'). */
  notes: string[];
}

// ───────────────────────────── Command definitions ─────────────────────────────
export type Args = Record<string, any>;
export interface CmdEnv {
  world: World;
  device: IosDevice;
  session: CliSession;
  /** The command line as typed (trimmed). */
  line: string;
  /** Length of the prompt that was on screen when the line was typed (for commands that draw their own '^' marker). */
  promptLen: number;
  /** Map a column in env.line to the screen, including the original prompt, indentation, `do`, and alias. */
  screenColumn(column: number): number;
  /** True when the literal keyword (full spelling, lower case) was part of the matched command. */
  has(keyword: string): boolean;
  /** Print one or more lines of IOS output. A trailing newline is added if missing. */
  print(text: string): void;
  /** Print an IOS error (e.g. '% Bad mask /26 for address 10.0.0.1') and stop the command with status 'rejected'. */
  reject(text?: string): never;
  /** Simulator remark shown outside the terminal stream. */
  note(text: string): void;
  setMode(mode: ModeName, ctx?: Record<string, unknown>): void;
  /** Ask a follow-up question; the next input line goes to the registered pending handler. */
  ask(pending: PendingInput): void;
  delay(ms: number): void;
  /** Close the session (logout / connection closed). */
  close(): void;
}
export interface CommandDef {
  modes: ModeName | ModeName[];
  pattern: string | string[];
  feature: Feature;
  /** Help text per keyword or per '<param>' shown by '?'. Optional. */
  help?: Record<string, string>;
  /** Default: true in configuration modes, false in user/priv EXEC. */
  mutates?: boolean;
  /** Restrict to device kinds. Default: routers and switches. */
  kinds?: ('router' | 'switch')[];
  /** False for EXEC commands that change the command mode or close the session. */
  allowDo?: boolean;
  run(env: CmdEnv, args: Args): void;
}
export type PendingHandler = (env: CmdEnv, input: string, pending: PendingInput) => void;
export type SessionHook = (env: CmdEnv) => void;

class CliReject extends Error {}
type ExecSink = { out: string; notes: string[]; delay?: number; echo?: InputEcho };

// ───────────────────────────── Registry ─────────────────────────────
const registry: CommandDef[] = [];
const pendingHandlers: Record<string, PendingHandler> = {};
const sessionHooks: SessionHook[] = [];
let registryVersion = 0;
const grammarCache = new Map<string, Node>();

export function registerCommands(defs: CommandDef[]): void { registry.push(...defs); registryVersion++; grammarCache.clear(); }
export function registerPending(kind: string, handler: PendingHandler): void { pendingHandlers[kind] = handler; }
/** Runs when a console/vty session starts (banner, initial configuration dialog, line login). */
export function registerSessionHook(hook: SessionHook): void { sessionHooks.push(hook); }
/** Test helper: wipe everything registered so far. */
export function resetRegistry(): void {
  registry.length = 0; sessionHooks.length = 0; registryVersion++; grammarCache.clear();
  for (const k of Object.keys(pendingHandlers)) delete pendingHandlers[k];
  registerCommands(coreCommands());
}

// ───────────────────────────── Pattern compilation ─────────────────────────────
type ParamType = 'ip' | 'mask' | 'wildcard' | 'int' | 'port' | 'word' | 'text' | 'if';
type Elem =
  | { t: 'kw'; word: string; capture?: string }
  | { t: 'param'; name: string; type: ParamType; lo?: number; hi?: number };
type Ast = (Elem | { t: 'choice'; words: string[]; capture?: string } | { t: 'opt'; seq: Ast })[];

interface ParamEdge { name: string; type: ParamType; lo?: number; hi?: number; node: Node; help?: string }
interface Node {
  kws: Map<string, { node: Node; capture?: string; help?: string }>;
  params: ParamEdge[];
  cmd?: CommandDef;
}
const newNode = (): Node => ({ kws: new Map(), params: [] });

function parsePattern(pattern: string): Ast {
  const toks = pattern.match(/\[|\]|\{[^}]*\}|<[^>]*>|[^\s\[\]]+/g) ?? [];
  let i = 0;
  const seq = (): Ast => {
    const out: Ast = [];
    while (i < toks.length) {
      const t = toks[i];
      if (t === ']') break;
      i++;
      if (t === '[') { const inner = seq(); if (toks[i] !== ']') throw new Error(`unbalanced [ in pattern: ${pattern}`); i++; out.push({ t: 'opt', seq: inner }); }
      else if (t.startsWith('{')) {
        const body = t.slice(1, -1); const c = body.indexOf(':');
        const capture = c >= 0 ? body.slice(0, c).trim() : undefined;
        out.push({ t: 'choice', capture, words: (c >= 0 ? body.slice(c + 1) : body).split('|').map((w) => w.trim().toLowerCase()) });
      } else if (t.startsWith('<')) {
        const m = /^<([A-Za-z_][\w]*):(ip|mask|wildcard|int|port|word|text|if)(?:\((\d+)-(\d+)\))?>$/.exec(t);
        if (!m) throw new Error(`bad parameter ${t} in pattern: ${pattern}`);
        out.push({ t: 'param', name: m[1], type: m[2] as ParamType, lo: m[3] ? Number(m[3]) : undefined, hi: m[4] ? Number(m[4]) : undefined });
      } else out.push({ t: 'kw', word: t.toLowerCase() });
    }
    return out;
  };
  const ast = seq();
  if (i < toks.length) throw new Error(`unbalanced ] in pattern: ${pattern}`);
  return ast;
}
function expand(ast: Ast): Elem[][] {
  let acc: Elem[][] = [[]];
  for (const e of ast) {
    let alts: Elem[][];
    if (e.t === 'opt') alts = [[], ...expand(e.seq)];
    else if (e.t === 'choice') alts = e.words.map((w) => [{ t: 'kw' as const, word: w, capture: e.capture }]);
    else alts = [[e]];
    const next: Elem[][] = [];
    for (const a of acc) for (const b of alts) next.push([...a, ...b]);
    acc = next;
  }
  return acc;
}
const PARAM_RANK: Record<ParamType, number> = { ip: 0, mask: 0, wildcard: 0, int: 1, port: 2, if: 3, word: 4, text: 5 };

function buildGrammar(mode: ModeName, kind: DeviceKind, isDo = false): Node {
  const key = `${mode}|${kind}|${isDo}|${registryVersion}`;
  const cached = grammarCache.get(key);
  if (cached) return cached;
  const root = newNode();
  for (const def of registry) {
    const modes = Array.isArray(def.modes) ? def.modes : [def.modes];
    if (!modes.includes(mode) || (isDo && def.allowDo === false)) continue;
    if (def.kinds && !def.kinds.includes(kind as 'router' | 'switch')) continue;
    for (const pattern of Array.isArray(def.pattern) ? def.pattern : [def.pattern]) {
      for (const variant of expand(parsePattern(pattern))) {
        let node = root;
        for (const e of variant) {
          if (e.t === 'kw') {
            let edge = node.kws.get(e.word);
            if (!edge) { edge = { node: newNode(), capture: e.capture, help: def.help?.[e.word] }; node.kws.set(e.word, edge); }
            else { if (!edge.help) edge.help = def.help?.[e.word]; if (!edge.capture) edge.capture = e.capture; }
            node = edge.node;
          } else {
            let edge = node.params.find((p) => p.name === e.name && p.type === e.type && p.lo === e.lo && p.hi === e.hi);
            if (!edge) {
              edge = { name: e.name, type: e.type, lo: e.lo, hi: e.hi, node: newNode(), help: def.help?.[`<${e.name}>`] };
              node.params.push(edge);
              node.params.sort((a, b) => PARAM_RANK[a.type] - PARAM_RANK[b.type]);
            }
            node = edge.node;
          }
        }
        if (node.cmd && node.cmd !== def) throw new Error(`CLI grammar collision in mode ${mode}: "${pattern}"`);
        node.cmd = def;
      }
    }
  }
  grammarCache.set(key, root);
  return root;
}

// ───────────────────────────── Matching ─────────────────────────────
interface Tok { text: string; start: number }
function tokenize(line: string): Tok[] {
  const out: Tok[] = []; const re = /\S+/g; let m: RegExpExecArray | null;
  while ((m = re.exec(line))) out.push({ text: m[0], start: m.index });
  return out;
}
function matchParam(p: ParamEdge, toks: Tok[], i: number, line: string): { n: number; value: unknown } | null {
  const t = toks[i].text;
  switch (p.type) {
    case 'ip': case 'mask': case 'wildcard': return isIp(t) ? { n: 1, value: t } : null;
    case 'int': {
      if (!/^\d+$/.test(t)) return null;
      const v = Number(t);
      if (!Number.isSafeInteger(v) || (p.lo !== undefined && v < p.lo) || (p.hi !== undefined && v > p.hi)) return null;
      return { n: 1, value: v };
    }
    case 'port': { const v = parsePort(t); return v === null ? null : { n: 1, value: v }; }
    case 'word': return { n: 1, value: t };
    case 'text': return { n: toks.length - i, value: line.slice(toks[i].start).trimEnd() };
    case 'if': {
      const r = parseIfName(t);
      if (!r) return null;
      if ('name' in r) return { n: 1, value: r.name };
      const nx = toks[i + 1]?.text;
      if (nx && /^[0-9][0-9/.:]*$/.test(nx)) return { n: 2, value: r.typeOnly + nx };
      return null;
    }
  }
}
interface MatchOk { ok: true; def: CommandDef; args: Args; kws: Set<string> }
interface MatchErr { ok: false; error: 'invalid' | 'incomplete' | 'ambiguous'; at: number }
type MatchResult = MatchOk | MatchErr;
const worse = (a: MatchErr, b: MatchErr): MatchErr => (b.at > a.at || (b.at === a.at && a.error === 'invalid' && b.error !== 'invalid') ? b : a);

function matchLine(root: Node, line: string): MatchResult {
  const toks = tokenize(line);
  const walk = (node: Node, i: number, args: Args, kws: string[]): MatchResult => {
    if (i === toks.length) return node.cmd ? { ok: true, def: node.cmd, args, kws: new Set(kws) } : { ok: false, error: 'incomplete', at: line.length };
    const t = toks[i]; const low = t.text.toLowerCase();
    let best: MatchErr = { ok: false, error: 'invalid', at: t.start };
    const exact = node.kws.get(low);
    const cands = exact ? [[low, exact] as const] : [...node.kws].filter(([k]) => k.startsWith(low));
    if (cands.length > 1) return { ok: false, error: 'ambiguous', at: t.start };
    if (cands.length === 1) {
      const [word, edge] = cands[0];
      const r = walk(edge.node, i + 1, edge.capture ? { ...args, [edge.capture]: word } : args, [...kws, word]);
      if (r.ok) return r;
      best = worse(best, r);
    }
    for (const p of node.params) {
      const m = matchParam(p, toks, i, line);
      if (!m) continue;
      const r = walk(p.node, i + m.n, { ...args, [p.name]: m.value }, kws);
      if (r.ok) return r;
      best = worse(best, r);
    }
    return best;
  };
  return walk(root, 0, {}, []);
}

/** All grammar nodes reachable after consuming every token of `line` (used by help and completion). */
function reach(root: Node, line: string): Node[] {
  const toks = tokenize(line);
  // params may consume 2 tokens (interface names) → walk as a frontier of [node, index]
  let frontier: [Node, number][] = [[root, 0]];
  const done: Node[] = [];
  while (frontier.length) {
    const next: [Node, number][] = [];
    for (const [node, idx] of frontier) {
      if (idx === toks.length) { done.push(node); continue; }
      const low = toks[idx].text.toLowerCase();
      const exact = node.kws.get(low);
      const cands = exact ? [exact] : [...node.kws].filter(([k]) => k.startsWith(low)).map(([, e]) => e);
      if (cands.length > 1) continue;
      if (cands.length === 1) next.push([cands[0].node, idx + 1]);
      for (const p of node.params) { const m = matchParam(p, toks, idx, line); if (m) next.push([p.node, idx + m.n]); }
    }
    frontier = next;
  }
  return [...new Set(done)];
}
function placeholder(p: ParamEdge): string {
  switch (p.type) {
    case 'ip': case 'mask': case 'wildcard': return 'A.B.C.D';
    case 'int': return `<${p.lo ?? 0}-${p.hi ?? 4294967295}>`;
    case 'port': return '<0-65535>';
    case 'word': return 'WORD';
    case 'text': return 'LINE';
    case 'if': return '<interface>';
  }
}

// ───────────────────────────── Prompt / grammar selection ─────────────────────────────
export function promptFor(world: World, session: CliSession): string {
  if (session.closed) return '';
  if (session.pending) return session.pending.prompt;
  const dev = getIos(world, session.deviceId);
  const suffix = session.mode === 'config-if' && session.ctx.range ? '(config-if-range)#' : PROMPT_SUFFIX[session.mode];
  return dev.config.hostname + suffix;
}
function aliasesFor(dev: IosDevice, mode: ModeName) {
  const cls = EXEC_MODES.includes(mode) ? 'exec' : mode === 'config' ? 'configure' : mode === 'config-if' ? 'interface' : null;
  return dev.config.aliases.filter((a) => a.mode === cls);
}
interface PreparedLine {
  line: string;
  grammarMode: ModeName;
  isDo: boolean;
  /** Map a column in the transformed command back onto the exact input as typed. */
  inputColumn(column: number): number;
  aliasLength: number;
  aliases: ReturnType<typeof aliasesFor>;
}
function prepareLine(dev: IosDevice, mode: ModeName, raw: string): PreparedLine {
  const leading = raw.length - raw.trimStart().length;
  let line = raw.slice(leading);
  const doPrefix = CONFIG_MODES.includes(mode) ? /^do(?:\s+|$)/i.exec(line)?.[0] : undefined;
  const isDo = doPrefix !== undefined;
  const grammarMode = isDo ? 'priv' : mode;
  const shift = leading + (doPrefix?.length ?? 0);
  if (isDo) line = line.slice(doPrefix.length);
  // Expand a full alias exactly once, before looking for a show output modifier. Leading space quotes a literal command.
  const aliases = leading && !isDo ? [] : aliasesFor(dev, grammarMode);
  const first = /^([^\s|]+)/.exec(line)?.[1];
  const alias = first === undefined ? undefined : aliases.find((a) => a.name === first);
  if (!alias || first === undefined) return { line, grammarMode, isDo, inputColumn: (col) => shift + col, aliasLength: 0, aliases };
  const command = alias.command.trim();
  return {
    line: command + line.slice(first.length), grammarMode, isDo, aliasLength: command.length, aliases,
    inputColumn: (col) => shift + (col < command.length ? 0 : col - command.length + first.length),
  };
}

/** Side-effect-free classification for pending UI input, guide denials and legacy journal entries. */
export function inspectInput(dev: IosDevice, session: Pick<CliSession, 'mode' | 'pending' | 'closed'>, raw: string): { echo: InputEcho; unsupportedCredential: boolean } {
  if (session.closed || session.pending?.secret) return { echo: { kind: 'hidden' }, unsupportedCredential: false };
  if (session.pending) return { echo: { kind: 'plain', text: raw }, unsupportedCredential: false };
  const prep = prepareLine(dev, session.mode, raw);
  return { echo: { kind: 'plain', text: raw }, unsupportedCredential: CONFIG_MODES.includes(prep.grammarMode) && unsupportedCredentialType(prep.line) };
}

const FILTERS = ['begin', 'exclude', 'include', 'section'] as const;
type FilterKind = (typeof FILTERS)[number];
function showPipe(line: string): { at: number; base: string; tail: string } | undefined {
  const first = /^([^\s|]+)/.exec(line)?.[1].toLowerCase();
  const at = line.indexOf('|');
  return first && 'show'.startsWith(first) && at >= 0 ? { at, base: line.slice(0, at).trimEnd(), tail: line.slice(at + 1) } : undefined;
}
interface Resolved extends PreparedLine { result: MatchResult; filter?: { kind: FilterKind; regex: RegExp } }
function resolve(world: World, session: CliSession, raw: string): Resolved {
  const dev = getIos(world, session.deviceId);
  const prep = prepareLine(dev, session.mode, raw);
  const line = prep.line.trimEnd();
  const pipe = EXEC_MODES.includes(prep.grammarMode) ? showPipe(line) : undefined;
  const body = pipe?.base ?? line;
  let result = matchLine(buildGrammar(prep.grammarMode, dev.kind, prep.isDo), body);
  if (pipe && result.ok && result.kws.has('show')) {
    const [op, expr] = tokenize(pipe.tail);
    const incomplete = (): MatchErr => ({ ok: false, error: 'incomplete', at: line.length });
    const invalid = (at: number): MatchErr => ({ ok: false, error: 'invalid', at: pipe.at + 1 + at });
    if (!op) result = incomplete();
    else {
      const kind = FILTERS.find((k) => k.startsWith(op.text.toLowerCase()));
      if (!kind) result = invalid(op.start);
      else if (!expr) result = incomplete();
      else {
        try { return { ...prep, line: body, result, filter: { kind, regex: new RegExp(pipe.tail.slice(expr.start)) } }; }
        catch { result = invalid(expr.start); }
      }
    }
  } else if (pipe && result.ok) {
    // A command only takes an output modifier after matching a `show` invocation.
    result = matchLine(buildGrammar(prep.grammarMode, dev.kind, prep.isDo), line);
  }
  if (!result.ok && !prep.isDo && SUB_CONFIG_MODES.includes(session.mode)) {
    // Try global configuration grammar if no sub-mode command matches, e.g. `ip route` inside an interface.
    const up = matchLine(buildGrammar('config', dev.kind), line);
    if (up.ok && result.error !== 'ambiguous') return { ...prep, line, result: up, grammarMode: 'config' };
    if (!up.ok) result = worse(result, up);
  }
  return { ...prep, line, result };
}

/** Parse without executing. Used by guided mode to decide whether a command is allowed right now. */
export function inspectLine(world: World, session: CliSession, raw: string): { status: ExecStatus; feature: Feature; mutates: boolean } {
  if (session.closed) return { status: 'rejected', feature: 'system', mutates: false };
  if (session.pending) return { status: 'pending', feature: 'system', mutates: false };
  if (!raw.trim() || raw.trim().startsWith('!')) return { status: 'empty', feature: 'system', mutates: false };
  const r = resolve(world, session, raw);
  if (!r.result.ok) return { status: r.result.error, feature: 'system', mutates: false };
  const def = r.result.def;
  return { status: 'ok', feature: def.feature, mutates: def.mutates ?? CONFIG_MODES.includes(r.grammarMode) };
}

// ───────────────────────────── Execution ─────────────────────────────
function makeEnv(world: World, session: CliSession, line: string, kws: Set<string>, sink: ExecSink, promptLen = 0, inputColumn = (col: number) => col): CmdEnv {
  return {
    world, device: getIos(world, session.deviceId), session, line, promptLen,
    screenColumn: (col) => promptLen + inputColumn(Math.max(0, col)),
    has: (k) => kws.has(k.toLowerCase()),
    print: (text) => { sink.out += text.endsWith('\n') ? text : text + '\n'; },
    reject: (text) => { if (text !== undefined) sink.out += text.endsWith('\n') ? text : text + '\n'; throw new CliReject(text); },
    note: (text) => { sink.notes.push(text); },
    setMode: (mode, ctx = {}) => { session.mode = mode; session.ctx = ctx; },
    ask: (pending) => { session.pending = pending; },
    delay: (ms) => { sink.delay = Math.max(sink.delay ?? 0, ms); },
    close: () => { session.closed = true; session.pending = undefined; },
  };
}
function finish(world: World, session: CliSession, sink: ExecSink, status: ExecStatus, feature: Feature, mutated: boolean): ExecOutcome {
  return {
    output: sink.out, prompt: promptFor(world, session), secret: !!session.pending?.secret, status, feature, mutated,
    termLength: session.termLength, pendingInput: pendingInputView(session), echo: sink.echo ?? { kind: 'hidden' },
    delayMs: sink.delay, closed: session.closed, notes: sink.notes,
  };
}

export function execLine(world: World, session: CliSession, raw: string): ExecOutcome {
  const sink: ExecSink = { out: '', notes: [] };
  if (session.closed) return finish(world, session, sink, 'rejected', 'system', false);
  world.tick++;
  // Multi-step input (passwords, confirmations, dialogs)
  if (session.pending) {
    const pending = session.pending;
    if (!pending.secret) sink.echo = { kind: 'plain', text: raw };
    session.pending = undefined;
    const handler = pendingHandlers[pending.kind];
    const env = makeEnv(world, session, raw, new Set(), sink);
    try {
      if (!handler) { env.close(); env.reject('% This prompt is no longer available. Reconnect and try again.'); }
      handler(env, raw, pending);
    } catch (e) {
      if (!(e instanceof CliReject)) throw e;
      return finish(world, session, sink, 'rejected', 'system', false);
    }
    return finish(world, session, sink, 'pending', 'system', false);
  }
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith('!')) {
    sink.echo = { kind: 'plain', text: raw };
    return finish(world, session, sink, 'empty', 'system', false);
  }
  const promptLen = promptFor(world, session).length;
  const dev = getIos(world, session.deviceId);
  const r = resolve(world, session, raw);
  const echo = sink.echo = { kind: 'plain', text: raw };
  if (session.via !== 'file') {
    session.history.push(trimmed);
    if (session.history.length > 200) session.history.shift();
  }
  if (!r.result.ok) {
    const err = r.result;
    const toks = tokenize(r.line);
    if (err.error === 'ambiguous') sink.out += `% Ambiguous command:  "${echo.text.trim()}"\n`;
    else if (err.error === 'incomplete') sink.out += '% Incomplete command.\n';
    else if (EXEC_MODES.includes(session.mode) && r.aliasLength === 0 && toks.length === 1 && err.at === toks[0].start && /^[A-Za-z][\w.-]*$/.test(toks[0].text)) {
      // A lone unknown word in EXEC mode is treated as a host name to telnet to.
      if (dev.config.ipDomainLookup) { sink.out += `Translating "${toks[0].text}"...domain server (255.255.255.255)\n`; sink.delay = 6000; }
      else sink.out += `Translating "${toks[0].text}"\n`;
      sink.out += '% Unknown command or computer name, or unable to find computer address\n';
    } else {
      sink.out += ' '.repeat(promptLen + r.inputColumn(err.at)) + '^\n';
      sink.out += "% Invalid input detected at '^' marker.\n";
    }
    return finish(world, session, sink, err.error, 'system', false);
  }
  const { def, args, kws } = r.result;
  const staticMutates = def.mutates ?? CONFIG_MODES.includes(r.grammarMode);
  const modeBefore = session.mode; const ctxBefore = session.ctx;
  if (!r.isDo && r.grammarMode !== session.mode) { session.mode = r.grammarMode; session.ctx = {}; }
  const env = makeEnv(world, session, r.line.trim(), kws, sink, promptLen, r.inputColumn);
  try {
    def.run(env, args);
  } catch (e) {
    if (!(e instanceof CliReject)) throw e;
    if (r.grammarMode !== modeBefore && session.mode === r.grammarMode) { session.mode = modeBefore; session.ctx = ctxBefore; }
    return finish(world, session, sink, 'rejected', def.feature, false);
  }
  if (r.isDo) { session.mode = modeBefore; session.ctx = ctxBefore; }
  if (r.filter) sink.out = filterOutput(sink.out, r.filter.kind, r.filter.regex);
  return finish(world, session, sink, 'ok', def.feature, staticMutates);
}

/** IOS output modifiers. `section` keeps matching lines plus their indented children. */
export function filterOutput(output: string, kind: string, pattern: string | RegExp): string {
  if (!output) return '';
  const re = typeof pattern === 'string' ? new RegExp(pattern) : pattern;
  const lines = output.replace(/\n$/, '').split('\n');
  let out: string[] = [];
  if (kind === 'include') out = lines.filter((l) => re.test(l));
  else if (kind === 'exclude') out = lines.filter((l) => !re.test(l));
  else if (kind === 'begin') { const i = lines.findIndex((l) => re.test(l)); out = i < 0 ? [] : lines.slice(i); }
  else {
    let sectionDepth: number | undefined;
    for (const l of lines) {
      const depth = l.length - l.trimStart().length;
      if (sectionDepth !== undefined && l.trim() && depth > sectionDepth) { out.push(l); continue; }
      sectionDepth = undefined;
      if (re.test(l)) { sectionDepth = depth; out.push(l); }
    }
  }
  return out.length ? out.join('\n') + '\n' : '';
}

function helpRoots(dev: IosDevice, mode: ModeName, isDo: boolean): Node[] {
  const root = buildGrammar(mode, dev.kind, isDo);
  return !isDo && SUB_CONFIG_MODES.includes(mode) ? [root, buildGrammar('config', dev.kind)] : [root];
}
function usableShowPipe(root: Node, line: string) {
  const pipe = showPipe(line);
  if (!pipe) return;
  const base = matchLine(root, pipe.base);
  if (base.ok && base.kws.has('show')) return pipe;
}
function aliasHelp(a: ReturnType<typeof aliasesFor>[number]): string {
  const command = a.command;
  return `*${a.name}=${/\s/.test(command) ? `"${command}"` : command}`;
}

/** Output of pressing '?' after `line` (line excludes the '?'). */
export function helpFor(world: World, session: CliSession, line: string): string {
  if (session.pending || session.closed) return '';
  const dev = getIos(world, session.deviceId);
  const prep = prepareLine(dev, session.mode, line);
  if (prep.isDo && !prep.line && !/\s$/.test(line)) return 'do\n';
  const roots = helpRoots(dev, prep.grammarMode, prep.isDo);
  const pipe = usableShowPipe(roots[0], prep.line);
  if (pipe) {
    const toks = tokenize(pipe.tail);
    if (!toks.length) return FILTERS.map((k) => `  ${k}\n`).join('');
    const low = toks[0].text.toLowerCase();
    if (toks.length === 1 && !/\s$/.test(pipe.tail)) {
      const matches = FILTERS.filter((k) => k.startsWith(low));
      return matches.length ? matches.join('  ') + '\n' : '% Unrecognized command\n';
    }
    return FILTERS.some((k) => k.startsWith(low)) ? (toks.length === 1 ? '  LINE  Regular expression\n' : '  <cr>\n') : '% Unrecognized command\n';
  }
  const typed = line.trim();
  if (!prep.isDo && typed && !/\s$/.test(line) && !/\s/.test(typed)) {
    // `alias?` describes the alias itself; `alias ?` below expands it for argument help.
    const aliases = prep.aliases.filter((a) => a.name.startsWith(typed)).map(aliasHelp);
    const words = [...roots[0].kws.keys()].filter((k) => k.startsWith(typed.toLowerCase()));
    if (CONFIG_MODES.includes(session.mode) && 'do'.startsWith(typed.toLowerCase())) words.push('do');
    if (roots.length > 1 && !words.length) words.push(...[...roots[1].kws.keys()].filter((k) => k.startsWith(typed.toLowerCase())));
    if (aliases.length || words.length) return [...aliases, ...words.sort()].join('  ') + '\n';
  }
  const toks = tokenize(prep.line);
  const last = toks.at(-1);
  if (last && !/\s$/.test(prep.line)) {
    const low = last.text.toLowerCase();
    for (const root of roots) {
      const words = new Set<string>();
      for (const n of reach(root, prep.line.slice(0, last.start))) {
        for (const k of n.kws.keys()) if (k.startsWith(low)) words.add(k);
        for (const p of n.params) if (matchParam(p, [last], 0, last.text)) words.add(placeholder(p));
      }
      if (words.size) return [...words].sort().join('  ') + '\n';
    }
    return '% Unrecognized command\n';
  }
  const nodes = roots.map((root) => reach(root, prep.line)).find((n) => n.length) ?? [];
  if (!nodes.length) return '% Unrecognized command\n';
  const rows = new Map<string, string>(); let cr = false;
  for (const n of nodes) {
    for (const p of n.params) if (!rows.has(placeholder(p))) rows.set(placeholder(p), p.help ?? '');
    for (const [k, e] of [...n.kws].sort(([a], [b]) => a.localeCompare(b))) if (!rows.has(k)) rows.set(k, e.help ?? '');
    if (n.cmd) cr = true;
  }
  if (cr && EXEC_MODES.includes(prep.grammarMode)) {
    const base = matchLine(roots[0], prep.line);
    if (base.ok && base.kws.has('show')) rows.set('|', 'Output modifiers');
  }
  if (!last && !prep.isDo && CONFIG_MODES.includes(session.mode)) rows.set('do', 'Run an EXEC command without leaving configuration mode');
  if (!last) for (const a of prep.aliases) rows.set(aliasHelp(a), '');
  const width = Math.max(4, ...[...rows.keys()].map((k) => k.length));
  let out = '';
  for (const [k, h] of rows) out += `  ${k.padEnd(width)}  ${h}`.trimEnd() + '\n';
  if (cr) out += '  <cr>\n';
  return out;
}

/** Tab completion of the last keyword. Do not replace the user-visible alias with its expanded text. */
export function completeLine(world: World, session: CliSession, line: string): { line: string; candidates: string[] } {
  if (session.pending || session.closed || !line || /\s$/.test(line)) return { line, candidates: [] };
  const dev = getIos(world, session.deviceId);
  const prep = prepareLine(dev, session.mode, line);
  const roots = helpRoots(dev, prep.grammarMode, prep.isDo);
  const complete = (at: number, words: string[], low: string) => {
    const matches = [...new Set(words.filter((k) => k.toLowerCase().startsWith(low)))].sort();
    const exact = matches.find((k) => k.toLowerCase() === low);
    const candidates = exact === undefined ? matches : [exact];
    return { line: candidates.length === 1 ? line.slice(0, at) + candidates[0] + ' ' : line, candidates };
  };
  const pipe = usableShowPipe(roots[0], prep.line);
  if (pipe) {
    const toks = tokenize(pipe.tail);
    if (toks.length === 1) {
      const at = pipe.at + 1 + toks[0].start;
      if (at >= prep.aliasLength) return complete(prep.inputColumn(at), [...FILTERS], toks[0].text.toLowerCase());
    }
    if (pipe.at >= prep.aliasLength) return { line, candidates: [] };
  }
  if (prep.isDo && !prep.line) return { line: line + ' ', candidates: ['do'] };
  const last = tokenize(prep.line).at(-1);
  if (!last) return { line, candidates: [] };
  if (last.start < prep.aliasLength) {
    const word = tokenize(line).at(-1)!.text;
    return { line: line + ' ', candidates: [word] };
  }
  const low = last.text.toLowerCase();
  for (const root of roots) {
    const words = reach(root, prep.line.slice(0, last.start)).flatMap((n) => [...n.kws.keys()]);
    if (last.start === 0) {
      words.push(...prep.aliases.map((a) => a.name));
      if (!prep.isDo && CONFIG_MODES.includes(session.mode)) words.push('do');
    }
    const r = complete(prep.inputColumn(last.start), words, low);
    if (r.candidates.length) return r;
  }
  return { line, candidates: [] };
}

/** Start a CLI session on a device. Console/vty sessions run the registered session hooks (dialog, login). */
export function startSession(world: World, deviceId: string, via: CliSession['via'], opts: { id?: string; remoteAddr?: string } = {}): { session: CliSession; outcome: ExecOutcome } {
  getIos(world, deviceId);
  const session: CliSession = {
    id: opts.id ?? `s${world.nextId++}`, deviceId, via, remoteAddr: opts.remoteAddr,
    mode: via === 'file' ? 'priv' : 'user', ctx: {}, history: [], termLength: DEFAULT_TERMINAL_LENGTH, defaultTermLength: DEFAULT_TERMINAL_LENGTH, closed: false,
  };
  const sink: ExecSink = { out: '', notes: [] };
  if (via !== 'file') {
    const env = makeEnv(world, session, '', new Set(), sink);
    try { for (const hook of sessionHooks) { hook(env); if (session.closed || session.pending) break; } } catch (e) { if (!(e instanceof CliReject)) throw e; }
  }
  return { session, outcome: finish(world, session, sink, 'ok', 'system', false) };
}

/** Ctrl-Z ends configuration at a command prompt. Ctrl-C cancels input. Neither dismisses line login. */
export function interrupt(world: World, session: CliSession, key: 'ctrl-z' | 'ctrl-c'): ExecOutcome {
  const sink: ExecSink = { out: '', notes: [] };
  if (session.closed) return finish(world, session, sink, 'ok', 'system', false);
  if (session.pending) {
    const pending = session.pending;
    if (pending.interrupt === 'keep') {
      sink.out += '\n';
      return finish(world, session, sink, 'pending', 'system', false);
    }
    session.pending = undefined;
    if (pendingHandlers[pending.kind + ':abort']) {
      const env = makeEnv(world, session, '', new Set(), sink);
      try { pendingHandlers[pending.kind + ':abort'](env, key, pending); } catch (e) { if (!(e instanceof CliReject)) throw e; }
    }
    sink.out += '\n';
  } else if (CONFIG_MODES.includes(session.mode)) {
    if (key === 'ctrl-z') { session.mode = 'priv'; session.ctx = {}; }
    sink.out += key === 'ctrl-z' ? '^Z\n' : '^C\n';
  }
  return finish(world, session, sink, 'ok', 'system', false);
}

// ───────────────────────────── Helpers for command modules ─────────────────────────────
/** Interfaces being configured in config-if mode (several with `interface range`). */
export function currentInterfaces(env: CmdEnv): InterfaceConfig[] {
  const names = (env.session.ctx.ifNames as string[] | undefined) ?? [];
  return names.map((n) => env.device.config.interfaces[n]).filter(Boolean);
}
export function isConfigMode(mode: ModeName): boolean { return CONFIG_MODES.includes(mode); }

// ───────────────────────────── Core commands (navigation) ─────────────────────────────
function coreCommands(): CommandDef[] {
  return [
    {
      modes: [...EXEC_MODES, ...CONFIG_MODES], pattern: 'exit', feature: 'system', mutates: false, allowDo: false,
      help: { exit: 'Exit from the current mode' },
      run(env) {
        const m = env.session.mode;
        if (m === 'config') env.setMode('priv');
        else if (SUB_CONFIG_MODES.includes(m)) {
          // policy-map class → back to the policy-map; everything else → global configuration
          if (m === 'config-pmap-c') env.setMode('config-pmap', { policy: env.session.ctx.policy });
          else env.setMode('config');
        } else env.close();
      },
    },
    { modes: CONFIG_MODES, pattern: 'end', feature: 'system', mutates: false, help: { end: 'Exit from configure mode' }, run(env) { env.setMode('priv'); } },
    { modes: EXEC_MODES, pattern: ['logout', 'quit'], feature: 'system', mutates: false, allowDo: false, help: { logout: 'Exit from the EXEC' }, run(env) { env.close(); } },
    { modes: 'priv', pattern: 'disable', feature: 'system', mutates: false, allowDo: false, help: { disable: 'Turn off privileged commands' }, run(env) { env.setMode('user'); } },
  ];
}
registerCommands(coreCommands());
