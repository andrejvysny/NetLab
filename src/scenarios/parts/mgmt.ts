/** Management: Telnet on the vty lines, SNMP communities with access lists, syslog to PC1. Owned by the scenario agent. */
import type { FlowSpec } from '../../engine/types.ts';
import { syslogBlockReason, syslogProbe, vtyAllowsTelnet, vtyDecision } from '../../engine/sim/index.ts';
import type { SimFlowResult } from '../../engine/sim/index.ts';
import type { CheckDef, Outcome, ReqDef } from '../checks.ts';
import { bad, flowTrace, missing, ok, reqPasses } from '../checks.ts';
import { probeWorld, type Env } from '../env.ts';
import type { Spec } from '../spec.ts';
import { has, model, wildOf } from '../spec.ts';
import { networkOf, maskToWildcard } from '../../engine/ip.ts';
import { sourceHost, sourceMismatch } from '../sourcePolicy.ts';
import type { Built, Target } from './common.ts';
import { T, block, cfgAction, emptyBuilt } from './common.ts';

/** Address of a router as seen from a PC: LAN1 PCs use R1's LAN and R2's WAN address, PC3 uses R1's WAN and R2's LAN address. */
function routerFor(env: Env, router: 'R1' | 'R2', from: string): Target {
  if (router === 'R1') return from === 'PC3' ? T.r1Wan(env) : T.r1Lan(env);
  return from === 'PC3' ? T.r2Lan(env) : T.r2Wan(env);
}

// ───────────────────────────── Telnet ─────────────────────────────
export const VTY_ACL = 'allowPC1';
export function telnetConfig(s: Spec): Record<string, string[]> {
  const m = model(s);
  const pw = s.telnet?.password ?? 'cisco';
  const lines = [`access-class ${VTY_ACL} in`, `password ${pw}`, 'login', 'transport input telnet'];
  const one = (pc1: string): string[] => [
    ...block(`ip access-list standard ${VTY_ACL}`, [`permit ${pc1}`]),
    ...block('line vty 0 4', lines),
    ...block('line vty 5 14', lines),
  ];
  return { R1: one(m.pc1), R2: one(m.pc1Outside) };
}

