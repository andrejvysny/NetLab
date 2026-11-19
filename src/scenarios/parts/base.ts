/**
 * Base parts: cabling, console access, router basics (names, addresses, interface state), PC addressing,
 * static routing with reachability, and saving the configuration. Owned by the scenario agent.
 */
import type { PcSetup, SolutionCable } from '../../engine/types.ts';
import { ipToInt, isPrivate, maskToPrefix, networkOf, shortIfName } from '../../engine/ip.ts';
import { renderRunningConfig } from '../../engine/config/render.ts';
import { consolePeer, interfaceState, routingTable, serialClock } from '../../engine/sim/index.ts';
import type { Action, CheckDef, Outcome, ReqDef } from '../checks.ts';
import { allOf, bad, missing, ok, reqPasses } from '../checks.ts';
import type { Env, PathEnd } from '../env.ts';
import { pathProblem } from '../env.ts';
import type { Spec } from '../spec.ts';
import { M32, cidr, clockFits, dhcpClients, has, host, isTask, maskOf, model } from '../spec.ts';
import type { Built } from './common.ts';
import { T, block, cfgAction, emptyBuilt, works } from './common.ts';

// ───────────────────────────── cabling ─────────────────────────────
export function dataCables(s: Spec): SolutionCable[] {
  const p = s.ports;
  const out: SolutionCable[] = [
    { kind: 'straight', a: { deviceId: 'PC1', port: 'Ethernet0' }, b: { deviceId: 'SW1', port: p.swPc1 } },
  ];
  if (s.hasPc2) out.push({ kind: 'straight', a: { deviceId: 'PC2', port: 'Ethernet0' }, b: { deviceId: 'SW1', port: p.swPc2 } });
  out.push({ kind: 'straight', a: { deviceId: 'SW1', port: p.swR1 }, b: { deviceId: 'R1', port: p.r1Lan } });
  if (s.wan === 'serial') {
    out.push({ kind: 'serial', a: { deviceId: 'R1', port: p.r1Wan }, b: { deviceId: 'R2', port: p.r2Wan }, dceEnd: 'a', note: 'The DCE end is on R1.' });
  } else {
    out.push({ kind: 'crossover', a: { deviceId: 'R1', port: p.r1Wan }, b: { deviceId: 'R2', port: p.r2Wan } });
  }
  out.push({ kind: 'crossover', a: { deviceId: 'R2', port: p.r2Lan }, b: { deviceId: 'PC3', port: 'Ethernet0' } });
  return out;
}

const CABLE_TIP = 'A PC or router to a switch needs a straight-through cable. Two routers, or a router and a PC, need a crossover cable.';

