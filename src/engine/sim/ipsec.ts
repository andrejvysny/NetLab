/**
 * IPsec with IKEv1 crypto maps (ARCHITECTURE §6.4): crypto ACL matching on the egress interface, negotiation
 * (ISAKMP policy, pre-shared key, peer, transform-set, mirrored crypto ACL), SA tables on both routers with
 * encaps/decaps counters, ESP encapsulation and decapsulation, and the "clear text where crypto was expected" check.
 *
 * Simplification (documented in the report): security associations never go stale. Before an SA is reused the
 * configuration conditions are checked again; if they no longer hold, the SA pair is deleted and renegotiated.
 */
import type {
  Ace, AclProtocol, AddrMatch, CryptoMapEntry, IosDevice, IpsecSa, IsakmpPolicy, Packet, PortMatch, Selector, World,
} from '../types.ts';
import { inSubnet, wildcardToMask } from '../ip.ts';
import { cloneWorld, nextId } from '../world.ts';
import { aceCoversMirror, aceText, aclEvaluate, aclEvidence, countHit, mirrorAceText, mirrorPacket } from './acl.ts';
import type { Ctx, SimPacket, WalkState } from './model.ts';
import { addStep } from './model.ts';
import { describePacket, isIosDevice, label } from './text.ts';

const PROTO_NUM: Record<string, number> = { ip: 0, icmp: 1, tcp: 6, udp: 17, gre: 47, esp: 50, ahp: 51, eigrp: 88, ospf: 89 };

/** IKE (UDP 500) and ESP packets are never matched against a crypto ACL. */
export function isIkeOrEsp(p: Packet): boolean {
  return p.proto === 'esp' || (p.proto === 'udp' && (p.sport === 500 || p.dport === 500));
}

function selector(a: AddrMatch, port: PortMatch | undefined, proto: AclProtocol): Selector {
  const protocol = typeof proto === 'number' ? proto : (PROTO_NUM[proto] ?? 0);
  const p = port && port.op === 'eq' && port.ports.length === 1 ? port.ports[0] : 0;
  switch (a.kind) {
    case 'any': return { address: '0.0.0.0', mask: '0.0.0.0', protocol, port: p };
    case 'host': return { address: a.address, mask: '255.255.255.255', protocol, port: p };
    case 'net': return { address: a.address, mask: wildcardToMask(a.wildcard), protocol, port: p };
  }
}
function sameSel(a: Selector, b: Selector): boolean {
  return a.address === b.address && a.mask === b.mask && a.protocol === b.protocol && a.port === b.port;
}

export interface CryptoMatch { mapName: string; entry: CryptoMapEntry; aclId: string; ace: Ace }

/** Why a crypto map entry cannot be used, or null when it is complete. */
function incomplete(dev: IosDevice, e: CryptoMapEntry): string | null {
  const missing: string[] = [];
  if (!e.matchAcl) missing.push('match address');
  else if (!dev.config.acls[e.matchAcl]) missing.push(`access list ${e.matchAcl} (not defined)`);
  if (e.peers.length === 0) missing.push('set peer');
  if (e.transformSets.length === 0) missing.push('set transform-set');
  else if (!e.transformSets.some((n) => dev.config.crypto.transformSets.some((t) => t.name === n))) {
    missing.push(`transform-set ${e.transformSets.join(', ')} (not defined)`);
  }
  return missing.length ? missing.join(', ') : null;
}

/** First crypto map entry (by sequence number) whose ACL permits the packet. `notes` collects incomplete entries. */
export function cryptoMatch(dev: IosDevice, mapName: string, p: Packet, notes?: string[]): CryptoMatch | null {
  const map = dev.config.crypto.maps.find((m) => m.name === mapName);
  if (!map) { notes?.push(`crypto map ${mapName} is applied to the interface but not defined`); return null; }
  const entries = [...map.entries].sort((a, b) => a.seq - b.seq);
  for (const e of entries) {
    const why = incomplete(dev, e);
    if (why) { notes?.push(`crypto map ${mapName} ${e.seq} is incomplete and ignored (missing: ${why})`); continue; }
    const acl = dev.config.acls[e.matchAcl!];
    const r = aclEvaluate(acl, p);
    if (r.permit && r.ace) return { mapName, entry: e, aclId: e.matchAcl!, ace: r.ace };
  }
  return null;
}

