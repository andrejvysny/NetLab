/**
 * MQC screens: show class-map [<name>], show policy-map [<name>], show policy-map interface [<if>] [input|output]
 * in the IOS XE layout (nested child policy indented; counters from runtime.qosCounters via qosCounter).
 */
import type { ClassMatch, IosDevice, PolicyClass, PolicyMap, World } from '../../types.ts';
import { bandwidthKbps, qosCounter } from '../../sim/index.ts';
import { ifOrder, joinLines } from './util.ts';

function matchWords(m: ClassMatch, forInterface: boolean): string {
  switch (m.kind) {
    case 'access-group': return /^\d+$/.test(m.acl) ? (forInterface ? `access-group ${m.acl}` : `access-group  ${m.acl}`) : `access-group name ${m.acl}`;
    case 'protocol': return `protocol ${m.protocol}`;
    case 'dscp': return `${forInterface ? ' ' : ''}dscp ${m.values.join(' ')}`;
    case 'precedence': return `${forInterface ? ' ' : ''}precedence ${m.values.join(' ')}`;
    case 'any': return 'any ';
  }
}
function classIds(dev: IosDevice): Map<string, number> {
  const ids = new Map<string, number>([['class-default', 0]]);
  dev.config.qos.classMaps.forEach((c, i) => ids.set(c.name, i + 1));
  return ids;
}

export function showClassMap(dev: IosDevice, only?: string): string {
  const ids = classIds(dev);
  const out: string[] = [];
  const block = (name: string, type: string, matches: ClassMatch[], description?: string) => {
    out.push(` Class Map ${type} ${name} (id ${ids.get(name) ?? 0})`);
    if (description) out.push(`   Description: ${description}`);
    if (!matches.length) out.push('   Match none ');
    for (const m of matches) out.push(`   Match ${matchWords(m, false)} `);
    out.push('');
  };
  if (!only || only === 'class-default') block('class-default', 'match-any', [{ kind: 'any' }]);
  for (const c of dev.config.qos.classMaps) {
    if (only && c.name !== only) continue;
    block(c.name, c.matchType, c.matches, c.description);
  }
  if (only && !out.length) return `Class-map ${only} not found`;
  return joinLines(out);
}

function ordered(pm: PolicyMap): PolicyClass[] {
  const user = pm.classes.filter((c) => c.className !== 'class-default');
  const dflt = pm.classes.find((c) => c.className === 'class-default');
  return dflt ? [...user, dflt] : user;
}
function actionLines(c: PolicyClass, ind: string): string[] {
  const out: string[] = [];
  if (c.setDscp) out.push(`${ind}set dscp ${c.setDscp}`);
  if (c.police) out.push(`${ind}police cir ${c.police.bps} bc ${Math.max(1500, Math.floor(c.police.bps / 32))}`, `${ind}  conform-action transmit `, `${ind}  exceed-action drop `);
  if (c.priority) {
    const p = c.priority;
    if (p.percent !== undefined) out.push(`${ind}priority ${p.percent} (%)${p.burstBytes !== undefined ? ` ${p.burstBytes} (bytes)` : ''}`);
    else if (p.kbps !== undefined) out.push(`${ind}priority ${p.kbps} (kbps)${p.burstBytes !== undefined ? ` ${p.burstBytes} (bytes)` : ''}`);
    else out.push(`${ind}priority`);
  }
  if (c.bandwidth) {
    const b = c.bandwidth;
    if (b.remainingPercent !== undefined) out.push(`${ind}bandwidth remaining ${b.remainingPercent} (%)`);
    else if (b.percent !== undefined) out.push(`${ind}bandwidth ${b.percent} (%)`);
    else if (b.kbps !== undefined) out.push(`${ind}bandwidth ${b.kbps} (kbps)`);
  }
  if (c.shapeAverage) {
    out.push(`${ind}Average Rate Traffic Shaping`);
    out.push(c.shapeAverage.percent !== undefined ? `${ind}cir ${c.shapeAverage.percent}%` : `${ind}cir ${c.shapeAverage.bps} (bps)`);
  }
  if (c.fairQueue) out.push(`${ind}fair-queue`);
  if (c.queueLimit !== undefined) out.push(`${ind}queue-limit ${c.queueLimit} packets`);
  if (c.servicePolicy) out.push(`${ind}service-policy ${c.servicePolicy}`);
  for (const x of c.extraLines ?? []) if (x.trim()) out.push(`${ind}${x.trim()}`);
  return out;
}
export function showPolicyMap(dev: IosDevice, only?: string): string {
  const out: string[] = [];
  for (const pm of dev.config.qos.policyMaps) {
    if (only && pm.name !== only) continue;
    out.push(`  Policy Map ${pm.name}`);
    if (pm.description) out.push(`    Description: ${pm.description}`);
    for (const c of ordered(pm)) {
      out.push(`    Class ${c.className}`);
      out.push(...actionLines(c, '      '));
    }
    out.push('');
  }
  if (only && !out.length) return `Policy Map ${only} not found`;
  return joinLines(out);
}

