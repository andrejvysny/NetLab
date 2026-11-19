/**
 * Catalyst basics (switches only unless noted): vlan <id|list> + name, no vlan, switchport mode/access vlan,
 * [no] switchport, switchport trunk/port-security/… (accepted), ip default-gateway (also accepted on routers, as IOS does),
 * spanning-tree … and vtp … (accepted, not simulated).
 * `interface vlan <id>` is handled by interface.ts (`interface <if>` creates Vlan<n> on switches).
 *
 * session.ctx in config-vlan: { vlanIds: number[] }
 */
import type { CmdEnv, CommandDef } from '../framework.ts';
import { currentInterfaces, registerCommands } from '../framework.ts';
import type { InterfaceConfig } from '../../types.ts';
import { invalidToken, setExtra, NOT_SIMULATED } from './system.ts';
import { isPhysical } from './interface.ts';

const SW: ('router' | 'switch')[] = ['switch'];
export function defaultVlanName(id: number): string { return 'VLAN' + String(id).padStart(4, '0'); }
const RESERVED = [1, 1002, 1003, 1004, 1005];

/** '10' | '10,20' | '10-20' | '10,20-25' → ids, or null when malformed / out of range. */
export function parseVlanList(text: string): number[] | null {
  const out: number[] = [];
  for (const part of text.split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!m) return null;
    const lo = Number(m[1]), hi = m[2] === undefined ? lo : Number(m[2]);
    if (lo < 1 || hi > 4094 || hi < lo) return null;
    for (let v = lo; v <= hi; v++) if (!out.includes(v)) out.push(v);
  }
  return out;
}
function vlanIds(env: CmdEnv): number[] { return ((env.session.ctx as { vlanIds?: number[] }).vlanIds) ?? []; }
function ports(env: CmdEnv, tokIdx = 0): InterfaceConfig[] {
  const ifs = currentInterfaces(env);
  // switchport commands exist only on physical switch ports
  if (ifs.some((i) => !isPhysical(env.device, i.name))) invalidToken(env, tokIdx);
  return ifs;
}
function l2(env: CmdEnv, ifc: InterfaceConfig): NonNullable<InterfaceConfig['switchport']> {
  if (!ifc.switchport) {
    env.note('This port is a routed port (no switchport). Type switchport first to make it a switch port again.');
    invalidToken(env, 0);
  }
  return ifc.switchport;
}
function ifExtra(ifc: InterfaceConfig, line: string, key: number, mode: 'set' | 'remove'): void {
  if (!ifc.extraLines) ifc.extraLines = [];
  setExtra(ifc.extraLines, line, key, mode);
  if (!ifc.extraLines.length) delete ifc.extraLines;
}

const HV: Record<string, string> = {
  vlan: 'Vlan commands',
  name: 'Ascii name of the VLAN',
  switchport: 'Set switching mode characteristics',
  mode: 'Set trunking mode of the interface',
  access: 'Set trunking mode to ACCESS unconditionally',
  trunk: 'Set trunking mode to TRUNK unconditionally',
  dynamic: 'Set trunking mode to dynamically negotiate access or trunk mode',
  auto: 'Set trunking mode dynamic negotiation parameter to AUTO',
  desirable: 'Set trunking mode dynamic negotiation parameter to DESIRABLE',
  ip: 'Global IP configuration subcommands',
  'default-gateway': 'Specify default gateway (if not routing IP)',
  'spanning-tree': 'Spanning Tree Subsystem',
  vtp: 'Configure global VTP state',
  nonegotiate: 'Device will not engage in negotiation protocol on this interface',
  'port-security': 'Security related command',
  voice: 'Voice appliance attributes',
  no: 'Negate a command or set its defaults',
  '<id>': 'ISL VLAN IDs 1-1005',
  '<list>': 'VLAN IDs of the allowed VLANs when this port is in trunking mode',
  '<vname>': 'The ascii name for the VLAN',
  '<gw>': 'IP address of default gateway',
};

