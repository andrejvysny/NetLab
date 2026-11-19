/**
 * The packet pipeline (ARCHITECTURE §6.1). One packet is walked from the device that creates it, hop by hop, until it is
 * delivered or dropped. On every router the order is exactly:
 *   inbound ACL → IPsec decryption → NAT outside→inside → local delivery → routing → NAT inside→outside →
 *   crypto map → outbound ACL → QoS classification → transmit.
 * Every step adds one plain sentence to the trace, with the deciding evidence in `detail`.
 */
import type { Ace, Acl, Delivery, DropReason, Feature, IosDevice, PcDevice, TraceStage, TraceStep, World } from '../types.ts';
import { natRoleOn } from '../natProfile.ts';
import { inSubnet } from '../ip.ts';
import { aclEvaluate, aclEvidence, aceText, countHit } from './acl.ts';
import { clearTextViolation, cryptoOutbound, decrypt } from './ipsec.ts';
import type { Ctx, IfState, SimPacket, WalkResult, WalkState } from './model.ts';
import { addStep } from './model.ts';
import { natInsideToOutside, natOutsideMissingNote, natOutsideToInside, natRolesMissingNote } from './nat.ts';
import { interfaceState } from './physical.ts';
import { classifyOutput } from './qos.ts';
import { explainNoRoute, lookupIn, newRouteMemo, routeText, tableWith } from './routing.ts';
import type { LocalResult } from './services.ts';
import { icmpErrorFor, iosLocal, pcLocal } from './services.ts';
import type { L2Endpoint } from './switching.ts';
import { answersFor, explainUnresolved, l2Reach } from './switching.ts';
import { aPacket, describePacket, isIosDevice, isPcDevice, label, subnetText } from './text.ts';

/**
 * Real IOS does not apply an interface's outbound ACL to packets the router creates itself (its own pings, syslog, IKE …).
 * Set to true to filter them as well (the literal reading of ARCHITECTURE §6.1).
 */
export const OUTBOUND_ACL_FILTERS_LOCAL_PACKETS = false;

const MAX_VISITS = 2000;

export function makeCtx(world: World): Ctx {
  const ctx: Ctx = {
    world,
    routes: newRouteMemo(),
    ifStates: new Map(),
    reach: new Map(),
    logs: [],
    depth: 0,
    walk: (fromDeviceId, packet) => walk(ctx, fromDeviceId, packet),
    fork: (w) => makeCtx(w),
  };
  return ctx;
}

/** interfaceState with a per-call memo. */
function stateOf(ctx: Ctx, deviceId: string, ifName: string): IfState {
  const key = `${deviceId}|${ifName}`;
  let s = ctx.ifStates.get(key);
  if (!s) { s = interfaceState(ctx.world, deviceId, ifName); ctx.ifStates.set(key, s); }
  return s;
}
function upOf(ctx: Ctx, deviceId: string, ifName: string): boolean {
  const s = stateOf(ctx, deviceId, ifName);
  return s.status === 'up' && s.protocol === 'up';
}
/** l2Reach with a per-call memo. */
function reachOf(ctx: Ctx, deviceId: string, ifName: string): L2Endpoint[] {
  const key = `${deviceId}|${ifName}`;
  let r = ctx.reach.get(key);
  if (!r) { r = l2Reach(ctx.world, deviceId, ifName); ctx.reach.set(key, r); }
  return r;
}
/** The neighbour on the link of `ifName` that answers for `ip` (addresses are read fresh: a DHCP client may just have got one). */
function neighbourOf(ctx: Ctx, deviceId: string, ifName: string, ip: string): L2Endpoint | null {
  for (const ep of reachOf(ctx, deviceId, ifName)) {
    if (answersFor(ctx.world, ep.deviceId, ep.ifName, ip) && upOf(ctx, ep.deviceId, ep.ifName)) return ep;
  }
  return null;
}

type Next =
  | { kind: 'forward'; deviceId: string; ifName: string; packet: SimPacket }
  | { kind: 'end'; result: WalkResult };

interface StepInit { stage: TraceStage; feature: Feature; iface?: string; detail?: string; header?: string }

