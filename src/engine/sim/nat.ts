/**
 * NAT (ARCHITECTURE §6.3): static rules (address and port forms, both directions), dynamic rules with a pool or an
 * interface, overload (PAT, the ICMP identifier counts as the port), TCP load distribution (`ip nat inside destination`),
 * and the translation table that is reused for replies.
 */
import type { DropReason, IosConfig, IosDevice, NatDynamicRule, NatPool, NatStaticRule, NatTranslation, Packet, TraceStep, World } from '../types.ts';
import { intToIp, ipToInt } from '../ip.ts';
import { nextId } from '../world.ts';
import { basicNatEnabled, catalystNatMappingProblem, natRoleOn } from '../natProfile.ts';
import { lookupIn, tableWith } from './routing.ts';
import { isUp } from './physical.ts';
import { aclEvaluate, aclEvidence, countHit } from './acl.ts';
import type { Ctx, SimPacket, WalkState } from './model.ts';
import { addStep } from './model.ts';
import { describePacket } from './text.ts';

type NatProto = 'icmp' | 'tcp' | 'udp';

function natProto(p: Packet): NatProto | null {
  return p.proto === 'icmp' || p.proto === 'tcp' || p.proto === 'udp' ? p.proto : null;
}
function isIcmpError(p: Packet): boolean {
  return p.proto === 'icmp' && p.icmpType !== 'echo' && p.icmpType !== 'echo-reply' && p.icmpType !== undefined;
}
function sportOf(p: Packet): number { return p.sport ?? 0; }
function dportOf(p: Packet): number { return p.proto === 'icmp' ? (p.sport ?? 0) : (p.dport ?? 0); }

function withSrc(p: SimPacket, address: string, port: number): SimPacket {
  if (p.proto === 'icmp') return isIcmpError(p) ? { ...p, src: address } : { ...p, src: address, sport: port, dport: port };
  return { ...p, src: address, sport: port };
}
function withDst(p: SimPacket, address: string, port: number): SimPacket {
  if (p.proto === 'icmp') return isIcmpError(p) ? { ...p, dst: address } : { ...p, dst: address, sport: port, dport: port };
  return { ...p, dst: address, dport: port };
}

function ifaceAddress(cfg: IosConfig, ifName: string | undefined): string | undefined {
  return ifName ? cfg.interfaces[ifName]?.ip?.address : undefined;
}
function staticGlobal(cfg: IosConfig, r: NatStaticRule): string | undefined {
  return r.global ?? ifaceAddress(cfg, r.interface);
}
function poolOf(cfg: IosConfig, name: string | undefined): NatPool | undefined {
  return name ? cfg.nat.pools.find((p) => p.name === name) : undefined;
}
function inPool(pool: NatPool, ip: string): boolean {
  const n = ipToInt(ip);
  return n >= ipToInt(pool.start) && n <= ipToInt(pool.end);
}
function isOverload(r: NatDynamicRule): boolean { return r.overload || (!!r.interface && !r.pool); }

/** A NAT selector needs a permit ACE. 'No filter' on an interface is not a match for translation. */
function natSelected(r: ReturnType<typeof aclEvaluate>): boolean { return r.permit && r.ace !== undefined; }

export function staticRuleText(r: NatStaticRule): string {
  const g = r.interface ? `interface ${r.interface}` : r.global;
  return r.proto
    ? `ip nat inside source static ${r.proto} ${r.local} ${r.localPort} ${g} ${r.globalPort}`
    : `ip nat inside source static ${r.local} ${g}`;
}
export function dynamicRuleText(r: NatDynamicRule): string {
  return `ip nat inside source list ${r.acl} ${r.pool ? `pool ${r.pool}` : `interface ${r.interface}`}${r.overload ? ' overload' : ''}`;
}
/** One row of `show ip nat translations`: Pro, Inside global, Inside local, Outside local, Outside global. */
export function translationRow(t: NatTranslation): string {
  return `${t.proto} ${t.insideGlobal}:${t.insideGlobalPort} ${t.insideLocal}:${t.insideLocalPort} ${t.outsideLocal}:${t.outsideLocalPort} ${t.outsideGlobal}:${t.outsideGlobalPort}`;
}

