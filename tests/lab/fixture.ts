/**
 * Self-contained fixtures for the Lab tests: a small scenario (two routers, two PCs, four requirements, three guide steps),
 * a pre-built variant, an in-memory storage adapter and a tiny PC command prompt. Nothing here depends on
 * src/scenarios, src/engine/pc/cmd.ts or src/content.
 */
import assert from 'node:assert/strict';
import type {
  CheckResult, GuideStep, JournalEntry, PortRef, RequirementResult, RequirementView, ScenarioDef, ScenarioInstance,
  ScenarioSummary, SolutionView, World,
} from '../../src/engine/types.ts';
import type { ExecView, LabApi } from '../../src/engine/labapi.ts';
import type { LabOptions, LabStorage, PcRunner } from '../../src/engine/lab.ts';
import { Lab } from '../../src/engine/lab.ts';
import { cloneWorld, isIos, isPc } from '../../src/engine/world.ts';
import { dhcpAcquire, dhcpRelease, probeFlow, sendFlow } from '../../src/engine/sim/index.ts';

export const GI = 'GigabitEthernet0/0/0';
export const SE = 'Serial0/1/0';
export const port = (deviceId: string, name: string): PortRef => ({ deviceId, port: name });

export const R1_CONFIG = `hostname R1
interface GigabitEthernet0/0/0
 ip address 10.0.1.1 255.255.255.0
 no shutdown
interface Serial0/1/0
 ip address 10.0.12.1 255.255.255.252
 clock rate 128000
 no shutdown
ip route 10.0.2.0 255.255.255.0 10.0.12.2
logging 10.0.1.10
line vty 0 4
 password cisco
 login
end
`;
export const R2_CONFIG = `hostname R2
ip dhcp excluded-address 10.0.2.1
ip dhcp pool LAN2
 network 10.0.2.0 255.255.255.0
 default-router 10.0.2.1
interface GigabitEthernet0/0/0
 ip address 10.0.2.1 255.255.255.0
 no shutdown
interface Serial0/1/0
 ip address 10.0.12.2 255.255.255.252
 no shutdown
ip route 10.0.1.0 255.255.255.0 10.0.12.1
line vty 0 4
 password cisco
 login
end
`;

export const SOLUTION: SolutionView = {
  cables: [
    { kind: 'crossover', a: port('PC1', 'Ethernet0'), b: port('R1', GI) },
    { kind: 'serial', a: port('R1', SE), b: port('R2', SE), dceEnd: 'a' },
    { kind: 'crossover', a: port('R2', GI), b: port('PC2', 'Ethernet0') },
  ],
  configs: { R1: R1_CONFIG, R2: R2_CONFIG },
  pcs: {
    PC1: { mode: 'static', address: '10.0.1.10', mask: '255.255.255.0', gateway: '10.0.1.1', services: { syslog: true } },
    PC2: { mode: 'dhcp' },
  },
  notes: ['Any free ports work.'],
};

const REQUIREMENTS: RequirementView[] = [
  { id: 'req-cable', no: '1', title: 'PC1 is cabled to R1 and R1 to R2', feature: 'cabling', points: 2 },
  { id: 'req-lan', no: '2', title: 'PC1 reaches R1', feature: 'interface', points: 3 },
  { id: 'req-wan', no: '3', title: 'PC1 reaches R2', feature: 'routing', points: 4 },
  { id: 'req-name', no: '4', title: 'R1 is called R1', feature: 'system', points: 1 },
];
const GUIDE: GuideStep[] = [
  { id: 'cable', no: 1, title: 'Cable the bench', feature: 'cabling', devices: ['PC1', 'R1', 'R2', 'PC2'], goal: 'Connect PC1 to R1, R1 to R2 and R2 to PC2.', hint: 'PC to router needs a crossover cable.', allows: ['cabling'] },
  { id: 'r1', no: 2, title: 'Set up R1', feature: 'interface', devices: ['R1'], goal: 'Name the router and give its LAN port an address.', example: 'hostname R1', allows: ['system', 'interface'] },
  { id: 'route', no: 3, title: 'Reach R2', feature: 'routing', devices: ['R1', 'R2', 'PC1'], goal: 'PC1 can ping R2.', allows: ['system', 'interface', 'routing', 'pc'] },
];

