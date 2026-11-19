/**
 * Physical layer and interface state (ARCHITECTURE §5): which cable fits where, which links come up,
 * and the IOS-style status/protocol pair of every interface with a plain-English reason when it is not up.
 */
import type { CableKind, Device, PortKind, PortRef, World } from '../types.ts';
import { ethernetMedium, peerOf, portSpec } from '../world.ts';
import type { IfState, LinkInfo } from './model.ts';
import { isIosDevice, isPcDevice, kindWord, label } from './text.ts';

const CABLE_NAMES: Record<CableKind, string> = {
  straight: 'straight-through', crossover: 'crossover', serial: 'serial', console: 'console',
};
function cap(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1); }
function portLabel(world: World, ref: PortRef): string { return `${label(world, ref.deviceId)} ${ref.port}`; }

/** Which Ethernet cable type this pair of devices needs when auto-MDIX is off. PC and router ports are MDI, switch ports MDI-X. */
export function requiredEthernetCable(a: Device, b: Device): 'straight' | 'crossover' {
  const aSwitch = a.kind === 'switch';
  const bSwitch = b.kind === 'switch';
  return aSwitch !== bSwitch ? 'straight' : 'crossover';
}

function pairWords(a: Device, b: Device): string {
  if (a.kind === b.kind) return a.kind === 'pc' ? 'two PCs' : a.kind === 'router' ? 'two routers' : 'two switches';
  // put the PC / router first, the switch last: "a PC and a switch"
  const order = { pc: 0, router: 1, switch: 2 } as const;
  const [x, y] = order[a.kind] <= order[b.kind] ? [a, b] : [b, a];
  return `${kindWord(x.kind)} and ${kindWord(y.kind)}`;
}

/**
 * Would this cable work between these two ports? `fits` = the plugs go into the sockets at all;
 * `usable` = the link can carry traffic (or console access). Used when a cable is plugged in and by linkInfo().
 */
export function checkCable(
  world: World, kind: CableKind, a: PortRef, b: PortRef,
): { fits: boolean; usable: boolean; problem?: string } {
  const da = world.devices[a.deviceId];
  const db = world.devices[b.deviceId];
  const pa = portSpec(world, a);
  const pb = portSpec(world, b);
  if (!da || !db || !pa || !pb) return { fits: false, usable: false, problem: 'That port does not exist.' };
  if (a.deviceId === b.deviceId) {
    return { fits: false, usable: false, problem: `Both ends of the cable are on ${da.label}. This lab connects cables between different devices.` };
  }
  const sfp = pa.media === 'sfp' ? a : pb.media === 'sfp' ? b : null;
  if (sfp) {
    return { fits: false, usable: false, problem: `${portLabel(world, sfp)} is an SFP cage, not an RJ-45 or Serial jack. NetLab does not simulate SFP transceivers or cables.` };
  }
  const ka: PortKind = pa.kind;
  const kb: PortKind = pb.kind;
  const rj45 = (k: PortKind) => k === 'ethernet' || k === 'console';

  if (kind === 'serial') {
    if (ka === 'serial' && kb === 'serial') return { fits: true, usable: true };
    return { fits: false, usable: false, problem: 'A serial cable only fits the Serial ports of two routers.' };
  }
  if (ka === 'serial' || kb === 'serial') {
    return { fits: false, usable: false, problem: `A ${CABLE_NAMES[kind]} cable does not fit a Serial port. Serial ports need a serial (DCE/DTE) cable.` };
  }

  if (kind === 'console') {
    const rs = ka === 'rs232' ? a : kb === 'rs232' ? b : null;
    const other = rs === a ? b : a;
    const ko = rs === a ? kb : ka;
    if (!rs || ko === 'rs232') {
      return { fits: false, usable: false, problem: "A console cable goes from a PC's COM port to the CON port of a router or switch." };
    }
    if (ko === 'console') return { fits: true, usable: true };
    return {
      fits: true, usable: false,
      problem: `The console cable is plugged into ${portLabel(world, other)}, which is an Ethernet port. Plug it into the port marked CON (Console).`,
    };
  }

  // Ethernet cables: RJ-45 on both ends.
  if (!rj45(ka) || !rj45(kb)) {
    return { fits: false, usable: false, problem: `An Ethernet cable does not fit a PC's COM port. Use the Ethernet port.` };
  }
  if (ka === 'console' || kb === 'console') {
    const con = ka === 'console' ? a : b;
    return {
      fits: true, usable: false,
      problem: `An Ethernet cable is plugged into the console port of ${label(world, con.deviceId)}. The console port carries no network traffic: use an Ethernet port, or a console cable from a PC's COM port.`,
    };
  }
  if (world.settings.strictCables) {
    const need = requiredEthernetCable(da, db);
    if (need !== kind) {
      return {
        fits: true, usable: false,
        problem: `${cap(CABLE_NAMES[kind])} cable between ${pairWords(da, db)}: this pair needs a ${CABLE_NAMES[need]} cable.`,
      };
    }
  }
  return { fits: true, usable: true };
}

