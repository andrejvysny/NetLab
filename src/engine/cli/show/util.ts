/**
 * Shared helpers for the verification commands (show …, ping, traceroute, telnet): caret errors, interface
 * resolution, the simulated clock, deterministic MAC addresses / serial numbers, column padding and IOS naming.
 * Pure functions; nothing here keeps state (the clock is derived from world.tick).
 */
import type { CmdEnv } from '../framework.ts';
import { CONFIG_MODES, promptFor } from '../framework.ts';
import type { Device, IosDevice, World } from '../../types.ts';
import { ifSortKey, parseIfName } from '../../ip.ts';

// ───────────────────────────── tokens and caret errors ─────────────────────────────
export interface Tok { text: string; start: number }
export function toks(line: string): Tok[] {
  const out: Tok[] = []; const re = /\S+/g; let m: RegExpExecArray | null;
  while ((m = re.exec(line))) out.push({ text: m[0], start: m.index });
  return out;
}
/** Columns the prompt (and a `do ` prefix in configuration modes) take before env.line on screen. */
function lineOffset(env: CmdEnv): number {
  const prompt = env.promptLen || promptFor(env.world, env.session).length;
  return prompt + (CONFIG_MODES.includes(env.session.mode) ? 'do '.length : 0);
}
/** "% Invalid input detected at '^' marker." with the caret under column `col` of env.line. */
export function invalidCol(env: CmdEnv, col: number): never {
  return env.reject(' '.repeat(lineOffset(env) + Math.max(0, col)) + "^\n% Invalid input detected at '^' marker.");
}
/** Same, caret under token number `index` (0-based) of env.line. */
export function invalidTok(env: CmdEnv, index: number): never {
  const t = toks(env.line);
  const tok = t[Math.min(index, t.length - 1)];
  return invalidCol(env, tok ? tok.start : env.line.length);
}

/** 'Loopback00' → 'Loopback0' (IOS ignores leading zeros). */
export function normIf(name: string): string {
  const m = /^([A-Za-z]+)(.*)$/.exec(name);
  return m ? m[1] + m[2].replace(/\d+/g, (d) => String(Number(d))) : name;
}

/** Index of the token where the interface argument starts (first token after `after` that parses as an interface). */
function ifTokenIndex(env: CmdEnv, after: number): number {
  const t = toks(env.line);
  for (let i = after; i < t.length; i++) if (parseIfName(t[i].text)) return i;
  return Math.min(after, t.length - 1);
}

/**
 * The canonical name of an existing interface typed as a command argument, or a caret error like IOS.
 * `after` = number of fixed keywords before the interface argument (e.g. 2 for `show interfaces X`).
 */
export function existingIf(env: CmdEnv, raw: string, after: number): string {
  const name = normIf(raw);
  if (env.device.config.interfaces[name]) return name;
  const t = toks(env.line);
  const i = ifTokenIndex(env, after);
  const tok = t[i];
  if (!tok) return invalidCol(env, env.line.length);
  // caret under the number part, as IOS does for an unknown interface number
  const m = /^([A-Za-z]+)(.*)$/.exec(tok.text);
  if (m && m[2] === '' && t[i + 1]) return invalidCol(env, t[i + 1].start);
  return invalidCol(env, tok.start + (m ? m[1].length : 0));
}

// ───────────────────────────── interfaces ─────────────────────────────
/** Interfaces in the order IOS lists them: switches show Vlan interfaces first, then physical ports, loopbacks, tunnels. */
export function ifOrder(dev: IosDevice): string[] {
  const names = Object.keys(dev.config.interfaces);
  const group = (n: string): number => {
    if (n.startsWith('Vlan')) return dev.kind === 'switch' ? 0 : 4;
    if (n.startsWith('Loopback')) return 2;
    if (n.startsWith('Tunnel')) return 3;
    return 1;
  };
  return names.sort((a, b) => group(a) - group(b) || (ifSortKey(a) < ifSortKey(b) ? -1 : ifSortKey(a) > ifSortKey(b) ? 1 : 0));
}
export function isPhysicalPort(dev: Device, name: string): boolean {
  return dev.ports.some((p) => p.name === name && (p.kind === 'ethernet' || p.kind === 'serial'));
}
export function isSerial(name: string): boolean { return name.startsWith('Serial'); }
export function isEthernet(name: string): boolean { return /^(GigabitEthernet|FastEthernet|TenGigabitEthernet|Ethernet)/.test(name); }
/** Switch port still in layer-2 mode (no IP processing). */
export function isL2(dev: IosDevice, name: string): boolean {
  return dev.kind === 'switch' && isPhysicalPort(dev, name) && !!dev.config.interfaces[name]?.switchport;
}