export function telnetPart(s: Spec): Built {
  const b = emptyBuilt('telnet');
  b.config = telnetConfig(s);
  const nat = has(s, 'nat');
  // The case asks for working PC1-only Telnet access, not a particular authentication mode. The focused lab specifies one.
  const requiredPassword = s.telnet?.passwordGiven ? s.telnet.password : undefined;
  const accepted = (router: 'R1' | 'R2'): CheckDef => ({
    id: `pc1-${router.toLowerCase()}`, label: `PC1 can use every Telnet-enabled line on ${router}`,
    run(env) {
      const to = routerFor(env, router, 'PC1');
      const dev = router === 'R1' ? env.r1 : env.r2;
      const expected = `PC1 can access ${router}${to.addr ? ` (${to.addr})` : ''} on every Telnet-enabled VTY range${requiredPassword !== undefined ? ' using the assigned line password' : ''}.`;
      const tip = router === 'R2' && nat
        ? 'Permit the translated address of PC1 on R2. Check the VTY access-class and transport input.'
        : 'Permit PC1 with the inbound access-class and allow Telnet on the VTY lines. Check with show running-config | section line vty.';
      if (!to.addr || !dev) return missing(expected, to.gap, tip);
      const f = env.probe({ fromDeviceId: 'PC1', dst: to.addr, proto: 'tcp', dport: 23 });
      const src = f.forward.received?.src;
      if (!f.ok || f.forward.atDeviceId !== router || !f.vty?.accepted || !src) return bad(expected, f.summary, tip, flowTrace(f));
      const ranges = dev.config.lines.vty.filter(vtyAllowsTelnet);
      // The real probe proves the idle connection and NAT-visible source. Test additional VTYs independently of occupancy.
      for (const range of ranges) {
        const line = vtyDecision(env.world, router, src, 'telnet', range.first);
        // For a later line, the idle probe is not evidence of that line's decision.
        const trace = range.first === f.vty.line?.first ? flowTrace(f) : undefined;
        if (!line.accepted) return bad(expected, line.text, tip, trace);
        if (requiredPassword !== undefined && (line.login !== 'password' || line.line?.password !== requiredPassword)) {
          return bad(expected, `${router} VTY ${range.first} to ${range.last} does not use the assigned line password and login.`,
            'Set the password named in the lab and enable login on this VTY range.', trace);
        }
        if (line.login === 'password-not-set' || line.login === 'local-no-users') {
          return bad(expected, line.text, 'If using login, set a line password. If using login local, configure a local user.', trace);
        }
      }
      return ok(expected, `${router} gives PC1 usable access on all ${ranges.length} Telnet-enabled VTY ranges. ${f.vty.text}`, flowTrace(f));
    },
  });
  const allowed = (router: 'R1' | 'R2'): CheckDef => ({
    id: `others-${router.toLowerCase()}`, label: `Only PC1 may Telnet to ${router} on every Telnet-enabled line`,
    run(env) {
      const to = routerFor(env, router, 'PC1');
      const dev = router === 'R1' ? env.r1 : env.r2;
      const expected = `Every Telnet-enabled vty range on ${router} permits only PC1 as seen by that router.`;
      const tip = `Limit every Telnet-enabled vty range on ${router} to PC1's actual source address on that router. Check access-class and transport input.`;
      if (!to.addr || !dev) return missing(expected, to.gap, tip);
      const f = env.probe({ fromDeviceId: 'PC1', dst: to.addr, proto: 'tcp', dport: 23 });
      const src = f.forward.received?.src;
      // A denied/non-working path is not evidence of restriction. Once the TCP path works, grade source policy separately from login.
      if (!f.ok || f.forward.atDeviceId !== router || !f.vty?.accepted || !src) return bad(expected, f.summary, tip, flowTrace(f));
      for (const range of dev.config.lines.vty.filter(vtyAllowsTelnet)) {
        const leak = sourceMismatch(range.accessClassIn ? dev.config.acls[range.accessClassIn] : undefined, [sourceHost(src)],
          { src, dst: '0.0.0.0', proto: 'tcp', sport: 0, dport: 23, tcpSyn: true, ttl: 64, bytes: 0 }, 'outside');
        if (leak) return bad(expected, 'address' in leak
          ? `${router} VTY ${range.first} to ${range.last} would permit a source other than PC1 (${leak.address}).`
          : `Could not establish the effective source restriction for VTY ${range.first} to ${range.last} on ${router}.`, tip);
      }
      for (const from of [...(s.hasPc2 ? ['PC2'] : []), 'PC3']) {
        const target = routerFor(env, router, from);
        if (!target.addr) continue; // The source-ACL check above does not depend on other PCs being online.
        const other = env.probe({ fromDeviceId: from, dst: target.addr, proto: 'tcp', dport: 23 });
        if (other.forward.atDeviceId === router && other.vty?.accepted) return bad(expected, other.vty.text, tip, flowTrace(other));
      }
      return ok(expected, `Only the source address ${src} seen for PC1 is permitted on ${router}.`, flowTrace(f));
    },
  });
  const req: ReqDef = { id: 'telnet', title: 'Telnet: both routers accept PC1 only', feature: 'vty', points: 2, checks: [accepted('R1'), accepted('R2'), allowed('R1'), allowed('R2')] };
  b.requirements = [req];
  b.steps = [{
    id: 'telnet', title: 'Telnet to both routers, only from PC1', feature: 'vty', devices: ['R1', 'R2'],
    goal: `Allow Telnet on both routers only from PC1${requiredPassword !== undefined ? ' using the given line password' : ''}. Apply the restriction to every Telnet-enabled VTY range.`,
    why: 'Remote access saves moving the console cable. An open Telnet port is a risk, so it is limited to the management station.',
    hint: `Use a standard ACL with PC1's address and apply it to each Telnet-enabled VTY range with access-class.${nat ? ' On R2, PC1 arrives with its public address after NAT.' : ''}${requiredPassword !== undefined
      ? ' Set the given password and enable login on each of those ranges.'
      : ' The worked example sets a line password and enables login. For this task, the grader checks usable access and the source restriction, not a specific login mode.'}`,
    allows: ['vty', 'acl', 'console', 'pc'],
    script: [
      cfgAction('R1', b.config.R1),
      cfgAction('R2', b.config.R2),
      { kind: 'note', text: `Check on PC1: telnet <R1 LAN address> and telnet <R2 WAN address>. Try Telnet from ${s.hasPc2 ? 'PC2' : 'PC3'} too: only PC1 may connect.` },
    ],
    done: (env) => reqPasses(env, req),
  }];
  return b;
}

