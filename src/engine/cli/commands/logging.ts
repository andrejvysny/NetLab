/**
 * Syslog: `logging <ip>` / `logging host <ip>`, `logging source-interface <if>`, `logging trap <level>`, and the accepted
 * switches `no logging trap` and `[no] logging on`, and extras `logging console|monitor|buffered|facility|history|rate-limit …`
 * (kept in `logging.extraLines`, not simulated), with `no` forms.
 *
 * Normalisation: severity numbers become names (`logging trap 4` → 'warnings'); `logging trap informational` is the default
 * and is stored as undefined (IOS does not print it). Extras are stored as IOS prints them, e.g. 'logging console warnings',
 * 'logging buffered 128000 debugging', 'no logging console', 'no logging on'.
 *
 * No sub-modes, so no session.ctx keys.
 */
import type { CmdEnv, CommandDef } from '../framework.ts';
import { registerCommands } from '../framework.ts';
import { checkInterfaceRef, setExtraLine } from './acl.ts';

export const SYSLOG_LEVELS = ['emergencies', 'alerts', 'critical', 'errors', 'warnings', 'notifications', 'informational', 'debugging'] as const;
/** 'warnings' | '4' → 4; unknown → null. */
export function syslogLevelNumber(level: string | undefined): number | null {
  if (level === undefined) return 6;
  if (/^[0-7]$/.test(level)) return Number(level);
  const i = (SYSLOG_LEVELS as readonly string[]).indexOf(level.toLowerCase());
  return i < 0 ? null : i;
}
const LEVEL_HELP: Record<string, string> = {
  emergencies: 'System is unusable                (severity=0)', alerts: 'Immediate action needed           (severity=1)',
  critical: 'Critical conditions               (severity=2)', errors: 'Error conditions                  (severity=3)',
  warnings: 'Warning conditions                (severity=4)', notifications: 'Normal but significant conditions (severity=5)',
  informational: 'Informational messages            (severity=6)', debugging: 'Debugging messages                (severity=7)',
  '<lvl>': 'Logging severity level',
};
const FACILITIES = ['auth', 'cron', 'daemon', 'kern', 'local0', 'local1', 'local2', 'local3', 'local4', 'local5', 'local6', 'local7',
  'lpr', 'mail', 'news', 'sys10', 'sys11', 'sys12', 'sys13', 'sys14', 'sys9', 'syslog', 'user', 'uucp'];
const LEVEL = `[{level:${SYSLOG_LEVELS.join('|')}}]`;
const LEVEL_NUM = '<lvl:int(0-7)>';

const H: Record<string, string> = {
  no: 'Negate a command or set its defaults', logging: 'Modify message logging facilities',
  '<addr>': 'IP address of the logging host', host: 'Set syslog server IP address and parameters',
  'source-interface': 'Specify interface for source address in logging transactions', '<ifname>': 'Interface name',
  trap: 'Set syslog server logging level', on: 'Enable logging to all enabled destinations',
  console: 'Set console logging parameters', monitor: 'Set terminal line (monitor) logging parameters',
  buffered: 'Set buffered logging parameters', '<size>': 'Logging buffer size',
  facility: 'Facility parameter for syslog messages', history: 'Configure syslog history table',
  'rate-limit': 'Set messages per second limit', '<rate>': 'Messages per second and options',
  ...LEVEL_HELP,
};

function levelName(args: Record<string, unknown>): string | undefined {
  if (args.lvl !== undefined) return SYSLOG_LEVELS[args.lvl as number];
  return args.level as string | undefined;
}
function extra(env: CmdEnv): string[] {
  const l = env.device.config.logging;
  if (!l.extraLines) l.extraLines = [];
  return l.extraLines;
}
function accepted(env: CmdEnv, key: string, line: string | null): void {
  setExtraLine(extra(env), key, line);
  env.note(`Accepted, but not simulated: ${key}.`);
}
function addHost(env: CmdEnv, addr: string): void {
  const hosts = env.device.config.logging.hosts;
  if (!hosts.includes(addr)) hosts.push(addr);
}
function removeHost(env: CmdEnv, addr: string): void {
  const l = env.device.config.logging;
  l.hosts = l.hosts.filter((h) => h !== addr);
}

