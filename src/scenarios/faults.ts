/**
 * Fault catalogue for broken networks: realistic single mistakes on the solved lab, physical ones included.
 * Each fault knows how to plant itself (through CLI lines, cables or PC settings), how it shows up for a user
 * (the help-desk ticket), how to detect that it is still there, and how to fix it. Owned by the scenario agent.
 */
import type { Feature, PcSetup, PortRef, SolutionCable } from '../engine/types.ts';
import { linkInfo } from '../engine/sim/index.ts';
import { aclEvaluate } from '../engine/sim/index.ts';
import type { Env } from './env.ts';
import type { Spec } from './spec.ts';
import { SVC, clockFits, has, host, lastHost, maskOf, model, svcAclLines, wildOf } from './spec.ts';
import { IKE } from './parts/ipsec.ts';
import { QOS } from './parts/qos.ts';
import { VTY_ACL } from './parts/mgmt.ts';
import { pcSetups } from './parts/base.ts';
import { block } from './parts/common.ts';

export type Layer = 'physical' | 'addressing' | 'dhcp' | 'nat' | 'acl' | 'ipsec' | 'qos' | 'mgmt';
export const LAYER_ORDER: Layer[] = ['physical', 'addressing', 'dhcp', 'nat', 'acl', 'ipsec', 'qos', 'mgmt'];

export type CableOp = { remove: PortRef } | { add: SolutionCable };
export interface FaultOps {
  /** Configuration-mode lines per router. */
  configs?: Record<string, string[]>;
  cables?: CableOp[];
  pcs?: Record<string, PcSetup>;
}
export interface Fault {
  id: string;
  layer: Layer;
  /** Topic of the cause. */
  feature: Feature;
  /** Faults in the same slot touch the same setting and are never planted together. */
  slot: string;
  /** The cause, for the solution. */
  title: string;
  /** The symptom, as a user would report it. */
  ticket: string;
  /** Topic the symptom points at (not always the topic of the cause). */
  ticketFeature: Feature;
  break: FaultOps;
  fix: FaultOps;
  /** The fix in words. */
  fixText: string;
  /** Is the planted mistake still in the world? */
  present(env: Env): boolean;
  /** Requirements this fault is aimed at: they must fail while it is present. */
  mustFail: string[];
  /** Requirements that may fail as a side effect. Everything else must still pass. */
  mayFail: string[];
}

const ref = (deviceId: string, port: string): PortRef => ({ deviceId, port });
/** Side effects of a dead tunnel when ICMP is one of the encrypted protocols: every ping across the WAN link is lost. */
const ICMP_WAN = ['reach', 'pat', 'static-nat', 'acl-pc1', 'acl-pc2', 'qos', 'telnet', 'snmp'];

