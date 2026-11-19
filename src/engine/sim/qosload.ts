/**
 * "What happens when the link is full?" — a fluid model of the output policy of one interface, for the QoS learning tool.
 * Each offered flow is classified like a real packet of that flow (on a copy of the world). The link capacity, capped
 * by any configured shaper, is divided: priority classes first (up to their rate), then each bandwidth guarantee;
 * the rest is shared by weight (bandwidth classes by their rate, class-default by the unreserved rest). Inside a fair-queue
 * class the flows get equal shares; inside other classes they share in proportion to what they send.
 * This is an approximation of LLQ/CBWFQ good enough to show guarantees and starvation, not a packet-level scheduler.
 */
import type { World } from '../types.ts';
import type { QosLoadResult, QosLoadSpec } from '../labapi.ts';
import { probeFlow } from './flow.ts';
import type { QosPlanClass } from './model.ts';
import { qosPlan } from './qos.ts';
import { rateText } from './text.ts';

const round1 = (n: number): number => Math.round(n * 10) / 10;

function treatmentText(c: QosPlanClass): string {
  switch (c.treatment) {
    case 'priority': return c.kbps !== undefined ? `priority ${rateText(c.kbps * 1000)}` : 'priority';
    case 'bandwidth': return c.kbps !== undefined ? `bandwidth ${rateText(c.kbps * 1000)} guaranteed` : 'bandwidth guaranteed';
    case 'fair-queue': return 'fair-queue (WFQ)';
    case 'default': return 'best effort';
  }
}

/** Give `amount` to demands, never more than each asks; shares follow `weights`. Returns what each got. */
function waterFill(demands: number[], weights: number[], amount: number): number[] {
  const got = demands.map(() => 0);
  let left = amount;
  for (let round = 0; round < 50 && left > 1e-9; round++) {
    const open = demands.map((d, i) => (d - got[i] > 1e-9 ? i : -1)).filter((i) => i >= 0);
    if (open.length === 0) break;
    const totalW = open.reduce((s, i) => s + weights[i], 0);
    if (totalW <= 0) break;
    let used = 0;
    for (const i of open) {
      const give = Math.min(demands[i] - got[i], left * weights[i] / totalW);
      got[i] += give;
      used += give;
    }
    left -= used;
    if (used < 1e-9) break;
  }
  return got;
}

export function qosLoad(world: World, spec: QosLoadSpec): QosLoadResult {
  const plan = qosPlan(world, spec.deviceId, spec.iface);
  const linkKbps = plan.physicalBps / 1000;
  const shapedKbps = Math.min(linkKbps, (plan.shapedBps ?? plan.physicalBps) / 1000);

  interface Row { label: string; offered: number; cls?: QosPlanClass; className: string; treatment: string; crossed: boolean; delivered: number }
  const rows: Row[] = spec.offered.map((o) => {
    const flow = probeFlow(world, o.flow);
    const deliveries = [flow.forward, ...(flow.reverse ? [flow.reverse] : [])];
    const crossing = deliveries.find((d) => d.steps.some((s) => s.deviceId === spec.deviceId && s.stage === 'egress' && s.iface === spec.iface));
    const row: Row = { label: o.label, offered: Math.max(0, o.kbps), className: '—', treatment: '', crossed: !!crossing, delivered: 0 };
    if (!crossing) {
      row.treatment = `does not leave through ${spec.iface}${flow.forward.ok ? '' : `: ${flow.forward.reasonText ?? 'dropped earlier'}`}`;
      return row;
    }
    const q = crossing.qos.find((x) => x.deviceId === spec.deviceId && x.iface === spec.iface);
    if (!q) { row.className = '(no policy)'; row.treatment = 'first in, first out'; return row; }
    const leaf = q.childClass ?? q.className;
    const policy = q.childPolicy ?? q.policy;
    row.cls = plan.classes.find((c) => c.className === leaf && c.policy === policy);
    row.className = leaf;
    row.treatment = row.cls ? treatmentText(row.cls) : 'best effort';
    return row;
  });

  const live = rows.filter((r) => r.crossed);
  const total = live.reduce((s, r) => s + r.offered, 0);
  if (total <= shapedKbps + 1e-9) {
    for (const r of live) r.delivered = r.offered;
  } else if (!plan.attached) {
    // one queue: everybody loses the same fraction
    for (const r of live) r.delivered = r.offered * shapedKbps / total;
  } else {
    // group rows by class
    const groups = new Map<string, Row[]>();
    for (const r of live) { const g = groups.get(r.className); if (g) g.push(r); else groups.set(r.className, [r]); }
    const names = [...groups.keys()];
    const demand = names.map((n) => groups.get(n)!.reduce((s, r) => s + r.offered, 0));
    const cls = names.map((n) => groups.get(n)![0].cls);
    const got = names.map(() => 0);
    let left = shapedKbps;
    // 1. priority classes: served first, limited to their rate when the link is congested
    names.forEach((_, i) => {
      if (cls[i]?.treatment !== 'priority') return;
      const give = Math.min(demand[i], cls[i]?.kbps ?? demand[i], left);
      got[i] = give;
      left -= give;
    });
    // 2. guaranteed minimum of the bandwidth classes (scaled down if they do not fit)
    const guar = names.map((_, i) => (cls[i]?.treatment === 'bandwidth' ? Math.min(demand[i], cls[i]?.kbps ?? 0) : 0));
    const guarSum = guar.reduce((s, x) => s + x, 0);
    const scale = guarSum > left && guarSum > 0 ? left / guarSum : 1;
    names.forEach((_, i) => { got[i] += guar[i] * scale; });
    left -= guarSum * scale;
    // 3. the rest is shared by weight among classes that still want more (priority classes get no extra)
    const reserved = plan.classes.reduce((s, c) => s + (c.treatment === 'priority' || c.treatment === 'bandwidth' ? (c.kbps ?? 0) : 0), 0);
    const defaultWeight = Math.max(shapedKbps * 0.01, shapedKbps - reserved);
    const weights = names.map((_, i) => (cls[i]?.treatment === 'priority' ? 0 : cls[i]?.treatment === 'bandwidth' ? Math.max(cls[i]?.kbps ?? 0, shapedKbps * 0.01) : defaultWeight));
    const want = names.map((_, i) => (cls[i]?.treatment === 'priority' ? 0 : demand[i] - got[i]));
    const extra = waterFill(want, weights, Math.max(0, left));
    names.forEach((_, i) => { got[i] += extra[i]; });
    // inside a class: fair-queue = equal shares per flow, otherwise in proportion to the offered rate
    names.forEach((n, i) => {
      const members = groups.get(n)!;
      if (cls[i]?.treatment === 'fair-queue') {
        const share = waterFill(members.map((r) => r.offered), members.map(() => 1), got[i]);
        members.forEach((r, k) => { r.delivered = share[k]; });
      } else {
        for (const r of members) r.delivered = demand[i] > 0 ? got[i] * r.offered / demand[i] : 0;
      }
    });
  }

  return {
    ok: plan.attached,
    message: plan.attached ? undefined : plan.problem,
    linkKbps: round1(linkKbps),
    shapedKbps: round1(shapedKbps),
    rows: rows.map((r) => ({ label: r.label, className: r.className, treatment: r.treatment, offeredKbps: round1(r.offered), deliveredKbps: round1(r.delivered) })),
  };
}