export const commands: CommandDef[] = [
  {
    modes: 'config', feature: 'syslog', help: H,
    pattern: ['logging <addr:ip>', 'logging host <addr:ip>'],
    run(env, args) { addHost(env, String(args.addr)); },
  },
  {
    modes: 'config', feature: 'syslog', help: H,
    pattern: ['no logging <addr:ip>', 'no logging host <addr:ip>'],
    run(env, args) { removeHost(env, String(args.addr)); },
  },
  {
    modes: 'config', feature: 'syslog', help: H,
    pattern: 'logging source-interface <ifname:if>',
    run(env, args) {
      checkInterfaceRef(env, String(args.ifname));
      env.device.config.logging.sourceInterface = String(args.ifname);
    },
  },
  {
    modes: 'config', feature: 'syslog', help: H,
    pattern: 'no logging source-interface [<ifname:if>]',
    run(env) { delete env.device.config.logging.sourceInterface; },
  },
  {
    modes: 'config', feature: 'syslog', help: H,
    pattern: [`logging trap ${LEVEL}`, `logging trap ${LEVEL_NUM}`],
    run(env, args) {
      const name = levelName(args);
      const l = env.device.config.logging;
      if (l.extraLines) setExtraLine(l.extraLines, 'logging trap', null);
      if (name === undefined || name === 'informational') delete l.trapLevel; else l.trapLevel = name;
    },
  },
  {
    modes: 'config', feature: 'syslog', help: H,
    pattern: [`no logging trap ${LEVEL}`, `no logging trap ${LEVEL_NUM}`],
    run(env) {
      delete env.device.config.logging.trapLevel;
      setExtraLine(extra(env), 'logging trap', 'no logging trap');
    },
  },
  {
    modes: 'config', feature: 'syslog', help: H,
    pattern: ['logging on', 'no logging on'],
    run(env) {
      setExtraLine(extra(env), 'logging on', env.has('no') ? 'no logging on' : null);
    },
  },
  {
    modes: 'config', feature: 'syslog', help: H,
    pattern: [`logging {dest:console|monitor} ${LEVEL}`, `logging {dest:console|monitor} ${LEVEL_NUM}`],
    run(env, args) {
      const name = levelName(args);
      const key = `logging ${args.dest}`;
      accepted(env, key, name === undefined || name === 'debugging' ? null : `${key} ${name}`);
    },
  },
  {
    modes: 'config', feature: 'syslog', help: H,
    pattern: [`no logging {dest:console|monitor} ${LEVEL}`, `no logging {dest:console|monitor} ${LEVEL_NUM}`],
    run(env, args) { accepted(env, `logging ${args.dest}`, `no logging ${args.dest}`); },
  },
  {
    modes: 'config', feature: 'syslog', help: H,
    pattern: [`logging buffered [<size:int(4096-2147483647)>] ${LEVEL}`, `logging buffered [<size:int(4096-2147483647)>] ${LEVEL_NUM}`],
    run(env, args) {
      const name = levelName(args);
      const parts = ['logging buffered'];
      if (args.size !== undefined) parts.push(String(args.size));
      if (name !== undefined) parts.push(name);
      accepted(env, 'logging buffered', parts.join(' '));
    },
  },
  {
    modes: 'config', feature: 'syslog', help: H,
    pattern: [`no logging buffered [<size:int(4096-2147483647)>] ${LEVEL}`, `no logging buffered [<size:int(4096-2147483647)>] ${LEVEL_NUM}`],
    run(env) { accepted(env, 'logging buffered', 'no logging buffered'); },
  },
  {
    modes: 'config', feature: 'syslog', help: H,
    pattern: `logging facility {fac:${FACILITIES.join('|')}}`,
    run(env, args) { accepted(env, 'logging facility', args.fac === 'local7' ? null : `logging facility ${args.fac}`); },
  },
  {
    modes: 'config', feature: 'syslog', help: H,
    pattern: `no logging facility [{fac:${FACILITIES.join('|')}}]`,
    run(env) { setExtraLine(extra(env), 'logging facility', null); },
  },
  {
    modes: 'config', feature: 'syslog', help: H,
    pattern: [`logging history {level:${SYSLOG_LEVELS.join('|')}}`, `logging history ${LEVEL_NUM}`],
    run(env, args) { accepted(env, 'logging history', `logging history ${levelName(args)}`); },
  },
  {
    modes: 'config', feature: 'syslog', help: H,
    pattern: [`no logging history ${LEVEL}`, `no logging history ${LEVEL_NUM}`],
    run(env) { setExtraLine(extra(env), 'logging history', null); },
  },
  {
    modes: 'config', feature: 'syslog', help: H,
    pattern: 'logging rate-limit <rate:text>',
    run(env, args) { accepted(env, 'logging rate-limit', `logging rate-limit ${String(args.rate).trim().replace(/\s+/g, ' ')}`); },
  },
  {
    modes: 'config', feature: 'syslog', help: H,
    pattern: 'no logging rate-limit [<rate:text>]',
    run(env) { setExtraLine(extra(env), 'logging rate-limit', null); },
  },
];

export function install(): void { registerCommands(commands); }