/**
 * A clear-text packet arrived on an interface with a crypto map. If its mirror image is permitted by the crypto ACL,
 * the peer should have encrypted it: the router drops it (%CRYPTO-4-RECVD_PKT_NOT_IPSEC).
 */
export function clearTextViolation(dev: IosDevice, ifName: string, p: Packet): CryptoMatch | null {
  const mapName = dev.config.interfaces[ifName]?.cryptoMap;
  if (!mapName || isIkeOrEsp(p)) return null;
  return cryptoMatch(dev, mapName, mirrorPacket(p));
}

// ───────────────────────────── negotiation ─────────────────────────────
function policyText(p: IsakmpPolicy): string {
  return `${p.priority} (${p.encryption}, ${p.hash}, ${p.authentication}, group ${p.group})`;
}
function keyFor(dev: IosDevice, addr: string): string | undefined {
  const keys = dev.config.crypto.isakmpKeys;
  const exact = keys.find((k) => k.address === addr && (!k.mask || k.mask === '255.255.255.255'));
  if (exact) return exact.key;
  const wide = keys.find((k) => (k.address === '0.0.0.0' && (!k.mask || k.mask === '0.0.0.0')) || (k.mask !== undefined && inSubnet(addr, k.address, k.mask)));
  return wide?.key;
}
function tsText(t: { name: string; transforms: string[]; mode: string }): string {
  return `${t.name} (${t.transforms.join(' ')}, ${t.mode})`;
}
function sameTransforms(a: string[], b: string[]): boolean {
  return a.length === b.length && [...a].sort().join(' ') === [...b].sort().join(' ');
}

interface Agreement {
  policy: IsakmpPolicy;
  peerPolicy: IsakmpPolicy;
  transform: { name: string; transforms: string[]; mode: 'tunnel' | 'transport' };
  peerMap: string;
  peerEntry: CryptoMapEntry;
  peerAclId: string;
  peerAce: Ace;
}
type AgreeResult = { ok: true; a: Agreement } | { ok: false; text: string; phase: 0 | 1 | 2 };

/** Initiator-side conditions that need no packet exchange. */
function initiatorReady(world: World, A: IosDevice, peer: string): string | null {
  const c = A.config.crypto;
  if (!c.isakmpEnabled) return `ISAKMP is switched off on ${A.label} ("no crypto isakmp enable"). Enter "crypto isakmp enable".`;
  if (c.isakmpPolicies.length === 0) return `${A.label} has no ISAKMP policy ("crypto isakmp policy …"), so it has nothing to offer to the peer.`;
  if (c.isakmpPolicies.some((p) => p.authentication === 'pre-share') && keyFor(A, peer) === undefined) {
    return `${A.label} has no pre-shared key for the peer ${peer}. Enter "crypto isakmp key <key> address ${peer}".`;
  }
  void world;
  return null;
}

