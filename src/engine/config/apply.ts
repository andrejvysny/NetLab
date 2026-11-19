/**
 * Config-file operations: feed configuration text to a device through the real CLI (like pasting into a terminal),
 * save / erase the startup-config, reload.
 *
 * Config files start in global configuration mode and end at `end`. Bare `!` separators and explicit global prompts
 * close the previous section; a pasted sub-mode prompt never selects a target by itself. Unlike an interactive terminal,
 * a file cannot send EXEC commands or respond to an interactive question. `merge` keeps successful lines on error;
 * `replace` is validated on a copy and commits only if every line is accepted.
 */
import type { Feature, IosDevice, World } from '../types.ts';
import type { CliSession, ExecOutcome } from '../cli/framework.ts';
import { execLine, inspectInput, installCli, startSession } from '../cli/index.ts';
import { cloneWorld, defaultIosConfig, emptyRuntime, isIos } from '../world.ts';
import { renderRunningConfig, simSecretDecode, type7Decode } from './render.ts';
import { redactCredentialLine, unsupportedCredentialType, UNSUPPORTED_CREDENTIAL } from './credentials.ts';

export interface ApplyLine { lineNo: number; line: string; ok: boolean; output: string }
export interface ApplyResult { ok: boolean; applied: number; failed: number; lines: ApplyLine[]; message?: string }
export interface ConfigStep extends ApplyLine { mode: CliSession['mode']; feature: Feature; mutated: boolean; changed: boolean }
export type ConfigObserver = (step: ConfigStep) => void;

// ───────────────────────────── Line classification ─────────────────────────────
/** One line of the file after preprocessing. */
export interface PreparedLine {
  lineNo: number;
  /** The line as written in the file (trimmed on the right). */
  original: string;
  /** What is sent to the CLI (prompt removed and trimmed; credential codecs belong to the CLI). */
  command: string;
  /** Line belongs to the block above (indented in the file, or pasted after a sub-mode prompt such as `R1(config-if)#`). */
  indented: boolean;
  boundary?: true;
  promptMode?: string;
  /** Banner/menu delimiters are collected before regular config line parsing. */
  error?: string;
  banner?: { kind: string; text: string };
}

const HEADER_FURNITURE: RegExp[] = [
  /^Building configuration\.\.\./i,
  /^Current configuration\s*:/i,
  /^Using \d+ out of \d+ bytes/i,
  /^version\s+\d+\.\d+/i,
  /^boot-(start|end)-marker$/i,
  /^ip forward-protocol nd$/i,
  /^switch \d+ provision\s/i,
  /^spanning-tree extend system-id$/i,
  /^spanning-tree mode rapid-pvst$/i,
  /^startup-config is not present$/i,
];
/** Top-level blocks that are printed by render.ts but carry nothing the simulator models. */
const FURNITURE_BLOCKS: RegExp[] = [/^line aux 0$/i, /^control-plane$/i];