/**
 * End the walk with a drop. `text` is the one-sentence step text; `extra.more` is the longer explanation: it goes into
 * the step's `detail` and is appended to `reasonText`. `step` = null when the caller already recorded the deciding step.
 */
function fail(
  st: WalkState, deviceId: string, reason: DropReason, text: string, step: StepInit | null,
  extra: { icmpError?: SimPacket; arrivedIface?: string; more?: string } = {},
): Next {
  const d = st.delivery;
  d.ok = false;
  d.reason = reason;
  d.reasonText = extra.more ? `${text} ${extra.more}` : text;
  d.atDeviceId = deviceId;
  if (step) {
    const detail = [step.detail, extra.more].filter((x) => !!x).join(' — ') || undefined;
    addStep(st, { deviceId, verdict: 'drop', text, ...step, detail });
  }
  return { kind: 'end', result: { delivery: d, arrivedIface: extra.arrivedIface, icmpError: extra.icmpError, responder: deviceId } };
}

function finishLocal(st: WalkState, deviceId: string, ingress: string | undefined, p: SimPacket, r: LocalResult): Next {
  const d = st.delivery;
  d.ok = r.ok;
  d.atDeviceId = deviceId;
  d.received = p;
  if (!r.ok) { d.reason = r.reason; d.reasonText = r.reasonText; }
  return { kind: 'end', result: { delivery: d, arrivedIface: ingress, reply: r.reply, icmpError: r.icmpError, responder: deviceId, vty: r.vty } };
}

/** Walk one packet from the device that creates it to wherever it ends. */
export function walk(ctx: Ctx, fromDeviceId: string, packet: SimPacket): WalkResult {
  const delivery: Delivery = { ok: false, steps: [], encrypted: false, qos: [] };
  const st: WalkState = { delivery, quiet: false };
  const world = ctx.world;
  ctx.depth += 1;
  try {
    let deviceId = fromDeviceId;
    let ingress: string | undefined;
    let p: SimPacket = { ...packet };
    const seen = new Set<string>();
    const loopDevices: string[] = [];
    let looping = false;
    for (let visit = 0; visit < MAX_VISITS; visit++) {
      const dev = world.devices[deviceId];
      if (!dev) {
        return (fail(st, deviceId, 'no-link', `There is no device ${deviceId}.`, { stage: 'drop', feature: 'cabling' }) as { kind: 'end'; result: WalkResult }).result;
      }
      if (ingress !== undefined) {
        const key = `${deviceId}|${ingress}|${p.proto}|${p.src}|${p.dst}|${p.sport ?? ''}|${p.dport ?? ''}|${p.inner ? `${p.inner.src}>${p.inner.dst}` : ''}`;
        if (seen.has(key) && !looping) {
          looping = true;
          addStep(st, {
            deviceId, stage: 'route', feature: 'routing', verdict: 'info', iface: ingress, header: describePacket(p),
            text: `The packet is back at ${dev.label}, where it has already been: the routers keep sending it to each other (a routing loop).`,
          });
          st.quiet = true;
        }
        seen.add(key);
        if (looping && !loopDevices.includes(dev.label)) loopDevices.push(dev.label);
      }
      const next: Next = isPcDevice(dev) ? pcNode(ctx, st, dev, ingress, p) : isIosDevice(dev) ? iosNode(ctx, st, dev, ingress, p) : fail(st, deviceId, 'no-link', 'Unknown device.', null);
      if (next.kind === 'end') {
        if (looping) {
          st.quiet = false;
          if (delivery.reason === 'ttl-expired') {
            const where = label(world, delivery.atDeviceId ?? deviceId);
            const who = loopDevices.length > 1
              ? `${loopDevices.slice(0, -1).join(', ')} and ${loopDevices.at(-1)} keep sending the packet to each other`
              : `${loopDevices[0] ?? where} keeps sending the packet round in a circle`;
            const text = `Routing loop: ${who} until its TTL reaches 0 and ${where} discards it.`;
            const more = 'Check the routes: for example two default routes that point at each other.';
            delivery.reasonText = `${text} ${more}`;
            addStep(st, { deviceId: delivery.atDeviceId ?? deviceId, stage: 'drop', feature: 'routing', verdict: 'drop', text, detail: more, header: describePacket(p) });
          } else if (!delivery.ok) {
            // the loop ended for another reason: show that final step (it was not recorded while the trace was shortened)
            addStep(st, { deviceId: delivery.atDeviceId ?? deviceId, stage: 'drop', feature: 'routing', verdict: 'drop', text: delivery.reasonText ?? 'The packet is dropped.', header: describePacket(p) });
          }
        }
        return next.result;
      }
      deviceId = next.deviceId;
      ingress = next.ifName;
      p = next.packet;
    }
    st.quiet = false;
    const text = 'The packet travelled through far too many devices without arriving. There is a forwarding loop in the network.';
    return (fail(st, deviceId, 'loop', text, { stage: 'drop', feature: 'routing' }) as { kind: 'end'; result: WalkResult }).result;
  } finally {
    ctx.depth -= 1;
  }
}

