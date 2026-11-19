/**
 * interface <if> / interface range / no interface / default interface, and the basic interface sub-commands:
 * ip address [secondary], no ip address, shutdown, description, bandwidth, clock rate, encapsulation, duplex, speed,
 * media-type on the dual-media port, [no] ip unreachables, plus accepted-but-not-simulated lines
 * (mtu, ip mtu, ip redirects, ip proxy-arp, negotiation, cdp enable, keepalive, load-interval, ip ospf …, ppp …).
 *
 * session.ctx in config-if: { ifNames: string[], range?: boolean }  (contract from framework.ts)
 *
 * Physical ports must exist on the device. `Loopback<n>` is created on demand; `Vlan<n>` (SVI) only on switches.
 * `interface vlan <id>` lives here (not in switch.ts) so that one CommandDef owns `interface <if>`.
 */
import type { CmdEnv, CommandDef } from '../framework.ts';
import { currentInterfaces, registerCommands } from '../framework.ts';
import type { InterfaceConfig, IosDevice } from '../../types.ts';
import { broadcastOf, ipToInt, isMask, maskToPrefix, networkOf, parseIfName } from '../../ip.ts';
import { portSpec } from '../../world.ts';
import { linkInfo } from '../../sim/physical.ts';
import { invalidAt, invalidToken, setExtra, tokenIndexOf, tokens, NOT_SIMULATED } from './system.ts';

// ───────────────────────────── helpers (exported for the other base modules) ─────────────────────────────
export type IfClass = 'ethernet' | 'serial' | 'loopback' | 'vlan' | 'other';
export function ifClass(name: string): IfClass {
  if (/^(GigabitEthernet|FastEthernet|TenGigabitEthernet|Ethernet)/.test(name)) return 'ethernet';
  if (name.startsWith('Serial')) return 'serial';
  if (name.startsWith('Loopback')) return 'loopback';
  if (name.startsWith('Vlan')) return 'vlan';
  return 'other';
}
export function isPhysical(dev: IosDevice, name: string): boolean {
  return dev.ports.some((p) => p.name === name && (p.kind === 'ethernet' || p.kind === 'serial'));
}
/** Switch port still in layer-2 (switchport) mode: no IP commands. */
export function isL2Port(dev: IosDevice, ifc: InterfaceConfig): boolean {
  return dev.kind === 'switch' && isPhysical(dev, ifc.name) && !!ifc.switchport;
}
/** 'Loopback00' → 'Loopback0', 'Vlan010' → 'Vlan10'. */
export function normIfName(name: string): string {
  const m = /^([A-Za-z]+)(.*)$/.exec(name);
  if (!m) return name;
  return m[1] + m[2].replace(/\d+/g, (d) => String(Number(d)));
}
function knownNumbers(dev: IosDevice, type: string): string[] {
  const names = new Set([...Object.keys(dev.config.interfaces), ...dev.ports.filter((p) => p.kind === 'ethernet' || p.kind === 'serial').map((p) => p.name)]);
  return [...names].filter((n) => n.startsWith(type) && /^\d/.test(n.slice(type.length))).map((n) => n.slice(type.length));
}
function creatable(dev: IosDevice, type: string): boolean { return type === 'Loopback' || (type === 'Vlan' && dev.kind === 'switch'); }