export function natStaticRules(dev: IosDevice): NatStaticRule[] {
  return dev.kind === 'switch' ? dev.config.nat.staticRules.filter((r) => !!r.global && !r.interface) : dev.config.nat.staticRules;
}
function hasNatConfig(dev: IosDevice): boolean {
  const { nat } = dev.config;
  return nat.staticRules.length > 0 || nat.dynamicRules.length > 0 || (dev.kind === 'router' && nat.insideDestinationRules.length > 0);
}

/** The rewritten address must route through an inside data port on Catalyst. */
function catalystInsidePath(ctx: Ctx, dev: IosDevice, local: string): boolean {
  if (dev.kind === 'router') return true;
  const via = lookupIn(tableWith(ctx.world, dev.id, ctx.routes), local)?.resolved.iface;
  return !!via && natRoleOn(dev, via) === 'inside' && isUp(ctx.world, dev.id, via);
}

/** Does the configuration still produce this translation? Entries left over from removed rules are ignored and dropped. */
function entryValid(world: World, dev: IosDevice, t: NatTranslation): boolean {
  const cfg = dev.config;
  if (t.fromStatic) {
    return natStaticRules(dev).some((r) => r.local === t.insideLocal && staticGlobal(cfg, r) === t.insideGlobal
      && (!r.proto || (r.proto === t.proto && r.localPort === t.insideLocalPort && r.globalPort === t.insideGlobalPort)));
  }
  const probe: Packet = { src: t.insideLocal, dst: t.outsideGlobal, proto: t.proto, sport: t.insideLocalPort, dport: t.outsideGlobalPort, icmpType: t.icmpType, tcpSyn: t.tcpSyn, ttl: 64, bytes: 0 };
  for (const r of cfg.nat.dynamicRules) {
    if (dev.kind === 'switch' && (t.mappingAcl !== r.acl || catalystNatMappingProblem(world, dev, r))) continue;
    if (!natSelected(aclEvaluate(cfg.acls[r.acl], probe))) continue;
    if (r.pool) { const pool = poolOf(cfg, r.pool); if (pool && inPool(pool, t.insideGlobal)) return true; }
    else if (ifaceAddress(cfg, r.interface) === t.insideGlobal) return true;
  }
  if (dev.kind === 'switch') return false;
  for (const r of cfg.nat.insideDestinationRules) {
    const pool = poolOf(cfg, r.pool);
    if (!pool || !inPool(pool, t.insideLocal)) continue;
    if (natSelected(aclEvaluate(cfg.acls[r.acl], { ...probe, src: t.insideGlobal }))) return true;
  }
  return false;
}

/** Readback filters invalidated Catalyst entries without mutating the bench. */
export function visibleNatTranslations(world: World, dev: IosDevice): NatTranslation[] {
  if (dev.kind === 'router') return dev.runtime.natTranslations;
  if (!basicNatEnabled(dev) || !dev.config.ipRouting) return [];
  const usableRoles = new Set(Object.keys(dev.config.interfaces)
    .map((name) => { const role = natRoleOn(dev, name); return role && isUp(world, dev.id, name) ? role : undefined; }));
  if (!usableRoles.has('inside') || !usableRoles.has('outside')) return [];
  return dev.runtime.natTranslations.filter((t) => entryValid(world, dev, t));
}
function purgeStale(world: World, dev: IosDevice): void {
  if (dev.runtime.natTranslations.length === 0) return;
  dev.runtime.natTranslations = dev.runtime.natTranslations.filter((t) => entryValid(world, dev, t));
}

