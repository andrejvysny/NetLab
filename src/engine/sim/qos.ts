/**
 * MQC QoS (ARCHITECTURE §6.5): classification of transmitted packets against the output service-policy
 * (hierarchical: a shaped parent class with a nested child policy), counters, and a description of the
 * effective policy (`qosPlan`) for grading and tools.
 */
import type { ClassMap, ClassMatch, IosConfig, IosDevice, Packet, PolicyClass, PolicyMap, World } from '../types.ts';
import { aceText, aclEvaluate } from './acl.ts';
import type { QosPlan, QosPlanClass } from './model.ts';
import { linkInfo, serialClock } from './physical.ts';
import { bandwidthKbps, defaultBandwidthKbps } from './routing.ts';
import { isIosDevice, rateText } from './text.ts';

/** Key of IosRuntime.qosCounters. `path` is the policy-map name, or `parent/child` for classes of a nested policy. */
export function qosCounterKey(ifName: string, dir: 'out' | 'in', path: string, className: string): string {
  return `${ifName}|${dir}|${path}|${className}`;
}

/** Packets/bytes counted for a class of the output policy of an interface. */
export function qosCounter(world: World, deviceId: string, ifName: string, path: string, className: string): { packets: number; bytes: number } {
  const dev = world.devices[deviceId];
  if (!isIosDevice(dev)) return { packets: 0, bytes: 0 };
  return dev.runtime.qosCounters[qosCounterKey(ifName, 'out', path, className)] ?? { packets: 0, bytes: 0 };
}

const PROTOCOL_PORTS: Record<string, { proto: 'tcp' | 'udp'; ports: number[] }[]> = {
  telnet: [{ proto: 'tcp', ports: [23] }],
  ssh: [{ proto: 'tcp', ports: [22] }],
  http: [{ proto: 'tcp', ports: [80] }],
  https: [{ proto: 'tcp', ports: [443] }],
  ftp: [{ proto: 'tcp', ports: [20, 21] }],
  snmp: [{ proto: 'udp', ports: [161, 162] }],
  syslog: [{ proto: 'udp', ports: [514] }],
  dhcp: [{ proto: 'udp', ports: [67, 68] }],
  dns: [{ proto: 'udp', ports: [53] }, { proto: 'tcp', ports: [53] }],
  tftp: [{ proto: 'udp', ports: [69] }],
  ntp: [{ proto: 'udp', ports: [123] }],
  isakmp: [{ proto: 'udp', ports: [500, 4500] }],
};

function matchOne(cfg: IosConfig, m: ClassMatch, p: Packet): { hit: boolean; evidence: string } {
  switch (m.kind) {
    case 'any': return { hit: true, evidence: 'match any' };
    case 'access-group': {
      const acl = cfg.acls[m.acl];
      const word = acl?.named ? `access-group name ${m.acl}` : `access-group ${m.acl}`;
      if (!acl) return { hit: false, evidence: `match ${word} (access list not defined: matches nothing)` };
      const r = aclEvaluate(acl, p);
      if (r.ace && r.permit) return { hit: true, evidence: `match ${word} → ${r.ace.seq} ${aceText(r.ace, acl.type)}` };
      return { hit: false, evidence: `match ${word}` };
    }
    case 'protocol': {
      const name = m.protocol.toLowerCase();
      let hit = false;
      if (name === 'ip') hit = true;
      else if (name === 'icmp' || name === 'tcp' || name === 'udp') hit = p.proto === name;
      else if (name === 'ipsec' || name === 'esp') hit = p.proto === 'esp';
      else {
        const defs = PROTOCOL_PORTS[name] ?? [];
        hit = defs.some((d) => p.proto === d.proto && (d.ports.includes(p.dport ?? -1) || d.ports.includes(p.sport ?? -1)));
      }
      return { hit, evidence: `match protocol ${m.protocol}` };
    }
    case 'dscp': {
      // Simulated packets carry no marking: they are all DSCP 0 ("default").
      const hit = m.values.some((v) => v === 'default' || v === '0');
      return { hit, evidence: `match dscp ${m.values.join(' ')}` };
    }
    case 'precedence': {
      const hit = m.values.some((v) => v === 'routine' || v === '0');
      return { hit, evidence: `match precedence ${m.values.join(' ')}` };
    }
  }
}