// ───────────────────────────── transmit ─────────────────────────────
function countIf(dev: IosDevice, ifName: string, dir: 'in' | 'out'): void {
  const c = dev.runtime.ifCounters[ifName] ?? { in: 0, out: 0 };
  c[dir] += 1;
  dev.runtime.ifCounters[ifName] = c;
}

/** Proxy ARP: another router on the link that has a route to `dst` through a different interface answers for it. */
function proxyArp(ctx: Ctx, dev: IosDevice | PcDevice, ifName: string, dst: string): L2Endpoint | null {
  for (const ep of reachOf(ctx, dev.id, ifName)) {
    const other = ctx.world.devices[ep.deviceId];
    if (!isIosDevice(other) || !other.config.ipRouting) continue;
    const r = lookupIn(tableWith(ctx.world, other.id, ctx.routes), dst);
    if (r && r.resolved.iface !== ep.ifName && r.resolved.iface !== 'Null0') return ep;
  }
  return null;
}

/**
 * Put the packet on the wire of `ifName`. `target` is the address of the neighbour that must take it
 * (next hop / default gateway); undefined = the destination itself is on this link.
 */
function transmit(
  ctx: Ctx, st: WalkState, dev: IosDevice | PcDevice, ifName: string, p: SimPacket, target: string | undefined,
  o: { allowProxy?: boolean; targetWord?: string } = {},
): Next {
  const world = ctx.world;
  const hdr = describePacket(p);
  if (ifName === 'Null0') {
    return fail(st, dev.id, 'no-route', `${dev.label} routes ${p.dst} to Null0, which throws the packet away on purpose.`, { stage: 'route', feature: 'routing', header: hdr });
  }
  if (ifName.startsWith('Loopback')) {
    return fail(st, dev.id, 'host-unreachable', `${p.dst} lies in the network of ${ifName} on ${dev.label}, but nobody owns that address: a loopback has no other devices on it.`, { stage: 'egress', feature: 'routing', iface: ifName, header: hdr });
  }
  const state = stateOf(ctx, dev.id, ifName);
  if (!(state.status === 'up' && state.protocol === 'up')) {
    return fail(st, dev.id, 'no-link', `${dev.label} cannot send on ${ifName}: the interface is ${state.status}/${state.protocol}.`, { stage: 'link', feature: 'cabling', iface: ifName, header: hdr }, { more: state.problem });
  }
  const spec = dev.ports.find((x) => x.name === ifName);
  const serial = spec?.kind === 'serial';
  let ep: L2Endpoint | null;
  const want = target ?? p.dst;
  if (serial) {
    ep = reachOf(ctx, dev.id, ifName)[0] ?? null;
    if (!ep) {
      return fail(st, dev.id, 'no-link', `${dev.label} cannot send on ${ifName}: nothing is reachable at the other end of the serial cable.`, { stage: 'link', feature: 'cabling', iface: ifName, header: hdr });
    }
  } else {
    ep = neighbourOf(ctx, dev.id, ifName, want);
    if (!ep && o.allowProxy) ep = proxyArp(ctx, dev, ifName, p.dst);
    if (!ep) {
      const why = explainUnresolved(world, dev.id, ifName, want);
      const text = want === p.dst
        ? `${dev.label} cannot find ${p.dst} on the link of ${ifName}: nobody answers the ARP request.`
        : `${dev.label} cannot reach ${o.targetWord ?? 'the next hop'} ${want} on ${ifName}: nobody answers the ARP request.`;
      return fail(st, dev.id, 'host-unreachable', text, { stage: 'link', feature: isPcDevice(dev) ? 'pc' : 'routing', iface: ifName, header: hdr }, { more: why });
    }
  }
  if (isIosDevice(dev)) countIf(dev, ifName, 'out');
  if (p.proto === 'esp' && !p.espProbe) st.delivery.encrypted = true;
  const peerName = `${label(world, ep.deviceId)} ${ep.ifName}`;
  if (isIosDevice(dev)) {
    addStep(st, {
      deviceId: dev.id, stage: 'egress', feature: 'interface', verdict: 'ok', iface: ifName, header: hdr,
      text: serial
        ? `${dev.label} sends the packet out of ${ifName}, over the serial link to ${peerName}.`
        : `${dev.label} sends the packet out of ${ifName} to ${peerName}${want !== p.dst ? ` (next hop ${want})` : ''}.`,
    });
  }
  for (const hop of ep.hops) {
    const sw = world.devices[hop.switchId];
    if (isIosDevice(sw)) {
      if (sw.config.interfaces[hop.inPort] && !hop.inPort.startsWith('Vlan')) countIf(sw, hop.inPort, 'in');
      countIf(sw, hop.outPort, 'out');
    }
    addStep(st, {
      deviceId: hop.switchId, stage: 'switch', feature: 'switching', verdict: 'ok', iface: hop.outPort, header: hdr,
      text: hop.inPort.startsWith('Vlan')
        ? `Switch ${label(world, hop.switchId)} sends the frame out of ${hop.outPort} (VLAN ${hop.vlan}).`
        : `Switch ${label(world, hop.switchId)} passes the frame from ${hop.inPort} to ${hop.outPort} (VLAN ${hop.vlan}).`,
    });
  }
  return { kind: 'forward', deviceId: ep.deviceId, ifName: ep.ifName, packet: p };
}