function addEntry(ctx: Ctx, dev: IosDevice, t: Omit<NatTranslation, 'id' | 'createdTick'>): NatTranslation {
  const same = dev.runtime.natTranslations.find((e) => e.proto === t.proto && e.insideLocal === t.insideLocal && e.insideLocalPort === t.insideLocalPort
    && e.insideGlobal === t.insideGlobal && e.insideGlobalPort === t.insideGlobalPort
    && e.outsideGlobal === t.outsideGlobal && e.outsideGlobalPort === t.outsideGlobalPort);
  if (same) { dev.runtime.natHits += 1; return same; }
  const full: NatTranslation = { ...t, id: nextId(ctx.world), createdTick: ctx.world.tick };
  dev.runtime.natTranslations.push(full);
  if (dev.kind === 'switch') dev.runtime.natHits += 1;
  else dev.runtime.natMisses += 1;
  return full;
}

function step(st: WalkState, dev: IosDevice, stage: 'nat-inside' | 'nat-outside', verdict: TraceStep['verdict'], text: string, detail: string | undefined, p: Packet, iface?: string): void {
  addStep(st, { deviceId: dev.id, stage, feature: 'nat', text, detail, verdict, iface, header: describePacket(p) });
}

// ───────────────────────────── outside → inside ─────────────────────────────

/**
 * Packet arrived on an `ip nat outside` interface: translate the destination back to the inside local address
 * (translation table first, then static rules, then TCP load distribution). Returns the (possibly rewritten) packet.
 */
