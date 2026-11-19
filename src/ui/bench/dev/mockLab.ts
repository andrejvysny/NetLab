/**
 * DEV ONLY. A small stand-in for the real Lab so the workbench can be exercised on its own (bench.html).
 * Real world objects (createWorld/addDevice), real cables and console-cable checks, a fake CLI and fake PC commands.
 * It deliberately mutates the world in place and hands out a fresh state object per change, like the worst-case real lab.
 */
import type {
  ActionResult, ApplyReport, CommandSheetSection, ExecView, GuideBlock, LabApi, LabState, OpenSessionResult, PcExecView,
  PortStatus, QosLoadResult, SessionView, SnmpReply, SnmpRequest, UiSettings,
} from '../../../engine/labapi.ts';
import type {
  Cable, CableKind, FlowResult, GradeReport, IosDevice, LabMode, PcDevice, PcServices, PortRef, ScenarioSummary, SolutionView, World,
} from '../../../engine/types.ts';
import { addDevice, createWorld } from '../../../engine/world.ts';

type Mode = 'setup' | 'user' | 'priv' | 'config' | 'config-if' | 'config-line';
interface MockSession {
  view: SessionView;
  mode: Mode;
  iface?: string;
  history: string[];
  pending?: 'enable' | 'vty-login';
}
export interface MockControls {
  setMode(mode: LabMode): void;
  /** Guided mode: the next state-changing action is refused with a GuideBlock. */
  blockNext(on: boolean): void;
  injectSyslog(pcId: string): void;
  injectTrap(pcId: string): void;
  cableReference(): void;
  dropSession(deviceId: string): void;
}

const SUMMARY: ScenarioSummary = {
  id: 'mock', title: 'Workbench test bench', family: 'mock', features: ['cabling', 'console'], minutes: 30, level: 1,
  blurb: 'Mock lab for the workbench harness.', seedable: false,
};
const BLOCK: GuideBlock = {
  stepId: 'step-2', stepNo: 2, stepTitle: 'Cable the LAN first',
  reason: 'You tried to change something that belongs to a later step. Finish step 2 first: connect PC1 and PC2 to SW1 with straight-through cables.',
};

