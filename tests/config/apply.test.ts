import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IosConfig, World } from '../../src/engine/types.ts';
import { addDevice, createWorld, defaultIosConfig, getIos } from '../../src/engine/world.ts';
import { installCli, registerCommands } from '../../src/engine/cli/index.ts';
import type { CommandDef } from '../../src/engine/cli/index.ts';
import {
  applyConfigText, decodeSecrets, eraseStartupConfig, prepareConfigLines, reloadDevice, saveStartupConfig,
} from '../../src/engine/config/apply.ts';
import { renderRunningConfig, simSecretEncode, type7Encode } from '../../src/engine/config/render.ts';
import * as systemMod from '../../src/engine/cli/commands/system.ts';
import * as interfaceMod from '../../src/engine/cli/commands/interface.ts';
import * as lineMod from '../../src/engine/cli/commands/line.ts';
import * as routingMod from '../../src/engine/cli/commands/routing.ts';
import * as dhcpMod from '../../src/engine/cli/commands/dhcp.ts';
import * as aclMod from '../../src/engine/cli/commands/acl.ts';
import * as natMod from '../../src/engine/cli/commands/nat.ts';
import * as snmpMod from '../../src/engine/cli/commands/snmp.ts';
import * as loggingMod from '../../src/engine/cli/commands/logging.ts';
import * as cryptoMod from '../../src/engine/cli/commands/crypto.ts';
import * as qosMod from '../../src/engine/cli/commands/qos.ts';
import * as switchMod from '../../src/engine/cli/commands/switch.ts';
import { R1_COURSE, R1_RUNNING, R2_COURSE, R2_RUNNING, r1Config, r2Config } from './reference.ts';

// Test-only commands with names no real module uses, so the apply machinery can be tested while other modules are unfinished.
const testDefs: CommandDef[] = [
  { modes: 'config', pattern: 'zz-name <name:word>', feature: 'system', run: (e, a) => { e.device.config.hostname = a.name; } },
  { modes: 'config', pattern: 'zz-reject', feature: 'system', run: (e) => e.reject('% zz says no') },
  { modes: 'config', pattern: 'zz-crash', feature: 'system', run: () => { throw new Error('boom'); } },
  { modes: 'config', pattern: 'zz-pw <pw:text>', feature: 'vty', run: (e, a) => { e.device.config.lines.console.password = a.pw; } },
  { modes: 'config', pattern: 'zz-if <ifname:if>', feature: 'interface', mutates: false, run: (e, a) => e.setMode('config-if', { ifNames: [a.ifname] }) },
  { modes: 'config-if', pattern: 'zz-desc <d:text>', feature: 'interface', run: (e, a) => { for (const n of e.session.ctx.ifNames as string[]) e.device.config.interfaces[n].description = a.d; } },
  { modes: 'config-if', pattern: ['zz-shut', 'no zz-shut'], feature: 'interface', run: (e) => { for (const n of e.session.ctx.ifNames as string[]) e.device.config.interfaces[n].shutdown = !e.has('no'); } },
];
installCli();
registerCommands(testDefs);

const MODULES: Record<string, { commands: CommandDef[] }> = {
  system: systemMod, interface: interfaceMod, line: lineMod, routing: routingMod, dhcp: dhcpMod, acl: aclMod, nat: natMod,
  snmp: snmpMod, logging: loggingMod, crypto: cryptoMod, qos: qosMod,
};
/** Command modules that are still empty stubs (another agent has not delivered them yet). */
function missing(names: string[]): string[] { return names.filter((n) => MODULES[n].commands.length === 0); }
const ALL = Object.keys(MODULES);
const MODULES_SWITCH: { commands: CommandDef[] } = switchMod;

function routerWorld(config?: IosConfig): World {
  const w = createWorld();
  addDevice(w, { id: 'r1', model: 'isr4331', label: 'R1', x: 0, y: 0 });
  addDevice(w, { id: 'pc1', model: 'pc-windows', label: 'PC1', x: 0, y: 0 });
  if (config) getIos(w, 'r1').config = config;
  return w;
}
const failures = (r: ReturnType<typeof applyConfigText>) => r.lines.filter((l) => !l.ok).map((l) => `line ${l.lineNo}: ${l.line}\n${l.output}`).join('\n');