export function faultCatalogue(s: Spec): Fault[] {
  const m = model(s);
  const a = s.addr;
  const p = s.ports;
  const out: Fault[] = [];
  const add = (f: Fault): void => { out.push(f); };
  const r1if = (env: Env, name: string) => env.r1?.config.interfaces[name];
  const r2if = (env: Env, name: string) => env.r2?.config.interfaces[name];
  const cableBad = (env: Env, at: PortRef): boolean => { const l = linkInfo(env.world, at); return l.cabled && !l.usable; };

  // ───────────── physical ─────────────
  add({
    id: 'cable-type-pc3', layer: 'physical', feature: 'cabling', slot: 'cable-pc3',
    title: 'The cable between R2 and PC3 is a straight-through cable. A router and a PC need a crossover cable.',
    ticket: 'PC3 has no network link at all. The port light on R2 towards PC3 stays amber.', ticketFeature: 'cabling',
    break: { cables: [{ remove: ref('PC3', 'Ethernet0') }, { add: { kind: 'straight', a: ref('R2', p.r2Lan), b: ref('PC3', 'Ethernet0') } }] },
    fix: { cables: [{ remove: ref('PC3', 'Ethernet0') }, { add: { kind: 'crossover', a: ref('R2', p.r2Lan), b: ref('PC3', 'Ethernet0') } }] },
    fixText: 'Swap the cable between R2 and PC3 for a crossover cable.',
    present: (env) => cableBad(env, ref('PC3', 'Ethernet0')),
    mustFail: ['cabling'], mayFail: ['dhcp', 'addressing', 'reach', 'pat', 'static-nat', 'acl-pc1', 'acl-pc2', 'snmp', 'ipsec'],
  });
  add({
    id: 'cable-type-r1', layer: 'physical', feature: 'cabling', slot: 'cable-r1',
    title: 'The cable between SW1 and R1 is a crossover cable. A switch and a router need a straight-through cable.',
    ticket: 'PC1 and PC2 still ping each other, but nobody in LAN1 reaches the router R1.', ticketFeature: 'cabling',
    break: { cables: [{ remove: ref('R1', p.r1Lan) }, { add: { kind: 'crossover', a: ref('SW1', p.swR1), b: ref('R1', p.r1Lan) } }] },
    fix: { cables: [{ remove: ref('R1', p.r1Lan) }, { add: { kind: 'straight', a: ref('SW1', p.swR1), b: ref('R1', p.r1Lan) } }] },
    fixText: 'Swap the cable between SW1 and R1 for a straight-through cable.',
    present: (env) => cableBad(env, ref('R1', p.r1Lan)),
    mustFail: ['cabling'], mayFail: ['dhcp', 'addressing', 'reach', 'pat', 'static-nat', 'acl-pc1', 'acl-pc2', 'ipsec', 'qos', 'telnet', 'snmp', 'syslog'],
  });
  const spare = s.wan === 'serial' ? 'GigabitEthernet0/0/1' : 'GigabitEthernet0/0/2';
  add({
    id: 'cable-port-r1', layer: 'physical', feature: 'cabling', slot: 'cable-r1',
    title: `The cable from SW1 is plugged into R1 ${spare}. The LAN address is configured on ${p.r1Lan}.`,
    ticket: `Somebody tidied the cables. Since then PC1 cannot ping its gateway ${m.r1Lan}.`, ticketFeature: 'interface',
    break: { cables: [{ remove: ref('R1', p.r1Lan) }, { add: { kind: 'straight', a: ref('SW1', p.swR1), b: ref('R1', spare) } }] },
    fix: { cables: [{ remove: ref('SW1', p.swR1) }, { add: { kind: 'straight', a: ref('SW1', p.swR1), b: ref('R1', p.r1Lan) } }] },
    fixText: `Move the cable on R1 from ${spare} back to ${p.r1Lan}.`,
    present: (env) => !linkInfo(env.world, ref('R1', p.r1Lan)).cabled,
    mustFail: ['addressing'], mayFail: ['dhcp', 'reach', 'pat', 'static-nat', 'acl-pc1', 'acl-pc2', 'ipsec', 'qos', 'telnet', 'snmp', 'syslog'],
  });
  add({
    id: 'shutdown-r2-lan', layer: 'physical', feature: 'interface', slot: 'r2-lan-state',
    title: `The LAN interface of R2 (${p.r2Lan}) is shut down.`,
    ticket: 'PC3 lost its connection from one moment to the next. Its cable is plugged in.', ticketFeature: 'interface',
    break: { configs: { R2: block(`interface ${p.r2Lan}`, ['shutdown']) } },
    fix: { configs: { R2: block(`interface ${p.r2Lan}`, ['no shutdown']) } },
    fixText: `On R2 enter no shutdown on ${p.r2Lan}.`,
    present: (env) => r2if(env, p.r2Lan)?.shutdown === true,
    mustFail: ['addressing'], mayFail: ['dhcp', 'reach', 'pat', 'static-nat', 'acl-pc1', 'acl-pc2', 'snmp', 'ipsec'],
  });
  add({
    id: 'shutdown-r1-wan', layer: 'physical', feature: 'interface', slot: 'r1-wan-state',
    title: `The WAN interface of R1 (${p.r1Wan}) is shut down.`,
    ticket: 'Nothing crosses the WAN link any more. Each LAN still works on its own.', ticketFeature: 'interface',
    break: { configs: { R1: block(`interface ${p.r1Wan}`, ['shutdown']) } },
    fix: { configs: { R1: block(`interface ${p.r1Wan}`, ['no shutdown']) } },
    fixText: `On R1 enter no shutdown on ${p.r1Wan}.`,
    present: (env) => r1if(env, p.r1Wan)?.shutdown === true,
    mustFail: ['addressing'], mayFail: ['dhcp', 'reach', 'pat', 'static-nat', 'routes', 'acl-pc1', 'acl-pc2', 'ipsec', 'qos', 'telnet', 'snmp', 'syslog'],
  });

  // ───────────── addresses and routes ─────────────
  const wrongMask = a.lan2.len === 24 ? '255.255.255.128' : '255.255.255.0';
  add({
    id: 'mask-r2-lan', layer: 'addressing', feature: 'interface', slot: 'r2-lan-ip',
    title: `The LAN interface of R2 has the mask ${wrongMask}. The plan says /${a.lan2.len} (${maskOf(a.lan2)}).`,
    ticket: 'The routing table of R2 lists LAN2 with a different size than the plan. Traffic still flows.', ticketFeature: 'routing',
    break: { configs: { R2: block(`interface ${p.r2Lan}`, [`ip address ${m.r2Lan} ${wrongMask}`]) } },
    fix: { configs: { R2: block(`interface ${p.r2Lan}`, [`ip address ${m.r2Lan} ${maskOf(a.lan2)}`]) } },
    fixText: `On R2 set ip address ${m.r2Lan} ${maskOf(a.lan2)} on ${p.r2Lan}.`,
    present: (env) => r2if(env, p.r2Lan)?.ip?.mask !== maskOf(a.lan2),
    mustFail: ['addressing'], mayFail: ['dhcp'],
  });
  add({
    id: 'route-r2-missing', layer: 'addressing', feature: 'routing', slot: 'r2-route',
    title: 'R2 has no default route.',
    ticket: `PC3 cannot reach PC1 on its public address, and R2 cannot ping the loopback of R1. R2 still reaches ${m.r1Wan}.`, ticketFeature: 'routing',
    break: { configs: { R2: [`no ip route 0.0.0.0 0.0.0.0 ${p.r2Wan} ${m.r1Wan}`] } },
    fix: { configs: { R2: [`ip route 0.0.0.0 0.0.0.0 ${p.r2Wan} ${m.r1Wan}`] } },
    fixText: `On R2 add ip route 0.0.0.0 0.0.0.0 ${p.r2Wan} ${m.r1Wan}.`,
    present: (env) => (env.r2?.config.staticRoutes.length ?? 0) === 0,
    mustFail: ['routes'], mayFail: ['reach', 'static-nat', 'acl-pc1', 'ipsec', 'telnet', 'snmp', 'syslog'],
  });
  add({
    id: 'route-r1-missing', layer: 'addressing', feature: 'routing', slot: 'r1-route',
    title: 'R1 has no default route.',
    ticket: 'The PCs of LAN1 cannot reach LAN2 or the loopback of R2 any more. They still reach the WAN address of R2. PC3 gets no IP address.', ticketFeature: 'routing',
    break: { configs: { R1: [`no ip route 0.0.0.0 0.0.0.0 ${p.r1Wan} ${m.r2Wan}`] } },
    fix: { configs: { R1: [`ip route 0.0.0.0 0.0.0.0 ${p.r1Wan} ${m.r2Wan}`] } },
    fixText: `On R1 add ip route 0.0.0.0 0.0.0.0 ${p.r1Wan} ${m.r2Wan}.`,
    present: (env) => (env.r1?.config.staticRoutes.length ?? 0) === 0,
    mustFail: ['routes'], mayFail: ['dhcp', 'reach', 'pat', 'static-nat', 'acl-pc1', 'acl-pc2', 'snmp', 'ipsec'],
  });
  const pc1Good = pcSetups(s).PC1;
  add({
    id: 'pc1-gateway', layer: 'addressing', feature: 'pc', slot: 'pc1',
    title: `PC1 has the wrong default gateway (${host(a.lan1, 254)}). It should be ${m.r1Lan}.`,
    ticket: 'PC1 reaches PC2, but nothing outside LAN1. PC2 has no such problem.', ticketFeature: 'pc',
    break: { pcs: { PC1: { ...pc1Good, gateway: host(a.lan1, 254) } } },
    fix: { pcs: { PC1: { ...pc1Good } } },
    fixText: `On PC1 set the default gateway to ${m.r1Lan}.`,
    present: (env) => env.pc('PC1')?.nic.gateway !== m.r1Lan,
    mustFail: ['addressing'], mayFail: ['reach', 'static-nat', 'acl-pc1', 'acl-pc2', 'ipsec', 'qos', 'telnet', 'snmp'],
  });

  // ───────────── DHCP ─────────────
  if (has(s, 'dhcp')) {
    const n = s.dhcp?.excludeFirst ?? 100;
    add({
      id: 'helper-wrong-if', layer: 'dhcp', feature: 'dhcp', slot: 'r2-helper',
      title: `On R2 the helper address sits on the WAN interface (${p.r2Wan}). It must be on the LAN interface, where PC3's request arrives.`,
      ticket: 'PC3 gets no DHCP address. ifconfig en0 shows 169.254.x.x. PC2 is fine.', ticketFeature: 'dhcp',
      break: { configs: { R2: [...block(`interface ${p.r2Lan}`, [`no ip helper-address ${m.r1Wan}`]), ...block(`interface ${p.r2Wan}`, [`ip helper-address ${m.r1Wan}`])] } },
      fix: { configs: { R2: [...block(`interface ${p.r2Wan}`, [`no ip helper-address ${m.r1Wan}`]), ...block(`interface ${p.r2Lan}`, [`ip helper-address ${m.r1Wan}`])] } },
      fixText: `On R2 remove ip helper-address from ${p.r2Wan} and enter ip helper-address ${m.r1Wan} on ${p.r2Lan}.`,
      present: (env) => !(r2if(env, p.r2Lan)?.helperAddresses ?? []).includes(m.r1Wan),
      mustFail: ['dhcp'], mayFail: ['reach', 'pat', 'static-nat', 'acl-pc1', 'acl-pc2', 'snmp', 'ipsec'],
    });
    const few = Math.min(10, Math.max(1, n - 1));
    add({
      id: 'dhcp-exclusion', layer: 'dhcp', feature: 'dhcp', slot: 'r1-exclusion',
      title: `R1 excludes only ${host(a.lan1, 1)} to ${host(a.lan1, few)} from DHCP. The first ${n} addresses must stay free.`,
      ticket: `A new laptop in LAN1 got the address ${host(a.lan1, few + 1)}. The plan says the first ${n} addresses of LAN1 are never handed out.`, ticketFeature: 'dhcp',
      break: { configs: { R1: [`no ip dhcp excluded-address ${host(a.lan1, 1)} ${host(a.lan1, n)}`, `ip dhcp excluded-address ${host(a.lan1, 1)} ${host(a.lan1, few)}`] } },
      fix: { configs: { R1: [`no ip dhcp excluded-address ${host(a.lan1, 1)} ${host(a.lan1, few)}`, `ip dhcp excluded-address ${host(a.lan1, 1)} ${host(a.lan1, n)}`] } },
      fixText: `On R1 replace the exclusion by ip dhcp excluded-address ${host(a.lan1, 1)} ${host(a.lan1, n)}. Then renew the lease on PC2.`,
      present: (env) => !(env.r1?.config.dhcp.excluded ?? []).some((e) => e.low === host(a.lan1, 1) && e.high === host(a.lan1, n)),
      mustFail: ['dhcp'], mayFail: ['acl-pc2'],
    });
    add({
      id: 'dhcp-gateway', layer: 'dhcp', feature: 'dhcp', slot: 'r1-pool-lan2',
      title: `The DHCP pool for LAN2 hands out the default gateway ${lastHost(a.lan2)}. The gateway of LAN2 is ${m.r2Lan}.`,
      ticket: 'PC3 gets an address, but it cannot leave LAN2. ipconfig getoption en0 router on PC3 shows a default gateway that nobody owns.', ticketFeature: 'dhcp',
      break: { configs: { R1: block('ip dhcp pool LAN2', [`default-router ${lastHost(a.lan2)}`]) } },
      fix: { configs: { R1: block('ip dhcp pool LAN2', [`default-router ${m.r2Lan}`]) } },
      fixText: `On R1, in ip dhcp pool LAN2, enter default-router ${m.r2Lan}. Then renew the lease on PC3.`,
      present: (env) => env.r1?.config.dhcp.pools.find((x) => x.name === 'LAN2')?.defaultRouters[0] !== m.r2Lan,
      mustFail: ['dhcp'], mayFail: ['reach', 'pat', 'static-nat', 'acl-pc1', 'acl-pc2', 'snmp', 'ipsec'],
    });
  }

  // ───────────── NAT ─────────────
  if (has(s, 'nat') && s.nat?.mode === 'case' && a.r1Lo100) {
    const rolesOk = (env: Env): boolean => r1if(env, p.r1Lan)?.natRole === 'inside' && r1if(env, p.r1Wan)?.natRole === 'outside';
    add({
      id: 'nat-swapped', layer: 'nat', feature: 'nat', slot: 'nat-roles',
      title: 'On R1, ip nat inside and ip nat outside are swapped: the LAN interface is outside, the WAN interface is inside.',
      ticket: 'R2 sees the private addresses of LAN1. PC1 cannot be reached from outside on its public address.', ticketFeature: 'nat',
      break: { configs: { R1: [...block(`interface ${p.r1Lan}`, ['no ip nat inside', 'ip nat outside']), ...block(`interface ${p.r1Wan}`, ['no ip nat outside', 'ip nat inside'])] } },
      fix: { configs: { R1: [...block(`interface ${p.r1Lan}`, ['no ip nat outside', 'ip nat inside']), ...block(`interface ${p.r1Wan}`, ['no ip nat inside', 'ip nat outside'])] } },
      fixText: `On R1 make ${p.r1Lan} ip nat inside and ${p.r1Wan} ip nat outside.`,
      present: (env) => !rolesOk(env),
      mustFail: ['pat', 'static-nat'], mayFail: ['telnet', 'snmp', 'syslog'],
    });
    add({
      id: 'nat-inside-missing', layer: 'nat', feature: 'nat', slot: 'nat-roles',
      title: 'On R1, the LAN interface has no ip nat inside.',
      ticket: 'show ip nat translations on R1 stays empty. R2 sees the private addresses of LAN1.', ticketFeature: 'nat',
      break: { configs: { R1: block(`interface ${p.r1Lan}`, ['no ip nat inside']) } },
      fix: { configs: { R1: block(`interface ${p.r1Lan}`, ['ip nat inside']) } },
      fixText: `On R1 enter ip nat inside on ${p.r1Lan}.`,
      present: (env) => !rolesOk(env),
      mustFail: ['pat', 'static-nat'], mayFail: ['telnet', 'snmp'],
    });
    add({
      id: 'nat-acl-wildcard', layer: 'nat', feature: 'nat', slot: 'nat-acl',
      title: `Access list 1 on R1 has the wildcard 0.0.0.3. It only covers the first four addresses of LAN1, so PC2 is not translated.`,
      ticket: 'PC2 appears on R2 with its private address. PC1 is translated correctly.', ticketFeature: 'nat',
      break: { configs: { R1: ['no access-list 1', `access-list 1 permit ${a.lan1.net} 0.0.0.3`] } },
      fix: { configs: { R1: ['no access-list 1', `access-list 1 permit ${a.lan1.net} ${wildOf(a.lan1)}`] } },
      fixText: `On R1 rebuild the list: access-list 1 permit ${a.lan1.net} ${wildOf(a.lan1)}.`,
      present: (env) => !aclEvaluate(env.r1?.config.acls['1'], { src: m.pc2, dst: m.r2Wan, proto: 'icmp', ttl: 64, bytes: 60 }).permit || !env.r1?.config.acls['1'],
      mustFail: ['pat'], mayFail: [],
    });
    const wrongLocal = host(a.lan1, a.pc1Host + 1);
    add({
      id: 'static-nat-wrong', layer: 'nat', feature: 'nat', slot: 'nat-static',
      title: `The static NAT rule on R1 translates ${wrongLocal}. PC1 has ${m.pc1}.`,
      ticket: 'PC1 cannot be reached from outside on its public address. PC1 itself leaves with the WAN address of R1.', ticketFeature: 'nat',
      break: { configs: { R1: [`no ip nat inside source static ${m.pc1} ${a.r1Lo100}`, `ip nat inside source static ${wrongLocal} ${a.r1Lo100}`] } },
      fix: { configs: { R1: [`no ip nat inside source static ${wrongLocal} ${a.r1Lo100}`, `ip nat inside source static ${m.pc1} ${a.r1Lo100}`] } },
      fixText: `On R1 replace the rule by ip nat inside source static ${m.pc1} ${a.r1Lo100}.`,
      present: (env) => !(env.r1?.config.nat.staticRules ?? []).some((r) => r.local === m.pc1 && r.global === a.r1Lo100),
      mustFail: ['static-nat'], mayFail: ['telnet', 'snmp', 'syslog'],
    });
  }

  // ───────────── access lists ─────────────
  if (has(s, 'acl') && s.acl?.mode === 'case') {
    const acl = s.acl;
    const lan2 = `${a.lan2.net} ${wildOf(a.lan2)}`;
    const lines: string[] = [];
    if (acl.pc1.kind === 'r2-lo0') lines.push(`access-list 110 deny ip host ${m.pc1} host ${a.r2Lo0}`);
    else lines.push(`access-list 110 deny ip host ${m.pc1} ${a.lan2.net} ${wildOf({ net: a.lan2.net, len: a.lan2.len + 1 })}`);
    for (const svc of acl.pc2Allow) {
      const info = SVC[svc];
      if (info.proto === 'icmp') lines.push(`access-list 110 permit icmp host ${m.pc2} ${lan2}`);
      else for (const w of info.words) lines.push(`access-list 110 permit ${info.proto} host ${m.pc2} ${lan2} eq ${w}`);
    }
    const denyIdx = lines.length;
    lines.push(`access-list 110 deny ip host ${m.pc2} ${lan2}`);
    lines.push('access-list 110 permit ip any any');
    const both = ['acl-pc1', 'acl-pc2'];
    add({
      id: 'acl-direction', layer: 'acl', feature: 'acl', slot: 'acl-apply',
      title: `Access list 110 is applied outbound on ${p.r1Lan} of R1. It must be inbound.`,
      ticket: 'The rules for PC1 and PC2 have no effect. PC1 reaches what it should not, and PC2 can use every protocol towards LAN2.', ticketFeature: 'acl',
      break: { configs: { R1: block(`interface ${p.r1Lan}`, ['no ip access-group 110 in', 'ip access-group 110 out']) } },
      fix: { configs: { R1: block(`interface ${p.r1Lan}`, ['no ip access-group 110 out', 'ip access-group 110 in']) } },
      fixText: `On R1, on ${p.r1Lan}: no ip access-group 110 out, then ip access-group 110 in.`,
      present: (env) => r1if(env, p.r1Lan)?.aclIn !== '110',
      mustFail: both, mayFail: [],
    });
    add({
      id: 'acl-wrong-interface', layer: 'acl', feature: 'acl', slot: 'acl-apply',
      title: `Access list 110 is applied inbound on the WAN interface of R1 (${p.r1Wan}). It belongs inbound on the LAN interface (${p.r1Lan}).`,
      ticket: 'The rules for PC1 and PC2 have no effect. show access-lists on R1 counts matches only on the last line.', ticketFeature: 'acl',
      break: { configs: { R1: [...block(`interface ${p.r1Lan}`, ['no ip access-group 110 in']), ...block(`interface ${p.r1Wan}`, ['ip access-group 110 in'])] } },
      fix: { configs: { R1: [...block(`interface ${p.r1Wan}`, ['no ip access-group 110 in']), ...block(`interface ${p.r1Lan}`, ['ip access-group 110 in'])] } },
      fixText: `On R1 remove ip access-group 110 in from ${p.r1Wan} and enter it on ${p.r1Lan}.`,
      present: (env) => r1if(env, p.r1Lan)?.aclIn !== '110' || r1if(env, p.r1Wan)?.aclIn === '110',
      mustFail: both, mayFail: [],
    });
    add({
      id: 'acl-no-final-permit', layer: 'acl', feature: 'acl', slot: 'acl-110',
      title: 'Access list 110 on R1 has no final permit ip any any. The hidden deny at the end drops everything else.',
      ticket: 'Since the access list on R1 was edited, PC1 and PC2 reach nothing outside LAN1. PC2 also gets no DHCP address any more.', ticketFeature: 'acl',
      break: { configs: { R1: block('ip access-list extended 110', [`no ${lines.length * 10}`]) } },
      fix: { configs: { R1: ['access-list 110 permit ip any any'] } },
      fixText: 'On R1 add the last line again: access-list 110 permit ip any any.',
      present: (env) => !(env.r1?.config.acls['110']?.entries ?? []).some((e) => e.action === 'permit' && e.protocol === 'ip' && e.src.kind === 'any' && e.dst.kind === 'any'),
      mustFail: both, mayFail: ['dhcp', 'reach', 'pat', 'static-nat', 'ipsec', 'qos', 'telnet', 'snmp'],
    });
    const badLines = lines.map((l, i) => (i === denyIdx ? `access-list 110 deny ip host ${m.pc2} ${a.lan2.net} ${maskOf(a.lan2)}` : l));
    add({
      id: 'acl-mask-not-wildcard', layer: 'acl', feature: 'acl', slot: 'acl-110',
      title: `In access list 110 the deny line for PC2 uses the subnet mask ${maskOf(a.lan2)} where a wildcard mask (${wildOf(a.lan2)}) belongs.`,
      ticket: 'PC2 can open every kind of connection to PC3. The plan allows only a few protocols.', ticketFeature: 'acl',
      break: { configs: { R1: ['no access-list 110', ...badLines] } },
      fix: { configs: { R1: ['no access-list 110', ...lines] } },
      fixText: `On R1 rebuild access list 110. The deny line for PC2 must end with ${a.lan2.net} ${wildOf(a.lan2)}.`,
      present: (env) => !(env.r1?.config.acls['110']?.entries ?? []).some((e) => e.action === 'deny' && e.src.kind === 'host' && e.src.address === m.pc2 && e.dst.kind === 'net' && e.dst.wildcard === wildOf(a.lan2)),
      mustFail: ['acl-pc2'], mayFail: [],
    });
  }

  // ───────────── IPsec ─────────────
  if (has(s, 'ipsec') && s.ipsec?.mode === 'services') {
    const services = s.ipsec.services;
    const icmpIn = services.includes('icmp');
    const side = icmpIn ? ICMP_WAN : ['qos', 'telnet', 'snmp', 'acl-pc2', 'syslog'];
    const keyOf = (env: Env, r: 'R1' | 'R2', peer: string): string | undefined => (r === 'R1' ? env.r1 : env.r2)?.config.crypto.isakmpKeys.find((k) => k.address === peer)?.key;
    add({
      id: 'isakmp-key', layer: 'ipsec', feature: 'ipsec', slot: 'ike',
      title: 'The pre-shared ISAKMP keys differ: R2 has another key for R1 than R1 has for R2.',
      ticket: 'Traffic that should be encrypted times out across the WAN link. Other traffic passes. show crypto isakmp sa shows no working SA.', ticketFeature: 'ipsec',
      break: { configs: { R2: [`no crypto isakmp key ${IKE.key} address ${m.r1Wan}`, `crypto isakmp key KSS132 address ${m.r1Wan}`] } },
      fix: { configs: { R2: [`no crypto isakmp key KSS132 address ${m.r1Wan}`, `crypto isakmp key ${IKE.key} address ${m.r1Wan}`] } },
      fixText: `On R2 set the same key as on R1: crypto isakmp key ${IKE.key} address ${m.r1Wan}.`,
      present: (env) => keyOf(env, 'R1', m.r2Wan) === undefined || keyOf(env, 'R1', m.r2Wan) !== keyOf(env, 'R2', m.r1Wan),
      mustFail: ['ipsec'], mayFail: side,
    });
    add({
      id: 'isakmp-policy', layer: 'ipsec', feature: 'ipsec', slot: 'ike',
      title: 'The ISAKMP policies do not match: R2 uses Diffie-Hellman group 5, R1 uses group 14.',
      ticket: 'The tunnel between R1 and R2 never comes up. Traffic that should be encrypted is lost. Other traffic passes.', ticketFeature: 'ipsec',
      break: { configs: { R2: block('crypto isakmp policy 10', ['group 5']) } },
      fix: { configs: { R2: block('crypto isakmp policy 10', ['group 14']) } },
      fixText: 'On R2, in crypto isakmp policy 10, enter group 14.',
      present: (env) => {
        const sig = (r: typeof env.r1): string[] => (r?.config.crypto.isakmpPolicies ?? []).map((x) => `${x.encryption}/${x.hash}/${x.authentication}/${x.group}`);
        const other = sig(env.r2);
        return !sig(env.r1).some((x) => other.includes(x));
      },
      mustFail: ['ipsec'], mayFail: side,
    });
    const tcpSvc = services.find((x) => SVC[x].proto === 'tcp');
    if (tcpSvc) {
      const full = svcAclLines(services).map((l) => `access-list ${IKE.acl} ${l}`);
      const w = SVC[tcpSvc].words[0];
      const broken = full.filter((l) => l !== `access-list ${IKE.acl} permit tcp any eq ${w} any`);
      add({
        id: 'crypto-acl-mirror', layer: 'ipsec', feature: 'ipsec', slot: 'crypto-acl',
        title: `The crypto access list on R2 lacks the line permit tcp any eq ${w} any. It no longer mirrors the list on R1.`,
        ticket: `${SVC[tcpSvc].name} from LAN1 to R2 times out. Ping to R2 works.`, ticketFeature: tcpSvc === 'telnet' ? 'vty' : 'ipsec',
        break: { configs: { R2: [`no access-list ${IKE.acl}`, ...broken] } },
        fix: { configs: { R2: [`no access-list ${IKE.acl}`, ...full] } },
        fixText: `On R2 rebuild access list ${IKE.acl} so that it has the same lines as on R1, including permit tcp any eq ${w} any.`,
        present: (env) => (env.r2?.config.acls[IKE.acl]?.entries.length ?? 0) < full.length,
        mustFail: ['ipsec'], mayFail: ['qos', 'telnet'],
      });
    }
    add({
      id: 'crypto-map-missing', layer: 'ipsec', feature: 'ipsec', slot: 'crypto-apply',
      title: `The crypto map is not applied to the WAN interface of R2 (${p.r2Wan}).`,
      ticket: 'R1 cannot set up the tunnel. Traffic that should be encrypted is lost in both directions. Other traffic passes.', ticketFeature: 'ipsec',
      break: { configs: { R2: block(`interface ${p.r2Wan}`, ['no crypto map']) } },
      fix: { configs: { R2: block(`interface ${p.r2Wan}`, [`crypto map ${IKE.map}`]) } },
      fixText: `On R2 enter crypto map ${IKE.map} on ${p.r2Wan}.`,
      present: (env) => !r2if(env, p.r2Wan)?.cryptoMap,
      mustFail: ['ipsec'], mayFail: side,
    });
  }

  // ───────────── QoS ─────────────
  if (has(s, 'qos') && s.qos) {
    const q = s.qos;
    if (s.wan === 'serial') {
      const rate = q.linkKbps * 1000;
      const other = q.linkKbps === 64 ? 128000 : 64000;
      add({
        id: 'clock-missing', layer: 'qos', feature: 'interface', slot: 'clock',
        title: `The DCE end of the serial link (R1 ${p.r1Wan}) has no clock rate. The link is not limited to ${q.linkKbps} kbit/s.`,
        ticket: `A speed test shows that the serial link runs much faster than the agreed ${q.linkKbps} kbit/s.`, ticketFeature: 'qos',
        break: { configs: { R1: block(`interface ${p.r1Wan}`, ['no clock rate']) } },
        fix: { configs: { R1: block(`interface ${p.r1Wan}`, [`clock rate ${rate}`]) } },
        fixText: `On R1 enter clock rate ${rate} on ${p.r1Wan}.`,
        present: (env) => !clockFits(r1if(env, p.r1Wan)?.clockRate, rate),
        mustFail: ['qos'], mayFail: [],
      });
      add({
        id: 'clock-wrong', layer: 'qos', feature: 'interface', slot: 'clock',
        title: `The clock rate on R1 ${p.r1Wan} is ${other}. The task asks for ${rate}.`,
        ticket: `A speed test shows about ${other / 1000} kbit/s on the serial link. The plan says ${q.linkKbps} kbit/s.`, ticketFeature: 'qos',
        break: { configs: { R1: block(`interface ${p.r1Wan}`, [`clock rate ${other}`]) } },
        fix: { configs: { R1: block(`interface ${p.r1Wan}`, [`clock rate ${rate}`]) } },
        fixText: `On R1 enter clock rate ${rate} on ${p.r1Wan}.`,
        present: (env) => !clockFits(r1if(env, p.r1Wan)?.clockRate, rate),
        mustFail: ['qos'], mayFail: [],
      });
    }
    add({
      id: 'qos-policy-missing', layer: 'qos', feature: 'qos', slot: 'qos-r2-apply',
      title: `No service-policy is attached to the WAN interface of R2 (${p.r2Wan}).`,
      ticket: 'From LAN2, pings to the other side get very slow whenever a big file is sent. On R2, show policy-map interface shows nothing.', ticketFeature: 'qos',
      break: { configs: { R2: block(`interface ${p.r2Wan}`, [`no service-policy output ${QOS.parent}`]) } },
      fix: { configs: { R2: block(`interface ${p.r2Wan}`, [`service-policy output ${QOS.parent}`]) } },
      fixText: `On R2 enter service-policy output ${QOS.parent} on ${p.r2Wan}.`,
      present: (env) => !r2if(env, p.r2Wan)?.servicePolicyOut,
      mustFail: ['qos'], mayFail: [],
    });
    add({
      id: 'qos-wrong-interface', layer: 'qos', feature: 'qos', slot: 'qos-r1-apply',
      title: `On R1 the policy is attached to the LAN interface (${p.r1Lan}). There it handles packets that leave towards LAN1, not packets that leave over the WAN link.`,
      ticket: 'From LAN1, pings to the other side get very slow whenever a big file is sent. On R1, show policy-map interface shows nothing for the WAN interface.', ticketFeature: 'qos',
      break: { configs: { R1: [...block(`interface ${p.r1Wan}`, [`no service-policy output ${QOS.parent}`]), ...block(`interface ${p.r1Lan}`, [`service-policy output ${QOS.parent}`])] } },
      fix: { configs: { R1: [...block(`interface ${p.r1Lan}`, [`no service-policy output ${QOS.parent}`]), ...block(`interface ${p.r1Wan}`, [`service-policy output ${QOS.parent}`])] } },
      fixText: `On R1 remove the service-policy from ${p.r1Lan} and enter service-policy output ${QOS.parent} on ${p.r1Wan}.`,
      present: (env) => r1if(env, p.r1Wan)?.servicePolicyOut !== QOS.parent,
      mustFail: ['qos'], mayFail: [],
    });
    add({
      id: 'qos-child-attached', layer: 'qos', feature: 'qos', slot: 'qos-r1-apply',
      title: `On R1 the child policy ${QOS.child} is attached to the WAN interface. The shaper lives in the parent policy ${QOS.parent}, so nothing is shaped.`,
      ticket: 'On R1 the classes count packets, but show policy-map interface shows no shaping rate at all.', ticketFeature: 'qos',
      break: { configs: { R1: block(`interface ${p.r1Wan}`, [`no service-policy output ${QOS.parent}`, `service-policy output ${QOS.child}`]) } },
      fix: { configs: { R1: block(`interface ${p.r1Wan}`, [`no service-policy output ${QOS.child}`, `service-policy output ${QOS.parent}`]) } },
      fixText: `On R1, on ${p.r1Wan}: no service-policy output ${QOS.child}, then service-policy output ${QOS.parent}.`,
      present: (env) => r1if(env, p.r1Wan)?.servicePolicyOut !== QOS.parent,
      mustFail: ['qos'], mayFail: [],
    });
    add({
      id: 'qos-priority-number', layer: 'qos', feature: 'qos', slot: 'qos-r1-numbers',
      title: `On R1 the numbers of the two classes are swapped: priority ${q.guaranteed.kbps} and bandwidth ${q.priority.kbps}.`,
      ticket: 'On R1, show policy-map shows other rates than the plan: the priority class has too much, the guaranteed class too little.', ticketFeature: 'qos',
      break: { configs: { R1: [`policy-map ${QOS.child}`, ` class ${QOS.cPrio}`, `  priority ${q.guaranteed.kbps}`, ` class ${QOS.cGuar}`, `  bandwidth ${q.priority.kbps}`] } },
      fix: { configs: { R1: [`policy-map ${QOS.child}`, ` class ${QOS.cPrio}`, `  priority ${q.priority.kbps}`, ` class ${QOS.cGuar}`, `  bandwidth ${q.guaranteed.kbps}`] } },
      fixText: `On R1, in policy-map ${QOS.child}: class ${QOS.cPrio} gets priority ${q.priority.kbps}, class ${QOS.cGuar} gets bandwidth ${q.guaranteed.kbps}.`,
      present: (env) => {
        const pm = env.r1?.config.qos.policyMaps.find((x) => x.name === QOS.child);
        return pm?.classes.find((c) => c.className === QOS.cPrio)?.priority?.kbps !== q.priority.kbps
          || pm?.classes.find((c) => c.className === QOS.cGuar)?.bandwidth?.kbps !== q.guaranteed.kbps;
      },
      mustFail: ['qos'], mayFail: [],
    });
    add({
      id: 'qos-bandwidth-missing', layer: 'qos', feature: 'interface', slot: 'qos-r2-bw',
      title: `The WAN interface of R2 has no bandwidth ${q.linkKbps}. The shaper percentage is calculated from the default bandwidth instead.`,
      ticket: `On R2 the shaper allows far more than ${q.shapePercent} % of ${q.linkKbps} kbit/s. show policy-map interface shows a much higher target rate.`, ticketFeature: 'qos',
      break: { configs: { R2: block(`interface ${p.r2Wan}`, ['no bandwidth']) } },
      fix: { configs: { R2: block(`interface ${p.r2Wan}`, [`bandwidth ${q.linkKbps}`]) } },
      fixText: `On R2 enter bandwidth ${q.linkKbps} on ${p.r2Wan}.`,
      present: (env) => r2if(env, p.r2Wan)?.bandwidthKbps !== q.linkKbps,
      mustFail: ['qos'], mayFail: [],
    });
  }

  // ───────────── management ─────────────
  if (has(s, 'telnet')) {
    const pw = s.telnet?.password ?? 'cisco';
    add({
      id: 'vty-password-missing', layer: 'mgmt', feature: 'vty', slot: 'vty-r2',
      title: 'The vty lines of R2 have login but no password.',
      ticket: 'Telnet from PC1 to R2 answers "Password required, but none set" and closes. R1 is fine.', ticketFeature: 'vty',
      break: { configs: { R2: [...block('line vty 0 4', ['no password']), ...block('line vty 5 14', ['no password'])] } },
      fix: { configs: { R2: [...block('line vty 0 4', [`password ${pw}`]), ...block('line vty 5 14', [`password ${pw}`])] } },
      fixText: `On R2 enter password ${pw} on line vty 0 4 and line vty 5 14.`,
      present: (env) => (env.r2?.config.lines.vty ?? []).some((l) => l.login === true && l.password === undefined),
      mustFail: ['telnet'], mayFail: [],
    });
    if (m.pc1Outside !== m.pc1) {
      add({
        id: 'vty-acl-untranslated', layer: 'mgmt', feature: 'vty', slot: 'vty-r2',
        title: `The access-class list on R2 permits ${m.pc1}, the private address of PC1. R2 sees PC1 as ${m.pc1Outside}.`,
        ticket: 'Telnet from PC1 to R2 is refused at once. Telnet from PC1 to R1 works.', ticketFeature: 'vty',
        break: { configs: { R2: block(`ip access-list standard ${VTY_ACL}`, [`no permit ${m.pc1Outside}`, `permit ${m.pc1}`]) } },
        fix: { configs: { R2: block(`ip access-list standard ${VTY_ACL}`, [`no permit ${m.pc1}`, `permit ${m.pc1Outside}`]) } },
        fixText: `On R2, in ip access-list standard ${VTY_ACL}: remove ${m.pc1} and permit ${m.pc1Outside}.`,
        present: (env) => !aclEvaluate(env.r2?.config.acls[VTY_ACL], { src: m.pc1Outside, dst: '0.0.0.0', proto: 'tcp', ttl: 64, bytes: 0 }).permit || !env.r2?.config.acls[VTY_ACL],
        mustFail: ['telnet'], mayFail: [],
      });
    }
  }
  if (has(s, 'snmp') && s.snmp) {
    const o = s.snmp;
    add({
      id: 'snmp-acl-swapped', layer: 'mgmt', feature: 'snmp', slot: 'snmp-r1',
      title: `On R1 the access lists of the two SNMP communities are swapped: ${o.ro} uses list 11, ${o.rw} uses list 10.`,
      ticket: 'PC3 is able to change the SNMP contact on R1. Its read requests to R1 time out.', ticketFeature: 'snmp',
      break: { configs: { R1: [`no snmp-server community ${o.ro}`, `no snmp-server community ${o.rw}`, `snmp-server community ${o.ro} RO 11`, `snmp-server community ${o.rw} RW 10`] } },
      fix: { configs: { R1: [`no snmp-server community ${o.ro}`, `no snmp-server community ${o.rw}`, `snmp-server community ${o.ro} RO 10`, `snmp-server community ${o.rw} RW 11`] } },
      fixText: `On R1: snmp-server community ${o.ro} RO 10 and snmp-server community ${o.rw} RW 11.`,
      present: (env) => env.r1?.config.snmp.communities.find((c) => c.name === o.rw)?.acl !== '11' || env.r1?.config.snmp.communities.find((c) => c.name === o.ro)?.acl !== '10',
      mustFail: ['snmp'], mayFail: [],
    });
    if (m.pc1Outside !== m.pc1 && o.readers === 'pc1-pc3') {
      add({
        id: 'snmp-acl-untranslated', layer: 'mgmt', feature: 'snmp', slot: 'snmp-r2',
        title: `The SNMP access lists 10 and 11 on R2 permit ${m.pc1}, the private address of PC1. R2 sees PC1 as ${m.pc1Outside}.`,
        ticket: 'The SNMP tool on PC1 gets a timeout from R2. R1 answers. PC3 can still read from R2.', ticketFeature: 'snmp',
        break: { configs: { R2: ['no access-list 10', `access-list 10 permit host ${m.pc1}`, `access-list 10 permit host ${m.pc3}`, 'no access-list 11', `access-list 11 permit host ${m.pc1}`] } },
        fix: { configs: { R2: ['no access-list 10', `access-list 10 permit host ${m.pc1Outside}`, `access-list 10 permit host ${m.pc3}`, 'no access-list 11', `access-list 11 permit host ${m.pc1Outside}`] } },
        fixText: `On R2 rebuild access lists 10 and 11 with ${m.pc1Outside} for PC1.`,
        present: (env) => !aclEvaluate(env.r2?.config.acls['11'], { src: m.pc1Outside, dst: '0.0.0.0', proto: 'udp', ttl: 64, bytes: 0 }).permit || !env.r2?.config.acls['11'],
        mustFail: ['snmp'], mayFail: [],
      });
    }
  }
  if (has(s, 'syslog') && s.syslog) {
    const wrongHost = m.pc1Outside === m.pc1 ? host(a.lan1, 250) : host({ net: m.pc1Outside, len: 32 }, 1);
    add({
      id: 'syslog-host-wrong', layer: 'mgmt', feature: 'syslog', slot: 'syslog-r2-host',
      title: `R2 sends its messages to ${wrongHost}. Nobody has that address. PC1 is ${m.pc1Outside} for R2.`,
      ticket: 'The syslog window on PC1 shows messages from R1 only. Nothing arrives from R2.', ticketFeature: 'syslog',
      break: { configs: { R2: [`no logging ${m.pc1Outside}`, `logging ${wrongHost}`] } },
      fix: { configs: { R2: [`no logging ${wrongHost}`, `logging ${m.pc1Outside}`] } },
      fixText: `On R2: no logging ${wrongHost}, then logging ${m.pc1Outside}.`,
      present: (env) => !(env.r2?.config.logging.hosts ?? []).includes(m.pc1Outside),
      mustFail: ['syslog'], mayFail: [],
    });
    const goodSrc = s.syslog.source === 'Loopback0' ? 'Loopback0' : p.r1Lan;
    add({
      id: 'syslog-source-wrong', layer: 'mgmt', feature: 'syslog', slot: 'syslog-r1-source',
      title: `R1 sends its messages from ${p.r1Wan}, not from ${goodSrc}.`,
      ticket: 'The messages of R1 arrive on PC1, but with the wrong source address. The log filter for R1 shows nothing.', ticketFeature: 'syslog',
      break: { configs: { R1: [`logging source-interface ${p.r1Wan}`] } },
      fix: { configs: { R1: [`logging source-interface ${goodSrc}`] } },
      fixText: `On R1 enter logging source-interface ${goodSrc}.`,
      present: (env) => env.r1?.config.logging.sourceInterface !== goodSrc,
      mustFail: ['syslog'], mayFail: [],
    });
    add({
      id: 'syslog-server-off', layer: 'mgmt', feature: 'pc', slot: 'pc1',
      title: 'The syslog server on PC1 is switched off.',
      ticket: 'No syslog message arrives on PC1, from neither router. Both routers say they are logging to it.', ticketFeature: 'syslog',
      break: { pcs: { PC1: { ...pc1Good, services: { syslog: false } } } },
      fix: { pcs: { PC1: { ...pc1Good, services: { syslog: true } } } },
      fixText: 'Open PC1 and start its syslog server.',
      present: (env) => env.pc('PC1')?.services.syslog !== true,
      mustFail: ['syslog'], mayFail: [],
    });
  }
  return out;
}

/** Ids of every fault that exists for the reference plan (for reports and tests). */
export function faultIds(s: Spec): string[] { return faultCatalogue(s).map((f) => f.id); }
