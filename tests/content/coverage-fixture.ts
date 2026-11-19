import assert from 'node:assert/strict';
import { execLine, installCli, startSession } from '../../src/engine/cli/index.ts';
import type { CliSession } from '../../src/engine/cli/index.ts';
import { addDevice, createWorld, getIos, getPc } from '../../src/engine/world.ts';
import type { World } from '../../src/engine/types.ts';
import { cable } from '../sim/fixtures.ts';

export type Model = 'isr4331' | 'c9300l';
export type Preset = 'fresh' | 'wire' | 'linked' | 'routed';
export type Target = 'X' | 'P';
export const LAN = '192.168.40.1', A = '192.168.40.10', B = '192.168.40.11';
export const WAN = '198.51.100.1', PEER = '198.51.100.2', RLAN = '192.0.2.1', C = '192.0.2.10';
export const GLOBAL = '203.0.113.10', MASK = '255.255.255.0';
installCli();

export interface SetupCommand { device: string; via: CliSession['via']; mode: CliSession['mode']; input: string }
const transcripts = new WeakMap<World, SetupCommand[]>();
export const transcript = (w: World) => transcripts.get(w) ?? [];

export function commands(w: World, id: string, lines: readonly string[], into?: CliSession) {
  const s = into ?? startSession(w, id, 'file').session;
  for (const line of lines) {
    transcripts.get(w)?.push({ device: id, via: s.via, mode: s.mode, input: line });
    const o = execLine(w, s, line);
    assert.equal(o.status, 'ok', `${id} prerequisite ${line}: ${o.output}`);
    assert.equal(s.pending, undefined, `${id} prerequisite stopped for input: ${line}`);
  }
  return s;
}

export function fixture(model: Model, preset: Preset) {
  const w = createWorld();
  transcripts.set(w, []);
  const add = (id: string, m: 'pc-windows' | Model) => addDevice(w, { id, model: m, label: id, x: 0, y: 0 });
  add('X', model); add('P', 'isr4331');
  const isr = model === 'isr4331';
  const lan = isr ? 'GigabitEthernet0/0/0' : 'GigabitEthernet1/0/1';
  const wan = isr ? 'Serial0/1/0' : 'GigabitEthernet1/0/2';
  const peerWan = isr ? 'Serial0/1/0' : 'GigabitEthernet0/0/1';
  for (const id of ['X', 'P']) getIos(w, id).runtime.setupDialogDone = true;
  const x = (...lines: string[]) => commands(w, 'X', ['configure terminal', ...lines, 'end']);
  const p = (...lines: string[]) => commands(w, 'P', ['configure terminal', ...lines, 'end']);
  const ip = (address: string) => `ip address ${address} ${MASK}`;
  if (preset !== 'fresh') {
    add('L2', 'c9300l'); for (const id of ['A', 'B', 'C']) add(id, 'pc-windows');
    // Routed LAN ports; the spare switch is just an L2 fan-out for A and B.
    cable(w, isr ? 'straight' : 'crossover', ['X', lan], ['L2', 'GigabitEthernet1/0/1']);
    cable(w, 'straight', ['A', 'Ethernet0'], ['L2', 'GigabitEthernet1/0/2']);
    cable(w, 'straight', ['B', 'Ethernet0'], ['L2', 'GigabitEthernet1/0/3']);
    cable(w, 'crossover', ['C', 'Ethernet0'], ['P', 'GigabitEthernet0/0/0']);
    cable(w, isr ? 'serial' : 'straight', ['X', wan], ['P', peerWan], 'a');
    for (const [id, address, gateway] of [['A', A, LAN], ['B', B, LAN], ['C', C, RLAN]]) {
      const pc = getPc(w, id);
      Object.assign(pc.nic, { mode: 'static', address, gateway, mask: MASK });
      Object.assign(pc.services, { http: true, syslog: true });
    }
  }
  if (preset === 'linked' || preset === 'routed') {
    const l3 = isr ? [] : ['no switchport'];
    x(...(isr ? [] : ['ip routing']), `interface ${lan}`, ...l3, ip(LAN), 'no shutdown', 'exit',
      `interface ${wan}`, ...l3, ip(WAN), ...(isr ? ['clock rate 56000'] : []), 'no shutdown');
    p('interface GigabitEthernet0/0/0', ip(RLAN), 'no shutdown', 'exit', `interface ${peerWan}`, ip(PEER), 'no shutdown');
  }
  if (preset === 'routed') {
    x(`ip route 192.0.2.0 ${MASK} ${PEER}`);
    p(`ip route 192.168.40.0 ${MASK} ${WAN}`, `ip route 203.0.113.0 ${MASK} ${WAN}`);
  }
  return { w, model, isr, lan, wan, peerWan, ip, x, p, d: getIos(w, 'X') };
}
export type Bench = ReturnType<typeof fixture>;