/** All configuration conditions of §6.4 between initiator A (leaving ifA) and responder B (receiving on ifB). */
function agree(A: IosDevice, local: string, peer: string, entryA: CryptoMapEntry, aceA: Ace, B: IosDevice, ifB: string, packet: Packet): AgreeResult {
  const ca = A.config.crypto;
  const cb = B.config.crypto;
  if (!ca.isakmpEnabled) return { ok: false, phase: 0, text: `ISAKMP is switched off on ${A.label} ("no crypto isakmp enable").` };
  if (!cb.isakmpEnabled) return { ok: false, phase: 1, text: `ISAKMP is switched off on ${B.label} ("no crypto isakmp enable").` };
  if (ca.isakmpPolicies.length === 0) return { ok: false, phase: 0, text: `${A.label} has no ISAKMP policy ("crypto isakmp policy …").` };
  if (cb.isakmpPolicies.length === 0) return { ok: false, phase: 1, text: `${B.label} has no ISAKMP policy ("crypto isakmp policy …"), so the routers cannot agree on how to protect the negotiation.` };

  // Phase 1: a common policy
  let policy: IsakmpPolicy | undefined;
  let peerPolicy: IsakmpPolicy | undefined;
  for (const pa of [...ca.isakmpPolicies].sort((x, y) => x.priority - y.priority)) {
    const pb = [...cb.isakmpPolicies].sort((x, y) => x.priority - y.priority)
      .find((q) => q.encryption === pa.encryption && q.hash === pa.hash && q.authentication === pa.authentication && q.group === pa.group);
    if (pb) { policy = pa; peerPolicy = pb; break; }
  }
  if (!policy || !peerPolicy) {
    return {
      ok: false, phase: 1,
      text: `${A.label} and ${B.label} have no ISAKMP policy in common. ${A.label} offers policy ${ca.isakmpPolicies.map(policyText).join('; ')}. ${B.label} has policy ${cb.isakmpPolicies.map(policyText).join('; ')}. Encryption, hash, authentication and group must be the same in one policy on each side.`,
    };
  }
  if (policy.authentication !== 'pre-share') {
    return { ok: false, phase: 1, text: `ISAKMP policy ${policy.priority} uses authentication ${policy.authentication}. The simulator only supports pre-shared keys ("authentication pre-share").` };
  }
  const ka = keyFor(A, peer);
  const kb = keyFor(B, local);
  if (ka === undefined) return { ok: false, phase: 1, text: `${A.label} has no pre-shared key for the peer ${peer}. Enter "crypto isakmp key <key> address ${peer}".` };
  if (kb === undefined) return { ok: false, phase: 1, text: `${B.label} has no pre-shared key for ${local}, the address ${A.label} uses. Enter "crypto isakmp key <key> address ${local}" on ${B.label}.` };
  if (ka !== kb) {
    return { ok: false, phase: 1, text: `The pre-shared keys do not match for ${A.label} (${local}) and ${B.label} (${peer}). Both routers need exactly the same key (upper and lower case matter).` };
  }

  // Phase 2: crypto map on the receiving interface, peer, transform-set, mirrored ACL
  const mapName = B.config.interfaces[ifB]?.cryptoMap;
  if (!mapName) {
    return { ok: false, phase: 2, text: `${B.label} has no crypto map on ${ifB}, the interface where the packets from ${A.label} arrive. Apply it there ("crypto map <name>" on the interface).` };
  }
  const map = cb.maps.find((m) => m.name === mapName);
  if (!map) return { ok: false, phase: 2, text: `${B.label} ${ifB} refers to crypto map ${mapName}, which is not defined.` };
  const entries = [...map.entries].sort((x, y) => x.seq - y.seq);
  const forPeer = entries.filter((e) => e.peers.includes(local));
  if (forPeer.length === 0) {
    const have = entries.flatMap((e) => e.peers);
    return {
      ok: false, phase: 2,
      text: `Crypto map ${mapName} on ${B.label} has no entry with "set peer ${local}" (the address ${A.label} sends from).${have.length ? ` It has: set peer ${have.join(', ')}.` : ''}`,
    };
  }
  const mine = entryA.transformSets.map((n) => ca.transformSets.find((t) => t.name === n)).filter((t) => t !== undefined);
  let transformSeen = false;
  let lastTheirs: { name: string; transforms: string[]; mode: 'tunnel' | 'transport' }[] = [];
  let aclProblem = '';
  for (const eb of forPeer) {
    const why = incomplete(B, eb);
    if (why) { aclProblem = `Crypto map ${mapName} ${eb.seq} on ${B.label} is incomplete (missing: ${why}).`; continue; }
    const theirs = eb.transformSets.map((n) => cb.transformSets.find((t) => t.name === n)).filter((t) => t !== undefined);
    lastTheirs = theirs;
    let common: { name: string; transforms: string[]; mode: 'tunnel' | 'transport' } | undefined;
    for (const ta of mine) {
      if (theirs.some((tb) => sameTransforms(ta.transforms, tb.transforms) && ta.mode === tb.mode)) { common = ta; break; }
    }
    if (!common) continue;
    transformSeen = true;
    if (eb.pfsGroup !== undefined && eb.pfsGroup !== entryA.pfsGroup) {
      aclProblem = `${B.label} requires PFS group ${eb.pfsGroup} ("set pfs"), but ${A.label} ${entryA.pfsGroup !== undefined ? `uses group ${entryA.pfsGroup}` : 'does not use PFS'}.`;
      continue;
    }
    const aclB = B.config.acls[eb.matchAcl!];
    const decision = aclEvaluate(aclB, mirrorPacket(packet));
    if (decision.ace?.action === 'deny') {
      aclProblem = `The crypto access list ${eb.matchAcl} on ${B.label} denies the mirrored packet at entry ${decision.ace.seq} "${aceText(decision.ace)}" before it can match a permit.`;
      continue;
    }
    const peerAce = aclB?.entries.find((x) => aceCoversMirror(x, aceA));
    if (!peerAce) {
      const mirror = mirrorAceText(aceA);
      aclProblem = `The crypto access list ${eb.matchAcl} on ${B.label} has no entry that mirrors "${aceText(aceA)}" of ${A.label}. `
        + (mirror === aceText(aceA)
          ? `${B.label} needs the entry "${mirror}" in that list too.`
          : `${B.label} needs the same entry with source and destination swapped: "${mirror}".`);
      continue;
    }
    return { ok: true, a: { policy, peerPolicy, transform: common, peerMap: mapName, peerEntry: eb, peerAclId: eb.matchAcl!, peerAce } };
  }
  if (!transformSeen && !aclProblem) {
    return {
      ok: false, phase: 2,
      text: `${A.label} and ${B.label} have no transform-set in common. ${A.label} offers ${mine.map(tsText).join(', ') || 'nothing'}. ${B.label} accepts ${lastTheirs.map(tsText).join(', ') || 'nothing'}. The transforms and the mode must be the same.`,
    };
  }
  return { ok: false, phase: 2, text: aclProblem || `${A.label} and ${B.label} cannot agree on IPsec parameters.` };
}