export function cablingPart(s: Spec): Built {
  const b = emptyBuilt('cabling');
  b.cables = dataCables(s);
  const lan1: CheckDef = {
    id: 'lan1',
    label: s.hasPc2 ? 'LAN1: PC1 and PC2 are wired to R1 through the switch' : 'LAN1: PC1 is wired to R1 through the switch',
    run(env) {
      const expected = s.hasPc2
        ? 'PC1 and PC2 lead through a switch to the same port of R1. Every cable on the way fits.'
        : 'PC1 leads through a switch to a port of R1. Every cable on the way fits.';
      const find = (pc: string): PathEnd | undefined => env.roles.fromPc[pc]?.find((e) => e.ref.deviceId === 'R1');
      const wired = (pc: string): boolean => (env.roles.fromPc[pc]?.length ?? 0) > 0 || env.world.cables.some((c) => c.kind !== 'console' && (c.a.deviceId === pc || c.b.deviceId === pc));
      const e1 = find('PC1');
      if (!e1) return bad(expected, wired('PC1') ? 'PC1 has a cable, but the cables do not lead to R1 yet.' : 'PC1 has no network cable yet.', CABLE_TIP);
      let e2: PathEnd | undefined;
      if (s.hasPc2) {
        e2 = find('PC2');
        if (!e2) return bad(expected, wired('PC2') ? 'PC2 has a cable, but the cables do not lead to R1 yet.' : 'PC2 has no network cable yet.', CABLE_TIP);
        if (e2.ref.port !== e1.ref.port) {
          return bad(expected, `PC1 leads to R1 ${shortIfName(e1.ref.port)}, PC2 leads to R1 ${shortIfName(e2.ref.port)}. LAN1 is one network, so both must end on the same router port.`,
            'Plug both PCs into the switch. Use one cable from the switch to R1.');
        }
      }
      const prob = pathProblem(env.world, e1.path) ?? (e2 ? pathProblem(env.world, e2.path) : null);
      if (prob) return bad(expected, prob, CABLE_TIP);
      const sw = e1.switches.length ? env.world.devices[e1.switches[0]]?.label ?? e1.switches[0] : 'no switch';
      return ok(expected, `${s.hasPc2 ? 'PC1 and PC2 reach' : 'PC1 reaches'} R1 ${shortIfName(e1.ref.port)} through ${sw}.`);
    },
  };
  const wan: CheckDef = {
    id: 'wan',
    label: s.wan === 'serial' ? 'WAN: R1 and R2 are joined by a serial cable' : 'WAN: R1 and R2 are joined by an Ethernet crossover cable',
    run(env) {
      const expected = s.wan === 'serial'
        ? 'One serial cable goes straight from R1 to R2.'
        : 'One Ethernet crossover cable goes straight from R1 to R2.';
      const r = env.roles;
      if (!r.r1Wan || !r.r2Wan || r.wanPath.length === 0) {
        return bad(expected, 'No cable joins R1 and R2 yet.', s.wan === 'serial' ? 'Use the serial cable between two Serial ports.' : 'Use a crossover cable between two Gigabit ports of the routers.');
      }
      if (r.wanSwitches.length > 0) {
        return bad(expected, 'R1 and R2 are joined through a switch. The task needs a direct point-to-point link.', 'Run one cable straight from R1 to R2.');
      }
      const c = r.wanPath[0];
      if (s.wan === 'serial' && c.kind !== 'serial') {
        return bad(expected, `R1 and R2 are joined by an Ethernet cable (R1 ${shortIfName(r.r1Wan)} to R2 ${shortIfName(r.r2Wan)}). This link must be a serial link.`,
          'Use the serial cable between the Serial ports. Only a serial link can be clocked to a fixed speed.');
      }
      const prob = pathProblem(env.world, r.wanPath);
      if (prob) return bad(expected, prob, CABLE_TIP);
      const dce = c.kind === 'serial' ? ` The DCE end is on ${(c.dceEnd ?? 'a') === 'a' ? c.a.deviceId : c.b.deviceId}.` : '';
      return ok(expected, `R1 ${shortIfName(r.r1Wan)} and R2 ${shortIfName(r.r2Wan)} are joined by a ${c.kind === 'serial' ? 'serial' : c.kind} cable.${dce}`);
    },
  };
  const lan2: CheckDef = {
    id: 'lan2',
    label: 'LAN2: PC3 is wired to R2',
    run(env) {
      const expected = 'PC3 leads to a port of R2 with a cable that fits. PC3 is not part of LAN1.';
      const ends = env.roles.fromPc['PC3'] ?? [];
      const e3 = ends.find((e) => e.ref.deviceId === 'R2');
      if (!e3) {
        const any = env.world.cables.some((c) => c.kind !== 'console' && (c.a.deviceId === 'PC3' || c.b.deviceId === 'PC3'));
        return bad(expected, any ? 'PC3 has a cable, but it does not lead to R2 yet.' : 'PC3 has no network cable yet.', 'PC3 plugs straight into R2. A router and a PC need a crossover cable.');
      }
      if (ends.some((e) => e.ref.deviceId === 'R1' && e.ref.port === env.roles.r1Lan)) {
        return bad(expected, 'PC3 sits on the same switch network as LAN1.', 'LAN2 is a separate network behind R2. Take PC3 off the LAN1 switch.');
      }
      const prob = pathProblem(env.world, e3.path);
      if (prob) return bad(expected, prob, CABLE_TIP);
      return ok(expected, `PC3 reaches R2 ${shortIfName(e3.ref.port)}${e3.switches.length ? ' through a switch' : ' directly'}.`);
    },
  };
  const req: ReqDef = { id: 'cabling', title: 'Cabling: every link uses the right cable', feature: 'cabling', points: 2, checks: [lan1, wan, lan2] };
  b.requirements = [req];
  const lines = b.cables.map((c) => ({ kind: 'cable' as const, cable: c }));
  b.steps = [{
    id: 'cable', title: 'Cable the bench', feature: 'cabling',
    devices: ['PC1', ...(s.hasPc2 ? ['PC2'] : []), 'SW1', 'R1', 'R2', 'PC3'],
    goal: 'Connect the devices as the topology shows. Pick the right cable type for every link.',
    why: 'Nothing works without a link. The wrong Ethernet cable type keeps a link down.',
    hint: s.wan === 'serial'
      ? 'PC or router to a switch: straight-through. Router to router here: the serial cable. Router straight to a PC: crossover.'
      : 'PC or router to a switch: straight-through. Router to router, and router to PC: crossover.',
    allows: ['cabling'],
    script: lines,
    done: (env) => reqPasses(env, req),
  }];
  return b;
}

// ───────────────────────────── console ─────────────────────────────
export function consoleCables(): SolutionCable[] {
  return [
    { kind: 'console', a: { deviceId: 'PC1', port: 'COM1' }, b: { deviceId: 'R1', port: 'Console' }, note: 'Console for R1.' },
    { kind: 'console', a: { deviceId: 'PC3', port: 'COM1' }, b: { deviceId: 'R2', port: 'Console' }, note: 'Console for R2. You can also move one console cable between the routers.' },
  ];
}
export function consolePart(_s: Spec): Built {
  const b = emptyBuilt('console');
  b.cables = consoleCables();
  const reached = (env: Env, id: 'R1' | 'R2'): boolean => {
    const dev = id === 'R1' ? env.r1 : env.r2;
    return consolePeer(env.world, id) !== null || !!dev?.runtime.setupDialogDone;
  };
  b.steps = [{
    id: 'console', title: 'Connect the console', feature: 'console', devices: ['PC1', 'R1', 'PC3', 'R2'],
    goal: 'Connect a console cable from a PC to the CON port of each router. Open the terminal and answer "no" to the setup question.',
    why: 'The routers are empty. The console is the only way in.',
    hint: 'The console cable goes from the COM port of a PC to the port marked CON. Use PC1 for R1 and PC3 for R2, so you do not have to move the cable.',
    allows: ['console', 'cabling', 'system'],
    script: [
      ...b.cables.map((c) => ({ kind: 'cable' as const, cable: c })),
      { kind: 'note', text: 'In each terminal: answer no to "Would you like to enter the initial configuration dialog?". Then type enable.' },
    ],
    done: (env) => reached(env, 'R1') && reached(env, 'R2'),
  }];
  return b;
}

