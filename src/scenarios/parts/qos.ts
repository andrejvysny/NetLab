/**
 * QoS on the WAN link: link speed, a two-level policy (parent shaper, child LLQ with a priority class,
 * a guaranteed class and fair queueing for the rest), applied outbound on both routers. Owned by the scenario agent.
 */
import { shortIfName } from '../../engine/ip.ts';
import { interfaceState, qosPlan, serialClock } from '../../engine/sim/index.ts';
import type { QosPlanClass } from '../../engine/sim/index.ts';
import type { CheckDef, Outcome, ReqDef } from '../checks.ts';
import { bad, flowTrace, missing, ok, reqPasses } from '../checks.ts';
import type { Env } from '../env.ts';
import { arrivedAt } from '../env.ts';
import type { QosOpts, Spec, Svc } from '../spec.ts';
import { SVC, clockFits, has, joinAnd, svcAclLines, svcShort } from '../spec.ts';
import { IKE } from './ipsec.ts';
import { clockInBasics } from './base.ts';
import type { Built, Probe } from './common.ts';
import { T, block, cfgAction, emptyBuilt, runProbe, sentence } from './common.ts';

export const QOS = { child: 'output_QE', parent: 'output_SE', cPrio: 'classPriority', cGuar: 'classGuaranteed', aPrio: 'matchPriority', aGuar: 'matchGuaranteed' };
const QOS_TIP = 'Send some traffic, then run show policy-map interface on the WAN interface. The counters show which class each packet lands in.';

export function qosConfig(s: Spec): Record<string, string[]> {
  const q = s.qos as QosOpts;
  const common = [
    ...block(`ip access-list extended ${QOS.aPrio}`, svcAclLines(q.priority.services)),
    ...block(`ip access-list extended ${QOS.aGuar}`, svcAclLines(q.guaranteed.services)),
    ...block(`class-map match-all ${QOS.cPrio}`, [`match access-group name ${QOS.aPrio}`]),
    ...block(`class-map match-all ${QOS.cGuar}`, [`match access-group name ${QOS.aGuar}`]),
    `policy-map ${QOS.child}`,
    ` class ${QOS.cPrio}`, `  priority ${q.priority.kbps}`,
    ` class ${QOS.cGuar}`, `  bandwidth ${q.guaranteed.kbps}`,
    ' class class-default', '  fair-queue',
    `policy-map ${QOS.parent}`,
    ' class class-default', s.wan === 'serial' ? `  shape average percent ${q.shapePercent}` : `  shape average ${targetBps(q)}`, `  service-policy ${QOS.child}`,
  ];
  const tail = has(s, 'ipsec') ? block(`crypto map ${IKE.map} 10 ipsec-isakmp`, ['qos pre-classify']) : [];
  const clock = s.wan === 'serial' && !clockInBasics(s) ? [`clock rate ${q.linkKbps * 1000}`] : [];
  const one = (wanIf: string, dce: boolean): string[] => [
    ...common,
    ...block(`interface ${wanIf}`, [...(s.wan === 'serial' ? [`bandwidth ${q.linkKbps}`] : []), ...(dce ? clock : []), `service-policy output ${QOS.parent}`]),
    ...tail,
  ];
  return { R1: one(s.ports.r1Wan, true), R2: one(s.ports.r2Wan, false) };
}

function targetBps(q: QosOpts): number { return Math.round(q.linkKbps * 1000 * q.shapePercent / 100); }