const RE_ENABLE = /^en(a(b(le?)?)?)?$/i;
const RE_CONF_T = /^conf(?:i(?:g(?:u(?:r(?:e)?)?)?)?)?\s+t(?:e(?:r(?:m(?:i(?:n(?:a(?:l)?)?)?)?)?)?)?$/i;
const RE_EXIT = /^exit$/i;
const RE_END = /^end$/i;
const RE_SHOW_CONFIG = /^sh(?:o(?:w)?)?\s+(?:run(?:ning-config)?|start(?:up-config)?)$/i;
const RE_PROMPT = /^[A-Za-z0-9][\w.\-]*(\([\w\-]+\))?[#>]\s*/;

/** Rewrite secrets produced by render.ts back to clear text. Unknown or invalid hashes are left for the CLI to judge. */
export function decodeSecrets(cmd: string): string {
  let m = /^(password)\s+7\s+(\S+)$/i.exec(cmd);
  if (m) { const p = type7Decode(m[2]); return p === null ? cmd : `${m[1]} ${p}`; }
  m = /^(enable\s+password(?:\s+level\s+\d+)?)\s+7\s+(\S+)$/i.exec(cmd);
  if (m) { const p = type7Decode(m[2]); return p === null ? cmd : `${m[1]} ${p}`; }
  m = /^(enable\s+secret(?:\s+level\s+\d+)?)\s+9\s+(\$9\$sim\$\S*)$/i.exec(cmd);
  if (m) { const p = simSecretDecode(m[2]); return p === null ? cmd : `${m[1]} ${p}`; }
  m = /^(username\s+\S+(?:\s+privilege\s+\d+)?\s+secret)\s+9\s+(\$9\$sim\$\S*)$/i.exec(cmd);
  if (m) { const p = simSecretDecode(m[2]); return p === null ? cmd : `${m[1]} ${p}`; }
  m = /^(username\s+\S+(?:\s+privilege\s+\d+)?\s+password)\s+7\s+(\S+)$/i.exec(cmd);
  if (m) { const p = type7Decode(m[2]); return p === null ? cmd : `${m[1]} ${p}`; }
  return cmd;
}

/** Equivalent spellings tried when a line does not parse (other command modules may implement only one form). */
const VARIANTS: [RegExp, string][] = [
  [/^no ip domain lookup$/i, 'no ip domain-lookup'],
  [/^ip domain lookup$/i, 'ip domain-lookup'],
  [/^ip domain name (\S+)$/i, 'ip domain-name $1'],
  [/^logging host (\S+)$/i, 'logging $1'],
  [/^queue-limit (\d+) packets$/i, 'queue-limit $1'],
  [/^encr (.+)$/i, 'encryption $1'],
  [/^\d+ ((?:permit|deny|remark)\b.*)$/i, '$1'],
  [/^(access-list \d+ (?:permit|deny))\s+(\d+\.\d+\.\d+\.\d+)((?: log)?)$/i, '$1 host $2$3'],
  [/^((?:permit|deny))\s+(\d+\.\d+\.\d+\.\d+)((?: log)?)$/i, '$1 host $2$3'],
  [/^match access-group name (\S+)$/i, 'match access-group $1'],
];
function variantsOf(cmd: string): string[] {
  const out: string[] = [];
  const add = (c: string) => { if (c !== cmd && !out.includes(c)) out.push(c); };
  for (const [re, rep] of VARIANTS) if (re.test(cmd)) add(cmd.replace(re, rep));
  for (const v of [...out]) for (const [re, rep] of VARIANTS) if (re.test(v)) add(v.replace(re, rep));
  return out;
}

/** Split config text into the lines that will be sent to the CLI (comments, furniture and session noise removed). */
export function prepareConfigLines(text: string): PreparedLine[] {
  const raw = String(text ?? '').split(/\r\n|\r|\n/);
  const out: PreparedLine[] = [];
  let skipBlock = false;
  let boundary = false;
  for (let i = 0; i < raw.length; i++) {
    const original = raw[i].replace(/\s+$/, '');
    const lineNo = i + 1;
    const prompt = RE_PROMPT.exec(original.trim());
    const promptMode = prompt?.[1]?.slice(1, -1).toLowerCase();
    let cmd = original.trim().replace(RE_PROMPT, '').trim();
    if (!cmd) continue;
    if (cmd.startsWith('!')) {
      if (cmd === '!' && (!/^\s/.test(original) || promptMode === 'config')) { boundary = true; skipBlock = false; }
      continue;
    }
    const inBlock = prompt ? !!promptMode && promptMode !== 'config' : /^\s/.test(original);
    if (RE_END.test(cmd)) { out.push({ lineNo, original, command: 'end', indented: inBlock }); break; }
    if (skipBlock) {
      if (inBlock) continue;
      skipBlock = false;
    }
    if (!inBlock && FURNITURE_BLOCKS.some((re) => re.test(cmd))) { skipBlock = true; boundary = true; continue; }
    if (HEADER_FURNITURE.some((re) => re.test(cmd)) || /^Enter configuration commands, one per line\.\s+End with CNTL\/Z\.$/i.test(cmd)) continue;
    if (!promptMode && (RE_ENABLE.test(cmd) || (prompt && RE_SHOW_CONFIG.test(cmd)))) continue;
    if (!promptMode && RE_CONF_T.test(cmd)) { boundary = true; continue; }
    const prepared: PreparedLine = { lineNo, original, command: cmd, indented: inBlock };
    if (boundary) prepared.boundary = true;
    if (promptMode) prepared.promptMode = promptMode === 'config-if-range' ? 'config-if' : promptMode;
    boundary = false;
    const b = /^(banner\s+\S+|menu\s+\S+\s+title)\s+(.+)$/i.exec(raw[i].trimStart().replace(RE_PROMPT, ''));
    if (b) {
      const banner = collectBanner(b[2], raw, i);
      if (!banner) {
        // What follows may be banner text. Do not mistake it for a configuration command.
        prepared.error = '% Unterminated text delimiter. The rest of the file was not read.\n';
        out.push(prepared);
        break;
      }
      const d = ['#', '%', '~', '@', '$', '&', '|', '\u0003', '\u0004'].find((c) => !banner.text.includes(c));
      if (!d) prepared.error = '% No usable text delimiter in this file.\n';
      else prepared.command = `${b[1]} ${d}${banner.text}${d}`;
      if (/^banner/i.test(b[1])) prepared.banner = { kind: b[1].split(/\s+/)[1].toLowerCase(), text: banner.text };
      i = banner.endIndex;
    } else if (/^(access-list\s+\S+\s+(permit|deny)|(\d+\s+)?(permit|deny))\s/i.test(cmd)) {
      prepared.command = cmd.replace(/\s+/g, ' ');
    }
    out.push(prepared);
  }
  return out;
}

/** Banner text between delimiters. `^C` (as running-config prints it) counts as one delimiter. */
function collectBanner(rest: string, raw: string[], start: number): { text: string; endIndex: number } | null {
  if (!rest) return null;
  const delim = rest.startsWith('^C') ? '^C' : rest[0];
  const after = rest.slice(delim.length);
  const close = after.indexOf(delim);
  if (close >= 0) return { text: after.slice(0, close), endIndex: start };
  const parts = [after];
  for (let j = start + 1; j < raw.length; j++) {
    const line = raw[j].replace(/\r$/, '');
    const k = line.indexOf(delim);
    if (k >= 0) { parts.push(line.slice(0, k)); return { text: parts.join('\n'), endIndex: j }; }
    parts.push(line);
  }
  return null;
}

// ───────────────────────────── Execution ─────────────────────────────
const PARSE_FAIL = new Set(['invalid', 'incomplete', 'ambiguous']);
const OK_STATUS = new Set(['ok', 'empty']);
const RE_SHUTDOWN = /^(no\s+)?shut(d(o(w(n)?)?)?)?$/i;

function resetMode(session: CliSession): void { session.mode = 'config'; session.ctx = {}; session.pending = undefined; }

/** Resolve the text of a configuration alias for audit messages and file policy checks. */
export function configurationAlias(device: IosDevice, mode: CliSession['mode'], cmd: string): string {
  const group = mode === 'config-if' ? 'interface' : mode === 'config' ? 'configure' : null;
  const first = /^[^\s|]+/.exec(cmd)?.[0];
  const alias = group && device.config.aliases.find((a) => a.mode === group && a.name === first);
  return alias && first ? (alias.command + cmd.slice(first.length)).trim() : cmd;
}

export function auditConfigCommand(device: IosDevice, mode: CliSession['mode'], original: string, raw: string): string {
  const direct = redactCredentialLine(original);
  if (direct !== original) return direct;
  const { echo } = inspectInput(device, { mode, closed: false }, raw);
  return echo.kind === 'redacted' ? echo.text : original;
}

function fileCommandProblem(command: string): string | undefined {
  if (/^do(?:\s|$)/i.test(command)) return '% EXEC commands are not run from a configuration file. Use the terminal.\n';
  if (unsupportedCredentialType(command)) return UNSUPPORTED_CREDENTIAL;
  return undefined;
}

function fileProblem(device: IosDevice, session: CliSession, cmd: string): string | undefined {
  return fileCommandProblem(cmd) ?? fileCommandProblem(configurationAlias(device, session.mode, cmd));
}

function runOne(world: World, session: CliSession, cmd: string): ExecOutcome | { error: string } {
  try { return execLine(world, session, cmd); } catch {
    return { error: '% Simulator error while running this line.\n' };
  }
}

interface ApplyOptions { reset: boolean; boot: boolean }

function resetConfig(device: IosDevice): void {
  device.config = defaultIosConfig(device.kind, device.ports);
  const rt = device.runtime;
  rt.natTranslations = [];
  rt.natHits = 0;
  rt.natMisses = 0;
  rt.aclHits = {};
  rt.dhcpBindings = [];
  rt.ikeSas = [];
  rt.ipsecSas = [];
  rt.qosCounters = {};
}

function applyInternal(world: World, deviceId: string, text: string, opts: ApplyOptions, observe?: ConfigObserver, trackChanges = false): ApplyResult {
  const result: ApplyResult = { ok: true, applied: 0, failed: 0, lines: [] };
  const fail = (lineNo: number, line: string, output: string) => {
    result.lines.push({ lineNo, line, ok: false, output }); result.failed++; result.ok = false;
  };
  try {
    const device = world?.devices?.[deviceId];
    if (!isIos(device)) { fail(0, '', `% No router or switch with id "${deviceId}".\n`); return result; }
    installCli();
    if (opts.reset) resetConfig(device);
    const lines = prepareConfigLines(text);
    const session = startSession(world, deviceId, 'file').session;
    resetMode(session);
    let rejectedBlock = false;
    for (let n = 0; n < lines.length; n++) {
      const pl = lines[n];
      if (pl.command === 'end') break;
      if (pl.boundary || pl.promptMode === 'config') resetMode(session);
      if (pl.boundary || !pl.indented) rejectedBlock = false;
      if (RE_EXIT.test(pl.command) && session.mode === 'config' && (!pl.promptMode || pl.promptMode === 'config')) continue;
      const mode = session.mode;
      const before = trackChanges ? JSON.stringify(device.config) : '';
      const ifsBefore = mode === 'config-if' ? JSON.stringify(session.ctx.ifNames ?? []) : null;
      const problem = pl.error ?? (rejectedBlock ? '% The block header was rejected; this line was not run.\n' : undefined) ?? (pl.promptMode && pl.promptMode !== mode
        ? `% Pasted prompt expects ${pl.promptMode}, but the file is in ${mode}. Select the block before its commands.\n`
        : fileProblem(device, session, pl.command));
      const line = auditConfigCommand(device, mode, pl.original, pl.command);
      let out = problem ? { error: problem } : runOne(world, session, pl.command);
      if (!('error' in out) && PARSE_FAIL.has(out.status)) {
        for (const v of variantsOf(pl.command)) {
          if (fileProblem(device, session, v)) continue;
          const alt = runOne(world, session, v);
          if (!('error' in alt) && !PARSE_FAIL.has(alt.status)) { out = alt; break; }
        }
      }
      let output = 'error' in out ? out.error : out.status === 'ambiguous' ? '% Ambiguous command.\n' : out.output;
      const pending = session.pending;
      if (pending) {
        // Interactive questions have no answers in a configuration file. Never consume the next config line as one.
        session.pending = undefined;
        output = '% This line requires interactive input. Use the terminal or specify all arguments in the file.\n';
      }
      const ok = !pending && !('error' in out) && OK_STATUS.has(out.status);
      const sensitive = line !== pl.original;
      if (!ok) {
        if (sensitive && !problem && !pending) output = '% Credential command was rejected. Review the arguments in the editor.\n';
        // Keep the source line number, but never keep a secret in the file report or journal.
        fail(pl.lineNo, line, output);
        if (!pl.indented) { resetMode(session); rejectedBlock = true; }
      } else {
        const notes = (out as ExecOutcome).notes;
        output += notes.map((note) => `[Simulator note] ${note}\n`).join('');
        result.lines.push({ lineNo: pl.lineNo, line, ok: true, output });
        result.applied++;
      }
      // Boot semantics: an interface block without an explicit shutdown setting is enabled.
      let bootChanged = false;
      if (opts.boot && ok && session.mode === 'config-if' && JSON.stringify(session.ctx.ifNames ?? []) !== ifsBefore) {
        let explicit = false;
        for (let k = n + 1; k < lines.length && lines[k].indented && !lines[k].boundary; k++) if (RE_SHUTDOWN.test(lines[k].command)) explicit = true;
        if (!explicit) for (const name of (session.ctx.ifNames as string[] | undefined) ?? []) {
          const ifc = device.config.interfaces[name];
          if (ifc?.shutdown) { ifc.shutdown = false; bootChanged = true; }
        }
      }
      observe?.({ lineNo: pl.lineNo, line, output, mode, feature: 'error' in out ? 'system' : out.feature, ok,
        mutated: ok && (bootChanged || (!('error' in out) && out.mutated)), changed: trackChanges && JSON.stringify(device.config) !== before });
      if (session.closed || session.mode === 'user' || session.mode === 'priv') { session.closed = false; resetMode(session); }
    }
    if (result.applied > 0) device.runtime.setupDialogDone = true;
  } catch {
    fail(0, '', '% Could not read the configuration.\n');
  }
  return result;
}

/** Merge applies accepted lines; replace validates a complete candidate before changing the running configuration. */
export function applyConfigText(world: World, deviceId: string, text: string, how: 'merge' | 'replace', observe?: ConfigObserver, trackChanges = false): ApplyResult {
  if (how === 'merge') return applyInternal(world, deviceId, text, { reset: false, boot: false }, observe, trackChanges);
  const current = world?.devices?.[deviceId];
  if (!isIos(current)) return applyInternal(world, deviceId, text, { reset: false, boot: false });
  try {
    const copy = cloneWorld(world);
    const result = applyInternal(copy, deviceId, text, { reset: true, boot: true }, observe, trackChanges);
    if (!result.ok || !result.applied) return { ...result, ok: false, applied: 0, message: result.failed
      ? 'Replacement was canceled. The device configuration was not changed.'
      : 'No configuration commands were found. The device configuration was not changed.' };
    const candidate = copy.devices[deviceId] as IosDevice;
    current.config = candidate.config;
    Object.assign(current.runtime, candidate.runtime);
    world.tick = copy.tick;
    return result;
  } catch {
    return { ok: false, applied: 0, failed: 0, lines: [], message: 'Could not validate the replacement. The device configuration was not changed.' };
  }
}
/** copy running-config startup-config */
export function saveStartupConfig(world: World, deviceId: string): void {
  const device = world.devices[deviceId];
  if (!isIos(device)) return;
  device.startupConfig = renderRunningConfig(world, deviceId);
}
/** erase startup-config */
export function eraseStartupConfig(world: World, deviceId: string): void {
  const device = world.devices[deviceId];
  if (!isIos(device)) return;
  device.startupConfig = null;
}
/** Validate a saved snapshot before touching live state. A failed import must not bypass line login or reload sessions. */
function loadStartup(world: World, deviceId: string, boot: boolean): ApplyResult {
  const failure = (output: string): ApplyResult => ({ ok: false, applied: 0, failed: 1, lines: [{ lineNo: 0, line: '', ok: false, output }] });
  const device = world.devices[deviceId];
  if (!isIos(device)) return failure('% No router or switch selected.\n');
  try {
    const copy = cloneWorld(world);
    const candidate = copy.devices[deviceId] as IosDevice;
    if (boot) {
      candidate.config = defaultIosConfig(candidate.kind, candidate.ports);
      candidate.runtime = emptyRuntime();
    }
    const text = candidate.startupConfig;
    const result = text?.trim()
      ? applyInternal(copy, deviceId, text, { reset: false, boot })
      : { ok: true, applied: 0, failed: 0, lines: [] };
    if (!result.ok) return { ...result, applied: 0 };
    device.config = candidate.config;
    if (boot) {
      if (text?.trim()) candidate.runtime.setupDialogDone = true;
      device.runtime = candidate.runtime;
    } else {
      // Preserve the runtime object's identity; only a reboot ends the other sessions on this device.
      Object.assign(device.runtime, candidate.runtime);
    }
    world.tick = copy.tick;
    world.nextId = copy.nextId;
    return result;
  } catch {
    return failure('% Could not validate the saved configuration.\n');
  }
}

/** EXEC startup-to-running merge is all-or-nothing. The config editor still supports a partial file merge. */
export function mergeStartupConfig(world: World, deviceId: string): ApplyResult { return loadStartup(world, deviceId, false); }
/** Reload only when the saved snapshot can be reapplied in full (or when startup-config is empty). */
export function reloadDevice(world: World, deviceId: string): ApplyResult { return loadStartup(world, deviceId, true); }