// ───────────────────────────── basics: names, addresses, interface state ─────────────────────────────
function prefix(mask: string): number { return maskToPrefix(mask); }
function hostNo(address: string, mask: string): number { return ipToInt(address) - ipToInt(networkOf(address, mask)); }

/** The clock rate is typed with the interface addresses, unless the base is pre-built and the QoS task sets the link speed. */
export function clockInBasics(s: Spec): boolean { return isTask(s, 'basics') || !has(s, 'qos'); }

export function basicsConfig(s: Spec): Record<string, string[]> {
  const m = model(s);
  const a = s.addr;
  const p = s.ports;
  const r1: string[] = ['hostname R1', 'no ip domain-lookup', ...block('interface Loopback0', [`ip address ${a.r1Lo0} ${M32}`])];
  if (a.r1Lo100) r1.push(...block('interface Loopback100', [`ip address ${a.r1Lo100} ${M32}`]));
  r1.push(...block(`interface ${p.r1Lan}`, [`ip address ${m.r1Lan} ${m.mLan1}`, 'no shutdown']));
  r1.push(...block(`interface ${p.r1Wan}`, [`ip address ${m.r1Wan} ${m.mWan}`, ...(m.clock && clockInBasics(s) ? [`clock rate ${m.clock}`] : []), 'no shutdown']));
  const r2: string[] = ['hostname R2', 'no ip domain-lookup', ...block('interface Loopback0', [`ip address ${a.r2Lo0} ${M32}`])];
  r2.push(...block(`interface ${p.r2Lan}`, [`ip address ${m.r2Lan} ${m.mLan2}`, 'no shutdown']));
  r2.push(...block(`interface ${p.r2Wan}`, [`ip address ${m.r2Wan} ${m.mWan}`, 'no shutdown']));
  return { R1: r1, R2: r2 };
}

const IF_TIP = 'Run show ip interface brief on the router. Compare the addresses and masks with the task sheet.';