// ───────────────────────────── SNMP ─────────────────────────────
export function snmpConfig(s: Spec): Record<string, string[]> {
  const m = model(s);
  const o = s.snmp!;
  const a = s.addr;
  const one = (pc1: string): string[] => {
    const acl10 = o.readers === 'lan1'
      ? [`access-list 10 permit ${a.lan1.net} ${wildOf(a.lan1)}`]
      : [`access-list 10 permit host ${pc1}`, `access-list 10 permit host ${m.pc3}`];
    const out = [...acl10, `access-list 11 permit host ${pc1}`, `snmp-server community ${o.ro} RO 10`, `snmp-server community ${o.rw} RW 11`];
    if (o.location) out.push(`snmp-server location ${o.location}`);
    if (o.contact) out.push(`snmp-server contact ${o.contact}`);
    return out;
  };
  return { R1: one(m.pc1), R2: one(m.pc1Outside) };
}

interface SnmpTry { ok: boolean; value?: string; f: SimFlowResult }
function snmpTry(env: Env, from: string, to: Target & { addr: string }, community: string, op: 'get' | 'set', oid = 'sysName'): SnmpTry {
  const spec: FlowSpec = {
    fromDeviceId: from, dst: to.addr, proto: 'udp', dport: 161,
    app: op === 'get' ? { kind: 'snmp', op, community, oid } : { kind: 'snmp', op, community, oid: 'sysContact', value: 'lab-check' },
  };
  const f = env.probe(spec);
  const app = f.reverse?.received?.app;
  const good = f.ok && f.forward.atDeviceId === to.dev && !!app && app.kind === 'snmp' && app.op === 'response' && !app.error
    && (op !== 'set' || app.value === 'STRING: lab-check');
  return { ok: good, value: good && app && app.kind === 'snmp' ? app.value : undefined, f };
}