test('prepareConfigLines: furniture, comments, prompts, session noise, end, banners, ACE spacing', () => {
  const text = [
    'Building configuration...',
    '',
    'Current configuration : 1234 bytes',
    '!',
    '! Last configuration change at 10:00:00 UTC',
    'version 17.3',
    'service timestamps debug datetime msec',
    'service timestamps log uptime',
    'R1>enable',
    'R1#configure terminal',
    'conf t',
    'hostname R1',
    'boot-start-marker',
    'boot-end-marker',
    'no aaa new-model',
    'R1(config)#ip route 0.0.0.0 0.0.0.0 60.50.30.2',
    'interface GigabitEthernet0/0/0',
    ' ip address 192.168.100.1 255.255.255.0',
    ' negotiation auto',
    'access-list 110 deny   ip any any',
    'ip access-list standard X',
    ' 10 deny   any',
    'router rip',
    ' version 2',
    'banner motd ^C',
    'Hello',
    'World',
    '^C',
    'control-plane',
    ' service-policy input system-cpp-policy',
    'line con 0',
    ' stopbits 1',
    'line aux 0',
    ' stopbits 1',
    'line vty 0 4',
    ' password 7 0822455D0A16',
    'end',
    'hostname AFTER_END',
  ].join('\n');
  const lines = prepareConfigLines(text);
  assert.deepEqual(lines.map((l) => [l.lineNo, l.command]), [
    [7, 'service timestamps debug datetime msec'],
    [8, 'service timestamps log uptime'],
    [12, 'hostname R1'],
    [15, 'no aaa new-model'],
    [16, 'ip route 0.0.0.0 0.0.0.0 60.50.30.2'],
    [17, 'interface GigabitEthernet0/0/0'],
    [18, 'ip address 192.168.100.1 255.255.255.0'],
    [19, 'negotiation auto'],
    [20, 'access-list 110 deny ip any any'],
    [21, 'ip access-list standard X'],
    [22, '10 deny any'],
    [23, 'router rip'],
    [24, 'version 2'],
    [25, 'banner motd #\nHello\nWorld\n#'],
    [31, 'line con 0'],
    [32, 'stopbits 1'],
    [35, 'line vty 0 4'],
    [36, 'password 7 0822455D0A16'],
    [37, 'end'],
  ]);
  assert.equal(lines.find((l) => l.lineNo === 36)?.original, ' password 7 0822455D0A16', 'the report shows the line as written');
  assert.deepEqual(lines.find((l) => l.lineNo === 25)?.banner, { kind: 'motd', text: '\nHello\nWorld\n' });
  assert.deepEqual(prepareConfigLines('banner motd #Hi there#').map((l) => l.command), ['banner motd #Hi there#']);
  assert.deepEqual(prepareConfigLines('banner login ^CNo # here^C').map((l) => l.command), ['banner login %No # here%']);
  assert.deepEqual(prepareConfigLines(''), []);
});

test('decodeSecrets: type 7 passwords and simulator type 9 secrets become clear text', () => {
  assert.equal(decodeSecrets('password 7 0822455D0A16'), 'password cisco');
  assert.equal(decodeSecrets(`password 7 ${type7Encode('my pass')}`), 'password my pass');
  assert.equal(decodeSecrets(`enable password 7 ${type7Encode('enpw')}`), 'enable password enpw');
  assert.equal(decodeSecrets(`enable secret 9 ${simSecretEncode('class')}`), 'enable secret class');
  assert.equal(decodeSecrets(`username admin privilege 15 secret 9 ${simSecretEncode('adm in')}`), 'username admin privilege 15 secret adm in');
  assert.equal(decodeSecrets(`username bob secret 9 ${simSecretEncode('b')}`), 'username bob secret b');
  assert.equal(decodeSecrets('password 7 ZZZZ'), 'password 7 ZZZZ', 'invalid hash left for the CLI');
  assert.equal(decodeSecrets('enable secret 9 $9$abcdefghijklmn$xyz'), 'enable secret 9 $9$abcdefghijklmn$xyz');
  assert.equal(decodeSecrets('password cisco'), 'password cisco');
});