export function basicsPart(s: Spec): Built {
  const b = emptyBuilt('basics');
  const m = model(s);
  const a = s.addr;
  b.config = basicsConfig(s);

  const wan: CheckDef = {
    id: 'wan', label: `WAN1: both routers use a /${a.wan.len} mask in one network`,
    run(env) {
      const expected = s.addrGiven
        ? `R1's WAN interface has ${m.r1Wan}/${a.wan.len}. R2's WAN interface has ${m.r2Wan}/${a.wan.len}.`
        : `Both WAN interfaces have a /${a.wan.len} mask. They hold the two host addresses of one public network.`;
      const x = env.a.r1Wan;
      const y = env.a.r2Wan;
      if (!env.roles.r1Wan) return missing(expected, 'R1 and R2 are not joined by a cable yet.', 'Cable the WAN link first.');
      if (!x || !y) return missing(expected, `${!x ? 'R1' : 'R2'} has no IP address on its WAN interface yet.`, IF_TIP);
      const seen = `R1 ${shortIfName(env.roles.r1Wan)} has ${x.address}/${prefix(x.mask)}. R2 ${shortIfName(env.roles.r2Wan ?? '')} has ${y.address}/${prefix(y.mask)}.`;
      if (prefix(x.mask) !== a.wan.len || prefix(y.mask) !== a.wan.len) return bad(expected, seen, `A /${a.wan.len} mask is ${maskOf(a.wan)}.`);
      if (networkOf(x.address, x.mask) !== networkOf(y.address, y.mask) || x.address === y.address) {
        return bad(expected, `${seen} The two addresses are not two different hosts of one network.`, 'A /30 network has exactly two host addresses. Give one to each router.');
      }
      const h1 = hostNo(x.address, x.mask);
      const h2 = hostNo(y.address, y.mask);
      const size = 2 ** (32 - a.wan.len);
      if (h1 === 0 || h2 === 0 || h1 === size - 1 || h2 === size - 1) {
        return bad(expected, `${seen} One of them is the network or broadcast address.`, 'Use the two addresses between the network address and the broadcast address.');
      }
      if (s.addrGiven && (x.address !== m.r1Wan || y.address !== m.r2Wan)) return bad(expected, seen, IF_TIP);
      if (!s.addrGiven && has(s, 'nat') && (isPrivate(x.address) || isPrivate(y.address))) {
        return bad(expected, `${seen} This is a private network.`, 'WAN1 stands for the public side. Pick a public network, not 10.x, 172.16-31.x or 192.168.x.');
      }
      return ok(expected, seen);
    },
  };
  const lan1: CheckDef = {
    id: 'lan1', label: `LAN1: R1 uses host .1 with a /${a.lan1.len} mask in a private class C network`,
    run(env) {
      const expected = s.addrGiven
        ? `R1's LAN interface has ${m.r1Lan}/${a.lan1.len}.`
        : `R1's LAN interface has a /${a.lan1.len} mask, a private class C network (192.168.x.0) and host number 1.`;
      const x = env.a.r1Lan;
      if (!env.roles.r1Lan) return missing(expected, 'No R1 port is wired to PC1 yet.', 'Cable LAN1 first.');
      if (!x) return missing(expected, `R1 ${shortIfName(env.roles.r1Lan)} (the port towards PC1) has no IP address yet.`, IF_TIP);
      const seen = `R1 ${shortIfName(env.roles.r1Lan)} has ${x.address}/${prefix(x.mask)}.`;
      if (prefix(x.mask) !== a.lan1.len) return bad(expected, seen, `A /${a.lan1.len} mask is ${maskOf(a.lan1)}.`);
      if (s.addrGiven) return x.address === m.r1Lan ? ok(expected, seen) : bad(expected, seen, IF_TIP);
      if (!x.address.startsWith('192.168.')) return bad(expected, `${seen} That is not a private class C network.`, 'Private class C networks are 192.168.0.0 to 192.168.255.0.');
      if (hostNo(x.address, x.mask) !== 1) return bad(expected, `${seen} The host number is not 1.`, 'The router takes the first address of its LAN.');
      return ok(expected, seen);
    },
  };
  const lan2: CheckDef = {
    id: 'lan2', label: `LAN2: R2 uses host .1 with a /${a.lan2.len} mask`,
    run(env) {
      const expected = s.addrGiven
        ? `R2's LAN interface has ${m.r2Lan}/${a.lan2.len}.`
        : `R2's LAN interface has a /${a.lan2.len} mask and the first host address of its network.`;
      const x = env.a.r2Lan;
      if (!env.roles.r2Lan) return missing(expected, 'No R2 port is wired to PC3 yet.', 'Cable LAN2 first.');
      if (!x) return missing(expected, `R2 ${shortIfName(env.roles.r2Lan)} (the port towards PC3) has no IP address yet.`, IF_TIP);
      const seen = `R2 ${shortIfName(env.roles.r2Lan)} has ${x.address}/${prefix(x.mask)}.`;
      if (prefix(x.mask) !== a.lan2.len) return bad(expected, seen, `A /${a.lan2.len} mask is ${maskOf(a.lan2)}.`);
      if (s.addrGiven) return x.address === m.r2Lan ? ok(expected, seen) : bad(expected, seen, IF_TIP);
      if (hostNo(x.address, x.mask) !== 1) return bad(expected, `${seen} The host number is not 1.`, 'The router takes the first address of its LAN.');
      if (env.a.r1Lan && networkOf(env.a.r1Lan.address, env.a.r1Lan.mask) === networkOf(x.address, env.a.r1Lan.mask)) {
        return bad(expected, `${seen} That overlaps with LAN1.`, 'LAN2 needs its own network.');
      }
      return ok(expected, seen);
    },
  };
  const pcStatic = (pcId: 'PC1' | 'PC2' | 'PC3', hostNumber: number | null, gwOf: (e: Env) => { address: string; mask: string } | undefined, want: string, wantMask: string): CheckDef => ({
    id: pcId.toLowerCase(), label: hostNumber !== null && !s.addrGiven ? `${pcId} has a static address with host number ${hostNumber}` : `${pcId} has its static address`,
    run(env) {
      const gw = gwOf(env);
      const expected = s.addrGiven || hostNumber === null
        ? `${pcId} is set to a static address ${want}, mask ${wantMask}, with the router as default gateway.`
        : `${pcId} is set to a static address with host number ${hostNumber} in its LAN, the LAN mask, and the router as default gateway.`;
      const pc = env.pc(pcId);
      if (!pc) return missing(expected, `${pcId} is not on the bench.`, '');
      if (pc.nic.mode !== 'static' || !pc.nic.address || !pc.nic.mask) {
        return bad(expected, `${pcId} is set to ${pc.nic.mode === 'dhcp' ? 'DHCP' : 'static'} and has ${pc.nic.address ?? 'no address'}.`, `Open ${pcId} and enter the address, the mask and the gateway by hand.`);
      }
      const seen = `${pcId} has ${pc.nic.address}, mask ${pc.nic.mask}, gateway ${pc.nic.gateway ?? 'none'}.`;
      if (!gw) return missing(expected, `${seen} The router's LAN interface has no address yet.`, IF_TIP);
      if (pc.nic.mask !== gw.mask || networkOf(pc.nic.address, gw.mask) !== networkOf(gw.address, gw.mask)) {
        return bad(expected, `${seen} That does not fit the router's LAN (${gw.address}/${prefix(gw.mask)}).`, 'The PC and the router interface must be in the same network with the same mask.');
      }
      if (pc.nic.gateway !== gw.address) return bad(expected, seen, `The default gateway is the router's LAN address, ${gw.address}.`);
      if (s.addrGiven && pc.nic.address !== want) return bad(expected, seen, `The sheet gives ${want} to ${pcId}.`);
      if (!s.addrGiven && hostNumber !== null && hostNo(pc.nic.address, pc.nic.mask) !== hostNumber) {
        return bad(expected, `${seen} The host number is ${hostNo(pc.nic.address, pc.nic.mask)}.`, `Use host number ${hostNumber}: the network address plus ${hostNumber}.`);
      }
      return ok(expected, seen);
    },
  });
  const loopbacks: CheckDef = {
    id: 'loopbacks', label: a.r1Lo100 ? 'Loopbacks: R1 Loopback0, R1 Loopback100 and R2 Loopback0 exist with a /32 mask' : 'Loopbacks: Loopback0 exists on both routers with a /32 mask',
    run(env) {
      const want: { name: string; got?: { address: string; mask: string }; fixed?: string }[] = [
        { name: 'R1 Loopback0', got: env.a.r1Lo0, fixed: a.r1Lo0 },
        ...(a.r1Lo100 ? [{ name: 'R1 Loopback100', got: env.a.r1Lo100, fixed: a.r1Lo100 }] : []),
        { name: 'R2 Loopback0', got: env.a.r2Lo0, fixed: a.r2Lo0 },
      ];
      const expected = s.addrGiven
        ? `${want.map((w) => `${w.name} has ${w.fixed}/32`).join('. ')}.`
        : `${want.map((w) => w.name).join(', ')}: each has its own address with mask 255.255.255.255 (/32).`;
      const seen = want.map((w) => `${w.name}: ${w.got ? `${w.got.address}/${prefix(w.got.mask)}` : 'missing'}`).join('. ') + '.';
      const tip = 'Create the interface with interface Loopback<number> and give it an address with mask 255.255.255.255.';
      if (want.some((w) => !w.got)) return bad(expected, seen, tip);
      if (want.some((w) => prefix(w.got!.mask) !== 32)) return bad(expected, seen, 'A /32 mask is 255.255.255.255.');
      const all = want.map((w) => w.got!.address);
      if (new Set(all).size !== all.length) return bad(expected, `${seen} Two loopbacks share one address.`, 'Every loopback needs its own address.');
      if (s.addrGiven && want.some((w) => w.got!.address !== w.fixed)) return bad(expected, seen, tip);
      return ok(expected, seen);
    },
  };
  const up: CheckDef = {
    id: 'up', label: 'The LAN and WAN interfaces of both routers are up',
    run(env) {
      const expected = 'R1 and R2 each show their LAN and WAN interface as up/up.';
      const list: [string, string | undefined, string][] = [
        ['R1', env.roles.r1Lan, 'LAN'], ['R1', env.roles.r1Wan, 'WAN'], ['R2', env.roles.r2Wan, 'WAN'], ['R2', env.roles.r2Lan, 'LAN'],
      ];
      const seen: string[] = [];
      let problem: string | undefined;
      for (const [dev, ifName, role] of list) {
        if (!ifName) { problem ??= `${dev} has no cabled ${role} port yet.`; seen.push(`${dev} ${role}: not cabled`); continue; }
        const st = interfaceState(env.world, dev, ifName);
        seen.push(`${dev} ${shortIfName(ifName)}: ${st.status}/${st.protocol}`);
        if (!(st.status === 'up' && st.protocol === 'up')) problem ??= st.problem ?? `${dev} ${ifName} is ${st.status}/${st.protocol}.`;
      }
      if (problem) {
        const uncabled = list.some(([, ifName]) => !ifName);
        return bad(expected, `${seen.join('. ')}. ${problem}`, uncabled
          ? 'Cable the links first. Then give the interfaces their addresses and enter no shutdown.'
          : 'Router ports start shut down. Enter no shutdown on each interface you use. show ip interface brief shows the state.');
      }
      return ok(expected, `${seen.join('. ')}.`);
    },
  };
  const checks: CheckDef[] = [wan, lan1, lan2];
  if (has(s, 'pcs')) {
    checks.push(pcStatic('PC1', a.pc1Host, (e) => e.a.r1Lan, m.pc1, m.mLan1));
    if (!dhcpClients(s) && isTask(s, 'pcs')) checks.push(pcStatic('PC3', null, (e) => e.a.r2Lan, m.pc3, m.mLan2));
  }
  checks.push(loopbacks, up);
  if (s.clockRate && s.wan === 'serial' && !has(s, 'qos')) {
    const rate = s.clockRate;
    checks.push({
      id: 'clock', label: `The serial link is clocked at ${rate} bit/s`,
      run(env) {
        const expected = `The DCE end of the serial cable has clock rate ${rate}.`;
        if (!env.roles.r1Wan) return missing(expected, 'R1 and R2 are not joined by a cable yet.', 'Cable the WAN link first.');
        const c = serialClock(env.world, 'R1', env.roles.r1Wan);
        if (!c) return bad(expected, 'The link between the routers is not a serial link.', 'Use the serial cable.');
        const where = `${c.dceDeviceId} ${shortIfName(c.dceIf)} is the DCE end`;
        if (!clockFits(c.configured, rate)) return bad(expected, `${where}. Its clock rate is ${c.configured ?? 'not set'}.`, `Enter clock rate ${rate} on the DCE interface. show controllers tells you which end is DCE.`);
        return ok(expected, `${where} with clock rate ${c.configured}.`);
      },
    });
  }
  const req: ReqDef = { id: 'addressing', title: 'Addresses, masks and interface state', feature: 'interface', points: 2, checks };
  b.requirements = [req];

  const cfg = b.config;
  const has1 = (env: Env): boolean => {
    const c = env.r1?.config.interfaces;
    const lanOk = !!env.a.r1Lan && !!env.roles.r1Lan && !c?.[env.roles.r1Lan]?.shutdown;
    const wanOk = !!env.a.r1Wan && !!env.roles.r1Wan && !c?.[env.roles.r1Wan]?.shutdown;
    return lanOk && wanOk && !!env.a.r1Lo0 && (!a.r1Lo100 || !!env.a.r1Lo100);
  };
  const has2 = (env: Env): boolean => {
    const c = env.r2?.config.interfaces;
    const lanOk = !!env.a.r2Lan && !!env.roles.r2Lan && !c?.[env.roles.r2Lan]?.shutdown;
    const wanOk = !!env.a.r2Wan && !!env.roles.r2Wan && !c?.[env.roles.r2Wan]?.shutdown;
    return lanOk && wanOk && !!env.a.r2Lo0;
  };
  const table = s.addrGiven ? 'Use the addresses from the table on the sheet.' : 'You choose the addresses. Follow the rules on the sheet.';
  b.steps = [
    {
      id: 'basics-r1', title: 'R1: name and interface addresses', feature: 'interface', devices: ['R1'],
      goal: `Name the router R1 and give its LAN interface, its WAN interface and its loopback${a.r1Lo100 ? 's' : ''} an address. Switch the LAN and WAN interfaces on.`,
      why: 'Router ports start shut down and without an address. Until that changes, no packet can pass.',
      hint: `${table} LAN1 /${a.lan1.len} is ${maskOf(a.lan1)}. WAN1 /${a.wan.len} is ${maskOf(a.wan)}. A loopback /32 is ${M32}.${s.wan === 'serial' ? ' The DCE end of the serial cable also needs a clock rate.' : ''}`,
      allows: ['system', 'interface', 'console', 'pc'],
      script: [cfgAction('R1', cfg.R1), { kind: 'note', text: 'Check: show ip interface brief' }],
      done: has1,
    },
    {
      id: 'basics-r2', title: 'R2: name and interface addresses', feature: 'interface', devices: ['R2'],
      goal: 'Name the router R2 and give its LAN interface, its WAN interface and Loopback0 an address. Switch the LAN and WAN interfaces on.',
      why: 'The WAN link only comes up when both ends are switched on.',
      hint: `${table} LAN2 /${a.lan2.len} is ${maskOf(a.lan2)}. WAN1 /${a.wan.len} is ${maskOf(a.wan)}.`,
      allows: ['system', 'interface', 'console', 'pc'],
      script: [cfgAction('R2', cfg.R2), { kind: 'note', text: 'Check: show ip interface brief. Then ping the WAN address of R1.' }],
      done: (env) => has2(env) && !!env.roles.r2Wan && interfaceState(env.world, 'R2', env.roles.r2Wan).protocol === 'up',
    },
  ];
  return b;
}