/**
 * May this cable be plugged in right now? Checks "one cable per port" and that the plugs fit the sockets.
 * `ok` says nothing about whether the link will come up: an Ethernet cable in a CON port can be plugged in
 * (ok = true) but gives no link — `warning` then says why.
 */
export function canPlug(world: World, kind: CableKind, a: PortRef, b: PortRef): { ok: boolean; problem?: string; warning?: string } {
  for (const ref of [a, b]) {
    if (peerOf(world, ref)) return { ok: false, problem: `${portLabel(world, ref)} already has a cable. Unplug it first: one cable per port.` };
  }
  const c = checkCable(world, kind, a, b);
  if (!c.fits) return { ok: false, problem: c.problem };
  return c.usable ? { ok: true } : { ok: true, warning: c.problem };
}

/** State of the cable plugged into a port. `usable` says nothing about shutdown: it is only about the cable and the sockets. */
export function linkInfo(world: World, ref: PortRef): LinkInfo {
  const link = peerOf(world, ref);
  if (!link) return { cabled: false, usable: false };
  const { cable, peer, myEnd } = link;
  const check = checkCable(world, cable.kind, cable.a, cable.b);
  const info: LinkInfo = { cabled: true, cable, peer, usable: check.usable };
  if (cable.kind === 'serial' && check.usable) info.dce = (cable.dceEnd === 'b' ? 'b' : 'a') === myEnd;
  if (!check.usable) info.problem = check.problem ?? 'This cable cannot be used between these two ports.';
  return info;
}

const DOWN: IfState = { status: 'down', protocol: 'down' };

function svivlan(ifName: string): number | null {
  const m = /^Vlan(\d+)$/.exec(ifName);
  return m ? Number(m[1]) : null;
}

/**
 * IOS-style state of an interface: `administratively down/down`, `down/down`, `up/down` (serial encapsulation mismatch,
 * SVI without an active port) or `up/up`. Works for router and switch interfaces, loopbacks, SVIs and a PC's Ethernet0.
 */
export function interfaceState(world: World, deviceId: string, ifName: string): IfState {
  const dev = world.devices[deviceId];
  if (!dev) return { ...DOWN, problem: `There is no device ${deviceId}.` };

  if (isPcDevice(dev)) {
    const spec = dev.ports.find((p) => p.name === ifName);
    if (!spec || spec.kind !== 'ethernet') return { ...DOWN, problem: `${dev.label} has no network interface ${ifName}.` };
    return physicalState(world, dev, ifName);
  }
  if (!isIosDevice(dev)) return DOWN;

  const cfg = dev.config.interfaces[ifName];
  if (!cfg) return { ...DOWN, problem: `${dev.label} has no interface ${ifName}.` };
  if (cfg.shutdown) {
    return { status: 'administratively down', protocol: 'down', problem: `${ifName} on ${dev.label} is shut down. Enter "no shutdown" on the interface.` };
  }
  if (ifName.startsWith('Loopback')) return { status: 'up', protocol: 'up' };

  const vlan = svivlan(ifName);
  if (vlan !== null) {
    if (dev.kind !== 'switch') return { ...DOWN, problem: `${ifName} is a switch interface. ${dev.label} is a router.` };
    for (const spec of dev.ports) {
      const pc = dev.config.interfaces[spec.name];
      const sp = pc?.switchport;
      if (!sp) continue;
      if (sp.mode !== 'trunk' && sp.accessVlan !== vlan) continue;
      const st = physicalState(world, dev, spec.name);
      if (st.status === 'up' && st.protocol === 'up') return { status: 'up', protocol: 'up' };
    }
    return { status: 'up', protocol: 'down', problem: `${ifName} on ${dev.label} has no active port in VLAN ${vlan}. Connect a device to a port in that VLAN.` };
  }

  const spec = dev.ports.find((p) => p.name === ifName);
  if (!spec || (spec.kind !== 'ethernet' && spec.kind !== 'serial')) {
    return { ...DOWN, problem: `${ifName} on ${dev.label} is not a simulated network port.` };
  }
  return physicalState(world, dev, ifName);
}