function setIkeSa(world: World, dev: IosDevice, local: string, remote: string, state: 'QM_IDLE' | 'MM_NO_STATE'): void {
  const cur = dev.runtime.ikeSas.find((s) => s.local === local && s.remote === remote);
  if (cur) { cur.state = state; return; }
  dev.runtime.ikeSas.push({ id: nextId(world), local, remote, state, createdTick: world.tick });
}

function ikePacket(src: string, dst: string): SimPacket {
  return { src, dst, proto: 'udp', sport: 500, dport: 500, ttl: 255, bytes: 200, app: { kind: 'ike' } };
}

function newSpi(world: World): number {
  return ((nextId(world) * 2654435761) >>> 0) || 1;
}

function findCounterpart(world: World, sa: IpsecSa): { dev: IosDevice; sa: IpsecSa } | null {
  for (const id of world.order) {
    const d = world.devices[id];
    if (!isIosDevice(d)) continue;
    const other = d.runtime.ipsecSas.find((s) => s.spiIn === sa.spiOut && s.spiOut === sa.spiIn && s.localEndpoint === sa.remoteEndpoint && s.remoteEndpoint === sa.localEndpoint);
    if (other) return { dev: d, sa: other };
  }
  return null;
}

function dropSaPair(world: World, dev: IosDevice, sa: IpsecSa): void {
  const other = findCounterpart(world, sa);
  dev.runtime.ipsecSas = dev.runtime.ipsecSas.filter((s) => s !== sa);
  if (other) other.dev.runtime.ipsecSas = other.dev.runtime.ipsecSas.filter((s) => s !== other.sa);
}