// ───────────────────────────── PC addressing ─────────────────────────────
export function pcSetups(s: Spec): Record<string, PcSetup> {
  const m = model(s);
  const out: Record<string, PcSetup> = { PC1: { mode: 'static', address: m.pc1, mask: m.mLan1, gateway: m.r1Lan } };
  if (dhcpClients(s)) {
    if (s.hasPc2) out.PC2 = { mode: 'dhcp' };
    out.PC3 = { mode: 'dhcp' };
  } else {
    if (s.hasPc2) out.PC2 = { mode: 'static', address: m.pc2, mask: m.mLan1, gateway: m.r1Lan };
    out.PC3 = { mode: 'static', address: m.pc3, mask: m.mLan2, gateway: m.r2Lan };
  }
  return out;
}
export function pcsPart(s: Spec): Built {
  const b = emptyBuilt('pcs');
  b.pcs = pcSetups(s);
  const dyn = dhcpClients(s);
  const script: Action[] = [{ kind: 'pc', pcId: 'PC1', setup: b.pcs.PC1 }];
  if (!dyn) {
    if (s.hasPc2) script.push({ kind: 'pc', pcId: 'PC2', setup: b.pcs.PC2 });
    script.push({ kind: 'pc', pcId: 'PC3', setup: b.pcs.PC3 });
  }
  script.push({ kind: 'note', text: 'Check on PC1: ping the LAN address of R1.' });
  const fits = (env: Env, pcId: string, gw: { address: string; mask: string } | undefined): boolean => {
    const pc = env.pc(pcId);
    return !!pc && !!gw && pc.nic.mode === 'static' && !!pc.nic.address && pc.nic.gateway === gw.address
      && works(env, { from: pcId, to: T.fixed('the router', gw.address, pcId === 'PC3' ? 'R2' : 'R1'), proto: 'icmp' }, '').pass;
  };
  b.steps = [{
    id: 'pcs', title: dyn ? 'Give PC1 its static address' : 'Give the PCs their static addresses', feature: 'pc',
    devices: dyn ? ['PC1'] : ['PC1', ...(s.hasPc2 ? ['PC2'] : []), 'PC3'],
    goal: dyn
      ? `Set PC1 to a static address with host number ${s.addr.pc1Host}, the LAN1 mask and R1 as default gateway. Leave PC2 and PC3 on DHCP for now.`
      : 'Set each PC to its static address, mask and default gateway.',
    why: 'A PC without a default gateway can only talk inside its own LAN.',
    hint: 'The default gateway of a PC is the LAN address of its router.',
    allows: ['pc', 'console'],
    script,
    done: (env) => fits(env, 'PC1', env.a.r1Lan) && (dyn || ((!s.hasPc2 || fits(env, 'PC2', env.a.r1Lan)) && fits(env, 'PC3', env.a.r2Lan))),
  }];
  return b;
}