test('applyConfigText: per-line results, IOS errors, tolerated noise, never throws', () => {
  const w = routerWorld();
  const r = applyConfigText(w, 'r1', [
    'enable',
    'configure terminal',
    'zz-name LAB1',
    'exit',
    'zz-bogus 1 2 3',
    'zz-reject',
    'zz-crash',
    'R1(config)#zz-pw 7 abc',
    '',
    'zz-name',
    'end',
    'zz-name NEVER',
  ].join('\n'), 'merge');
  assert.equal(getIos(w, 'r1').config.hostname, 'LAB1');
  assert.equal(getIos(w, 'r1').config.lines.console.password, '7 abc');
  assert.deepEqual(r.lines.map((l) => [l.lineNo, l.ok]), [[3, true], [5, false], [6, false], [7, false], [8, true], [10, false]]);
  assert.equal(r.applied, 2);
  assert.equal(r.failed, 4);
  assert.equal(r.ok, false);
  assert.match(r.lines[1].output, /\^\n% Invalid input detected at '\^' marker\./);
  assert.equal(r.lines[2].output, '% zz says no\n');
  assert.equal(r.lines[3].output, '% Simulator error while running this line.\n');
  assert.doesNotMatch(r.lines[3].output, /boom/); // raw engine exception details can include submitted text
  assert.equal(r.lines[4].line, 'R1(config)#zz-pw 7 abc');
  assert.match(r.lines[5].output, /% Incomplete command\./);
  // nothing after `end`
  assert.equal(getIos(w, 'r1').config.hostname, 'LAB1');
  assert.equal(getIos(w, 'r1').runtime.setupDialogDone, true);
  // bad input never throws
  assert.equal(applyConfigText(w, 'nope', 'hostname X', 'merge').ok, false);
  assert.equal(applyConfigText(w, 'pc1', 'hostname X', 'merge').ok, false);
  assert.doesNotThrow(() => applyConfigText(w, 'r1', null as unknown as string, 'merge'));
  assert.deepEqual(applyConfigText(w, 'r1', '!\n\n', 'merge'), { ok: true, applied: 0, failed: 0, lines: [] });
});

test('a failed top-level line does not let its block change the previous sub-mode', () => {
  const w = routerWorld();
  const r = applyConfigText(w, 'r1', 'zz-if g0/0/0\n zz-desc first\nzz-iff g0/0/1\n zz-desc second\nR1(config)#zz-if g0/0/2\nR1(config-if)#zz-desc third\nR1(config-if)#zz-typo\nR1(config-if)#no zz-shut', 'merge');
  const c = getIos(w, 'r1').config;
  assert.equal(c.interfaces['GigabitEthernet0/0/0'].description, 'first');
  assert.deepEqual(r.lines.filter((l) => !l.ok).map((l) => l.lineNo), [3, 4, 7]);
  assert.equal(c.interfaces['GigabitEthernet0/0/2'].description, 'third');
  assert.equal(c.interfaces['GigabitEthernet0/0/2'].shutdown, false, 'a failed line inside a pasted sub-mode keeps the sub-mode');
});