function hasCable(w: World, a: PortRef, b: PortRef, kinds: string[]): boolean {
  const same = (x: PortRef, y: PortRef) => x.deviceId === y.deviceId && x.port === y.port;
  return w.cables.some((c) => kinds.includes(c.kind) && ((same(c.a, a) && same(c.b, b)) || (same(c.a, b) && same(c.b, a))));
}
function cabled(w: World): boolean {
  return hasCable(w, port('PC1', 'Ethernet0'), port('R1', GI), ['crossover', 'straight']) && hasCable(w, port('R1', SE), port('R2', SE), ['serial']);
}
function allCabled(w: World): boolean {
  return cabled(w) && hasCable(w, port('R2', GI), port('PC2', 'Ethernet0'), ['crossover', 'straight']);
}
function check(id: string, label: string, pass: boolean, expected: string, observed: string): CheckResult {
  return { id, label, pass, expected, observed };
}

export interface MiniOptions {
  id?: string;
  /** Pre-built bench: the model solution is already in place. */
  prebuilt?: boolean;
  /** A grader that (wrongly) changes the world it is given. */
  rudeGrader?: boolean;
  /** A grader / progress function that throws. */
  throwing?: boolean;
  /** Called every time the Lab asks for the guide progress (to count calls, to make the call look slow, to read the journal). */
  onProgress?: (world: World, journal: JournalEntry[]) => void;
  seedable?: boolean;
}

/** The fixture assignment. */
export function miniScenario(o: MiniOptions = {}): ScenarioDef {
  const summary: ScenarioSummary = {
    id: o.id ?? 'mini', title: o.prebuilt ? 'Mini lab (pre-built)' : 'Mini lab', family: o.prebuilt ? 'broken' : 'lab',
    features: ['cabling', 'interface', 'routing'], minutes: 20, level: 1, blurb: 'Two routers and two PCs.', seedable: !!o.seedable,
  };
  return {
    summary,
    build(seed: number): ScenarioInstance {
      return {
        summary,
        seed,
        brief: { intro: 'Connect PC1 to R2 through R1.', items: [{ no: '1', text: 'Cable the bench.', feature: 'cabling' }], given: [{ label: 'LAN1', value: '10.0.1.0/24' }] },
        diagram: { nodes: [{ id: 'R1', label: 'R1', kind: 'router', x: 300, y: 200 }], links: [] },
        bench: [
          { id: 'R1', model: 'isr4331', label: 'R1', x: 300, y: 200 },
          { id: 'R2', model: 'isr4331', label: 'R2', x: 600, y: 200 },
          { id: 'PC1', model: 'pc-windows', label: 'PC1', x: 100, y: 400 },
          { id: 'PC2', model: 'pc-windows', label: 'PC2', x: 700, y: 400 },
        ],
        initial: o.prebuilt ? { cables: SOLUTION.cables, configs: SOLUTION.configs, pcs: SOLUTION.pcs } : undefined,
        requirements: REQUIREMENTS,
        guide: GUIDE,
        solution: SOLUTION,
        hardwareNotes: [{ id: 'hw-1', feature: 'interface', title: 'Clock rate', text: 'A real DCE cable needs clock rate.' }],
        grade(world: World, journal: JournalEntry[]) {
          if (o.throwing) throw new Error('grader exploded');
          if (o.rudeGrader) { world.tick += 1000; world.cables.length = 0; }
          const w = cloneWorld(world);
          const r1 = w.devices.R1;
          const lan = probeFlow(w, { fromDeviceId: 'PC1', dst: '10.0.1.1', proto: 'icmp' });
          const wan = probeFlow(w, { fromDeviceId: 'PC1', dst: '10.0.12.2', proto: 'icmp' });
          const named = isIos(r1) && r1.config.hostname === 'R1';
          const res = (id: string, pass: boolean, c: CheckResult): RequirementResult => {
            const v = REQUIREMENTS.find((r) => r.id === id)!;
            return { ...v, earned: pass ? v.points : 0, pass, checks: [c] };
          };
          return {
            requirements: [
              res('req-cable', cabled(w), check('c1', 'Cables', cabled(w), 'both cables', cabled(w) ? 'both cables' : 'missing')),
              res('req-lan', lan.ok, check('c2', 'PC1 ping R1', lan.ok, 'reply', lan.summary)),
              res('req-wan', wan.ok, check('c3', 'PC1 ping R2', wan.ok, 'reply', wan.summary)),
              res('req-name', named, check('c4', 'Hostname', named, 'R1', isIos(r1) ? r1.config.hostname : '?')),
            ],
            orderIssues: journal.some((e) => e.blocked) ? [{ tick: 0, text: 'An action was stopped by the guide.', severity: 'info' as const }] : [],
          };
        },
        guideProgress(world: World, journal: JournalEntry[]) {
          if (o.throwing) throw new Error('progress exploded');
          o.onProgress?.(world, journal);
          const r1 = world.devices.R1;
          const gi = isIos(r1) ? r1.config.interfaces[GI] : undefined;
          const r1Done = isIos(r1) && r1.config.hostname === 'R1' && gi?.ip?.address === '10.0.1.1' && gi.shutdown === false;
          return {
            cable: allCabled(world),
            r1: r1Done,
            route: probeFlow(world, { fromDeviceId: 'PC1', dst: '10.0.12.2', proto: 'icmp' }).ok,
          };
        },
      };
    },
  };
}

