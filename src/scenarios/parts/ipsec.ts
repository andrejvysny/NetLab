/**
 * IPsec between R1 and R2 (IKEv1, crypto map on the WAN interfaces). Case study: only the listed services are encrypted,
 * for any address. Course lab: everything between LAN1 and LAN2. Owned by the scenario agent.
 */
import { interfaceState } from '../../engine/sim/index.ts';
import type { SimFlowResult } from '../../engine/sim/index.ts';
import type { CheckDef, Outcome, ReqDef } from '../checks.ts';
import { bad, flowTrace, missing, ok, reqPasses } from '../checks.ts';
import type { Env } from '../env.ts';
import { arrivedAt, wireForm } from '../env.ts';
import type { Spec, Svc } from '../spec.ts';
import { SVC, joinAnd, model, svcAclLines, svcShort, wildOf } from '../spec.ts';
import type { Built, Probe } from './common.ts';
import { T, block, cfgAction, emptyBuilt, runProbe, sentence } from './common.ts';

export const IKE = { key: 'KSS123', acl: '120', ts: 'TS', map: 'CM' };
const IPSEC_TIP = 'Run show crypto isakmp sa and show crypto ipsec sa on both routers after a ping. Compare policy, key, peer address and the crypto access list of both sides.';

export function ipsecConfig(s: Spec): Record<string, string[]> {
  const m = model(s);
  const a = s.addr;
  const opts = s.ipsec ?? { mode: 'lans' as const };
  const aclFor = (local: 'R1' | 'R2'): string[] => {
    if (opts.mode === 'services') return svcAclLines(opts.services).map((l) => `access-list ${IKE.acl} ${l}`);
    const l1 = `${a.lan1.net} ${wildOf(a.lan1)}`;
    const l2 = `${a.lan2.net} ${wildOf(a.lan2)}`;
    return [`access-list ${IKE.acl} permit ip ${local === 'R1' ? `${l1} ${l2}` : `${l2} ${l1}`}`];
  };
  const one = (local: 'R1' | 'R2', peer: string, wanIf: string): string[] => [
    ...block('crypto isakmp policy 10', ['encryption aes', 'hash sha256', 'authentication pre-share', 'group 14']),
    `crypto isakmp key ${IKE.key} address ${peer}`,
    ...block(`crypto ipsec transform-set ${IKE.ts} esp-aes esp-sha-hmac`, ['mode tunnel']),
    ...aclFor(local),
    ...block(`crypto map ${IKE.map} 10 ipsec-isakmp`, [`set peer ${peer}`, `set transform-set ${IKE.ts}`, `match address ${IKE.acl}`]),
    ...block(`interface ${wanIf}`, [`crypto map ${IKE.map}`]),
  ];
  return { R1: one('R1', m.r2Wan, s.ports.r1Wan), R2: one('R2', m.r1Wan, s.ports.r2Wan) };
}

function cap(t: string): string { return t.charAt(0).toUpperCase() + t.slice(1); }
type Form = 'esp' | 'clear' | 'none';
interface Crossing { f: SimFlowResult | null; fwd: Form; back: Form }
/** How a request (and its answer) looked on the WAN link. `via` is the router that sends the request onto the link. */
function crossing(env: Env, p: Probe, via: 'R1' | 'R2'): Crossing {
  const f = runProbe(env, p);
  if (!f) return { f: null, fwd: 'none', back: 'none' };
  const out = via === 'R1' ? env.roles.r1Wan : env.roles.r2Wan;
  const other = via === 'R1' ? 'R2' : 'R1';
  const back = via === 'R1' ? env.roles.r2Wan : env.roles.r1Wan;
  return { f, fwd: wireForm(f.forward.steps, via, out), back: f.reverse ? wireForm(f.reverse.steps, other, back) : 'none' };
}
function formWord(x: Form): string { return x === 'esp' ? 'encrypted (ESP)' : x === 'clear' ? 'not encrypted' : 'not sent over the link'; }

