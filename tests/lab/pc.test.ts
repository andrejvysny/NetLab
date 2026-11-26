/** PCs: network settings, services, the command prompt, Telnet into a router (vty session), SNMP. */
import { test } from 'node:test';
import { pcExec as realPcExec } from '../../src/engine/pc/cmd.ts';
import assert from 'node:assert/strict';
import { buildSolution, makeLab, miniScenario, ok, openConsole, plugConsole, type, world } from './fixture.ts';
import type { IosDevice, PcDevice } from '../../src/engine/types.ts';
import { Lab } from '../../src/engine/lab.ts';

function start(id = 'mini', mode: 'guided' | 'free' | 'exam' = 'free') {
  const h = makeLab();
  ok(h.lab.startScenario(id, mode));
  return h;
}
type L = ReturnType<typeof start>['lab'];
const ios = (lab: L, id: string) => world(lab).devices[id] as IosDevice;
const pc = (lab: L, id: string) => world(lab).devices[id] as PcDevice;

test('setPcNic static: bad input is refused with a plain message and changes nothing', () => {
  const { lab } = start();
  const before = lab.getState();
  const no = (nic: Record<string, unknown>, re: RegExp) => {
    const r = lab.setPcNic('PC1', { mode: 'static', ...nic } as never);
    assert.equal(r.ok, false, JSON.stringify(nic));
    assert.match(r.message ?? '', re, JSON.stringify(nic));
  };
  no({}, /Type an IP address for PC1/);
  no({ address: '10.0.1', mask: '255.255.255.0' }, /"10\.0\.1" is not an IP address/);
  no({ address: '10.0.1.300', mask: '255.255.255.0' }, /is not an IP address/);
  no({ address: '10.0.1.10' }, /Type a subnet mask/);
  no({ address: '10.0.1.10', mask: '255.0.255.0' }, /255\.0\.255\.0 is not a valid subnet mask/);
  no({ address: '10.0.1.10', mask: '0.0.0.0' }, /not a valid subnet mask/);
  no({ address: '10.0.1.10', mask: '24' }, /"24" is not a subnet mask/);
  no({ address: '10.0.1.0', mask: '255.255.255.0' }, /is the network address of 10\.0\.1\.0\/24/);
  no({ address: '10.0.1.255', mask: '255.255.255.0' }, /is the broadcast address/);
  no({ address: '127.0.0.1', mask: '255.0.0.0' }, /reserved for the PC itself/);
  no({ address: '224.1.1.1', mask: '255.255.255.0' }, /multicast/);
  no({ address: '0.1.1.1', mask: '255.255.255.0' }, /reserved/);
  no({ address: '10.0.1.10', mask: '255.255.255.255' }, /leaves no room for hosts/);
  no({ address: '10.0.1.10', mask: '255.255.255.0', gateway: 'router' }, /"router" is not an IP address/);
  no({ address: '10.0.1.10', mask: '255.255.255.0', dns: '8.8.8' }, /DNS server/);
  assert.equal(lab.setPcNic('PC1', { mode: 'wifi' } as never).ok, false);
  assert.equal(lab.setPcNic('PC1', null as never).ok, false);
  assert.match(lab.setPcNic('R1', { mode: 'dhcp' }).message ?? '', /R1 is not a PC/);
  assert.match(lab.setPcNic('PC9', { mode: 'dhcp' }).message ?? '', /not on the bench/);
  assert.equal(lab.getState(), before);
});

test('setPcNic static stores the settings (a wrong but possible gateway is accepted) and journals the action', () => {
  const { lab } = start();
  ok(lab.setPcNic('PC1', { mode: 'static', address: ' 10.0.1.10 ', mask: '255.255.255.0', gateway: '10.0.9.1', dns: '8.8.8.8' }));
  assert.deepEqual(pc(lab, 'PC1').nic, { mode: 'static', mac: pc(lab, 'PC1').nic.mac, address: '10.0.1.10', mask: '255.255.255.0', gateway: '10.0.9.1', dns: '8.8.8.8' });
  ok(lab.setPcNic('PC1', { mode: 'static', address: '10.0.1.10', mask: '255.255.255.0' }));
  assert.equal(pc(lab, 'PC1').nic.gateway, undefined, 'an empty gateway clears the old one');
  const j = lab.getState().journal;
  assert.deepEqual(j.map((e) => [e.via, e.feature, e.ok, e.mutated, e.line]), [
    ['pc', 'pc', true, true, 'Network: static 10.0.1.10 255.255.255.0 gateway 10.0.9.1 dns 8.8.8.8'],
    ['pc', 'pc', true, true, 'Network: static 10.0.1.10 255.255.255.0'],
  ]);
});