export function snmpPart(s: Spec): Built {
  const b = emptyBuilt('snmp');
  const o = s.snmp!;
  b.config = snmpConfig(s);
  const nat = has(s, 'nat');
  const readers = o.readers === 'lan1' ? ['PC1', ...(s.hasPc2 ? ['PC2'] : [])] : ['PC1', 'PC3'];
  const others = ['PC1', ...(s.hasPc2 ? ['PC2'] : []), 'PC3'].filter((x) => !readers.includes(x));
  const nonWriters = [...(s.hasPc2 ? ['PC2'] : []), 'PC3'];
  /** Community names to try: the given ones, or every community the router has (read-only first for reading, read-write first for writing). */
  const names = (env: Env, router: 'R1' | 'R2', op: 'get' | 'set'): string[] => {
    if (o.namesGiven) return [op === 'get' ? o.ro : o.rw];
    const dev = router === 'R1' ? env.r1 : env.r2;
    const all = dev?.config.snmp.communities ?? [];
    const firstKind = op === 'get' ? 'ro' : 'rw';
    return [...all.filter((c) => c.access === firstKind), ...all.filter((c) => c.access !== firstKind)].map((c) => c.name);
  };
  const tipAcl = nat
    ? 'Each community has its own access list. On R2 the list must permit the address R2 sees: PC1 arrives there with its public address.'
    : 'Each community has its own access list. Check with show snmp community and show access-lists.';

  const can = (env: Env, from: string, op: 'get' | 'set'): Outcome => {
    const word = op === 'get' ? 'reads from' : 'writes to';
    const expected = `${from} ${word} R1 and R2 with SNMP${o.namesGiven ? ` (community ${op === 'get' ? o.ro : o.rw})` : ''}.`;
    const seen: string[] = [];
    for (const router of ['R1', 'R2'] as const) {
      const to = routerFor(env, router, from);
      if (!to.addr) return missing(expected, to.gap, tipAcl);
      const list = names(env, router, op);
      if (list.length === 0) return bad(expected, `${router} has no SNMP community yet.`, `Create the communities with snmp-server community <name> RO <list> and snmp-server community <name> RW <list>.`);
      let hit: string | undefined;
      let firstTry: SnmpTry | undefined;
      for (const c of list) {
        const t = snmpTry(env, from, { ...to, addr: to.addr }, c, op);
        firstTry ??= t;
        if (t.ok) { hit = c; break; }
      }
      if (!hit) {
        const why = firstTry?.f.forward.reasonText ?? firstTry?.f.summary ?? 'No answer.';
        return bad(expected, `${router} does not answer ${from}. ${why}`, op === 'set' ? `Writing needs a read-write (RW) community whose access list permits ${from}. ${tipAcl}` : tipAcl, firstTry ? flowTrace(firstTry.f) : undefined);
      }
      seen.push(`${router} answers ${from} with community ${hit}.`);
    }
    return ok(expected, seen.join(' '));
  };
  const restricted = (env: Env, op: 'get' | 'set'): Outcome => {
    const word = op === 'get' ? 'read' : 'write';
    const expected = op === 'set' ? 'Only PC1 may write with any community on either router.'
      : `Only ${o.readers === 'lan1' ? 'hosts of LAN1' : 'PC1 and PC3'} may read with any community on either router.`;
    for (const router of ['R1', 'R2'] as const) {
      const dev = router === 'R1' ? env.r1 : env.r2;
      const to = routerFor(env, router, 'PC1');
      if (!dev || !to.addr || !env.a.pc1) return missing(expected, to.gap || 'The source of PC1 is unknown.', tipAcl);
      // Find the actual NAT-visible source; if all requests are blocked the required positive check fails separately.
      const flow = snmpTry(env, 'PC1', { ...to, addr: to.addr }, names(env, router, op)[0] ?? '', op).f;
      const pc1Source = flow.forward.atDeviceId === router && flow.forward.received?.src
        ? flow.forward.received.src : (router === 'R2' && nat ? env.a.r1Lo100?.address : env.a.pc1);
      if (!pc1Source) return missing(expected, `The source of PC1 on ${router} is unknown.`, tipAcl);
      const allowed = [sourceHost(pc1Source)];
      if (op === 'get' && o.readers === 'pc1-pc3' && env.a.pc3) allowed.push(sourceHost(env.a.pc3));
      if (op === 'get' && o.readers === 'lan1' && env.a.r1Lan) {
        const lan = env.a.r1Lan;
        allowed.push({ kind: 'net', address: networkOf(lan.address, lan.mask), wildcard: maskToWildcard(lan.mask) });
      }
      for (const c of dev.config.snmp.communities) {
        if (op === 'set' && c.access !== 'rw') continue;
        for (const ifc of Object.values(dev.config.interfaces)) {
          for (const address of [ifc.ip, ...(ifc.secondary ?? [])]) {
            if (ifc.shutdown || !address) continue;
            const leak = sourceMismatch(c.acl ? dev.config.acls[c.acl] : undefined, allowed,
              { src: pc1Source, dst: address.address, proto: 'udp', sport: 49152, dport: 161, ttl: 64, bytes: 0 }, 'outside');
            if (leak) return bad(expected, 'address' in leak
              ? `${router} community ${c.name} would allow ${leak.address}, an unauthorized source, to ${word}.`
              : `Could not establish the effective source restriction of community ${c.name} on ${router}.`, tipAcl);
            if (op === 'get' && o.readers === 'lan1' && c.name === o.ro) {
              const gap = sourceMismatch(c.acl ? dev.config.acls[c.acl] : undefined, allowed,
                { src: pc1Source, dst: address.address, proto: 'udp', sport: 49152, dport: 161, ttl: 64, bytes: 0 }, 'inside');
              if (gap) return bad(expected, 'address' in gap ? `${router} community ${c.name} does not let LAN1 source ${gap.address} read.`
                : `Could not establish LAN1 coverage of community ${c.name} on ${router}.`, tipAcl);
            }
          }
        }
        for (const from of op === 'get' ? others : nonWriters) {
          const target = routerFor(env, router, from);
          if (!target.addr) continue;
          const { f } = snmpTry(env, from, { ...target, addr: target.addr }, c.name, op);
          // A denied response is NOT the same as a denied request (an SNMP SET can already have mutated the MIB).
          if (f.forward.ok && f.forward.atDeviceId === router) return bad(expected, `${router} accepts an SNMP ${op} from ${from} with community ${c.name}.`, tipAcl, flowTrace(f));
        }
      }
    }
    return ok(expected, `Both routers restrict ${word} access to the permitted sources.`);
  };
  const checks: CheckDef[] = [
    { id: 'pc1-read', label: 'PC1 can read from both routers', run: (env) => can(env, 'PC1', 'get') },
    { id: 'pc1-write', label: 'PC1 can write to both routers', run: (env) => can(env, 'PC1', 'set') },
  ];
  for (const r of readers.filter((x) => x !== 'PC1')) {
    checks.push({ id: `${r.toLowerCase()}-read`, label: `${r} can read from both routers`, run: (env) => can(env, r, 'get') });
  }
  checks.push({
    id: 'no-write', label: `${nonWriters.join(' and ')} cannot write`, needs: ['pc1-write'],
    run: (env) => restricted(env, 'set'),
  });
  if (others.length) {
    checks.push({
      id: 'no-read', label: `${others.join(' and ')} cannot read`, needs: ['pc1-read'],
      run: (env) => restricted(env, 'get'),
    });
  }
  if (o.location || o.contact) {
    checks.push({
      id: 'info', label: 'Location and contact are set on both routers', needs: ['pc1-read'],
      run(env) {
        const expected = `PC1 reads sysLocation "${o.location ?? ''}" and sysContact "${o.contact ?? ''}" from R1 and R2.`;
        for (const router of ['R1', 'R2'] as const) {
          const to = routerFor(env, router, 'PC1');
          if (!to.addr) return missing(expected, to.gap, tipAcl);
          const c = names(env, router, 'get')[0];
          for (const [oid, want] of [['sysLocation', o.location], ['sysContact', o.contact]] as const) {
            if (!want) continue;
            const t = snmpTry(env, 'PC1', { ...to, addr: to.addr }, c, 'get', oid);
            const got = (t.value ?? '').replace(/^STRING:\s*/, '');
            if (!t.ok || got !== want) return bad(expected, `${router} answers ${oid} = "${got}".`, 'Use snmp-server location <text> and snmp-server contact <text>.', flowTrace(t.f));
          }
        }
        return ok(expected, 'Both routers answer with the right location and contact.');
      },
    });
  }
  const who = o.readers === 'lan1' ? 'every host of LAN1 may read' : 'PC1 and PC3 may read';
  const req: ReqDef = { id: 'snmp', title: `SNMP on both routers: ${who}, only PC1 may write`, feature: 'snmp', points: 2, checks };
  b.requirements = [req];
  b.steps = [{
    id: 'snmp', title: 'SNMP communities with access lists', feature: 'snmp', devices: ['R1', 'R2'],
    goal: `Create a read-only and a read-write community on both routers${o.namesGiven ? ` (${o.ro} and ${o.rw})` : ''}${o.location ? `, with location ${o.location} and contact ${o.contact}` : ''}. ${o.readers === 'lan1' ? 'Every host of LAN1 may read' : 'PC1 and PC3 may read'}, only PC1 may write.`,
    why: 'A community name works like a password that is sent in clear text. The access list decides who may use it at all.',
    hint: nat
      ? 'Two standard access lists per router: one for the readers, one for the writer. Add the list number at the end of each community line. On R2 use the address that R2 sees for PC1.'
      : 'Two standard access lists per router: one for the readers, one for the writer. Add the list number at the end of each community line.',
    allows: ['snmp', 'acl', 'console', 'pc'],
    script: [
      cfgAction('R1', b.config.R1),
      cfgAction('R2', b.config.R2),
      { kind: 'note', text: 'Check with the SNMP tool on PC1: read sysName from both routers, then write sysContact. Try to write from PC3: it must time out.' },
    ],
    done: (env) => reqPasses(env, req),
  }];
  return b;
}

