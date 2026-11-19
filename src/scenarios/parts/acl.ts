/**
 * Access lists. Case study: one extended list, inbound on R1's LAN interface, that carries the rules for PC1 and PC2.
 * Course lab: a standard list, an extended list and a named list. Owned by the scenario agent.
 */
import type { PcSetup } from '../../engine/types.ts';
import { networkOf } from '../../engine/ip.ts';
import type { CheckDef, Outcome, ReqDef } from '../checks.ts';
import { allOf, bad, flowTrace, missing, ok, reqPasses } from '../checks.ts';
import type { Env } from '../env.ts';
import { stoppedByAcl } from '../env.ts';
import type { Net, Spec, Svc } from '../spec.ts';
import { SVC, dhcpClients, joinAnd, lastHost, model, svcShort, wildOf } from '../spec.ts';
import type { Built, Probe, Target } from './common.ts';
import { T, arrives, block, cfgAction, emptyBuilt, runProbe, sentence, stopped, works } from './common.ts';

const ACL_TIP = 'On R1 run show access-lists to see which line counts the packets. Check the order of the lines and where the list is applied (show ip interface).';

function svcProbe(from: string, to: Target, svc: Svc): Probe {
  const info = SVC[svc];
  return info.proto === 'icmp' ? { from, to, proto: 'icmp' } : { from, to, proto: info.proto, port: info.ports[0] };
}
/** Allowed traffic: a ping must be answered, a TCP or UDP request must arrive at the target. */
function passes(env: Env, p: Probe, tip: string): Outcome {
  if (p.proto === 'icmp') return works(env, p, tip);
  const expected = `${sentence(p)} can exchange packets with the correct endpoint (an application may refuse a connection).`;
  const f = runProbe(env, p);
  if (!f) return missing(expected, p.to.gap, tip);
  return f.forward.atDeviceId === p.to.dev && f.reverse?.ok && f.reverse.atDeviceId === p.from && f.reverse.received?.src === p.to.addr
    ? ok(expected, f.summary, flowTrace(f)) : bad(expected, f.summary, tip, flowTrace(f));
}
function firstHalf(n: Net): Net { return { net: n.net, len: n.len + 1 }; }

// ───────────────────────────── case study ─────────────────────────────
function caseLines(s: Spec): string[] {
  if (s.acl?.mode !== 'case') return [];
  const m = model(s);
  const a = s.addr;
  const lan2 = `${a.lan2.net} ${wildOf(a.lan2)}`;
  const out: string[] = [];
  if (s.acl.pc1.kind === 'r2-lo0') out.push(`access-list 110 deny ip host ${m.pc1} host ${a.r2Lo0}`);
  else { const h = firstHalf(a.lan2); out.push(`access-list 110 deny ip host ${m.pc1} ${h.net} ${wildOf(h)}`); }
  for (const svc of s.acl.pc2Allow) {
    const info = SVC[svc];
    if (info.proto === 'icmp') out.push(`access-list 110 permit icmp host ${m.pc2} ${lan2}`);
    else for (const w of info.words) out.push(`access-list 110 permit ${info.proto} host ${m.pc2} ${lan2} eq ${w}`);
  }
  out.push(`access-list 110 deny ip host ${m.pc2} ${lan2}`);
  out.push('access-list 110 permit ip any any');
  return out;
}