// ───────────────────────────── PC ─────────────────────────────
function pcNode(ctx: Ctx, st: WalkState, pc: PcDevice, ingress: string | undefined, p: SimPacket): Next {
  const world = ctx.world;
  const hdr = describePacket(p);
  const nic = pc.nic;
  if (ingress !== undefined) {
    if (!nic.address || p.dst !== nic.address) {
      return fail(st, pc.id, 'no-route', `${pc.label} received a packet for ${p.dst}, which is not its own address. A PC is not a router: it does not pass packets on.`, { stage: 'deliver', feature: 'pc', iface: ingress, header: hdr }, { arrivedIface: ingress });
    }
    return finishLocal(st, pc.id, ingress, p, pcLocal(ctx, st, pc, p));
  }
  // The PC creates the packet.
  if (!nic.address || !nic.mask) {
    const text = nic.mode === 'dhcp'
      ? `${pc.label} has no IP address yet: it did not get one from a DHCP server.`
      : `${pc.label} has no IP address: configure its network adapter first.`;
    return fail(st, pc.id, 'no-ip', text, { stage: 'origin', feature: 'pc', header: hdr });
  }
  const what = aPacket(p);
  if (p.dst === nic.address || p.dst.startsWith('127.')) {
    addStep(st, { deviceId: pc.id, stage: 'origin', feature: 'pc', verdict: 'ok', header: hdr, text: `${pc.label} sends ${what} to its own address ${p.dst}, so the packet never leaves the PC.` });
    return finishLocal(st, pc.id, undefined, p, pcLocal(ctx, st, pc, p));
  }
  const own = subnetText(nic.address, nic.mask);
  const onLink = inSubnet(p.dst, nic.address, nic.mask);
  if (!onLink) {
    if (!nic.gateway) {
      return fail(st, pc.id, 'no-gateway', `${p.dst} is outside ${pc.label}'s own network ${own}, and ${pc.label} has no default gateway to send the packet to.`, { stage: 'origin', feature: 'pc', header: hdr });
    }
    if (!inSubnet(nic.gateway, nic.address, nic.mask) || nic.gateway === nic.address) {
      return fail(st, pc.id, 'no-gateway', `The default gateway ${nic.gateway} of ${pc.label} is not a neighbour in its own network ${own}, so ${pc.label} cannot use it.`, { stage: 'origin', feature: 'pc', header: hdr });
    }
  }
  addStep(st, {
    deviceId: pc.id, stage: 'origin', feature: 'pc', verdict: 'ok', iface: 'Ethernet0', header: hdr,
    text: `${pc.label} sends ${what} to ${p.dst}.`,
    detail: onLink
      ? `${p.dst} is inside ${pc.label}'s own network ${own}, so the packet goes straight to that address.`
      : `${p.dst} is outside ${pc.label}'s own network ${own}, so the packet goes to the default gateway ${nic.gateway}.`,
  });
  return transmit(ctx, st, pc, 'Ethernet0', p, onLink ? undefined : nic.gateway, { targetWord: 'its default gateway' });
}

