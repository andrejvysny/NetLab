/**
 * NAT. Case study: PAT on the WAN address for LAN1 plus static NAT for PC1 to the Loopback100 address.
 * Course labs: static NAT, dynamic NAT with a pool, and overload, with a block of global addresses that the
 * provider router (R2) reaches through a static route. Owned by the scenario agent.
 */
import { inSubnet, ipToInt, isPrivate, maskToPrefix, maskToWildcard, networkOf } from '../../engine/ip.ts';
import { isPc } from '../../engine/world.ts';
import { aclEvaluate, lookupRoute, sendFlow } from '../../engine/sim/index.ts';
import type { SimFlowResult } from '../../engine/sim/index.ts';
import type { CheckDef, Outcome, ReqDef } from '../checks.ts';
import { allOf, bad, flowTrace, missing, ok, reqPasses } from '../checks.ts';
import type { Env } from '../env.ts';
import { ping, probeWorld } from '../env.ts';
import { sourceMismatch } from '../sourcePolicy.ts';
import type { AddrMatch, Packet } from '../../engine/types.ts';
import type { Net, Spec } from '../spec.ts';
import { cidr, has, host, lastHost, maskOf, model, wildOf } from '../spec.ts';
import type { Built, Probe, Target } from './common.ts';
import { T, arrives, block, cfgAction, emptyBuilt, runProbe, sentence, works } from './common.ts';

const NAT_TIP = 'On R1 run show ip nat translations after a ping. Check ip nat inside on the LAN interface and ip nat outside on the WAN interface.';

/** The ping must work and the receiver must see one of the wanted source addresses. */
function seenAs(env: Env, p: Probe, want: (src: string) => boolean, wantText: string, tip: string): Outcome {
  const expected = `${sentence(p)} gets an answer. ${p.to.dev} sees it coming from ${wantText}.`;
  const f = runProbe(env, p);
  if (!f) return missing(expected, p.to.gap, tip);
  const src = f.forward.received?.src;
  if (!f.ok || f.forward.atDeviceId !== p.to.dev) return bad(expected, f.summary, tip, flowTrace(f));
  if (!src || !want(src)) return bad(expected, `The ping works, but ${p.to.dev} sees the source address ${src ?? '?'}.`, tip, flowTrace(f));
  return ok(expected, `${p.to.dev} sees the source address ${src}.`, flowTrace(f));
}

/** Two LAN1 hosts send at the same moment (on a copy of the world). `second` may be a test address for PC1. */
function together(env: Env, key: string, dst: string, pc1As?: { address: string; mask: string; gateway: string }): { a: SimFlowResult; b: SimFlowResult } | null {
  return env.memo(`together:${key}:${dst}:${pc1As?.address ?? ''}`, () => {
    const w = probeWorld(env.world);
    const pc1 = w.devices['PC1'];
    if (!isPc(pc1) || !isPc(w.devices['PC2'])) return null;
    // PC1 stands in for "one more LAN1 PC": it borrows a spare address and the normal LAN settings for this test.
    if (pc1As) pc1.nic = { mode: 'static', mac: pc1.nic.mac, address: pc1As.address, mask: pc1As.mask, gateway: pc1As.gateway };
    const a = sendFlow(w, ping('PC2', dst));
    const b = sendFlow(w, ping('PC1', dst));
    return { a, b };
  });
}

// ───────────────────────────── case study ─────────────────────────────
function caseConfig(s: Spec): Record<string, string[]> {
  const m = model(s);
  const a = s.addr;
  return {
    R1: [
      ...block(`interface ${s.ports.r1Lan}`, ['ip nat inside']),
      ...block(`interface ${s.ports.r1Wan}`, ['ip nat outside']),
      `ip nat inside source static ${m.pc1} ${a.r1Lo100}`,
      `access-list 1 permit ${a.lan1.net} ${wildOf(a.lan1)}`,
      `ip nat inside source list 1 interface ${s.ports.r1Wan} overload`,
    ],
  };
}

