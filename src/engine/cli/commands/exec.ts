/**
 * EXEC commands: enable, configure [terminal], copy running-config startup-config (and back), write [memory|erase|terminal],
 * erase startup-config, reload, terminal length/width/monitor, clock set, debug/undebug, clear …;
 * and the session hooks: initial configuration dialog (factory-fresh console), MOTD banner, console and vty login
 * (line password or `login local`; `privilege level 15` on the line or a privilege-15 user lands in privileged EXEC).
 *
 * EXEC modes keep no session.ctx keys. Pending-input kinds registered here:
 *   setup-dialog, login-password, login-user, login-user-password, enable-password, configure-from, copy-dest,
 *   erase-confirm, reload-save, reload-confirm, clear-confirm, debug-all, ospf-reset
 *
 * vty sessions use the vty line at position `runtime.vtyInUse` among the configured vty lines (IOS hands out the
 * lowest free line; whoever opens/closes vty sessions maintains vtyInUse — this module never changes it).
 */
import type { CmdEnv, CommandDef, PendingInput } from '../framework.ts';
import { DEFAULT_TERMINAL_LENGTH, registerCommands, registerPending, registerSessionHook } from '../framework.ts';
import type { IosDevice, LineConfig } from '../../types.ts';
import type { ApplyResult } from '../../config/apply.ts';
import { eraseStartupConfig, mergeStartupConfig, reloadDevice, saveStartupConfig } from '../../config/apply.ts';
import { renderRunningConfig, renderStartupDiff } from '../../config/render.ts';
import { getIos } from '../../world.ts';
import { invalidAt, invalidToken, secretMatches, tokens, NOT_SIMULATED } from './system.ts';
import { absoluteLine, lineTerminalLength, vtyLine, vtyLineNumbers } from './line.ts';
import { ifCaretCol, normIfName } from './interface.ts';

// ───────────────────────────── text constants ─────────────────────────────
export const DIALOG_HEAD = '         --- System Configuration Dialog ---\n\n';
export const DIALOG_QUESTION = 'Would you like to enter the initial configuration dialog? [yes/no]: ';
export const PRESS_RETURN = '\n\nPress RETURN to get started!\n';
export const CONFIG_BANNER = 'Enter configuration commands, one per line.  End with CNTL/Z.';

const yes = (s: string): boolean => { const t = s.trim().toLowerCase(); return t.length > 0 && 'yes'.startsWith(t); };
const no = (s: string): boolean => { const t = s.trim().toLowerCase(); return t.length > 0 && 'no'.startsWith(t); };
/** `[confirm]` prompts: Enter or y/yes confirm, anything else aborts. */
const confirmed = (s: string): boolean => { const t = s.trim().toLowerCase(); return t === '' || 'yes'.startsWith(t); };

