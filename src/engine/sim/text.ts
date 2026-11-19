/** Wording helpers for traces: packet headers, device labels, rates. Pure functions. */
import type { Device, IosDevice, Packet, PcDevice, World } from '../types.ts';
import { maskToPrefix, networkOf, portName } from '../ip.ts';

export function isIosDevice(d: Device | undefined): d is IosDevice { return !!d && (d.kind === 'router' || d.kind === 'switch'); }
export function isPcDevice(d: Device | undefined): d is PcDevice { return !!d && d.kind === 'pc'; }

/** Sticker name of a device ('R1'); falls back to the id. */
export function label(world: World, deviceId: string): string {
  return world.devices[deviceId]?.label ?? deviceId;
}

/** '60.50.40.0/26' from any address inside the subnet. */
export function subnetText(address: string, mask: string): string {
  return `${networkOf(address, mask)}/${maskToPrefix(mask)}`;
}

/** 121600 → '121.6 kbit/s'; 2000000 → '2000 kbit/s'. */
export function rateText(bps: number): string {
  const k = bps / 1000;
  return `${Number.isInteger(k) ? k : Number(k.toFixed(3))} kbit/s`;
}

const ICMP_WORDS: Record<string, string> = {
  echo: 'echo', 'echo-reply': 'echo reply', unreachable: 'unreachable',
  'admin-prohibited': 'administratively prohibited', 'time-exceeded': 'time exceeded',
};

/** Port as IOS would print it, with the number when a name is used: 'www (80)', '49153'. */
export function portText(port: number | undefined, proto: 'tcp' | 'udp'): string {
  if (port === undefined) return '?';
  const name = portName(port, proto);
  return name === String(port) ? name : `${name} (${port})`;
}

function appWord(p: Packet): string {
  const a = p.app;
  if (!a) return '';
  switch (a.kind) {
    case 'syslog': return ' syslog';
    case 'snmp': return ` SNMP ${a.op}`;
    case 'dhcp': return ` DHCP ${a.op}`;
    case 'ike': return ' IKE';
    case 'generic': return a.label ? ` ${a.label}` : '';
  }
}

/** Header line for TraceStep.header, e.g. 'ICMP echo 60.50.50.100 → 60.50.40.2'. */
export function describePacket(p: Packet): string {
  switch (p.proto) {
    case 'icmp': return `ICMP ${ICMP_WORDS[p.icmpType ?? 'echo'] ?? p.icmpType} ${p.src} → ${p.dst}`;
    case 'tcp': {
      const rst = (p as { tcpRst?: boolean }).tcpRst;
      const flag = rst ? 'RST' : p.tcpSyn ? 'SYN' : 'SYN-ACK';
      return `TCP ${flag} ${p.src}:${p.sport ?? 0} → ${p.dst}:${p.dport ?? 0}`;
    }
    case 'udp': return `UDP${appWord(p)} ${p.src}:${p.sport ?? 0} → ${p.dst}:${p.dport ?? 0}`;
    case 'esp': return `ESP ${p.src} → ${p.dst}${p.inner ? ` [${describePacket(p.inner)}]` : ''}`;
    default: return `IP ${p.src} → ${p.dst}`;
  }
}

/** Short human name of what a packet is: 'ping (ICMP echo request)', 'TCP connection request to port 80 (www)'. */
export function packetKind(p: Packet): string {
  switch (p.proto) {
    case 'icmp':
      switch (p.icmpType) {
        case 'echo-reply': return 'ping reply (ICMP echo reply)';
        case 'unreachable': return 'ICMP "destination unreachable" message';
        case 'admin-prohibited': return 'ICMP "administratively prohibited" message';
        case 'time-exceeded': return 'ICMP "time exceeded" message';
        default: return 'ping (ICMP echo request)';
      }
    case 'tcp': {
      if ((p as { tcpRst?: boolean }).tcpRst) return 'TCP reset (connection refused)';
      if (p.tcpSyn) return `TCP connection request to port ${portText(p.dport, 'tcp')}`;
      return `TCP answer from port ${portText(p.sport, 'tcp')}`;
    }
    case 'udp': {
      const a = p.app;
      if (a?.kind === 'syslog') return 'syslog message (UDP 514)';
      if (a?.kind === 'snmp') return a.op === 'response' ? 'SNMP response' : a.op === 'trap' ? 'SNMP trap (UDP 162)' : `SNMP ${a.op} request (UDP 161)`;
      if (a?.kind === 'dhcp') return `DHCP ${a.op} (UDP 67)`;
      if (a?.kind === 'ike') return 'IKE negotiation packet (UDP 500)';
      return `UDP packet to port ${portText(p.dport, 'udp')}`;
    }
    case 'esp': return 'encrypted packet (ESP)';
    default: return 'IP packet';
  }
}

/** packetKind with the right article: 'a ping (ICMP echo request)', 'an ICMP "time exceeded" message'. */
export function aPacket(p: Packet): string {
  const k = packetKind(p);
  return `${/^[aeioAEIO]/.test(k) || k.startsWith('SNMP') ? 'an' : 'a'} ${k}`;
}

export function plural(n: number, one: string, many = one + 's'): string { return `${n} ${n === 1 ? one : many}`; }

/** 'a PC', 'a router', 'a switch' */
export function kindWord(kind: 'router' | 'switch' | 'pc'): string { return kind === 'pc' ? 'a PC' : `a ${kind}`; }