test('setPcService switches services and ignores nonsense', () => {
  const { lab } = start();
  lab.setPcService('PC1', 'http', true);
  lab.setPcService('PC1', 'syslog', true);
  assert.deepEqual(pc(lab, 'PC1').services, { http: true, ftp: false, telnet: false, syslog: true });
  const s = lab.getState();
  lab.setPcService('PC1', 'http', true); // already on
  lab.setPcService('PC1', 'smtp' as never, true);
  lab.setPcService('PC1', 'ftp', 'yes' as never);
  lab.setPcService('R1', 'http', true);
  assert.equal(lab.getState(), s);
  lab.setPcService('PC1', 'http', false);
  assert.equal(pc(lab, 'PC1').services.http, false);
  assert.deepEqual(lab.getState().journal.map((e) => e.line), ['Service http on', 'Service syslog on', 'Service http off']);
});

test('pcExec runs the PC command prompt and journals commands as verification', () => {
  const { lab } = start('mini-prebuilt');
  const rev = lab.getState().rev;
  assert.deepEqual(lab.pcExec('PC1', 'ping 10.0.12.2'), { output: 'Reply from 10.0.12.2\n' });
  assert.deepEqual(lab.pcExec('PC1', 'ping 10.9.9.9'), { output: 'Request timed out.\n', delayMs: 2000 });
  assert.deepEqual(lab.pcExec('PC1', 'cls'), { output: '', clear: true });
  assert.deepEqual(lab.pcExec('PC1', '   '), { output: '' });
  assert.deepEqual(lab.pcExec('R1', 'ping 10.0.1.1'), { output: '' });
  assert.deepEqual(lab.pcExec('PC1', 'boom'), { output: 'This command could not be run: boom\n\n' });
  assert.deepEqual(lab.getState().journal.map((e) => [e.deviceId, e.via, e.line, e.feature, e.mutated]), [
    ['PC1', 'pc', 'ping 10.0.12.2', 'verify', false],
    ['PC1', 'pc', 'ping 10.9.9.9', 'verify', false],
    ['PC1', 'pc', 'cls', 'verify', false],
    ['PC1', 'pc', 'boom', 'verify', false],
  ]);
  assert.equal(lab.getState().rev, rev + 4);
});

test('with the real src/engine/pc/cmd.ts a command never throws through the Lab', () => {
  const lab = new Lab({ scenarios: [miniScenario()], storage: null });
  ok(lab.startScenario('mini', 'free'));
  const v = lab.pcExec('PC1', 'ipconfig');
  assert.equal(typeof v.output, 'string');
});

test('telnet from a PC opens a vty session on the router; exit ends it', () => {
  const { lab } = start('mini-prebuilt');
  const refused = lab.pcExec('PC1', 'telnet 10.9.9.9');
  assert.equal(refused.session, undefined);
  const open = lab.pcExec('PC1', 'telnet 10.0.12.2');
  assert.equal(open.output, 'Trying 10.0.12.2 ... Open\n');
  assert.equal(open.banner, '\nUser Access Verification\n\n');
  const s = open.session!;
  assert.deepEqual(s, {
    id: s.id, deviceId: 'R2', kind: 'telnet', pcId: 'PC1', title: 'Telnet 10.0.12.2 — from PC1',
    prompt: 'Password: ', secret: true, closed: false, termLength: 24, pendingInput: { kind: 'password', paste: 'manual' },
  });
  assert.equal(ios(lab, 'R2').runtime.vtyInUse, 1);
  assert.deepEqual(lab.getState().sessions, [s]);
  const login = lab.sessionExec(s.id, 'cisco');
  assert.deepEqual([login.prompt, login.secret], ['R2>', false]);
  assert.equal(lab.getState().sessions[0].prompt, 'R2>');
  // enable needs a password on a vty: none is set
  assert.match(lab.sessionExec(s.id, 'enable').output, /% No password set/);
  // a second session takes the next line
  const two = lab.pcExec('PC1', 'telnet 10.0.12.2').session!;
  assert.equal(ios(lab, 'R2').runtime.vtyInUse, 2);
  assert.notEqual(two.id, s.id);
  lab.closeSession(two.id);
  assert.equal(ios(lab, 'R2').runtime.vtyInUse, 1);
  const bye = lab.sessionExec(s.id, 'exit');
  assert.equal(bye.closed, true);
  assert.equal(ios(lab, 'R2').runtime.vtyInUse, 0);
  assert.deepEqual(lab.getState().sessions, []);
  assert.equal(lab.sessionExec(s.id, 'show running-config').closed, true);
  // typed lines are journaled as vty; the password is not
  const vty = lab.getState().journal.filter((e) => e.via === 'vty').map((e) => [e.deviceId, e.mode, e.line, e.ok]);
  assert.deepEqual(vty, [['R2', 'user', 'enable', false], ['R2', 'user', 'exit', true]]);
  assert.ok(!lab.getState().journal.some((e) => e.line === 'cisco'));
});