function casePart(s: Spec): Built {
  const b = emptyBuilt('nat');
  b.config = caseConfig(s);
  const aclCase = has(s, 'acl') && s.acl?.mode === 'case' ? s.acl : undefined;
  const pc1ToPc3 = !(aclCase && aclCase.pc1.kind === 'lan2-first-half');
  const pc2PingLan2 = !aclCase || aclCase.pc2Allow.includes('icmp');
  const inWan = (env: Env) => (src: string): boolean => src === env.a.r1Wan?.address && !isPrivate(src);

  const pc2Out: CheckDef = {
    id: 'pc2-out', label: 'PC2 goes out with a public address from WAN1',
    run(env) {
      const want = env.a.r1Wan ? `a WAN1 address (R1 has ${env.a.r1Wan.address})` : 'a WAN1 address';
      const parts = [seenAs(env, { from: 'PC2', to: T.r2Wan(env), proto: 'icmp' }, inWan(env), want, NAT_TIP)];
      if (pc2PingLan2) parts.push(seenAs(env, { from: 'PC2', to: T.pc3(env), proto: 'icmp' }, inWan(env), want, NAT_TIP));
      return allOf(parts);
    },
  };
  const shared: CheckDef = {
    id: 'shared', label: 'Several LAN1 PCs share the public address at the same time (PAT)', needs: ['pc2-out'],
    run(env) {
      const expected = 'Two LAN1 PCs ping outside at the same moment. Both get answers, behind the same WAN1 address.';
      const lan = env.a.r1Lan;
      const dst = env.a.r2Wan?.address;
      if (!lan || !dst) return missing(expected, 'The LAN or WAN address is missing.', NAT_TIP);
      const net: Net = { net: networkOf(lan.address, lan.mask), len: maskToPrefix(lan.mask) };
      let spare = lastHost(net);
      if (spare === env.a.pc2 || spare === lan.address) spare = host(net, 2 ** (32 - net.len) - 3);
      const r = together(env, 'pat', dst, { address: spare, mask: lan.mask, gateway: lan.address });
      if (!r) return missing(expected, 'PC1 or PC2 is not on the bench.', NAT_TIP);
      const s1 = r.a.forward.received?.src;
      const s2 = r.b.forward.received?.src;
      const tip = 'The dynamic rule needs the word overload: ip nat inside source list <acl> interface <WAN interface> overload. The access list must permit the whole LAN1 network.';
      if (!r.a.ok) return bad(expected, r.a.summary, tip, flowTrace(r.a));
      if (!r.b.ok) return bad(expected, `PC2 gets out, but a second LAN1 PC (tested with the address ${spare}) does not. ${r.b.summary}`, tip, flowTrace(r.b));
      if (s1 !== s2 || !s1 || !inWan(env)(s1)) return bad(expected, `PC2 appears as ${s1}, a second LAN1 PC (tested with ${spare}) appears as ${s2}.`, tip, flowTrace(r.b));
      return ok(expected, `PC2 and a second LAN1 PC (tested with the address ${spare}) both appear as ${s1}.`, flowTrace(r.b));
    },
  };
  const scope: CheckDef = {
    id: 'scope', label: 'The PAT rules cover LAN1 but do not permit unrelated sources', needs: ['shared'],
    run(env) {
      const expected = 'The PAT selector covers usable LAN1 client addresses, not sources outside LAN1.';
      const tip = 'Limit overload to the LAN1 network with the subnet wildcard. Split permit ranges or named lists are fine.';
      const d = env.r1;
      const lan = env.a.r1Lan;
      const wan = env.a.r1Wan;
      const dst = env.a.r2Wan?.address;
      if (!d || !lan || !wan || !dst) return missing(expected, 'R1 LAN/WAN or R2 WAN address is missing.', tip);
      const net = networkOf(lan.address, lan.mask);
      const allow: AddrMatch = { kind: 'net', address: net, wildcard: maskToWildcard(lan.mask) };
      const rules = d.config.nat.dynamicRules.filter((r) => (!r.pool && r.interface === env.roles.r1Wan) ||
        (r.pool && r.overload && d.config.nat.pools.find((p) => p.name === r.pool)?.start === wan.address));
      if (!rules.length) return bad(expected, 'R1 has no applicable rule translating to its WAN1 address.', tip);
      const packet: Packet = { src: net, dst, proto: 'icmp', ttl: 64, bytes: 64 };
      const examples: Packet[] = [packet, { ...packet, proto: 'tcp', sport: 49152, dport: 80, tcpSyn: true }, { ...packet, proto: 'udp', sport: 49152, dport: 161 }];
      for (const p of examples) for (const r of rules) {
        const leak = sourceMismatch(d.config.acls[r.acl], [allow], p, 'outside');
        if (leak) return bad(expected, 'address' in leak ? `The selector ${r.acl} permits ${leak.address} outside LAN1.` : `Could not establish the scope of ${r.acl}.`, tip);
      }
      const count = 2 ** (32 - maskToPrefix(lan.mask)) - 2;
      // LAN1 is assigned /24; avoid unbounded work on a malformed prefix, which already fails task 2.
      if (count < 2 || count > 1022) return bad(expected, 'LAN1 has the wrong size for a LAN1 PAT test.', tip);
      for (let i = 1; i <= count; i++) {
        const src = host({ net, len: 24 }, i);
        if (src === lan.address || src === env.a.pc1) continue;
        if (examples.some((p) => !rules.some((r) => aclEvaluate(d.config.acls[r.acl], { ...p, src }).permit))) {
          return bad(expected, `The PAT selector does not cover ${src} for all tested traffic.`, tip);
        }
      }
      return ok(expected, `The tested PAT selectors cover LAN1 (${net}) without admitting sources outside its subnet.`);
    },
  };
  const pat: ReqDef = { id: 'pat', title: 'PAT: LAN1 goes out behind a public WAN1 address', feature: 'nat', points: 2, checks: [pc2Out, shared, scope] };

  const lo = (env: Env): string => (env.a.r1Lo100 ? `the address of R1 Loopback100 (${env.a.r1Lo100.address})` : 'the address of R1 Loopback100');
  const pc1Out: CheckDef = {
    id: 'pc1-out', label: 'PC1 goes out with the Loopback100 address',
    run(env) {
      const o = seenAs(env, { from: 'PC1', to: T.r2Wan(env), proto: 'icmp' }, (src) => src === env.a.r1Lo100?.address, lo(env),
        'PC1 needs a static translation: ip nat inside source static <PC1 address> <Loopback100 address>. Check it with show ip nat translations.');
      if (o.pass && env.a.r1Lo100 && isPrivate(env.a.r1Lo100.address)) {
        return bad(o.expected, `Loopback100 has the private address ${env.a.r1Lo100.address}.`, 'PC1 must appear with a public address. Give Loopback100 a public /32 address.');
      }
      return o;
    },
  };
  const outsider = (env: Env): Probe[] => {
    const list: Probe[] = [{ from: 'R2', to: T.pc1Public(env), proto: 'icmp' }];
    if (pc1ToPc3) list.push({ from: 'PC3', to: T.pc1Public(env), proto: 'icmp' });
    return list;
  };
  const fromOutside: CheckDef = {
    id: 'from-outside', label: 'A session started outside reaches PC1 on the Loopback100 address',
    run(env) {
      const tip = 'Static NAT works in both directions. Check the static rule on R1, and that R2 can route to the Loopback100 address (its default route).';
      return allOf(outsider(env).map((p) => {
        const o = works(env, p, tip);
        const f = runProbe(env, p);
        if (o.pass && f && f.repliedFrom !== p.to.addr) {
          return bad(o.expected, `PC1 answers, but the outside station sees a reply from ${f.repliedFrom ?? 'an unknown address'}, not the Loopback100 address.`, tip, flowTrace(f));
        }
        return o;
      }));
    },
  };
  const tcpIn: CheckDef = {
    id: 'tcp-in', label: 'Any service on PC1 can be reached from outside', needs: ['from-outside'],
    run: (env) => arrives(env, { from: pc1ToPc3 ? 'PC3' : 'R2', to: T.pc1Public(env), proto: 'tcp', port: 80 },
      'The static rule must translate the whole address, not a single port.'),
  };
  const stat: ReqDef = { id: 'static-nat', title: 'Static NAT: PC1 is reachable from outside on the Loopback100 address', feature: 'nat', points: 2, checks: [pc1Out, fromOutside, tcpIn] };
  b.requirements = [pat, stat];
  b.steps = [{
    id: 'nat', title: 'NAT on R1: PAT for LAN1, static NAT for PC1', feature: 'nat', devices: ['R1'],
    goal: 'Mark the LAN interface of R1 as inside and the WAN interface as outside. Then translate all of LAN1 to the WAN address with overload, and PC1 to the Loopback100 address with a static rule.',
    why: 'LAN1 is private. Outside, its PCs must appear with public addresses, and PC1 must be reachable from outside.',
    hint: 'You need four things: the two interface roles, a standard access list that permits LAN1, the dynamic rule with overload, and one static rule for PC1.',
    allows: ['nat', 'acl', 'interface', 'console', 'pc'],
    script: [
      cfgAction('R1', b.config.R1),
      { kind: 'note', text: 'Check: ping from PC2 and PC1 to the WAN address of R2. Then on R1: show ip nat translations.' },
    ],
    done: (env) => reqPasses(env, pat) && reqPasses(env, stat),
  }];
  return b;
}