// ───────────────────────────── session start (hook) ─────────────────────────────
function pickVtyLine(dev: IosDevice): { n: number; cfg: LineConfig } | undefined {
  const nums = vtyLineNumbers(dev.config);
  if (!nums.length) return undefined;
  const n = nums[Math.min(Math.max(0, dev.runtime.vtyInUse), nums.length - 1)];
  const cfg = vtyLine(dev.config, n);
  return cfg ? { n, cfg } : undefined;
}
/** What a console/vty session shows when it starts (also used after reload). */
export function sessionStart(env: CmdEnv): void {
  const dev = env.device;
  if (env.session.via === 'console' && dev.startupConfig === null && !dev.runtime.setupDialogDone) {
    env.print(DIALOG_HEAD);
    env.ask({ kind: 'setup-dialog', prompt: DIALOG_QUESTION, response: 'confirm', paste: 'allow' });
    return;
  }
  greet(env);
}
function greet(env: CmdEnv): void {
  const dev = env.device;
  if (dev.config.bannerMotd !== undefined && dev.config.bannerMotd !== '') env.print(dev.config.bannerMotd);
  if (env.session.via === 'console') login(env, dev.config.lines.console, 'console', 0);
  else if (env.session.via === 'vty') {
    const line = pickVtyLine(dev);
    if (!line) { env.print('\n% Connection refused by remote host\n'); env.close(); return; }
    login(env, line.cfg, 'vty', line.n);
  }
}
interface LoginData { tries: number; via: 'console' | 'vty'; line: number; user?: string }
function lineCfg(env: CmdEnv, d: LoginData): LineConfig | undefined {
  return d.via === 'console' ? env.device.config.lines.console : vtyLine(env.device.config, d.line);
}
/** `privilege level 15` on the line: the session starts in privileged EXEC once the user is in. */
function loggedIn(env: CmdEnv, line: LineConfig | undefined): void {
  if (line?.extraLines?.includes('privilege level 15')) env.setMode('priv');
}
function loginPrompt(kind: 'login-password' | 'login-user' | 'login-user-password', data: LoginData): PendingInput {
  const secret = kind !== 'login-user';
  return { kind, prompt: secret ? 'Password: ' : 'Username: ', secret, interrupt: 'keep', data: { ...data } };
}
/** A half-completed login does not acquire EXEC access if another session changes its line. */
function requireLoginLine(env: CmdEnv, data: LoginData, method: true | 'local'): LineConfig {
  const line = lineCfg(env, data);
  if (!line || line.login !== method || (method === true && line.password === undefined)) {
    env.close();
    return env.reject('% Login settings changed; reconnect and try again.');
  }
  return line;
}
function login(env: CmdEnv, line: LineConfig, via: 'console' | 'vty', n: number): void {
  const data: LoginData = { tries: 0, via, line: n };
  env.session.defaultTermLength = env.session.termLength = lineTerminalLength(line);
  if (line.login === 'local') {
    if (!env.device.config.users.some((u) => u.secret !== '')) {
      env.note('Local login requires a configured user with a password. Add one through an authenticated console or the lab configuration tool.');
    }
    env.print('\nUser Access Verification\n\n');
    env.ask(loginPrompt('login-user', data));
    return;
  }
  if (line.login !== true) { loggedIn(env, line); return; }
  if (line.password === undefined) {
    if (via === 'vty') { env.print('\nPassword required, but none set\n'); env.close(); return; }
    // Intentional lab convention for a new console: `login` without a line password remains disabled.
    loggedIn(env, line);
    return;
  }
  env.print('\nUser Access Verification\n\n');
  env.ask(loginPrompt('login-password', data));
}
function loginFailed(env: CmdEnv, pending: PendingInput, d: LoginData, message: string | null, restartKind: 'login-password' | 'login-user'): void {
  const tries = d.tries + 1;
  if (message) env.print(message);
  if (tries >= 3) {
    if (d.via === 'vty') { if (restartKind === 'login-password') env.print('% Bad passwords\n\n'); env.close(); return; }
    if (restartKind === 'login-password') env.print('% Bad passwords\n\n');
    env.print('\nUser Access Verification\n\n');
    env.ask(loginPrompt(restartKind, { ...d, tries: 0, user: undefined }));
    return;
  }
  if (restartKind === 'login-user') { env.print(''); env.ask(loginPrompt('login-user', { ...d, tries, user: undefined })); return; }
  env.ask({ ...pending, data: { ...d, tries } });
}
const pendingHandlers: Record<string, (env: CmdEnv, input: string, p: PendingInput) => void> = {
  'setup-dialog'(env, input) {
    if (no(input)) {
      env.device.runtime.setupDialogDone = true;
      env.print(PRESS_RETURN);
      greet(env);
      return;
    }
    env.ask({ kind: 'setup-dialog', prompt: DIALOG_QUESTION, response: 'confirm', paste: 'allow' });
    if (yes(input)) {
      env.note('The setup wizard is not simulated. Answer no, then configure the device with commands (enable, configure terminal, …).');
      return env.reject('');
    }
    env.reject("% Please answer 'yes' or 'no'.");
  },
  'setup-dialog:abort'(env, key, p) {
    if (key === 'ctrl-z') { env.ask(p); return; }
    env.device.runtime.setupDialogDone = true;
    env.print(PRESS_RETURN);
    greet(env);
  },
  'login-password'(env, input, p) {
    const d = p.data as unknown as LoginData;
    const line = requireLoginLine(env, d, true);
    if (input === line.password || input.trim() === line.password) { loggedIn(env, line); return; }
    loginFailed(env, p, d, null, 'login-password');
    env.reject();
  },
  'login-user'(env, input, p) {
    const d = p.data as unknown as LoginData;
    requireLoginLine(env, d, 'local');
    env.ask(loginPrompt('login-user-password', { ...d, user: input.trim() }));
  },
  'login-user-password'(env, input, p) {
    const d = p.data as unknown as LoginData;
    const line = requireLoginLine(env, d, 'local');
    const u = env.device.config.users.find((x) => x.name === d.user);
    if (u && u.secret !== '' && secretMatches(input, u.secret)) {
      if (u.privilege !== undefined) env.setMode(u.privilege === 15 ? 'priv' : 'user');
      else loggedIn(env, line);
      return;
    }
    loginFailed(env, p, d, '% Login invalid\n', 'login-user');
    env.reject();
  },
  'enable-password'(env, input, p) {
    const cfg = env.device.config;
    const ok = cfg.enableSecret !== undefined
      ? secretMatches(input, cfg.enableSecret)
      : cfg.enablePassword !== undefined && (input === cfg.enablePassword || input.trim() === cfg.enablePassword);
    if (ok) { env.setMode('priv'); return; }
    const tries = Number((p.data as { tries?: number } | undefined)?.tries ?? 0) + 1;
    if (tries >= 3) return env.reject('% Bad secrets\n\n');
    env.ask({ ...p, data: { tries } });
    env.reject();
  },
  'configure-from'(env, input) {
    const t = input.trim().toLowerCase();
    if (t === '' || 'terminal'.startsWith(t)) { env.print(CONFIG_BANNER); env.setMode('config'); return; }
    if ('memory'.startsWith(t) || 'network'.startsWith(t)) return unsupportedConfigSource(env);
    env.reject('?Must be "terminal", "memory" or "network"');
  },
  'copy-dest'(env, input, p) {
    const d = p.data as { to: 'startup' | 'running' };
    const t = input.trim();
    const name = d.to === 'startup' ? 'startup-config' : 'running-config';
    const path = d.to === 'startup' ? 'nvram:' : 'system:';
    if (t && t !== name && t !== path + name && t !== path + '/' + name) {
      return env.reject(`% The simulator supports ${name} as the destination for this command. No configuration was copied.`);
    }
    if (d.to === 'startup') {
      saveStartupConfig(env.world, env.device.id);
      env.print('Building configuration...\n[OK]');
      return;
    }
    const text = env.device.startupConfig;
    if (text === null) return env.reject('%Error opening nvram:/startup-config (No such file or directory)');
    const result = mergeStartupConfig(env.world, env.device.id);
    if (!result.ok) return rejectStartup(env, result, 'Copy canceled. The running configuration was not changed.');
    env.print(`\n${new TextEncoder().encode(text).length} bytes copied`);
  },
  'erase-confirm'(env, input) {
    if (!confirmed(input)) return;
    eraseStartupConfig(env.world, env.device.id);
    env.print('[OK]\nErase of nvram: complete');
  },
  'reload-save'(env, input) {
    if (yes(input)) {
      env.print('Building configuration...\n[OK]');
      saveStartupConfig(env.world, env.device.id);
    } else if (!no(input)) {
      env.ask({ kind: 'reload-save', response: 'confirm', prompt: 'System configuration has been modified. Save? [yes/no]: ' });
      return env.reject("% Please answer 'yes' or 'no'.");
    }
    env.ask({ kind: 'reload-confirm', response: 'confirm', prompt: 'Proceed with reload? [confirm]' });
  },
  'reload-confirm'(env, input) {
    if (!confirmed(input)) return;
    doReload(env);
  },
  'clear-confirm'(env, input, p) {
    if (!confirmed(input)) return;
    const d = p.data as { what: 'counters' | 'line'; ifName?: string };
    if (d.what === 'counters') {
      const rt = env.device.runtime;
      if (d.ifName) delete rt.ifCounters[d.ifName]; else rt.ifCounters = {};
      return;
    }
    env.reject('% Clearing terminal lines is not simulated. No session was reset.');
  },
  'debug-all'(env, input) {
    if (yes(input)) env.note(DEBUG_NOTE);
  },
  'ospf-reset'(env, input) {
    if (yes(input)) env.note(NOT_SIMULATED + 'OSPF processes (routes are calculated from the configuration directly).');
  },
};
function unsupportedConfigSource(env: CmdEnv): never {
  return env.reject('% Only terminal configuration is supported here. Use configure terminal.');
}