function casePart(s: Spec): Built {
  const b = emptyBuilt('acl');
  if (s.acl?.mode !== 'case') return b;
  const opts = s.acl;
  b.config = { R1: [...caseLines(s), ...block(`interface ${s.ports.r1Lan}`, ['ip access-group 110 in'])] };
  const services: PcSetup = { mode: dhcpClients(s) ? 'dhcp' : 'static', services: { http: true, ftp: true } };
  if (opts.pc2Allow.includes('telnet')) services.services = { ...services.services, telnet: true };
  b.pcs = { PC3: services };

  // ── PC1 ──
  let pc1Req: ReqDef;
  if (opts.pc1.kind === 'r2-lo0') {
    const pingStop: CheckDef = {
      id: 'ping', label: "PC1 cannot ping R2's Loopback0, other hosts can",
      run: (env) => allOf([
        works(env, { from: 'PC2', to: T.r2Lo0(env), proto: 'icmp' }, 'PC2 must still reach the loopback of R2. Check the routes and the last line of the access list.'),
        stopped(env, { from: 'PC1', to: T.r2Lo0(env), proto: 'icmp' }, 'Deny IP from the host PC1 to the host address of the loopback. Put the list inbound on the LAN interface of R1.'),
      ]),
    };
    const tcpStop: CheckDef = {
      id: 'any-protocol', label: "PC1 cannot reach R2's Loopback0 with any other protocol", needs: ['ping'],
      run: (env) => allOf([
        stopped(env, { from: 'PC1', to: T.r2Lo0(env), proto: 'tcp', port: 23 }, 'Deny the protocol ip, not only icmp. Then every protocol is covered.'),
        stopped(env, { from: 'PC1', to: T.r2Lo0(env), proto: 'udp', port: 161 }, 'Deny the protocol ip, not only icmp. Then every protocol is covered.'),
      ]),
    };
    const rest: CheckDef = {
      id: 'rest', label: 'PC1 still reaches everything else', needs: ['ping'],
      run: (env) => allOf([
        works(env, { from: 'PC1', to: T.r2Wan(env), proto: 'icmp' }, 'An access list ends with an invisible deny. End your list with permit ip any any.'),
        works(env, { from: 'PC1', to: T.pc3(env), proto: 'icmp' }, 'An access list ends with an invisible deny. End your list with permit ip any any.'),
      ]),
    };
    pc1Req = { id: 'acl-pc1', title: "ACL: PC1 cannot communicate with R2's Loopback0", feature: 'acl', points: 2, checks: [pingStop, tcpStop, rest] };
  } else {
    const pingStop: CheckDef = {
      id: 'ping', label: 'PC1 cannot ping the first half of LAN2, other hosts can',
      run: (env) => allOf([
        works(env, { from: 'PC2', to: T.r2Lan(env), proto: 'icmp' }, 'PC2 must still be able to ping LAN2. Check the routes and the access list.'),
        stopped(env, { from: 'PC1', to: T.r2Lan(env), proto: 'icmp' }, 'Deny IP from the host PC1 to the first half of LAN2. Half of a network has a mask that is one bit longer.'),
        stopped(env, { from: 'PC1', to: T.pc3(env), proto: 'icmp' }, 'Deny IP from the host PC1 to the first half of LAN2. Half of a network has a mask that is one bit longer.'),
      ]),
    };
    const tcpStop: CheckDef = {
      id: 'any-protocol', label: 'PC1 cannot reach the first half of LAN2 with any other protocol', needs: ['ping'],
      run: (env) => allOf([
        stopped(env, { from: 'PC1', to: T.pc3(env), proto: 'tcp', port: 80 }, 'Deny the protocol ip, not only icmp.'),
        stopped(env, { from: 'PC1', to: T.r2Lan(env), proto: 'tcp', port: 23 }, 'Deny the protocol ip, not only icmp.'),
      ]),
    };
    const rest: CheckDef = {
      id: 'rest', label: 'PC1 still reaches the second half of LAN2 and everything else', needs: ['ping'],
      run(env) {
        const lan = env.a.r2Lan;
        const parts: Outcome[] = [
          works(env, { from: 'PC1', to: T.r2Wan(env), proto: 'icmp' }, 'End your list with permit ip any any.'),
          works(env, { from: 'PC1', to: T.r2Lo0(env), proto: 'icmp' }, 'End your list with permit ip any any.'),
        ];
        if (lan) {
          const net: Net = { net: networkOf(lan.address, lan.mask), len: s.addr.lan2.len };
          const far = T.fixed('the last address of LAN2', lastHost(net), 'R2');
          const p: Probe = { from: 'PC1', to: far, proto: 'icmp' };
          const f = runProbe(env, p);
          const expected = `${sentence(p)} is not filtered. It gets as far as R2.`;
          if (f) {
            parts.push(!stoppedByAcl(f) && f.forward.atDeviceId === 'R2'
              ? ok(expected, 'The packet passes R1 and arrives at R2.', flowTrace(f))
              : bad(expected, f.summary, 'The wildcard for half of LAN2 is too wide. Count again: the first half ends in the middle of the network.', flowTrace(f)));
          }
        }
        return allOf(parts);
      },
    };
    pc1Req = { id: 'acl-pc1', title: 'ACL: PC1 cannot communicate with the first half of LAN2', feature: 'acl', points: 2, checks: [pingStop, tcpStop, rest] };
  }

  // ── PC2 ──
  const allow = opts.pc2Allow;
  const deniedTcp = (['http', 'ftp', 'telnet', 'ssh'] as Svc[]).filter((x) => !allow.includes(x));
  const denyTip = 'After the permit lines, deny IP from the host PC2 to the LAN2 network.';
  const filter: CheckDef = {
    id: 'filter', label: `PC2 reaches LAN2 with ${svcShort(allow[0])}, but not with ${svcShort(deniedTcp[0])}`,
    run: (env) => allOf([
      passes(env, svcProbe('PC2', T.pc3(env), allow[0]), `Permit ${svcShort(allow[0])} from the host PC2 to LAN2 before the deny line.`),
      stopped(env, svcProbe('PC2', T.pc3(env), deniedTcp[0]), denyTip),
    ]),
  };
  const allowChecks: CheckDef[] = allow.slice(1).map((svc) => ({
    id: `allow-${svc}`, label: `PC2 also reaches LAN2 with ${svcShort(svc)}`, needs: ['filter'],
    run: (env) => passes(env, svcProbe('PC2', T.pc3(env), svc), `Permit ${svcShort(svc)} from the host PC2 to LAN2 before the deny line.`),
  }));
  const blocked: CheckDef = {
    id: 'blocked', label: 'PC2 cannot reach LAN2 with any other protocol', needs: ['filter'],
    run(env) {
      const parts = deniedTcp.slice(1, 3).map((svc) => stopped(env, svcProbe('PC2', T.pc3(env), svc), denyTip));
      if (!allow.includes('icmp')) parts.push(stopped(env, { from: 'PC2', to: T.pc3(env), proto: 'icmp' }, denyTip));
      for (const [proto, port] of [['udp', 69], ['udp', 80], ['tcp', 443], ['tcp', 45678]] as const) {
        parts.push(stopped(env, { from: 'PC2', to: T.pc3(env), proto, port }, 'Deny all other IP traffic, not only the verification ports.'));
      }
      return allOf(parts);
    },
  };
  const whole: CheckDef = {
    id: 'whole-lan2', label: 'The rule covers the whole LAN2 network, not only PC3', needs: ['filter'],
    run: (env) => allOf([
      ...deniedTcp.map((svc) => stopped(env, svcProbe('PC2', T.r2Lan(env), svc), 'Use the LAN2 network with its wildcard mask as the destination, not the single address of PC3.')),
      ...allow.map((svc) => passes(env, svcProbe('PC2', T.r2Lan(env), svc), 'Permit the assigned protocols to all LAN2 addresses, not only to PC3.')),
    ]),
  };
  const unaffected: CheckDef = {
    id: 'unaffected', label: 'PC2 is free everywhere else, and PC1 is not restricted towards LAN2', needs: ['filter'],
    run(env) {
      const tip = 'Only PC2 towards LAN2 is restricted. Use host <PC2 address> as the source, the LAN2 network as the destination, and end the list with permit ip any any.';
      const parts: Outcome[] = [
        works(env, { from: 'PC2', to: T.pc1(env), proto: 'icmp' }, tip),
        works(env, { from: 'PC2', to: T.r2Wan(env), proto: 'icmp' }, tip),
        arrives(env, svcProbe('PC2', T.r2Wan(env), deniedTcp[0]), tip),
      ];
      if (opts.pc1.kind === 'r2-lo0') parts.push(arrives(env, svcProbe('PC1', T.pc3(env), deniedTcp[0]), tip));
      return allOf(parts);
    },
  };
  const names = joinAnd(allow.map(svcShort), 'or');
  const pc2Req: ReqDef = { id: 'acl-pc2', title: `ACL: PC2 reaches LAN2 only with ${names}`, feature: 'acl', points: 2, checks: [filter, ...allowChecks, blocked, whole, unaffected] };

  b.requirements = [pc1Req, pc2Req];
  b.steps = [{
    id: 'acl', title: 'One access list on R1 for PC1 and PC2', feature: 'acl', devices: ['R1', 'PC3'],
    goal: opts.pc1.kind === 'r2-lo0'
      ? `Stop PC1 from reaching the Loopback0 address of R2, and let PC2 reach LAN2 only with ${names}. All other traffic stays allowed.`
      : `Stop PC1 from reaching the first half of LAN2, and let PC2 reach LAN2 only with ${names}. All other traffic stays allowed.`,
    why: 'Filtering on R1, where the packets enter, keeps unwanted traffic off the slow WAN link.',
    hint: 'One extended list, applied inbound on the LAN interface of R1. Order matters: deny for PC1, permits for PC2, deny for PC2, then permit everything else. Use the addresses the PCs really have now.',
    allows: ['acl', 'interface', 'console', 'pc'],
    script: [
      { kind: 'pc', pcId: 'PC3', setup: b.pcs.PC3 },
      cfgAction('R1', b.config.R1),
      { kind: 'note', text: 'Check: try the allowed and the forbidden traffic from PC1 and PC2. Then on R1: show access-lists.' },
    ],
    done: (env) => reqPasses(env, pc1Req) && reqPasses(env, pc2Req),
  }];
  return b;
}

