/**
 * ping / traceroute / telnet / ssh from the IOS CLI: real flows through the simulation, IOS output layout.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installCli, execLine, startSession } from '../../src/engine/cli/index.ts';
import type { ExecOutcome } from '../../src/engine/cli/framework.ts';
import type { World } from '../../src/engine/types.ts';
import { getIos } from '../../src/engine/world.ts';
import { ROUTER_SESSION_NOTE } from '../../src/engine/cli/commands/execnet.ts';
import { referenceLab, threeRouters, acl, deny, permit, any, host, GI } from '../sim/fixtures.ts';

installCli();

function cli(w: World, dev: string) {
  getIos(w, dev).runtime.setupDialogDone = true;
  const { session } = startSession(w, dev, 'console');
  execLine(w, session, 'enable');
  return (line: string): ExecOutcome => execLine(w, session, line);
}
/** threeRouters with default routes so that everything is reachable. */
function routed(): World {
  const w = threeRouters();
  getIos(w, 'R1').config.staticRoutes.push({ prefix: '0.0.0.0', mask: '0.0.0.0', nextHop: '10.0.12.2' });
  getIos(w, 'R3').config.staticRoutes.push({ prefix: '0.0.0.0', mask: '0.0.0.0', nextHop: '10.0.23.2' });
  const r2 = getIos(w, 'R2').config;
  r2.staticRoutes.push({ prefix: '10.1.0.0', mask: '255.255.255.0', nextHop: '10.0.12.1' }, { prefix: '10.3.0.0', mask: '255.255.255.0', nextHop: '10.0.23.3' });
  r2.staticRoutes.push({ prefix: '1.1.1.1', mask: '255.255.255.255', nextHop: '10.0.12.1' }, { prefix: '3.3.3.3', mask: '255.255.255.255', nextHop: '10.0.23.3' });
  return w;
}
const symbolsOf = (out: string): string => out.split('\n').filter((l) => /^[!.U]+$/.test(l)).join('');

test('ping: IOS layout, success, round-trip times, options in any order, line wrapping', () => {
  const w = referenceLab();
  const run = cli(w, 'R1');
  const o = run('ping 2.2.2.2 source Loopback0');
  assert.equal(o.status, 'ok');
  assert.equal(o.feature, 'verify');
  assert.equal(o.mutated, false);
  const l = o.output.split('\n');
  assert.equal(l[0], 'Type escape sequence to abort.');
  assert.equal(l[1], 'Sending 5, 100-byte ICMP Echos to 2.2.2.2, timeout is 2 seconds:');
  assert.equal(l[2], 'Packet sent with a source address of 1.1.1.1 ');
  assert.equal(l[3], '!!!!!');
  assert.match(l[4], /^Success rate is 100 percent \(5\/5\), round-trip min\/avg\/max = \d+\/\d+\/\d+ ms$/);
  // the serial link at 128 kbit/s makes the round trip take a while (ESP included)
  const [min] = /= (\d+)\//.exec(l[4])!.slice(1).map(Number);
  assert.ok(min >= 10, `min rtt ${min}`);

  const many = run('ping 60.50.30.2 timeout 1 repeat 100 size 36');
  assert.match(many.output, /^Sending 100, 36-byte ICMP Echos to 60\.50\.30\.2, timeout is 1 seconds:$/m);
  const rows = many.output.split('\n').filter((x) => /^!+$/.test(x));
  assert.deepEqual(rows.map((r) => r.length), [70, 30]);
  assert.match(many.output, /Success rate is 100 percent \(100\/100\)/);
  assert.equal(run('ping 60.50.30.2 source lo0 repeat 2').status, 'ok');
  assert.equal(run('ping ip 60.50.30.2 size 200').status, 'ok');
  assert.match(run('ping 60.50.30.2 repeat 2 source 60.50.50.100').output, /source address of 60\.50\.50\.100/);
  // invalid sources
  assert.match(run('ping 2.2.2.2 source 9.9.9.9').output, /^% Invalid source\. Must use same-VRF IP address or full interface name without spaces \(e\.g\. Serial0\/1\)$/m);
  assert.equal(run('ping 2.2.2.2 source Loopback7').status, 'rejected');
  assert.match(run('ping 2.2.2.2 source gi0/0/1').output, /% Invalid source/);
  // a host name that cannot be resolved
  assert.match(run('ping nowhere').output, /^% Unrecognized host or address, or protocol not running\.$/m);
});