interface SvcProbe { p: Probe; via: 'R1' | 'R2'; needBack: boolean }
function probesFor(env: Env, svc: Svc): SvcProbe[] {
  const info = SVC[svc];
  const out: SvcProbe[] = [];
  const ports: (number | undefined)[] = info.proto === 'icmp' ? [undefined] : info.ports;
  for (const port of ports) {
    const needBack = info.proto !== 'udp';
    out.push({ p: { from: 'PC1', to: T.r2Wan(env), proto: info.proto, port }, via: 'R1', needBack });
    out.push({ p: { from: 'R2', to: T.r1Wan(env), proto: info.proto, port }, via: 'R2', needBack });
    // UDP 161/162 probes need not have a listener. Explicit source-port probes still exercise UDP replies,
    // and source-port TCP probes exercise the same selectors as a real response without requiring SSH setup.
    if (port !== undefined) {
      out.push({ p: { from: 'PC1', to: T.r2Wan(env), proto: info.proto, sport: port, port: 45678 }, via: 'R1', needBack: false });
      out.push({ p: { from: 'R2', to: T.r1Wan(env), proto: info.proto, sport: port, port: 45678 }, via: 'R2', needBack: false });
    }
    out.push({ p: { from: 'PC3', to: T.r1Wan(env), proto: info.proto, port }, via: 'R2', needBack });
    // Use another IP header on R1 without testing a flow that tasks 6/7 could intentionally prohibit.
    out.push({ p: { from: 'R1', to: T.r2Lan(env), proto: info.proto, port }, via: 'R1', needBack });
  }
  return out;
}
/** Every probe of the service must cross the WAN link inside ESP (the answer too, where one is expected). */
function mustBeEncrypted(env: Env, svc: Svc, tip: string): Outcome {
  const expected = `${cap(svcShort(svc))} crosses the WAN link inside ESP, from R1 to R2 and from R2 to R1.`;
  const seen: string[] = [];
  let lost: { text: string; f: SimFlowResult } | undefined;
  let clear: SimFlowResult | undefined;
  let last: SimFlowResult | null = null;
  for (const sp of probesFor(env, svc)) {
    // Do not flood the simulated WAN with a routing loop to a known-down address on R2.
    const lan = env.roles.r2Lan;
    if (sp.p.from === 'R1' && lan && sp.p.to.addr === env.a.r2Lan?.address && interfaceState(env.world, 'R2', lan).protocol !== 'up') {
      return bad(expected, `${sp.p.to.name} (${lan}) is not up.`, 'Bring up the R2 LAN interface before testing traffic to its address.');
    }
    const c = crossing(env, sp.p, sp.via);
    if (!c.f) return missing(expected, sp.p.to.gap, tip);
    last = c.f;
    const backText = sp.needBack ? `, answer ${formWord(c.back)}` : '';
    seen.push(`${sentence(sp.p)}: ${formWord(c.fwd)}${backText}.`);
    const delivered = arrivedAt(c.f, sp.p.to.dev) && (!sp.needBack || (c.f.reverse?.ok && c.f.reverse.atDeviceId === sp.p.from));
    const good = delivered && c.fwd === 'esp' && (!sp.needBack || c.back === 'esp');
    if (good) continue;
    if (!delivered || c.fwd === 'none' || (sp.needBack && c.back === 'none')) lost ??= { text: `${sentence(sp.p)} does not get through. ${c.f.summary}`, f: c.f };
    else clear ??= c.f;
  }
  // A packet that is lost says more than a list of what was not sent: show that reason alone.
  if (lost) return bad(expected, lost.text, 'First make the tunnel work for this traffic. Run show crypto isakmp sa and show crypto ipsec sa on both routers.', flowTrace(lost.f));
  if (clear) return bad(expected, seen.join(' '), tip, flowTrace(clear));
  return ok(expected, seen.join(' '), last ? flowTrace(last) : undefined);
}