/** Column for the caret when the interface typed at token `tokIdx` (one or two tokens) does not exist. */
export function ifCaretCol(env: CmdEnv, tokIdx: number, name: string): number {
  const t = tokens(env.line);
  const tok = t[tokIdx];
  if (!tok) return env.line.length;
  const m = /^([A-Za-z]+)(.*)$/.exec(tok.text);
  let numStart: number, numText: string;
  if (m && m[2] === '' && t[tokIdx + 1]) { numStart = t[tokIdx + 1].start; numText = t[tokIdx + 1].text; }
  else { numStart = tok.start + (m ? m[1].length : 0); numText = m ? m[2] : tok.text; }
  const type = name.replace(/\d.*$/, '');
  const known = knownNumbers(env.device, type);
  if (!known.length && !creatable(env.device, type)) return tok.start;
  const typed = numText.split(/([/.])/); // keep separators to compute columns
  const comps: { text: string; col: number }[] = [];
  let col = numStart;
  for (const part of typed) { if (part !== '/' && part !== '.') comps.push({ text: part, col }); col += part.length; }
  if (creatable(env.device, type)) {
    // Loopback / Vlan: one number only
    const dot = numText.search(/[/.]/);
    return dot >= 0 ? numStart + dot : numStart;
  }
  for (let i = 0; i < comps.length; i++) {
    const prefix = comps.slice(0, i + 1).map((c) => String(Number(c.text)));
    const ok = known.some((k) => { const kc = k.split('/'); return prefix.every((c, j) => kc[j] === c); });
    if (!ok) return comps[i].col;
  }
  return numStart + numText.length;
}

/** Find (or create Loopback/Vlan) the interface named `name`, typed at token `tokIdx`. Rejects like IOS. */
export function resolveInterface(env: CmdEnv, rawName: string, tokIdx: number, create: boolean): InterfaceConfig {
  const dev = env.device; const cfg = dev.config;
  const name = normIfName(rawName);
  if (cfg.interfaces[name]) return cfg.interfaces[name];
  const cls = ifClass(name);
  const num = name.replace(/^[A-Za-z]+/, '');
  if (create && cls === 'loopback' && /^\d+$/.test(num) && Number(num) <= 2147483647) {
    cfg.interfaces[name] = { name, shutdown: false };
    return cfg.interfaces[name];
  }
  if (create && cls === 'vlan' && dev.kind === 'switch' && /^\d+$/.test(num) && Number(num) >= 1 && Number(num) <= 4094) {
    cfg.interfaces[name] = { name, shutdown: false };
    return cfg.interfaces[name];
  }
  if (num.includes('.') && cfg.interfaces[name.split('.')[0]]) env.note('Subinterfaces (for example Gi0/0/0.10) are not part of this simulator.');
  else if (name.startsWith('Tunnel')) env.note('Tunnel interfaces are not part of this simulator.');
  else if (cls === 'vlan' && dev.kind === 'router') env.note('A router has no VLAN interfaces. Configure the physical port instead.');
  else if (/^(FastEthernet|Ethernet)/.test(name)) env.note(`This device has no ${name.replace(/\d.*$/, '')} ports. Its ports are named like ${dev.ports[0]?.name ?? 'GigabitEthernet0/0/0'}.`);
  invalidAt(env, ifCaretCol(env, tokIdx, name));
}

/** Parse the text after `interface range` into interface names, or reject with a caret. */
export function parseIfRange(env: CmdEnv, spec: string, specCol: number): string[] {
  const out: string[] = [];
  let offset = 0;
  for (const piece of spec.split(',')) {
    const lead = piece.length - piece.trimStart().length;
    const col = specCol + offset + lead;
    const text = piece.trim();
    offset += piece.length + 1;
    if (!text) invalidAt(env, col);
    const m = /^([A-Za-z]+)\s*(\d+(?:\/\d+)*)\s*(?:-\s*(\d+))?$/.exec(text);
    if (!m) invalidAt(env, col);
    const t = parseIfName(m[1]);
    if (!t || !('typeOnly' in t)) invalidAt(env, col);
    const type = t.typeOnly;
    const comps = m[2].split('/').map((c) => String(Number(c)));
    const startNum = Number(comps[comps.length - 1]);
    const endNum = m[3] === undefined ? startNum : Number(m[3]);
    const numCol = col + text.indexOf(m[2], m[1].length);
    if (endNum < startNum) invalidAt(env, col + text.lastIndexOf(m[3]!));
    for (let n = startNum; n <= endNum; n++) {
      const name = type + [...comps.slice(0, -1), String(n)].join('/');
      if (!env.device.config.interfaces[name]) {
        if (n === startNum) {
          // caret at the failing component of the first interface
          const known = knownNumbers(env.device, type);
          if (!known.length) invalidAt(env, col);
          let c = numCol;
          for (let i = 0; i < comps.length; i++) {
            const prefix = comps.slice(0, i + 1);
            if (!known.some((k) => prefix.every((p, j) => k.split('/')[j] === p))) invalidAt(env, c);
            c += m[2].split('/')[i].length + 1;
          }
          invalidAt(env, numCol);
        }
        invalidAt(env, col + text.lastIndexOf(m[3]!));
      }
      if (!out.includes(name)) out.push(name);
    }
  }
  return out;
}