// ───────────────────────────── routing and reachability ─────────────────────────────
function tableCheck(router: 'R1' | 'R2'): CheckDef {
  return {
    id: `${router.toLowerCase()}-table`,
    label: `${router}: connected networks plus exactly one static route, no routing protocol`,
    run(env) {
      const expected = `${router} runs no routing protocol. Besides its connected networks, its routing table holds exactly one more entry.`;
      const dev = router === 'R1' ? env.r1 : env.r2;
      if (!dev) return missing(expected, `${router} is not on the bench.`, '');
      const proto = dev.config.rip ? 'RIP' : dev.config.ospf.length ? 'OSPF' : null;
      const table = routingTable(env.world, router);
      const extra = table.filter((r) => r.code !== 'C' && r.code !== 'L');
      const text = extra.length === 0 ? 'no extra entry' : extra.map((r) => `${r.code}${r.isDefault ? '*' : ''} ${r.prefix}/${r.prefixLen}`).join(', ');
      const waiting = dev.config.staticRoutes.length - extra.filter((r) => r.code === 'S').length;
      const seen = `${router} has ${text}${proto ? `, and ${proto} is configured` : ''}${waiting > 0 ? `. ${waiting} configured static route${waiting > 1 ? 's are' : ' is'} not in the table (its interface is down)` : ''}.`;
      if (proto) return bad(expected, seen, `Remove the routing protocol (no router ${proto.toLowerCase()}${proto === 'OSPF' ? ' <id>' : ''}). Use one static default route instead.`);
      if (extra.length !== 1 || dev.config.staticRoutes.length !== 1) {
        return bad(expected, seen, 'One default route is enough: ip route 0.0.0.0 0.0.0.0 with the WAN interface and the address of the other router. Check with show ip route.');
      }
      return ok(expected, seen);
    },
  };
}

