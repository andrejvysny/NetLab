/**
 * Management screens: show snmp [community|host|location|contact|chassis], show logging, show users, show line [...],
 * show terminal. Notification counters report modeled dispatch attempts and receiver collection.
 */
import type { CliSession } from '../framework.ts';
import type { IosDevice, LineConfig, NotificationCounter, World } from '../../types.ts';
import { lookupRoute, syslogBlockReason } from '../../sim/index.ts';
import { effectiveSnmpHosts, enabledSnmpTraps, hostAllowsSnmpTrap, modeledSnmpHost, validSnmpHost } from '../../snmp.ts';
import { joinLines, logStamp, padL, padR, serialNo } from './util.ts';

// ───────────────────────────── SNMP ─────────────────────────────
function snmpEnabled(dev: IosDevice): boolean {
  const s = dev.config.snmp;
  return s.communities.length > 0 || s.hosts.some(validSnmpHost) || !!s.location || !!s.contact || s.enableTraps.length > 0;
}
function attempts(c?: NotificationCounter): string {
  return `${c?.attempts ?? 0} modeled attempts, ${c?.collected ?? 0} collected`;
}
export function chassisId(world: World, dev: IosDevice): string { return serialNo(world, dev.id, 'chassis', dev.kind === 'switch' ? 'FOC' : 'FDO'); }

export function showSnmp(world: World, dev: IosDevice): string {
  if (!snmpEnabled(dev)) return '%SNMP agent not enabled';
  const s = dev.config.snmp;
  const traps = enabledSnmpTraps(s);
  const hosts = effectiveSnmpHosts(s).filter(validSnmpHost);
  const active = hosts.some((h) => traps.some((trap) => hostAllowsSnmpTrap(h, trap)));
  const out = [
    `Chassis: ${chassisId(world, dev)}`,
    `Contact: ${s.contact ?? ''}`,
    `Location: ${s.location ?? ''}`,
    'SNMP request/PDU counters and queues are not modeled.',
    `SNMP global trap: ${traps.length ? 'enabled' : 'disabled'} for modeled events${traps.length ? ` (${traps.join(', ')})` : ''}`,
    '',
    `SNMP logging: ${active ? 'enabled' : 'disabled'} for modeled traps`,
  ];
  for (const host of hosts) {
    const prefix = `    Logging to ${host.address}.162 (${host.type})`;
    if (!modeledSnmpHost(host)) out.push(`${prefix}: configuration only (no delivery).`);
    else {
      const on = traps.some((trap) => hostAllowsSnmpTrap(host, trap));
      out.push(`${prefix}: ${on ? 'enabled' : 'disabled'}, ${attempts(dev.runtime.notificationCounters?.snmp?.[host.address])}.`);
    }
  }
  return joinLines(out);
}
export function snmpCommunity(dev: IosDevice): string {
  const out: string[] = [''];
  dev.config.snmp.communities.forEach((c, i) => {
    out.push(`Community name: ${c.name}`, `Community Index: cisco${i}`, `Community SecurityName: ${c.name}`,
      `storage-type: nonvolatile\t active${c.acl ? `\taccess-list: ${c.acl}` : ''}`, '', '');
  });
  return out.join('\n').replace(/\n+$/, '\n');
}
export function snmpHost(dev: IosDevice): string {
  const out: string[] = [];
  for (const h of effectiveSnmpHosts(dev.config.snmp).filter(validSnmpHost)) {
    out.push(`Notification host: ${h.address}\tudp-port: 162\ttype: ${h.type === 'informs' ? 'inform' : 'trap'}`);
    out.push(`user: ${h.community}\tsecurity model: ${h.version === '2c' ? 'v2c' : h.version === '3' ? `v3 ${h.securityLevel ?? 'noauth'}` : 'v1'}`);
    if (h.notificationTypes?.length) out.push(`Notification types: ${h.notificationTypes.join(' ')}`);
    if (!modeledSnmpHost(h)) out.push('Configuration only: not simulated.');
    out.push('');
  }
  return out.join('\n');
}