// ───────────────────────────── storage ─────────────────────────────
export class MemoryStorage implements LabStorage {
  data = new Map<string, string>();
  /** Make every call throw (a sandbox that forbids storage). */
  broken = false;
  /** Make writes throw (quota exceeded). */
  full = false;
  /** Total characters the storage can hold (like the 5 MB of a browser). */
  quota = Infinity;
  writes = 0;
  getItem(key: string): string | null { if (this.broken) throw new Error('storage denied'); return this.data.has(key) ? this.data.get(key)! : null; }
  setItem(key: string, value: string): void {
    if (this.broken || this.full) throw new Error('storage denied');
    let used = 0;
    for (const [k, v] of this.data) if (k !== key) used += k.length + v.length;
    if (used + key.length + value.length > this.quota) throw new Error('QuotaExceededError');
    this.writes++;
    this.data.set(key, value);
  }
  removeItem(key: string): void { if (this.broken) throw new Error('storage denied'); this.data.delete(key); }
  keys(): string[] { if (this.broken) throw new Error('storage denied'); return [...this.data.keys()]; }
}

// ───────────────────────────── a tiny PC command prompt ─────────────────────────────
export const fakePc: PcRunner = (world, pcId, line) => {
  const [cmd, arg] = line.trim().split(/\s+/);
  const pc = world.devices[pcId];
  if (cmd === 'cls') return { output: '', clear: true };
  if (cmd === 'ipconfig' && arg === '/renew') {
    const r = dhcpAcquire(world, pcId);
    return { output: r.ok ? `IPv4 Address: ${r.address}\n` : `No DHCP server. ${r.reasonText ?? ''}\n` };
  }
  if (cmd === 'ipconfig' && arg === '/release') { dhcpRelease(world, pcId); return { output: 'Address released.\n' }; }
  if (cmd === 'ipconfig') return { output: `IPv4 Address: ${isPc(pc) ? pc.nic.address ?? '' : ''}\n` };
  if (cmd === 'ping') {
    const r = sendFlow(world, { fromDeviceId: pcId, dst: arg ?? '', proto: 'icmp' });
    return r.ok ? { output: `Reply from ${arg}\n` } : { output: 'Request timed out.\n', delayMs: 2000 };
  }
  if (cmd === 'telnet') {
    const r = sendFlow(world, { fromDeviceId: pcId, dst: arg ?? '', proto: 'tcp', dport: 23 });
    if (r.ok && r.vty?.accepted && r.forward.atDeviceId) {
      return { output: `Trying ${arg} ... Open\n`, telnet: { deviceId: r.forward.atDeviceId, remoteAddr: r.forward.received?.src ?? '', host: arg, port: 23 } };
    }
    return { output: `Connecting To ${arg}...Could not open connection to the host, on port 23: Connect failed\n`, delayMs: 2000 };
  }
  // "setip <address> <mask>": a command that changes the adapter settings (like netsh / networksetup on a real PC)
  if (cmd === 'setip' && isPc(pc)) {
    pc.nic = { mode: 'static', mac: pc.nic.mac, address: arg, mask: line.trim().split(/\s+/)[2] ?? '255.255.255.0' };
    return { output: 'Ok.\n' };
  }
  if (cmd === 'boom') throw new Error('boom');
  return { output: `'${cmd}' is not recognized as an internal or external command.\n` };
};