// ───────────────────────────── show policy-map interface ─────────────────────────────
function hasQueueing(dev: IosDevice, pm: PolicyMap): boolean {
  return pm.classes.some((c) => c.priority || c.bandwidth || c.fairQueue || c.shapeAverage || c.queueLimit !== undefined || !!c.servicePolicy);
}
function shapeBps(c: PolicyClass, baseKbps: number): number | undefined {
  if (!c.shapeAverage) return undefined;
  if (c.shapeAverage.bps !== undefined) return c.shapeAverage.bps;
  if (c.shapeAverage.percent !== undefined) return Math.round(baseKbps * 1000 * c.shapeAverage.percent / 100);
  return undefined;
}
function matchLines(dev: IosDevice, className: string, ind: string): string[] {
  if (className === 'class-default') return [`${ind}Match: any `];
  const cm = dev.config.qos.classMaps.find((x) => x.name === className);
  if (!cm) return [];
  return cm.matches.map((m) => `${ind}Match: ${matchWords(m, true)}`);
}

type Counter = (path: string, className: string) => { packets: number; bytes: number };

function policyLines(count: Counter, dev: IosDevice, pm: PolicyMap, path: string, baseKbps: number, ind: string, depth: number): string[] {
  const out: string[] = [];
  const classes = ordered(pm);
  if (!classes.some((c) => c.className === 'class-default')) classes.push({ className: 'class-default' });
  const queueing = hasQueueing(dev, pm);
  const prio = classes.filter((c) => c.priority);
  if (prio.length) {
    const pk = prio.reduce((n, c) => n + count(path, c.className).packets, 0);
    const by = prio.reduce((n, c) => n + count(path, c.className).bytes, 0);
    out.push(`${ind}queue stats for all priority classes:`, `${ind}  Queueing`, `${ind}  queue limit 512 packets`,
      `${ind}  (queue depth/total drops/no-buffer drops) 0/0/0`, `${ind}  (pkts output/bytes output) ${pk}/${by}`, '');
  }
  for (const c of classes) {
    const cnt = count(path, c.className);
    const cm = dev.config.qos.classMaps.find((x) => x.name === c.className);
    const type = c.className === 'class-default' ? 'match-any' : cm?.matchType ?? 'match-all';
    const i2 = ind + '  ';
    out.push(`${ind}Class-map: ${c.className} (${type})  `);
    out.push(`${i2}${cnt.packets} packets, ${cnt.bytes} bytes`);
    out.push(`${i2}5 minute offered rate 0000 bps, drop rate 0000 bps`);
    out.push(...matchLines(dev, c.className, i2));
    if (c.police) {
      out.push(`${i2}police:`, `${i2}    cir ${c.police.bps} bps, bc ${Math.max(1500, Math.floor(c.police.bps / 32))} bytes`,
        `${i2}  conformed ${cnt.packets} packets, ${cnt.bytes} bytes; actions:`, `${i2}    transmit `,
        `${i2}  exceeded 0 packets, 0 bytes; actions:`, `${i2}    drop `, `${i2}  conformed 0000 bps, exceeded 0000 bps`);
    }
    if (c.priority) {
      const kbps = c.priority.kbps ?? (c.priority.percent !== undefined ? Math.round(baseKbps * c.priority.percent / 100) : undefined);
      const burst = c.priority.burstBytes ?? Math.max(1500, Math.round((kbps ?? 0) * 1000 * 0.2 / 8));
      out.push(kbps !== undefined ? `${i2}Priority: ${kbps} kbps, burst bytes ${burst}, b/w exceed drops: 0` : `${i2}Priority: Strict, b/w exceed drops: 0`);
      out.push('');
    } else if (queueing && (c.bandwidth || c.fairQueue || c.shapeAverage || c.queueLimit !== undefined || c.className === 'class-default' || c.servicePolicy)) {
      out.push(`${i2}Queueing`);
      out.push(`${i2}queue limit ${c.queueLimit ?? 64} packets`);
      out.push(c.fairQueue ? `${i2}(queue depth/total drops/no-buffer drops/flowdrops) 0/0/0/0` : `${i2}(queue depth/total drops/no-buffer drops) 0/0/0`);
      out.push(`${i2}(pkts output/bytes output) ${cnt.packets}/${cnt.bytes}`);
      if (c.bandwidth) {
        const b = c.bandwidth;
        if (b.remainingPercent !== undefined) out.push(`${i2}bandwidth remaining ${b.remainingPercent}%`);
        else if (b.percent !== undefined) out.push(`${i2}bandwidth ${b.percent}% (${Math.round(baseKbps * b.percent / 100)} kbps)`);
        else if (b.kbps !== undefined) out.push(`${i2}bandwidth ${b.kbps} kbps`);
      }
      const shaped = shapeBps(c, baseKbps);
      if (shaped !== undefined) {
        const bc = Math.floor(shaped / 250);
        out.push(`${i2}shape (average) cir ${shaped}, bc ${bc}, be ${bc}`);
        out.push(`${i2}target shape rate ${shaped}`);
      }
      if (c.fairQueue) out.push(`${i2}Fair-queue: per-flow queue limit 16 packets`);
    }
    if (c.setDscp) out.push(`${i2}QoS Set`, `${i2}  dscp ${c.setDscp}`, `${i2}    Marker statistics: Disabled`);
    const child = c.servicePolicy ? dev.config.qos.policyMaps.find((p) => p.name === c.servicePolicy) : undefined;
    if (c.servicePolicy && depth < 2) {
      out.push('');
      out.push(`${i2}Service-policy : ${c.servicePolicy}`);
      if (child) {
        out.push('');
        const shaped = shapeBps(c, baseKbps);
        out.push(...policyLines(count, dev, child, `${path}/${child.name}`, shaped !== undefined ? shaped / 1000 : baseKbps, i2 + '  ', depth + 1));
      } else out.push(`${i2}  (policy-map ${c.servicePolicy} is not defined)`);
    }
    if (!c.priority) out.push('');
  }
  return out;
}