test('telnet: configuring over a vty logs the remote address; a line without a password closes at once', () => {
  const { lab } = start('mini-prebuilt');
  plugConsole(lab, 'PC1', 'R2');
  const con = openConsole(lab, 'R2');
  type(lab, con, ['enable', 'configure terminal', 'enable secret class', 'end']);
  const s = lab.pcExec('PC1', 'telnet 10.0.12.2').session!;
  type(lab, s.id, ['cisco', 'enable', 'class', 'configure terminal', 'interface loopback 7']);
  const end = lab.sessionExec(s.id, 'end');
  assert.equal(end.output, '', 'no console messages on a vty');
  assert.equal(ios(lab, 'R2').runtime.logBuffer.at(-1)?.text, 'Configured from console by vty0 (10.0.1.10)');
  // … but the console of R2 shows them
  assert.match(lab.sessionExec(con, '').output, /%LINEPROTO-5-UPDOWN: Line protocol on Interface Loopback7, changed state to up\n.*%SYS-5-CONFIG_I: Configured from console by vty0 \(10\.0\.1\.10\)/);
  // remove the vty password: the next connection is closed by the router
  type(lab, con, ['configure terminal', 'line vty 0 4', 'no password', 'end']);
  lab.closeSession(s.id);
  const closed = lab.pcExec('PC1', 'telnet 10.0.12.2');
  assert.match(closed.banner ?? '', /Password required, but none set/);
  assert.equal(closed.session?.closed, true);
  assert.equal(ios(lab, 'R2').runtime.vtyInUse, 0);
  assert.deepEqual(lab.getState().sessions.map((x) => x.kind), ['console']);
});

test('reload over Telnet closes every session on the router and restarts its console', () => {
  const { lab } = start('mini-prebuilt');
  plugConsole(lab, 'PC1', 'R2');
  const con = openConsole(lab, 'R2');
  type(lab, con, ['enable', 'configure terminal', 'enable secret class', 'end', 'write memory', 'configure terminal', 'interface loopback 3']);
  assert.equal(lab.getState().sessions[0].prompt, 'R2(config-if)#');
  const a = lab.pcExec('PC1', 'telnet 10.0.12.2').session!;
  const b = lab.pcExec('PC1', 'telnet 10.0.12.2').session!;
  type(lab, a.id, ['cisco', 'enable', 'class']);
  type(lab, b.id, ['cisco']);
  type(lab, a.id, ['reload', 'no']);
  const gone = lab.sessionExec(a.id, '');
  assert.equal(gone.closed, true);
  assert.equal(lab.sessionExec(b.id, 'show running-config').closed, true, 'the other vty session is gone too');
  assert.equal(ios(lab, 'R2').runtime.vtyInUse, 0);
  assert.equal(ios(lab, 'R2').config.interfaces.Loopback3, undefined, 'unsaved work is lost');
  const views = lab.getState().sessions;
  assert.deepEqual(views.map((v) => [v.kind, v.prompt, v.closed]), [['console', 'R2>', false]], 'the console starts again at the user prompt');
  const next = lab.sessionExec(con, '');
  assert.match(next.output, /%SYS-5-RELOAD: Reload requested by vty0 \(10\.0\.1\.10\)[\s\S]*Press RETURN to get started!/);
  assert.equal(next.prompt, 'R2>');
});