export function natOutsideToInside(ctx: Ctx, st: WalkState, dev: IosDevice, ifName: string, p: SimPacket): SimPacket {
  const cfg = dev.config;
  const proto = natProto(p);
  if (!proto) return p;
  if (natRoleOn(dev, ifName) !== 'outside' || (dev.kind === 'switch' && !cfg.ipRouting)) return p;
  purgeStale(ctx.world, dev);
  if (!hasNatConfig(dev)) return p;
  const table = dev.runtime.natTranslations;

  // ICMP error about a packet this router translated earlier: translate the address and the quoted packet.
  if (isIcmpError(p)) {
    const q = p.errFor;
    if (q) {
      const qp = natProto(q);
      const t = table.find((e) => e.proto === qp && e.insideGlobal === q.src && e.insideGlobalPort === sportOf(q) && e.outsideGlobal === q.dst);
      if (t && p.dst === t.insideGlobal && catalystInsidePath(ctx, dev, t.insideLocal)) {
        dev.runtime.natHits += 1;
        const np: SimPacket = { ...p, dst: t.insideLocal, errFor: q.proto === 'icmp' ? { ...q, src: t.insideLocal, sport: t.insideLocalPort, dport: t.insideLocalPort } : { ...q, src: t.insideLocal, sport: t.insideLocalPort } };
        step(st, dev, 'nat-outside', 'changed', `NAT changes the destination back from ${p.dst} to ${t.insideLocal}: the error message belongs to a translated conversation.`, translationRow(t), np, ifName);
        return np;
      }
    }
    const rule = natStaticRules(dev).find((r) => !r.proto && staticGlobal(cfg, r) === p.dst && catalystInsidePath(ctx, dev, r.local));
    if (rule) {
      if (dev.kind === 'switch') dev.runtime.natHits += 1;
      const np: SimPacket = { ...p, dst: rule.local };
      step(st, dev, 'nat-outside', 'changed', `NAT changes the destination from ${p.dst} to ${rule.local} (static NAT).`, staticRuleText(rule), np, ifName);
      return np;
    }
    return p;
  }

  // 1. translation table. A ping request from outside is never the answer to a ping that went out,
  //    so it does not use the entries that outgoing traffic created (static sessions excepted).
  const newPing = proto === 'icmp' && (p.icmpType === 'echo' || p.icmpType === undefined);
  const hit = table.find((e) => e.proto === proto && e.insideGlobal === p.dst && e.insideGlobalPort === dportOf(p)
    && e.outsideGlobal === p.src && (proto === 'icmp' || e.outsideGlobalPort === sportOf(p)) && (!newPing || e.fromStatic === true) && catalystInsidePath(ctx, dev, e.insideLocal));
  if (hit) {
    dev.runtime.natHits += 1;
    const np = withDst(p, hit.insideLocal, hit.insideLocalPort);
    step(st, dev, 'nat-outside', 'changed',
      `NAT changes the destination back from ${p.dst} to ${hit.insideLocal}, using its translation table.`,
      translationRow(hit), np, ifName);
    return np;
  }

  // 2. static rules: port forms first, then whole-address forms
  const rules = [...natStaticRules(dev)].sort((a, b) => Number(!!b.proto) - Number(!!a.proto));
  for (const r of rules) {
    const g = staticGlobal(cfg, r);
    if (!g || g !== p.dst || !catalystInsidePath(ctx, dev, r.local)) continue;
    if (r.proto && (r.proto !== proto || r.globalPort !== dportOf(p))) continue;
    const localPort = r.proto ? (r.localPort ?? dportOf(p)) : dportOf(p);
    const np = withDst(p, r.local, localPort);
    addEntry(ctx, dev, {
      proto, insideLocal: r.local, insideLocalPort: localPort, insideGlobal: g, insideGlobalPort: dportOf(p),
      outsideLocal: p.src, outsideLocalPort: proto === 'icmp' ? dportOf(p) : sportOf(p),
      outsideGlobal: p.src, outsideGlobalPort: proto === 'icmp' ? dportOf(p) : sportOf(p), fromStatic: true,
    });
    step(st, dev, 'nat-outside', 'changed',
      `NAT changes the destination from ${p.dst} to ${r.local} (static NAT, session started from outside).`,
      staticRuleText(r), np, ifName);
    return np;
  }

  // 3. ISR only: an inside host that currently holds a one-to-one pool address can be reached from outside.
  for (const r of dev.kind === 'router' ? cfg.nat.dynamicRules : []) {
    if (isOverload(r)) continue;
    const pool = poolOf(cfg, r.pool);
    if (!pool || !inPool(pool, p.dst)) continue;
    const owner = table.find((e) => e.insideGlobal === p.dst && !e.fromStatic);
    if (!owner) continue;
    const np = withDst(p, owner.insideLocal, dportOf(p));
    addEntry(ctx, dev, {
      proto, insideLocal: owner.insideLocal, insideLocalPort: dportOf(p), insideGlobal: p.dst, insideGlobalPort: dportOf(p),
      outsideLocal: p.src, outsideLocalPort: proto === 'icmp' ? dportOf(p) : sportOf(p),
      outsideGlobal: p.src, outsideGlobalPort: proto === 'icmp' ? dportOf(p) : sportOf(p),
    });
    step(st, dev, 'nat-outside', 'changed',
      `NAT changes the destination from ${p.dst} to ${owner.insideLocal}: that inside host currently holds this pool address.`,
      dynamicRuleText(r), np, ifName);
    return np;
  }

  // 4. TCP load distribution (rotary pool)
  if (dev.kind === 'router' && proto === 'tcp' && p.tcpSyn) {
    for (const r of cfg.nat.insideDestinationRules) {
      const acl = cfg.acls[r.acl];
      const res = aclEvaluate(acl, { ...p, src: p.dst });
      if (!natSelected(res)) continue;
      const pool = poolOf(cfg, r.pool);
      if (!pool) continue;
      const size = ipToInt(pool.end) - ipToInt(pool.start) + 1;
      if (size <= 0) continue;
      countHit(dev.runtime, r.acl, res.ace);
      const used = table.filter((e) => e.insideGlobal === p.dst && inPool(pool, e.insideLocal)).length;
      const real = intToIp(ipToInt(pool.start) + (used % size));
      const np = withDst(p, real, dportOf(p));
      addEntry(ctx, dev, {
        proto, insideLocal: real, insideLocalPort: dportOf(p), insideGlobal: p.dst, insideGlobalPort: dportOf(p),
        outsideLocal: p.src, outsideLocalPort: sportOf(p), outsideGlobal: p.src, outsideGlobalPort: sportOf(p),
      });
      step(st, dev, 'nat-outside', 'changed',
        `NAT load distribution: the connection to the virtual address ${p.dst} is handed to the real server ${real} (next in the rotary pool ${pool.name}).`,
        `ip nat inside destination list ${r.acl} pool ${r.pool}`, np, ifName);
      return np;
    }
  }
  return p;
}