export function policyMapInterface(world: World, dev: IosDevice, only?: string, dir?: 'input' | 'output'): string {
  const out: string[] = [];
  const names = only ? [only] : ifOrder(dev);
  for (const ifName of names) {
    const ifc = dev.config.interfaces[ifName];
    if (!ifc) continue;
    const blocks: { word: string; name: string }[] = [];
    if (ifc.servicePolicyIn && dir !== 'output') blocks.push({ word: 'input', name: ifc.servicePolicyIn });
    if (ifc.servicePolicyOut && dir !== 'input') blocks.push({ word: 'output', name: ifc.servicePolicyOut });
    if (!blocks.length) continue;
    out.push(` ${ifName} `, '');
    for (const b of blocks) {
      out.push(`  Service-policy ${b.word}: ${b.name}`, '');
      const pm = dev.config.qos.policyMaps.find((p) => p.name === b.name);
      if (!pm) { out.push(`    policy-map ${b.name} is not defined`, ''); continue; }
      // input policies classify nothing in the simulator: their classes show zero counters
      const count: Counter = b.word === 'input' ? () => ({ packets: 0, bytes: 0 }) : (path, cls) => qosCounter(world, dev.id, ifName, path, cls);
      out.push(...policyLines(count, dev, pm, pm.name, bandwidthKbps(ifc, ifName), '    ', 0));
    }
  }
  return joinLines(out);
}