export const commands: CommandDef[] = [
  // ── VLAN database ──
  {
    modes: 'config', pattern: ['vlan <id:int(1-4094)>', 'vlan <list:word>'], feature: 'switching', mutates: false, kinds: SW, help: HV,
    run(env, a) {
      const ids = a.id !== undefined ? [Number(a.id)] : parseVlanList(String(a.list));
      if (!ids) invalidToken(env, 1);
      const vlans = env.device.config.vlans;
      for (const id of ids) if (!vlans[String(id)]) vlans[String(id)] = { name: defaultVlanName(id) };
      env.setMode('config-vlan', { vlanIds: ids });
    },
  },
  {
    modes: 'config', pattern: ['no vlan <id:int(1-4094)>', 'no vlan <list:word>'], feature: 'switching', kinds: SW, help: HV,
    run(env, a) {
      const ids = a.id !== undefined ? [Number(a.id)] : parseVlanList(String(a.list));
      if (!ids) invalidToken(env, 2);
      for (const id of ids) {
        if (RESERVED.includes(id)) { env.print(`%Default VLAN ${id} may not be deleted.`); continue; }
        delete env.device.config.vlans[String(id)];
      }
    },
  },
  {
    modes: 'config-vlan', pattern: 'name <vname:word>', feature: 'switching', kinds: SW, help: HV,
    run(env, a) {
      const name = String(a.vname).slice(0, 32);
      for (const id of vlanIds(env)) {
        if (RESERVED.includes(id)) { env.print(`%Default VLAN ${id} may not have its name changed.`); continue; }
        const v = env.device.config.vlans[String(id)];
        if (v) v.name = name;
      }
    },
  },
  {
    modes: 'config-vlan', pattern: 'no name [<vname:word>]', feature: 'switching', kinds: SW, help: HV,
    run(env) {
      for (const id of vlanIds(env)) { const v = env.device.config.vlans[String(id)]; if (v && !RESERVED.includes(id)) v.name = defaultVlanName(id); }
    },
  },

  // ── switchport ──
  {
    modes: 'config-if', pattern: ['switchport mode {m:access|trunk}', 'switchport mode dynamic {d:auto|desirable}'], feature: 'switching', kinds: SW, help: HV,
    run(env, a) { for (const ifc of ports(env)) l2(env, ifc).mode = a.m ? a.m as 'access' | 'trunk' : 'dynamic'; },
  },
  {
    modes: 'config-if', pattern: 'no switchport mode [<rest:text>]', feature: 'switching', kinds: SW, help: HV,
    run(env) { for (const ifc of ports(env, 1)) l2(env, ifc).mode = 'dynamic'; },
  },
  {
    modes: 'config-if', pattern: 'switchport access vlan <id:int(1-4094)>', feature: 'switching', kinds: SW, help: { ...HV, vlan: 'Set VLAN when interface is in access mode', access: 'Set access mode characteristics of the interface' },
    run(env, a) {
      const id = Number(a.id);
      const ifs = ports(env);
      for (const ifc of ifs) l2(env, ifc);
      const vlans = env.device.config.vlans;
      if (!vlans[String(id)]) {
        env.print(`% Access VLAN does not exist. Creating vlan ${id}`);
        vlans[String(id)] = { name: defaultVlanName(id) };
      }
      for (const ifc of ifs) l2(env, ifc).accessVlan = id;
    },
  },
  {
    modes: 'config-if', pattern: 'no switchport access vlan [<id:int(1-4094)>]', feature: 'switching', kinds: SW, help: HV,
    run(env) { for (const ifc of ports(env, 1)) l2(env, ifc).accessVlan = 1; },
  },
  {
    modes: 'config-if', pattern: ['switchport', 'no switchport'], feature: 'switching', kinds: SW, help: HV,
    run(env) {
      const ifs = ports(env, env.has('no') ? 1 : 0);
      for (const ifc of ifs) {
        if (env.has('no')) {
          if (!ifc.switchport) continue;
          delete ifc.switchport;
          // a routed port starts without addresses; switch ports carry none anyway
        } else if (!ifc.switchport) {
          ifc.switchport = { mode: 'dynamic', accessVlan: 1 };
          delete ifc.ip; delete ifc.secondary; delete ifc.helperAddresses; delete ifc.natRole;
        }
      }
      if (env.has('no')) env.note('This port is now a routed (layer 3) port. It no longer switches traffic in VLAN 1; you can give it an IP address.');
    },
  },
  {
    modes: 'config-if',
    pattern: ['switchport trunk <rest:text>', 'no switchport trunk <rest:text>', 'switchport nonegotiate', 'no switchport nonegotiate',
      'switchport port-security [<rest:text>]', 'no switchport port-security [<rest:text>]', 'switchport voice vlan <rest:text>', 'no switchport voice vlan [<rest:text>]'],
    feature: 'switching', kinds: SW, help: { ...HV, trunk: 'Set trunking characteristics of the interface' },
    run(env, a) {
      const no = env.has('no');
      const sub = env.has('trunk') ? 'trunk' : env.has('nonegotiate') ? 'nonegotiate' : env.has('port-security') ? 'port-security' : 'voice vlan';
      const rest = a.rest === undefined ? '' : ' ' + String(a.rest);
      const line = `switchport ${sub}${rest}`;
      const first = rest.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
      // key = words that name the setting: 'switchport trunk allowed vlan', 'switchport trunk native vlan', 'switchport port-security maximum' …
      const key = sub === 'trunk' ? (first === 'allowed' || first === 'native' ? 4 : 3) : sub === 'nonegotiate' ? 2 : 3;
      for (const ifc of ports(env, no ? 1 : 0)) { l2(env, ifc); ifExtra(ifc, line, key, no ? 'remove' : 'set'); }
      env.note(NOT_SIMULATED + `switchport ${sub} (all switch ports forward VLAN traffic as configured with switchport access vlan).`);
    },
  },

  // ── default gateway (switch management) ──
  {
    modes: 'config', pattern: 'ip default-gateway <gw:ip>', feature: 'switching', help: HV,
    run(env, a) {
      env.device.config.defaultGateway = String(a.gw);
      if (env.device.config.ipRouting) env.note('IP routing is on, so this device ignores the default gateway. Routers use ip route 0.0.0.0 0.0.0.0 … instead.');
    },
  },
  { modes: 'config', pattern: 'no ip default-gateway [<gw:ip>]', feature: 'switching', help: HV, run(env) { delete env.device.config.defaultGateway; } },

  // ── spanning tree / VTP: accepted, not simulated ──
  {
    modes: 'config', pattern: ['spanning-tree <rest:text>', 'no spanning-tree <rest:text>'], feature: 'switching', kinds: SW, help: HV,
    run(env, a) {
      const rest = String(a.rest);
      const w = rest.split(/\s+/);
      // 'spanning-tree mode …' (2 words), 'spanning-tree vlan 1 priority …' (4), anything else: the whole line
      const key = w[0] === 'mode' ? 2 : w[0] === 'vlan' ? 4 : 1 + w.length;
      setExtra(env.device.config.extraLines, `spanning-tree ${rest}`, key, env.has('no') ? 'remove' : 'set');
      env.note(NOT_SIMULATED + 'spanning tree (the simulator has no loops to block).');
    },
  },
  {
    modes: 'config-if', pattern: ['spanning-tree <rest:text>', 'no spanning-tree <rest:text>'], feature: 'switching', kinds: SW, help: HV,
    run(env, a) {
      const rest = String(a.rest);
      const key = rest.split(/\s+/)[0] === 'vlan' ? 4 : 2;
      for (const ifc of currentInterfaces(env)) ifExtra(ifc, `spanning-tree ${rest}`, key, env.has('no') ? 'remove' : 'set');
      env.note(NOT_SIMULATED + 'spanning tree port settings.');
    },
  },
  {
    modes: 'config', pattern: ['vtp <rest:text>', 'no vtp <rest:text>'], feature: 'switching', kinds: SW, help: HV,
    run(env, a) {
      const rest = String(a.rest);
      setExtra(env.device.config.extraLines, `vtp ${rest}`, 2, env.has('no') ? 'remove' : 'set');
      env.note(NOT_SIMULATED + 'VTP.');
    },
  },
];

let installed = false;
export function install(): void { if (installed) return; installed = true; registerCommands(commands); }