// ───────────────────────────── logging ─────────────────────────────
const LEVELS = ['emergencies', 'alerts', 'critical', 'errors', 'warnings', 'notifications', 'informational', 'debugging'];
function levelNum(l: string | undefined, dflt: number): number {
  if (l === undefined) return dflt;
  if (/^\d$/.test(l)) return Number(l);
  const i = LEVELS.indexOf(l);
  return i < 0 ? dflt : i;
}
function extraLevel(dev: IosDevice, dest: string): { on: boolean; level: number } {
  const lines = dev.config.logging.extraLines ?? [];
  if (lines.includes(`no logging ${dest}`)) return { on: false, level: 7 };
  const l = lines.find((x) => x.startsWith(`logging ${dest}`));
  if (!l) return { on: true, level: 7 };
  const word = l.split(/\s+/).find((w) => LEVELS.includes(w));
  return { on: true, level: levelNum(word, 7) };
}
function bufferSize(dev: IosDevice): number {
  const l = (dev.config.logging.extraLines ?? []).find((x) => x.startsWith('logging buffered'));
  const m = l ? /logging buffered (\d+)/.exec(l) : null;
  return m ? Number(m[1]) : 102400;
}
export function showLogging(world: World, dev: IosDevice): string {
  const log = dev.config.logging;
  const buf = dev.runtime.logBuffer;
  const con = extraLevel(dev, 'console');
  const mon = extraLevel(dev, 'monitor');
  const bf = extraLevel(dev, 'buffered');
  const trap = levelNum(log.trapLevel, 6);
  const block = syslogBlockReason(dev);
  const globallyOff = block === 'logging-off';
  const lvl = (x: { on: boolean; level: number }, on = !globallyOff) => (x.on && on ? `level ${LEVELS[x.level]}` : 'disabled');
  const syslog = dev.runtime.notificationCounters?.syslog;
  const out = [
    `Syslog logging: ${globallyOff ? 'disabled (no logging on)' : 'enabled'}`,
    '', 'No Active Message Discriminator.', '', '', '', 'No Inactive Message Discriminator.', '', '',
    `    Console logging: ${lvl(con, true)}, xml disabled,`,
    '                     filtering disabled',
    `    Monitor logging: ${lvl(mon)}, xml disabled,`,
    '                     filtering disabled',
    `    Buffer logging:  ${lvl(bf)}, ${bf.on ? buf.filter((m) => m.severity <= bf.level).length : 0} messages retained, xml disabled,`,
    '                    filtering disabled',
    '    Exception Logging: size (4096 bytes)',
    '    Count and timestamp logging messages: disabled',
    '    File logging: disabled',
    '    Persistent logging: disabled',
    '', 'No active filter modules.', '',
    `    Trap logging: ${block ? `disabled (${globallyOff ? 'no logging on' : 'no logging trap'})` : `level ${LEVELS[trap]}`}`,
  ];
  for (const h of log.hosts) {
    const status = block ? 'disabled' : `route ${lookupRoute(world, dev.id, h) ? 'available' : 'unavailable'}`;
    out.push(`        Logging to ${h}  (udp port 514; ${status}): ${attempts(syslog?.[h])}.`);
  }
  if (log.sourceInterface) {
    out.push('        Logging Source-Interface:       VRF Name:', `        ${padR(log.sourceInterface, 32)}`);
  }
  out.push('', `Log Buffer (${bufferSize(dev)} bytes):`, '');
  if (bf.on) for (const m of buf) if (m.severity <= bf.level) out.push(`*${logStamp(dev, m.tick)}: %${m.mnemonic}: ${m.text}`);
  return joinLines(out);
}

