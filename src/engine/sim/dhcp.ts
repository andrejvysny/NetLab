/**
 * DHCP (ARCHITECTURE §6.6): a PC broadcasts on its link; a router interface that hears it answers from a local pool
 * or relays the request (ip helper-address) as a normal unicast packet; the server picks the pool by the receiving
 * subnet or by giaddr, honours exclusions, pings the candidate before offering it, and records a binding.
 */
import type { DhcpPool, IosDevice, PcDevice, TraceStep, World } from '../types.ts';
import { hostRange, inSubnet, intToIp, ipToInt, maskToPrefix } from '../ip.ts';
import { aclEvaluate, aclEvidence, countHit } from './acl.ts';
import { flushLogs, runFlow } from './flow.ts';
import type { SimPacket } from './model.ts';
import { interfaceState, isUp } from './physical.ts';
import { makeCtx } from './pipeline.ts';
import { dhcpServiceEnabled } from './services.ts';
import { answersFor, l2Reach } from './switching.ts';
import { isIosDevice, isPcDevice, label, subnetText } from './text.ts';

export interface DhcpResult {
  ok: boolean;
  address?: string;
  mask?: string;
  gateway?: string;
  server?: string;
  reasonText?: string;
  steps: TraceStep[];
}

interface Offer { address: string; mask: string; gateway?: string; dns?: string; server: string; serverId: string; pool: string }

function isExcluded(dev: IosDevice, ip: string): { low: string; high: string } | undefined {
  const n = ipToInt(ip);
  return dev.config.dhcp.excluded.find((e) => n >= ipToInt(e.low) && n <= ipToInt(e.high));
}

function selectPool(dev: IosDevice, addr: string): DhcpPool | undefined {
  return dev.config.dhcp.pools.find((p) => p.network && inSubnet(addr, p.network.address, p.network.mask));
}

/**
 * Ask for an address for a PC whose adapter is set to DHCP. On success the PC's NIC holds address, mask,
 * default gateway and the server address. On failure `reasonText` says who heard the request and why nobody answered.
 */