/** Note for the trace when a packet for a NAT address arrives on an interface that is not `ip nat outside`. */
export function natOutsideMissingNote(st: WalkState, dev: IosDevice, ifName: string, p: SimPacket): void {
  const cfg = dev.config;
  if (!basicNatEnabled(dev) || !hasNatConfig(dev) || !natProto(p)) return;
  const rule = natStaticRules(dev).find((r) => staticGlobal(cfg, r) === p.dst);
  if (!rule) return;
  step(st, dev, 'nat-outside', 'info',
    `${p.dst} is the public address of a static NAT rule, but it is not translated here because ${ifName} is not marked "ip nat outside".`,
    staticRuleText(rule), p, ifName);
}

// ───────────────────────────── inside → outside ─────────────────────────────

export type NatOutResult = { packet: SimPacket } | { drop: { reason: DropReason; text: string } };

function allocPort(dev: IosDevice, proto: NatProto, global: string, wanted: number): number | undefined {
  const used = new Set(dev.runtime.natTranslations.filter((e) => e.proto === proto && e.insideGlobal === global).map((e) => e.insideGlobalPort));
  if (dev.kind === 'switch') {
    for (const r of natStaticRules(dev)) if (r.global === global && r.proto === proto && r.globalPort !== undefined) used.add(r.globalPort);
  }
  if (!used.has(wanted)) return wanted;
  for (let port = 1024; port <= 65535; port++) if (!used.has(port)) return port;
  return dev.kind === 'router' ? wanted : undefined;
}

/**
 * Packet goes from an inside interface (or from an ISR itself) out of an `ip nat outside` interface:
 * translate the source (table, static rules, dynamic rules in order).
 */