export function createMockLab(): { lab: LabApi; controls: MockControls } {
  const world: World = createWorld();
  addDevice(world, { id: 'pc1', model: 'pc-windows', label: 'PC1', x: 170, y: 130 });
  addDevice(world, { id: 'pc2', model: 'pc-windows', label: 'PC2', x: 430, y: 130 });
  addDevice(world, { id: 'pc3', model: 'pc-macos', label: 'PC3', x: 1190, y: 130 });
  addDevice(world, { id: 'sw1', model: 'c9300l', label: 'SW1', x: 350, y: 400 });
  addDevice(world, { id: 'sw2', model: 'c9300l', label: 'SW2', x: 1040, y: 400 });
  addDevice(world, { id: 'r1', model: 'isr4331', label: 'R1', x: 420, y: 670 });
  addDevice(world, { id: 'r2', model: 'isr4331', label: 'R2', x: 980, y: 670 });

  let mode: LabMode = 'guided';
  let blockNext = false;
  const settings: UiSettings = { ...world.settings, fontScale: 1, font: 'lexend', terminalFontPx: 14, terminalPaging: true, reduceMotion: false };
  const sessions = new Map<string, MockSession>();
  const listeners = new Set<() => void>();
  const startedAt = Date.now();
  let rev = 1;
  let state: LabState;

  const build = (): LabState => ({
    rev,
    scenario: {
      summary: SUMMARY, seed: 1, mode, brief: { intro: 'Mock', items: [] }, diagram: { nodes: [], links: [] }, requirements: [],
      guide: [], startedAt, timerMinutes: null, finished: false, hintsUsed: 0,
    },
    world,
    sessions: [...sessions.values()].map((s) => s.view),
    journal: [],
    report: null,
    settings: { ...settings },
    storage: { available: false, saved: [] },
  });
  state = build();
  const changed = () => { rev++; world.tick++; state = build(); for (const l of [...listeners]) l(); };

  const ios = (id: string): IosDevice | undefined => { const d = world.devices[id]; return d && d.kind !== 'pc' ? d : undefined; };
  const pc = (id: string): PcDevice | undefined => { const d = world.devices[id]; return d && d.kind === 'pc' ? d : undefined; };
  const same = (a: PortRef, b: PortRef) => a.deviceId === b.deviceId && a.port === b.port;
  const cableAt = (ref: PortRef): Cable | undefined => world.cables.find((c) => same(c.a, ref) || same(c.b, ref));
  const specOf = (ref: PortRef) => world.devices[ref.deviceId]?.ports.find((p) => p.name === ref.port);
  const far = (c: Cable, ref: PortRef) => (same(c.a, ref) ? c.b : c.a);
  const gate = (): GuideBlock | undefined => { if (mode === 'guided' && blockNext) { blockNext = false; return BLOCK; } return undefined; };

  // ───────── link state ─────────
  const ifUp = (ref: PortRef): boolean => {
    const d = ios(ref.deviceId);
    if (!d) return true;
    return d.config.interfaces[ref.port]?.shutdown !== true;
  };
  const linkOf = (ref: PortRef): { cable?: Cable; usable: boolean; problem?: string } => {
    const cable = cableAt(ref);
    if (!cable) return { usable: false };
    const a = specOf(cable.a);
    const b = specOf(cable.b);
    if (!a || !b) return { cable, usable: false };
    const kinds = [a.kind, b.kind].sort().join('+');
    if (cable.kind === 'console') {
      return kinds === 'console+rs232' ? { cable, usable: true } : { cable, usable: false, problem: 'A console cable only works between a PC serial port and a CON port.' };
    }
    if (cable.kind === 'serial') return { cable, usable: true };
    if (kinds !== 'ethernet+ethernet') return { cable, usable: false, problem: 'An Ethernet cable gives no link in a console port.' };
    const mdix = (r: PortRef) => world.devices[r.deviceId]?.kind === 'switch';
    const need: CableKind = mdix(cable.a) === mdix(cable.b) ? 'crossover' : 'straight';
    if (settings.strictCables && cable.kind !== need) {
      return { cable, usable: false, problem: `These two ports need an Ethernet ${need === 'straight' ? 'straight-through' : 'crossover'} cable.` };
    }
    return { cable, usable: true };
  };
  const portStatus = (ref: PortRef): PortStatus => {
    const spec = specOf(ref);
    const kind = spec?.kind ?? 'ethernet';
    const link = linkOf(ref);
    if (!link.cable) {
      const st = ios(ref.deviceId) && (kind === 'ethernet' || kind === 'serial') ? (ifUp(ref) ? 'down/down' : 'administratively down/down') : undefined;
      return { ref, kind, led: 'off', status: st };
    }
    const c = link.cable;
    const other = far(c, ref);
    const base = { ref, kind, cableId: c.id, cableKind: c.kind, dce: c.kind === 'serial' ? same(c[c.dceEnd ?? 'a'], ref) : undefined };
    if (c.kind === 'console') return { ...base, led: link.usable ? 'green' : 'amber', problem: mode === 'exam' ? undefined : link.problem };
    if (!link.usable) return { ...base, led: 'amber', status: ifUp(ref) ? 'down/down' : 'administratively down/down', problem: mode === 'exam' ? undefined : link.problem };
    if (!ifUp(ref)) return { ...base, led: 'amber', status: 'administratively down/down', problem: mode === 'exam' ? undefined : 'This interface is shut down. Open the interface and type: no shutdown' };
    if (!ifUp(other)) return { ...base, led: 'amber', status: 'down/down', problem: mode === 'exam' ? undefined : `The port at the other end (${world.devices[other.deviceId]?.label}) is shut down.` };
    return { ...base, led: 'green', status: 'up/up' };
  };

  // ───────── cables ─────────
  const connectCable = (kind: CableKind, a: PortRef, b: PortRef, opts?: { dceEnd?: 'a' | 'b' }): ActionResult => {
    const sa = specOf(a);
    const sb = specOf(b);
    if (!sa || !sb) return { ok: false, message: 'That port does not exist.' };
    if (same(a, b)) return { ok: false, message: 'A cable needs two different ports.' };
    if (cableAt(a)) return { ok: false, message: `${world.devices[a.deviceId].label} ${sa.short} already has a cable. Unplug it first.` };
    if (cableAt(b)) return { ok: false, message: `${world.devices[b.deviceId].label} ${sb.short} already has a cable. Unplug it first.` };
    const rj = (k: string) => k === 'ethernet' || k === 'console';
    if (kind === 'serial' && (sa.kind !== 'serial' || sb.kind !== 'serial')) return { ok: false, message: 'A serial cable only fits serial ports (Se…).' };
    if ((kind === 'straight' || kind === 'crossover') && (!rj(sa.kind) || !rj(sb.kind))) return { ok: false, message: 'An Ethernet plug (RJ-45) does not fit this port.' };
    if (kind === 'console') {
      const pcEnds = (sa.kind === 'rs232' ? 1 : 0) + (sb.kind === 'rs232' ? 1 : 0);
      if (pcEnds !== 1) return { ok: false, message: 'A console cable goes from a PC serial port (COM1) to an RJ-45 port.' };
      if (!rj(sa.kind) && !rj(sb.kind)) return { ok: false, message: 'The RJ-45 end of the console cable does not fit this port.' };
    }
    const blocked = gate();
    if (blocked) return { ok: false, blocked };
    world.cables.push({ id: `c${world.nextId++}`, kind, a, b, dceEnd: kind === 'serial' ? opts?.dceEnd ?? 'a' : undefined });
    changed();
    return { ok: true };
  };
  const removeCable = (id: string): ActionResult => {
    const i = world.cables.findIndex((c) => c.id === id);
    if (i < 0) return { ok: false, message: 'That cable is not on the bench.' };
    const blocked = gate();
    if (blocked) return { ok: false, blocked };
    world.cables.splice(i, 1);
    changed();
    return { ok: true };
  };
  const consolePcOf = (deviceId: string): string | null => {
    const d = ios(deviceId);
    if (!d) return null;
    const c = cableAt({ deviceId, port: 'Console' });
    if (!c || c.kind !== 'console') return null;
    const o = far(c, { deviceId, port: 'Console' });
    return specOf(o)?.kind === 'rs232' ? o.deviceId : null;
  };
  const consoleTargetOf = (pcId: string): string | null => {
    const d = pc(pcId);
    if (!d) return null;
    const c = cableAt({ deviceId: pcId, port: 'COM1' });
    if (!c || c.kind !== 'console') return null;
    const o = far(c, { deviceId: pcId, port: 'COM1' });
    return specOf(o)?.kind === 'console' ? o.deviceId : null;
  };

  // ───────── fake CLI ─────────
  const promptOf = (s: MockSession): string => {
    const d = ios(s.view.deviceId);
    const h = d?.config.hostname ?? 'Router';
    if (s.view.closed) return '';
    if (s.pending) return 'Password: ';
    switch (s.mode) {
      case 'setup': return 'Would you like to enter the initial configuration dialog? [yes/no]: ';
      case 'user': return `${h}>`;
      case 'priv': return `${h}#`;
      case 'config': return `${h}(config)#`;
      case 'config-if': return `${h}(config-if)#`;
      case 'config-line': return `${h}(config-line)#`;
    }
  };
  const WORDS: Record<Mode, [string, string][]> = {
    setup: [],
    user: [['enable', 'Turn on privileged commands'], ['exit', 'Exit from the EXEC'], ['ping', 'Send echo messages'], ['show', 'Show running system information']],
    priv: [
      ['configure', 'Enter configuration mode'], ['copy', 'Copy from one file to another'], ['disable', 'Turn off privileged commands'],
      ['exit', 'Exit from the EXEC'], ['ping', 'Send echo messages'], ['reload', 'Halt and perform a cold restart'],
      ['show', 'Show running system information'], ['terminal', 'Set terminal line parameters'],
    ],
    config: [
      ['enable', 'Modify enable password parameters'], ['end', 'Exit from configure mode'], ['exit', 'Exit from configure mode'],
      ['hostname', "Set system's network name"], ['interface', 'Select an interface to configure'], ['ip', 'Global IP configuration subcommands'],
      ['line', 'Configure a terminal line'], ['no', 'Negate a command or set its defaults'],
    ],
    'config-if': [
      ['clock', 'Configure serial interface clock'], ['description', 'Interface specific description'], ['end', 'Exit from configure mode'],
      ['exit', 'Exit from interface configuration mode'], ['ip', 'Interface Internet Protocol config commands'],
      ['no', 'Negate a command or set its defaults'], ['shutdown', 'Shutdown the selected interface'],
    ],
    'config-line': [['end', 'Exit from configure mode'], ['exit', 'Exit from line configuration mode'], ['login', 'Enable password checking'], ['password', 'Set a password']],
  };
  const SHOW: [string, string][] = [['ip', 'IP information'], ['running-config', 'Current operating configuration'], ['version', 'System hardware and software status']];
  const is = (tok: string | undefined, word: string, min = 1) => !!tok && tok.length >= min && word.startsWith(tok.toLowerCase());
  const running = (d: IosDevice): string => {
    const out: string[] = ['Building configuration...', '', 'Current configuration : 1432 bytes', '!', 'version 17.3', 'service timestamps debug datetime msec', 'service timestamps log datetime msec', '!', `hostname ${d.config.hostname}`, '!'];
    if (d.config.enableSecret) out.push(`enable secret 9 ${'$9$'}mock`, '!');
    if (!d.config.ipDomainLookup) out.push('no ip domain-lookup', '!');
    for (const name of Object.keys(d.config.interfaces)) {
      const i = d.config.interfaces[name];
      out.push(`interface ${name}`);
      if (i.description) out.push(` description ${i.description}`);
      if (i.ip) out.push(` ip address ${i.ip.address} ${i.ip.mask}`); else if (d.kind === 'router') out.push(' no ip address');
      if (i.clockRate) out.push(` clock rate ${i.clockRate}`);
      if (i.shutdown) out.push(' shutdown');
      out.push('!');
    }
    for (const l of d.config.extraLines) out.push(l);
    out.push('line con 0', ' stopbits 1', 'line vty 0 4', ' login', '!', 'end');
    return out.join('\n') + '\n';
  };
  const ifName = (text: string, d: IosDevice): string | null => {
    const m = /^([a-z]+)\s*([\d/]+)$/i.exec(text.trim());
    if (!m) return null;
    const type = m[1].toLowerCase();
    const full = 'gigabitethernet'.startsWith(type) ? 'GigabitEthernet' : 'serial'.startsWith(type) ? 'Serial' : 'loopback'.startsWith(type) ? 'Loopback' : null;
    if (!full) return null;
    const name = full + m[2];
    if (full === 'Loopback' && !d.config.interfaces[name]) d.config.interfaces[name] = { name, shutdown: false };
    return d.config.interfaces[name] ? name : null;
  };

  const runLine = (s: MockSession, raw: string, viaFile = false): ExecView => {
    const d = ios(s.view.deviceId)!;
    let output = '';
    const notes: string[] = [];
    let delayMs: number | undefined;
    const done = (extra: Partial<ExecView> = {}): ExecView => {
      s.view = { ...s.view, prompt: promptOf(s), secret: !!s.pending };
      return { output, prompt: s.view.prompt, secret: s.view.secret, closed: s.view.closed, delayMs, notes, ...extra };
    };
    const invalid = () => { output += `${' '.repeat(promptOf(s).length)}^\n% Invalid input detected at '^' marker.\n`; };
    if (s.view.closed) return done();
    if (s.pending) {
      const what = s.pending;
      s.pending = undefined;
      if (what === 'enable') { if (raw === d.config.enableSecret) s.mode = 'priv'; else output += '% Bad secrets\n'; }
      else if (raw === 'cisco') s.mode = 'user'; else { output += '% Bad passwords\n'; s.view = { ...s.view, closed: true }; }
      return done();
    }
    if (s.mode === 'setup') {
      if (/^n/i.test(raw.trim())) { s.mode = 'user'; d.runtime.setupDialogDone = true; output += '\n\nPress RETURN to get started!\n\n'; }
      else if (raw.trim()) output += "% Please answer 'yes' or 'no'.\n";
      return done();
    }
    const line = raw.trim();
    if (!line || line.startsWith('!')) return done();
    if (!viaFile) s.history.push(line);
    const t = line.split(/\s+/);
    const cfg = s.mode === 'config' || s.mode === 'config-if' || s.mode === 'config-line';
    if (cfg && !is(t[0], 'exit', 2) && !is(t[0], 'end', 2) && !is(t[0], 'interface', 3) && !is(t[0], 'line', 2) && !is(t[0], 'do', 2)) {
      const blocked = gate();
      if (blocked) return done({ blocked });
    }
    if (is(t[0], 'do', 2) && cfg) {
      const keep = { mode: s.mode, iface: s.iface };
      s.mode = 'priv';
      const v = runLine(s, t.slice(1).join(' '), true);
      s.mode = keep.mode; s.iface = keep.iface;
      return { ...v, prompt: promptOf(s) };
    }
    if (s.mode === 'user' || s.mode === 'priv') {
      if (is(t[0], 'enable', 2)) { if (d.config.enableSecret && s.mode === 'user') s.pending = 'enable'; else s.mode = 'priv'; }
      else if (is(t[0], 'disable', 2) && s.mode === 'priv') s.mode = 'user';
      else if (is(t[0], 'exit', 2) || is(t[0], 'logout', 3) || is(t[0], 'quit', 1)) {
        s.view = { ...s.view, closed: true };
        output += s.view.kind === 'telnet' ? '' : `\n${d.config.hostname} con0 is now available\n\nPress RETURN to get started.\n`;
      } else if (is(t[0], 'configure', 4) && s.mode === 'priv') { s.mode = 'config'; output += 'Enter configuration commands, one per line.  End with CNTL/Z.\n'; }
      else if (is(t[0], 'terminal', 2) && s.mode === 'priv') { /* accepted */ }
      else if (is(t[0], 'copy', 3) && s.mode === 'priv') { d.startupConfig = running(d); output += 'Destination filename [startup-config]? \nBuilding configuration...\n[OK]\n'; }
      else if (is(t[0], 'reload', 3) && s.mode === 'priv') { s.view = { ...s.view, closed: true }; output += 'Proceed with reload? [confirm]\n\n*Mar  1 00:10:12.003: %SYS-5-RELOAD: Reload requested by console.\n'; }
      else if (is(t[0], 'ping', 2)) {
        output += `Type escape sequence to abort.\nSending 5, 100-byte ICMP Echos to ${t[1] ?? '?'}, timeout is 2 seconds:\n.....\nSuccess rate is 0 percent (0/5)\n`;
        delayMs = 4000;
      } else if (is(t[0], 'show', 2)) {
        if (is(t[1], 'running-config', 1)) {
          if (s.mode !== 'priv') invalid(); else output += running(d);
        } else if (is(t[1], 'version', 1)) {
          output += Array.from({ length: 58 }, (_, i) => (i === 0 ? 'Cisco IOS XE Software, Version 17.03.04a' : `  line ${i + 1} of the version text — Cisco ${d.kind === 'router' ? 'ISR4331/K9' : 'C9300L-24T-4G'} processor with 1795979K/6147K bytes of memory.`)).join('\n') + '\n';
        } else if (t[1] === 'flood') {
          // dev only: a very long output to test scrolling
          output += Array.from({ length: Number(t[2]) || 3000 }, (_, i) => `%FLOOD-6-LINE: line ${i + 1} of a very long output, with enough text to wrap in a narrow terminal window`).join('\n') + '\n';
        } else if (is(t[1], 'ip', 2)) {
          output += 'Interface              IP-Address      OK? Method Status                Protocol\n';
          for (const name of Object.keys(d.config.interfaces)) {
            const st = portStatus({ deviceId: d.id, port: name }).status ?? (d.config.interfaces[name].shutdown ? 'administratively down/down' : 'up/up');
            const [a, b] = st.split('/');
            output += `${name.padEnd(23)}${(d.config.interfaces[name].ip?.address ?? 'unassigned').padEnd(16)}YES ${d.config.interfaces[name].ip ? 'manual' : 'unset '} ${a.padEnd(22)}${b}\n`;
          }
        } else if (!t[1]) output += '% Incomplete command.\n';
        else invalid();
      } else if (t.length === 1 && /^[a-z][\w.-]*$/i.test(t[0])) {
        if (d.config.ipDomainLookup) { output += `Translating "${t[0]}"...domain server (255.255.255.255)\n`; delayMs = 6000; }
        output += '% Unknown command or computer name, or unable to find computer address\n';
      } else invalid();
      return done();
    }
    // configuration modes
    if (is(t[0], 'end', 2)) { s.mode = 'priv'; s.iface = undefined; return done(); }
    if (is(t[0], 'exit', 2)) { if (s.mode === 'config') s.mode = 'priv'; else s.mode = 'config'; s.iface = undefined; return done(); }
    if (is(t[0], 'interface', 3)) {
      const name = ifName(t.slice(1).join(' '), d);
      if (!name) invalid(); else { s.mode = 'config-if'; s.iface = name; }
      return done();
    }
    if (is(t[0], 'line', 2)) { s.mode = 'config-line'; return done(); }
    if (s.mode === 'config') {
      if (is(t[0], 'hostname', 1)) { if (!t[1]) output += '% Incomplete command.\n'; else d.config.hostname = t[1]; }
      else if (is(t[0], 'enable', 2) && is(t[1], 'secret', 1) && t[2]) d.config.enableSecret = t[2];
      else if (line === 'no ip domain-lookup' || line === 'no ip domain lookup') d.config.ipDomainLookup = false;
      else if (/^(ip|no|access-list|crypto|class-map|policy-map|snmp-server|logging|router|banner|service)\b/.test(line)) {
        d.config.extraLines.push(line);
        notes.push('Accepted, but not simulated by this test bench.');
      } else invalid();
      return done();
    }
    if (s.mode === 'config-if' && s.iface) {
      const i = d.config.interfaces[s.iface];
      if (is(t[0], 'shutdown', 2)) i.shutdown = true;
      else if (line === 'no shutdown' || line === 'no shut' || line === 'no sh') {
        i.shutdown = false;
        output += `*Mar  1 00:04:11.211: %LINK-3-UPDOWN: Interface ${s.iface}, changed state to ${portStatus({ deviceId: d.id, port: s.iface }).led === 'green' ? 'up' : 'down'}\n`;
      } else if (is(t[0], 'ip', 2) && is(t[1], 'address', 2)) {
        if (!t[2] || !t[3]) output += '% Incomplete command.\n';
        else if (!/^\d+\.\d+\.\d+\.\d+$/.test(t[2]) || !/^\d+\.\d+\.\d+\.\d+$/.test(t[3])) invalid();
        else i.ip = { address: t[2], mask: t[3] };
      } else if (is(t[0], 'description', 3)) i.description = t.slice(1).join(' ');
      else if (is(t[0], 'clock', 2) && is(t[1], 'rate', 1)) {
        const st = portStatus({ deviceId: d.id, port: s.iface });
        if (!st.dce) output += '%Error: This command applies only to DCE interfaces\n'; else i.clockRate = Number(t[2]) || 64000;
      } else invalid();
      return done();
    }
    if (s.mode === 'config-line') {
      if (is(t[0], 'password', 2) || is(t[0], 'login', 3)) notes.push('Accepted, but not simulated by this test bench.');
      else invalid();
      return done();
    }
    invalid();
    return done();
  };
  const open = (deviceId: string, kind: 'console' | 'telnet', pcId: string, title: string): MockSession => {
    const d = ios(deviceId)!;
    const s: MockSession = {
      view: { id: `s${world.nextId++}`, deviceId, kind, pcId, title, prompt: '', secret: false, closed: false },
      mode: kind === 'console' && !d.runtime.setupDialogDone ? 'setup' : 'user', history: [],
      pending: kind === 'telnet' ? 'vty-login' : undefined,
    };
    s.view.prompt = promptOf(s);
    s.view.secret = !!s.pending;
    sessions.set(s.view.id, s);
    return s;
  };

  // ───────── PC commands ─────────
  const pcExec = (pcId: string, raw: string): PcExecView => {
    const p = pc(pcId);
    if (!p) return { output: '' };
    const line = raw.trim();
    const t = line.split(/\s+/);
    const cmd = (t[0] ?? '').toLowerCase();
    if (!line) return { output: '' };
    if (cmd === 'cls' || cmd === 'clear') return { output: '', clear: true };
    if (cmd === 'ipconfig' || cmd === 'ifconfig') {
      return {
        output: `\nWindows IP Configuration\n\nEthernet adapter Ethernet0:\n\n   Connection-specific DNS Suffix  . :\n   IPv4 Address. . . . . . . . . . . : ${p.nic.address ?? ''}\n   Subnet Mask . . . . . . . . . . . : ${p.nic.mask ?? ''}\n   Default Gateway . . . . . . . . . : ${p.nic.gateway ?? ''}\n\n`,
      };
    }
    if (cmd === 'ping') {
      const dst = t[1] ?? '';
      if (!dst) return { output: 'Usage: ping target_name\n\n' };
      const ok = !!p.nic.address && linkOf({ deviceId: pcId, port: 'Ethernet0' }).usable;
      const rows = Array.from({ length: 4 }, () => (ok ? `Reply from ${dst}: bytes=32 time<1ms TTL=254` : 'Request timed out.')).join('\n');
      changed();
      return { output: `\nPinging ${dst} with 32 bytes of data:\n${rows}\n\nPing statistics for ${dst}:\n    Packets: Sent = 4, Received = ${ok ? 4 : 0}, Lost = ${ok ? 0 : 4} (${ok ? 0 : 100}% loss),\n\n`, delayMs: ok ? 600 : 3000 };
    }
    if (cmd === 'telnet') {
      const dst = t[1] ?? '';
      const target = dst === '192.168.100.1' ? 'r1' : dst === '60.50.30.2' ? 'r2' : null;
      if (!target || !p.nic.address) return { output: `Connecting To ${dst}...Could not open connection to the host, on port 23: Connect failed\n\n`, delayMs: 2500 };
      const s = open(target, 'telnet', pcId, `Telnet ${dst} (from ${p.label})`);
      changed();
      return { output: '', session: s.view, banner: `Trying ${dst} ... Open\n\n\nUser Access Verification\n\n` };
    }
    if (cmd === 'help') return { output: 'Commands in this test bench: ipconfig, ping <address>, telnet <address>, cls\nTelnet works to 192.168.100.1 (R1) and 60.50.30.2 (R2). Password: cisco\n\n' };
    return { output: `'${t[0]}' is not recognized as an internal or external command,\noperable program or batch file.\n\n` };
  };

  const notReady = <T>(v: T): T => v;
  const lab: LabApi = {
    getState: () => state,
    subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    listScenarios: () => [SUMMARY],
    startScenario: () => ({ ok: true }),
    restartScenario: () => undefined,
    leaveScenario: () => undefined,

    moveDevice: (id, x, y) => { const d = world.devices[id]; if (!d) return; d.x = x; d.y = y; changed(); },
    connectCable,
    removeCable,
    portStatus,
    consoleTargetOf,
    consolePcOf,
    openConsole: (deviceId): OpenSessionResult => {
      const d = ios(deviceId);
      if (!d) return { ok: false, message: 'This device has no console.' };
      const pcId = consolePcOf(deviceId);
      if (!pcId) return { ok: false, message: `No console cable is plugged into the CON port of ${d.label}.` };
      const existing = [...sessions.values()].find((s) => s.view.deviceId === deviceId && s.view.kind === 'console' && !s.view.closed);
      if (existing) return { ok: true, session: existing.view, banner: '' };
      const s = open(deviceId, 'console', pcId, `${d.label} — console (${world.devices[pcId].label} COM1, 9600 8N1)`);
      changed();
      const banner = d.runtime.setupDialogDone
        ? `\n${d.config.hostname} con0 is now available\n\nPress RETURN to get started.\n\n`
        : '\n         --- System Configuration Dialog ---\n\n';
      return { ok: true, session: s.view, banner };
    },
    sessionExec: (id, line) => {
      const s = sessions.get(id);
      if (!s) return { output: '', prompt: '', secret: false, closed: true, notes: [] };
      const v = runLine(s, line);
      changed();
      return v;
    },
    sessionHelp: (id, line) => {
      const s = sessions.get(id);
      if (!s || s.pending || s.mode === 'setup') return '';
      const t = line.trimStart().split(/\s+/);
      const partial = line.length > 0 && !/\s$/.test(line);
      let list = WORDS[s.mode];
      if (t.length > 1 || (t.length === 1 && !partial && t[0])) { list = is(t[0], 'show', 2) ? SHOW : []; if (!list.length) return '  <cr>\n'; }
      const last = partial ? t[t.length - 1].toLowerCase() : '';
      const hits = list.filter(([w]) => w.startsWith(last));
      if (!hits.length) return '% Unrecognized command\n';
      if (partial) return hits.map(([w]) => w).join('  ') + '\n';
      return hits.map(([w, h]) => `  ${w.padEnd(16)}${h}`).join('\n') + '\n';
    },
    sessionComplete: (id, line) => {
      const s = sessions.get(id);
      if (!s || s.pending || !line || /\s$/.test(line)) return { line, candidates: [] };
      const t = line.split(/\s+/);
      const last = t[t.length - 1].toLowerCase();
      const list = t.length === 1 ? WORDS[s.mode] : is(t[0], 'show', 2) ? SHOW : [];
      const cands = list.map(([w]) => w).filter((w) => w.startsWith(last));
      if (cands.length === 1) return { line: line.slice(0, line.length - last.length) + cands[0] + ' ', candidates: cands };
      return { line, candidates: cands };
    },
    sessionKey: (id, key) => {
      const s = sessions.get(id);
      if (!s) return { output: '', prompt: '', secret: false, closed: true, notes: [] };
      let output = '';
      if (s.pending) { s.pending = undefined; output = '\n'; }
      else if (s.mode === 'config' || s.mode === 'config-if' || s.mode === 'config-line') { s.mode = 'priv'; output = key === 'ctrl-z' ? '^Z\n' : '^C\n'; }
      s.view = { ...s.view, prompt: promptOf(s), secret: false };
      changed();
      return { output, prompt: s.view.prompt, secret: false, closed: s.view.closed, notes: [] };
    },
    sessionHistory: (id) => sessions.get(id)?.history.slice() ?? [],
    closeSession: (id) => { const s = sessions.get(id); if (s) { s.view = { ...s.view, closed: true }; changed(); } },

    getConfigText: (deviceId, which) => {
      const d = ios(deviceId);
      if (!d) return '';
      return which === 'running' ? running(d).split('\n').slice(3).join('\n') : d.startupConfig ?? '';
    },
    applyConfigText: (deviceId, text, how): ApplyReport => {
      const d = ios(deviceId);
      if (!d) return { ok: false, applied: 0, failed: 0, lines: [], message: 'This device has no configuration.' };
      if (!consolePcOf(deviceId)) return { ok: false, applied: 0, failed: 0, lines: [], message: 'No console cable is connected.' };
      const blocked = gate();
      if (blocked) return { ok: false, applied: 0, failed: 0, lines: [], blocked };
      if (how === 'replace') { d.config.hostname = d.kind === 'router' ? 'Router' : 'Switch'; d.config.extraLines = []; for (const n of Object.keys(d.config.interfaces)) d.config.interfaces[n] = { name: n, shutdown: d.kind === 'router' }; }
      const s: MockSession = { view: { id: 'file', deviceId, kind: 'console', pcId: '', title: '', prompt: '', secret: false, closed: false }, mode: 'config', history: [] };
      const lines: ApplyReport['lines'] = [];
      text.split('\n').forEach((raw, i) => {
        const line = raw.replace(/\s+$/, '');
        if (!line.trim() || line.trim().startsWith('!')) return;
        if (/^(version|service timestamps|Building|Current configuration| stopbits)/.test(line)) { lines.push({ lineNo: i + 1, line, ok: true, output: '' }); return; }
        if (s.mode === 'priv') s.mode = 'config';
        const v = runLine(s, line, true);
        const ok = !/^\s*%/m.test(v.output) && !/\^\n/.test(v.output);
        lines.push({ lineNo: i + 1, line, ok, output: ok ? '' : v.output.replace(/^ *\^\n/, '') });
      });
      changed();
      const failed = lines.filter((l) => !l.ok).length;
      return { ok: failed === 0, applied: lines.length - failed, failed, lines };
    },

    setPcNic: (pcId, nic) => {
      const p = pc(pcId);
      if (!p) return { ok: false, message: 'Not a PC.' };
      const blocked = gate();
      if (blocked) return { ok: false, blocked };
      if (nic.mode === 'static') {
        if (nic.mask && !/^255\./.test(nic.mask)) return { ok: false, message: `${nic.mask} is not a valid subnet mask.` };
        p.nic = { mode: 'static', mac: p.nic.mac, address: nic.address, mask: nic.mask, gateway: nic.gateway, dns: nic.dns };
        changed();
        return { ok: true };
      }
      const linked = linkOf({ deviceId: pcId, port: 'Ethernet0' }).usable;
      p.nic = { mode: 'dhcp', mac: p.nic.mac };
      if (linked) { p.nic.address = `192.168.100.${100 + world.order.indexOf(pcId) + 1}`; p.nic.mask = '255.255.255.0'; p.nic.gateway = '192.168.100.1'; p.nic.dhcpServer = '192.168.100.1'; }
      changed();
      return linked ? { ok: true } : { ok: false, message: 'No DHCP server answered. Check the cable of this PC and the DHCP pool on the router.' };
    },
    setPcService: (pcId, service: keyof PcServices, on) => { const p = pc(pcId); if (p) { p.services[service] = on; changed(); } },
    pcExec,
    pcSnmp: (pcId, req: SnmpRequest): SnmpReply => {
      const p = pc(pcId);
      changed();
      if (!p?.nic.address) return { ok: false, text: 'This PC has no IP address.' };
      if (req.community !== 'D105read' && req.community !== 'D105write') return { ok: false, text: 'Timeout: No Response from ' + req.host };
      if (req.op === 'set' && req.community !== 'D105write') return { ok: false, text: 'Timeout: No Response from ' + req.host };
      return { ok: true, text: `SNMPv2-MIB::${req.oid} = STRING: ${req.op === 'set' ? req.value : 'R1'}` };
    },
    clearPcLog: (pcId, which) => { const p = pc(pcId); if (p) { p.runtime[which] = []; changed(); } },

    trace: () => ({ error: 'Not available in the test bench.' }) as FlowResult | { error: string },
    qosLoad: (): QosLoadResult => ({ ok: false, message: 'Not available in the test bench.', linkKbps: 0, shapedKbps: 0, rows: [] }),
    noteHintUsed: () => undefined,
    solution: (): SolutionView | null => null,
    commandSheet: (): CommandSheetSection[] => [],
    check: () => notReady({ scenarioId: 'mock', mode, tick: world.tick, maxPoints: 0, points: 0, scaled18: 0, requirements: [], orderIssues: [], hardwareNotes: [] } as GradeReport),
    finishExam: () => ({ scenarioId: 'mock', mode, tick: world.tick, maxPoints: 0, points: 0, scaled18: 0, requirements: [], orderIssues: [], hardwareNotes: [] }),

    updateSettings: (patch) => {
      const { qosClassifiesInnerHeader: qos, ...other } = patch;
      Object.assign(settings, other);
      if (patch.strictCables !== undefined) world.settings.strictCables = patch.strictCables;
      if (mode !== 'exam' && typeof qos === 'boolean') settings.qosClassifiesInnerHeader = world.settings.qosClassifiesInnerHeader = qos;
      changed();
    },
    exportLab: () => JSON.stringify(world),
    importLab: () => ({ ok: false, message: 'Not available in the test bench.' }),
    loadSaved: () => ({ ok: false, message: 'Not available in the test bench.' }),
    deleteSaved: () => undefined,
  };

  const controls: MockControls = {
    setMode: (m) => { mode = m; changed(); },
    blockNext: (on) => { blockNext = on; },
    injectSyslog: (pcId) => {
      const p = pc(pcId);
      if (!p) return;
      const n = p.runtime.syslog.length;
      p.runtime.syslog.push({ tick: world.tick, from: n % 2 ? '2.2.2.2' : '1.1.1.1', severity: n % 3 === 0 ? 5 : 3, mnemonic: n % 3 === 0 ? 'SYS-5-CONFIG_I' : 'LINK-3-UPDOWN', text: n % 3 === 0 ? 'Configured from console by console' : 'Interface Serial0/1/0, changed state to up' });
      changed();
    },
    injectTrap: (pcId) => { const p = pc(pcId); if (!p) return; p.runtime.traps.push({ tick: world.tick, from: '1.1.1.1', community: 'D105read', text: 'linkUp ifIndex.3 ifDescr.3=Serial0/1/0' }); changed(); },
    cableReference: () => {
      const add = (kind: CableKind, a: [string, string], b: [string, string], dceEnd?: 'a' | 'b') => connectCable(kind, { deviceId: a[0], port: a[1] }, { deviceId: b[0], port: b[1] }, { dceEnd });
      add('straight', ['pc1', 'Ethernet0'], ['sw1', 'GigabitEthernet1/0/1']);
      add('straight', ['pc2', 'Ethernet0'], ['sw1', 'GigabitEthernet1/0/2']);
      add('straight', ['sw1', 'GigabitEthernet1/0/24'], ['r1', 'GigabitEthernet0/0/0']);
      add('serial', ['r1', 'Serial0/1/0'], ['r2', 'Serial0/1/0'], 'a');
      add('crossover', ['r2', 'GigabitEthernet0/0/0'], ['pc3', 'Ethernet0']);
      add('console', ['pc1', 'COM1'], ['r1', 'Console']);
    },
    dropSession: (deviceId) => { for (const s of sessions.values()) if (s.view.deviceId === deviceId && !s.view.closed) s.view = { ...s.view, closed: true }; changed(); },
  };
  return { lab, controls };
}