// ───────────────────────────── course labs ─────────────────────────────
function labPart(s: Spec, mode: 'static' | 'pool' | 'overload', blockNet: Net): Built {
  const b = emptyBuilt('nat');
  const m = model(s);
  const a = s.addr;
  const first = host(blockNet, 1);
  const last = lastHost(blockNet);
  const roles = [...block(`interface ${s.ports.r1Lan}`, ['ip nat inside']), ...block(`interface ${s.ports.r1Wan}`, ['ip nat outside'])];
  const acl = `access-list 1 permit ${a.lan1.net} ${wildOf(a.lan1)}`;
  const r1 = mode === 'static'
    ? [...roles, `ip nat inside source static ${m.pc1} ${first}`]
    : mode === 'pool'
      ? [...roles, `ip nat pool ITA ${first} ${last} netmask ${maskOf(blockNet)}`, acl, 'ip nat inside source list 1 pool ITA']
      : [...roles, `ip nat pool ITA ${first} ${first} netmask ${maskOf(blockNet)}`, acl, 'ip nat inside source list 1 pool ITA overload'];
  b.config = { R1: r1, R2: [`ip route ${blockNet.net} ${maskOf(blockNet)} ${s.ports.r2Wan} ${m.r1Wan}`] };
  const inBlock = (src: string): boolean => {
    const n = ipToInt(src);
    return n >= ipToInt(first) && n <= ipToInt(last);
  };
  const global1: Target = T.fixed(`the global address ${first}`, first, 'PC1');

  const route: CheckDef = {
    id: 'r2-route', label: `R2 has a static route to the global addresses ${cidr(blockNet)}`,
    run(env) {
      const expected = `R2 (the provider) has a route to ${cidr(blockNet)} towards R1. It has no route to the private LAN1.`;
      const r = lookupRoute(env.world, 'R2', first);
      const priv = env.a.pc1 ? lookupRoute(env.world, 'R2', env.a.pc1) : null;
      const tip = `On R2: ip route ${blockNet.net} ${maskOf(blockNet)} <WAN interface> <R1 WAN address>. A provider does not route private networks.`;
      if (!r) return bad(expected, `R2 has no route to ${first}.`, tip);
      if (r.resolved.iface !== env.roles.r2Wan) return bad(expected, `R2 sends ${first} out of ${r.resolved.iface}, not towards R1.`, tip);
      if (priv) return bad(expected, `R2 also has a route to the private address ${env.a.pc1} (${priv.prefix}/${priv.prefixLen}).`, tip);
      return ok(expected, `R2 routes ${r.prefix}/${r.prefixLen} towards R1.`);
    },
  };
  const ispReq: ReqDef = { id: 'isp-route', title: 'Provider side: R2 routes the global addresses to R1', feature: 'routing', points: 1, checks: [route] };

  let main: ReqDef;
  if (mode === 'static') {
    main = {
      id: 'nat-static', title: `Static NAT: PC1 is ${first} for the outside world`, feature: 'nat', points: 3,
      checks: [
        { id: 'pc1-out', label: `PC1 goes out as ${first}`, run: (env) => seenAs(env, { from: 'PC1', to: T.pc3(env), proto: 'icmp' }, (x) => x === first, first, NAT_TIP) },
        {
          id: 'from-outside', label: `PC3 reaches PC1 on ${first}`,
          run(env) {
            const p: Probe = { from: 'PC3', to: global1, proto: 'icmp' };
            const o = works(env, p, NAT_TIP);
            const f = runProbe(env, p);
            if (o.pass && f && f.forward.atDeviceId !== 'PC1') return bad(o.expected, `The ping is answered by ${f.forward.atDeviceId}, not by PC1.`, NAT_TIP, flowTrace(f));
            return o;
          },
        },
        { id: 'tcp-in', label: 'A TCP connection from outside reaches PC1 too', needs: ['from-outside'], run: (env) => arrives(env, { from: 'PC3', to: global1, proto: 'tcp', port: 80 }, NAT_TIP) },
      ],
    };
  } else if (mode === 'pool') {
    main = {
      id: 'nat-pool', title: `Dynamic NAT: LAN1 hosts take addresses from the pool ${first} to ${last}`, feature: 'nat', points: 3,
      checks: [
        { id: 'pc1-out', label: 'PC1 goes out with an address from the pool', run: (env) => seenAs(env, { from: 'PC1', to: T.pc3(env), proto: 'icmp' }, inBlock, `an address from ${first} to ${last}`, NAT_TIP) },
        {
          id: 'two-hosts', label: 'PC1 and PC2 are outside at the same time, each with its own pool address', needs: ['pc1-out'],
          run(env) {
            const expected = 'PC1 and PC2 ping PC3 at the same moment. Both get answers. PC3 sees two different pool addresses.';
            const dst = env.a.pc3;
            if (!dst) return missing(expected, 'PC3 has no IP address yet.', NAT_TIP);
            const r = together(env, 'pool', dst);
            if (!r) return missing(expected, 'PC1 or PC2 is not on the bench.', NAT_TIP);
            const tip = 'The pool must hold more than one address: ip nat pool <name> <first> <last> netmask <mask>. Do not add overload in this lab.';
            if (!r.a.ok) return bad(expected, r.a.summary, tip, flowTrace(r.a));
            if (!r.b.ok) return bad(expected, `PC2 gets out, PC1 does not. ${r.b.summary}`, tip, flowTrace(r.b));
            const s2 = r.a.forward.received?.src;
            const s1 = r.b.forward.received?.src;
            if (!s1 || !s2 || !inBlock(s1) || !inBlock(s2)) return bad(expected, `PC3 sees ${s1} and ${s2}.`, tip, flowTrace(r.b));
            if (s1 === s2) return bad(expected, `Both PCs appear as ${s1}. That is overload, not one address per host.`, tip, flowTrace(r.b));
            return ok(expected, `PC3 sees PC1 as ${s1} and PC2 as ${s2}.`, flowTrace(r.b));
          },
        },
      ],
    };
  } else {
    main = {
      id: 'nat-overload', title: `NAT overload: all of LAN1 shares the one global address ${first}`, feature: 'nat', points: 3,
      checks: [
        { id: 'pc1-out', label: `PC1 goes out as ${first}`, run: (env) => seenAs(env, { from: 'PC1', to: T.pc3(env), proto: 'icmp' }, (x) => x === first, first, NAT_TIP) },
        {
          id: 'shared', label: `PC1 and PC2 are outside at the same time, both as ${first}`, needs: ['pc1-out'],
          run(env) {
            const expected = `PC1 and PC2 ping PC3 at the same moment. Both get answers. PC3 sees ${first} for both.`;
            const dst = env.a.pc3;
            if (!dst) return missing(expected, 'PC3 has no IP address yet.', NAT_TIP);
            const r = together(env, 'overload', dst);
            if (!r) return missing(expected, 'PC1 or PC2 is not on the bench.', NAT_TIP);
            const tip = 'Add the word overload to the dynamic rule: ip nat inside source list 1 pool <name> overload.';
            if (!r.a.ok) return bad(expected, r.a.summary, tip, flowTrace(r.a));
            if (!r.b.ok) return bad(expected, `PC2 gets out, PC1 does not. ${r.b.summary}`, tip, flowTrace(r.b));
            const s2 = r.a.forward.received?.src;
            const s1 = r.b.forward.received?.src;
            if (s1 !== first || s2 !== first) return bad(expected, `PC3 sees PC1 as ${s1} and PC2 as ${s2}.`, tip, flowTrace(r.b));
            return ok(expected, `PC3 sees both PCs as ${first}.`, flowTrace(r.b));
          },
        },
      ],
    };
  }
  b.requirements = [main, ispReq];
  const what = mode === 'static'
    ? `Translate PC1 to the global address ${first} with a static rule.`
    : mode === 'pool'
      ? `Translate LAN1 to a pool with the global addresses ${first} to ${last}, one global address per host.`
      : `Translate all of LAN1 to the single global address ${first} with overload.`;
  b.steps = [
    {
      id: 'nat-lab', title: mode === 'static' ? 'Static NAT on R1' : mode === 'pool' ? 'Dynamic NAT with a pool on R1' : 'NAT overload on R1', feature: 'nat', devices: ['R1'],
      goal: `Mark the LAN interface of R1 as inside and the WAN interface as outside. ${what}`,
      why: 'LAN1 uses private addresses. The provider does not route them, so R1 must swap them for global addresses.',
      hint: mode === 'static'
        ? 'A static rule names one inside address and one global address.'
        : 'A dynamic rule joins a standard access list (who is translated) with a pool (which global addresses are used).',
      allows: ['nat', 'acl', 'interface', 'console', 'pc'],
      script: [cfgAction('R1', b.config.R1), { kind: 'note', text: 'Check on R1: show ip nat translations and show ip nat statistics.' }],
      done: (env) => {
        const r = env.r1?.config;
        if (!r || !env.roles.r1Lan || !env.roles.r1Wan) return false;
        const rolesOk = r.interfaces[env.roles.r1Lan]?.natRole === 'inside' && r.interfaces[env.roles.r1Wan]?.natRole === 'outside';
        const f = env.a.pc3 ? env.probe(ping('PC1', env.a.pc3)) : null;
        const translated = !!f && f.forward.atDeviceId === 'PC3' && !!f.forward.received && inBlock(f.forward.received.src);
        return rolesOk && translated;
      },
    },
    {
      id: 'isp-route', title: 'R2: route to the global addresses', feature: 'routing', devices: ['R2'],
      goal: `On R2 add a static route to ${cidr(blockNet)} that points to R1. Then test from PC1 and from PC3.`,
      why: 'R2 plays the provider. It only knows public networks. Without this route its answers to the global addresses have nowhere to go.',
      hint: 'A static route names the network, the mask, and where to send it: the WAN interface and the WAN address of R1.',
      allows: ['routing', 'interface', 'console', 'pc'],
      script: [cfgAction('R2', b.config.R2), { kind: 'note', text: 'Check: ping from PC1 to PC3. Then on R1: show ip nat translations.' }],
      done: (env) => reqPasses(env, ispReq) && reqPasses(env, main),
    },
  ];
  return b;
}

export function natPart(s: Spec): Built {
  const n = s.nat ?? { mode: 'case' as const };
  return n.mode === 'case' ? casePart(s) : labPart(s, n.mode, n.block);
}