// ───────────────────────────── router / switch ─────────────────────────────
/** An entry with the `log` keyword matched: IOS writes %SEC-6-IPACCESSLOG… (sent to the logging hosts after the flow). */
function logAclMatch(ctx: Ctx, dev: IosDevice, aclId: string, acl: Acl | undefined, r: { ace?: Ace; permit: boolean }, p: SimPacket): void {
  if (!acl || !r.ace?.log) return;
  const verb = r.permit ? 'permitted' : 'denied';
  let mnemonic: string;
  let text: string;
  if (acl.type === 'standard') {
    mnemonic = 'SEC-6-IPACCESSLOGS';
    text = `list ${aclId} ${verb} ${p.src} 1 packet`;
  } else if (p.proto === 'tcp' || p.proto === 'udp') {
    mnemonic = 'SEC-6-IPACCESSLOGP';
    text = `list ${aclId} ${verb} ${p.proto} ${p.src}(${p.sport ?? 0}) -> ${p.dst}(${p.dport ?? 0}), 1 packet`;
  } else if (p.proto === 'icmp') {
    const type = p.icmpType === 'echo-reply' ? '0/0' : p.icmpType === 'time-exceeded' ? '11/0' : p.icmpType === 'admin-prohibited' ? '3/13' : p.icmpType === 'unreachable' ? '3/1' : '8/0';
    mnemonic = 'SEC-6-IPACCESSLOGDP';
    text = `list ${aclId} ${verb} icmp ${p.src} -> ${p.dst} (${type}), 1 packet`;
  } else {
    mnemonic = 'SEC-6-IPACCESSLOGNP';
    text = `list ${aclId} ${verb} ${p.proto === 'esp' ? 50 : 0} ${p.src} -> ${p.dst}, 1 packet`;
  }
  ctx.logs.push({ deviceId: dev.id, severity: 6, mnemonic, text });
}

function ownsUp(ctx: Ctx, dev: IosDevice, ip: string): boolean {
  for (const [name, c] of Object.entries(dev.config.interfaces)) {
    if ((c.ip?.address === ip || c.secondary?.some((s) => s.address === ip)) && upOf(ctx, dev.id, name)) return true;
  }
  return false;
}

function firstUpAddress(ctx: Ctx, dev: IosDevice): string | undefined {
  for (const [name, c] of Object.entries(dev.config.interfaces)) {
    if (c.ip && upOf(ctx, dev.id, name)) return c.ip.address;
  }
  return undefined;
}