type NegResult = { ok: true; sa: IpsecSa; detail: string } | { ok: false; text: string };

function negotiate(ctx: Ctx, A: IosDevice, ifA: string, m: CryptoMatch, local: string, peer: string, packet: Packet): NegResult {
  const world = ctx.world;
  const pre = initiatorReady(world, A, peer);
  if (pre) return { ok: false, text: pre };

  // IKE travels as ordinary UDP 500 packets through the network (ACLs on the way apply).
  const out = ctx.walk(A.id, ikePacket(local, peer));
  if (!out.delivery.ok) {
    return { ok: false, text: `${A.label} cannot reach the peer ${peer} to negotiate (IKE uses UDP port 500): ${out.delivery.reasonText ?? 'the packet was lost.'}` };
  }
  const B = world.devices[out.delivery.atDeviceId ?? ''];
  if (!isIosDevice(B) || B.id === A.id || !out.arrivedIface) {
    return { ok: false, text: `The peer address ${peer} does not belong to another router that can negotiate IPsec.` };
  }
  const res = agree(A, local, peer, m.entry, m.ace, B, out.arrivedIface, packet);
  if (!res.ok && res.phase !== 2) {
    if (res.phase === 1) { setIkeSa(world, A, local, peer, 'MM_NO_STATE'); setIkeSa(world, B, peer, local, 'MM_NO_STATE'); }
    return { ok: false, text: res.text };
  }
  const back = ctx.walk(B.id, ikePacket(peer, local));
  if (!back.delivery.ok || back.delivery.atDeviceId !== A.id) {
    setIkeSa(world, A, local, peer, 'MM_NO_STATE');
    return { ok: false, text: `The IKE answer from ${B.label} (${peer}) does not get back to ${A.label} (${local}): ${back.delivery.reasonText ?? 'the packet was lost.'}` };
  }
  // Phase 1 is complete: both routers hold an ISAKMP SA, whatever happens to the IPsec proposal.
  setIkeSa(world, A, local, peer, 'QM_IDLE');
  setIkeSa(world, B, peer, local, 'QM_IDLE');
  if (!res.ok) return { ok: false, text: res.text };

  // ESP must be able to pass in both directions. Tested on a copy so that no counter moves.
  const copy = cloneWorld(world);
  const sub = ctx.fork(copy);
  const esp = (src: string, dst: string): SimPacket => ({ src, dst, proto: 'esp', ttl: 255, bytes: 100, espProbe: true });
  const e1 = sub.walk(A.id, esp(local, peer));
  if (!e1.delivery.ok) {
    return { ok: false, text: `The routers agree on the tunnel, but ESP packets from ${local} cannot reach ${peer}: ${e1.delivery.reasonText ?? 'they are lost.'}` };
  }
  const e2 = sub.walk(B.id, esp(peer, local));
  if (!e2.delivery.ok) {
    return { ok: false, text: `The routers agree on the tunnel, but ESP packets from ${peer} cannot get back to ${local}: ${e2.delivery.reasonText ?? 'they are lost.'}` };
  }

  const a = res.a;
  const spiA = newSpi(world); // A receives with this SPI
  const spiB = newSpi(world); // B receives with this SPI
  const localIdent = selector(m.ace.src, m.ace.srcPort, m.ace.protocol);
  const remoteIdent = selector(m.ace.dst, m.ace.dstPort, m.ace.protocol);
  const transform = a.transform.transforms.join(' ');
  const saA: IpsecSa = {
    id: nextId(world), iface: ifA, mapName: m.mapName, seq: m.entry.seq, localEndpoint: local, remoteEndpoint: peer,
    localIdent, remoteIdent, transform, mode: a.transform.mode, spiIn: spiA, spiOut: spiB, encaps: 0, decaps: 0, createdTick: world.tick,
  };
  const saB: IpsecSa = {
    id: nextId(world), iface: out.arrivedIface, mapName: a.peerMap, seq: a.peerEntry.seq, localEndpoint: peer, remoteEndpoint: local,
    localIdent: remoteIdent, remoteIdent: localIdent, transform, mode: a.transform.mode, spiIn: spiB, spiOut: spiA, encaps: 0, decaps: 0, createdTick: world.tick,
  };
  A.runtime.ipsecSas.push(saA);
  B.runtime.ipsecSas.push(saB);
  const detail = `ISAKMP policy ${policyText(a.policy)} matches ${B.label} policy ${a.peerPolicy.priority}; pre-shared keys match; `
    + `transform-set ${tsText(a.transform)}; ${B.label} crypto map ${a.peerMap} ${a.peerEntry.seq}: set peer ${local}, `
    + `access list ${a.peerAclId} entry ${a.peerAce.seq} "${aceText(a.peerAce)}" mirrors "${aceText(m.ace)}"`;
  return { ok: true, sa: saA, detail };
}