function rejectStartup(env: CmdEnv, result: ApplyResult, summary: string): never {
  for (const line of result.lines) {
    if (line.ok) continue;
    env.print(line.lineNo > 0 ? `% startup-config line ${line.lineNo}: ${line.line}` : '% startup-config:');
    if (line.output) env.print(line.output);
  }
  return env.reject(`% ${summary}`);
}

function doReload(env: CmdEnv): void {
  const result = reloadDevice(env.world, env.device.id);
  if (!result.ok) return rejectStartup(env, result, 'Reload canceled. The device was not restarted.');
  const via = env.session.via;
  if (via === 'console') env.print('\n%SYS-5-RELOAD: Reload requested by console. Reload Reason: Reload Command.');
  if (via !== 'console') { env.close(); return; }
  env.note('The device restarted. The boot messages of a real router (a few minutes) are not shown.');
  env.setMode('user');
  env.session.defaultTermLength = env.session.termLength = DEFAULT_TERMINAL_LENGTH;
  const dev = getIos(env.world, env.device.id);
  // with a saved configuration the router boots straight to "Press RETURN"; without one the setup dialog appears
  if (dev.startupConfig !== null || dev.runtime.setupDialogDone) env.print(PRESS_RETURN);
  sessionStart({ ...env, device: dev });
}