/** State of a physical port that is not shut down itself. */
function physicalState(world: World, dev: Device, ifName: string): IfState {
  if (isIosDevice(dev) && dev.config.interfaces[ifName]?.shutdown) {
    return { status: 'administratively down', protocol: 'down', problem: `${ifName} on ${dev.label} is shut down. Enter "no shutdown" on the interface.` };
  }
  const ref = { deviceId: dev.id, port: ifName };
  const link = linkInfo(world, ref);
  const localProblem = sfpProblem(world, ref);
  if (!link.cabled || !link.peer) return { ...DOWN, problem: localProblem ?? `No cable is plugged into ${dev.label} ${ifName}.` };
  if (!link.usable) return { ...DOWN, problem: link.problem };
  const mediumProblem = localProblem ?? sfpProblem(world, link.peer);
  if (mediumProblem) return { ...DOWN, problem: mediumProblem };

  const peerDev = world.devices[link.peer.deviceId];
  const peerName = portLabel(world, link.peer);
  if (isIosDevice(peerDev)) {
    const peerCfg = peerDev.config.interfaces[link.peer.port];
    if (!peerCfg) return { ...DOWN, problem: `The other end (${peerName}) is not a network interface.` };
    if (peerCfg.shutdown) {
      return { ...DOWN, problem: `The other end of the cable (${peerName}) is shut down. Enter "no shutdown" there.` };
    }
    if (link.cable?.kind === 'serial' && isIosDevice(dev)) {
      const mine = dev.config.interfaces[ifName]?.encapsulation ?? 'hdlc';
      const theirs = peerCfg.encapsulation ?? 'hdlc';
      if (mine !== theirs) {
        return {
          status: 'up', protocol: 'down',
          problem: `Encapsulation mismatch on the serial link: ${dev.label} ${ifName} uses ${mine.toUpperCase()}, ${peerName} uses ${theirs.toUpperCase()}. Both ends need the same encapsulation.`,
        };
      }
    }
  }
  return { status: 'up', protocol: 'up' };
}

function sfpProblem(world: World, ref: PortRef): string | undefined {
  const spec = portSpec(world, ref);
  const dev = world.devices[ref.deviceId];
  if (!spec || spec.kind !== 'ethernet' || ethernetMedium(spec, isIosDevice(dev) ? dev.config.interfaces[ref.port] : undefined) !== 'sfp') return;
  const name = portLabel(world, ref);
  return spec.media === 'combo'
    ? `${name} is set to media-type sfp. The RJ-45 connector cannot link in that mode; select media-type rj45 or no media-type.`
    : `${name} has an empty SFP cage. NetLab does not simulate SFP transceivers.`;
}

/** True when the interface is up/up. */
export function isUp(world: World, deviceId: string, ifName: string): boolean {
  const s = interfaceState(world, deviceId, ifName);
  return s.status === 'up' && s.protocol === 'up';
}

/** Port LED for the bench: off = no cable, amber = cable present but no link, green = link up (or working console connection). */
export function portLed(world: World, ref: PortRef): 'off' | 'amber' | 'green' {
  const link = linkInfo(world, ref);
  if (!link.cabled) return 'off';
  const spec = portSpec(world, ref);
  if (!spec) return 'off';
  if (spec.kind === 'console' || spec.kind === 'rs232') return link.usable ? 'green' : 'amber';
  return isUp(world, ref.deviceId, ref.port) ? 'green' : 'amber';
}

/**
 * Console access: the device at the other end of a working console cable.
 * For a PC: the router/switch its COM port is connected to. For a router/switch: the PC plugged into its CON port.
 */
export function consolePeer(world: World, deviceId: string): string | null {
  const dev = world.devices[deviceId];
  if (!dev) return null;
  for (const spec of dev.ports) {
    if (spec.kind !== 'console' && spec.kind !== 'rs232') continue;
    const link = linkInfo(world, { deviceId, port: spec.name });
    if (link.cabled && link.usable && link.cable?.kind === 'console' && link.peer) return link.peer.deviceId;
  }
  return null;
}

// No exact ISR4331 NIM-2T default is verified. Preserve the lab's nominal 2 Mb/s fallback, not a Cisco specification.
const LAB_DEFAULT_CLOCK_BPS = 2_000_000;

/** DCE setting and nominal rate, in bit/s; active means both connected serial ports are enabled (independent of HDLC/PPP). */
export function serialClock(world: World, deviceId: string, ifName: string): { dceDeviceId: string; dceIf: string; configured?: number; effective: number; active: boolean } | null {
  const ref = { deviceId, port: ifName };
  const link = linkInfo(world, ref);
  if (!link.usable || link.dce === undefined || !link.peer) return null;
  const dceRef = link.dce ? ref : link.peer;
  const dteRef = link.dce ? link.peer : ref;
  const configAt = (p: PortRef) => {
    const d = world.devices[p.deviceId];
    return isIosDevice(d) ? d.config.interfaces[p.port] : undefined;
  };
  const dce = configAt(dceRef);
  const dte = configAt(dteRef);
  if (!dce || !dte) return null;
  return {
    dceDeviceId: dceRef.deviceId, dceIf: dceRef.port, configured: dce.clockRate,
    effective: dce.clockRate ?? LAB_DEFAULT_CLOCK_BPS, active: !dce.shutdown && !dte.shutdown,
  };
}