// ───────────────────────────── data path ─────────────────────────────
export type CryptoOut =
  | { kind: 'clear' }
  | { kind: 'encrypted'; packet: SimPacket; entry: CryptoMapEntry; negotiated: boolean }
  | { kind: 'drop'; text: string; why: string };

/** Crypto map on the egress interface: encrypt the packet when an entry's ACL permits it (negotiating an SA if needed). */
export function cryptoOutbound(ctx: Ctx, st: WalkState, dev: IosDevice, ifName: string, p: SimPacket): CryptoOut {
  const ifc = dev.config.interfaces[ifName];
  const mapName = ifc?.cryptoMap;
  if (!mapName || isIkeOrEsp(p)) return { kind: 'clear' };
  const notes: string[] = [];
  const m = cryptoMatch(dev, mapName, p, notes);
  if (!m) {
    addStep(st, {
      deviceId: dev.id, stage: 'crypto', feature: 'ipsec', verdict: 'info', iface: ifName, header: describePacket(p),
      text: `Crypto map ${mapName} on ${ifName} does not select this packet, so it is sent without encryption.`,
      detail: notes.length ? notes.join('; ') : `no permit entry of the crypto access list matches ${describePacket(p)}`,
    });
    return { kind: 'clear' };
  }
  countHit(dev.runtime, m.aclId, m.ace);
  const evidence = `crypto map ${mapName} ${m.entry.seq}: match address ${m.aclId} → ${aclEvidence(m.aclId, dev.config.acls[m.aclId], { ace: m.ace, implicit: false, permit: true })}`;
  const local = ifc.ip?.address;
  const fail = (why: string): CryptoOut => {
    const text = `${dev.label} must encrypt this packet (crypto map ${mapName} entry ${m.entry.seq}), but the IPsec tunnel cannot be set up.`;
    addStep(st, { deviceId: dev.id, stage: 'crypto', feature: 'ipsec', verdict: 'drop', iface: ifName, header: describePacket(p), text, detail: `${why} — ${evidence}` });
    return { kind: 'drop', text, why };
  };
  if (!local) return fail(`${ifName} has no IP address to use as the tunnel endpoint.`);

  const localIdent = selector(m.ace.src, m.ace.srcPort, m.ace.protocol);
  const remoteIdent = selector(m.ace.dst, m.ace.dstPort, m.ace.protocol);
  let lastFail = '';
  for (const peer of m.entry.peers) {
    let sa: IpsecSa | undefined;
    let negotiated = false;
    const candidates = dev.runtime.ipsecSas.filter((s) => s.iface === ifName && s.mapName === mapName && s.seq === m.entry.seq
      && s.remoteEndpoint === peer && s.localEndpoint === local && sameSel(s.localIdent, localIdent) && sameSel(s.remoteIdent, remoteIdent));
    for (const c of candidates) {
      // Re-check that the other router still holds its half and that the configuration on both sides still supports this SA.
      const other = findCounterpart(ctx.world, c);
      const still = other ? agree(dev, local, peer, m.entry, m.ace, other.dev, other.sa.iface, p) : null;
      if (other && still && still.ok) { sa = c; break; }
      dropSaPair(ctx.world, dev, c);
    }
    let negDetail = '';
    if (!sa) {
      const r = negotiate(ctx, dev, ifName, m, local, peer, p);
      if (!r.ok) { lastFail = r.text; continue; }
      sa = r.sa;
      negotiated = true;
      negDetail = r.detail;
      const peerLabel = label(ctx.world, findCounterpart(ctx.world, sa)?.dev.id ?? peer);
      addStep(st, {
        deviceId: dev.id, stage: 'crypto', feature: 'ipsec', verdict: 'ok', iface: ifName, header: describePacket(p),
        text: `${dev.label} has no IPsec tunnel for this kind of traffic yet, so it negotiates one with ${peerLabel} (IKE) and succeeds.`,
        detail: negDetail,
      });
    }
    const tunnel = !(sa.mode === 'transport' && p.src === local && p.dst === peer);
    const esp: SimPacket = {
      src: tunnel ? local : p.src, dst: tunnel ? peer : p.dst, proto: 'esp', ttl: 255,
      bytes: p.bytes + (tunnel ? 56 : 36), inner: p, spi: sa.spiOut,
    };
    sa.encaps += 1;
    addStep(st, {
      deviceId: dev.id, stage: 'crypto', feature: 'ipsec', verdict: 'changed', iface: ifName, header: describePacket(esp),
      text: tunnel
        ? `The packet matches crypto map ${mapName} entry ${m.entry.seq}, so ${dev.label} encrypts it and wraps it in a new packet from ${local} to ${peer} (ESP, tunnel mode).`
        : `The packet matches crypto map ${mapName} entry ${m.entry.seq}, so ${dev.label} encrypts its contents (ESP, transport mode).`,
      detail: `${evidence}; SA to ${peer}, SPI 0x${sa.spiOut.toString(16).toUpperCase()}, ${sa.transform}`,
    });
    return { kind: 'encrypted', packet: esp, entry: m.entry, negotiated };
  }
  return fail(lastFail || `Crypto map ${mapName} entry ${m.entry.seq} has no peer.`);
}