export function dhcpAcquire(world: World, pcId: string): DhcpResult {
  const steps: TraceStep[] = [];
  const pc = world.devices[pcId];
  const stepOf = (deviceId: string, stage: TraceStep['stage'], verdict: TraceStep['verdict'], text: string, detail?: string, iface?: string) =>
    steps.push({ deviceId, stage, feature: 'dhcp', verdict, text, detail, iface });
  /** `text` is the full reason; the final step shows its first sentence and keeps the rest as detail. */
  const giveUp = (text: string, more?: string): DhcpResult => {
    stepOf(pcId, 'drop', 'drop', text, more);
    return { ok: false, reasonText: more ? `${text} ${more}` : text, steps };
  };
  if (!isPcDevice(pc)) return giveUp(`${label(world, pcId)} is not a PC.`);
  if (pc.nic.mode !== 'dhcp') {
    return giveUp(`${pc.label} uses a fixed (static) address, so it does not ask a DHCP server.`, 'Set its network adapter to DHCP ("obtain an address automatically") first.');
  }
  const link = interfaceState(world, pcId, 'Ethernet0');
  if (!(link.status === 'up' && link.protocol === 'up')) {
    return giveUp(`${pc.label} cannot ask for an address: its network link is down.`, link.problem);
  }

  const ctx = makeCtx(world);
  const clientId = pc.nic.mac;
  // The client starts from scratch: while it asks, it has no address (and does not answer the server's test pings).
  delete pc.nic.address;
  delete pc.nic.mask;
  delete pc.nic.gateway;
  delete pc.nic.dns;
  delete pc.nic.dhcpServer;
  stepOf(pcId, 'origin', 'ok', `${pc.label} has no address yet, so it broadcasts a DHCP request on its link.`, 'UDP 0.0.0.0:68 → 255.255.255.255:67 (DHCP discover)', 'Ethernet0');

  const listeners = l2Reach(world, pcId, 'Ethernet0').filter((ep) => {
    const d = world.devices[ep.deviceId];
    return isIosDevice(d) && !!d.config.interfaces[ep.ifName]?.ip && isUp(world, ep.deviceId, ep.ifName);
  });
  if (listeners.length === 0) {
    const others = l2Reach(world, pcId, 'Ethernet0');
    const routerNoIp = others.find((ep) => isIosDevice(world.devices[ep.deviceId]) && world.devices[ep.deviceId].kind === 'router');
    const hint = routerNoIp
      ? `${label(world, routerNoIp.deviceId)} ${routerNoIp.ifName} is on the link but has no IP address.`
      : 'A broadcast does not cross a router, so a DHCP server or a relay (ip helper-address) must be on this link.';
    return giveUp(`No DHCP server answered: no router interface with an IP address is active on the link of ${pc.label}.`, hint);
  }

  const declined = new Set<string>();
  let failures: string[] = [];

  const allocate = (server: IosDevice, pool: DhcpPool, serverAddr: string): Offer | null => {
    const net = pool.network!;
    const range = hostRange(net.address, net.mask);
    const rt = server.runtime;
    const poolLine = `ip dhcp pool ${pool.name}: network ${net.address} ${net.mask}${pool.defaultRouters.length ? `, default-router ${pool.defaultRouters[0]}` : ''}`;
    const offer = (address: string): Offer => ({
      address, mask: net.mask, gateway: pool.defaultRouters[0], dns: pool.dnsServers[0], server: serverAddr, serverId: server.id, pool: pool.name,
    });
    // Same client, same address — as long as the lease still fits the configuration.
    const old = rt.dhcpBindings.find((b) => b.clientId === clientId && b.pool === pool.name);
    if (old) {
      if (inSubnet(old.address, net.address, net.mask) && !isExcluded(server, old.address) && !declined.has(old.address)) {
        old.grantedTick = world.tick;
        stepOf(server.id, 'local', 'ok', `${server.label} already has a lease for ${pc.label}, so it offers the same address ${old.address} again.`, poolLine);
        return offer(old.address);
      }
      rt.dhcpBindings = rt.dhcpBindings.filter((b) => b !== old);
    }
    if (range.count === 0) {
      failures.push(`Pool ${pool.name} on ${server.label} (${subnetText(net.address, net.mask)}) has no usable host addresses.`);
      return null;
    }
    const toldExcluded = new Set<string>();
    const first = ipToInt(range.first);
    const last = ipToInt(range.last);
    for (let n = first; n <= last; n++) {
      const addr = intToIp(n);
      const ex = isExcluded(server, addr);
      if (ex) {
        const key = `${ex.low}-${ex.high}`;
        if (!toldExcluded.has(key)) {
          toldExcluded.add(key);
          stepOf(server.id, 'local', 'info',
            ex.low === ex.high ? `${server.label} never hands out ${ex.low}: it is excluded.` : `${server.label} never hands out ${ex.low} to ${ex.high}: these addresses are excluded.`,
            `ip dhcp excluded-address ${ex.low}${ex.high !== ex.low ? ' ' + ex.high : ''}`);
        }
        n = Math.min(last, ipToInt(ex.high)); // jump to the end of the excluded range
        continue;
      }
      if (declined.has(addr)) continue;
      if (rt.dhcpBindings.some((b) => b.address === addr)) continue;
      const ping = runFlow(ctx, { fromDeviceId: server.id, dst: addr, proto: 'icmp' });
      if (ping.ok) {
        const who = ping.forward.atDeviceId ? label(world, ping.forward.atDeviceId) : 'Something';
        stepOf(server.id, 'local', 'info', `${server.label} pings ${addr} before offering it: ${who} answers, so the address is in use and is skipped.`);
        continue;
      }
      stepOf(server.id, 'local', 'ok', `${server.label} pings ${addr} before offering it: nobody answers, so the address is free.`);
      rt.dhcpBindings.push({ address: addr, clientId, pool: pool.name, grantedTick: world.tick });
      stepOf(server.id, 'local', 'ok',
        `${server.label} offers ${addr} with mask ${net.mask}${pool.defaultRouters.length ? ` and default gateway ${pool.defaultRouters[0]}` : ''}, and records the lease.`, poolLine);
      return offer(addr);
    }
    failures.push(`Pool ${pool.name} on ${server.label} has no free address left.`);
    return null;
  };

  const dropBinding = (o: Offer) => {
    const s = world.devices[o.serverId];
    if (isIosDevice(s)) s.runtime.dhcpBindings = s.runtime.dhcpBindings.filter((b) => !(b.clientId === clientId && b.address === o.address));
  };

  const relay = (router: IosDevice, ifName: string, giaddr: string, mask: string, helper: string): Offer | null => {
    stepOf(router.id, 'route', 'ok',
      `${router.label} has no DHCP pool for this network, but "ip helper-address ${helper}" on ${ifName} makes it forward the request to ${helper} as a normal packet from ${giaddr}.`,
      `interface ${ifName}: ip helper-address ${helper}`, ifName);
    const req: SimPacket = { src: giaddr, dst: helper, proto: 'udp', sport: 67, dport: 67, ttl: 255, bytes: 328, app: { kind: 'dhcp', op: 'discover', clientId, giaddr } };
    const out = ctx.walk(router.id, req);
    steps.push(...out.delivery.steps);
    if (!out.delivery.ok) {
      const result = out.delivery.reason === 'service-denied' ? 'gets no DHCP response' : 'it does not arrive';
      failures.push(`${router.label} forwards the request to ${helper} (ip helper-address on ${ifName}), but ${result}: ${out.delivery.reasonText ?? 'the packet is lost.'}`);
      return null;
    }
    const server = world.devices[out.delivery.atDeviceId ?? ''];
    if (!isIosDevice(server) || server.config.dhcp.pools.length === 0) {
      failures.push(`${router.label} forwards the request to ${helper}, which is ${label(world, out.delivery.atDeviceId ?? helper)}. That device is not a DHCP server (it has no "ip dhcp pool").`);
      return null;
    }
    const pool = selectPool(server, giaddr);
    if (!pool) {
      failures.push(`${server.label} receives the relayed request but has no DHCP pool for ${subnetText(giaddr, mask)}, the network of the relay address ${giaddr}.`);
      stepOf(server.id, 'local', 'drop', `${server.label} has no DHCP pool for the network of the relay address ${giaddr}.`);
      return null;
    }
    stepOf(server.id, 'local', 'ok',
      `${server.label} receives the relayed request; the relay address ${giaddr} selects pool ${pool.name} (${subnetText(pool.network!.address, pool.network!.mask)}).`);
    const serverAddr = out.delivery.received?.dst ?? helper;
    const o = allocate(server, pool, serverAddr);
    if (!o) return null;
    const reply: SimPacket = {
      src: serverAddr, dst: giaddr, proto: 'udp', sport: 67, dport: 67, ttl: 255, bytes: 328,
      app: { kind: 'dhcp', op: 'offer', clientId, giaddr, yiaddr: o.address, mask: o.mask, gateway: o.gateway, dns: o.dns, server: serverAddr },
    };
    const back = ctx.walk(server.id, reply);
    steps.push(...back.delivery.steps);
    if (!back.delivery.ok || back.delivery.atDeviceId !== router.id) {
      failures.push(`${server.label} offers ${o.address}, but its answer to the relay address ${giaddr} is lost: ${back.delivery.reasonText ?? `it ends up at ${label(world, back.delivery.atDeviceId ?? '?')}.`}`);
      dropBinding(o);
      return null;
    }
    stepOf(router.id, 'egress', 'ok', `${router.label} passes the offer on to ${pc.label} through ${ifName}.`, undefined, ifName);
    return o;
  };

  const tryListener = (routerId: string, ifName: string): Offer | null => {
    const router = world.devices[routerId];
    if (!isIosDevice(router)) return null;
    const ifc = router.config.interfaces[ifName];
    if (!ifc?.ip) return null;
    stepOf(router.id, 'ingress', 'ok', `${router.label} hears the request on ${ifName} (${ifc.ip.address}).`, undefined, ifName);
    if (ifc.aclIn) {
      const acl = router.config.acls[ifc.aclIn];
      const r = aclEvaluate(acl, { src: '0.0.0.0', dst: '255.255.255.255', proto: 'udp', sport: 68, dport: 67, ttl: 128, bytes: 328 });
      countHit(router.runtime, ifc.aclIn, r.ace);
      if (!r.permit) {
        const text = `${router.label} drops the DHCP request: access list ${ifc.aclIn}, applied inbound on ${ifName}, does not permit it (UDP from 0.0.0.0 port 68 to 255.255.255.255 port 67).`;
        stepOf(router.id, 'acl-in', 'drop', text, aclEvidence(ifc.aclIn, acl, r), ifName);
        failures.push(text);
        return null;
      }
    }
    if (!dhcpServiceEnabled(router)) {
      const text = `${router.label} ignores the request: "no service dhcp" disables both its DHCP server and relay agent.`;
      stepOf(router.id, 'local', 'drop', text, 'Enter "service dhcp" to reenable both.', ifName);
      failures.push(text);
      return null;
    }
    const addrs = [ifc.ip, ...(ifc.secondary ?? [])];
    for (const a of addrs) {
      const pool = selectPool(router, a.address);
      if (!pool) continue;
      stepOf(router.id, 'local', 'ok', `${router.label} is a DHCP server for this network: pool ${pool.name} covers ${subnetText(pool.network!.address, pool.network!.mask)}.`);
      return allocate(router, pool, a.address);
    }
    const helpers = ifc.helperAddresses ?? [];
    if (helpers.length > 0) {
      for (const h of helpers) {
        const o = relay(router, ifName, ifc.ip.address, ifc.ip.mask, h);
        if (o) return o;
      }
      return null;
    }
    const elsewhere = Object.values(router.config.interfaces).find((c) => c.name !== ifName && (c.helperAddresses?.length ?? 0) > 0);
    const hint = elsewhere
      ? ` ("ip helper-address ${elsewhere.helperAddresses![0]}" is configured on ${elsewhere.name}, but the request arrives on ${ifName}. The helper must be on the interface that hears the broadcast.)`
      : '';
    failures.push(`${router.label} hears the request on ${ifName} but has no pool for ${subnetText(ifc.ip.address, ifc.ip.mask)} and no ip helper-address there.${hint}`);
    stepOf(router.id, 'local', 'drop', `${router.label} ignores the request: it has no DHCP pool for ${subnetText(ifc.ip.address, ifc.ip.mask)} and no "ip helper-address" on ${ifName}.`, undefined, ifName);
    return null;
  };

  for (let attempt = 0; attempt < 8; attempt++) {
    failures = [];
    let offer: Offer | null = null;
    for (const ep of listeners) {
      offer = tryListener(ep.deviceId, ep.ifName);
      if (offer) break;
    }
    if (!offer) break;
    // The client checks that nobody on its link already uses the offered address (ARP probe).
    const offered = offer.address;
    const clash = l2Reach(world, pcId, 'Ethernet0').find((e) => answersFor(world, e.deviceId, e.ifName, offered) && isUp(world, e.deviceId, e.ifName));
    if (clash) {
      stepOf(pcId, 'deliver', 'info',
        `${pc.label} finds that ${label(world, clash.deviceId)} ${clash.ifName} already uses the offered address ${offered}, so it declines the offer and asks again.`);
      declined.add(offered);
      dropBinding(offer);
      continue;
    }
    pc.nic.address = offer.address;
    pc.nic.mask = offer.mask;
    if (offer.gateway) pc.nic.gateway = offer.gateway;
    if (offer.dns) pc.nic.dns = offer.dns;
    pc.nic.dhcpServer = offer.server;
    stepOf(pcId, 'deliver', 'ok',
      `${pc.label} accepts the offer and now has ${offer.address}/${maskToPrefix(offer.mask)}${offer.gateway ? `, default gateway ${offer.gateway}` : ' and no default gateway (the pool has no "default-router")'}.`,
      `DHCP server ${offer.server}, pool ${offer.pool}`, 'Ethernet0');
    flushLogs(ctx);
    return { ok: true, address: offer.address, mask: offer.mask, gateway: offer.gateway, server: offer.server, steps };
  }
  flushLogs(ctx);
  const why = failures.length ? failures.join(' ') : `every offer for ${pc.label} was for an address that is already in use.`;
  stepOf(pcId, 'drop', 'drop', `No DHCP server answered, so ${pc.label} has no address.`, why);
  return { ok: false, reasonText: `No DHCP server answered: ${why}`, steps };
}

/** Give the lease back: the server forgets the binding and the PC has no address any more. */
export function dhcpRelease(world: World, pcId: string): void {
  const pc = world.devices[pcId];
  if (!isPcDevice(pc)) return;
  releaseFor(world, pc);
}

function releaseFor(world: World, pc: PcDevice): void {
  for (const id of world.order) {
    const d = world.devices[id];
    if (isIosDevice(d)) d.runtime.dhcpBindings = d.runtime.dhcpBindings.filter((b) => b.clientId !== pc.nic.mac);
  }
  if (pc.nic.mode === 'dhcp') {
    delete pc.nic.address;
    delete pc.nic.mask;
    delete pc.nic.gateway;
    delete pc.nic.dns;
    delete pc.nic.dhcpServer;
  }
}