test('ping: the first packet is lost while the IPsec SA is negotiated', () => {
  const w = referenceLab({ acquire: false });
  const r1 = getIos(w, 'R1');
  assert.equal(r1.runtime.ipsecSas.length, 0);
  const run = cli(w, 'R1');
  const o = run('ping 2.2.2.2 source Loopback0');
  assert.equal(symbolsOf(o.output), '.!!!!');
  assert.match(o.output, /Success rate is 80 percent \(4\/5\)/);
  assert.ok(r1.runtime.ipsecSas.length > 0);
  assert.equal(r1.runtime.ikeSas[0].state, 'QM_IDLE');
  // the SA is reused now
  assert.equal(symbolsOf(run('ping 2.2.2.2 source Loopback0').output), '!!!!!');
  assert.match(run('show crypto ipsec sa').output, /#pkts encaps: (9|10), #pkts encrypt/);
});

test('ping: ACL-blocked (U.U.U), no ip unreachables (.....), no route, timeout delay', () => {
  const w = routed();
  const r2 = getIos(w, 'R2').config;
  r2.acls['101'] = acl('101', 'extended', [deny('icmp', any, host('10.3.0.10')), permit('ip', any, any)]);
  r2.interfaces['GigabitEthernet0/0/1'].aclOut = '101';
  const run = cli(w, 'R1');
  assert.equal(symbolsOf(run('ping 3.3.3.3 source lo0').output), '!!!!!');
  const blocked = run('ping 10.3.0.10');
  assert.equal(symbolsOf(blocked.output), 'U.U.U');
  assert.match(blocked.output, /^Success rate is 0 percent \(0\/5\)$/m);
  assert.ok((blocked.delayMs ?? 0) >= 4000);
  assert.equal(getIos(w, 'R2').runtime.aclHits['101:10'], 5);
  r2.interfaces['Serial0/1/0'].noIpUnreachables = true;
  const silent = run('ping 10.3.0.10');
  assert.equal(symbolsOf(silent.output), '.....');
  assert.ok((silent.delayMs ?? 0) >= 10000);
  // no route on R1 itself
  getIos(w, 'R1').config.staticRoutes = [];
  const nr = run('ping 10.3.0.10');
  assert.equal(symbolsOf(nr.output), '.....');
  assert.match(nr.output, /^Success rate is 0 percent \(0\/5\)$/m);
});

test('ping counts like real traffic: interface and QoS counters, NAT entries', () => {
  const w = referenceLab();
  const r1 = getIos(w, 'R1');
  const out0 = r1.runtime.ifCounters['Serial0/1/0']?.out ?? 0;
  const run = cli(w, 'R1');
  run('ping 60.50.40.2 repeat 3');
  assert.equal((r1.runtime.ifCounters['Serial0/1/0']?.out ?? 0) - out0, 3);
  // R2 pings PC1's public address: the static NAT on R1 creates a session entry
  const run2 = cli(w, 'R2');
  assert.equal(symbolsOf(run2('ping 60.50.50.100').output), '!!!!!');
  assert.ok(r1.runtime.natTranslations.some((t) => t.fromStatic && t.proto === 'icmp' && t.outsideGlobal === '60.50.30.2'));
});

test('extended ping dialogue', () => {
  const w = referenceLab();
  const run = cli(w, 'R1');
  let o = run('ping');
  assert.equal(o.prompt, 'Protocol [ip]: ');
  const answers: [string, string][] = [
    ['', 'Target IP address: '], ['2.2.2.2', 'Repeat count [5]: '], ['3', 'Datagram size [100]: '], ['', 'Timeout in seconds [2]: '],
    ['', 'Extended commands [n]: '], ['y', 'Ingress ping [n]: '], ['', 'Source address or interface: '], ['9.9.9.9', 'Source address or interface: '],
    ['Loopback0', 'Type of service [0]: '], ['', 'Set DF bit in IP header? [no]: '], ['', 'Validate reply data? [no]: '],
    ['', 'Data pattern [0x0000ABCD]: '], ['', 'Loose, Strict, Record, Timestamp, Verbose[none]: '], ['', 'Sweep range of sizes [n]: '],
  ];
  for (const [a, prompt] of answers) {
    o = run(a);
    assert.equal(o.prompt, prompt, `after "${a}"`);
  }
  o = run('');
  assert.equal(o.prompt, 'R1#');
  assert.match(o.output, /^Sending 3, 100-byte ICMP Echos to 2\.2\.2\.2, timeout is 2 seconds:\nPacket sent with a source address of 1\.1\.1\.1 \n!!!\n/m);
  // short form without extended commands
  run('ping');
  for (const a of ['', '60.50.30.2', '', '', '']) run(a);
  o = run('n');
  assert.match(o.output, /^Sending 5, 100-byte ICMP Echos to 60\.50\.30\.2/m);
  // a bad answer ends the dialogue with the IOS message
  run('ping');
  run('');
  o = run('nonsense!');
  assert.match(o.output, /% Bad IP address or host name/);
  assert.equal(o.prompt, 'R1#');
  // user EXEC has no extended ping
  const u = cli(w, 'R2');
  u('disable');
  assert.equal(u('ping').status, 'incomplete');
  assert.equal(u('ping 60.50.30.1').status, 'ok');
});

test('traceroute: hops through the network, !A for an ACL, source option', () => {
  const w = referenceLab();
  const run = cli(w, 'R1');
  const o = run('traceroute 60.50.40.2');
  const l = o.output.split('\n');
  assert.equal(l[0], 'Type escape sequence to abort.');
  assert.equal(l[1], 'Tracing the route to 60.50.40.2');
  assert.equal(l[2], 'VRF info: (vrf in name/id, vrf out name/id)');
  assert.match(l[3], /^ {2}1 60\.50\.30\.2 \d+ msec \d+ msec \d+ msec$/);
  assert.match(l[4], /^ {2}2 60\.50\.40\.2 \d+ msec \d+ msec \d+ msec$/);
  assert.match(run('traceroute 2.2.2.2 source Loopback0').output, /^ {2}1 2\.2\.2\.2 \d+ msec \* {2}\d+ msec$/m);

  const w3 = routed();
  const r2 = getIos(w3, 'R2').config;
  r2.acls['102'] = acl('102', 'extended', [deny('udp', any, host('10.3.0.10')), permit('ip', any, any)]);
  r2.interfaces['GigabitEthernet0/0/1'].aclOut = '102';
  const t = cli(w3, 'R1')('trace 10.3.0.10');
  // TTL 1 expires at R2 before its outbound ACL; TTL 2 is refused by the ACL
  assert.match(t.output, /^ {2}1 10\.0\.12\.2 \d+ msec \d+ msec \d+ msec\n {2}2 10\.0\.12\.2 !A {2}\* {2}!A *$/m);
});

test('telnet / ssh from a router: open, refused, timed out, unreachable', () => {
  const w = routed();
  const run = cli(w, 'R1');
  // R2 default vty: login without a password
  let o = run('telnet 10.0.12.2');
  assert.match(o.output, /^Trying 10\.0\.12\.2 \.\.\. Open\n\n\nPassword required, but none set\n\n\[Connection to 10\.0\.12\.2 closed by foreign host\]$/m);
  assert.deepEqual(o.notes, [ROUTER_SESSION_NOTE]);
  const vty = getIos(w, 'R2').config.lines.vty[0];
  vty.password = 'cisco';
  o = run('telnet 10.0.12.2');
  assert.match(o.output, /^Trying 10\.0\.12\.2 \.\.\. Open\n\n\nUser Access Verification\n\nPassword: \n\[Connection to 10\.0\.12\.2 closed by foreign host\]$/m);
  assert.deepEqual(o.notes, [ROUTER_SESSION_NOTE]);
  // access-class that does not permit R1
  const r2 = getIos(w, 'R2').config;
  r2.acls['5'] = acl('5', 'standard', [{ action: 'permit', protocol: 'ip', src: host('10.1.0.10'), dst: any }]);
  vty.accessClassIn = '5';
  o = run('telnet 10.0.12.2');
  assert.equal(o.output, 'Trying 10.0.12.2 ... \n% Connection refused by remote host\n');
  delete vty.accessClassIn;
  // a PC without a Telnet server answers with a reset
  assert.match(run('telnet 10.3.0.10').output, /% Connection refused by remote host/);
  getIos(w, 'R3'); // PC3 runs no services by default; turn HTTP on
  const pc3 = w.devices.PC3;
  if (pc3.kind === 'pc') pc3.services.http = true;
  o = run('telnet 10.3.0.10 80');
  assert.match(o.output, /^Trying 10\.3\.0\.10, 80 \.\.\. Open\n\n\[Connection to 10\.3\.0\.10 closed by foreign host\]$/m);
  // nobody owns the address: no answer at all
  o = run('telnet 10.0.23.99');
  assert.equal(o.output, 'Trying 10.0.23.99 ... \n% Connection timed out; remote host not responding\n');
  assert.ok((o.delayMs ?? 0) >= 10000);
  // no route at all
  getIos(w, 'R1').config.staticRoutes = [];
  o = run('telnet 10.3.0.10');
  assert.equal(o.output, 'Trying 10.3.0.10 ... \n% Destination unreachable; gateway or host down\n');
  // SSH is a TCP 22 path probe only: even an allowed transport must not produce an SSH login prompt.
  getIos(w, 'R1').config.staticRoutes.push({ prefix: '0.0.0.0', mask: '0.0.0.0', nextHop: '10.0.12.2' });
  vty.transportInput = 'telnet';
  assert.match(run('ssh -l admin 10.0.12.2').output, /^% Connection refused by remote host$/m);
  vty.transportInput = 'ssh';
  o = run('ssh -l admin 10.0.12.2');
  assert.match(o.output, /^% Connection refused by remote host$/m);
  assert.match(o.notes.join(' '), /TCP 22 probe reaches R2.*does not run an SSH server/);
  assert.doesNotMatch(o.output, /Password:|Username:|User Access Verification/);
  assert.match(run('ssh -l admin -p 23 10.0.12.2').output, /Connection refused/, 'the TCP probe still respects Telnet transport policy');
  vty.transportInput = 'telnet ssh';
  o = run('ssh -l admin -p 23 10.0.12.2');
  assert.match(o.output, /^TCP probe to 10\.0\.12\.2 port 23 succeeded\. No SSH session was opened/m);
  assert.doesNotMatch(o.output, /Password:|Username:|User Access Verification|R2>/);
  assert.equal(o.pendingInput, null);
  assert.match(run('telnet 10.0.12.2').output, /User Access Verification\n\nPassword:/, 'a real Telnet probe still shows the line banner');
  void GI;
});

test('reference lab: telnet from the routers is refused by the access-class (only PC1 may connect)', () => {
  const w = referenceLab();
  assert.match(cli(w, 'R1')('telnet 60.50.30.2').output, /% Connection refused by remote host/);
  assert.match(cli(w, 'R2')('telnet 192.168.100.1').output, /% Connection refused by remote host|% Connection timed out/);
});
