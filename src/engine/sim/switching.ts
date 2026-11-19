/**
 * Layer 2: broadcast domains through switches (VLAN-aware) and neighbour resolution ("who owns this address on this link?").
 * No spanning tree, no MAC tables: a frame reaches every layer-3 endpoint of its VLAN.
 */
import type { IosDevice, InterfaceConfig, World } from '../types.ts';
import { inSubnet, ipToInt } from '../ip.ts';
import { basicNatEnabled, catalystNatMappingProblem, natRoleOn } from '../natProfile.ts';
import { peerOf } from '../world.ts';
import { aclEvaluate } from './acl.ts';
import { interfaceState, isUp } from './physical.ts';
import { isIosDevice, isPcDevice, label, subnetText } from './text.ts';

/** One switch a frame passes through. */
export interface L2Hop { switchId: string; inPort: string; outPort: string; vlan: number }
/** A layer-3 interface that hears frames sent from the starting interface. */
export interface L2Endpoint { deviceId: string; ifName: string; hops: L2Hop[] }

/**
 * Every layer-3 endpoint (PC NIC, router port, switch SVI) in the broadcast domain of an interface, with the switches crossed.
 * For a serial port: the interface at the other end. The starting interface itself is not included.
 */
export function l2Reach(world: World, deviceId: string, ifName: string): L2Endpoint[] {
  const out: L2Endpoint[] = [];
  const start = world.devices[deviceId];
  if (!start) return out;
  const visited = new Set<string>();

  const enter = (switchId: string, vlan: number, inPort: string, hops: L2Hop[]): void => {
    const key = `${switchId}|${vlan}`;
    if (visited.has(key)) return;
    visited.add(key);
    const sw = world.devices[switchId];
    if (!isIosDevice(sw)) return;
    const svi = `Vlan${vlan}`;
    if (sw.config.interfaces[svi] && !(switchId === deviceId && ifName === svi)) {
      out.push({ deviceId: switchId, ifName: svi, hops });
    }
    for (const spec of sw.ports) {
      if (spec.kind !== 'ethernet' || spec.name === inPort) continue;
      const sp = sw.config.interfaces[spec.name]?.switchport;
      if (!sp) continue;
      const trunk = sp.mode === 'trunk';
      if (!trunk && sp.accessVlan !== vlan) continue;
      if (!isUp(world, switchId, spec.name)) continue;
      const link = peerOf(world, { deviceId: switchId, port: spec.name });
      if (!link) continue;
      const tag = trunk && vlan !== 1 ? vlan : null;
      arrive(link.peer.deviceId, link.peer.port, tag, [...hops, { switchId, inPort, outPort: spec.name, vlan }]);
    }
  };

  const arrive = (devId: string, port: string, tag: number | null, hops: L2Hop[]): void => {
    const dev = world.devices[devId];
    if (!dev) return;
    if (dev.kind === 'switch' && isIosDevice(dev)) {
      const sp = dev.config.interfaces[port]?.switchport;
      if (!sp) { // routed port (`no switchport`)
        if (tag === null) out.push({ deviceId: devId, ifName: port, hops });
        return;
      }
      if (sp.mode === 'trunk') { enter(devId, tag ?? 1, port, hops); return; }
      if (tag !== null) return; // an access port drops tagged frames
      enter(devId, sp.accessVlan, port, hops);
      return;
    }
    if (tag !== null) return; // routers and PCs here do not read VLAN tags
    out.push({ deviceId: devId, ifName: port, hops });
  };

  const m = /^Vlan(\d+)$/.exec(ifName);
  if (m && start.kind === 'switch') {
    if (!isUp(world, deviceId, ifName)) return out;
    enter(deviceId, Number(m[1]), ifName, []);
    return out;
  }
  if (!isUp(world, deviceId, ifName)) return out;
  const link = peerOf(world, { deviceId, port: ifName });
  if (!link) return out;
  arrive(link.peer.deviceId, link.peer.port, null, []);
  return out;
}

function inRange(ip: string, lo: string, hi: string): boolean {
  const n = ipToInt(ip);
  return n >= ipToInt(lo) && n <= ipToInt(hi);
}

/** Is `ip` an inside-global address of a NAT rule (static global, or an address of a pool used by a dynamic rule)? */
function isNatGlobal(world: World, dev: IosDevice, ip: string): boolean {
  const cfg = dev.config;
  if (!basicNatEnabled(dev) || (dev.kind === 'switch' && !cfg.ipRouting)) return false;
  if (cfg.nat.staticRules.some((r) => r.global === ip && (dev.kind === 'router' || !r.interface))) return true;
  for (const rule of cfg.nat.dynamicRules) {
    if (!rule.pool || catalystNatMappingProblem(world, dev, rule)) continue;
    const pool = cfg.nat.pools.find((p) => p.name === rule.pool);
    if (pool && inRange(ip, pool.start, pool.end)) return true;
  }
  if (dev.kind === 'switch') return false;
  // virtual address of TCP load distribution: `ip nat inside destination list <acl> pool <rotary>`
  for (const rule of cfg.nat.insideDestinationRules) {
    const r = aclEvaluate(cfg.acls[rule.acl], { src: ip, dst: ip, proto: 'tcp', sport: 0, dport: 0, ttl: 64, bytes: 0 });
    if (r.permit && r.ace) return true;
  }
  return false;
}