test('replace resets configuration and configuration-dependent runtime; merge keeps them', () => {
  const w = routerWorld();
  const d = getIos(w, 'r1');
  d.config.hostname = 'OLD';
  d.config.interfaces['GigabitEthernet0/0/1'].description = 'keep me?';
  d.runtime.natTranslations.push({ id: 1, proto: 'icmp', insideLocal: 'a', insideLocalPort: 1, insideGlobal: 'b', insideGlobalPort: 1, outsideLocal: 'c', outsideLocalPort: 1, outsideGlobal: 'c', outsideGlobalPort: 1, createdTick: 0 });
  d.runtime.dhcpBindings.push({ address: '1.1.1.1', clientId: 'x', pool: 'P', grantedTick: 0 });
  d.runtime.aclHits['110:10'] = 5;
  d.runtime.qosCounters['x'] = { packets: 1, bytes: 1 };
  d.runtime.ikeSas.push({ id: 1, local: 'a', remote: 'b', state: 'QM_IDLE', createdTick: 0 });
  d.runtime.logBuffer.push({ tick: 1, severity: 5, mnemonic: 'X', text: 'y' });
  let r = applyConfigText(w, 'r1', 'zz-if g0/0/2\n zz-desc uplink', 'merge');
  assert.equal(r.ok, true, failures(r));
  assert.equal(d.config.hostname, 'OLD');
  assert.equal(d.config.interfaces['GigabitEthernet0/0/1'].description, 'keep me?');
  assert.equal(d.config.interfaces['GigabitEthernet0/0/2'].shutdown, true, 'merge never implies no shutdown');
  assert.equal(d.runtime.natTranslations.length, 1);

  r = applyConfigText(w, 'r1', 'zz-name NEW\nzz-if g0/0/0\n zz-desc LAN\nzz-if g0/0/2\n zz-desc spare\n zz-shut\n', 'replace');
  assert.equal(r.ok, true, failures(r));
  const c = getIos(w, 'r1').config;
  assert.equal(c.hostname, 'NEW');
  assert.equal(c.interfaces['GigabitEthernet0/0/1'].description, undefined);
  assert.equal(c.interfaces['GigabitEthernet0/0/1'].shutdown, true, 'not mentioned: factory default');
  assert.equal(c.interfaces['GigabitEthernet0/0/0'].shutdown, false, 'block without shutdown: enabled (boot semantics)');
  assert.equal(c.interfaces['GigabitEthernet0/0/2'].shutdown, true, 'explicit shutdown kept');
  const rt = getIos(w, 'r1').runtime;
  assert.deepEqual([rt.natTranslations, rt.dhcpBindings, rt.ikeSas, rt.aclHits, rt.qosCounters], [[], [], [], {}, {}]);
  assert.equal(rt.logBuffer.length, 1, 'the log buffer is not configuration');
});

test('save, erase and reload', () => {
  const w = routerWorld();
  const d = getIos(w, 'r1');
  saveStartupConfig(w, 'r1');
  assert.equal(d.startupConfig, renderRunningConfig(w, 'r1'));
  eraseStartupConfig(w, 'r1');
  assert.equal(d.startupConfig, null);
  // reload without startup-config: factory fresh, setup dialog again
  d.config.hostname = 'X';
  d.runtime.setupDialogDone = true;
  d.runtime.logBuffer.push({ tick: 1, severity: 5, mnemonic: 'X', text: 'y' });
  reloadDevice(w, 'r1');
  assert.deepEqual(d.config, defaultIosConfig('router', d.ports));
  assert.equal(d.runtime.setupDialogDone, false);
  assert.equal(d.runtime.logBuffer.length, 0);
  // reload with a startup-config (test-only commands)
  d.startupConfig = 'zz-name FROMNVRAM\nzz-if g0/0/1\n zz-desc saved\n';
  reloadDevice(w, 'r1');
  assert.equal(d.config.hostname, 'FROMNVRAM');
  assert.equal(d.config.interfaces['GigabitEthernet0/0/1'].description, 'saved');
  assert.equal(d.config.interfaces['GigabitEthernet0/0/1'].shutdown, false);
  assert.equal(d.runtime.setupDialogDone, true);
  assert.doesNotThrow(() => { reloadDevice(w, 'pc1'); saveStartupConfig(w, 'nope'); eraseStartupConfig(w, 'nope'); });
});

test('reload restores a saved configuration through the real CLI (system module)', (t) => {
  const gone = missing(['system']);
  if (gone.length) { t.skip(`command modules not delivered yet: ${gone.join(', ')}`); return; }
  const w = routerWorld();
  const d = getIos(w, 'r1');
  d.config.hostname = 'R1';
  d.config.ipDomainLookup = false;
  d.config.enableSecret = 'class';
  d.config.servicePasswordEncryption = true;
  d.config.bannerMotd = '\nAuthorised access only\n';
  saveStartupConfig(w, 'r1');
  reloadDevice(w, 'r1');
  assert.equal(d.config.hostname, 'R1');
  assert.equal(d.config.ipDomainLookup, false);
  assert.equal(d.config.enableSecret, 'class');
  assert.equal(d.config.servicePasswordEncryption, true);
  assert.equal(d.config.bannerMotd, '\nAuthorised access only\n');
});