function servicesPart(s: Spec, services: Svc[]): Built {
  const b = emptyBuilt('ipsec');
  b.config = ipsecConfig(s);
  const first = services[0];
  const tunnel: CheckDef = {
    id: 'tunnel', label: `The tunnel comes up: ${svcShort(first)} from PC1 to R2 travels encrypted and arrives`,
    run(env) {
      const sp = probesFor(env, first)[0];
      const expected = `${sentence(sp.p)} leaves R1 inside ESP and arrives at R2${sp.needBack ? ', with an encrypted response' : ''}.`;
      const c = crossing(env, sp.p, 'R1');
      if (!c.f) return missing(expected, sp.p.to.gap, IPSEC_TIP);
      const arrived = sp.p.proto === 'icmp' ? c.f.ok : arrivedAt(c.f, 'R2');
      if (c.fwd !== 'esp') return bad(expected, c.fwd === 'clear' ? 'The packet crosses the WAN link without encryption.' : c.f.summary, IPSEC_TIP, flowTrace(c.f));
      if (!arrived) return bad(expected, c.f.summary, IPSEC_TIP, flowTrace(c.f));
      if (sp.needBack && (c.back !== 'esp' || c.f.reverse?.atDeviceId !== sp.p.from || !c.f.reverse.ok)) return bad(expected, `The request is encrypted, but the answer is ${formWord(c.back)}.`, 'Each router needs both directions in its crypto access list, for example permit tcp any any eq telnet and permit tcp any eq telnet any.', flowTrace(c.f));
      return ok(expected, sp.needBack ? 'Request and answer both cross the WAN link inside ESP.' : 'The ESP request crosses the link and its inner packet reaches R2.', flowTrace(c.f));
    },
  };
  const perSvc: CheckDef[] = services.map((svc) => ({
    id: `enc-${svc}`, label: `${cap(svcShort(svc))} is encrypted in both directions`,
    run: (env) => mustBeEncrypted(env, svc, SVC[svc].proto === 'icmp'
      ? 'The crypto access list needs the line permit icmp any any on both routers.'
      : `The crypto access list must match ${svcShort(svc)} for any address, once with the port as destination and once with the port as source. Both routers need the same lines.`),
  }));
  const controls = (Object.keys(SVC) as Svc[]).filter((x) => !services.includes(x));
  const clear: CheckDef = {
    id: 'clear', label: 'Unlisted traffic crosses the WAN link in clear', needs: ['tunnel'],
    run(env) {
      const expected = 'Unlisted traffic, including ordinary TCP and UDP ports, reaches the far router without ESP.';
      const tip = 'Encrypt only the listed protocols. Match both source and destination service-port directions, but avoid a blanket permit ip, TCP or UDP.';
      const cases: SvcProbe[] = controls.flatMap((svc) => probesFor(env, svc).slice(0, SVC[svc].proto === 'icmp' ? 2 : 4));
      for (const [from, to, via] of [['PC1', T.r2Wan(env), 'R1'], ['R2', T.r1Wan(env), 'R2']] as const) {
        for (const proto of ['tcp', 'udp'] as const) cases.push({ p: { from, to, proto, port: 40961 }, via, needBack: proto === 'tcp' });
        cases.push({ p: { from: via, to, proto: 'udp', sport: 67, port: 67 }, via, needBack: false });
      }
      for (const sp of cases) {
        const c = crossing(env, sp.p, sp.via);
        if (!c.f) return missing(expected, sp.p.to.gap, IPSEC_TIP);
        if (c.fwd === 'esp' || (sp.needBack && c.back === 'esp')) return bad(expected, `${sentence(sp.p)}: it is encrypted too.`, tip, flowTrace(c.f));
        if (c.fwd !== 'clear' || !arrivedAt(c.f, sp.p.to.dev) || (sp.needBack && (c.back !== 'clear' || !c.f.reverse?.ok || c.f.reverse.atDeviceId !== sp.p.from))) {
          return bad(expected, `${sentence(sp.p)}: ${c.f.summary}`, tip, flowTrace(c.f));
        }
      }
      return ok(expected, 'The tested unlisted traffic reaches both routers in clear.');
    },
  };
  const req: ReqDef = {
    id: 'ipsec', title: `IPsec: ${joinAnd(services.map(svcShort))} are encrypted between R1 and R2`, feature: 'ipsec', points: 5,
    checks: [tunnel, ...perSvc, clear],
  };
  b.requirements = [req];
  b.steps = [ipsecStep(s, b.config, req,
    `Build an IPsec tunnel between R1 and R2 that encrypts only ${joinAnd(services.map(svcShort))}. Everything else crosses the link as before.`,
    'In the crypto access list, match the protocols for any address. A port needs two lines: once as destination, once as source.')];
  return b;
}

