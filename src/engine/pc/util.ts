/**
 * Small helpers shared by the Windows and macOS command prompts: argument splitting, address/MAC formatting,
 * the adapter state as the operating system shows it, and the result type. Pure functions, no state.
 */
import type { PcDevice, World } from '../types.ts';
import { broadcastOf, intToIp, ipToInt, isIp } from '../ip.ts';
import { interfaceState } from '../sim/index.ts';

export interface PcCmdOut {
  output: string;
  delayMs?: number;
  clear?: boolean;
  telnet?: { deviceId: string; remoteAddr: string; host: string; port: number };
}

/** Longest pause any single command may ask for (the brief: modest, capped at 3 s). */
export const MAX_DELAY_MS = 3000;
export function capDelay(ms: number): number { return Math.max(0, Math.min(MAX_DELAY_MS, Math.round(ms))); }

/** Split a command line into words. Double quotes group words ("a b" → a b). Never throws. */
export function tokenize(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  let has = false;
  for (const ch of line) {
    if (ch === '"') { quoted = !quoted; has = true; continue; }
    if (!quoted && /\s/.test(ch)) {
      if (has) { out.push(cur); cur = ''; has = false; }
      continue;
    }
    cur += ch;
    has = true;
  }
  if (has) out.push(cur);
  return out;
}

/** Whole-number argument within a range, or null. */
export function intArg(s: string | undefined, min: number, max: number): number | null {
  if (s === undefined || !/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n >= min && n <= max ? n : null;
}

/** Same as ip.isIp, but tolerant of undefined. */
export function isAddr(s: string | undefined): s is string { return !!s && isIp(s); }

// ───────────────────────────── MAC addresses ─────────────────────────────
/** 32-bit FNV-1a hash (deterministic stand-in for hardware addresses the configuration does not hold). */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
/** Six bytes of a PC NIC MAC ('00-50-56-C0-10-11'). */
export function macBytes(mac: string): number[] {
  const parts = mac.split(/[-:.]/).map((x) => parseInt(x, 16)).filter((n) => Number.isFinite(n));
  while (parts.length < 6) parts.push(0);
  return parts.slice(0, 6);
}
export function macWindows(bytes: number[], upper = true): string {
  const s = bytes.map((b) => b.toString(16).padStart(2, '0')).join('-');
  return upper ? s.toUpperCase() : s;
}
export function macColon(bytes: number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join(':');
}
/** Stable MAC of a router/switch interface (Cisco OUI 70:1f:53). */
export function deviceMac(deviceId: string, ifName: string): number[] {
  const h = hash32(`${deviceId}|${ifName}`);
  return [0x70, 0x1f, 0x53, (h >>> 16) & 255, (h >>> 8) & 255, h & 255];
}

// ───────────────────────────── adapter state ─────────────────────────────
export interface NicView {
  /** Cable plugged in and the link is up. */
  linkUp: boolean;
  dhcp: boolean;
  /** IPv4 address the OS really uses (only when the link is up). */
  address?: string;
  mask?: string;
  gateway?: string;
  dns?: string;
  dhcpServer?: string;
  /** DHCP adapter without a lease: the OS falls back to a self-assigned 169.254.x.y address (display only). */
  apipa?: { address: string; mask: string };
}

export function nicView(world: World, pc: PcDevice): NicView {
  const st = interfaceState(world, pc.id, 'Ethernet0');
  const linkUp = st.status === 'up' && st.protocol === 'up';
  const nic = pc.nic;
  const v: NicView = { linkUp, dhcp: nic.mode === 'dhcp' };
  if (!linkUp) return v;
  if (nic.address && nic.mask) {
    v.address = nic.address;
    v.mask = nic.mask;
    if (nic.gateway) v.gateway = nic.gateway;
    if (nic.dns) v.dns = nic.dns;
    if (nic.mode === 'dhcp' && nic.dhcpServer) v.dhcpServer = nic.dhcpServer;
  } else if (nic.mode === 'dhcp') {
    const b = macBytes(nic.mac);
    v.apipa = { address: `169.254.${(b[4] % 254) + 1}.${b[5]}`, mask: '255.255.0.0' };
  }
  return v;
}

/** 255.255.255.192 → 0xffffffc0 */
export function hexMask(mask: string): string { return '0x' + ipToInt(mask).toString(16).padStart(8, '0'); }
export function bcast(address: string, mask: string): string { return broadcastOf(address, mask); }
export function nextAddr(ip: string, n: number): string { return intToIp((ipToInt(ip) + n) >>> 0); }

/** Hostname of the PC as Windows shows it: the sticker label without spaces, upper case. */
export function winHostname(pc: PcDevice): string {
  const h = pc.label.replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return (h || 'DESKTOP-PC').toUpperCase();
}

/** Windows "label . . . . : value" line (34-character label column, like ipconfig). */
export function winField(label: string, value = ''): string {
  let s: string;
  if (label === 'Connection-specific DNS Suffix') s = 'Connection-specific DNS Suffix  . ';
  else if (label === 'Primary Dns Suffix') s = 'Primary Dns Suffix  . . . . . . . ';
  else {
    s = label;
    while (s.length < 33) s += s.length % 2 === 0 ? '.' : ' ';
    s += ' ';
  }
  return `   ${s}: ${value}`.trimEnd();
}

/** Pad helpers for table output. */
export function padL(s: string | number, n: number): string { return String(s).padStart(n); }
export function padR(s: string | number, n: number): string { return String(s).padEnd(n); }

/** Known TCP service names (nc and Test-NetConnection output). */
export const TCP_SERVICE: Record<number, string> = { 21: 'ftp', 22: 'ssh', 23: 'telnet', 25: 'smtp', 53: 'domain', 80: 'http', 110: 'pop3', 443: 'https', 445: 'microsoft-ds', 3389: 'ms-wbt-server' };