export function natInsideToOutside(ctx: Ctx, st: WalkState, dev: IosDevice, outIf: string, p: SimPacket, originated: boolean): NatOutResult {
  const cfg = dev.config;
  const proto = natProto(p);
  if (!proto) return { packet: p };
  if (natRoleOn(dev, outIf) !== 'outside' || (dev.kind === 'switch' && !cfg.ipRouting)) return { packet: p };
  purgeStale(ctx.world, dev);
  if (!hasNatConfig(dev)) return { packet: p };
  const table = dev.runtime.natTranslations;

  if (isIcmpError(p)) {
    const q = p.errFor;
    if (q) {
      const qp = natProto(q);
      const t = table.find((e) => e.proto === qp && e.insideLocal === q.dst && e.insideLocalPort === dportOf(q) && e.outsideGlobal === q.src);
      if (t && p.src === t.insideLocal) {
        dev.runtime.natHits += 1;
        const np: SimPacket = { ...p, src: t.insideGlobal, errFor: { ...q, dst: t.insideGlobal } };
        step(st, dev, 'nat-inside', 'changed', `NAT changes the source from ${p.src} to ${t.insideGlobal}: the error message belongs to a translated conversation.`, translationRow(t), np, outIf);
        return { packet: np };
      }
    }
  } else {
    // 1. translation table
    const hit = table.find((e) => e.proto === proto && e.insideLocal === p.src && e.insideLocalPort === sportOf(p)
      && e.outsideGlobal === p.dst && (proto === 'icmp' || e.outsideGlobalPort === dportOf(p)));
    if (hit) {
      dev.runtime.natHits += 1;
      const np = withSrc(p, hit.insideGlobal, hit.insideGlobalPort);
      step(st, dev, 'nat-inside', 'changed',
        `NAT changes the source from ${p.src} to ${hit.insideGlobal}, reusing the translation of this conversation.`,
        translationRow(hit), np, outIf);
      return { packet: np };
    }
  }

  // 2. static rules
  const rules = [...natStaticRules(dev)].sort((a, b) => Number(!!b.proto) - Number(!!a.proto));
  for (const r of rules) {
    if (r.local !== p.src) continue;
    if (r.proto && (isIcmpError(p) || r.proto !== proto || r.localPort !== sportOf(p))) continue;
    const g = staticGlobal(cfg, r);
    if (!g) continue;
    const gPort = r.proto ? (r.globalPort ?? sportOf(p)) : sportOf(p);
    const np = withSrc(p, g, gPort);
    if (!isIcmpError(p)) {
      addEntry(ctx, dev, {
        proto, insideLocal: p.src, insideLocalPort: sportOf(p), insideGlobal: g, insideGlobalPort: gPort,
        outsideLocal: p.dst, outsideLocalPort: proto === 'icmp' ? gPort : dportOf(p),
        outsideGlobal: p.dst, outsideGlobalPort: proto === 'icmp' ? gPort : dportOf(p), fromStatic: true,
      });
    }
    if (isIcmpError(p) && dev.kind === 'switch') dev.runtime.natHits += 1;
    step(st, dev, 'nat-inside', 'changed', `NAT changes the source address from ${p.src} to ${g} (static NAT).`, staticRuleText(r), np, outIf);
    return { packet: np };
  }

  // 3. dynamic rules, in configuration order
  const tried: string[] = [];
  for (const r of cfg.nat.dynamicRules) {
    const problem = catalystNatMappingProblem(ctx.world, dev, r);
    if (problem) { tried.push(`${dynamicRuleText(r)}: ${problem}`); continue; }
    const acl = cfg.acls[r.acl];
    const res = aclEvaluate(acl, p);
    if (!natSelected(res)) {
      const why = res.permit
        ? `access list ${r.acl} ${acl ? 'has no permit/deny entries' : 'is not defined'}, so it selects no traffic for NAT`
        : aclEvidence(r.acl, acl, res);
      tried.push(`${dynamicRuleText(r)}: ${why}`);
      continue;
    }
    const evidence = `${dynamicRuleText(r)} — ${aclEvidence(r.acl, acl, res)}`;
    const overload = isOverload(r);
    let global: string | undefined;
    let port: number | undefined;
    const wanted = sportOf(p);
    if (r.pool) {
      const pool = poolOf(cfg, r.pool);
      if (!pool) { tried.push(`${dynamicRuleText(r)}: pool ${r.pool} is not defined`); continue; }
      if (overload) {
        if (dev.kind === 'router') global = pool.start;
        else {
          // The next pool address can still serve new sessions if this one runs out of ports.
          for (let n = ipToInt(pool.start), end = ipToInt(pool.end); n <= end; n++) {
            const address = intToIp(n);
            if (natStaticRules(dev).some((s) => !s.proto && s.global === address)) continue;
            port = allocPort(dev, proto, address, wanted);
            if (port !== undefined) { global = address; break; }
          }
        }
      } else {
        const mine = table.find((e) => e.insideLocal === p.src && !e.fromStatic && inPool(pool, e.insideGlobal)
          && (dev.kind === 'router' || e.mappingAcl === r.acl));
        if (mine) global = mine.insideGlobal;
        else {
          const taken = new Set(table.filter((e) => inPool(pool, e.insideGlobal)).map((e) => e.insideGlobal));
          if (dev.kind === 'switch') for (const s of natStaticRules(dev)) if (s.global) taken.add(s.global);
          for (let n = ipToInt(pool.start); n <= ipToInt(pool.end); n++) {
            if (!taken.has(intToIp(n))) { global = intToIp(n); break; }
          }
          if (!global) {
            countHit(dev.runtime, r.acl, res.ace);
            if (dev.kind === 'switch') dev.runtime.natMisses += 1;
            const short = `NAT pool ${pool.name} on ${dev.label} has no free address left, so the packet is dropped.`;
            const more = `${pool.start} to ${pool.end} are all in use by other inside hosts. Add "overload" to let many hosts share one address.`;
            step(st, dev, 'nat-inside', 'drop', short, `${more} — ${evidence}`, p, outIf);
            return { drop: { reason: 'host-unreachable', text: `${short} ${more}` } };
          }
        }
      }
    } else {
      global = ifaceAddress(cfg, r.interface);
      if (!global) { tried.push(`${dynamicRuleText(r)}: ${r.interface} has no IP address`); continue; }
    }
    countHit(dev.runtime, r.acl, res.ace);
    const gPort = overload && global ? (port ?? allocPort(dev, proto, global, wanted)) : wanted;
    if (!global || gPort === undefined) {
      dev.runtime.natMisses += 1;
      const text = `NAT overload on ${dev.label} cannot allocate a global address and port; the packet is dropped.`;
      step(st, dev, 'nat-inside', 'drop', text, evidence, p, outIf);
      return { drop: { reason: 'host-unreachable', text } };
    }
    const np = withSrc(p, global, gPort);
    if (!isIcmpError(p)) {
      addEntry(ctx, dev, {
        ...(dev.kind === 'switch' ? { mappingAcl: r.acl, tcpSyn: p.tcpSyn, icmpType: p.icmpType } : {}),
        proto, insideLocal: p.src, insideLocalPort: sportOf(p), insideGlobal: global, insideGlobalPort: gPort,
        outsideLocal: p.dst, outsideLocalPort: proto === 'icmp' ? gPort : dportOf(p),
        outsideGlobal: p.dst, outsideGlobalPort: proto === 'icmp' ? gPort : dportOf(p),
      });
    }
    if (isIcmpError(p) && dev.kind === 'switch') dev.runtime.natHits += 1;
    const what = proto === 'icmp' ? 'ICMP identifier' : 'source port';
    const portNote = !overload || isIcmpError(p) ? ''
      : gPort === wanted ? `; the ${what} stays ${wanted}`
        : `; the ${what} changes from ${wanted} to ${gPort} because ${wanted} is already used by another translation`;
    const where = r.pool ? `an address of pool ${r.pool}` : `the address of ${r.interface}`;
    step(st, dev, 'nat-inside', 'changed',
      `NAT${overload ? ' (PAT, overload)' : ''} changes the source address from ${p.src} to ${global}, ${where}${portNote}.`,
      evidence, np, outIf);
    return { packet: np };
  }

  if (!originated) {
    step(st, dev, 'nat-inside', 'info',
      `NAT leaves the source ${p.src} unchanged: no static rule and no dynamic rule matches it.`,
      tried.length ? tried.join(' | ') : undefined, p, outIf);
  }
  return { packet: p };
}

