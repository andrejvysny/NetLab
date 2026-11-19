/**
 * Global basics: hostname, enable secret/password, service password-encryption, ip domain-lookup, banner (multi-line),
 * username, alias, ip domain-name, and a list of valid IOS commands that the simulator accepts but does not model
 * (stored in `config.extraLines`, flagged with env.note).
 *
 * Also exports small helpers shared by the other base command modules (exec, interface, line, routing, dhcp, switch):
 * caret errors, extra-line bookkeeping and password parsing (type 0/7 and the simulator's `9 $9$sim$…` secrets, whose codecs
 * live in config/render.ts).
 *
 * extraLines convention: entries are stored WITHOUT indentation, with the full (canonical) keywords, one command per entry.
 * Re-entering a command with the same key replaces the old entry; the default form of a default-on feature removes the
 * stored negation (e.g. `cdp run` removes `no cdp run`).
 */
import type { Args, CmdEnv, CommandDef, PendingInput } from '../framework.ts';
import { registerCommands, registerPending } from '../framework.ts';
import type { Feature, IosConfig } from '../../types.ts';
import { simSecretDecode, type7Decode } from '../../config/render.ts';

// ───────────────────────────── Shared helpers ─────────────────────────────
export interface Tok { text: string; start: number }
export function tokens(line: string): Tok[] {
  const out: Tok[] = []; const re = /\S+/g; let m: RegExpExecArray | null;
  while ((m = re.exec(line))) out.push({ text: m[0], start: m.index });
  return out;
}

/** IOS "% Invalid input detected at '^' marker." with the caret under column `col` of env.line. Stops the command. */
export function invalidAt(env: CmdEnv, col: number): never {
  env.reject(' '.repeat(env.screenColumn(col)) + '^\n' + "% Invalid input detected at '^' marker.");
}
/** Same, with the caret under the start of token number `index` (0-based) of env.line. */
export function invalidToken(env: CmdEnv, index: number): never {
  const t = tokens(env.line);
  const tok = t[Math.min(index, t.length - 1)];
  invalidAt(env, tok ? tok.start : env.line.length);
}
/** Index of the first token whose lower-case text starts with `prefix` (keyword abbreviations), or -1. */
export function tokenIndexOf(env: CmdEnv, keyword: string, from = 0): number {
  const t = tokens(env.line);
  for (let i = from; i < t.length; i++) {
    const low = t[i].text.toLowerCase();
    if (keyword.startsWith(low) && low.length > 0) return i;
  }
  return -1;
}

function baseOf(line: string): string { return line.replace(/^no\s+/i, ''); }
function keyOf(line: string, keyWords: number): string { return baseOf(line).split(/\s+/).slice(0, keyWords).join(' ').toLowerCase(); }
/**
 * Maintain a list of verbatim extra lines.
 * set:    remove every entry with the same key (with or without a leading `no`), then append `line`.
 * remove: only remove entries with the same key.
 */
export function setExtra(list: string[], line: string, keyWords: number, mode: 'set' | 'remove' = 'set'): void {
  const key = keyOf(line, keyWords);
  for (let i = list.length - 1; i >= 0; i--) if (keyOf(list[i], keyWords) === key) list.splice(i, 1);
  if (mode === 'set') list.push(line);
}
export function extraHas(list: string[] | undefined, prefix: string): string | undefined {
  return list?.find((l) => l.toLowerCase().startsWith(prefix.toLowerCase()));
}

export const NOT_SIMULATED = 'Accepted, but not simulated: ';

/** Does the typed password match a stored secret? (Stored values are plain text; a `$9$sim$…` value is decoded.) */
export function secretMatches(input: string, stored: string | undefined): boolean {
  if (stored === undefined) return false;
  const plain = simSecretDecode(stored) ?? stored;
  return input === plain || input.trim() === plain;
}

/**
 * Parse '<type> <value>' / '<value>' for password-like arguments.
 * Returns the plain text, or { error } with the IOS message.
 */
