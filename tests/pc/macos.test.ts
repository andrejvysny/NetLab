/**
 * macOS Terminal of the lab MacBook (PC3 in the reference lab: DHCP 60.50.40.2 on R2's LAN, lease relayed to R1).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pcExec } from '../../src/engine/pc/cmd.ts';
import type { PcCmdResult } from '../../src/engine/pc/cmd.ts';
import type { World } from '../../src/engine/types.ts';
import { dhcpRelease } from '../../src/engine/sim/index.ts';
import { ADDR, GI, acl, any, brokenLab, deny, host, pc, permit, r1, r2, referenceLab, setAcl, stdPermit, unplug } from '../sim/fixtures.ts';

const run = (w: World, line: string, id = 'PC3'): PcCmdResult => pcExec(w, id, line);
const count = (text: string, needle: string): number => text.split(needle).length - 1;

test('ifconfig / ifconfig en0 / ipconfig getifaddr en0', () => {
  const w = referenceLab();
  const r = run(w, 'ifconfig en0');
  assert.ok(r.output.startsWith('en0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500\n'));
  assert.ok(r.output.includes('\tinet 60.50.40.2 netmask 0xffffffc0 broadcast 60.50.40.63\n'));
  assert.ok(r.output.includes(`\tether ${pc(w, 'PC3').nic.mac.toLowerCase().replace(/-/g, ':')}\n`));
  assert.ok(r.output.endsWith('\tstatus: active\n'));
  const all = run(w, 'ifconfig');
  assert.ok(all.output.startsWith('lo0: ') && all.output.includes('\nen0: '));
  assert.equal(run(w, 'ifconfig en1').output, 'ifconfig: interface en1 does not exist\n');
  assert.equal(run(w, 'ipconfig getifaddr en0').output, '60.50.40.2\n');
  assert.equal(run(w, 'ipconfig getoption en0 router').output, '60.50.40.1\n');
  assert.ok(run(w, 'ipconfig').output.startsWith('usage: ipconfig <command> <args>'));
});

test('unplugged cable: en0 inactive without an address; ping says No route to host', () => {
  const w = referenceLab();
  unplug(w, 'PC3', 'Ethernet0');
  const r = run(w, 'ifconfig en0');
  assert.ok(r.output.includes('\tstatus: inactive'));
  assert.ok(!r.output.includes('\tinet '));
  assert.equal(run(w, 'ipconfig getifaddr en0').output, '');
  const p = run(w, 'ping -c 2 60.50.40.1');
  assert.equal(count(p.output, 'ping: sendto: No route to host'), 2);
  assert.ok(p.output.includes('2 packets transmitted, 0 packets received, 100.0% packet loss'));
  assert.equal(run(w, 'traceroute 60.50.40.1').output, 'traceroute: findsaddr: failed to connect to peer for src addr selection.\n');
});

test('sudo ipconfig set en0 DHCP renews the lease through the relay; failure leaves a self-assigned address', () => {
  const w = referenceLab();
  dhcpRelease(w, 'PC3');
  assert.equal(pc(w, 'PC3').nic.address, undefined);
  const r = run(w, 'sudo ipconfig set en0 DHCP');
  assert.equal(r.output, '');
  assert.equal(pc(w, 'PC3').nic.address, ADDR.pc3);
  assert.ok(r1(w).runtime.dhcpBindings.some((b) => b.address === ADDR.pc3), 'R1 holds the binding');
  const broken = brokenLab((x) => { delete r2(x).config.interfaces[GI].helperAddresses; });
  const f = run(broken, 'sudo ipconfig set en0 DHCP');
  assert.equal(f.delayMs, 3000);
  assert.match(run(broken, 'ifconfig en0').output, /\tinet 169\.254\.\d+\.\d+ netmask 0xffff0000 broadcast 169\.254\.255\.255\n/);
  // a Mac with a manual address is switched to DHCP, like the real command does
  const w2 = referenceLab();
  const p = pc(w2, 'PC3');
  p.nic = { mode: 'static', mac: p.nic.mac, address: '60.50.40.20', mask: '255.255.255.192', gateway: '60.50.40.1' };
  run(w2, 'ipconfig set en0 DHCP');
  assert.equal(p.nic.mode, 'dhcp');
  assert.equal(p.nic.address, ADDR.pc3);
});

test('ping -c: macOS format with icmp_seq, ttl, time and the statistics lines', () => {
  const w = referenceLab();
  const r = run(w, 'ping -c 3 60.50.40.1');
  assert.ok(r.output.startsWith('PING 60.50.40.1 (60.50.40.1): 56 data bytes\n'));
  for (const seq of [0, 1, 2]) assert.match(r.output, new RegExp(`64 bytes from 60\\.50\\.40\\.1: icmp_seq=${seq} ttl=255 time=\\d+\\.\\d{3} ms\\n`));
  assert.ok(r.output.includes('\n--- 60.50.40.1 ping statistics ---\n3 packets transmitted, 3 packets received, 0.0% packet loss\n'));
  assert.match(r.output, /round-trip min\/avg\/max\/stddev = [\d.]+\/[\d.]+\/[\d.]+\/[\d.]+ ms\n$/);
  // through both routers and the static NAT to PC1 (Windows TTL 128 minus two hops)
  const nat = run(w, 'ping -c 1 60.50.50.100');
  assert.match(nat.output, /64 bytes from 60\.50\.50\.100: icmp_seq=0 ttl=126 time=/);
  // -s changes the size
  assert.ok(run(w, 'ping -c 1 -s 100 60.50.40.1').output.includes('108 bytes from 60.50.40.1'));
});

test('ping without -c: stopped after four packets with ^C and a note', () => {
  const w = referenceLab();
  const r = run(w, 'ping 2.2.2.2');
  assert.equal(count(r.output, 'bytes from 2.2.2.2'), 4);
  assert.ok(r.output.includes('^C\n\n--- 2.2.2.2 ping statistics ---\n4 packets transmitted, 4 packets received, 0.0% packet loss'));
  assert.ok(r.output.includes('(Simulator: macOS ping runs until you press Ctrl+C.'));
});

test('ping: ACL drop → "Communication prohibited by filter"; silent host → Request timeout', () => {
  const w = brokenLab((x) => {
    setAcl(r2(x).config, acl('150', 'extended', [deny('icmp', any, host(ADDR.r2Lo0)), permit('ip', any, any)]));
    r2(x).config.interfaces[GI].aclIn = '150';
  });
  const r = run(w, 'ping -c 2 2.2.2.2');
  assert.equal(count(r.output, '92 bytes from 60.50.40.1: Communication prohibited by filter'), 2);
  assert.ok(r.output.includes('Vr HL TOS  Len   ID Flg  off TTL Pro  cks      Src      Dst'));
  assert.ok(r.output.includes('2 packets transmitted, 0 packets received, 100.0% packet loss'));
  const t = run(referenceLab(), 'ping -c 3 60.50.40.50');
  assert.equal(count(t.output, 'Request timeout for icmp_seq'), 2, 'the last timeout is not printed with -c');
  assert.ok(t.output.includes('3 packets transmitted, 0 packets received, 100.0% packet loss'));
  assert.ok(!t.output.includes('round-trip'));
});

test('ping usage and errors', () => {
  const w = referenceLab();
  assert.ok(run(w, 'ping').output.startsWith('usage: ping [-AaDdfnoQqRrv] [-c count]'));
  assert.equal(run(w, 'ping -c x 1.1.1.1').output, "ping: invalid count of packets to transmit: `x'\n");
  assert.ok(run(w, 'ping -y 1.1.1.1').output.startsWith('ping: illegal option -- y\n'));
  assert.equal(run(w, 'ping r1').output, 'ping: cannot resolve r1: Unknown host\n');
});

test('traceroute: UDP probes, one row per router, !X for an administratively prohibited hop', () => {
  const w = referenceLab();
  const r = run(w, 'traceroute 60.50.50.100');
  assert.ok(r.output.startsWith('traceroute to 60.50.50.100 (60.50.50.100), 64 hops max, 52 byte packets\n'));
  assert.match(r.output, /\n 1 {2}60\.50\.40\.1 \(60\.50\.40\.1\) {2}[\d.]+ ms {2}[\d.]+ ms {2}[\d.]+ ms\n/);
  assert.match(r.output, /\n 2 {2}60\.50\.30\.1 \(60\.50\.30\.1\) {2}/);
  assert.match(r.output, /\n 3 {2}60\.50\.50\.100 \(60\.50\.50\.100\) {2}/);
  const w2 = brokenLab((x) => {
    setAcl(r2(x).config, acl('150', 'extended', [deny('ip', any, host(ADDR.r2Lo0)), permit('ip', any, any)]));
    r2(x).config.interfaces[GI].aclIn = '150';
  });
  assert.match(run(w2, 'traceroute -n 2.2.2.2').output, /\n 1 {2}60\.50\.40\.1 {2}[\d.]+ ms !X {2}/);
  assert.ok(run(w, 'traceroute -m 6 60.50.40.50').output.includes(' 1  * * *'));
});

test('telnet from the Mac: refused by the access-class; accepted once R2 allows the Mac (intent with the real source)', () => {
  const w = referenceLab();
  const r = run(w, 'telnet 60.50.40.1');
  assert.equal(r.output, 'Trying 60.50.40.1...\ntelnet: connect to address 60.50.40.1: Connection refused\ntelnet: Unable to connect to remote host\n');
  assert.equal(r.telnet, undefined);
  r2(w).config.acls['allowPC1'].entries.push({ ...stdPermit(host(ADDR.pc3)), seq: 20 });
  const ok = run(w, 'telnet 60.50.40.1');
  assert.equal(ok.output, '');
  assert.deepEqual(ok.telnet, { deviceId: 'R2', remoteAddr: ADDR.pc3, host: '60.50.40.1', port: 23 });
  pc(w, 'PC1').services.telnet = true;
  const toPc = run(w, 'telnet 60.50.50.100');
  assert.ok(toPc.output.startsWith("Trying 60.50.50.100...\nConnected to 60.50.50.100.\nEscape character is '^]'.\nWelcome to the simulated Telnet service on PC1."));
  assert.ok(toPc.output.endsWith('Connection closed by foreign host.\n'));
});

test('nc -vz: generic TCP port test', () => {
  const w = referenceLab();
  pc(w, 'PC1').services.http = true;
  assert.equal(run(w, 'nc -vz 60.50.50.100 80').output, 'Connection to 60.50.50.100 port 80 [tcp/http] succeeded!\n');
  assert.equal(run(w, 'nc -zv 60.50.40.1 80').output, 'nc: connectx to 60.50.40.1 port 80 (tcp) failed: Connection refused\n');
  const to = run(w, 'nc -v -z 60.50.40.50 23');
  assert.equal(to.output, 'nc: connectx to 60.50.40.50 port 23 (tcp) failed: Operation timed out\n');
  assert.equal(to.delayMs, 3000);
  assert.equal(run(w, 'nc -z 60.50.50.100 80').output, '', 'without -v nc prints nothing');
  assert.ok(run(w, 'nc').output.startsWith('usage: nc '));
});

test('curl, ftp and ssh from the Mac', () => {
  const w = referenceLab();
  assert.equal(run(w, 'curl http://60.50.50.100/').output, 'curl: (7) Failed to connect to 60.50.50.100 port 80: Connection refused\n');
  pc(w, 'PC1').services.http = true;
  const page = run(w, 'curl http://60.50.50.100/');
  assert.ok(page.output.includes('Simulated web server on PC1 (60.50.50.100).'));
  assert.ok(run(w, 'curl -I http://60.50.50.100').output.startsWith('HTTP/1.1 200 OK\n'));
  assert.equal(run(w, 'curl http://60.50.40.50/').output, 'curl: (28) Failed to connect to 60.50.40.50 port 80: Operation timed out\n');
  assert.equal(run(w, 'ftp 60.50.50.100').output, "ftp: Can't connect to `60.50.50.100:21': Connection refused\nftp: Can't connect to `60.50.50.100:ftp'\n");
  pc(w, 'PC1').services.ftp = true;
  assert.ok(run(w, 'ftp 60.50.50.100').output.startsWith('Connected to 60.50.50.100.\n220 Simulated FTP server\n'));
  const closed = run(w, 'ssh 60.50.40.1');
  assert.match(closed.output, /^ssh: connect to host 60\.50\.40\.1 port 22: Connection refused\n/);
  assert.match(closed.output, /TCP 22 probe reaches R2.*does not run an SSH server/);
  assert.match(run(w, 'ssh -p 23 60.50.40.1').output, /port 23: Connection refused/);
  delete r2(w).config.lines.vty[0].accessClassIn;
  const wrongPort = run(w, 'ssh -p 23 admin@60.50.40.1');
  assert.match(wrongPort.output, /answered the TCP probe on port 23\. No SSH session was opened/);
  assert.doesNotMatch(wrongPort.output, /Password:|Username:|User Access Verification|crypto key|ip domain-name/);
  assert.equal(wrongPort.telnet, undefined);
});

test('arp -a, netstat -rn, hostname, clear, unknown command', () => {
  const w = referenceLab();
  const a = run(w, 'arp -a');
  assert.match(a.output, /^\? \(60\.50\.40\.1\) at 70:1f:53:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2} on en0 ifscope \[ethernet\]\n/);
  const n = run(w, 'netstat -rn');
  assert.ok(n.output.startsWith('Routing tables\n\nInternet:\nDestination        Gateway            Flags               Netif Expire\n'));
  assert.match(n.output, /\ndefault {12}60\.50\.40\.1 {9}UGScg {17}en0\n/);
  assert.match(n.output, /\n60\.50\.40\/26 {8}link#6/);
  assert.equal(run(w, 'hostname').output, 'MacBook.local\n');
  assert.deepEqual(run(w, 'clear'), { output: '', clear: true });
  assert.equal(run(w, 'cls').output, 'zsh: command not found: cls\n');
  assert.equal(run(w, 'ipconfig /all').output.split('\n')[0], 'usage: ipconfig <command> <args>');
});

test('the Mac never throws on odd input', () => {
  const w = referenceLab();
  for (const l of ['sudo', 'ping -c', 'ping -s 99999 1.1.1.1', 'traceroute', 'traceroute -m 0 1.1.1.1', 'telnet', 'telnet 1.1.1.1 xyz', 'nc -vz host', 'nc -u 1.1.1.1 161',
    'curl', 'curl -X', 'ftp', 'ssh', 'arp', 'netstat', 'nslookup', 'dig example.com', 'ifconfig en0 1.2.3.4', 'ipconfig set', 'ipconfig set en0 BOOTP', 'exit', 'help']) {
    const r = run(w, l);
    assert.equal(typeof r.output, 'string', l);
    assert.ok((r.delayMs ?? 0) <= 3000, l);
  }
});
