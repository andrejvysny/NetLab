/** Input checks with plain-words messages: PC network settings, cable kinds, port references. */
import type { CableKind, PortRef } from '../types.ts';
import { broadcastOf, ipToInt, isIp, isMask, maskToPrefix, networkOf } from '../ip.ts';

export const CABLE_KINDS: CableKind[] = ['straight', 'crossover', 'serial', 'console'];
export const CABLE_WORDS: Record<CableKind, string> = {
  straight: 'Ethernet straight-through', crossover: 'Ethernet crossover', serial: 'serial', console: 'console',
};

export function isPortRef(v: unknown): v is PortRef {
  return !!v && typeof v === 'object' && typeof (v as PortRef).deviceId === 'string' && typeof (v as PortRef).port === 'string';
}

export interface NicInput { address?: unknown; mask?: unknown; gateway?: unknown; dns?: unknown }
export type NicCheck =
  | { ok: true; address: string; mask: string; gateway?: string; dns?: string }
  | { ok: false; message: string };

const clean = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * Static address settings of a PC. Only things a real PC refuses are rejected (bad format, impossible combinations).
 * A wrong but possible setting (for example a gateway in another network) is accepted: the network simply does not work.
 */
export function checkStaticNic(pcLabel: string, nic: NicInput): NicCheck {
  const address = clean(nic.address);
  const mask = clean(nic.mask);
  const gateway = clean(nic.gateway);
  const dns = clean(nic.dns);
  if (!address) return { ok: false, message: `Type an IP address for ${pcLabel}, like 192.168.1.10.` };
  if (!isIp(address)) return { ok: false, message: `"${address}" is not an IP address. Use four numbers from 0 to 255 with dots, like 192.168.1.10.` };
  if (!mask) return { ok: false, message: `Type a subnet mask for ${pcLabel}, like 255.255.255.0.` };
  if (!isIp(mask)) return { ok: false, message: `"${mask}" is not a subnet mask. Use four numbers with dots, like 255.255.255.0.` };
  if (!isMask(mask) || mask === '0.0.0.0') {
    return { ok: false, message: `${mask} is not a valid subnet mask. A mask is a row of ones followed by zeros, like 255.255.255.0 or 255.255.255.192.` };
  }
  const first = Number(address.split('.')[0]);
  if (first === 0) return { ok: false, message: `${address} cannot be used on a PC. Addresses that start with 0 are reserved.` };
  if (first === 127) return { ok: false, message: `${address} cannot be used on a PC. Addresses that start with 127 are reserved for the PC itself (loopback).` };
  if (first >= 224) return { ok: false, message: `${address} cannot be used on a PC. Addresses from 224 up are reserved (multicast).` };
  const prefix = maskToPrefix(mask);
  if (prefix >= 31) return { ok: false, message: `The mask ${mask} leaves no room for hosts. Use a mask with at least two host addresses, like 255.255.255.252.` };
  if (ipToInt(address) === ipToInt(networkOf(address, mask))) {
    return { ok: false, message: `${address} is the network address of ${networkOf(address, mask)}/${prefix}. A PC cannot use it. Pick an address inside the network.` };
  }
  if (ipToInt(address) === ipToInt(broadcastOf(address, mask))) {
    return { ok: false, message: `${address} is the broadcast address of ${networkOf(address, mask)}/${prefix}. A PC cannot use it. Pick an address inside the network.` };
  }
  if (gateway && !isIp(gateway)) return { ok: false, message: `"${gateway}" is not an IP address. Type the gateway like 192.168.1.1, or leave it empty.` };
  if (gateway === '0.0.0.0') return { ok: false, message: 'The gateway 0.0.0.0 is not a real address. Type the address of the router, or leave it empty.' };
  if (dns && !isIp(dns)) return { ok: false, message: `"${dns}" is not an IP address. Type the DNS server like 8.8.8.8, or leave it empty.` };
  const out: NicCheck = { ok: true, address, mask };
  if (gateway) out.gateway = gateway;
  if (dns) out.dns = dns;
  return out;
}