/** 'GigabitEthernet0/0/0' → 'Gig 0/0/0', 'Serial0/1/0' → 'Ser 0/1/0' (CDP neighbour table). */
export function cdpIfName(name: string): string {
  const pairs: [string, string][] = [['GigabitEthernet', 'Gig'], ['TenGigabitEthernet', 'Ten'], ['FastEthernet', 'Fas'], ['Serial', 'Ser'], ['Ethernet', 'Eth']];
  for (const [long, short] of pairs) if (name.startsWith(long)) return `${short} ${name.slice(long.length)}`;
  return name;
}

// ───────────────────────────── padding ─────────────────────────────
export function padR(s: string | number, n: number): string { return String(s).padEnd(n); }
export function padL(s: string | number, n: number): string { return String(s).padStart(n); }
/** Trailing blanks removed, one string with '\n' between the lines. */
export function joinLines(lines: string[]): string { return lines.map((l) => l.replace(/\s+$/, '')).join('\n'); }

// ───────────────────────────── simulated clock ─────────────────────────────
/** The lab clock starts on Monday 18 May 2026 08:00:00 UTC (the devices were booted then). */
const BOOT_EPOCH_MS = Date.UTC(2026, 4, 18, 8, 0, 0);
/** The devices had been running for a few minutes when the student started; every executed command takes ~4 s. */
const BOOT_OFFSET_S = 300;
const SECONDS_PER_TICK = 4;
export function secondsAt(tick: number): number { return BOOT_OFFSET_S + Math.max(0, tick) * SECONDS_PER_TICK; }
export function uptimeSeconds(world: World): number { return secondsAt(world.tick); }
export function epochMsAt(tick: number): number { return BOOT_EPOCH_MS + secondsAt(tick) * 1000; }

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const two = (n: number): string => String(n).padStart(2, '0');

/** `clock timezone NAME H [M]` from the configuration: name and offset in minutes (default UTC 0). */
export function timezone(dev: IosDevice): { name: string; offsetMin: number } {
  const line = dev.config.extraLines.find((l) => /^clock timezone\s/i.test(l));
  const m = line ? /^clock timezone\s+(\S+)\s+(-?\d+)(?:\s+(\d+))?/i.exec(line) : null;
  if (!m) return { name: 'UTC', offsetMin: 0 };
  const h = Number(m[2]);
  const min = m[3] ? Number(m[3]) : 0;
  return { name: m[1], offsetMin: h * 60 + (h < 0 ? -min : min) };
}
function localDate(dev: IosDevice, ms: number): Date { return new Date(ms + timezone(dev).offsetMin * 60000); }