test('pcSnmp sends a request through the network and validates its input', () => {
  const { lab } = start('mini-prebuilt');
  plugConsole(lab, 'PC1', 'R2');
  const con = openConsole(lab, 'R2');
  type(lab, con, ['enable', 'configure terminal', 'snmp-server community public RO', 'snmp-server community secret RW', 'end']);
  assert.deepEqual(lab.pcSnmp('PC1', { host: '10.0.12.2', community: 'public', op: 'get', oid: 'sysName.0' }), { ok: true, text: 'sysName.0 = STRING: R2' });
  assert.deepEqual(lab.pcSnmp('PC1', { host: '10.0.12.2', community: 'wrong', op: 'get', oid: 'sysName.0' }), { ok: false, text: 'Timeout: No Response from 10.0.12.2' });
  assert.equal(lab.pcSnmp('PC1', { host: '10.0.12.2', community: 'public', op: 'set', oid: 'sysLocation.0', value: 'Lab D105' }).ok, false, 'read-only community');
  assert.equal(lab.pcSnmp('PC1', { host: '10.0.12.2', community: 'secret', op: 'set', oid: 'sysLocation.0', value: 'Lab D105' }).ok, true);
  assert.equal(ios(lab, 'R2').config.snmp.location, 'Lab D105');
  const j = lab.getState().journal.filter((e) => e.via === 'pc');
  assert.deepEqual(j.map((e) => [e.line, e.feature, e.ok]), [
    ['snmpget -c public 10.0.12.2 sysName.0', 'verify', true],
    ['snmpget -c wrong 10.0.12.2 sysName.0', 'verify', false],
    ['snmpset -c public 10.0.12.2 sysLocation.0 = Lab D105', 'verify', false],
    ['snmpset -c secret 10.0.12.2 sysLocation.0 = Lab D105', 'snmp', true],
  ]);
  const s = lab.getState();
  assert.match(lab.pcSnmp('PC1', { host: 'r2', community: 'public', op: 'get', oid: 'sysName.0' }).text, /"r2" is not an IP address/);
  assert.match(lab.pcSnmp('PC1', { host: '10.0.12.2', community: '', op: 'get', oid: 'sysName.0' }).text, /community/);
  assert.match(lab.pcSnmp('PC1', { host: '10.0.12.2', community: 'public', op: 'get', oid: '' }).text, /OID/);
  assert.match(lab.pcSnmp('PC1', { host: '10.0.12.2', community: 'secret', op: 'set', oid: 'sysName.0' }).text, /new value/);
  assert.equal(lab.pcSnmp('R1', { host: '10.0.12.2', community: 'public', op: 'get', oid: 'sysName.0' }).ok, false);
  assert.equal(lab.pcSnmp('PC1', null as never).ok, false);
  assert.equal(lab.getState(), s);
});

test('the whole solution: PC2 reaches PC1 after buildSolution (sanity of the fixture PCs)', () => {
  const { lab } = start();
  buildSolution(lab);
  assert.equal(lab.pcExec('PC2', 'ping 10.0.1.10').output, 'Reply from 10.0.1.10\n');
});

test('guided SNMP SET is gated on the receiving device; GET remains a verification', () => {
  const { lab } = start('mini-prebuilt');
  plugConsole(lab, 'PC1', 'R2');
  ok(lab.applyConfigText('R2', 'snmp-server community lab-only-community RW\n', 'merge'));
  const saved = JSON.parse(lab.exportLab());
  saved.mode = 'guided';
  saved.guideReached = 0;
  saved.world.cables = saved.world.cables.filter((c: { a: { deviceId: string }; b: { deviceId: string } }) => c.a.deviceId !== 'PC2' && c.b.deviceId !== 'PC2');
  ok(lab.importLab(JSON.stringify(saved)));
  const request = { host: '10.0.12.2', community: 'lab-only-community', oid: 'sysLocation.0' };
  assert.equal(lab.pcSnmp('PC1', { ...request, op: 'get' }).ok, true);
  const result = lab.pcSnmp('PC1', { ...request, op: 'set', value: 'synthetic new location' });
  assert.equal(result.ok, false);
  assert.match(result.text, /SNMP.*not part of this step/);
  assert.equal(ios(lab, 'R2').config.snmp.location, undefined);
  const last = lab.getState().journal.at(-1)!;
  assert.deepEqual([last.deviceId, last.feature, last.mutated, last.blocked], ['R2', 'snmp', false, true]);
  assert.equal(last.line, 'snmpset -c lab-only-community 10.0.12.2 sysLocation.0 = synthetic new location');
});

test('Windows shell only stops or starts the DHCP client for actual ipconfig actions', () => {
  const { lab } = makeLab({ pcExec: realPcExec });
  ok(lab.startScenario('mini-prebuilt', 'free'));
  const asking = () => JSON.parse(lab.exportLab()).dhcpClients.includes('PC2');
  assert.equal(asking(), true);
  assert.match(lab.pcExec('PC2', 'echo release').output, /release/);
  assert.equal(asking(), true);
  lab.pcExec('PC2', 'ipconfig/release');
  assert.equal(asking(), false);
  lab.pcExec('PC2', 'echo dhcp renew');
  assert.equal(asking(), false);
  lab.pcExec('PC2', 'ipconfig.exe /renew');
  assert.equal(asking(), true);
});