// ───────────────────────────── lines and users ─────────────────────────────
export interface LineRow { abs: number; type: 'CTY' | 'AUX' | 'VTY'; rel: number; cfg?: LineConfig }
export function lineRows(dev: IosDevice): LineRow[] {
  const rows: LineRow[] = [{ abs: 0, type: 'CTY', rel: 0, cfg: dev.config.lines.console }];
  const base = dev.kind === 'router' ? 2 : 1;
  if (dev.kind === 'router') rows.push({ abs: 1, type: 'AUX', rel: 0 });
  const nums: number[] = [];
  for (const r of dev.config.lines.vty) for (let n = r.first; n <= r.last; n++) nums.push(n);
  nums.sort((a, b) => a - b);
  for (const n of nums) rows.push({ abs: base + n, type: 'VTY', rel: n, cfg: dev.config.lines.vty.find((r) => r.first <= n && n <= r.last) });
  return rows;
}
function lineName(r: LineRow): string { return r.type === 'CTY' ? 'con' : r.type === 'AUX' ? 'aux' : 'vty'; }
function currentAbs(dev: IosDevice, s: CliSession): number {
  if (s.via !== 'vty') return 0;
  const rows = lineRows(dev).filter((r) => r.type === 'VTY');
  return rows[Math.max(0, Math.min(rows.length - 1, dev.runtime.vtyInUse - 1))]?.abs ?? 2;
}
function inUse(dev: IosDevice, s: CliSession, r: LineRow): boolean {
  if (r.type === 'CTY') return s.via !== 'vty';
  if (r.type !== 'VTY') return false;
  const vtys = lineRows(dev).filter((x) => x.type === 'VTY');
  const i = vtys.findIndex((x) => x.abs === r.abs);
  return i >= 0 && i < dev.runtime.vtyInUse;
}
export function showUsers(dev: IosDevice, s: CliSession): string {
  const out = ['    Line       User       Host(s)              Idle       Location'];
  const me = currentAbs(dev, s);
  for (const r of lineRows(dev)) {
    if (!inUse(dev, s, r)) continue;
    const mark = r.abs === me ? '*' : ' ';
    const loc = r.type === 'VTY' && r.abs === me ? s.remoteAddr ?? '' : '';
    out.push(`${mark}${padL(r.abs, 3)} ${padR(`${lineName(r)} ${r.rel}`, 10)}${padR('', 11)}${padR('idle', 21)}${padR('00:00:00', 11)}${loc}`);
  }
  out.push('', '  Interface    User               Mode         Idle     Peer Address', '');
  return joinLines(out);
}
export function showLineTable(dev: IosDevice, s: CliSession, only?: LineRow[]): string {
  const out = ['   Tty Ln Typ     Tx/Rx    A Modem  Roty AccO AccI   Uses   Noise  Overruns   Int'];
  for (const r of only ?? lineRows(dev)) {
    const mark = inUse(dev, s, r) ? '*' : ' ';
    const accI = r.cfg?.accessClassIn ? r.cfg.accessClassIn.slice(0, 4) : '-';
    const accO = r.cfg?.accessClassOut ? r.cfg.accessClassOut.slice(0, 4) : '-';
    const txrx = r.type === 'AUX' || r.type === 'CTY' ? '9600/9600' : '';
    out.push(`${mark}${padL(r.abs, 5)} ${padL(r.abs, 2)} ${padR(r.type, 3)} ${padL(txrx, 10)}  -    -      -  ${padL(accO, 4)} ${padL(accI, 4)} ${padL(r.type === 'VTY' && inUse(dev, s, r) ? 1 : 0, 6)} ${padL(0, 7)} ${padL('0/0', 9)}       -`);
  }
  return joinLines(out);
}
function transports(cfg: LineConfig | undefined): string {
  const t = cfg?.transportInput;
  if (t === 'none') return 'none';
  if (t === 'telnet') return 'telnet';
  if (t === 'ssh') return 'ssh';
  return 'telnet ssh';
}
export function lineDetail(dev: IosDevice, s: CliSession, r: LineRow, termLength = 24): string {
  const t = r.cfg?.execTimeout;
  const idle = t ? `${String(Math.floor(t[0] / 60)).padStart(2, '0')}:${String(t[0] % 60).padStart(2, '0')}:${String(t[1]).padStart(2, '0')}` : '00:10:00';
  const out = [
    showLineTable(dev, s, [r]),
    '',
    `Line ${r.abs}, Location: "", Type: ""`,
    `Length: ${termLength} lines, Width: 80 columns`,
    'Baud rate (TX/RX) is 9600/9600',
    `Status: ${inUse(dev, s, r) ? 'PSI Enabled, Ready, Active, No Exit Banner' : 'Ready, No Exit Banner'}`,
    `Capabilities: ${r.cfg?.loggingSynchronous ? 'Notifications Disabled' : 'none'}`,
    'Modem state: Ready',
    'Group codes:    0',
    'Special Chars: Escape  Hold  Stop  Start  Disconnect  Activation',
    '                ^^x    none   -     -       none         ',
    'Timeouts:      Idle EXEC    Idle Session   Modem Answer  Session   Dispatch',
    `               ${idle}        never                        none     not set`,
    '                            Idle Session Disconnect Warning',
    '                              never ',
    '                            Login-sequence User Response',
    '                             00:00:30',
    '                            Autoselect Initial Wait',
    '                              not set ',
    'Modem type is unknown.',
    'Session limit is not set.',
    'Time since activation: never',
    'Editing is enabled.',
    'History is enabled, history size is 20.',
    'DNS resolution in show commands is enabled',
    'Full user help is disabled',
    `Allowed input transports are ${r.type === 'VTY' ? transports(r.cfg) : 'none'}.`,
    'Allowed output transports are telnet ssh.',
    'NetLab: SSH transport settings do not start an SSH server; TCP 22 is a path probe only.',
    'Preferred transport is none.',
    'Shell: enabled',
    'Shell trace: off',
    'No output characters are padded',
    'No special data dispatching characters',
  ];
  return joinLines(out);
}