// ───────────────────────────── syslog ─────────────────────────────
export function syslogConfig(s: Spec): Record<string, string[]> {
  const m = model(s);
  const o = s.syslog!;
  const one = (srcIf: string, pc1: string): string[] => [
    `logging source-interface ${srcIf}`, `logging ${pc1}`, ...(o.allLevels ? ['logging trap debugging'] : []),
  ];
  return {
    R1: one(o.source === 'Loopback0' ? 'Loopback0' : s.ports.r1Lan, m.pc1),
    R2: one(o.source === 'Loopback0' ? 'Loopback0' : s.ports.r2Lan, m.pc1Outside),
  };
}

export function syslogPart(s: Spec): Built {
  const b = emptyBuilt('syslog');
  const o = s.syslog!;
  b.config = syslogConfig(s);
  b.pcs = { PC1: { mode: 'static', services: { syslog: true } } };
  const nat = has(s, 'nat');
  const srcName = o.source === 'Loopback0' ? 'Loopback0' : 'its LAN interface';
  const check = (router: 'R1' | 'R2'): CheckDef => ({
    id: router.toLowerCase(), label: `PC1 receives the messages of ${router}, sent from the address of ${srcName}`,
    run(env) {
      const want = o.source === 'Loopback0'
        ? (router === 'R1' ? env.a.r1Lo0?.address : env.a.r2Lo0?.address)
        : (router === 'R1' ? env.a.r1Lan?.address : env.a.r2Lan?.address);
      const expected = `The syslog server on PC1 records a message from ${router}${o.allLevels ? ' (also at debugging level)' : ''}. Its source address is ${want ?? `the address of ${srcName}`}.`;
      const tip = router === 'R2' && nat
        ? 'On R2 the logging host is the public address of PC1. Set logging source-interface too. Check with show logging.'
        : 'Enter logging <PC1 address> and logging source-interface. Check with show logging.';
      if (!want) return missing(expected, `${router} has no address on ${srcName} yet.`, tip);
      const dev = router === 'R1' ? env.r1 : env.r2;
      if (!dev || dev.config.logging.hosts.length === 0) return bad(expected, `${router} has no logging host yet.`, tip);
      // Only the focused lab specifies a severity threshold. Use an emergency event for the case to test any enabled threshold.
      const severity = o.allLevels ? 7 : 0;
      switch (syslogBlockReason(dev, severity)) {
        case 'logging-off':
          return bad(expected, `${router} has system logging disabled (no logging on).`, 'Enter logging on to re-enable system logging.');
        case 'trap-off':
          return bad(expected, `${router} has remote syslog disabled (no logging trap).`,
            o.allLevels ? 'Enter logging trap debugging to enable remote syslog at every level.' : 'Enter logging trap to re-enable remote syslog.');
        case 'severity':
          return bad(expected, `${router} filters out the required debugging-level message.`, 'Enter logging trap debugging so that every level is sent.');
      }
      const probes = syslogProbe(probeWorld(env.world), router, severity);
      if (!probes.length) return bad(expected, `${router} made no attempt to send the test message.`, tip);
      const atPc1 = probes.find((p) => p.received && p.flow.forward.atDeviceId === 'PC1' && p.seenFrom === want)
        ?? probes.find((p) => p.flow.forward.atDeviceId === 'PC1');
      if (!atPc1) return bad(expected, `${router} logs to ${probes[0].host}. The message does not arrive at PC1. ${probes[0].flow.summary}`, tip, flowTrace(probes[0].flow));
      if (!atPc1.received) return bad(expected, 'The message arrives at PC1, but the syslog server on PC1 is switched off.', 'Open PC1 and start its syslog server.', flowTrace(atPc1.flow));
      if (atPc1.seenFrom !== want) {
        return bad(expected, `PC1 records the message from ${atPc1.seenFrom}.`, `Set the source with logging source-interface ${o.source === 'Loopback0' ? 'Loopback0' : '<LAN interface>'}.`, flowTrace(atPc1.flow));
      }
      return ok(expected, `PC1 records the message from ${atPc1.seenFrom}.`, flowTrace(atPc1.flow));
    },
  });
  const req: ReqDef = { id: 'syslog', title: `Syslog: both routers log to PC1 from the address of ${srcName}`, feature: 'syslog', points: 1, checks: [check('R1'), check('R2')] };
  b.requirements = [req];
  b.steps = [{
    id: 'syslog', title: 'Syslog to PC1', feature: 'syslog', devices: ['R1', 'R2', 'PC1'],
    goal: `Start the syslog server on PC1. Make both routers send their system messages${o.allLevels ? ' of every level, including debugging,' : ''} to PC1, with the address of ${srcName} as the source.`,
    why: 'One central log shows what happened on every router. A fixed source address tells you at once which router wrote the line.',
    hint: nat
      ? 'Two global commands per router: the logging host and the source interface. From R2, PC1 is only reachable under its public address.'
      : o.allLevels
        ? 'Three global commands per router: the logging host, the source interface and the trap level. The trap level decides how detailed the messages are.'
        : 'Two global commands per router: the logging host and the source interface.',
    allows: ['syslog', 'pc', 'interface', 'console'],
    script: [
      { kind: 'pc', pcId: 'PC1', setup: b.pcs.PC1 },
      cfgAction('R1', b.config.R1),
      cfgAction('R2', b.config.R2),
      { kind: 'note', text: 'Leave configuration mode with end on each router. With the default trap level (informational) or debugging, PC1 should collect a %SYS-5-CONFIG_I message.' },
    ],
    done: (env) => reqPasses(env, req),
  }];
  return b;
}