function ifExtra(ifc: InterfaceConfig, line: string, key: number, mode: 'set' | 'remove'): void {
  if (!ifc.extraLines) ifc.extraLines = [];
  setExtra(ifc.extraLines, line, key, mode);
  if (!ifc.extraLines.length) delete ifc.extraLines;
}

// ── ip address validation ──
function hex(mask: string): string { return '0x' + ipToInt(mask).toString(16).toUpperCase().padStart(8, '0'); }
/** Other interface whose subnet overlaps addr/mask (primary or secondary), if any. */
export function overlapping(dev: IosDevice, selfName: string, addr: string, mask: string): string | undefined {
  for (const other of Object.values(dev.config.interfaces)) {
    if (other.name === selfName) continue;
    for (const ipm of [other.ip, ...(other.secondary ?? [])]) {
      if (!ipm) continue;
      const m = maskToPrefix(ipm.mask) < maskToPrefix(mask) ? ipm.mask : mask;
      if (networkOf(addr, m) === networkOf(ipm.address, m)) return other.name;
    }
  }
  return undefined;
}
/** Validate and assign. Returns the IOS error text, or null on success. */
function assignIp(env: CmdEnv, ifc: InterfaceConfig, addr: string, mask: string, secondary: boolean): string | null {
  if (!isMask(mask)) return `Bad mask ${hex(mask)} for address ${addr}`;
  const first = Number(addr.split('.')[0]);
  if (first === 0 || first === 127 || first >= 224) return `Not a valid host address - ${addr}`;
  const len = maskToPrefix(mask);
  const cls = ifClass(ifc.name);
  if (len === 0 || (len === 32 && cls !== 'loopback')) return `Bad mask /${len} for address ${addr}`;
  if (len <= 30 && (addr === networkOf(addr, mask) || addr === broadcastOf(addr, mask))) return `Bad mask /${len} for address ${addr}`;
  const clash = overlapping(env.device, ifc.name, addr, mask);
  if (clash) return `% ${networkOf(addr, mask)} overlaps with ${clash}`;
  if (len === 31 && (cls === 'ethernet' || cls === 'vlan')) env.print('% Warning: use /31 mask on non point-to-point interface cautiously');
  if (secondary) {
    if (ifc.ip && ifc.ip.address === addr) return null;
    const list = ifc.secondary ?? [];
    if (!list.some((s) => s.address === addr && s.mask === mask)) list.push({ address: addr, mask });
    ifc.secondary = list;
    if (!ifc.ip) env.note('This interface has no primary address yet. Add one without the word secondary.');
  } else {
    if (ifc.secondary) {
      ifc.secondary = ifc.secondary.filter((s) => s.address !== addr);
      if (!ifc.secondary.length) delete ifc.secondary;
    }
    ifc.ip = { address: addr, mask };
  }
  return null;
}