interface Landing { cls?: QosPlanClass; top?: { policy: string; className: string }; why: string; tip: string; trace?: ReturnType<typeof flowTrace> }
/** The leaf class of the output policy on `router`'s WAN interface that a probe lands in. */
function landing(env: Env, p: Probe, router: 'R1' | 'R2'): Landing {
  const wanIf = router === 'R1' ? env.roles.r1Wan : env.roles.r2Wan;
  if (!wanIf) return { why: `${router} has no cabled WAN interface yet.`, tip: 'Cable the WAN link first.' };
  const f = runProbe(env, p);
  if (!f) return { why: p.to.gap, tip: QOS_TIP };
  if (!arrivedAt(f, p.to.dev)) return { why: `The request does not reach ${p.to.name}. ${f.summary}`,
    tip: 'First make this traffic cross the WAN successfully. Check links, routing, filtering and the tunnel.', trace: flowTrace(f) };
  const plan = env.memo(`qos-plan:${router}:${wanIf}`, () => qosPlan(env.world, router, wanIf));
  const q = f.forward.qos.find((x) => x.deviceId === router && x.iface === wanIf);
  if (!q) {
    const left = f.forward.steps.some((x) => x.deviceId === router && x.stage === 'egress' && x.iface === wanIf);
    if (!left) return { why: `The packet never leaves ${router} on the WAN link. ${f.summary}`, tip: 'This packet is lost before QoS sees it. Solve that first: look at the path of the packet.', trace: flowTrace(f) };
    return {
      why: plan.problem ?? `No output policy classifies packets on ${router} ${shortIfName(wanIf)}.`,
      tip: `Attach the parent policy to the WAN interface of ${router}: service-policy output <name>.`, trace: flowTrace(f),
    };
  }
  const cls = plan.classes.find((c) => c.policy === (q.childPolicy ?? q.policy) && c.className === (q.childClass ?? q.className));
  return { cls, top: { policy: q.policy, className: q.className }, why: cls ? '' : 'The packet is classified, but the class has no settings.', tip: QOS_TIP, trace: flowTrace(f) };
}
function classText(c: QosPlanClass): string {
  const rate = c.kbps !== undefined ? ` ${Number(c.kbps.toFixed(1))} kbit/s` : '';
  const how = c.treatment === 'priority' ? `priority${rate}` : c.treatment === 'bandwidth' ? `bandwidth${rate}` : c.treatment === 'fair-queue' ? 'fair-queue' : 'no queueing command';
  return `class ${c.className} of ${c.policy} (${how})`;
}
function svcProbes(env: Env, router: 'R1' | 'R2', list: Svc[]): Probe[] {
  const out: Probe[] = [];
  for (const svc of list) {
    const info = SVC[svc];
    const ports: (number | undefined)[] = info.proto === 'icmp' ? [undefined] : info.ports;
    for (const port of ports) {
      const p: Probe = router === 'R1' ? { from: 'PC1', to: T.r2Wan(env), proto: info.proto, port } : { from: 'R2', to: T.r1Wan(env), proto: info.proto, port };
      out.push(p);
      if (port !== undefined) out.push({ ...p, sport: port, port: 45678 });
    }
  }
  return out;
}