function matchClassMap(cfg: IosConfig, cm: ClassMap, p: Packet): { hit: boolean; evidence: string } {
  const results = cm.matches.map((m) => matchOne(cfg, m, p));
  if (cm.matchType === 'match-any') {
    const first = results.find((r) => r.hit);
    return first ?? { hit: false, evidence: '' };
  }
  if (results.length === 0) return { hit: false, evidence: '' };
  const hit = results.every((r) => r.hit);
  return { hit, evidence: results.map((r) => r.evidence).join(' and ') };
}

/** Classes in the order IOS evaluates them: user classes in configuration order, class-default last. */
function orderedClasses(pm: PolicyMap): PolicyClass[] {
  const user = pm.classes.filter((c) => c.className !== 'class-default');
  const dflt = pm.classes.find((c) => c.className === 'class-default') ?? { className: 'class-default' };
  return [...user, dflt];
}

function pickClass(cfg: IosConfig, pm: PolicyMap, p: Packet): { cls: PolicyClass; evidence: string } {
  for (const c of orderedClasses(pm)) {
    if (c.className === 'class-default') return { cls: c, evidence: 'no other class matches' };
    const cm = cfg.qos.classMaps.find((x) => x.name === c.className);
    if (!cm) continue;
    const r = matchClassMap(cfg, cm, p);
    if (r.hit) return { cls: c, evidence: r.evidence };
  }
  return { cls: { className: 'class-default' }, evidence: 'no other class matches' };
}

function findPolicy(cfg: IosConfig, name: string | undefined): PolicyMap | undefined {
  return name ? cfg.qos.policyMaps.find((p) => p.name === name) : undefined;
}

function shapeBps(c: PolicyClass, baseKbps: number): number | undefined {
  if (!c.shapeAverage) return undefined;
  if (c.shapeAverage.bps !== undefined) return c.shapeAverage.bps;
  if (c.shapeAverage.percent !== undefined) return Math.round(baseKbps * 1000 * c.shapeAverage.percent / 100);
  return undefined;
}

function treatmentOf(c: PolicyClass, baseKbps: number, priorityKbpsSum: number): Pick<QosPlanClass, 'treatment' | 'kbps' | 'text'> & { short: string } {
  if (c.priority) {
    const kbps = c.priority.kbps ?? (c.priority.percent !== undefined ? baseKbps * c.priority.percent / 100 : undefined);
    return {
      treatment: 'priority', kbps,
      text: kbps !== undefined
        ? `Priority queue (LLQ): sent before everything else, up to ${rateText(kbps * 1000)}.`
        : 'Priority queue (LLQ): sent before everything else.',
      short: kbps !== undefined ? `priority queue, up to ${rateText(kbps * 1000)}` : 'priority queue',
    };
  }
  if (c.bandwidth) {
    let kbps = c.bandwidth.kbps;
    if (kbps === undefined && c.bandwidth.percent !== undefined) kbps = baseKbps * c.bandwidth.percent / 100;
    if (kbps === undefined && c.bandwidth.remainingPercent !== undefined) kbps = Math.max(0, baseKbps - priorityKbpsSum) * c.bandwidth.remainingPercent / 100;
    return {
      treatment: 'bandwidth', kbps,
      text: kbps !== undefined
        ? `Guaranteed at least ${rateText(kbps * 1000)} when the link is busy (CBWFQ).`
        : 'Guaranteed minimum bandwidth when the link is busy (CBWFQ).',
      short: kbps !== undefined ? `at least ${rateText(kbps * 1000)} guaranteed` : 'guaranteed bandwidth',
    };
  }
  if (c.fairQueue) return { treatment: 'fair-queue', text: 'Shares the remaining bandwidth fairly between conversations (WFQ).', short: 'fair share of what is left (WFQ)' };
  return { treatment: 'default', text: 'Best effort: no guarantee, first in first out.', short: 'best effort, no guarantee' };
}