/** Has the running configuration changed since it was last saved (or, with nothing saved, since the factory defaults)? */
export function configModified(env: CmdEnv): boolean {
  try { return renderStartupDiff(env.world, env.device.id); } catch { return true; }
}

// ───────────────────────────── debug ─────────────────────────────
const DEBUG_NOTE = 'Debugging is not simulated; no debug settings were changed. Use show commands and the packet trace tool instead.';
const DEBUG_TOPICS = [
  'ip rip', 'ip rip events', 'ip nat', 'ip nat detailed', 'ip packet', 'ip icmp', 'ip routing',
  'ip ospf events', 'ip ospf adj', 'ip dhcp server events', 'ip dhcp server packet',
  'crypto isakmp', 'crypto ipsec', 'ppp authentication', 'snmp packets',
];

// ───────────────────────────── clock set ─────────────────────────────
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
function monthOf(s: string): number {
  const t = s.toLowerCase();
  const m = MONTHS.filter((x) => x.startsWith(t));
  return m.length === 1 ? MONTHS.indexOf(m[0]) : -1;
}

const HE: Record<string, string> = {
  enable: 'Turn on privileged commands',
  configure: 'Enter configuration mode',
  terminal: 'Configure from the terminal',
  copy: 'Copy from one file to another',
  'running-config': 'Copy from current system configuration',
  'startup-config': 'Copy from startup configuration',
  write: 'Write running configuration to memory, network, or terminal',
  memory: 'Write to NV memory',
  erase: 'Erase a filesystem',
  'nvram:': 'Erase the NVRAM filesystem',
  reload: 'Halt and perform a cold restart',
  length: 'Set number of lines on a screen',
  width: 'Set width of the display terminal',
  monitor: 'Copy debug output to the current terminal line',
  clock: 'Manage the system clock',
  set: 'Set the time and date',
  debug: "Debugging functions (see also 'undebug')",
  undebug: "Disable debugging functions (see also 'debug')",
  all: 'Enable all debugging',
  clear: 'Reset functions',
  counters: 'Clear counters on one or all interfaces',
  line: 'Reset a terminal line',
  'arp-cache': 'Clear the entire ARP cache',
  ip: 'IP',
  dhcp: 'Delete items from the DHCP database',
  binding: 'DHCP address bindings',
  conflict: 'DHCP address conflicts',
  route: 'Delete route table entries',
  ospf: 'OSPF clear commands',
  process: 'Reset OSPF process',
  no: 'Disable debugging functions',
  '<level>': 'Enable level',
  '<n>': 'Number of lines on screen (0 for no pausing)',
  '<time>': 'Current Time (hh:mm:ss)',
  '<what>': 'Debugging topic',
};