/** '*09:12:45.123 UTC Mon May 18 2026' (show clock; '*' = not synchronised to NTP). */
export function clockText(dev: IosDevice, world: World): string {
  const ms = epochMsAt(world.tick) + (world.tick * 137) % 1000;
  const d = localDate(dev, ms);
  const msec = String(d.getUTCMilliseconds()).padStart(3, '0');
  return `*${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}.${msec} ${timezone(dev).name} ${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${d.getUTCFullYear()}`;
}
/** Log timestamp 'May 18 09:01:12.345' (service timestamps log datetime msec). */
export function logStamp(dev: IosDevice, tick: number): string {
  const d = localDate(dev, epochMsAt(tick) + (tick * 137) % 1000);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}.${String(d.getUTCMilliseconds()).padStart(3, '0')}`;
}
/** DHCP style 'May 19 2026 08:05 AM'. `extraSeconds` is added to the moment of `tick`. */
export function dhcpDate(dev: IosDevice, tick: number, extraSeconds = 0): string {
  const d = localDate(dev, epochMsAt(tick) + extraSeconds * 1000);
  const h = d.getUTCHours();
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${MONTHS[d.getUTCMonth()]} ${two(d.getUTCDate())} ${d.getUTCFullYear()} ${two(h12)}:${two(d.getUTCMinutes())} ${h < 12 ? 'AM' : 'PM'}`;
}
/** NAT verbose style '05/18/26 09:01:15'. */
export function shortDate(dev: IosDevice, tick: number): string {
  const d = localDate(dev, epochMsAt(tick));
  return `${two(d.getUTCMonth() + 1)}/${two(d.getUTCDate())}/${String(d.getUTCFullYear()).slice(2)} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`;
}
/** 'hh:mm:ss' for an age in seconds (IOS switches to '1d02h' style after a day). */
export function hms(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s >= 86400) return `${Math.floor(s / 86400)}d${two(Math.floor((s % 86400) / 3600))}h`;
  return `${two(Math.floor(s / 3600))}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}`;
}
/** '1 hour, 12 minutes' (show version uptime). */
export function uptimeText(seconds: number): string {
  let s = Math.floor(seconds / 60);
  const parts: string[] = [];
  const unit = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const weeks = Math.floor(s / 10080); s -= weeks * 10080;
  const days = Math.floor(s / 1440); s -= days * 1440;
  const hours = Math.floor(s / 60); s -= hours * 60;
  if (weeks) parts.push(unit(weeks, 'week'));
  if (days) parts.push(unit(days, 'day'));
  if (hours) parts.push(unit(hours, 'hour'));
  parts.push(unit(s, 'minute'));
  return parts.join(', ');
}

// ───────────────────────────── MAC addresses, serial numbers ─────────────────────────────
function dotted(hex12: string): string { return `${hex12.slice(0, 4)}.${hex12.slice(4, 8)}.${hex12.slice(8, 12)}`.toLowerCase(); }
function devIndex(world: World, deviceId: string): number { return Math.max(0, world.order.indexOf(deviceId)) + 1; }
/** Cisco-style dotted MAC of an interface (PCs: their NIC address). Serial and loopback interfaces have none. */
export function macOf(world: World, deviceId: string, ifName: string): string | undefined {
  const dev = world.devices[deviceId];
  if (!dev) return undefined;
  if (dev.kind === 'pc') return dotted(dev.nic.mac.replace(/[^0-9A-Fa-f]/g, '').padStart(12, '0'));
  if (isSerial(ifName) || ifName.startsWith('Loopback') || ifName.startsWith('Tunnel')) return undefined;
  const oui = dev.kind === 'router' ? '70ca9b' : '7c210e';
  const idx = devIndex(world, deviceId);
  let port: number;
  const svi = /^Vlan(\d+)$/.exec(ifName);
  if (svi) port = 0x40 + Number(svi[1]) % 0x40;
  else port = Math.max(0, dev.ports.findIndex((p) => p.name === ifName)) + 1;
  return dotted(oui + ((idx * 0x37) & 0xff).toString(16).padStart(2, '0') + (idx & 0xff).toString(16).padStart(2, '0') + port.toString(16).padStart(2, '0'));
}
/** Base MAC of a device (first address of its pool). */
export function baseMac(world: World, deviceId: string): string {
  const dev = world.devices[deviceId];
  const oui = dev?.kind === 'switch' ? '7c210e' : '70ca9b';
  const idx = devIndex(world, deviceId);
  return dotted(oui + ((idx * 0x37) & 0xff).toString(16).padStart(2, '0') + (idx & 0xff).toString(16).padStart(2, '0') + '00');
}
/** Deterministic serial number such as 'FDO2152A1B3'. */
export function serialNo(world: World, deviceId: string, salt: string, prefix = 'FDO'): string {
  let h = 2166136261;
  for (const c of deviceId + '|' + salt) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  const digits = (h % 10000).toString().padStart(4, '0');
  const tail = (h >>> 8).toString(36).toUpperCase().replace(/[^A-Z0-9]/g, '').padStart(4, 'X').slice(0, 4);
  return `${prefix}${digits}${tail}`.slice(0, 11);
}

/** Small deterministic number in [lo, hi] from a key and the tick (hold times, ages). */
export function jitter(key: string, tick: number, lo: number, hi: number): number {
  let h = 2166136261;
  for (const c of key) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return lo + ((h + tick * 7) % (hi - lo + 1));
}
