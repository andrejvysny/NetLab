/**
 * Interface state changes → the messages a real IOS device logs
 * (%LINK-3-UPDOWN, %LINK-5-CHANGED, %LINEPROTO-5-UPDOWN), associated SNMP link events, and console log formatting.
 */
import type { ModeledSnmpTrap, World } from '../types.ts';
import { isIos } from '../world.ts';
import { interfaceState } from '../sim/index.ts';

export interface IfStatus { status: 'up' | 'down' | 'administratively down'; protocol: 'up' | 'down' }
/** deviceId → interface name → state. IOS devices only. */
export type IfSnapshot = Record<string, Record<string, IfStatus>>;

export interface LogEvent {
  deviceId: string;
  severity: number;
  /** Without the leading '%', e.g. 'LINK-3-UPDOWN'. */
  mnemonic: string;
  text: string;
  /** Seconds after the action (the line protocol follows the link about a second later). */
  delay: number;
  /** Only existing interface line-protocol edges generate a trap, never both LINK and LINEPROTO. */
  trapType?: ModeledSnmpTrap;
}

export function snapshotInterfaces(world: World): IfSnapshot {
  const out: IfSnapshot = {};
  for (const id of world.order) {
    const dev = world.devices[id];
    if (!isIos(dev)) continue;
    const row: Record<string, IfStatus> = {};
    for (const name of Object.keys(dev.config.interfaces)) {
      const s = interfaceState(world, id, name);
      row[name] = { status: s.status, protocol: s.protocol };
    }
    out[id] = row;
  }
  return out;
}

/** Messages for every interface whose state differs between two snapshots, in device order. */
export function diffInterfaces(world: World, before: IfSnapshot, after: IfSnapshot): LogEvent[] {
  const out: LogEvent[] = [];
  for (const id of world.order) {
    const now = after[id];
    if (!now) continue;
    const was = before[id] ?? {};
    for (const name of Object.keys(now)) {
      const a = now[name];
      const b = was[name];
      if (!b) {
        // A new logical interface (interface Loopback0): IOS reports only its line protocol.
        if (a.protocol === 'up') out.push({ deviceId: id, severity: 5, mnemonic: 'LINEPROTO-5-UPDOWN', text: `Line protocol on Interface ${name}, changed state to up`, delay: 0 });
        continue;
      }
      if (a.status !== b.status) {
        if (a.status === 'administratively down') {
          out.push({ deviceId: id, severity: 5, mnemonic: 'LINK-5-CHANGED', text: `Interface ${name}, changed state to administratively down`, delay: 0 });
        } else {
          out.push({ deviceId: id, severity: 3, mnemonic: 'LINK-3-UPDOWN', text: `Interface ${name}, changed state to ${a.status}`, delay: 0 });
        }
      }
      if (a.protocol !== b.protocol) {
        out.push({ deviceId: id, severity: 5, mnemonic: 'LINEPROTO-5-UPDOWN', text: `Line protocol on Interface ${name}, changed state to ${a.protocol}`, delay: 1,
          trapType: a.protocol === 'up' ? 'snmp linkup' : 'snmp linkdown' });
      }
    }
  }
  return out;
}

const two = (n: number): string => String(n).padStart(2, '0');

/**
 * A log message as the console prints it with the default `service timestamps log datetime msec`
 * (the '*' means the clock was never set). The time is derived from the logical clock, so it is repeatable.
 */
export function consoleLogLine(tick: number, mnemonic: string, text: string, delay = 0): string {
  const secs = 40 + Math.max(0, tick) * 3 + delay;
  const ms = (Math.max(0, tick) * 137 + delay * 411) % 1000;
  const hh = Math.floor(secs / 3600) % 24;
  const mm = Math.floor(secs / 60) % 60;
  const ss = secs % 60;
  return `*Mar  1 ${two(hh)}:${two(mm)}:${two(ss)}.${String(ms).padStart(3, '0')}: %${mnemonic}: ${text}\n`;
}