// ───────────────────────────── lab helpers ─────────────────────────────
export interface Harness {
  lab: Lab;
  storage: MemoryStorage;
  /** The injected wall clock; move it with clock.t += … */
  clock: { t: number };
}
export function makeLab(opts: Partial<LabOptions> & { scenario?: MiniOptions } = {}): Harness {
  const storage = new MemoryStorage();
  const clock = { t: 1_700_000_000_000 };
  const lab = new Lab({
    scenarios: opts.scenarios ?? [miniScenario(opts.scenario), miniScenario({ id: 'mini-prebuilt', prebuilt: true })],
    storage: opts.storage === undefined ? storage : opts.storage,
    now: opts.now ?? (() => clock.t),
    pcExec: opts.pcExec ?? fakePc,
  });
  return { lab, storage, clock };
}

export function world(lab: LabApi): World {
  const w = lab.getState().world;
  assert.ok(w, 'a lab is open');
  return w;
}
export function ok<T extends { ok: boolean; message?: string }>(r: T, what = 'action'): T {
  assert.equal(r.ok, true, `${what} failed: ${r.message ?? ''}`);
  return r;
}
export function cableId(lab: LabApi, ref: PortRef): string {
  const id = lab.portStatus(ref).cableId;
  assert.ok(id, `no cable at ${ref.deviceId} ${ref.port}`);
  return id;
}

/** Plug the three network cables of the model solution. */
export function cableBench(lab: LabApi): void {
  for (const c of SOLUTION.cables) ok(lab.connectCable(c.kind, c.a, c.b, { dceEnd: c.dceEnd }), `cable ${c.a.deviceId}–${c.b.deviceId}`);
}
/** Console cable from a PC to a device (moving it when it is plugged in somewhere else). */
export function plugConsole(lab: LabApi, pcId: string, deviceId: string): void {
  const old = lab.portStatus(port(pcId, 'COM1')).cableId;
  if (old) ok(lab.removeCable(old), 'unplug console');
  ok(lab.connectCable('console', port(pcId, 'COM1'), port(deviceId, 'Console')), 'plug console');
}
/** Open the console and return the session id. */
export function openConsole(lab: LabApi, deviceId: string): string {
  const r = lab.openConsole(deviceId);
  assert.equal(r.ok, true, r.ok ? '' : r.message);
  return r.ok ? r.session.id : '';
}
/** Type lines one after another; returns the views. */
export function type(lab: LabApi, sessionId: string, lines: string[]): ExecView[] {
  return lines.map((l) => lab.sessionExec(sessionId, l));
}
/** Console on a factory-fresh device, through the initial dialog into configuration mode. */
export function consoleToConfig(lab: LabApi, pcId: string, deviceId: string): string {
  plugConsole(lab, pcId, deviceId);
  const id = openConsole(lab, deviceId);
  const first = lab.getState().sessions.find((s) => s.id === id);
  if (first && /initial configuration dialog/.test(first.prompt)) type(lab, id, ['no', '']);
  type(lab, id, ['enable', 'configure terminal']);
  return id;
}
/** Type a whole configuration (config-file text) line by line in configuration mode. Returns the lines IOS refused. */
export function typeConfig(lab: LabApi, sessionId: string, text: string): string[] {
  const refused: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('!')) continue;
    const v = lab.sessionExec(sessionId, line);
    if (v.blocked || /^%|\n%/.test(v.output)) refused.push(`${line} → ${v.blocked ? v.blocked.reason : v.output.trim()}`);
  }
  return refused;
}
/** The whole model solution through LabApi: cables, both routers typed on the console, PCs. */
export function buildSolution(lab: LabApi): void {
  cableBench(lab);
  for (const dev of ['R1', 'R2']) {
    const id = consoleToConfig(lab, 'PC1', dev);
    assert.deepEqual(typeConfig(lab, id, SOLUTION.configs[dev]), [], `${dev} accepts its configuration`);
  }
  ok(lab.setPcNic('PC1', { mode: 'static', address: '10.0.1.10', mask: '255.255.255.0', gateway: '10.0.1.1' }), 'PC1 static');
  lab.setPcService('PC1', 'syslog', true);
  ok(lab.setPcNic('PC2', { mode: 'dhcp' }), 'PC2 dhcp');
}