// ───────────────────────────── course lab (LAB1) ─────────────────────────────
/** Which access list dropped the request, read from the last trace step and the interface it names. */
function droppingAcl(env: Env, p: Probe): { device: string; aclId: string; type: 'standard' | 'extended'; named: boolean } | null {
  const f = runProbe(env, p);
  if (!f || !stoppedByAcl(f)) return null;
  const last = f.forward.steps[f.forward.steps.length - 1];
  const dev = last ? env.world.devices[last.deviceId] : undefined;
  if (!last || !dev || dev.kind === 'pc' || !last.iface) return null;
  const ifc = dev.config.interfaces[last.iface];
  const aclId = last.stage === 'acl-in' ? ifc?.aclIn : ifc?.aclOut;
  const acl = aclId ? dev.config.acls[aclId] : undefined;
  return acl && aclId ? { device: dev.id, aclId, type: acl.type, named: acl.named } : null;
}
function stoppedAt(env: Env, p: Probe, device: string, tip: string): Outcome {
  const expected = `${sentence(p)} is dropped by an access list on ${device}.`;
  const f = runProbe(env, p);
  if (!f) return missing(expected, p.to.gap, tip);
  if (!stoppedByAcl(f)) return bad(expected, f.ok ? `It is not dropped. ${f.summary}` : f.summary, tip, flowTrace(f));
  if (f.forward.atDeviceId !== device) return bad(expected, `It is dropped on ${f.forward.atDeviceId}, not on ${device}.`, tip, flowTrace(f));
  return ok(expected, f.summary, flowTrace(f));
}