export function routingConfig(s: Spec): Record<string, string[]> {
  const m = model(s);
  const out: Record<string, string[]> = { R1: [`ip route 0.0.0.0 0.0.0.0 ${s.ports.r1Wan} ${m.r2Wan}`] };
  if (s.r2Default) out.R2 = [`ip route 0.0.0.0 0.0.0.0 ${s.ports.r2Wan} ${m.r1Wan}`];
  return out;
}

const REACH_TIP = 'Ping one hop at a time: first the own gateway, then the WAN address of the far router, then the far PC. The first ping that fails shows where to look.';

export function routingPart(s: Spec): Built {
  const b = emptyBuilt('routing');
  b.config = routingConfig(s);
  const routes: ReqDef = {
    id: 'routes', title: 'Routing: one static default route, no routing protocol', feature: 'routing', points: 2,
    checks: s.r2Default ? [tableCheck('R1'), tableCheck('R2')] : [tableCheck('R1')],
  };
  const aclCase = has(s, 'acl') && s.acl?.mode === 'case' ? s.acl : undefined;
  const pc1ToPc3 = !(aclCase && aclCase.pc1.kind === 'lan2-first-half');
  const pc2ToPc3 = s.hasPc2 && (!aclCase || aclCase.pc2Allow.includes('icmp'));
  const inLan1: CheckDef = {
    id: 'lan1', label: s.hasPc2 ? 'Inside LAN1: PC1 and PC2 reach each other' : 'Inside LAN1: PC1 reaches R1',
    run(env) {
      if (!s.hasPc2) return works(env, { from: 'PC1', to: T.r1Lan(env), proto: 'icmp' }, REACH_TIP);
      return allOf([
        works(env, { from: 'PC1', to: T.pc2(env), proto: 'icmp' }, 'Check the address and mask of both PCs with ipconfig.'),
        works(env, { from: 'PC2', to: T.pc1(env), proto: 'icmp' }, 'Check the address and mask of both PCs with ipconfig.'),
      ]);
    },
  };
  const inLan2: CheckDef = {
    id: 'lan2', label: 'Inside LAN2: PC3 reaches R2',
    run: (env) => works(env, { from: 'PC3', to: T.r2Lan(env), proto: 'icmp' }, 'Check that PC3 has an address in LAN2 and that the R2 LAN interface is up.'),
  };
  const cross: CheckDef = {
    id: 'cross', label: 'Between LAN1 and LAN2',
    run(env) {
      const parts: Outcome[] = [];
      if (pc1ToPc3) parts.push(works(env, { from: 'PC1', to: T.pc3(env), proto: 'icmp' }, REACH_TIP));
      if (pc2ToPc3) parts.push(works(env, { from: 'PC2', to: T.pc3(env), proto: 'icmp' }, REACH_TIP));
      if (!has(s, 'nat')) parts.push(works(env, { from: 'PC3', to: T.pc1(env), proto: 'icmp' }, REACH_TIP));
      if (parts.length === 0) parts.push(works(env, { from: 'PC1', to: T.r2Wan(env), proto: 'icmp' }, REACH_TIP));
      return allOf(parts);
    },
  };
  const loops: CheckDef = {
    id: 'loopbacks', label: 'Between the loopback interfaces of R1 and R2',
    run(env) {
      if (!env.a.r1Lo0 || !env.a.r2Lo0) return missing('Both Loopback0 interfaces can ping each other.', 'At least one Loopback0 has no address.', REACH_TIP);
      const tip = 'On R1 run ping <R2 loopback> source Loopback0. If it fails, check the default route on both routers with show ip route.';
      return allOf([
        works(env, { from: 'R1', to: T.r2Lo0(env), proto: 'icmp', srcAddr: env.a.r1Lo0?.address }, tip),
        works(env, { from: 'R2', to: T.r1Lo0(env), proto: 'icmp', srcAddr: env.a.r2Lo0?.address }, tip),
      ]);
    },
  };
  const reach: ReqDef = { id: 'reach', title: 'Reachability: inside the LANs, between them, and between the loopbacks', feature: 'routing', points: 2, checks: [inLan1, inLan2, cross, loops] };
  b.requirements = s.r2Default ? [reach, routes] : [routes];
  const script: Action[] = [cfgAction('R1', b.config.R1)];
  if (b.config.R2) script.push(cfgAction('R2', b.config.R2));
  script.push({ kind: 'note', text: 'Check: show ip route on both routers. On R1: ping <R2 Loopback0> source Loopback0.' });
  b.steps = [{
    id: 'routing', title: 'One default route on each router', feature: 'routing', devices: ['R1', 'R2'],
    goal: 'Add one static default route on each router, pointing across the WAN link to the other router. Then test with ping.',
    why: 'The sheet forbids a routing protocol and allows only one extra entry in each routing table. A default route covers everything.',
    hint: 'A default route matches every destination: network 0.0.0.0 with mask 0.0.0.0. It also needs the way out: the WAN interface and the address of the other router.',
    allows: ['routing', 'interface', 'console', 'pc'],
    script,
    done: (env) => reqPasses(env, routes) && loops.run(env).pass && works(env, { from: 'PC1', to: T.r2Wan(env), proto: 'icmp' }, '').pass,
  }];
  return b;
}

