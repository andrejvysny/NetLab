/**
 * Putting scenario data onto a world: the bench, the pre-built parts (`initial`) and the model solution.
 * The Lab controller can call these directly, or follow the same order:
 *   1. cables (clock rate is only accepted on the DCE end, so the serial cable must be there first)
 *   2. configuration text through applyConfigText(…, 'merge')
 *   3. PC settings and services
 *   4. one DHCP request for every PC that is set to DHCP, in bench order (a PC without a server simply stays without address)
 *   5. the configured routers are saved (startup-config = running-config), as a network that is in service would be
 * Owned by the scenario agent.
 */
import type { Cable, PcSetup, ScenarioInstance, SolutionCable, World, WorldSettings } from '../engine/types.ts';
import { addDevice, createWorld, isIos, isPc, nextId } from '../engine/world.ts';
import { applyConfigText, saveStartupConfig } from '../engine/config/apply.ts';
import { dhcpAcquire } from '../engine/sim/index.ts';

export interface ApplyOutcome {
  ok: boolean;
  /** Configuration lines the CLI did not accept. */
  failed: { deviceId: string; lineNo: number; line: string; output: string }[];
}

function samePort(a: { deviceId: string; port: string }, b: { deviceId: string; port: string }): boolean {
  return a.deviceId === b.deviceId && a.port === b.port;
}
function touches(c: Cable, ref: { deviceId: string; port: string }): boolean { return samePort(c.a, ref) || samePort(c.b, ref); }

/** Plug a cable in. Whatever sits in either port is unplugged first; an identical cable is left alone. */
export function plugCable(world: World, c: SolutionCable): void {
  const same = world.cables.find((x) => x.kind === c.kind
    && ((samePort(x.a, c.a) && samePort(x.b, c.b) && (x.dceEnd ?? 'a') === (c.dceEnd ?? 'a'))
      || (samePort(x.a, c.b) && samePort(x.b, c.a) && c.kind !== 'serial')));
  if (same) return;
  world.cables = world.cables.filter((x) => !touches(x, c.a) && !touches(x, c.b));
  const cable: Cable = { id: `cable-${nextId(world)}`, kind: c.kind, a: { ...c.a }, b: { ...c.b } };
  if (c.kind === 'serial') cable.dceEnd = c.dceEnd ?? 'a';
  world.cables.push(cable);
}
export function unplugAt(world: World, ref: { deviceId: string; port: string }): void {
  world.cables = world.cables.filter((x) => !touches(x, ref));
}

/** Set a PC's adapter and services. A DHCP PC keeps the lease it has. */
export function setPc(world: World, pcId: string, setup: PcSetup): void {
  const pc = world.devices[pcId];
  if (!isPc(pc)) return;
  if (setup.mode === 'static') {
    const next = { mode: 'static' as const, mac: pc.nic.mac, address: setup.address ?? pc.nic.address, mask: setup.mask ?? pc.nic.mask, gateway: setup.gateway ?? pc.nic.gateway };
    pc.nic = { mode: 'static', mac: next.mac };
    if (next.address) pc.nic.address = next.address;
    if (next.mask) pc.nic.mask = next.mask;
    if (next.gateway) pc.nic.gateway = next.gateway;
  } else if (pc.nic.mode !== 'dhcp') {
    pc.nic = { mode: 'dhcp', mac: pc.nic.mac };
  }
  if (setup.services) Object.assign(pc.services, setup.services);
}

function applyConfigs(world: World, configs: Record<string, string> | undefined, out: ApplyOutcome): void {
  for (const [deviceId, text] of Object.entries(configs ?? {})) {
    const r = applyConfigText(world, deviceId, text, 'merge');
    for (const l of r.lines) if (!l.ok) out.failed.push({ deviceId, lineNo: l.lineNo, line: l.line, output: l.output });
  }
}
function renewAll(world: World): void {
  for (const id of world.order) {
    const d = world.devices[id];
    if (isPc(d) && d.nic.mode === 'dhcp') dhcpAcquire(world, id);
  }
}
function saveAll(world: World, ids: string[]): void {
  for (const id of ids) if (isIos(world.devices[id])) saveStartupConfig(world, id);
}

/** A new world with the devices of the scenario on the bench, uncabled and unconfigured. */
export function benchWorld(inst: ScenarioInstance, settings: Partial<WorldSettings> = {}): World {
  const world = createWorld({ ...(inst.initial?.settings ?? {}), ...settings });
  for (const seed of inst.bench) addDevice(world, seed);
  return world;
}

/** Put the pre-built parts of the scenario on the bench. Does nothing for a scenario that starts from scratch. */
export function applyInitial(world: World, inst: ScenarioInstance): ApplyOutcome {
  const out: ApplyOutcome = { ok: true, failed: [] };
  const init = inst.initial;
  if (!init) return out;
  if (init.settings) Object.assign(world.settings, init.settings);
  for (const c of init.cables ?? []) plugCable(world, c);
  applyConfigs(world, init.configs, out);
  for (const [pcId, setup] of Object.entries(init.pcs ?? {})) setPc(world, pcId, setup);
  renewAll(world);
  saveAll(world, Object.keys(init.configs ?? {}));
  out.ok = out.failed.length === 0;
  return out;
}

/** Bench plus pre-built parts: the world as the student finds it. */
export function startWorld(inst: ScenarioInstance, settings: Partial<WorldSettings> = {}): World {
  const world = benchWorld(inst, settings);
  applyInitial(world, inst);
  return world;
}

/**
 * Apply the model solution: cables, configuration (through the real CLI), PC settings, DHCP leases, and a final save
 * of both routers. For a broken network this applies the documented fixes.
 */
export function applySolution(world: World, inst: ScenarioInstance): ApplyOutcome {
  const out: ApplyOutcome = { ok: true, failed: [] };
  for (const c of inst.solution.cables) plugCable(world, c);
  applyConfigs(world, inst.solution.configs, out);
  for (const [pcId, setup] of Object.entries(inst.solution.pcs)) setPc(world, pcId, setup);
  renewAll(world);
  saveAll(world, ['R1', 'R2']);
  out.ok = out.failed.length === 0;
  return out;
}