/** Would some NAT rule translate this source if the interface roles were right? Returns the rule text. */
function ruleForSource(cfg: IosConfig, p: Packet): string | null {
  const s = cfg.nat.staticRules.find((r) => r.local === p.src && (!r.proto || (r.proto === p.proto && r.localPort === p.sport)));
  if (s) return staticRuleText(s);
  for (const r of cfg.nat.dynamicRules) {
    const res = aclEvaluate(cfg.acls[r.acl], p);
    if (natSelected(res)) return dynamicRuleText(r);
  }
  return null;
}

/**
 * Trace note when a NAT rule matches the source but the interface roles are missing, so nothing is translated.
 * `inIf` is undefined for packets the router creates itself.
 */
export function natRolesMissingNote(st: WalkState, dev: IosDevice, inIf: string | undefined, outIf: string, p: SimPacket): void {
  if (!basicNatEnabled(dev) || !hasNatConfig(dev) || !natProto(p) || inIf === undefined) return;
  const inRole = natRoleOn(dev, inIf);
  const outRole = natRoleOn(dev, outIf);
  if (inRole === 'outside' || outRole === 'inside') return; // traffic towards the inside: nothing to say
  const rule = ruleForSource(dev.config, p);
  if (!rule) return;
  const missing: string[] = [];
  if (inRole !== 'inside') missing.push(`${inIf} (where the packet came in) is not marked "ip nat inside"`);
  if (outRole !== 'outside') missing.push(`${outIf} (where it leaves) is not marked "ip nat outside"`);
  if (missing.length === 0) return;
  step(st, dev, 'nat-inside', 'info',
    `NAT does not translate the source ${p.src}: ${missing.join(' and ')}.`,
    `${rule} — a rule matches, but NAT only works between an inside and an outside interface`, p, outIf);
}