// ───────────────────────────── saving ─────────────────────────────
export function savePart(s: Spec): Built {
  const b = emptyBuilt('save');
  const saved = (router: 'R1' | 'R2'): CheckDef => ({
    id: `${router.toLowerCase()}-saved`, label: `${router}: the running configuration is saved`,
    run(env) {
      const expected = `${router} has a startup-config that is the same as its running-config.`;
      const dev = router === 'R1' ? env.r1 : env.r2;
      if (!dev) return missing(expected, `${router} is not on the bench.`, '');
      const tip = `On ${router} type copy running-config startup-config and press Enter at the question.`;
      if (dev.startupConfig === null) return bad(expected, `${router} has no startup-config. After a restart it would be empty again.`, tip);
      if (dev.startupConfig !== renderRunningConfig(env.world, router)) {
        return bad(expected, `${router} was saved earlier, but the configuration changed after that.`, tip);
      }
      return ok(expected, `${router} is saved and up to date.`);
    },
  });
  const req: ReqDef = { id: 'saved', title: 'Both routers keep their configuration after a restart', feature: 'system', points: 1, checks: [saved('R1'), saved('R2')] };
  b.requirements = [req];
  b.steps = [{
    id: 'save', title: 'Save and do a final check', feature: 'system', devices: ['R1', 'R2'],
    goal: 'Save the configuration on both routers. Then test the main tasks one more time.',
    why: 'The running configuration lives in memory only. A power cut or reload would wipe all your work.',
    hint: 'The command copies the running configuration to the startup configuration. It is typed in privileged mode, not in configuration mode.',
    allows: ['system', 'console', 'pc'],
    script: [
      { kind: 'exec', deviceId: 'R1', lines: ['copy running-config startup-config', ''] },
      { kind: 'exec', deviceId: 'R2', lines: ['copy running-config startup-config', ''] },
      {
        kind: 'note',
        text: has(s, 'ipsec') && has(s, 'telnet')
          ? 'Final check: ping between the PCs, Telnet from PC1 to both routers, show ip route, show crypto ipsec sa.'
          : has(s, 'routing') && isTask(s, 'routing')
            ? 'Final check: ping between the PCs and look at show ip route once more.'
            : 'Final check: repeat the tests of this lab once more.',
      },
    ],
    done: (env) => reqPasses(env, req),
  }];
  return b;
}

/** Text of a network for sentences: '192.168.100.0/24'. */
export function netText(s: Spec, which: 'lan1' | 'lan2' | 'wan'): string { return cidr(s.addr[which]); }
export { host };
