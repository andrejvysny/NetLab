/** What happens around an action: interface up/down messages (console, log buffer, syslog server), %SYS-5-CONFIG_I, DHCP clients. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GI, R2_CONFIG, SE, buildSolution, cableBench, cableId, consoleToConfig, makeLab, ok, openConsole, plugConsole, port, type, typeConfig, world,
} from './fixture.ts';
import type { IosDevice, PcDevice } from '../../src/engine/types.ts';

function start(id = 'mini', mode: 'guided' | 'free' | 'exam' = 'free') {
  const h = makeLab();
  ok(h.lab.startScenario(id, mode));
  return h;
}
type L = ReturnType<typeof start>['lab'];
const ios = (lab: L, id: string) => world(lab).devices[id] as IosDevice;
const pc = (lab: L, id: string) => world(lab).devices[id] as PcDevice;
const logs = (lab: L, id: string) => ios(lab, id).runtime.logBuffer.map((m) => `%${m.mnemonic}: ${m.text}`);
const STAMP = String.raw`\*Mar  1 \d\d:\d\d:\d\d\.\d\d\d: `;

test('no shutdown / shutdown print the IOS messages on the console that typed them', () => {
  const { lab } = start();
  cableBench(lab);
  const id = consoleToConfig(lab, 'PC1', 'R1');
  type(lab, id, [`interface ${GI}`]);
  const up = lab.sessionExec(id, 'no shutdown');
  assert.match(up.output, new RegExp(`^${STAMP}%LINK-3-UPDOWN: Interface GigabitEthernet0/0/0, changed state to up\n${STAMP}%LINEPROTO-5-UPDOWN: Line protocol on Interface GigabitEthernet0/0/0, changed state to up\n$`));
  const down = lab.sessionExec(id, 'shutdown');
  assert.match(down.output, new RegExp(`^${STAMP}%LINK-5-CHANGED: Interface GigabitEthernet0/0/0, changed state to administratively down\n${STAMP}%LINEPROTO-5-UPDOWN: Line protocol on Interface GigabitEthernet0/0/0, changed state to down\n$`));
  // an interface without a usable link: administratively down → down
  type(lab, id, ['interface g0/0/1']);
  const nolink = lab.sessionExec(id, 'no shutdown');
  assert.match(nolink.output, new RegExp(`^${STAMP}%LINK-3-UPDOWN: Interface GigabitEthernet0/0/1, changed state to down\n$`));
  // a new loopback reports its line protocol only
  const lo = lab.sessionExec(id, 'interface loopback 0');
  assert.match(lo.output, new RegExp(`^${STAMP}%LINEPROTO-5-UPDOWN: Line protocol on Interface Loopback0, changed state to up\n$`));
  // nothing changes → nothing printed
  assert.equal(lab.sessionExec(id, 'no shutdown').output, '');
  assert.deepEqual(logs(lab, 'R1'), [
    '%LINK-3-UPDOWN: Interface GigabitEthernet0/0/0, changed state to up',
    '%LINEPROTO-5-UPDOWN: Line protocol on Interface GigabitEthernet0/0/0, changed state to up',
    '%LINK-5-CHANGED: Interface GigabitEthernet0/0/0, changed state to administratively down',
    '%LINEPROTO-5-UPDOWN: Line protocol on Interface GigabitEthernet0/0/0, changed state to down',
    '%LINK-3-UPDOWN: Interface GigabitEthernet0/0/1, changed state to down',
    '%LINEPROTO-5-UPDOWN: Line protocol on Interface Loopback0, changed state to up',
  ]);
});

test('leaving configuration mode logs %SYS-5-CONFIG_I (end, exit, Ctrl-Z)', () => {
  const { lab } = start();
  const id = consoleToConfig(lab, 'PC1', 'R1');
  const end = lab.sessionExec(id, 'end');
  assert.match(end.output, new RegExp(`^${STAMP}%SYS-5-CONFIG_I: Configured from console by console\n$`));
  type(lab, id, ['configure terminal', 'interface loopback 1']);
  assert.equal(lab.sessionExec(id, 'exit').output, '', 'config-if → config is not leaving configuration mode');
  assert.match(lab.sessionExec(id, 'exit').output, /%SYS-5-CONFIG_I/);
  type(lab, id, ['configure terminal']);
  assert.match(lab.sessionKey(id, 'ctrl-z').output, /^\^Z\n.*%SYS-5-CONFIG_I: Configured from console by console\n$/);
  assert.equal(logs(lab, 'R1').filter((l) => /CONFIG_I/.test(l)).length, 3);
});

test('a link change caused on the bench shows up on the open console with the next output', () => {
  const { lab } = start();
  cableBench(lab);
  const id = consoleToConfig(lab, 'PC1', 'R1');
  type(lab, id, [`interface ${GI}`, 'no shutdown', 'end']);
  ok(lab.removeCable(cableId(lab, port('PC1', 'Ethernet0'))));
  assert.equal(lab.portStatus(port('R1', GI)).status, 'down/down');
  const v = lab.sessionExec(id, 'show running-config | include hostname');
  assert.match(v.output, new RegExp(`^${STAMP}%LINK-3-UPDOWN: Interface GigabitEthernet0/0/0, changed state to down\n${STAMP}%LINEPROTO-5-UPDOWN: Line protocol on Interface GigabitEthernet0/0/0, changed state to down\nhostname Router\n$`));
  assert.equal(lab.sessionExec(id, 'show running-config | include hostname').output, 'hostname Router\n', 'shown once');
  // just pressing Enter also brings the waiting messages
  ok(lab.connectCable('crossover', port('PC1', 'Ethernet0'), port('R1', GI)));
  assert.match(lab.sessionExec(id, '').output, /changed state to up/);
  // messages for a console nobody is watching are not kept
  plugConsole(lab, 'PC1', 'R2');
  ok(lab.removeCable(cableId(lab, port('PC1', 'Ethernet0'))));
  plugConsole(lab, 'PC1', 'R1');
  const back = lab.openConsole('R1');
  assert.ok(back.ok && back.banner === '');
  assert.equal(lab.sessionExec(id, '').output, '');
  assert.equal(logs(lab, 'R1').at(-1), '%LINEPROTO-5-UPDOWN: Line protocol on Interface GigabitEthernet0/0/0, changed state to down', 'the log buffer has them all');
});

test('the far end of a link logs too, and messages reach a syslog server PC', () => {
  const { lab } = start();
  buildSolution(lab); // R1 has "logging 10.0.1.10"; PC1 runs the syslog server
  assert.deepEqual(pc(lab, 'PC1').runtime.syslog, []);
  plugConsole(lab, 'PC1', 'R1');
  const id = openConsole(lab, 'R1');
  type(lab, id, ['enable', 'configure terminal', `interface ${SE}`]);
  const down = lab.sessionExec(id, 'shutdown');
  assert.match(down.output, /%LINK-5-CHANGED: Interface Serial0\/1\/0, changed state to administratively down/);
  assert.doesNotMatch(down.output, /R2|Serial0\/1\/0, changed state to down\n.*Serial0\/1\/0, changed state to down/s, 'only R1 messages on the R1 console');
  assert.deepEqual(logs(lab, 'R2').slice(-2), [
    '%LINK-3-UPDOWN: Interface Serial0/1/0, changed state to down',
    '%LINEPROTO-5-UPDOWN: Line protocol on Interface Serial0/1/0, changed state to down',
  ]);
  const got = pc(lab, 'PC1').runtime.syslog;
  assert.deepEqual(got.map((m) => [m.from, m.severity, m.mnemonic, m.text]), [
    ['10.0.1.1', 5, 'LINK-5-CHANGED', 'Interface Serial0/1/0, changed state to administratively down'],
    ['10.0.1.1', 5, 'LINEPROTO-5-UPDOWN', 'Line protocol on Interface Serial0/1/0, changed state to down'],
  ]);
  type(lab, id, ['no shutdown']);
  lab.sessionExec(id, 'end');
  const all = pc(lab, 'PC1').runtime.syslog.map((m) => m.mnemonic);
  assert.deepEqual(all.slice(2), ['LINK-3-UPDOWN', 'LINEPROTO-5-UPDOWN', 'SYS-5-CONFIG_I']);
  // the UI sees the new messages: the state was republished with them
  const pcInState = lab.getState().world!.devices.PC1 as PcDevice;
  assert.equal(pcInState.runtime.syslog.length, 5);
  lab.clearPcLog('PC1', 'syslog');
  assert.deepEqual(pc(lab, 'PC1').runtime.syslog, []);
  lab.clearPcLog('PC1', 'nothing' as never);
  lab.clearPcLog('R1', 'syslog');
});

test('applying a config file logs like pasting it on the console', () => {
  const { lab } = start();
  cableBench(lab);
  plugConsole(lab, 'PC1', 'R2');
  const id = openConsole(lab, 'R2');
  type(lab, id, ['no', '']);
  const rep = lab.applyConfigText('R2', R2_CONFIG, 'merge');
  assert.equal(rep.ok, true);
  const v = lab.sessionExec(id, '');
  assert.match(v.output, /%SYS-5-CONFIG_I: Configured from console by console/);
  assert.match(v.output, /%LINK-3-UPDOWN: Interface GigabitEthernet0\/0\/0, changed state to up/);
  assert.match(v.output, /%LINK-3-UPDOWN: Interface Serial0\/1\/0, changed state to down/, 'R1 is still shut down');
  assert.equal(v.prompt, 'R2>', 'the prompt follows the new hostname');
  assert.equal(lab.getState().sessions.find((s) => s.id === id)?.prompt, 'R2>');
});

test('DHCP: a PC that was told to use DHCP keeps asking and gets its address once the network is ready', () => {
  const { lab } = start();
  cableBench(lab);
  const early = lab.setPcNic('PC2', { mode: 'dhcp' });
  assert.equal(early.ok, false);
  assert.equal(early.message, 'PC2 cannot ask for an address: its network link is down. The other end of the cable (R2 GigabitEthernet0/0/0) is shut down. '
    + 'Enter "no shutdown" there. PC2 keeps asking. It gets an address as soon as a server answers.');
  assert.equal(pc(lab, 'PC2').nic.mode, 'dhcp');
  assert.equal(pc(lab, 'PC2').nic.address, undefined);
  const id = consoleToConfig(lab, 'PC1', 'R2');
  // type R2's configuration line by line; watch for the moment PC2 gets its lease
  let gotAfter = '';
  for (const raw of R2_CONFIG.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    lab.sessionExec(id, line);
    if (!gotAfter && pc(lab, 'PC2').nic.address) gotAfter = line;
  }
  assert.equal(gotAfter, 'no shutdown', 'the lease arrives with the line that brings the LAN interface up');
  assert.deepEqual(pc(lab, 'PC2').nic, { mode: 'dhcp', mac: pc(lab, 'PC2').nic.mac, address: '10.0.2.2', mask: '255.255.255.0', gateway: '10.0.2.1', dhcpServer: '10.0.2.1' });
  assert.equal(ios(lab, 'R2').runtime.dhcpBindings.length, 1);
});

test('DHCP: a PC nobody has set up does not grab an address; a static PC gives its lease back', () => {
  const { lab } = start();
  cableBench(lab);
  const id = consoleToConfig(lab, 'PC1', 'R1');
  assert.deepEqual(typeConfig(lab, id, `interface ${GI}\nip address 10.0.1.1 255.255.255.0\nno shutdown\nexit\nip dhcp pool LAN1\nnetwork 10.0.1.0 255.255.255.0\ndefault-router 10.0.1.1\nend`), []);
  assert.equal(pc(lab, 'PC1').nic.mode, 'dhcp', 'factory setting of the adapter');
  assert.equal(pc(lab, 'PC1').nic.address, undefined, 'PC1 was never told to ask');
  const asked = ok(lab.setPcNic('PC1', { mode: 'dhcp' }));
  assert.match(asked.message ?? '', /^Address received: 10\.0\.1\.2 with mask 255\.255\.255\.0, gateway 10\.0\.1\.1\.$/);
  assert.equal(ios(lab, 'R1').runtime.dhcpBindings.length, 1);
  // asking again keeps the address
  ok(lab.setPcNic('PC1', { mode: 'dhcp' }));
  assert.equal(pc(lab, 'PC1').nic.address, '10.0.1.2');
  // going static releases the lease on the server
  ok(lab.setPcNic('PC1', { mode: 'static', address: '10.0.1.10', mask: '255.255.255.0', gateway: '10.0.1.1' }));
  assert.deepEqual(ios(lab, 'R1').runtime.dhcpBindings, []);
  assert.deepEqual(pc(lab, 'PC1').nic, { mode: 'static', mac: pc(lab, 'PC1').nic.mac, address: '10.0.1.10', mask: '255.255.255.0', gateway: '10.0.1.1' });
  // and a static PC never asks again
  type(lab, id, ['configure terminal', `interface ${GI}`, 'shutdown', 'no shutdown']);
  assert.equal(pc(lab, 'PC1').nic.address, '10.0.1.10');
});

test('DHCP: the lease goes with the link and comes back with it', () => {
  const { lab } = start('mini-prebuilt');
  assert.equal(pc(lab, 'PC2').nic.address, '10.0.2.2');
  plugConsole(lab, 'PC1', 'R2');
  const id = openConsole(lab, 'R2');
  type(lab, id, ['enable', 'configure terminal', `interface ${GI}`, 'shutdown']);
  assert.equal(pc(lab, 'PC2').nic.address, undefined);
  assert.equal(pc(lab, 'PC2').nic.mode, 'dhcp');
  type(lab, id, ['no shutdown']);
  assert.equal(pc(lab, 'PC2').nic.address, '10.0.2.2');
  // same with the cable
  const cable = cableId(lab, port('PC2', 'Ethernet0'));
  ok(lab.removeCable(cable));
  assert.equal(pc(lab, 'PC2').nic.address, undefined);
  ok(lab.connectCable('crossover', port('PC2', 'Ethernet0'), port('R2', GI)));
  assert.equal(pc(lab, 'PC2').nic.address, '10.0.2.2');
  // "ipconfig /release" switches the client off until "ipconfig /renew"
  assert.equal(lab.pcExec('PC2', 'ipconfig /release').output, 'Address released.\n');
  type(lab, id, ['shutdown', 'no shutdown']);
  assert.equal(pc(lab, 'PC2').nic.address, undefined);
  assert.equal(lab.pcExec('PC2', 'ipconfig /renew').output, 'IPv4 Address: 10.0.2.2\n');
  const j = lab.getState().journal.filter((e) => e.via === 'pc').map((e) => [e.line, e.feature, e.mutated]);
  assert.deepEqual(j, [['ipconfig /release', 'pc', true], ['ipconfig /renew', 'pc', true]]);
});

test('exam mode: a failed DHCP request says nothing about the reason', () => {
  const { lab } = start('mini', 'exam');
  const r = lab.setPcNic('PC2', { mode: 'dhcp' });
  assert.deepEqual(r, { ok: false, message: 'No DHCP server answered. PC2 has no address. It keeps asking.' });
});