function ifaceHasAddress(cfg: InterfaceConfig | undefined, ip: string): boolean {
  if (!cfg) return false;
  if (cfg.ip?.address === ip) return true;
  return !!cfg.secondary?.some((s) => s.address === ip);
}

/**
 * Does this interface answer for `ip` on its link? Its own addresses, plus NAT global addresses that lie inside the
 * subnet of an `ip nat outside` interface (IOS answers ARP for those so that translated traffic can come back).
 */
export function answersFor(world: World, deviceId: string, ifName: string, ip: string): boolean {
  const dev = world.devices[deviceId];
  if (isPcDevice(dev)) return ifName === 'Ethernet0' && !!dev.nic.address && dev.nic.address === ip;
  if (!isIosDevice(dev)) return false;
  const cfg = dev.config.interfaces[ifName];
  if (!cfg) return false;
  if (ifaceHasAddress(cfg, ip)) return true;
  if (natRoleOn(dev, ifName) === 'outside' && cfg.ip && inSubnet(ip, cfg.ip.address, cfg.ip.mask) && isNatGlobal(world, dev, ip)) return true;
  return false;
}

/** The endpoint on the same link that owns `ip` (first match in bench order), or null. */
export function resolveNeighbor(world: World, deviceId: string, ifName: string, ip: string): L2Endpoint | null {
  for (const ep of l2Reach(world, deviceId, ifName)) {
    if (!answersFor(world, ep.deviceId, ep.ifName, ip)) continue;
    if (!isUp(world, ep.deviceId, ep.ifName)) continue;
    return ep;
  }
  return null;
}

/** Every interface in the world that is configured with `ip`, wherever it is. */
export function findOwners(world: World, ip: string): { deviceId: string; ifName: string }[] {
  const out: { deviceId: string; ifName: string }[] = [];
  for (const id of world.order) {
    const dev = world.devices[id];
    if (isPcDevice(dev)) {
      if (dev.nic.address === ip) out.push({ deviceId: id, ifName: 'Ethernet0' });
    } else if (isIosDevice(dev)) {
      for (const [name, cfg] of Object.entries(dev.config.interfaces)) {
        if (ifaceHasAddress(cfg, ip)) out.push({ deviceId: id, ifName: name });
      }
    }
  }
  return out;
}

/**
 * Plain explanation of why nobody on the link of `ifName` answers for `ip`.
 * Looks for the address elsewhere in the lab to say what is wrong (interface shut down, other segment, not configured).
 */
export function explainUnresolved(world: World, deviceId: string, ifName: string, ip: string): string {
  const me = label(world, deviceId);
  const state = interfaceState(world, deviceId, ifName);
  if (!(state.status === 'up' && state.protocol === 'up')) {
    return `${me} ${ifName} is ${state.status}/${state.protocol}.${state.problem ? ' ' + state.problem : ''}`;
  }
  const owners = findOwners(world, ip).filter((o) => !(o.deviceId === deviceId && o.ifName === ifName));
  if (owners.length === 0) return `No device in the lab has the address ${ip}.`;
  const reach = l2Reach(world, deviceId, ifName);
  for (const o of owners) {
    const who = `${label(world, o.deviceId)} ${o.ifName}`;
    const st = interfaceState(world, o.deviceId, o.ifName);
    const sameLink = reach.some((e) => e.deviceId === o.deviceId && e.ifName === o.ifName);
    if (!(st.status === 'up' && st.protocol === 'up')) {
      return `${who} has the address ${ip}, but that interface is ${st.status}/${st.protocol}.${st.problem ? ' ' + st.problem : ''}`;
    }
    if (!sameLink) {
      const dev = world.devices[o.deviceId];
      if (isIosDevice(dev) && o.ifName.startsWith('Loopback')) {
        return `${ip} is a loopback address of ${dev.label}. It is not on this link, so it needs a route.`;
      }
      return `${who} has the address ${ip}, but it is not on the same link as ${me} ${ifName}. Check the cabling and the VLANs.`;
    }
  }
  return `Nobody on the link of ${me} ${ifName} answers for ${ip}.`;
}

/** 'x.x.x.x/len' of a PC's own network, or '' when it has no address. */
export function pcSubnetText(world: World, pcId: string): string {
  const pc = world.devices[pcId];
  if (!isPcDevice(pc) || !pc.nic.address || !pc.nic.mask) return '';
  return subnetText(pc.nic.address, pc.nic.mask);
}