test('secrets survive render → replace (system + line modules)', (t) => {
  const gone = missing(['system', 'line']);
  if (gone.length) { t.skip(`command modules not delivered yet: ${gone.join(', ')}`); return; }
  const c = r1Config();
  c.servicePasswordEncryption = true;
  c.enableSecret = 'class';
  c.enablePassword = 'enpass';
  c.lines.console = { login: true, password: 'conpass' };
  c.users = [{ name: 'admin', privilege: 15, secret: 'adminpw' }];
  const w = routerWorld(c);
  const text = renderRunningConfig(w, 'r1');
  const w2 = routerWorld();
  applyConfigText(w2, 'r1', text, 'replace');
  const back = getIos(w2, 'r1').config;
  assert.equal(back.enableSecret, 'class');
  assert.equal(back.enablePassword, 'enpass');
  assert.equal(back.lines.console.password, 'conpass');
  assert.equal(back.lines.vty[0]?.password, 'cisco');
  assert.deepEqual(back.users.map((u) => [u.name, u.secret]), [['admin', 'adminpw']]);
});

for (const [name, build, expected] of [['R1', r1Config, R1_RUNNING], ['R2', r2Config, R2_RUNNING]] as const) {
  test(`round trip: ${name} reference config → render → factory reset → apply → identical render`, (t) => {
    const gone = missing(ALL);
    if (gone.length) { t.skip(`round trip skipped: command modules not delivered yet: ${gone.join(', ')}`); return; }
    const w = routerWorld(build());
    const text = renderRunningConfig(w, 'r1');
    assert.ok(text.endsWith(expected));
    const w2 = routerWorld();
    const r = applyConfigText(w2, 'r1', text, 'replace');
    assert.equal(r.failed, 0, failures(r));
    assert.equal(renderRunningConfig(w2, 'r1'), text);
    // a second replace with the same text changes nothing
    applyConfigText(w2, 'r1', text, 'replace');
    assert.equal(renderRunningConfig(w2, 'r1'), text);
  });

  test(`course listing: ${name} as typed in docs/COURSE.md → replace → same running-config as the reference object`, (t) => {
    const gone = missing(ALL);
    if (gone.length) { t.skip(`skipped: command modules not delivered yet: ${gone.join(', ')}`); return; }
    const w = routerWorld();
    const r = applyConfigText(w, 'r1', name === 'R1' ? R1_COURSE : R2_COURSE, 'replace');
    assert.equal(r.failed, 0, failures(r));
    assert.equal(renderRunningConfig(w, 'r1'), renderRunningConfig(routerWorld(build()), 'r1'));
  });
}

test('round trip: a configuration that uses every rendered section (all command modules)', (t) => {
  const gone = missing(ALL);
  if (gone.length) { t.skip(`skipped: command modules not delivered yet: ${gone.join(', ')}`); return; }
  const c = r1Config();
  c.servicePasswordEncryption = true;
  c.enableSecret = 'class';
  c.bannerMotd = '\nAuthorised access only\n';
  c.users = [{ name: 'admin', privilege: 15, secret: 'adminpw' }];
  c.interfaces['GigabitEthernet0/0/1'] = { name: 'GigabitEthernet0/0/1', shutdown: false, description: 'spare LAN', ip: { address: '10.1.1.1', mask: '255.255.255.0' }, aclOut: 'matchPriority', noIpUnreachables: true };
  c.interfaces['Serial0/1/1'] = { name: 'Serial0/1/1', shutdown: true, encapsulation: 'ppp', ip: { address: '10.2.2.1', mask: '255.255.255.252' } };
  c.ospf = [{ processId: 1, routerId: '1.1.1.1', networks: [{ address: '10.1.1.0', wildcard: '0.0.0.255', area: '0' }], passive: ['GigabitEthernet0/0/1'] }];
  c.nat.pools = [{ name: 'P', start: '60.50.30.5', end: '60.50.30.6', mask: '255.255.255.252' }];
  c.acls['2'] = acl2();
  c.nat.dynamicRules.push({ acl: '2', pool: 'P', overload: true });
  c.snmp.location = 'D105';
  c.snmp.contact = 'student';
  c.logging.trapLevel = 'debugging';
  c.lines.console = { login: true, password: 'conpass', loggingSynchronous: true, execTimeout: [0, 0] };
  c.dhcp.pools[0].dnsServers = ['8.8.8.8'];
  const w = routerWorld(c);
  const text = renderRunningConfig(w, 'r1');
  const w2 = routerWorld();
  const r = applyConfigText(w2, 'r1', text, 'replace');
  assert.equal(r.failed, 0, failures(r));
  assert.equal(renderRunningConfig(w2, 'r1'), text);
});
function acl2() { const a = r1Config().acls['1']; return { ...a, id: '2' }; }