function iosNode(ctx: Ctx, st: WalkState, dev: IosDevice, ingress: string | undefined, pkt: SimPacket): Next {
  const world = ctx.world;
  const cfg = dev.config;
  const rt = dev.runtime;
  const originated = ingress === undefined;
  const inIf = ingress !== undefined ? cfg.interfaces[ingress] : undefined;
  let p = pkt;
  const step = (s: Omit<TraceStep, 'deviceId'>) => addStep(st, { deviceId: dev.id, ...s });
  const errSrc = (): string => inIf?.ip?.address ?? firstUpAddress(ctx, dev) ?? '0.0.0.0';
  const mayAnswer = !inIf?.noIpUnreachables;
  const noUnreachNote = inIf?.noIpUnreachables ? `"no ip unreachables" is set on ${ingress}, so ${dev.label} does not tell the sender.` : undefined;

  if (!originated && ingress !== undefined) {
    countIf(dev, ingress, 'in');
    step({ stage: 'ingress', feature: 'interface', verdict: 'ok', iface: ingress, header: describePacket(p), text: `${dev.label} receives the packet on ${ingress}.` });

    // 1. inbound ACL — the packet exactly as it arrives (an ESP packet is checked as ESP)
    if (inIf?.aclIn) {
      const acl = cfg.acls[inIf.aclIn];
      const r = aclEvaluate(acl, p);
      countHit(rt, inIf.aclIn, r.ace);
      logAclMatch(ctx, dev, inIf.aclIn, acl, r, p);
      const evidence = aclEvidence(inIf.aclIn, acl, r);
      if (!r.permit) {
        const text = `${dev.label} drops the packet: access list ${inIf.aclIn}, applied inbound on ${ingress}, ${r.implicit ? 'has no entry that permits it, so the implicit deny at the end applies' : 'denies it'}.`;
        return fail(st, dev.id, 'acl-in', text, { stage: 'acl-in', feature: 'acl', iface: ingress, detail: evidence, header: describePacket(p) },
          { arrivedIface: ingress, more: noUnreachNote, icmpError: mayAnswer ? icmpErrorFor(errSrc(), p, 'admin-prohibited', 'admin') : undefined });
      }
      step({
        stage: 'acl-in', feature: 'acl', verdict: r.implicit ? 'info' : 'ok', iface: ingress, detail: evidence, header: describePacket(p),
        text: r.implicit
          ? `Access list ${inIf.aclIn} is applied inbound on ${ingress}, but it filters nothing${acl ? ' (it has no entries)' : ' (it is not defined)'}.`
          : `The inbound access list ${inIf.aclIn} on ${ingress} permits the packet.`,
      });
    }

    // 2. IPsec: decrypt ESP addressed to this router; otherwise check that nothing that should be encrypted arrives in clear
    if (p.proto === 'esp' && ownsUp(ctx, dev, p.dst)) {
      if (p.espProbe) return finishLocal(st, dev.id, ingress, p, { ok: true });
      const d = decrypt(st, dev, ingress, p);
      if (!d.ok) return fail(st, dev.id, 'ipsec-no-sa', d.text, null, { arrivedIface: ingress });
      p = d.packet;
    } else if (inIf?.cryptoMap) {
      const v = clearTextViolation(dev, ingress, p);
      if (v) {
        const text = `${dev.label} drops the packet: it arrived on ${ingress} without encryption, but crypto map ${v.mapName} says this kind of traffic must come through the IPsec tunnel.`;
        ctx.logs.push({ deviceId: dev.id, severity: 4, mnemonic: 'CRYPTO-4-RECVD_PKT_NOT_IPSEC', text: `Rec'd packet not an IPSEC packet. (ip) vrf/dest_addr= /${p.dst}, src_addr= ${p.src}, prot= ${p.proto === 'icmp' ? 1 : p.proto === 'tcp' ? 6 : 17}` });
        return fail(st, dev.id, 'ipsec-expected', text, {
          stage: 'decrypt', feature: 'ipsec', iface: ingress, header: describePacket(p),
          detail: `crypto map ${v.mapName} ${v.entry.seq}: access list ${v.aclId} entry ${v.ace.seq} "${aceText(v.ace)}" matches the packet with source and destination swapped (IOS logs %CRYPTO-4-RECVD_PKT_NOT_IPSEC)`,
        }, { arrivedIface: ingress, more: 'The sender did not encrypt it: check the crypto map and the crypto access list on the other router.' });
      }
    }

    // 3. NAT outside → inside
    const natRole = natRoleOn(dev, ingress);
    if (natRole === 'outside') p = natOutsideToInside(ctx, st, dev, ingress, p);
    else if (inIf && natRole === undefined) natOutsideMissingNote(st, dev, ingress, p);
  } else {
    step({ stage: 'origin', feature: 'interface', verdict: 'ok', header: describePacket(p), text: `${dev.label} sends ${aPacket(p)} from its address ${p.src} to ${p.dst}.` });
  }
  const afterIn = p;

  // 4. local delivery
  if (ownsUp(ctx, dev, p.dst)) {
    return finishLocal(st, dev.id, ingress, p, iosLocal(ctx, st, dev, ingress, p));
  }

  // 5. routing
  if (!originated) {
    if (!cfg.ipRouting) {
      const text = dev.kind === 'switch'
        ? `${dev.label} works as a layer-2 switch. It does not route packets between networks, so it cannot be used as a gateway.`
        : `${dev.label} does not forward packets: "no ip routing" is set.`;
      return fail(st, dev.id, 'no-route', text, { stage: 'route', feature: 'routing', iface: ingress, header: describePacket(p) }, { arrivedIface: ingress });
    }
  }
  const table = tableWith(world, dev.id, ctx.routes);
  const route = lookupIn(table, p.dst);
  if (!route) {
    return fail(st, dev.id, 'no-route', `${dev.label} has no route to ${p.dst}.`, { stage: 'route', feature: 'routing', header: describePacket(p) },
      {
        arrivedIface: ingress, more: [explainNoRoute(world, dev.id, p.dst), originated ? undefined : noUnreachNote].filter((x) => !!x).join(' '),
        icmpError: !originated && mayAnswer ? icmpErrorFor(errSrc(), p, 'unreachable', 'host') : undefined,
      });
  }
  if (!originated) {
    // Forwarding costs one hop of TTL.
    if (p.ttl <= 1) {
      const text = `The TTL of the packet reaches 0 at ${dev.label}, so ${dev.label} discards it.`;
      return fail(st, dev.id, 'ttl-expired', text, { stage: 'route', feature: 'routing', iface: ingress, header: describePacket(p) },
        { arrivedIface: ingress, icmpError: icmpErrorFor(errSrc(), p, 'time-exceeded') });
    }
    p = { ...p, ttl: p.ttl - 1 };
  }
  const egress = route.resolved.iface;
  const outIf = cfg.interfaces[egress];
  step({
    stage: 'route', feature: 'routing', verdict: 'ok', iface: egress, header: describePacket(p), detail: routeText(route),
    text: route.code === 'C'
      ? `${dev.label} is directly connected to the network of ${p.dst}, so the packet leaves through ${egress}.`
      : `${dev.label} routes the packet out of ${egress}${route.resolved.nextHop ? ` towards ${route.resolved.nextHop}` : ''}, using ${route.isDefault ? 'its default route' : `its route to ${route.prefix}/${route.prefixLen}`}.`,
  });
  if (egress === 'Null0' || !outIf) return transmit(ctx, st, dev, egress, p, route.resolved.nextHop);

  // 6. NAT inside → outside
  const locallyBuiltEsp = originated && p.proto === 'esp';
  const natFromInside = originated ? dev.kind === 'router' : natRoleOn(dev, ingress) === 'inside';
  if (natFromInside && natRoleOn(dev, egress) === 'outside' && !locallyBuiltEsp) {
    const r = natInsideToOutside(ctx, st, dev, egress, p, originated);
    if ('drop' in r) {
      return fail(st, dev.id, r.drop.reason, r.drop.text, null,
        { arrivedIface: ingress, icmpError: !originated && mayAnswer ? icmpErrorFor(errSrc(), afterIn, 'unreachable', 'host') : undefined });
    }
    p = r.packet;
  } else {
    natRolesMissingNote(st, dev, ingress, egress, p);
  }

  // 7. crypto map on the egress interface
  let classifyOn: SimPacket = p;
  let innerNote = '';
  let encryptedHere = false;
  if (outIf.cryptoMap) {
    const c = cryptoOutbound(ctx, st, dev, egress, p);
    if (c.kind === 'drop') return fail(st, dev.id, 'ipsec-negotiation-failed', c.text, null, { arrivedIface: ingress, more: c.why });
    if (c.kind === 'encrypted') {
      if (c.negotiated) st.delivery.negotiated = true;
      const inner = p;
      p = c.packet;
      encryptedHere = true;
      if (world.settings.qosClassifiesInnerHeader || c.entry.qosPreClassify) {
        classifyOn = inner;
        innerNote = c.entry.qosPreClassify && !world.settings.qosClassifiesInnerHeader
          ? 'classified on the original packet ("qos pre-classify" on the crypto map)'
          : 'classified on the original packet, not on the ESP wrapper (training profile)';
      } else {
        classifyOn = p;
        innerNote = 'classified on the ESP wrapper: the original header is hidden (no "qos pre-classify" on the crypto map)';
      }
    }
  }

  // 8. outbound ACL — the packet as it leaves (after NAT and encryption)
  if (outIf.aclOut) {
    const acl = cfg.acls[outIf.aclOut];
    if (originated && !OUTBOUND_ACL_FILTERS_LOCAL_PACKETS) {
      step({
        stage: 'acl-out', feature: 'acl', verdict: 'info', iface: egress, header: describePacket(p),
        text: `Access list ${outIf.aclOut} is applied outbound on ${egress}, but it is not checked here: IOS does not filter packets that the router creates itself.`,
      });
    } else {
      const r = aclEvaluate(acl, p);
      countHit(rt, outIf.aclOut, r.ace);
      logAclMatch(ctx, dev, outIf.aclOut, acl, r, p);
      const evidence = aclEvidence(outIf.aclOut, acl, r);
      if (!r.permit) {
        const text = `${dev.label} drops the packet: access list ${outIf.aclOut}, applied outbound on ${egress}, ${r.implicit ? 'has no entry that permits it, so the implicit deny at the end applies' : 'denies it'}.`;
        return fail(st, dev.id, 'acl-out', text, { stage: 'acl-out', feature: 'acl', iface: egress, detail: evidence, header: describePacket(p) },
          { arrivedIface: ingress, more: originated ? undefined : noUnreachNote, icmpError: !originated && mayAnswer ? icmpErrorFor(errSrc(), afterIn, 'admin-prohibited', 'admin') : undefined });
      }
      step({
        stage: 'acl-out', feature: 'acl', verdict: r.implicit ? 'info' : 'ok', iface: egress, detail: evidence, header: describePacket(p),
        text: r.implicit
          ? `Access list ${outIf.aclOut} is applied outbound on ${egress}, but it filters nothing${acl ? ' (it has no entries)' : ' (it is not defined)'}.`
          : `The outbound access list ${outIf.aclOut} on ${egress} permits the packet.`,
      });
    }
  }

  // 9. QoS classification
  if (outIf.servicePolicyOut) {
    const q = classifyOutput(dev, egress, classifyOn, true, p.bytes);
    if (q && 'problem' in q) {
      step({ stage: 'qos', feature: 'qos', verdict: 'info', iface: egress, header: describePacket(p), text: q.problem });
    } else if (q) {
      st.delivery.qos.push({ deviceId: dev.id, iface: egress, policy: q.policy, className: q.className, childPolicy: q.childPolicy, childClass: q.childClass });
      step({ stage: 'qos', feature: 'qos', verdict: 'ok', iface: egress, header: describePacket(p), text: q.text, detail: innerNote ? `${q.detail}; ${innerNote}` : q.detail });
    }
  }

  // 10. transmit. A tunnel-mode ESP packet is handed to the neighbour that leads to the tunnel peer.
  let target = route.resolved.nextHop;
  if (encryptedHere) {
    const toPeer = lookupIn(table, p.dst);
    if (toPeer && toPeer.resolved.iface === egress) target = toPeer.resolved.nextHop;
  }
  return transmit(ctx, st, dev, egress, p, target, { allowProxy: route.code === 'S' && !route.resolved.nextHop });
}
