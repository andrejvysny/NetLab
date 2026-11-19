/**
 * Windows command prompt of the lab PCs, on the reference lab of docs/COURSE.md (tests/sim/fixtures.ts).
 * PC1 static 192.168.100.10, PC2 DHCP 192.168.100.101, PC3 (macOS) DHCP 60.50.40.2 behind R2.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pcExec, pcPrompt } from '../../src/engine/pc/cmd.ts';
import type { PcCmdResult } from '../../src/engine/pc/cmd.ts';
import type { World } from '../../src/engine/types.ts';
import { ADDR, GI, acl, any, brokenLab, deny, host, pc, permit, r1, r2, referenceLab, setAcl, unplug } from '../sim/fixtures.ts';

const run = (w: World, id: string, line: string): PcCmdResult => pcExec(w, id, line);
const lines = (r: PcCmdResult): string[] => r.output.split('\n');
const count = (text: string, needle: string): number => text.split(needle).length - 1;

test('prompt: Windows PCs show C:\\Users\\student>, the MacBook shows the zsh prompt', () => {
  const w = referenceLab();
  assert.equal(pcPrompt(w, 'PC1'), 'C:\\Users\\student>');
  assert.equal(pcPrompt(w, 'PC3'), 'student@MacBook ~ % ');
});

test('ipconfig: static adapter with address, mask and gateway, in the Windows layout', () => {
  const w = referenceLab();
  const r = run(w, 'PC1', 'ipconfig');
  assert.ok(r.output.startsWith('\nWindows IP Configuration\n\n\nEthernet adapter Ethernet:\n\n'));
  assert.ok(r.output.includes('   IPv4 Address. . . . . . . . . . . : 192.168.100.10\n'));
  assert.ok(r.output.includes('   Subnet Mask . . . . . . . . . . . : 255.255.255.0\n'));
  assert.ok(r.output.includes('   Default Gateway . . . . . . . . . : 192.168.100.1\n'));
  assert.ok(r.output.includes('   Connection-specific DNS Suffix  . :\n'));
  assert.ok(r.output.endsWith('\n\n'), 'an empty line before the next prompt');
  // the colon column is the same on every line
  const cols = lines(r).filter((x) => x.startsWith('   ')).map((x) => x.indexOf(':'));
  assert.ok(cols.length >= 4 && cols.every((c) => c === cols[0]), `colons not aligned: ${cols}`);
});

test('ipconfig /all: DHCP adapter shows DHCP Enabled, DHCP server and the physical address', () => {
  const w = referenceLab();
  const r = run(w, 'PC2', 'ipconfig /all');
  assert.ok(r.output.includes('   Host Name . . . . . . . . . . . . : PC2\n'));
  assert.ok(r.output.includes('   DHCP Enabled. . . . . . . . . . . : Yes\n'));
  assert.ok(r.output.includes('   IPv4 Address. . . . . . . . . . . : 192.168.100.101(Preferred)\n'));
  assert.ok(r.output.includes('   DHCP Server . . . . . . . . . . . : 192.168.100.1\n'));
  assert.ok(r.output.includes(`   Physical Address. . . . . . . . . : ${pc(w, 'PC2').nic.mac}\n`));
  const st = run(w, 'PC1', 'ipconfig -all');
  assert.ok(st.output.includes('   DHCP Enabled. . . . . . . . . . . : No\n'));
  assert.ok(!st.output.includes('DHCP Server'));
  // cmd.exe accepts the switch glued to the command name
  assert.equal(run(w, 'PC1', 'ipconfig/all').output, st.output);
});

test('ipconfig: an unplugged cable shows "Media disconnected"', () => {
  const w = referenceLab();
  unplug(w, 'PC1', 'Ethernet0');
  const r = run(w, 'PC1', 'ipconfig');
  assert.ok(r.output.includes('   Media State . . . . . . . . . . . : Media disconnected\n'));
  assert.ok(!r.output.includes('IPv4 Address'));
  assert.equal(run(w, 'PC1', 'ipconfig /renew').output, '\nWindows IP Configuration\n\nNo operation can be performed on Ethernet while it has its media disconnected.\n\n');
  assert.ok(run(w, 'PC1', 'getmac').output.includes('Media disconnected'));
});

test('ipconfig /release and /renew run the real DHCP exchange', () => {
  const w = referenceLab();
  assert.ok(r1(w).runtime.dhcpBindings.some((b) => b.address === ADDR.pc2));
  const rel = run(w, 'PC2', 'ipconfig /release');
  assert.equal(pc(w, 'PC2').nic.address, undefined, 'the lease is given back');
  assert.ok(!r1(w).runtime.dhcpBindings.some((b) => b.address === ADDR.pc2), 'the server forgets the binding');
  assert.ok(!rel.output.includes('IPv4') && !rel.output.includes('169.254'), rel.output);
  assert.ok(rel.output.includes('   Default Gateway . . . . . . . . . :\n'));
  // without an address the PC cannot send
  const p = run(w, 'PC2', 'ping 192.168.100.1');
  assert.equal(count(p.output, 'PING: transmit failed. General failure.'), 4);
  assert.ok(p.output.includes('Packets: Sent = 4, Received = 0, Lost = 4 (100% loss),'));
  const ren = run(w, 'PC2', 'ipconfig /renew');
  assert.ok(ren.output.includes('   IPv4 Address. . . . . . . . . . . : 192.168.100.101\n'), ren.output);
  assert.equal(pc(w, 'PC2').nic.address, ADDR.pc2);
  assert.ok((ren.delayMs ?? 0) > 0 && (ren.delayMs ?? 0) <= 3000);
  // a static adapter cannot be released or renewed
  assert.ok(run(w, 'PC1', 'ipconfig /renew').output.includes('The operation failed as no adapter is in the state permissible for'));
});

test('ipconfig /renew without a reachable DHCP server: real failure text, then an APIPA address', () => {
  const w = brokenLab((x) => { r1(x).config.dhcp.pools = []; });
  const r = run(w, 'PC2', 'ipconfig /renew');
  assert.ok(r.output.includes('An error occurred while renewing interface Ethernet : unable to contact your DHCP server. Request has timed out.'));
  assert.equal(r.delayMs, 3000);
  const ip = run(w, 'PC2', 'ipconfig');
  assert.match(ip.output, /Autoconfiguration IPv4 Address\. \. : 169\.254\.\d+\.\d+\n/);
  assert.ok(ip.output.includes('   Subnet Mask . . . . . . . . . . . : 255.255.0.0\n'));
});

test('ping: four echo requests through the network, Windows reply lines and statistics', () => {
  const w = referenceLab();
  const before = r1(w).runtime.ipsecSas.reduce((s, sa) => s + sa.encaps, 0);
  const r = run(w, 'PC1', 'ping 60.50.40.2');
  assert.ok(r.output.startsWith('\nPinging 60.50.40.2 with 32 bytes of data:\n'));
  assert.equal(count(r.output, 'Reply from 60.50.40.2: bytes=32 time='), 4);
  assert.match(r.output, /Reply from 60\.50\.40\.2: bytes=32 time=\d+ms TTL=62\n/);
  assert.ok(r.output.includes('Ping statistics for 60.50.40.2:\n    Packets: Sent = 4, Received = 4, Lost = 0 (0% loss),\n'));
  assert.match(r.output, /Approximate round trip times in milli-seconds:\n {4}Minimum = \d+ms, Maximum = \d+ms, Average = \d+ms\n\n$/);
  assert.ok((r.delayMs ?? 0) > 0 && (r.delayMs ?? 0) <= 3000);
  const after = r1(w).runtime.ipsecSas.reduce((s, sa) => s + sa.encaps, 0);
  assert.ok(after >= before + 4, 'the pings really crossed the IPsec tunnel');
  // same LAN: below one millisecond, router TTL 255
  const lan = run(w, 'PC1', 'ping -n 2 192.168.100.1');
  assert.equal(count(lan.output, 'Reply from 192.168.100.1: bytes=32 time<1ms TTL=255'), 2);
});

test('ping: options -n, -l, -t and the usage / error texts', () => {
  const w = referenceLab();
  const n = run(w, 'PC1', 'ping -n 2 -l 100 192.168.100.101');
  assert.ok(n.output.includes('Pinging 192.168.100.101 with 100 bytes of data:'));
  assert.equal(count(n.output, 'bytes=100 '), 2);
  assert.ok(n.output.includes('Sent = 2, Received = 2, Lost = 0 (0% loss)'));
  const t = run(w, 'PC1', 'ping -t 192.168.100.1');
  assert.equal(count(t.output, 'Reply from 192.168.100.1'), 8);
  assert.ok(t.output.includes('Control-C\n^C\n'));
  assert.ok(t.output.includes('(Simulator: ping -t was stopped after 8 echo requests.)'));
  assert.ok(run(w, 'PC1', 'ping').output.includes('Usage: ping [-t] [-a] [-n count] [-l size]'));
  assert.equal(run(w, 'PC1', 'ping -n 0 1.1.1.1').output, 'Bad value for option -n, valid range is from 1 to 4294967295.\n\n');
  assert.equal(run(w, 'PC1', 'ping -l 70000 1.1.1.1').output, 'Bad value for option -l, valid range is from 0 to 65500.\n\n');
  assert.ok(run(w, 'PC1', 'ping -x 1.1.1.1').output.startsWith('Bad option -x.\n'));
  assert.equal(run(w, 'PC1', 'ping -n 3').output, 'IP address must be specified.\n\n');
  assert.equal(run(w, 'PC1', 'ping R2').output, 'Ping request could not find host R2. Please check the name and try again.\n\n');
});

test('ping blocked by an ACL: "Destination net unreachable" from the router, counted as received', () => {
  const w = referenceLab();
  const r = run(w, 'PC1', 'ping 2.2.2.2');
  assert.equal(count(r.output, 'Reply from 192.168.100.1: Destination net unreachable.'), 4);
  assert.ok(r.output.includes('Packets: Sent = 4, Received = 4, Lost = 0 (0% loss),'));
  assert.ok(!r.output.includes('Approximate round trip'), 'no round-trip block without echo replies');
  assert.ok((r1(w).runtime.aclHits['110:10'] ?? 0) >= 4, 'ACL 110 counted the drops');
});

test('ping: no route at the router → "Destination host unreachable"; silent host → "Request timed out."', () => {
  const w = brokenLab((x) => { r1(x).config.staticRoutes = []; });
  const r = run(w, 'PC1', 'ping -n 2 60.50.40.2');
  assert.equal(count(r.output, 'Reply from 192.168.100.1: Destination host unreachable.'), 2);
  const w2 = referenceLab();
  const t = run(w2, 'PC1', 'ping 60.50.40.50');
  assert.equal(count(t.output, 'Request timed out.'), 4);
  assert.ok(t.output.includes('Sent = 4, Received = 0, Lost = 4 (100% loss),'));
  assert.equal(t.delayMs, 2400);
});

test('ping on the own LAN to an absent address: the PC reports "Destination host unreachable" itself', () => {
  const w = referenceLab();
  const r = run(w, 'PC1', 'ping -n 1 192.168.100.77');
  assert.ok(r.output.includes('Reply from 192.168.100.10: Destination host unreachable.'));
});

test('ping with the cable unplugged: General failure', () => {
  const w = referenceLab();
  unplug(w, 'PC1', 'Ethernet0');
  const r = run(w, 'PC1', 'ping 192.168.100.1');
  assert.equal(count(r.output, 'PING: transmit failed. General failure.'), 4);
  assert.ok((r.delayMs ?? 0) <= 3000);
});

test('ping: the packet that triggers IPsec negotiation is lost, like on real routers', () => {
  const w = referenceLab();
  for (const d of [r1(w), r2(w)]) { d.runtime.ipsecSas = []; d.runtime.ikeSas = []; }
  const r = run(w, 'PC1', 'ping 60.50.40.2');
  const rows = lines(r).filter((x) => x.startsWith('Re'));
  assert.equal(rows[0], 'Request timed out.');
  assert.equal(rows.slice(1).filter((x) => x.startsWith('Reply from 60.50.40.2')).length, 3);
  assert.ok(r.output.includes('Sent = 4, Received = 3, Lost = 1 (25% loss)'));
  assert.ok(r1(w).runtime.ipsecSas.length > 0, 'the SA now exists');
});

test('tracert: every router on the way, unreachable report, usage', () => {
  const w = referenceLab();
  const r = run(w, 'PC1', 'tracert 60.50.40.2');
  assert.ok(r.output.startsWith('\nTracing route to 60.50.40.2 over a maximum of 30 hops\n\n'));
  assert.match(r.output, /\n {2}1 {4}<1 ms {4}<1 ms {4}<1 ms {2}192\.168\.100\.1\n/);
  assert.match(r.output, /\n {2}2 +\d+ ms +\d+ ms +\d+ ms {2}60\.50\.30\.2\n/);
  assert.match(r.output, /\n {2}3 +\d+ ms +\d+ ms +\d+ ms {2}60\.50\.40\.2\n/);
  assert.ok(r.output.endsWith('\nTrace complete.\n\n'));
  const blocked = run(w, 'PC1', 'tracert 2.2.2.2');
  assert.ok(blocked.output.includes('  1  192.168.100.1  reports: Destination net unreachable.\n'));
  assert.ok(run(w, 'PC1', 'tracert').output.includes('Usage: tracert [-d] [-h maximum_hops]'));
  assert.equal(run(w, 'PC1', 'tracert R2').output, 'Unable to resolve target system name R2.\n\n');
  const silent = run(w, 'PC1', 'tracert -d -h 10 60.50.40.50');
  assert.ok(silent.output.includes('     *        *        *     Request timed out.'));
  unplug(w, 'PC1', 'Ethernet0');
  assert.ok(run(w, 'PC1', 'tracert 60.50.40.2').output.includes('  1  General failure.'));
});

test('telnet PC1 → R2: accepted by the vty line; the intent carries the NAT-translated source 60.50.50.100', () => {
  const w = referenceLab();
  const r = run(w, 'PC1', 'telnet 60.50.30.2');
  assert.equal(r.output, '');
  assert.deepEqual(r.telnet, { deviceId: 'R2', remoteAddr: '60.50.50.100', host: '60.50.30.2', port: 23 });
  const r1t = run(w, 'PC1', 'telnet 192.168.100.1');
  assert.deepEqual(r1t.telnet, { deviceId: 'R1', remoteAddr: '192.168.100.10', host: '192.168.100.1', port: 23 });
  // the Telnet SYN crossed the tunnel and created/used a NAT entry
  assert.ok(r1(w).runtime.natTranslations.some((t) => t.proto === 'tcp' && t.insideLocal === ADDR.pc1 && t.insideGlobal === ADDR.pc1Public && t.outsideLocalPort === 23));
});

test('telnet refused (access-class) or to a closed port: the Windows failure text, no intent', () => {
  const w = referenceLab();
  const r = run(w, 'PC2', 'telnet 192.168.100.1');
  assert.equal(r.output, 'Connecting To 192.168.100.1...Could not open connection to the host, on port 23: Connect failed\n\n');
  assert.equal(r.telnet, undefined);
  assert.ok((r.delayMs ?? 0) > 0);
  const closed = run(w, 'PC1', 'telnet 60.50.40.2 25');
  assert.ok(closed.output.includes('Could not open connection to the host, on port 25: Connect failed'));
  const blocked = run(w, 'PC2', 'telnet 60.50.40.2 21');
  assert.ok(blocked.output.includes('on port 21: Connect failed'));
  assert.equal(blocked.delayMs, 3000, 'an ACL-dropped connection attempt times out');
});

test('telnet to a PC that runs the telnet service (or any open port): short banner, back to the prompt', () => {
  const w = referenceLab();
  pc(w, 'PC3').services.telnet = true;
  const r = run(w, 'PC1', 'telnet 60.50.40.2');
  assert.equal(r.telnet, undefined);
  assert.ok(r.output.includes('Welcome to the simulated Telnet service on PC3.'));
  assert.ok(r.output.includes('Connection to host lost.'));
  const ftpPort = run(w, 'PC1', 'telnet 60.50.40.2 21');
  assert.ok(ftpPort.output.includes('220 Simulated FTP server'));
});

test('curl: HTTP test on port 80 — page naming the server, -I headers, real curl errors', () => {
  const w = referenceLab();
  const r = run(w, 'PC2', 'curl http://60.50.40.2/');
  assert.ok(r.output.includes('<p>Simulated web server on PC3 (60.50.40.2).</p>'));
  assert.ok(r1(w).runtime.natTranslations.some((t) => t.proto === 'tcp' && t.insideLocal === ADDR.pc2 && t.insideGlobal === ADDR.r1Wan && t.outsideLocalPort === 80), 'PAT entry for the HTTP session');
  const h = run(w, 'PC2', 'curl -I 60.50.40.2');
  assert.ok(h.output.startsWith('HTTP/1.1 200 OK\nServer: SimHTTP/1.0 (PC3)\n'));
  assert.ok(!h.output.includes('<html>'));
  const refused = run(w, 'PC1', 'curl http://60.50.40.1/');
  assert.equal(refused.output, 'curl: (7) Failed to connect to 60.50.40.1 port 80: Connection refused\n\n');
  pc(w, 'PC3').services.http = false;
  assert.ok(run(w, 'PC2', 'curl http://60.50.40.2').output.includes('Connection refused'));
  const to = run(w, 'PC2', 'curl http://60.50.40.50/');
  assert.equal(to.output, 'curl: (28) Failed to connect to 60.50.40.50 port 80: Timed out\n\n');
  assert.equal(to.delayMs, 3000);
  assert.ok(run(w, 'PC1', 'curl').output.includes("curl: try 'curl --help'"));
  assert.equal(run(w, 'PC1', 'curl http://www.example.com/').output, 'curl: (6) Could not resolve host: www.example.com\n\n');
});

test('ftp: connection test only', () => {
  const w = referenceLab();
  const ok = run(w, 'PC1', 'ftp 60.50.40.2');
  assert.ok(ok.output.startsWith('Connected to 60.50.40.2.\n220 Simulated FTP server\n'));
  assert.ok(ok.output.includes('file transfer are not simulated'));
  assert.equal(run(w, 'PC2', 'ftp 60.50.40.2').output, '> ftp: connect :Connection timed out\n\n', 'ACL 110 blocks FTP for PC2');
  assert.equal(run(w, 'PC1', 'ftp 192.168.100.1').output, '> ftp: connect :Connection refused\n\n');
});

test('ssh: port 22 test; Test-NetConnection / tnc as the generic port test', () => {
  const w = referenceLab();
  const refused = run(w, 'PC2', 'ssh 60.50.30.2');
  assert.match(refused.output, /^ssh: connect to host 60\.50\.30\.2 port 22: Connection refused\n/);
  assert.match(refused.output, /TCP 22 probe reaches R2.*does not run an SSH server/);
  const acc = run(w, 'PC1', 'ssh admin@192.168.100.1');
  assert.match(acc.output, /port 22: Connection refused/, 'a reachable router does not emulate an SSH server');
  assert.equal(acc.telnet, undefined);
  const wrongPort = run(w, 'PC1', 'ssh -p 23 admin@192.168.100.1');
  assert.match(wrongPort.output, /answered the TCP probe on port 23\. No SSH session was opened/);
  assert.doesNotMatch(wrongPort.output, /Password:|Username:|User Access Verification|crypto key|ip domain-name/);
  assert.equal(wrongPort.telnet, undefined);
  assert.match(run(w, 'PC2', 'ssh -p 23 admin@192.168.100.1').output, /port 23: Connection refused/);
  const ok = run(w, 'PC2', 'Test-NetConnection 60.50.40.2 -Port 80');
  assert.match(ok.output, /TcpTestSucceeded : True/);
  assert.match(ok.output, /RemotePort {7}: 80/);
  assert.match(ok.output, /SourceAddress {4}: 192\.168\.100\.101/);
  const bad = run(w, 'PC2', 'tnc 60.50.40.2 -p 21');
  assert.ok(bad.output.startsWith('WARNING: TCP connect to (60.50.40.2 : 21) failed\n'));
  assert.match(bad.output, /PingSucceeded {10}: True/);
  assert.match(bad.output, /TcpTestSucceeded {7}: False/);
  assert.equal(run(w, 'PC1', 'tnc 192.168.100.1 -Port 23 -InformationLevel Quiet').output, 'True\n\n');
  assert.ok(run(w, 'PC1', 'tnc 1.1.1.1 -Bogus 1').output.includes("A parameter cannot be found that matches parameter name 'Bogus'."));
});

test('arp -a, route print, hostname, getmac, nslookup, ver, help, cls, unknown command', () => {
  const w = referenceLab();
  const a = run(w, 'PC2', 'arp -a');
  assert.ok(a.output.includes('\nInterface: 192.168.100.101 --- 0x5\n  Internet Address      Physical Address      Type\n'));
  assert.match(a.output, /\n {2}192\.168\.100\.1 {9}70-1f-53-[0-9a-f]{2}-[0-9a-f]{2}-[0-9a-f]{2} {5}dynamic\n/);
  assert.ok(a.output.includes('  192.168.100.255       ff-ff-ff-ff-ff-ff     static'));
  const rp = run(w, 'PC1', 'route print');
  assert.match(rp.output, / {10}0\.0\.0\.0 {10}0\.0\.0\.0 {4}192\.168\.100\.1 {3}192\.168\.100\.10 {5}25/);
  assert.ok(rp.output.includes('Persistent Routes:'));
  assert.equal(run(w, 'PC1', 'hostname').output, 'PC1\n\n');
  assert.ok(run(w, 'PC1', 'getmac').output.includes(pc(w, 'PC1').nic.mac));
  const ns = run(w, 'PC1', 'nslookup www.example.com');
  assert.ok(ns.output.includes("*** UnKnown can't find www.example.com: No response from server"));
  assert.ok(run(w, 'PC1', 'ver').output.includes('Microsoft Windows [Version 10.0.'));
  assert.ok(run(w, 'PC1', 'help').output.includes('IPCONFIG'));
  assert.deepEqual(run(w, 'PC1', 'cls'), { output: '', clear: true });
  assert.equal(run(w, 'PC1', 'ifconfig').output, "'ifconfig' is not recognized as an internal or external command,\noperable program or batch file.\n\n");
  unplug(w, 'PC2', 'Ethernet0');
  assert.equal(run(w, 'PC2', 'arp -a').output, 'No ARP Entries Found.\n\n');
});

test('an outbound ACL on R1 towards the WAN also shows as unreachable for PC2', () => {
  const w = brokenLab((x) => {
    setAcl(r1(x).config, acl('150', 'extended', [deny('icmp', host(ADDR.pc2), any), permit('ip', any, any)]));
    r1(x).config.interfaces[GI].aclIn = '150';
  });
  const r = run(w, 'PC2', 'ping -n 1 60.50.40.2');
  assert.ok(r.output.includes('Reply from 192.168.100.1: Destination net unreachable.'));
});

test('never throws; empty lines do nothing; every command advances the world tick', () => {
  const w = referenceLab();
  assert.deepEqual(run(w, 'PC1', '   '), { output: '' });
  const t0 = w.tick;
  const junk = ['ping -n', 'ping -l x 1.1.1.1', 'tracert -h', 'telnet', 'telnet 1.2.3.4 abc', 'ipconfig /bogus', 'curl -I', 'curl ftp://x/', 'ftp',
    'Test-NetConnection', 'tnc -Port', 'arp', 'route', 'ssh', 'ssh -p', '"unterminated', 'ping 999.1.1.1', 'nslookup', 'echo hi', 'ping -t -n 3 1.1.1.1',
    'tnc 60.50.40.2 -c 1', 'ipconfig /release *', 'exit'];
  for (const l of junk) {
    const r = run(w, 'PC1', l);
    assert.equal(typeof r.output, 'string', l);
    assert.ok(r.output.length > 0, `no output for "${l}"`);
    assert.ok((r.delayMs ?? 0) <= 3000, l);
  }
  assert.equal(w.tick, t0 + junk.length);
  assert.deepEqual(pcExec(w, 'R1', 'ping 1.1.1.1'), { output: '' }, 'not a PC');
  assert.deepEqual(JSON.parse(JSON.stringify(w)), w, 'the world is still plain JSON');
});