export function parseSecretArg(text: string, kind: 'password' | 'secret'): { plain: string } | { error: string } {
  const m = /^(\d)\s+(\S.*)$/.exec(text);
  if (!m) return { plain: text };
  const type = m[1]; const value = m[2];
  if (type === '0') return { plain: value };
  if (kind === 'password' && type === '7') {
    const plain = type7Decode(value);
    return plain === null ? { error: 'Invalid encrypted password' } : { plain };
  }
  if (kind === 'secret' && ['5', '8', '9'].includes(type)) {
    const plain = type === '9' ? simSecretDecode(value) : null;
    if (plain !== null) return { plain };
    return { error: '% This simulator cannot verify an imported IOS secret hash. Set a new secret in the lab instead.' };
  }
  // e.g. `password 5 x`: IOS treats an unknown leading digit followed by text as part of the password
  return { plain: text };
}

// ───────────────────────────── Accepted-but-not-simulated helper ─────────────────────────────
export type ExtraMode = 'set' | 'remove' | 'none';
interface Passive {
  pattern: string | string[];
  /** Canonical text (full keywords) stored in / removed from extraLines. */
  line: (a: Args, env: CmdEnv) => string;
  /** Number of words (after an optional leading `no`) identifying the setting. */
  key: number;
  /** 'set' (default): store; 'remove': drop a stored entry (IOS default / `no` of a value); 'none': informational line. */
  mode?: (a: Args, env: CmdEnv) => ExtraMode;
  /** Extra validation; may call invalidToken/env.reject. */
  validate?: (a: Args, env: CmdEnv) => void;
  feature?: Feature;
  /** Shown as "Accepted, but not simulated: <what>." ('' = no note). */
  what: string;
  help?: Record<string, string>;
  kinds?: ('router' | 'switch')[];
}
export function passiveGlobal(p: Passive): CommandDef {
  return {
    modes: 'config', pattern: p.pattern, feature: p.feature ?? 'system', help: p.help, kinds: p.kinds,
    run(env, a) {
      if (p.validate) p.validate(a, env);
      const mode = p.mode ? p.mode(a, env) : 'set';
      if (mode !== 'none') setExtra(env.device.config.extraLines, p.line(a, env), p.key, mode);
      if (p.what) env.note(NOT_SIMULATED + p.what + '.');
    },
  };
}
/** set when the `no` form was typed, remove otherwise (a default-on feature: only its negation is stored). */
const negStored = (_a: Args, e: CmdEnv): ExtraMode => (e.has('no') ? 'set' : 'remove');
/** set for the positive form, remove for the `no` form (a default-off feature or a value). */
const posStored = (_a: Args, e: CmdEnv): ExtraMode => (e.has('no') ? 'remove' : 'set');
const info = (): ExtraMode => 'none';
const neg = (env: CmdEnv): boolean => env.has('no');

// ───────────────────────────── Hostname ─────────────────────────────
export function hostnameLegal(name: string): boolean {
  return /^[A-Za-z]([A-Za-z0-9-]*[A-Za-z0-9])?$/.test(name) && name.length <= 63;
}

// ───────────────────────────── Banner (multi-line via pending input) ─────────────────────────────
type BannerKind = 'motd' | 'login' | 'exec';
function storeBanner(cfg: IosConfig, kind: BannerKind, text: string): void {
  if (kind === 'motd') { cfg.bannerMotd = text; return; }
  setExtra(cfg.extraLines, `banner ${kind} ^C${text}^C`, 2);
}
function startBanner(env: CmdEnv, kind: BannerKind, rest: string): void {
  const body = rest.replace(/^\s+/, '');
  const delim = body.startsWith('^C') ? '^C' : body[0];
  const after = body.slice(delim.length);
  const end = after.indexOf(delim);
  if (end >= 0) { storeBanner(env.device.config, kind, after.slice(0, end)); return; }
  env.print(`Enter TEXT message.  End with the character '${delim}'.`);
  const pending: PendingInput = { kind: 'banner-text', prompt: '', data: { kind, delim, acc: after + '\n' } };
  env.ask(pending);
}
function bannerPending(env: CmdEnv, input: string, pending: PendingInput): void {
  const d = pending.data as { kind: BannerKind; delim: string; acc: string };
  const end = input.indexOf(d.delim);
  if (end >= 0) { storeBanner(env.device.config, d.kind, d.acc + input.slice(0, end)); return; }
  env.ask({ ...pending, data: { ...d, acc: d.acc + input + '\n' } });
}
/** `menu <name> title <delim>…<delim>` multi-line entry, stored as one extra line. */
function startMenuTitle(env: CmdEnv, name: string, rest: string): void {
  const body = rest.replace(/^\s+/, '');
  const delim = body.startsWith('^C') ? '^C' : body[0];
  const after = body.slice(delim.length);
  const end = after.indexOf(delim);
  if (end >= 0) { setExtra(env.device.config.extraLines, `menu ${name} title ^C${after.slice(0, end)}^C`, 3); env.note(NOT_SIMULATED + 'menus.'); return; }
  env.print(`Enter TEXT message.  End with the character '${delim}'.`);
  env.ask({ kind: 'menu-title', prompt: '', data: { name, delim, acc: after + '\n' } });
}
function menuPending(env: CmdEnv, input: string, pending: PendingInput): void {
  const d = pending.data as { name: string; delim: string; acc: string };
  const end = input.indexOf(d.delim);
  if (end >= 0) { setExtra(env.device.config.extraLines, `menu ${d.name} title ^C${d.acc + input.slice(0, end)}^C`, 3); env.note(NOT_SIMULATED + 'menus.'); return; }
  env.ask({ ...pending, data: { ...d, acc: d.acc + input + '\n' } });
}