export type DecryptResult = { ok: true; packet: SimPacket } | { ok: false; text: string };

/** ESP packet addressed to this router: find the inbound SA and return the protected packet. */
export function decrypt(st: WalkState, dev: IosDevice, ifName: string, p: SimPacket): DecryptResult {
  const sa = dev.runtime.ipsecSas.find((s) => s.spiIn === p.spi && s.remoteEndpoint === p.src);
  if (!sa || !p.inner) {
    const text = `${dev.label} received an encrypted packet from ${p.src} but has no matching IPsec security association (SPI 0x${(p.spi ?? 0).toString(16).toUpperCase()}), so it cannot decrypt it; clear the tunnel on both routers ("clear crypto sa").`;
    addStep(st, { deviceId: dev.id, stage: 'decrypt', feature: 'ipsec', verdict: 'drop', iface: ifName, header: describePacket(p), text });
    return { ok: false, text };
  }
  sa.decaps += 1;
  addStep(st, {
    deviceId: dev.id, stage: 'decrypt', feature: 'ipsec', verdict: 'changed', iface: ifName, header: describePacket(p.inner),
    text: `${dev.label} is the end of the IPsec tunnel: it decrypts the ESP packet and gets the original packet back.`,
    detail: `SA from ${sa.remoteEndpoint}, SPI 0x${sa.spiIn.toString(16).toUpperCase()}, crypto map ${sa.mapName} ${sa.seq}, ${sa.transform}`,
  });
  return { ok: true, packet: p.inner };
}