export function qosPart(s: Spec): Built {
  const b = emptyBuilt('qos');
  const q = s.qos as QosOpts;
  b.config = qosConfig(s);
  const shaped = targetBps(q);
  const rest = (Object.keys(SVC) as Svc[]).filter((x) => !q.priority.services.includes(x) && !q.guaranteed.services.includes(x));
  const restProbes = (env: Env, router: 'R1' | 'R2'): Probe[] => [
    ...svcProbes(env, router, rest),
    ...(['tcp', 'udp'] as const).map((proto) => router === 'R1'
      ? { from: 'PC1', to: T.r2Wan(env), proto, port: 40961 } : { from: 'R2', to: T.r1Wan(env), proto, port: 40961 }),
  ];
  const checks: CheckDef[] = [];

  if (s.wan === 'serial') {
    checks.push({
      id: 'clock', label: `The serial link runs at ${q.linkKbps} kbit/s (clock rate on the DCE end)`,
      run(env) {
        const expected = `The DCE end of the serial cable has clock rate ${q.linkKbps * 1000} (or the nearest value the router offers).`;
        if (!env.roles.r1Wan) return missing(expected, 'R1 and R2 are not joined by a cable yet.', 'Cable the WAN link first.');
        const c = serialClock(env.world, 'R1', env.roles.r1Wan);
        if (!c) return bad(expected, 'The link between the routers is not a serial link.', 'Only a serial link has a clock rate.');
        const state = interfaceState(env.world, 'R1', env.roles.r1Wan);
        if (state.status !== 'up' || state.protocol !== 'up') return bad(expected, `The serial link is ${state.status}/${state.protocol}.`, 'Bring up both WAN interfaces before testing the clock.');
        const where = `${c.dceDeviceId} ${shortIfName(c.dceIf)} is the DCE end`;
        if (!clockFits(c.configured, q.linkKbps * 1000)) {
          return bad(expected, `${where}. Its clock rate is ${c.configured ?? 'not set, so the port runs at its default speed'}.`,
            `Enter clock rate ${q.linkKbps * 1000} on the DCE interface. show controllers tells you which end is DCE.`);
        }
        return ok(expected, `${where} with clock rate ${c.configured}.`);
      },
    });
  }
  for (const router of ['R1', 'R2'] as const) {
    const id = router.toLowerCase();
    const classCheck = (kind: 'priority' | 'bandwidth', list: Svc[], kbps: number): CheckDef => ({
      id: `${id}-${kind === 'priority' ? 'priority' : 'guaranteed'}`,
      label: kind === 'priority'
        ? `${router} sends ${joinAnd(list.map(svcShort))} through the priority queue with ${kbps} kbit/s`
        : `${router} guarantees ${joinAnd(list.map(svcShort))} at least ${kbps} kbit/s`,
      run(env) {
        const expected = kind === 'priority'
          ? `Packets of ${joinAnd(list.map(svcShort))} that leave ${router} on the WAN link land in a class with priority ${kbps}.`
          : `Packets of ${joinAnd(list.map(svcShort))} that leave ${router} on the WAN link land in a class guaranteeing at least ${kbps} kbit/s.`;
        const seen: string[] = [];
        for (const p of svcProbes(env, router, list)) {
          const l = landing(env, p, router);
          if (!l.cls) return bad(expected, `${sentence(p)}: ${l.why}`, l.tip, l.trace);
          seen.push(`${sentence(p)}: ${classText(l.cls)}.`);
          const rate = l.cls.kbps ?? -1;
          const good = l.cls.treatment === kind && (kind === 'priority' ? Math.abs(rate - kbps) < 0.01 : rate >= kbps - 0.01)
            && (l.cls.policeBps === undefined || l.cls.policeBps >= kbps * 1000);
          if (!good) {
            const tip = l.cls.className === 'class-default' || l.cls.treatment === 'fair-queue'
              ? `The class-map does not match this traffic. Check its access list. If the traffic is encrypted, the crypto map entry also needs qos pre-classify.`
              : `In the child policy the class needs ${kind === 'priority' ? 'priority' : 'at least a bandwidth of'} ${kbps} kbit/s without a lower policer cap.`;
            return bad(expected, seen.join(' '), tip, l.trace);
          }
        }
        return ok(expected, seen.join(' '));
      },
    });
    checks.push(classCheck('priority', q.priority.services, q.priority.kbps));
    checks.push(classCheck('bandwidth', q.guaranteed.services, q.guaranteed.kbps));
    checks.push({
      id: `${id}-rest`, label: `${router} lets all other traffic share the rest fairly (WFQ)`,
      run(env): Outcome {
        const expected = `Other traffic, including unlisted TCP and UDP ports, uses a fair queue on ${router}.`;
        for (const p of restProbes(env, router)) {
          const l = landing(env, p, router);
          if (!l.cls) return bad(expected, `${sentence(p)}: ${l.why}`, l.tip, l.trace);
          if (l.cls.treatment !== 'fair-queue') return bad(expected, `${sentence(p)} uses ${classText(l.cls)}.`,
            'Match only the assigned priority and guaranteed traffic. Give all other traffic fair-queue.', l.trace);
        }
        return ok(expected, `The tested unmatched traffic uses fair-queue on ${router}.`);
      },
    });
    checks.push({
      id: `${id}-shape`, label: `${router} shapes everything to ${q.shapePercent} % of ${q.linkKbps} kbit/s`,
      run(env) {
        const wanIf = router === 'R1' ? env.roles.r1Wan : env.roles.r2Wan;
        const clock = wanIf && s.wan === 'serial' ? serialClock(env.world, router, wanIf)?.configured : undefined;
        const reference = clock !== undefined && clockFits(clock, q.linkKbps * 1000) ? clock : q.linkKbps * 1000;
        const target = Math.round(reference * q.shapePercent / 100);
        const expected = `The output policy on ${router}'s WAN interface shapes all traffic to ${target / 1000} kbit/s (${q.shapePercent} % of ${reference / 1000}).`;
        if (!wanIf) return missing(expected, `${router} has no cabled WAN interface yet.`, 'Cable the WAN link first.');
        const plan = env.memo(`qos-plan:${router}:${wanIf}`, () => qosPlan(env.world, router, wanIf));
        if (!plan.attached) return bad(expected, plan.problem ?? 'No output policy is attached.', `Attach the parent policy with service-policy output on ${router}'s WAN interface.`);
        if (plan.shapedBps === undefined || !plan.shaper) {
          return bad(expected, `The attached policy ${plan.policy ?? ''} has no shaper.`,
            'Attach the parent policy, not the child policy. The parent has one class, class-default, with shape average percent and the child policy inside it.');
        }
        const seen = `The shaper is ${plan.shaper.text}.`;
        if (Math.abs(plan.shapedBps - target) > 1) {
          return bad(expected, seen, s.wan === 'serial'
            ? `Set the effective rate to ${target} bit/s. For a percentage shaper, set bandwidth ${reference / 1000} on this serial interface.`
            : `Set the effective rate to ${target} bit/s, e.g. shape average ${target}. Ethernet physical speed stays unchanged.`);
        }
        const dev = router === 'R1' ? env.r1 : env.r2;
        const parentClass = dev?.config.qos.policyMaps.find((p) => p.name === plan.shaper?.policy)?.classes.find((c) => c.className === plan.shaper?.className);
        if (parentClass?.police && parentClass.police.bps < target) {
          return bad(expected, `${seen} A policer further caps this class to ${parentClass.police.bps} bit/s.`, 'Remove the lower cap on the shaper class, or set it to the intended effective rate.');
        }
        const allocated = plan.classes.filter((c) => c.parentClass === plan.shaper?.className && c.parentPolicy === plan.shaper?.policy)
          .reduce((sum, c) => sum + (c.kbps ?? 0), 0);
        if (allocated >= target / 1000) return bad(expected, `${seen} The configured guarantees reserve ${allocated} kbit/s, leaving no capacity for other traffic.`, 'Leave part of the shaped capacity for the fair queue.');
        for (const p of [...svcProbes(env, router, [...q.priority.services, ...q.guaranteed.services]), ...restProbes(env, router)]) {
          const l = landing(env, p, router);
          if (!l.top || !l.cls) return bad(expected, `${sentence(p)}: ${l.why}`, l.tip, l.trace);
          if (l.top.policy !== plan.shaper.policy || l.top.className !== plan.shaper.className) {
            return bad(expected, `${seen} ${sentence(p)} uses an unshaped class (${l.top.className}).`, 'Put the shaper into class class-default of the parent policy, and nest the child policy there.', l.trace);
          }
        }
        return ok(expected, seen);
      },
    });
  }
  const req: ReqDef = {
    id: 'qos', title: `QoS on the WAN link: ${q.linkKbps} kbit/s, priority ${q.priority.kbps}, guarantee ${q.guaranteed.kbps}, WFQ, shape ${q.shapePercent} %`, feature: 'qos', points: 5, checks,
  };
  b.requirements = [req];
  const speed = s.wan === 'serial'
    ? `Set the link speed: clock rate ${q.linkKbps * 1000} on the DCE end and bandwidth ${q.linkKbps} on both WAN interfaces.`
    : `On Ethernet, leave the PHY speed alone; use ${q.linkKbps} kbit/s as a reference for the shaper.`;
  b.steps = [{
    id: 'qos', title: 'QoS on the WAN link, both directions', feature: 'qos', devices: ['R1', 'R2'],
    goal: `${speed} Then add the output policy on both routers: priority ${q.priority.kbps} for ${joinAnd(q.priority.services.map(svcShort))}, guaranteed ${q.guaranteed.kbps} for ${joinAnd(q.guaranteed.services.map(svcShort))}, fair sharing for the rest, all shaped to ${q.shapePercent} %.`,
    why: 'On a slow link the important traffic must not wait behind big downloads. Each router can only control what it sends, so both routers need the policy.',
    hint: `Use a child policy for the queues and a parent shaper on WAN output.${has(s, 'ipsec') ? ' When the hardware sees ESP, enable pre-classification in the active crypto-map entry to classify the original ICMP and service ports.' : ''}${s.wan === 'ethernet' ? ` The target is ${shaped} bit/s, not an Ethernet speed or clock setting.` : ''}`,
    allows: ['qos', 'acl', 'interface', 'ipsec', 'console', 'pc'],
    script: [
      cfgAction('R1', b.config.R1),
      cfgAction('R2', b.config.R2),
      { kind: 'note', text: 'Check on both routers: show policy-map interface. Ping across the link and watch the counters.' },
    ],
    done: (env) => reqPasses(env, req),
  }];
  return b;
}