test('round trip: Catalyst switch with VLANs, access/trunk ports, Vlan1 and default gateway', (t) => {
  const gone = missing(['system', 'interface', 'line']).concat(MODULES_SWITCH.commands.length ? [] : ['switch']);
  if (gone.length) { t.skip(`skipped: command modules not delivered yet: ${gone.join(', ')}`); return; }
  const w = createWorld();
  addDevice(w, { id: 'sw1', model: 'c9300l', label: 'SW1', x: 0, y: 0 });
  const c = getIos(w, 'sw1').config;
  c.hostname = 'SW1';
  c.vlans['10'] = { name: 'Users' };
  c.interfaces['GigabitEthernet1/0/1'] = { name: 'GigabitEthernet1/0/1', shutdown: false, description: 'PC1', switchport: { mode: 'access', accessVlan: 10 } };
  c.interfaces['GigabitEthernet1/0/24'] = { name: 'GigabitEthernet1/0/24', shutdown: false, switchport: { mode: 'trunk', accessVlan: 1 } };
  c.interfaces['GigabitEthernet1/0/5'] = { name: 'GigabitEthernet1/0/5', shutdown: true, switchport: { mode: 'dynamic', accessVlan: 1 } };
  c.interfaces['Vlan1'] = { name: 'Vlan1', shutdown: false, ip: { address: '192.168.100.2', mask: '255.255.255.0' } };
  c.defaultGateway = '192.168.100.1';
  const text = renderRunningConfig(w, 'sw1');
  const w2 = createWorld();
  addDevice(w2, { id: 'sw1', model: 'c9300l', label: 'SW1', x: 0, y: 0 });
  const r = applyConfigText(w2, 'sw1', text, 'replace');
  assert.equal(r.failed, 0, failures(r));
  assert.equal(renderRunningConfig(w2, 'sw1'), text);
});

test('save → reload brings back the full R1 configuration with interfaces enabled', (t) => {
  const gone = missing(ALL);
  if (gone.length) { t.skip(`skipped: command modules not delivered yet: ${gone.join(', ')}`); return; }
  const w = routerWorld(r1Config());
  const before = renderRunningConfig(w, 'r1');
  saveStartupConfig(w, 'r1');
  getIos(w, 'r1').runtime.natTranslations.push({ id: 9, proto: 'icmp', insideLocal: 'a', insideLocalPort: 1, insideGlobal: 'b', insideGlobalPort: 1, outsideLocal: 'c', outsideLocalPort: 1, outsideGlobal: 'c', outsideGlobalPort: 1, createdTick: 0 });
  reloadDevice(w, 'r1');
  const d = getIos(w, 'r1');
  assert.equal(renderRunningConfig(w, 'r1'), before);
  assert.equal(d.config.interfaces['GigabitEthernet0/0/0'].shutdown, false);
  assert.equal(d.config.interfaces['Serial0/1/0'].shutdown, false);
  assert.equal(d.config.interfaces['GigabitEthernet0/0/1'].shutdown, true);
  assert.equal(d.runtime.natTranslations.length, 0);
  assert.equal(d.runtime.setupDialogDone, true);
});