const HT: Record<string, string> = { ...HE, terminal: 'Set terminal line parameters', no: 'Negate a command or set its defaults' };

export const commands: CommandDef[] = [
  // ── enable ──
  {
    modes: ['user', 'priv'], pattern: 'enable [<level:int(0-15)>]', feature: 'system', help: HE, allowDo: false,
    run(env, a) {
      if (a.level !== undefined && a.level !== 15) return env.reject('% This simulator supports enable at privilege level 15 only.');
      if (env.session.mode === 'priv') return;
      const cfg = env.device.config;
      if (cfg.enableSecret === undefined && cfg.enablePassword === undefined) {
        if (env.session.via === 'vty') env.reject('% No password set');
        env.setMode('priv');
        return;
      }
      env.ask({ kind: 'enable-password', prompt: 'Password: ', secret: true, data: { tries: 0 } });
    },
  },
  // ── configure ──
  { modes: 'priv', pattern: 'configure terminal', feature: 'system', mutates: false, allowDo: false, help: HE, run(env) { env.print(CONFIG_BANNER); env.setMode('config'); } },
  { modes: 'priv', pattern: 'configure', feature: 'system', mutates: false, allowDo: false, help: HE, run(env) { env.ask({ kind: 'configure-from', prompt: 'Configuring from terminal, memory, or network [terminal]? ' }); } },

  { modes: 'priv', pattern: 'configure {memory|network|overwrite-network}', feature: 'system', mutates: false, allowDo: false, help: HE, run: unsupportedConfigSource },

  // ── save / erase / reload ──
  {
    modes: 'priv', pattern: 'copy {running-config|system:running-config} {startup-config|nvram:startup-config}', feature: 'system', help: { ...HE, 'startup-config': 'Copy to startup configuration' },
    run(env) { env.ask({ kind: 'copy-dest', paste: 'allow', prompt: 'Destination filename [startup-config]? ', data: { to: 'startup' } }); },
  },
  {
    modes: 'priv', pattern: 'copy {startup-config|nvram:startup-config} {running-config|system:running-config}', feature: 'system', mutates: true, help: { ...HE, 'running-config': 'Update (merge with) current system configuration' },
    run(env) { env.ask({ kind: 'copy-dest', paste: 'allow', prompt: 'Destination filename [running-config]? ', data: { to: 'running' } }); },
  },
  {
    modes: 'priv', pattern: ['write', 'write memory'], feature: 'system', help: HE,
    run(env) { env.print('Building configuration...\n[OK]'); saveStartupConfig(env.world, env.device.id); },
  },
  {
    modes: 'priv', pattern: 'write terminal', feature: 'verify', help: { ...HE, terminal: 'Write to terminal' },
    run(env) { env.print(renderRunningConfig(env.world, env.device.id)); },
  },
  {
    modes: 'priv', pattern: ['write erase', 'erase startup-config', 'erase nvram:'], feature: 'system', mutates: true,
    help: { ...HE, erase: 'Erase NV memory', 'startup-config': 'Erase contents of configuration memory' },
    run(env) { env.ask({ kind: 'erase-confirm', response: 'confirm', prompt: 'Erasing the nvram filesystem will remove all configuration files! Continue? [confirm]' }); },
  },
  {
    modes: 'priv', pattern: 'reload', feature: 'system', mutates: true, help: HE,
    run(env) {
      if (configModified(env)) {
        env.print('');
        env.ask({ kind: 'reload-save', response: 'confirm', prompt: 'System configuration has been modified. Save? [yes/no]: ' });
        return;
      }
      env.ask({ kind: 'reload-confirm', response: 'confirm', prompt: 'Proceed with reload? [confirm]' });
    },
  },

  // ── terminal ──
  { modes: ['user', 'priv'], pattern: 'terminal length <n:int(0-512)>', feature: 'system', help: HT, run(env, a) { env.session.termLength = Number(a.n); } },
  { modes: ['user', 'priv'], pattern: 'terminal no length', feature: 'system', help: HT, run(env) { env.session.termLength = env.session.defaultTermLength; } },
  { modes: ['user', 'priv'], pattern: ['terminal width <n:int(0-512)>', 'terminal no width'], feature: 'system', help: { ...HT, '<n>': 'Number of characters on a screen line' }, run(env) { env.note(NOT_SIMULATED + 'terminal width (output is not wrapped by IOS in this simulator).'); } },
  {
    modes: ['user', 'priv'], pattern: ['terminal monitor', 'terminal no monitor'], feature: 'system', help: HT,
    run(env) {
      if (!env.has('no') && env.session.via === 'console') env.print('% Console already monitors');
      else env.note(NOT_SIMULATED + 'per-session monitoring; monitor settings did not change.');
    },
  },

  // ── clock set ──
  {
    modes: 'priv', pattern: 'clock set <time:word> <d1:word> <d2:word> <year:int(1993-2035)>', feature: 'system', help: { ...HE, '<d1>': 'Day of the month or month of the year', '<d2>': 'Month of the year or day of the month', '<year>': 'Year' },
    run(env, a) {
      const tm = /^(\d{1,2}):(\d{1,2}):(\d{1,2})$/.exec(String(a.time));
      if (!tm || Number(tm[1]) > 23 || Number(tm[2]) > 59 || Number(tm[3]) > 59) invalidToken(env, 2);
      const d1 = String(a.d1), d2 = String(a.d2);
      const dayOk = (s: string) => /^\d{1,2}$/.test(s) && Number(s) >= 1 && Number(s) <= 31;
      if (/^\d+$/.test(d1)) { if (!dayOk(d1)) invalidToken(env, 3); if (monthOf(d2) < 0) invalidToken(env, 4); }
      else { if (monthOf(d1) < 0) invalidToken(env, 3); if (!dayOk(d2)) invalidToken(env, 4); }
      env.note('Accepted. The simulator does not keep a real clock.');
    },
  },

  // ── debug ──
  {
    modes: 'priv', pattern: DEBUG_TOPICS.map((topic) => `debug ${topic}`), feature: 'verify', help: HE,
    run(env) { env.note(DEBUG_NOTE); },
  },
  {
    modes: 'priv', pattern: 'debug all', feature: 'verify', help: HE,
    run(env) { env.ask({ kind: 'debug-all', response: 'confirm', prompt: 'This may severely impact network performance. Continue? (yes/[no]): ' }); },
  },
  {
    modes: 'priv', pattern: ['undebug all', 'no debug all'], feature: 'verify', help: { ...HE, all: 'Disable all debugging' },
    run(env) { env.note(DEBUG_NOTE); },
  },
  {
    modes: 'priv', pattern: DEBUG_TOPICS.flatMap((topic) => [`undebug ${topic}`, `no debug ${topic}`]), feature: 'verify', help: HE,
    run(env) { env.note(DEBUG_NOTE); },
  },

  // ── clear ──
  {
    modes: 'priv', pattern: 'clear counters [<ifname:if>]', feature: 'verify', help: HE,
    run(env, a) {
      let ifName: string | undefined;
      if (a.ifname !== undefined) {
        ifName = normIfName(String(a.ifname));
        if (!env.device.config.interfaces[ifName]) invalidAt(env, ifCaretCol(env, 2, ifName));
      }
      env.ask({
        kind: 'clear-confirm', response: 'confirm', data: { what: 'counters', ifName },
        prompt: ifName ? 'Clear "show interface" counters on this interface [confirm]' : 'Clear "show interface" counters on all interfaces [confirm]',
      });
    },
  },
  {
    modes: 'priv', pattern: ['clear line <n:int(0-1000)>', 'clear line {type:console|vty|aux} <n:int(0-1000)>'], feature: 'verify',
    help: { ...HE, console: 'Primary terminal line', vty: 'Virtual terminal', aux: 'Auxiliary line' },
    run(env, a) {
      const dev = env.device; const n = Number(a.n);
      const type = a.type as 'console' | 'vty' | 'aux' | undefined;
      const valid = type === 'console' ? n === 0
        : type === 'aux' ? dev.kind === 'router' && n === 0
          : type === 'vty' ? vtyLineNumbers(dev.config).includes(n)
            : n === 0 || (dev.kind === 'router' && n === 1) || vtyLineNumbers(dev.config).some((v) => absoluteLine(dev, 'vty', v) === n);
      if (!valid) invalidToken(env, tokens(env.line).length - 1);
      env.ask({ kind: 'clear-confirm', response: 'confirm', prompt: '[confirm]', data: { what: 'line' } });
    },
  },
  {
    modes: 'priv', pattern: ['clear ip dhcp binding *', 'clear ip dhcp binding <addr:ip>'], feature: 'dhcp', help: { ...HE, '*': 'Clear all automatic bindings' },
    run(env, a) {
      const rt = env.device.runtime;
      rt.dhcpBindings = a.addr === undefined ? [] : rt.dhcpBindings.filter((b) => b.address !== a.addr);
    },
  },
  { modes: 'priv', pattern: ['clear ip dhcp conflict *', 'clear ip dhcp conflict <addr:ip>'], feature: 'dhcp', help: { ...HE, '*': 'Clear all address conflicts' }, run(env) { env.note(NOT_SIMULATED + 'DHCP conflict tracking; there is no conflict table to clear.'); } },
  { modes: 'priv', pattern: 'clear arp-cache', feature: 'verify', help: HE, run(env) { env.note(NOT_SIMULATED + 'ARP caching; there is no ARP cache to clear.'); } },
  { modes: 'priv', pattern: ['clear ip route *', 'clear ip route <addr:ip> [<mask:mask>]'], feature: 'routing', help: { ...HE, '*': 'Delete all routes' }, run(env) { env.note(NOT_SIMULATED + 'removal of learned routes; routes are recomputed from configuration.'); } },
  {
    modes: 'priv', pattern: 'clear ip ospf process', feature: 'routing', help: HE,
    run(env) { env.ask({ kind: 'ospf-reset', response: 'confirm', prompt: 'Reset ALL OSPF processes? [no]: ' }); },
  },
];

let installed = false;
export function install(): void {
  if (installed) return;
  installed = true;
  registerCommands(commands);
  for (const [kind, handler] of Object.entries(pendingHandlers)) registerPending(kind, handler);
  registerSessionHook(sessionStart);
}