// ───────────────────────────── Commands ─────────────────────────────
const H = {
  hostname: "Set system's network name",
  enable: 'Modify enable password parameters',
  secret: 'Assign the privileged level secret (MAX of 25 characters)',
  password: 'Assign the privileged level password (MAX of 25 characters)',
  service: 'Modify use of network based services',
  'password-encryption': 'Encrypt system passwords',
  ip: 'Global IP configuration subcommands',
  'domain-lookup': 'Enable IP Domain Name System hostname translation',
  domain: 'IP DNS Resolver',
  lookup: 'Enable IP Domain Name System hostname translation',
  'domain-name': 'Define the default domain name',
  name: 'Define the default domain name',
  banner: 'Define a login banner',
  motd: 'Set Message of the Day banner',
  login: 'Set login banner',
  exec: 'Set EXEC process creation banner',
  username: 'Establish User Name Authentication',
  privilege: 'Set user privilege level',
  autocommand: 'Automatically issue a command after the user logs in',
  alias: 'Create command alias',
  configure: 'Global configuration mode',
  interface: 'Interface configuration mode',
  no: 'Negate a command or set its defaults',
  '<name>': 'This system\'s network name',
};

export const commands: CommandDef[] = [
  // ── hostname ──
  {
    modes: 'config', pattern: 'hostname <name:word>', feature: 'system', help: H,
    run(env, a) {
      const name = String(a.name);
      if (!hostnameLegal(name)) {
        env.print('% Hostname contains one or more illegal characters.');
        env.note('A host name should start with a letter and use only letters, digits and hyphens (-). IOS printed a warning but still changed the name.');
      }
      env.device.config.hostname = name;
    },
  },
  { modes: 'config', pattern: 'no hostname [<name:word>]', feature: 'system', help: H, run(env) { env.device.config.hostname = env.device.kind === 'router' ? 'Router' : 'Switch'; } },

  // ── enable secret / password ──
  {
    modes: 'config', pattern: ['enable secret <pw:text>', 'enable secret {t:0|5|8|9} <pw:text>'], feature: 'system',
    help: { ...H, '0': 'Specifies an UNENCRYPTED password will follow', '5': 'Specifies a MD5 HASHED secret will follow', '8': 'Specifies a PBKDF2 HASHED secret will follow', '9': 'Specifies a SCRYPT HASHED secret will follow', '<pw>': "The UNENCRYPTED (cleartext) 'enable' secret" },
    run(env, a) {
      const r = parseSecretArg(a.t ? `${a.t} ${a.pw}` : String(a.pw), 'secret');
      if ('error' in r) return env.reject(r.error);
      const cfg = env.device.config;
      if (cfg.enablePassword !== undefined && cfg.enablePassword === r.plain) {
        env.reject('The enable secret you have chosen is the same as your enable password.\nThis is not recommended.  Re-enter the enable secret.');
      }
      cfg.enableSecret = r.plain;
    },
  },
  {
    modes: 'config', pattern: ['enable password <pw:text>', 'enable password {t:0|7} <pw:text>'], feature: 'system',
    help: { ...H, '0': 'Specifies an UNENCRYPTED password will follow', '7': 'Specifies a HIDDEN password will follow', '<pw>': "The UNENCRYPTED (cleartext) 'enable' password" },
    run(env, a) {
      const r = parseSecretArg(a.t ? `${a.t} ${a.pw}` : String(a.pw), 'password');
      if ('error' in r) return env.reject(r.error);
      const cfg = env.device.config;
      if (cfg.enableSecret !== undefined && secretMatches(r.plain, cfg.enableSecret)) {
        env.reject('The enable password you have chosen is the same as your enable secret.\nThis is not recommended.  Re-enter the enable password.');
      }
      cfg.enablePassword = r.plain;
      if (cfg.enableSecret !== undefined) env.note('An enable secret is also set. IOS uses the secret and ignores the enable password.');
    },
  },
  {
    modes: 'config', pattern: 'enable secret level <lvl:int(1-15)> <pw:text>', feature: 'system', help: { level: 'Set exec level password' },
    run(env, a) {
      const r = parseSecretArg(String(a.pw), 'secret');
      if ('error' in r) return env.reject(r.error);
      if (Number(a.lvl) === 15) { env.device.config.enableSecret = r.plain; return; }
      setExtra(env.device.config.extraLines, `enable secret level ${a.lvl} ${r.plain}`, 4);
      env.note(NOT_SIMULATED + 'privilege levels other than 15.');
    },
  },
  { modes: 'config', pattern: 'no enable secret [<pw:text>]', feature: 'system', help: H, run(env) { delete env.device.config.enableSecret; } },
  { modes: 'config', pattern: 'no enable password [<pw:text>]', feature: 'system', help: H, run(env) { delete env.device.config.enablePassword; } },

  // ── service password-encryption ──
  { modes: 'config', pattern: ['service password-encryption', 'no service password-encryption'], feature: 'system', help: H, run(env) { env.device.config.servicePasswordEncryption = !neg(env); } },

  // ── ip domain-lookup / ip domain lookup ──
  {
    modes: 'config', pattern: ['ip domain-lookup', 'ip domain lookup', 'no ip domain-lookup', 'no ip domain lookup'], feature: 'system', help: H,
    run(env) { env.device.config.ipDomainLookup = !neg(env); },
  },
  {
    modes: 'config', pattern: ['ip domain lookup source-interface <ifname:if>', 'no ip domain lookup source-interface [<ifname:if>]'], feature: 'system',
    help: { 'source-interface': 'Specify interface for source address in connections' },
    run(env, a) {
      setExtra(env.device.config.extraLines, `ip domain lookup source-interface ${a.ifname ?? ''}`.trim(), 4, neg(env) ? 'remove' : 'set');
      env.note(NOT_SIMULATED + 'DNS lookups.');
    },
  },
  // ── ip domain-name / ip domain name ──
  {
    modes: 'config', pattern: ['ip domain-name <dn:word>', 'ip domain name <dn:word>'], feature: 'system', help: H,
    run(env, a) { setExtra(env.device.config.extraLines, `ip domain name ${a.dn}`, 3); },
  },
  {
    modes: 'config', pattern: ['no ip domain-name [<dn:word>]', 'no ip domain name [<dn:word>]'], feature: 'system', help: H,
    run(env) { setExtra(env.device.config.extraLines, 'ip domain name', 3, 'remove'); },
  },

  // ── banner ──
  {
    modes: 'config', pattern: 'banner {kind:motd|login|exec} <rest:text>', feature: 'system',
    help: { ...H, '<rest>': 'c  banner-text c, where \'c\' is a delimiting character' },
    run(env, a) {
      startBanner(env, a.kind as BannerKind, String(a.rest));
      if (a.kind !== 'motd') env.note(NOT_SIMULATED + `the ${a.kind} banner (only the MOTD banner is shown).`);
    },
  },
  {
    modes: 'config', pattern: 'banner <rest:text>', feature: 'system', help: H,
    run(env, a) {
      const rest = String(a.rest);
      const first = rest.split(/\s+/)[0].toLowerCase();
      if (['motd', 'login', 'exec'].some((k) => k.startsWith(first)) && !/\s/.test(rest.trim())) env.reject('% Incomplete command.');
      startBanner(env, 'motd', rest);
    },
  },
  {
    modes: 'config', pattern: 'no banner {kind:motd|login|exec}', feature: 'system', help: H,
    run(env, a) {
      if (a.kind === 'motd') delete env.device.config.bannerMotd;
      else setExtra(env.device.config.extraLines, `banner ${a.kind}`, 2, 'remove');
    },
  },

  // ── username ──
  {
    modes: 'config',
    pattern: ['username <user:word> {kind:secret|password} <pw:text>', 'username <user:word> privilege <lvl:int(0-15)> {kind:secret|password} <pw:text>', 'username <user:word> privilege <lvl:int(0-15)>'],
    feature: 'system',
    help: { ...H, secret: 'Specify the secret for the user', password: 'Specify the password for the user', '<lvl>': 'User privilege level', '<user>': 'User name' },
    run(env, a) {
      const users = env.device.config.users;
      let u = users.find((x) => x.name === a.user);
      let plain: string | undefined;
      if (a.pw !== undefined) {
        const r = parseSecretArg(String(a.pw), a.kind === 'secret' ? 'secret' : 'password');
        if ('error' in r) return env.reject(r.error);
        plain = r.plain;
      }
      if (!u) { u = { name: String(a.user), secret: plain ?? '' }; users.push(u); }
      else if (plain !== undefined) u.secret = plain;
      if (a.lvl !== undefined) u.privilege = Number(a.lvl);
      if (u.secret === '') env.note('Add a password or secret for this user before using login local.');
    },
  },
  {
    modes: 'config', pattern: 'username <user:word> autocommand <cmd:text>', feature: 'system', help: H,
    run(env, a) {
      if (!env.device.config.users.some((u) => u.name === a.user)) env.device.config.users.push({ name: String(a.user), secret: '' });
      setExtra(env.device.config.extraLines, `username ${a.user} autocommand ${a.cmd}`, 3);
      env.note(NOT_SIMULATED + 'autocommand (the command is not run at login).');
    },
  },
  {
    modes: 'config', pattern: 'no username <user:word> [<rest:text>]', feature: 'system', help: H,
    run(env, a) {
      const cfg = env.device.config;
      cfg.users = cfg.users.filter((u) => u.name !== a.user);
      setExtra(cfg.extraLines, `username ${a.user} autocommand`, 3, 'remove');
    },
  },

  // ── alias ──
  {
    modes: 'config', pattern: 'alias {mode:exec|configure|interface} <name:word> <cmd:text>', feature: 'system',
    help: { ...H, exec: 'Exec mode', configure: 'Global configuration mode', interface: 'Interface configuration mode', '<name>': 'Alias name', '<cmd>': 'Alias command' },
    run(env, a) {
      const list = env.device.config.aliases;
      const mode = a.mode as 'exec' | 'configure' | 'interface';
      const i = list.findIndex((x) => x.mode === mode && x.name === a.name);
      const entry = { mode, name: String(a.name), command: String(a.cmd) };
      if (i >= 0) list[i] = entry; else list.push(entry);
    },
  },
  {
    modes: 'config', pattern: 'no alias {mode:exec|configure|interface} [<name:word>]', feature: 'system', help: H,
    run(env, a) { env.device.config.aliases = env.device.config.aliases.filter((x) => x.mode !== a.mode || (a.name !== undefined && x.name !== a.name)); },
  },

  // ── menu (management lab) ──
  {
    modes: 'config', pattern: 'menu <name:word> title <rest:text>', feature: 'system', help: { menu: 'Define a user-interface menu', title: 'Set the menu title' },
    run(env, a) { startMenuTitle(env, String(a.name), String(a.rest)); },
  },
  {
    modes: 'config', pattern: ['menu <name:word> {kind:text|command} <item:word> <rest:text>'], feature: 'system',
    help: { menu: 'Define a user-interface menu', text: 'Text of menu item', command: 'Menu item command' },
    run(env, a) { setExtra(env.device.config.extraLines, `menu ${a.name} ${a.kind} ${a.item} ${a.rest}`, 4); env.note(NOT_SIMULATED + 'menus.'); },
  },
  {
    modes: 'config', pattern: 'no menu <name:word> [<rest:text>]', feature: 'system', help: { menu: 'Define a user-interface menu' },
    run(env, a) {
      const cfg = env.device.config;
      const prefix = `menu ${a.name} ${a.rest ?? ''}`.trim().toLowerCase();
      cfg.extraLines = cfg.extraLines.filter((l) => !(l.toLowerCase() === prefix || l.toLowerCase().startsWith(prefix + ' ')));
    },
  },

  // ── crypto key generate rsa (SSH keys) ──
  {
    modes: 'config', pattern: 'crypto key generate rsa [general-keys] [modulus <bits:int(512-4096)>]', feature: 'vty', mutates: false,
    help: { crypto: 'Encryption module', key: 'Long term key operations', generate: 'Generate new keys', rsa: 'Generate RSA keys', 'general-keys': 'Generate a general purpose RSA key pair for signing and encryption', modulus: 'Provide number of modulus bits on the command line' },
    run(env, a) {
      if (a.bits === undefined && env.session.via === 'file') {
        return env.reject('% RSA modulus requires interactive input. Specify modulus on the command line.');
      }
      const cfg = env.device.config;
      const dflt = env.device.kind === 'router' ? 'Router' : 'Switch';
      if (cfg.hostname === dflt) env.reject(`% Please define a hostname other than ${dflt}.`);
      const dn = extraHas(cfg.extraLines, 'ip domain name ');
      if (!dn) env.reject('% Please define a domain-name first.');
      const fqdn = `${cfg.hostname}.${dn!.slice('ip domain name '.length)}`;
      env.print(`The name for the keys will be: ${fqdn}`);
      if (a.bits !== undefined) { describeRsaLimit(env, Number(a.bits)); return; }
      env.print('Choose the size of the key modulus in the range of 512 to 4096 for your\n  General Purpose Keys. Choosing a key modulus greater than 512 may take\n  a few minutes.\n');
      env.ask({ kind: 'rsa-modulus', prompt: 'How many bits in the modulus [2048]: ' });
    },
  },

  // ── accepted, not simulated ──
  passiveGlobal({ pattern: ['ip cef', 'no ip cef'], key: 2, what: 'CEF switching', line: () => 'no ip cef', mode: negStored, help: { cef: 'Cisco Express Forwarding' } }),
  passiveGlobal({ pattern: ['cdp run', 'no cdp run'], key: 2, what: 'CDP', line: () => 'no cdp run', mode: negStored, help: { cdp: 'Global CDP configuration subcommands', run: 'Enable CDP' } }),
  passiveGlobal({ pattern: ['lldp run', 'no lldp run'], key: 2, what: 'LLDP', line: () => 'lldp run', mode: posStored, help: { lldp: 'Global LLDP configuration subcommands', run: 'Enable LLDP' } }),
  passiveGlobal({
    pattern: ['service timestamps {kind:debug|log} <rest:text>', 'service timestamps {kind:debug|log}'], key: 3, what: 'message timestamps',
    line: (a) => `service timestamps ${a.kind}${a.rest ? ' ' + a.rest : ''}`,
    // `datetime msec` is the IOS XE default: nothing to store
    mode: (a) => (String(a.rest ?? '').toLowerCase().replace(/\s+/g, ' ') === 'datetime msec' ? 'remove' : 'set'),
    help: { timestamps: 'Timestamp debug/log messages', debug: 'Timestamp debug messages', log: 'Timestamp log messages' },
  }),
  passiveGlobal({ pattern: 'no service timestamps {kind:debug|log} [<rest:text>]', key: 3, what: 'message timestamps', line: (a) => `no service timestamps ${a.kind}`, help: { timestamps: 'Timestamp debug/log messages' } }),
  passiveGlobal({ pattern: ['service pad', 'no service pad'], key: 2, what: 'X.25 PAD', line: () => 'no service pad', mode: negStored, help: { pad: 'Enable PAD commands' } }),
  passiveGlobal({ pattern: ['service {kind:tcp-keepalives-in|tcp-keepalives-out|sequence-numbers}', 'no service {kind:tcp-keepalives-in|tcp-keepalives-out|sequence-numbers}'], key: 2, what: 'this service', line: (a) => `service ${a.kind}`, mode: posStored }),
  passiveGlobal({ pattern: ['ip ssh <rest:text>', 'no ip ssh <rest:text>'], key: 3, feature: 'vty', what: 'SSH', line: (a) => `ip ssh ${a.rest}`, mode: posStored, help: { ssh: 'Configure ssh options' } }),
  passiveGlobal({ pattern: ['ntp server <addr:ip> [prefer]', 'no ntp server <addr:ip> [prefer]'], key: 3, what: 'NTP', line: (a, e) => `ntp server ${a.addr}${e.has('prefer') ? ' prefer' : ''}`, mode: posStored, help: { ntp: 'Configure NTP', server: 'Configure NTP server', prefer: 'Prefer this peer when possible' } }),
  passiveGlobal({ pattern: 'ip name-server <rest:text>', key: 3, what: 'DNS name servers', line: (a) => `ip name-server ${a.rest}`, help: { 'name-server': 'Specify address of name server to use' } }),
  passiveGlobal({ pattern: 'no ip name-server [<rest:text>]', key: 2, what: 'DNS name servers', line: () => 'ip name-server', mode: () => 'remove', help: { 'name-server': 'Specify address of name server to use' } }),
  passiveGlobal({ pattern: 'ip host <name:word> <rest:text>', key: 3, what: 'the host name table', line: (a) => `ip host ${a.name} ${a.rest}`, help: { host: 'Add an entry to the ip hostname table' } }),
  passiveGlobal({ pattern: 'no ip host <name:word> [<rest:text>]', key: 3, what: 'the host name table', line: (a) => `ip host ${a.name}`, mode: () => 'remove', help: { host: 'Add an entry to the ip hostname table' } }),
  passiveGlobal({ pattern: ['ip http {kind:server|secure-server}', 'no ip http {kind:server|secure-server}'], key: 3, what: 'the HTTP server', line: (a, e) => `${e.has('no') ? 'no ' : ''}ip http ${a.kind}`, help: { http: 'HTTP server configuration', server: 'Enable HTTP server', 'secure-server': 'Enable HTTP secure server' } }),
  passiveGlobal({ pattern: ['ip http authentication <rest:text>', 'no ip http authentication [<rest:text>]'], key: 3, what: 'the HTTP server', line: (a) => `ip http authentication ${a.rest ?? ''}`.trim(), mode: posStored, help: { authentication: 'Set http server authentication method' } }),
  passiveGlobal({ pattern: ['license boot level <rest:text>', 'no license boot level [<rest:text>]'], key: 3, what: 'licensing', line: (a) => `license boot level ${a.rest ?? ''}`.trim(), mode: posStored, help: { license: 'Configure license features', boot: 'license boot config commands', level: 'License Level' } }),
  passiveGlobal({ pattern: ['ip classless', 'no ip classless'], key: 2, what: 'classless routing behaviour', line: () => 'no ip classless', mode: negStored, help: { classless: 'Follow classless routing forwarding rules' } }),
  passiveGlobal({ pattern: ['ip subnet-zero', 'no ip subnet-zero'], key: 2, what: 'subnet zero handling', line: () => 'no ip subnet-zero', mode: negStored, help: { 'subnet-zero': "Allow 'subnet zero' subnets" } }),
  passiveGlobal({ pattern: ['ip source-route', 'no ip source-route'], key: 2, what: 'source routing', line: () => 'no ip source-route', mode: negStored, help: { 'source-route': 'Process packets with source routing header options' } }),
  passiveGlobal({ pattern: ['ip bootp server', 'no ip bootp server'], key: 3, what: 'the BOOTP server', line: () => 'no ip bootp server', mode: negStored, help: { bootp: 'Config BOOTP services' } }),
  passiveGlobal({ pattern: 'ip forward-protocol nd', key: 3, what: '', line: () => 'ip forward-protocol nd', mode: info, help: { 'forward-protocol': 'Controls forwarding of physical and directed IP broadcasts' } }),
  passiveGlobal({ pattern: ['clock timezone <rest:text>', 'no clock timezone [<rest:text>]'], key: 2, what: 'the clock', line: (a) => `clock timezone ${a.rest ?? ''}`.trim(), mode: posStored, help: { clock: 'Configure time-of-day clock', timezone: 'Configure time zone' } }),
  passiveGlobal({ pattern: ['clock summer-time <rest:text>', 'no clock summer-time [<rest:text>]'], key: 2, what: 'the clock', line: (a) => `clock summer-time ${a.rest ?? ''}`.trim(), mode: posStored, help: { 'summer-time': 'Configure summer (daylight savings) time' } }),
  passiveGlobal({ pattern: ['boot system <rest:text>', 'no boot system [<rest:text>]'], key: 2, what: 'boot images', line: (a) => `boot system ${a.rest ?? ''}`.trim(), mode: posStored, help: { boot: 'Modify system boot parameters', system: 'System image file' } }),
  passiveGlobal({ pattern: ['security passwords min-length <n:int(0-16)>', 'no security passwords min-length [<n:int(0-16)>]'], key: 3, what: 'password rules', line: (a) => `security passwords min-length ${a.n ?? ''}`.trim(), mode: posStored, help: { security: 'Infra Security CLIs', passwords: 'Password security configuration' } }),
  passiveGlobal({ pattern: ['login block-for <rest:text>', 'no login block-for [<rest:text>]'], key: 2, feature: 'vty', what: 'login blocking', line: (a) => `login block-for ${a.rest ?? ''}`.trim(), mode: posStored, help: { login: 'Enable secure login checking', 'block-for': 'Set quiet-mode active time period' } }),
  passiveGlobal({ pattern: ['login {kind:on-failure|on-success} log [<rest:text>]', 'no login {kind:on-failure|on-success} [<rest:text>]'], key: 2, feature: 'vty', what: 'login logging', line: (a) => `login ${a.kind} log`, mode: posStored }),
  passiveGlobal({ pattern: ['aaa new-model', 'no aaa new-model'], key: 2, feature: 'vty', what: 'AAA (logins still use the line settings)', line: () => 'aaa new-model', mode: posStored, help: { aaa: 'Authentication, Authorization and Accounting.', 'new-model': 'Enable NEW access control commands and functions.(Disables OLD commands.)' } }),
  passiveGlobal({
    kinds: ['router'], pattern: ['config-register <value:word>', 'no config-register [<value:word>]'], key: 1, what: 'the configuration register (it would only change the next boot)', line: (a) => `config-register ${a.value ?? ''}`.trim(), mode: posStored,
    validate: (a, e) => { if (!e.has('no') && !/^(0x)?[0-9a-f]{1,4}$/i.test(String(a.value))) invalidToken(e, 1); },
    help: { 'config-register': 'Define the configuration register' },
  }),
  // Informational lines that appear in a saved configuration: accepted silently, nothing to store.
  passiveGlobal({ pattern: 'version <rest:text>', key: 1, what: '', line: () => '', mode: info, help: { version: 'Version' } }),
  passiveGlobal({ pattern: ['boot-start-marker', 'boot-end-marker'], key: 1, what: '', line: () => '', mode: info }),
  passiveGlobal({ pattern: ['platform <rest:text>', 'no platform <rest:text>'], key: 1, what: '', line: () => '', mode: info }),
  passiveGlobal({ pattern: ['license udi <rest:text>', 'diagnostic bootup level <rest:text>', 'multilink bundle-name <rest:text>', 'subscriber templating', 'memory free low-watermark <rest:text>', 'control-plane'], key: 1, what: '', line: () => '', mode: info }),
];

function describeRsaLimit(env: CmdEnv, bits: number): void {
  env.note(`RSA generation is not simulated. The requested ${bits}-bit key was not created.`);
}

let installed = false;
export function install(): void {
  if (installed) return;
  installed = true;
  registerCommands(commands);
  registerPending('banner-text', bannerPending);
  registerPending('menu-title', menuPending);
  registerPending('rsa-modulus', (env, input) => {
    const t = input.trim();
    const bits = t === '' ? 2048 : Number(t);
    if (!/^\d*$/.test(t) || bits < 512 || bits > 4096) {
      env.ask({ kind: 'rsa-modulus', prompt: 'How many bits in the modulus [2048]: ' });
      return env.reject('% You must enter a number between 512 and 4096');
    }
    describeRsaLimit(env, bits);
  });
}