function matchSummary(cfg: IosConfig, className: string): string {
  if (className === 'class-default') return 'everything that no other class matches';
  const cm = cfg.qos.classMaps.find((x) => x.name === className);
  if (!cm) return `class-map ${className} is not defined (matches nothing)`;
  if (cm.matches.length === 0) return 'no match statement (matches nothing)';
  const parts = cm.matches.map((m) => {
    switch (m.kind) {
      case 'any': return 'any packet';
      case 'access-group': {
        const acl = cfg.acls[m.acl];
        const word = acl?.named ? `access-group name ${m.acl}` : `access-group ${m.acl}`;
        if (!acl) return `${word} (access list not defined)`;
        const lines = acl.entries.filter((e) => e.action !== 'remark').map((e) => aceText(e, acl.type));
        return `${word}: ${lines.join('; ')}`;
      }
      case 'protocol': return `protocol ${m.protocol}`;
      case 'dscp': return `dscp ${m.values.join(' ')}`;
      case 'precedence': return `precedence ${m.values.join(' ')}`;
    }
  });
  return parts.join(cm.matchType === 'match-any' ? ' OR ' : ' AND ');
}

export interface QosClassification {
  policy: string;
  className: string;
  childPolicy?: string;
  childClass?: string;
  /** One sentence for the trace. */
  text: string;
  /** Evidence: the chain policy → class → match. */
  detail: string;
}

/**
 * Classify a packet that leaves `ifName` and count it. `p` is the header the classifier looks at (the original packet
 * when an IPsec-protected packet is classified on its inner header); `wireBytes` is the size that is really transmitted. Returns null when no output policy is attached,
 * or a `problem` when the attached policy-map does not exist.
 */
export function classifyOutput(
  dev: IosDevice, ifName: string, p: Packet, count: boolean, wireBytes: number = p.bytes,
): QosClassification | { problem: string } | null {
  const cfg = dev.config;
  const ifc = cfg.interfaces[ifName];
  const name = ifc?.servicePolicyOut;
  if (!name) return null;
  const pm = findPolicy(cfg, name);
  if (!pm) return { problem: `service-policy output ${name} is attached to ${ifName}, but policy-map ${name} does not exist.` };
  const bw = bandwidthKbps(ifc, ifName);
  const top = pickClass(cfg, pm, p);
  const bump = (path: string, cls: string) => {
    if (!count) return;
    const key = qosCounterKey(ifName, 'out', path, cls);
    const c = dev.runtime.qosCounters[key] ?? { packets: 0, bytes: 0 };
    c.packets += 1;
    c.bytes += wireBytes;
    dev.runtime.qosCounters[key] = c;
  };
  bump(pm.name, top.cls.className);
  const shaped = shapeBps(top.cls, bw);
  const shapeWord = shaped !== undefined ? ` (shaped to ${rateText(shaped)})` : '';
  const child = findPolicy(cfg, top.cls.servicePolicy);
  if (!child) {
    const t = treatmentOf(top.cls, bw, 0);
    const extra = top.cls.servicePolicy ? `; the nested policy-map ${top.cls.servicePolicy} does not exist` : '';
    return {
      policy: pm.name, className: top.cls.className,
      text: `QoS on ${ifName} puts the packet into class ${top.cls.className} of policy ${pm.name}: ${t.short}.`,
      detail: `service-policy output ${pm.name} → class ${top.cls.className}${shapeWord}: ${top.evidence}${extra}`,
    };
  }
  const sub = pickClass(cfg, child, p);
  bump(`${pm.name}/${child.name}`, sub.cls.className);
  const base = shaped !== undefined ? shaped / 1000 : bw;
  const t = treatmentOf(sub.cls, base, 0);
  return {
    policy: pm.name, className: top.cls.className, childPolicy: child.name, childClass: sub.cls.className,
    text: `QoS on ${ifName} puts the packet into class ${sub.cls.className} of policy ${child.name}: ${t.short}.`,
    detail: `service-policy output ${pm.name} → class ${top.cls.className}${shapeWord} → service-policy ${child.name} → class ${sub.cls.className}: ${sub.evidence}`,
  };
}