function lansPart(s: Spec): Built {
  const b = emptyBuilt('ipsec');
  b.config = ipsecConfig(s);
  const pair = (env: Env, p: Probe, via: 'R1' | 'R2', tip: string, needOk: boolean): Outcome => {
    const expected = `${sentence(p)} crosses the WAN link inside ESP${needOk ? ' and is answered' : ''}.`;
    const c = crossing(env, p, via);
    if (!c.f) return missing(expected, p.to.gap, tip);
    if (c.fwd !== 'esp') return bad(expected, c.fwd === 'clear' ? 'It crosses the WAN link without encryption.' : c.f.summary, tip, flowTrace(c.f));
    if (!arrivedAt(c.f, p.to.dev) || (needOk && !c.f.ok)) return bad(expected, c.f.summary, tip, flowTrace(c.f));
    if (c.f.reverse && c.back !== 'esp' && c.back !== 'none') return bad(expected, 'The request is encrypted, but the answer is not.', 'The crypto access list of R2 must be the mirror of the list of R1: source and destination swapped.', flowTrace(c.f));
    return ok(expected, 'Request and answer cross the WAN link inside ESP.', flowTrace(c.f));
  };
  const tunnel: CheckDef = { id: 'tunnel', label: 'The tunnel comes up: a ping from PC1 to PC3 travels encrypted', run: (env) => pair(env, { from: 'PC1', to: T.pc3(env), proto: 'icmp' }, 'R1', IPSEC_TIP, true) };
  const anyProto: CheckDef = {
    id: 'any-protocol', label: 'Every protocol between LAN1 and LAN2 is encrypted',
    run(env) {
      const a1 = pair(env, { from: 'PC1', to: T.pc3(env), proto: 'tcp', port: 80 }, 'R1', 'Match the protocol ip between the two LAN networks, not single protocols.', false);
      if (!a1.pass) return a1;
      return pair(env, { from: 'PC2', to: T.pc3(env), proto: 'udp', port: 69 }, 'R1', 'Match the whole LAN1 network as the source, not a single host.', false);
    },
  };
  const back: CheckDef = { id: 'back', label: 'A session started in LAN2 is encrypted too', run: (env) => pair(env, { from: 'PC3', to: T.pc1(env), proto: 'icmp' }, 'R2', 'R2 needs the mirrored crypto access list: LAN2 as source, LAN1 as destination.', true) };
  const clear: CheckDef = {
    id: 'clear', label: 'Traffic outside the two LANs is not encrypted and still works', needs: ['tunnel'],
    run(env) {
      const p: Probe = { from: 'PC1', to: T.r2Wan(env), proto: 'icmp' };
      const expected = `${sentence(p)} crosses the WAN link without encryption and is answered.`;
      const c = crossing(env, p, 'R1');
      if (!c.f) return missing(expected, p.to.gap, IPSEC_TIP);
      const tip = 'The crypto access list should name LAN1 and LAN2 only. With permit ip any any, everything is forced into the tunnel.';
      if (c.fwd === 'esp') return bad(expected, 'It is encrypted too.', tip, flowTrace(c.f));
      if (!c.f.ok) return bad(expected, c.f.summary, tip, flowTrace(c.f));
      return ok(expected, 'It crosses the link in clear and is answered.', flowTrace(c.f));
    },
  };
  const req: ReqDef = { id: 'ipsec', title: 'IPsec: everything between LAN1 and LAN2 is encrypted', feature: 'ipsec', points: 5, checks: [tunnel, anyProto, back, clear] };
  b.requirements = [req];
  b.steps = [ipsecStep(s, b.config, req,
    'Build an IPsec tunnel between R1 and R2 that encrypts all traffic between LAN1 and LAN2. Traffic to other addresses crosses the link as before.',
    'The crypto access list names IP traffic from the own LAN to the far LAN. The list on R2 is the mirror of the list on R1.')];
  return b;
}

function ipsecStep(s: Spec, config: Record<string, string[]>, req: ReqDef, goal: string, aclHint: string) {
  return {
    id: 'ipsec', title: 'IPsec tunnel between R1 and R2', feature: 'ipsec' as const, devices: ['R1', 'R2'],
    goal,
    why: 'The WAN link is not trusted. A tunnel hides the chosen traffic from anyone who listens on it.',
    hint: `Five building blocks on each router: ISAKMP policy, pre-shared key, transform set, crypto access list, crypto map. Then put the crypto map on the WAN interface. ${aclHint}`,
    allows: ['ipsec', 'acl', 'interface', 'console', 'pc'] as ('ipsec' | 'acl' | 'interface' | 'console' | 'pc')[],
    script: [
      cfgAction('R1', config.R1),
      cfgAction('R2', config.R2),
      { kind: 'note' as const, text: 'Check: ping across the WAN link. Then on both routers: show crypto isakmp sa and show crypto ipsec sa.' },
    ],
    done: (env: Env) => reqPasses(env, req),
  };
}

export function ipsecPart(s: Spec): Built {
  const o = s.ipsec ?? { mode: 'lans' as const };
  return o.mode === 'services' ? servicesPart(s, o.services) : lansPart(s);
}