export const LAB_ACL_NAME = 'PING_OUT_ONLY';

function labPart(s: Spec): Built {
  const b = emptyBuilt('acl');
  const m = model(s);
  const a = s.addr;
  const lan2 = `${a.lan2.net} ${wildOf(a.lan2)}`;
  const std = { R2: [`access-list 1 deny host ${m.pc2}`, 'access-list 1 permit any', ...block(`interface ${s.ports.r2Lan}`, ['ip access-group 1 out'])] };
  const ext = { R1: [`access-list 100 deny tcp any ${lan2} eq www`, 'access-list 100 permit ip any any', ...block(`interface ${s.ports.r1Lan}`, ['ip access-group 100 in'])] };
  const named = {
    R1: [
      ...block(`ip access-list extended ${LAB_ACL_NAME}`, ['permit icmp any any echo-reply', 'deny icmp any any', 'permit ip any any']),
      ...block(`interface ${s.ports.r1Wan}`, [`ip access-group ${LAB_ACL_NAME} in`]),
    ],
  };
  b.config = { R2: std.R2, R1: [...ext.R1, ...named.R1] };
  b.pcs = { PC3: { mode: 'static', services: { http: true, ftp: true } }, PC1: { mode: 'static', services: { http: true } } };

  // 1. standard
  const pc2ToPc3: (e: Env) => Probe = (e) => ({ from: 'PC2', to: T.pc3(e), proto: 'icmp' });
  const stdReq: ReqDef = {
    id: 'acl-std', title: 'Standard ACL on R2: PC2 cannot reach LAN2', feature: 'acl', points: 3,
    checks: [
      { id: 'pc2-blocked', label: 'R2 drops packets from PC2 to LAN2', run: (env) => stoppedAt(env, pc2ToPc3(env), 'R2', 'A standard list only looks at the source. Deny the host PC2, permit the rest, and apply the list on R2.') },
      {
        id: 'standard', label: 'The list that drops them is a standard list', needs: ['pc2-blocked'],
        run(env) {
          const expected = 'The access list that drops the packets of PC2 is a standard list (number 1 to 99).';
          const d = droppingAcl(env, pc2ToPc3(env));
          if (!d) return bad(expected, 'No access list drops the packet.', ACL_TIP);
          return d.type === 'standard' ? ok(expected, `Access list ${d.aclId} on ${d.device} is a standard list.`) : bad(expected, `Access list ${d.aclId} on ${d.device} is an extended list.`, 'This task practises the standard list: access-list 1 deny host <PC2>, then access-list 1 permit any.');
        },
      },
      {
        id: 'others-ok', label: 'PC1 and PC3 still reach each other', needs: ['pc2-blocked'],
        run: (env) => allOf([
          works(env, { from: 'PC1', to: T.pc3(env), proto: 'icmp' }, 'A list ends with an invisible deny. Add permit any after the deny line.'),
          works(env, { from: 'PC2', to: T.pc1(env), proto: 'icmp' }, 'Only the way from PC2 to LAN2 is closed.'),
        ]),
      },
    ],
  };
  // 2. extended
  const webFrom = (pc: string): (e: Env) => Probe => (e) => ({ from: pc, to: T.pc3(e), proto: 'tcp', port: 80 });
  const extReq: ReqDef = {
    id: 'acl-ext', title: 'Extended ACL on R1: no HTTP from LAN1 to LAN2', feature: 'acl', points: 3,
    checks: [
      {
        id: 'http-blocked', label: 'R1 drops HTTP from LAN1 to LAN2',
        run: (env) => allOf([
          stoppedAt(env, webFrom('PC1')(env), 'R1', 'An extended list sits close to the source: inbound on the LAN interface of R1. Deny tcp from any to LAN2 with eq www.'),
          stoppedAt(env, webFrom('PC2')(env), 'R1', 'Use any as the source, so every LAN1 host is covered.'),
        ]),
      },
      {
        id: 'extended', label: 'The list that drops it is an extended list', needs: ['http-blocked'],
        run(env) {
          const expected = 'The access list that drops HTTP is an extended list (number 100 to 199, or a named extended list).';
          const d = droppingAcl(env, webFrom('PC1')(env));
          if (!d) return bad(expected, 'No access list drops the packet.', ACL_TIP);
          return d.type === 'extended' ? ok(expected, `Access list ${d.aclId} on ${d.device} is an extended list.`) : bad(expected, `Access list ${d.aclId} is a standard list.`, 'Only an extended list can look at the protocol and the port.');
        },
      },
      {
        id: 'rest-ok', label: 'Other traffic from LAN1 is untouched', needs: ['http-blocked'],
        run: (env) => allOf([
          works(env, { from: 'PC1', to: T.pc3(env), proto: 'icmp' }, 'End the list with permit ip any any.'),
          arrives(env, { from: 'PC1', to: T.pc3(env), proto: 'tcp', port: 21 }, 'Deny only tcp with eq www. End the list with permit ip any any.'),
          arrives(env, { from: 'PC1', to: T.r2Wan(env), proto: 'tcp', port: 80 }, 'Only HTTP to LAN2 is forbidden. Use the LAN2 network as the destination, not any.'),
        ]),
      },
    ],
  };
  // 3. named
  const pingIn: (e: Env) => Probe = (e) => ({ from: 'PC3', to: T.pc1(e), proto: 'icmp' });
  const namedReq: ReqDef = {
    id: 'acl-named', title: 'Named ACL on R1: no pings from outside, answers to own pings still come back', feature: 'acl', points: 3,
    checks: [
      {
        id: 'ping-in-blocked', label: 'R1 drops pings that come in over the WAN link',
        run: (env) => allOf([
          stoppedAt(env, pingIn(env), 'R1', 'Apply the named list inbound on the WAN interface of R1. Permit icmp echo-reply first, then deny icmp.'),
          stoppedAt(env, { from: 'R2', to: T.r1Wan(env), proto: 'icmp' }, 'R1', 'The list sits inbound on the WAN interface, so it also covers pings to R1 itself.'),
        ]),
      },
      {
        id: 'named', label: 'The list is a named list', needs: ['ping-in-blocked'],
        run(env) {
          const expected = 'The access list that drops the pings was made with ip access-list extended <name>.';
          const d = droppingAcl(env, pingIn(env));
          if (!d) return bad(expected, 'No access list drops the packet.', ACL_TIP);
          return d.named && !/^\d+$/.test(d.aclId) ? ok(expected, `Access list ${d.aclId} on ${d.device} is a named list.`) : bad(expected, `Access list ${d.aclId} is a numbered list.`, `Create it with ip access-list extended ${LAB_ACL_NAME}.`);
        },
      },
      {
        id: 'ping-out-ok', label: 'Pings from LAN1 to outside still get their answers', needs: ['ping-in-blocked'],
        run: (env) => works(env, { from: 'PC1', to: T.pc3(env), proto: 'icmp' }, 'The answer to a ping is an echo-reply. Permit icmp any any echo-reply before the deny line.'),
      },
      {
        id: 'other-in-ok', label: 'Other traffic from outside still passes', needs: ['ping-in-blocked'],
        run: (env) => arrives(env, { from: 'PC3', to: T.pc1(env), proto: 'tcp', port: 80 }, 'End the list with permit ip any any.'),
      },
    ],
  };
  b.requirements = [stdReq, extReq, namedReq];
  b.steps = [
    {
      id: 'acl-std', title: 'Standard access list on R2', feature: 'acl', devices: ['R2'],
      goal: 'Stop PC2 from reaching LAN2 with a standard access list on R2. Other hosts must not notice anything.',
      why: 'A standard list only knows the source address. So it belongs close to the destination. Anywhere else it would block too much.',
      hint: 'Two lines: deny the one host, then permit everybody else. Apply the list where packets leave R2 towards LAN2.',
      allows: ['acl', 'interface', 'console', 'pc'],
      script: [cfgAction('R2', std.R2), { kind: 'note', text: 'Check: ping PC3 from PC2 and from PC1. On R2: show access-lists.' }],
      done: (env) => reqPasses(env, stdReq),
    },
    {
      id: 'acl-ext', title: 'Extended access list on R1', feature: 'acl', devices: ['R1', 'PC3'],
      goal: 'Stop every LAN1 host from opening HTTP (TCP port 80) to LAN2, with an extended access list on R1. All other traffic stays allowed.',
      why: 'An extended list knows source, destination, protocol and port. So it can sit close to the source and save the WAN link.',
      hint: 'Deny tcp from any source to the LAN2 network with eq www. Then permit ip any any. Apply the list where the packets of LAN1 enter R1.',
      allows: ['acl', 'interface', 'console', 'pc'],
      script: [
        { kind: 'pc', pcId: 'PC3', setup: b.pcs.PC3 },
        cfgAction('R1', ext.R1),
        { kind: 'note', text: 'Check: open http://<PC3> from PC1 (it must fail). Ping PC3 from PC1 (it must work).' },
      ],
      done: (env) => reqPasses(env, extReq),
    },
    {
      id: 'acl-named', title: 'Named access list on the WAN side of R1', feature: 'acl', devices: ['R1', 'PC1'],
      goal: `Create the named list ${LAB_ACL_NAME}: nobody outside may ping R1 or LAN1, but pings that LAN1 hosts send out still get their answers. All other traffic stays allowed.`,
      why: 'A named list is easier to read and to edit than a numbered one. You can add and remove single lines.',
      hint: 'The answer to a ping is the ICMP type echo-reply. Permit that first, deny the rest of ICMP, permit everything else. Apply the list inbound on the WAN interface of R1.',
      allows: ['acl', 'interface', 'console', 'pc'],
      script: [
        { kind: 'pc', pcId: 'PC1', setup: b.pcs.PC1 },
        cfgAction('R1', named.R1),
        { kind: 'note', text: 'Check: ping PC1 from PC3 (it must fail). Ping PC3 from PC1 (it must work).' },
      ],
      done: (env) => reqPasses(env, namedReq),
    },
  ];
  return b;
}

export function aclPart(s: Spec): Built {
  return s.acl?.mode === 'lab' ? labPart(s) : casePart(s);
}