/** Nominal Ethernet link capacity, not a PHY negotiation or duplex-mismatch model. All modeled RJ-45 ports are 1 Gb/s capable. */
function ethernetCapacityBps(world: World, dev: IosDevice, ifName: string): number | undefined {
  if (!dev.ports.some((p) => p.name === ifName && p.kind === 'ethernet')) return undefined;
  const capMbps = (speed?: string): number => speed === '10' || speed === '100' ? Number(speed) : 1000;
  const local = capMbps(dev.config.interfaces[ifName].speed);
  const link = linkInfo(world, { deviceId: dev.id, port: ifName });
  const remote = link.usable && link.peer ? world.devices[link.peer.deviceId] : undefined;
  const peer = isIosDevice(remote) && link.peer ? capMbps(remote.config.interfaces[link.peer.port]?.speed) : 1000;
  return Math.min(local, peer) * 1_000_000;
}

/**
 * The effective output QoS of an interface: nominal physical rate, bandwidth metadata, shaper and leaf-class treatment.
 * `attached` is false (with a `problem`) when nothing usable is attached in the output direction.
 */
export function qosPlan(world: World, deviceId: string, ifName: string): QosPlan {
  const dev = world.devices[deviceId];
  if (!isIosDevice(dev) || !dev.config.interfaces[ifName]) {
    return { attached: false, problem: `There is no interface ${ifName} on ${dev?.label ?? deviceId}.`, physicalBps: 0, bandwidthKbps: 0, bandwidthConfigured: false, classes: [] };
  }
  const cfg = dev.config;
  const ifc = cfg.interfaces[ifName];
  const bw = bandwidthKbps(ifc, ifName);
  const clock = serialClock(world, deviceId, ifName);
  const plan: QosPlan = {
    attached: false,
    // Interface bandwidth is the reference for MQC percentage rates, not an Ethernet speed or serial clock.
    physicalBps: clock?.effective ?? ethernetCapacityBps(world, dev, ifName) ?? defaultBandwidthKbps(ifName) * 1000,
    clockRateBps: clock?.configured,
    bandwidthKbps: bw,
    bandwidthConfigured: ifc.bandwidthKbps !== undefined,
    classes: [],
  };
  const name = ifc.servicePolicyOut;
  if (!name) {
    plan.problem = ifc.servicePolicyIn
      ? `Policy ${ifc.servicePolicyIn} is attached to ${ifName} as input. Queueing and shaping only work on packets that leave the interface: use "service-policy output ${ifc.servicePolicyIn}".`
      : `No service-policy output is attached to ${ifName} on ${dev.label}.`;
    return plan;
  }
  plan.policy = name;
  const pm = findPolicy(cfg, name);
  if (!pm) {
    plan.problem = `service-policy output ${name} is attached to ${ifName}, but policy-map ${name} does not exist on ${dev.label}.`;
    return plan;
  }
  plan.attached = true;

  const addLeaves = (policy: PolicyMap, baseKbps: number, parent?: { policy: string; className: string }) => {
    const classes = orderedClasses(policy);
    const prioSum = classes.reduce((s, c) => s + (c.priority?.kbps ?? (c.priority?.percent !== undefined ? baseKbps * c.priority.percent / 100 : 0)), 0);
    for (const c of classes) {
      const shaped = shapeBps(c, baseKbps);
      if (shaped !== undefined && plan.shapedBps === undefined) {
        plan.shapedBps = shaped;
        const how = c.shapeAverage?.percent !== undefined
          ? `shape average percent ${c.shapeAverage.percent} of ${rateText(baseKbps * 1000)}`
          : `shape average ${shaped}`;
        plan.shaper = { policy: policy.name, className: c.className, text: `${how} = ${rateText(shaped)}` };
      }
      const child = findPolicy(cfg, c.servicePolicy);
      if (child && !parent) {
        addLeaves(child, shaped !== undefined ? shaped / 1000 : baseKbps, { policy: policy.name, className: c.className });
        continue;
      }
      if (c.servicePolicy && !child && !plan.problem) {
        plan.problem = `Class ${c.className} of ${policy.name} refers to policy-map ${c.servicePolicy}, which does not exist.`;
      }
      // An implicit class-default in a parent policy that only exists to hold children is still a leaf.
      const t = treatmentOf(c, baseKbps, prioSum);
      plan.classes.push({
        policy: policy.name, className: c.className, parentPolicy: parent?.policy, parentClass: parent?.className,
        treatment: t.treatment, kbps: t.kbps, policeBps: c.police?.bps, match: matchSummary(cfg, c.className), text: t.text,
      });
    }
  };
  addLeaves(pm, bw);
  return plan;
}