test('a file closes sections at bare ! and explicit global prompts; never uses a mismatched sub-mode', () => {
  const w = routerWorld();
  const d = getIos(w, 'r1');
  const r = applyConfigText(w, 'r1', [
    'Router#show running-config', 'Router#configure termin', 'Router(config)#interface g0/0/0',
    'Router(config-if)#description kept', '!', ' description orphan',
    'Router(config-if)#description wrong-mode', 'Router(config)#interface g0/0/1',
    'Router(config-router)#description wrong-mode-again', 'Router(config-if)#description correct', 'Router(config-if)#end', 'hostname NotRun',
  ].join('\r\n'), 'merge');
  assert.deepEqual(r.lines.filter((x) => !x.ok).map((x) => x.lineNo), [6, 7, 9]);
  assert.match(r.lines.find((l) => l.lineNo === 7)!.output, /Pasted prompt expects config-if/);
  assert.equal(d.config.interfaces['GigabitEthernet0/0/0'].description, 'kept');
  assert.equal(d.config.interfaces['GigabitEthernet0/0/1'].description, 'correct');
  assert.equal(d.config.hostname, 'Router');
});

test('invalid replacements and comments-only files leave running, startup and runtime untouched', () => {
  const w = routerWorld();
  const d = getIos(w, 'r1');
  d.config.hostname = 'OldName';
  saveStartupConfig(w, 'r1');
  d.runtime.logBuffer.push({ tick: 1, severity: 5, mnemonic: 'X', text: 'old' });
  const before = structuredClone(w);
  for (const text of ['! waiting for a console\nend', 'hostname Candidate\nnot-a-command', 'hostname Candidate\nbanner motd @unterminated\nhostname NotRun\nend']) {
    const r = applyConfigText(w, 'r1', text, 'replace');
    assert.deepEqual([r.ok, r.applied], [false, 0], text);
    assert.match(r.message ?? '', /not changed/);
    assert.deepEqual(w, before);
  }
});

test('configuration files never run EXEC actions or swallow the line after an interactive command', () => {
  const w = routerWorld();
  const d = getIos(w, 'r1');
  d.config.hostname = 'LabRouter';
  assert.equal(applyConfigText(w, 'r1', 'ip domain name lab.invalid', 'merge').ok, true);
  const r = applyConfigText(w, 'r1', 'do write memory\ncrypto key generate rsa\nhostname StillHere\nend\n', 'merge');
  assert.deepEqual(r.lines.map((l) => l.ok), [false, false, true]);
  assert.match(r.lines[0].output, /EXEC commands are not run/);
  assert.match(r.lines[1].output, /requires interactive input/);
  assert.equal(d.startupConfig, null);
  assert.equal(d.config.hostname, 'StillHere');
});

test('configuration files reject unsupported encrypted credentials without echoing the material', () => {
  const w = routerWorld();
  const r = applyConfigText(w, 'r1', 'enable secret 9 $9$synthetic-unusable\nhostname Allowed\n', 'merge');
  assert.match(r.lines[0].output, /encrypted credential is not supported/);
  assert.doesNotMatch(JSON.stringify(r), /synthetic-unusable/);
  assert.equal(getIos(w, 'r1').config.enableSecret, undefined);
  assert.equal(getIos(w, 'r1').config.hostname, 'Allowed');
});

test('save and reload preserve toy passwords beginning with what would otherwise parse as a type', () => {
  const w = routerWorld();
  const d = getIos(w, 'r1');
  for (const encrypted of [false, true]) {
    d.config.servicePasswordEncryption = encrypted;
    d.config.enablePassword = '7 lab-only-value';
    d.config.enableSecret = '9 lab-only-value';
    d.config.lines.console.password = '0 lab-only-value';
    saveStartupConfig(w, 'r1');
    reloadDevice(w, 'r1');
    assert.equal(d.config.enablePassword, '7 lab-only-value');
    assert.equal(d.config.enableSecret, '9 lab-only-value');
    assert.equal(d.config.lines.console.password, '0 lab-only-value');
  }
});