/** IOS rejects IP commands on a layer-2 switch port: caret under the keyword after `ip`. */
export function rejectIfL2(env: CmdEnv, ifs: InterfaceConfig[], keyword: string): void {
  if (ifs.some((i) => isL2Port(env.device, i))) {
    const idx = tokenIndexOf(env, keyword, 1);
    env.note('This switch port works at layer 2 (switchport). Put the IP address on an interface vlan, or type no switchport first.');
    invalidToken(env, idx < 0 ? 0 : idx);
  }
}
function requireClass(env: CmdEnv, ifs: InterfaceConfig[], allowed: IfClass[], tokIdx = 0): void {
  if (ifs.some((i) => !allowed.includes(ifClass(i.name)))) invalidToken(env, tokIdx);
}

// ── clock rate ──
// NIM-1T/2T/4T configuration guide OL-31531-01, Required Features step 4 (not the PA/VIP rate table).
const NIM_RATES = [1200, 2400, 4800, 9600, 14400, 19200, 28800, 32000, 38400, 48000, 56000, 57600, 64000,
  72000, 115200, 125000, 148000, 192000, 250000, 256000, 384000, 500000, 512000, 768000, 800000, 1000000,
  2000000, 4000000, 5300000, 8000000];
export function roundClockRate(bps: number): number {
  // Preserve the worked lab's exact 128 kbit/s and existing configs. It is not in the documented NIM list.
  if (bps === 128000) return bps;
  let best = NIM_RATES[0];
  for (const r of NIM_RATES) if (Math.abs(r - bps) < Math.abs(best - bps)) best = r;
  return best;
}
export function isDceHere(env: CmdEnv, ifName: string): { cabled: boolean; dce: boolean } {
  const link = linkInfo(env.world, { deviceId: env.device.id, port: ifName });
  return { cabled: link.dce !== undefined, dce: link.dce === true };
}

const IF_TYPE_NAMES: Record<string, string> = { gigabitethernet: 'GigabitEthernet', serial: 'Serial', loopback: 'Loopback', vlan: 'Vlan' };
const HI: Record<string, string> = {
  gigabitethernet: 'GigabitEthernet IEEE 802.3z',
  serial: 'Serial',
  loopback: 'Loopback interface',
  vlan: 'Catalyst Vlans',
  '<num>': 'interface number',
  interface: 'Select an interface to configure',
  range: 'interface range command',
  ip: 'Interface Internet Protocol config commands',
  address: 'Set the IP address of an interface',
  secondary: 'Make this IP address a secondary address',
  shutdown: 'Shutdown the selected interface',
  description: 'Interface specific description',
  bandwidth: 'Set bandwidth informational parameter',
  clock: 'Configure serial interface clock',
  rate: 'Configure serial interface clock speed',
  encapsulation: 'Set encapsulation type for an interface',
  hdlc: 'Serial HDLC synchronous',
  ppp: 'Point-to-Point protocol',
  duplex: 'Configure duplex operation.',
  auto: 'Enable AUTO duplex configuration',
  full: 'Force full duplex operation',
  half: 'Force half-duplex operation',
  speed: 'Configure speed operation.',
  '10': 'Force 10 Mbps operation',
  '100': 'Force 100 Mbps operation',
  '1000': 'Force 1000 Mbps operation',
  unreachables: 'Enable sending ICMP Unreachable messages',
  mtu: 'Set the interface Maximum Transmission Unit (MTU)',
  redirects: 'Enable sending ICMP Redirect messages',
  'proxy-arp': 'Enable proxy ARP',
  'directed-broadcast': 'Enable forwarding of directed broadcasts',
  negotiation: 'Select Autonegotiation mode',
  'media-type': 'Media type',
  cdp: 'CDP interface subcommands',
  enable: 'Enable CDP on interface',
  keepalive: 'Enable keepalive',
  'load-interval': 'Specify interval for load calculation for an interface',
  ospf: 'OSPF interface commands',
  no: 'Negate a command or set its defaults',
  default: 'Set a command to its defaults',
  '<addr>': 'IP address',
  '<mask>': 'IP subnet mask',
  '<kbps>': 'Bandwidth in kilobits',
  '<bps>': 'DCE clock rate (bits per second)',
  '<text>': 'Up to 240 characters describing this interface',
};

export const commands: CommandDef[] = [
  // ── navigation ──
  {
    modes: 'config', pattern: 'interface <ifname:if>', feature: 'interface', mutates: false, help: HI,
    run(env, a) {
      const ifc = resolveInterface(env, String(a.ifname), 1, true);
      env.setMode('config-if', { ifNames: [ifc.name] });
    },
  },
  // `interface gigabitEthernet 0/0/0` with the type as a keyword: gives `interface ?` the IOS list of types,
  // and `interface loopback` alone reports % Incomplete command.
  ...(['router', 'switch'] as const).map((kind): CommandDef => ({
    modes: 'config', kinds: [kind], feature: 'interface', mutates: false, help: HI,
    pattern: kind === 'router' ? 'interface {type:gigabitethernet|serial|loopback} <num:word>' : 'interface {type:gigabitethernet|loopback|vlan} <num:word>',
    run(env, a) {
      if (!/^\d/.test(String(a.num))) invalidToken(env, 2);
      const ifc = resolveInterface(env, IF_TYPE_NAMES[String(a.type)] + String(a.num), 1, true);
      env.setMode('config-if', { ifNames: [ifc.name] });
    },
  })),
  {
    modes: 'config', pattern: 'interface range <spec:text>', feature: 'interface', mutates: false, help: HI,
    run(env, a) {
      const t = tokens(env.line);
      const names = parseIfRange(env, String(a.spec), t[2]?.start ?? env.line.length);
      env.setMode('config-if', { ifNames: names, range: true });
    },
  },
  {
    modes: 'config', pattern: 'no interface <ifname:if>', feature: 'interface', help: HI,
    run(env, a) {
      const dev = env.device; const cfg = dev.config;
      const name = normIfName(String(a.ifname));
      const cls = ifClass(name);
      if (!cfg.interfaces[name]) {
        if (cls === 'loopback' || (cls === 'vlan' && dev.kind === 'switch')) return; // nothing to delete
        invalidAt(env, ifCaretCol(env, 2, name));
      }
      if (isPhysical(dev, name) || name === 'Vlan1') {
        env.note(name === 'Vlan1' ? 'Vlan1 always exists and cannot be deleted.' : 'A physical port cannot be deleted. Use default interface ' + name + ' to clear its settings.');
        invalidToken(env, 2);
      }
      delete cfg.interfaces[name];
    },
  },
  {
    modes: 'config', pattern: 'default interface <ifname:if>', feature: 'interface', help: { ...HI, default: 'Set a command to its defaults' },
    run(env, a) {
      const dev = env.device;
      const ifc = resolveInterface(env, String(a.ifname), 2, false);
      const fresh: InterfaceConfig = dev.kind === 'router'
        ? { name: ifc.name, shutdown: isPhysical(dev, ifc.name) }
        : isPhysical(dev, ifc.name) ? { name: ifc.name, shutdown: false, switchport: { mode: 'dynamic', accessVlan: 1 } } : { name: ifc.name, shutdown: ifc.name === 'Vlan1' };
      dev.config.interfaces[ifc.name] = fresh;
      env.print(`Interface ${ifc.name} set to default configuration`);
    },
  },

  // ── ip address ──
  {
    modes: 'config-if', pattern: 'ip address <addr:ip> <mask:mask> [secondary]', feature: 'interface', help: HI,
    run(env, a) {
      const ifs = currentInterfaces(env);
      rejectIfL2(env, ifs, 'address');
      for (const ifc of ifs) {
        const err = assignIp(env, ifc, String(a.addr), String(a.mask), env.has('secondary'));
        if (err) { if (ifs.length === 1) env.reject(err); env.print(err); }
      }
    },
  },
  {
    modes: 'config-if', pattern: 'no ip address [<addr:ip> <mask:mask> [secondary]]', feature: 'interface', help: HI,
    run(env, a) {
      for (const ifc of currentInterfaces(env)) {
        if (a.addr === undefined) { delete ifc.ip; delete ifc.secondary; continue; }
        if (env.has('secondary')) {
          if (ifc.secondary) { ifc.secondary = ifc.secondary.filter((s) => s.address !== a.addr); if (!ifc.secondary.length) delete ifc.secondary; }
          continue;
        }
        if (ifc.ip && ifc.ip.address === a.addr) {
          if (ifc.secondary?.length) env.reject('Must delete secondary before deleting primary');
          delete ifc.ip;
        }
      }
    },
  },

  // ── shutdown ──
  {
    modes: 'config-if', pattern: ['shutdown', 'no shutdown'], feature: 'interface', help: HI,
    run(env) { const down = !env.has('no'); for (const ifc of currentInterfaces(env)) ifc.shutdown = down; },
  },

  // ── description ──
  { modes: 'config-if', pattern: 'description <text:text>', feature: 'interface', help: HI, run(env, a) { for (const ifc of currentInterfaces(env)) ifc.description = String(a.text).slice(0, 240); } },
  { modes: 'config-if', pattern: 'no description [<text:text>]', feature: 'interface', help: HI, run(env) { for (const ifc of currentInterfaces(env)) delete ifc.description; } },

  // ── bandwidth ──
  { modes: 'config-if', pattern: 'bandwidth <kbps:int(1-10000000)>', feature: 'interface', help: HI, run(env, a) { for (const ifc of currentInterfaces(env)) ifc.bandwidthKbps = Number(a.kbps); } },
  { modes: 'config-if', pattern: 'no bandwidth [<kbps:int(1-10000000)>]', feature: 'interface', help: HI, run(env) { for (const ifc of currentInterfaces(env)) delete ifc.bandwidthKbps; } },

  // ── clock rate ──
  {
    modes: 'config-if', pattern: 'clock rate <bps:int(1200-8000000)>', feature: 'interface', help: HI,
    run(env, a) {
      const ifs = currentInterfaces(env);
      requireClass(env, ifs, ['serial']);
      const bps = Number(a.bps);
      const rate = roundClockRate(bps);
      let applied = false;
      for (const ifc of ifs) {
        const d = isDceHere(env, ifc.name);
        // a configuration file may be applied while the cable is unplugged: keep the setting then
        const ok = d.dce || (env.session.via === 'file' && !d.cabled);
        if (!ok) {
          if (ifs.length === 1) {
            env.note(d.cabled ? 'This end of the serial cable is DTE. Set the clock rate on the router that has the DCE end.' : 'No serial cable is plugged into this port yet. The clock rate can only be set on the DCE end of a serial cable.');
            env.reject('%Error: This command applies only to DCE interfaces');
          }
          env.print('%Error: This command applies only to DCE interfaces');
          continue;
        }
        ifc.clockRate = rate;
        applied = true;
      }
      if (applied && rate !== bps) env.print('%Clockrate rounded to nearest value that your hardware can support.');
      if (applied && bps === 128000) env.note('NetLab accepts 128000 for the worked lab. It is not listed for the NIM-2T in Cisco’s module guide; check clock rate ? on real equipment.');
    },
  },
  {
    modes: 'config-if', pattern: 'no clock rate [<bps:int(1200-8000000)>]', feature: 'interface', help: HI,
    run(env) { const ifs = currentInterfaces(env); requireClass(env, ifs, ['serial'], 1); for (const ifc of ifs) delete ifc.clockRate; },
  },

  // ── encapsulation ──
  {
    modes: 'config-if', pattern: 'encapsulation {enc:hdlc|ppp}', feature: 'interface', help: HI,
    run(env, a) {
      const ifs = currentInterfaces(env);
      if (ifs.some((i) => ifClass(i.name) === 'loopback')) invalidToken(env, 0);
      requireClass(env, ifs, ['serial'], 1);
      for (const ifc of ifs) { if (a.enc === 'ppp') ifc.encapsulation = 'ppp'; else delete ifc.encapsulation; }
    },
  },
  {
    modes: 'config-if', pattern: 'no encapsulation [{enc:hdlc|ppp}]', feature: 'interface', help: HI,
    run(env) { for (const ifc of currentInterfaces(env)) delete ifc.encapsulation; },
  },

  // ── duplex / speed ──
  {
    modes: 'config-if', pattern: 'duplex {mode:auto|full|half}', feature: 'interface', help: HI,
    run(env, a) {
      const ifs = currentInterfaces(env); requireClass(env, ifs, ['ethernet']);
      for (const ifc of ifs) { if (a.mode === 'auto') delete ifc.duplex; else ifc.duplex = String(a.mode); }
    },
  },
  { modes: 'config-if', pattern: 'no duplex [{mode:auto|full|half}]', feature: 'interface', help: HI, run(env) { const ifs = currentInterfaces(env); requireClass(env, ifs, ['ethernet'], 1); for (const ifc of ifs) delete ifc.duplex; } },
  {
    modes: 'config-if', pattern: 'speed {spd:10|100|1000|auto}', feature: 'interface', help: { ...HI, auto: 'Enable AUTO speed configuration' },
    run(env, a) {
      const ifs = currentInterfaces(env); requireClass(env, ifs, ['ethernet']);
      for (const ifc of ifs) { if (a.spd === 'auto') delete ifc.speed; else ifc.speed = String(a.spd); }
    },
  },
  { modes: 'config-if', pattern: 'no speed [{spd:10|100|1000|auto}]', feature: 'interface', help: HI, run(env) { const ifs = currentInterfaces(env); requireClass(env, ifs, ['ethernet'], 1); for (const ifc of ifs) delete ifc.speed; } },

  // ── ip unreachables (decides U vs . when an ACL drops a packet) ──
  {
    modes: 'config-if', pattern: ['ip unreachables', 'no ip unreachables'], feature: 'acl', help: HI,
    run(env) {
      const ifs = currentInterfaces(env); rejectIfL2(env, ifs, 'unreachables');
      for (const ifc of ifs) { if (env.has('no')) ifc.noIpUnreachables = true; else delete ifc.noIpUnreachables; }
    },
  },

  // ── accepted, not simulated (InterfaceConfig.extraLines) ──
  passiveIf(['mtu <n:int(64-9216)>', 'no mtu [<n:int(64-9216)>]'], (a) => `mtu ${a.n ?? ''}`.trim(), 1, (a, e) => (e.has('no') || Number(a.n) === 1500 ? 'remove' : 'set'), 'the interface MTU'),
  passiveIf(['ip mtu <n:int(68-9216)>', 'no ip mtu [<n:int(68-9216)>]'], (a) => `ip mtu ${a.n ?? ''}`.trim(), 2, (a, e) => (e.has('no') || Number(a.n) === 1500 ? 'remove' : 'set'), 'the IP MTU', { l2: 'mtu' }),
  passiveIf(['ip redirects', 'no ip redirects'], () => 'no ip redirects', 2, (_a, e) => (e.has('no') ? 'set' : 'remove'), 'ICMP redirects', { l2: 'redirects' }),
  passiveIf(['ip proxy-arp', 'no ip proxy-arp'], () => 'no ip proxy-arp', 2, (_a, e) => (e.has('no') ? 'set' : 'remove'), 'proxy ARP', { l2: 'proxy-arp' }),
  passiveIf(['ip directed-broadcast', 'no ip directed-broadcast'], () => 'ip directed-broadcast', 2, (_a, e) => (e.has('no') ? 'remove' : 'set'), 'directed broadcasts', { l2: 'directed-broadcast' }),
  passiveIf(['ip route-cache', 'no ip route-cache'], () => 'no ip route-cache', 2, (_a, e) => (e.has('no') ? 'set' : 'remove'), 'the route cache'),
  passiveIf(['ip tcp adjust-mss <n:int(500-1460)>', 'no ip tcp adjust-mss [<n:int(500-1460)>]'], (a) => `ip tcp adjust-mss ${a.n ?? ''}`.trim(), 3, (_a, e) => (e.has('no') ? 'remove' : 'set'), 'TCP MSS adjustment'),
  passiveIf(['negotiation auto', 'no negotiation auto'], () => 'no negotiation auto', 2, (_a, e) => (e.has('no') ? 'set' : 'remove'), 'link negotiation', { only: ['ethernet'] }),
  {
    modes: 'config-if', pattern: ['media-type {m:rj45|sfp|auto-select}', 'no media-type [{m:rj45|sfp|auto-select}]'], feature: 'interface', help: HI,
    run(env, a) {
      const ifs = currentInterfaces(env);
      if (ifs.some((i) => portSpec(env.world, { deviceId: env.device.id, port: i.name })?.media !== 'combo')) {
        env.note('Media selection is only available on the dual-media GE 0/0/0 interface of the ISR 4331.');
        invalidToken(env, env.has('no') ? 1 : 0);
      }
      for (const ifc of ifs) ifExtra(ifc, `media-type ${a.m ?? ''}`.trim(), 1, env.has('no') ? 'remove' : 'set');
      if (!env.has('no') && a.m === 'sfp') env.note('The RJ-45 side is no longer selected. This bench does not provide SFP transceivers or cables.');
    },
  },
  passiveIf(['cdp enable', 'no cdp enable'], () => 'no cdp enable', 2, (_a, e) => (e.has('no') ? 'set' : 'remove'), 'CDP'),
  passiveIf(['keepalive [<n:int(0-32767)>]', 'no keepalive [<n:int(0-32767)>]'], (a, e) => (e.has('no') ? 'no keepalive' : `keepalive ${a.n ?? ''}`.trim()), 1, (a, e) => (!e.has('no') && (a.n === undefined || Number(a.n) === 10) ? 'remove' : 'set'), 'keepalives'),
  passiveIf(['load-interval <n:int(30-600)>', 'no load-interval [<n:int(30-600)>]'], (a) => `load-interval ${a.n ?? ''}`.trim(), 1, (a, e) => (e.has('no') || Number(a.n) === 300 ? 'remove' : 'set'), 'load averages'),
  passiveIf(['ppp <rest:text>', 'no ppp <rest:text>'], (a) => `ppp ${a.rest}`, 2, (_a, e) => (e.has('no') ? 'remove' : 'set'), 'PPP options (authentication is not checked)', { only: ['serial'] }),
  { ...passiveIf(['ip ospf <rest:text>', 'no ip ospf <rest:text>'], (a) => `ip ospf ${a.rest}`, 3, (_a, e) => (e.has('no') ? 'remove' : 'set'), 'OSPF interface settings', { l2: 'ospf' }), feature: 'routing' },
];

function passiveIf(
  pattern: string[], line: (a: Record<string, any>, e: CmdEnv) => string, key: number,
  mode: (a: Record<string, any>, e: CmdEnv) => 'set' | 'remove', what: string, opts: { only?: IfClass[]; l2?: string } = {},
): CommandDef {
  return {
    modes: 'config-if', pattern, feature: 'interface', help: HI,
    run(env, a) {
      const ifs = currentInterfaces(env);
      if (opts.only) requireClass(env, ifs, opts.only, env.has('no') ? 1 : 0);
      if (opts.l2) rejectIfL2(env, ifs, opts.l2);
      for (const ifc of ifs) ifExtra(ifc, line(a, env), key, mode(a, env));
      env.note(NOT_SIMULATED + what + '.');
    },
  };
}

let installed = false;
export function install(): void { if (installed) return; installed = true; registerCommands(commands); }
