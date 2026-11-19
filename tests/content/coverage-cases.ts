import assert from 'node:assert/strict';
import { execLine, startSession } from '../../src/engine/cli/index.ts';
import type { CliSession, ExecOutcome, ExecStatus, ModeName } from '../../src/engine/cli/index.ts';
import type { Packet, ScenarioDef, ScenarioSummary } from '../../src/engine/types.ts';
import { Lab } from '../../src/engine/lab.ts';
import { aclEvaluate, dhcpAcquire, emitSnmpTrap, interfaceState, qosLoad, qosPlan, routingTable, sendFlow, serialClock, snmpRequest, syslogProbe } from '../../src/engine/sim/index.ts';
import { applyConfigText, reloadDevice, saveStartupConfig } from '../../src/engine/config/apply.ts';
import { renderRunningConfig } from '../../src/engine/config/render.ts';
import { getIos, getPc, isIos, MODEL_INFO } from '../../src/engine/world.ts';
import { A, B, C, LAN, WAN, PEER, RLAN, MASK, GLOBAL, commands } from './coverage-fixture.ts';
import type { Bench, Preset, Target } from './coverage-fixture.ts';

export type Label = 'functional' | 'partial' | 'display-only' | 'unsupported' | 'correct hardware rejection' | 'ill-formed paper notation' | 'unresolved';
export type Context = Bench & { s: CliSession; target: Target };
type Text = string | ((b: Bench) => string);
export interface Check { label: Label; status: ExecStatus; proof: string; verify?: (c: Context, o: ExecOutcome) => void }
export interface Case {
  line: number; variant: string; input: Text;
  mode: ModeName; preset?: Preset; target?: Target; rOnly?: boolean; sOnly?: boolean;
  before?: (b: Bench) => void; pre?: readonly Text[]; prerequisite?: string;
  router: Check; switch?: Check;
  switchBlock?: Text; key?: 'ctrl-z';
}
export const cases: Case[] = [];
const add = (line: number, variant: string, mode: ModeName, input: Text, router: Check, extras: Partial<Omit<Case, 'line' | 'mode' | 'input' | 'router' | 'variant'>> = {}) =>
  cases.push({ line, variant, mode, input, router, ...extras });
const ck = (label: Label, proof: string, verify?: Check['verify'], status: ExecStatus = 'ok'): Check => ({ label, proof, verify, status });
const fn = (proof: string, verify: NonNullable<Check['verify']>) => ck('functional', proof, verify);
const partial = (proof: string, verify: Check['verify']) => ck('partial', proof, verify);
const display = (proof: string, verify: Check['verify']) => ck('display-only', proof, verify);
const bad = (proof: string, status: ExecStatus = 'invalid') => ck('ill-formed paper notation', proof, undefined, status);
const hw = (proof: string, status: ExecStatus = 'invalid') => ck('correct hardware rejection', proof, undefined, status);
const gap = (proof: string, status: ExecStatus = 'invalid') => ck('unsupported', proof, undefined, status);
const unsure = (proof: string, status: ExecStatus = 'invalid') => ck('unresolved', proof, undefined, status);
const out = (re: RegExp): Check['verify'] => (_c, o) => assert.match(o.output, re);
const note = (re: RegExp): Check['verify'] => (_c, o) => assert.match(o.notes.join('\n'), re);
const shown = (proof: string, re: RegExp) => fn(proof, out(re)!);
const mode = (m: ModeName) => fn(`Session enters ${m}.`, (c) => assert.equal(c.s.mode, m));
const intf = (where: 'lan' | 'wan' = 'lan'): Text => (b) => `interface ${b[where]}`;
const cfg = ['configure terminal'];
const ci = (where: 'lan' | 'wan' = 'lan') => [...cfg, intf(where)];
const flow = (b: Bench, fromDeviceId = 'A', dst = C) => sendFlow(b.w, { fromDeviceId, dst, proto: 'icmp' });
const http = (b: Bench, fromDeviceId: string, dst: string, sport = 49152) => sendFlow(b.w, { fromDeviceId, dst, proto: 'tcp', sport, dport: 80 });
const execNow = (b: Bench, id: Target, text: string) => execLine(b.w, startSession(b.w, id, 'file').session, text);
const assertLogin = (c: Context, via: 'console' | 'vty') => {
  const { session, outcome } = startSession(c.w, c.target, via, { remoteAddr: A });
  assert.equal(outcome.prompt, 'Password: ');
  assert.equal(outcome.secret, true);
  execLine(c.w, session, 'incorrect');
  assert.ok(session.pending, 'wrong password is re-prompted');
  execLine(c.w, session, 'cisco');
  assert.equal(session.pending, undefined);
  assert.equal(session.mode, 'user');
  assert.equal(session.closed, false);
};

// A: prompt transitions, actual terminal authentication, interface/link behavior, learned routes and actual CLI probes.
add(10, 'from console', 'user', 'enable', mode('priv'));
add(11, 'privileged to user', 'priv', 'disable', mode('user'));
add(12, 'global mode', 'priv', 'configure terminal', mode('config'));
add(13, 'prompt and state', 'config', 'hostname BenchX', fn('New hostname appears in the prompt.', (c, o) => assert.equal(o.prompt, 'BenchX(config)#')), { pre: cfg });
add(14, 'one-line delimiter', 'config', 'banner motd #Audit only#', fn('A new console session receives the MOTD.', (c) => assert.match(startSession(c.w, 'X', 'console').outcome.output, /Audit only/)), { pre: cfg });
add(15, 'global to privileged', 'config', 'exit', mode('priv'), { pre: cfg });
add(16, 'typed words', 'config-if', 'control-z', bad('Not a CLI keyword; enter the key event separately.'), { pre: ci() });
add(16, 'actual key', 'config-if', 'Ctrl+Z', mode('priv'), { pre: ci(), key: 'ctrl-z' });
add(18, 'select VTY range', 'config', 'line vty 0 4', fn('Selects lines 0 through 4; subsequent password applies to that range.', (c) => {
  assert.equal(c.s.mode, 'config-line'); commands(c.w, 'X', ['password cisco'], c.s);
  assert.equal(c.d.config.lines.vty.find((l) => l.first === 0 && l.last === 4)?.password, 'cisco');
}), { pre: cfg });
add(19, 'enforce VTY password', 'config-line', 'login', fn('A new VTY prompts for and enforces the line password.', (c) => assertLogin(c, 'vty')), { pre: [...cfg, 'line vty 0 4', 'password cisco', 'no login'] });
add(20, 'VTY line password', 'config-line', 'password cisco', fn('Wrong password re-prompts; configured password opens modeled EXEC.', (c) => assertLogin(c, 'vty')), { pre: [...cfg, 'line vty 0 4', 'login'] });
add(22, 'select console', 'config', 'line con 0', fn('Subsequent console password is applied to line con 0.', (c) => {
  assert.equal(c.s.mode, 'config-line'); commands(c.w, 'X', ['password cisco'], c.s); assert.equal(c.d.config.lines.console.password, 'cisco');
}), { pre: cfg });
add(23, 'enforce console password', 'config-line', 'login', fn('A new console prompts for and enforces the line password.', (c) => assertLogin(c, 'console')), { pre: [...cfg, 'line con 0', 'password cisco'] });
add(24, 'console password', 'config-line', 'password cisco', fn('Configured password is accepted after enabling console login.', (c) => {
  commands(c.w, 'X', ['login'], c.s); assertLogin(c, 'console');
}), { pre: [...cfg, 'line con 0'] });
add(25, 'console synchronous logging', 'config-line', 'logging synchronous', display('Stored/rendered; not an asynchronous terminal redraw test.', (c) => {
  assert.equal(c.d.config.lines.console.loggingSynchronous, true); assert.match(execNow(c, 'X', 'show running-config').output, /logging synchronous/);
}), { pre: [...cfg, 'line con 0'] });
add(28, 'physical interface', 'config', intf(), fn('Enters the selected port’s context and edits only that port.', (c) => {
  assert.deepEqual(c.s.ctx.ifNames, [c.lan]); commands(c.w, 'X', ['description coverage'], c.s); assert.equal(c.d.config.interfaces[c.lan].description, 'coverage');
}), { pre: cfg });
add(29, 'routed IPv4 interface', 'config-if', `ip address ${LAN} ${MASK}`, fn('Adds the connected route and answers a LAN host ping.', (c) => {
  assert.ok(routingTable(c.w, 'X').some((r) => r.code === 'C' && r.prefix === '192.168.40.0')); assert.equal(flow(c, 'A', LAN).ok, true);
}), { preset: 'wire', pre: [...ci(), (b) => b.isr ? 'no shutdown' : 'no switchport', 'no shutdown'], before: (b) => { if (!b.isr) b.x('ip routing'); } });
add(29, 'unconverted L2 switchport', 'config-if', `ip address ${LAN} ${MASK}`, fn('ISR onboard port is routed by default; address is stored.', (c) => assert.equal(c.d.config.interfaces[c.lan].ip?.address, LAN)), { pre: ci(), switch: hw('Switchport rejects an IP address until no switchport.', 'rejected') });
add(30, 'description', 'config-if', 'description Student LAN', fn('Interface description appears in running config after editing.', (c) => assert.match(execNow(c, 'X', 'show running-config').output, /description Student LAN/)), { pre: ci() });
add(31, 'release shutdown', 'config-if', 'no shutdown', fn('A cabled port moves from administratively down to line protocol up.', (c) => assert.equal(interfaceState(c.w, 'X', c.lan).protocol, 'up')), { preset: 'wire', pre: [...ci(), 'shutdown'] });
add(32, 'NIM DCE / Catalyst Ethernet', 'config-if', 'clock rate 56000', fn('The serial circuit uses a 56 kbit/s DCE clock.', (c) => assert.equal(serialClock(c.w, 'X', c.wan)?.configured, 56000)), { preset: 'linked', before: (b) => { if (b.isr) b.x(`interface ${b.wan}`, 'no clock rate'); }, pre: ci('wan'), switch: hw('Catalyst has no WIC/NIM serial controller; clock rate is not valid on this Ethernet port.', 'rejected') });
add(32, 'NIM DTE', 'config-if', 'clock rate 56000', hw('A real serial DTE consumes the DCE clock and may not provide the clock.', 'rejected'), { preset: 'linked', target: 'P', pre: [...cfg, 'interface Serial0/1/0'], rOnly: true });
add(32, 'NIM not cabled', 'config-if', 'clock rate 56000', hw('No DCE cable is detected at the serial port.', 'rejected'), { pre: ci('wan'), rOnly: true });

const news = (p: 'rip' | 'ospf', ip: string) => p === 'rip' ? `network ${ip}` : `network ${ip} 0.0.0.255 area 0`;
const routerCmd = (p: 'rip' | 'ospf') => p === 'rip' ? 'router rip' : 'router ospf 10';
for (const [p, lines] of [['rip', [34, 35, 36]], ['ospf', [38, 39, 40]]] as const) {
  const [proc, net1, net2] = lines;
  const before = (b: Bench) => b.p(routerCmd(p), news(p, '198.51.100.0'), news(p, '192.0.2.0'));
  const learned = (checkReverse = false) => fn(`Peers install ${p.toUpperCase()} routes and ping succeeds once both networks are advertised.`, (c) => {
    const code = p === 'rip' ? 'R' : 'O';
    assert.ok(routingTable(c.w, 'X').some((r) => r.code === code && r.prefix === '192.0.2.0'));
    if (checkReverse) { assert.ok(routingTable(c.w, 'P').some((r) => r.code === code && r.prefix === '192.168.40.0')); assert.equal(flow(c).ok, true); }
  });
  add(proc, 'start protocol', 'config', routerCmd(p), fn('Process accepts network statements and learns a peer route.', (c, o) => {
    assert.equal(c.s.mode, 'config-router'); commands(c.w, 'X', [news(p, '198.51.100.0')], c.s); learned().verify!(c, o);
  }), { preset: 'linked', before, pre: cfg });
  add(net1, 'transit network', 'config-router', news(p, '198.51.100.0'), learned(), { preset: 'linked', before, pre: [...cfg, routerCmd(p)] });
  add(net2, 'advertise LAN', 'config-router', news(p, '192.168.40.0'), learned(true), { preset: 'linked', before, pre: [...cfg, routerCmd(p), news(p, '198.51.100.0')] });
}
for (const [line, prefix, mask] of [[42,'0.0.0.0','0.0.0.0'], [43,'192.0.2.0',MASK]] as const) {
  add(line, 'resolved next hop', 'config', `ip route ${prefix} ${mask} ${PEER}`, fn('Installs RIB entry and forwards traffic through P.', (c) => {
    assert.ok(routingTable(c.w, 'X').some((r) => r.code === 'S' && r.prefix === prefix && r.isDefault === (line === 42))); assert.equal(flow(c).ok, true);
  }), { preset: 'linked', pre: cfg, before: (b) => b.p(`ip route 192.168.40.0 ${MASK} ${WAN}`) });
}
add(45, 'RIB', 'priv', 'show ip route', shown('Shows the installed static and connected networks.', /S\s+192\.0\.2\.0\/24.*198\.51\.100\.2/), { preset: 'routed' });
add(46, 'IP and link', 'priv', 'show ip interface brief', shown('Shows the configured management/L3 address and up/up.', /192\.168\.40\.1.*up\s+up/), { preset: 'linked' });
add(47, 'serial DCE abbreviation / Catalyst missing serial interface', 'priv', 'show controller serial 0/1/0', shown('Serial output contains DCE and the clock rate.', /DCE[^\n]*56000/i), { preset: 'linked', switch: hw('Catalyst has no Serial0/1/0 (the command itself is not router-only).', 'rejected') });
add(47, 'Ethernet controller', 'priv', (b) => `show controller ${b.lan}`, partial('Accepted; Ethernet uses generic controller output, not PHY diagnostics.', (c, o) => assert.ok(o.output.includes(c.lan) || /not available|controller/i.test(o.output))), { preset: 'linked' });
add(48, 'protocol state', 'priv', 'show ip protocols', fn('Displays configured RIP and OSPF state (not proof of convergence).', (_c, o) => { assert.match(o.output, /Routing Protocol is "rip"/); assert.match(o.output, /Routing Protocol is "ospf 10"/); }), { preset: 'linked', before: (b) => b.x('router rip', 'network 192.168.40.0', 'exit', 'router ospf 10', 'network 198.51.100.0 0.0.0.255 area 0') });
add(49, 'fixed modeled release', 'priv', 'show version', display('Shows configured hardware/release metadata, not real boot/licensing discovery.', (c, o) => assert.ok(o.output.includes(MODEL_INFO[c.model].ios!))));
add(50, 'running config', 'priv', 'show running-config', shown('Shows current hostname and configured interface address.', /hostname BenchX[\s\S]*ip address 192\.168\.40\.1/), { preset: 'linked', before: (b) => b.x('hostname BenchX') });
add(51, 'confirm destination', 'priv', 'copy running-config startup-config', fn('Confirms destination and reads saved startup config.', (c, o) => {
  assert.match(o.prompt, /Destination filename/); assert.equal(c.d.startupConfig, null); execLine(c.w, c.s, ''); assert.match(c.d.startupConfig ?? '', /hostname BenchX/);
}), { before: (b) => b.x('hostname BenchX') });
add(53, 'ICMP request/reply', 'priv', `ping ${C}`, shown('Successful CLI probes use a real modeled path and return !.', /!!!!![\s\S]*100 percent/), { preset: 'routed' });
add(54, 'unambiguous abbreviation', 'priv', `trace ${C}`, shown('CLI TTL probes resolve the far router and destination.', /198\.51\.100\.2[\s\S]*192\.0\.2\.10/), { preset: 'routed' });
for (const [l, text] of [[55,'debug ip rip'], [56,'undebug all']] as const) {
  add(l, 'debug stub', 'priv', text, display('Accepted with a simulation notice; no debug state or asynchronous trace.', note(/Debugging is not simulated/)));
}

// B: evaluate concrete packets against ACEs parsed by the real CLI; forwarding, logging and counters checked separately.
const packet = (p: Partial<Packet> = {}): Packet => ({ proto: 'icmp', src: A, dst: C, ttl: 64, bytes: 64, ...p });
const evalAce = (b: Bench, acl: number, p: Partial<Packet> = {}) => aclEvaluate(b.d.config.acls[String(acl)], packet(p));
add(66, 'standard wildcard permit', 'config', 'access-list 10 permit 192.168.40.0 0.0.0.255', fn('Matches addresses within the wildcard and implicitly denies other sources.', (c) => {
  assert.equal(evalAce(c, 10).permit, true); assert.equal(evalAce(c, 10, { src: C }).implicit, true);
}), { pre: cfg });
add(66, 'standard deny and log', 'config', `access-list 10 deny ${A} 0.0.0.0 log`, fn('Drops the matching inbound packet, increments hit counter, and emits an ACL log.', (c) => {
  c.x(`interface ${c.lan}`, 'ip access-group 10 in'); const f = flow(c); assert.equal(f.forward.reason, 'acl-in');
  assert.equal(c.d.runtime.aclHits['10:10'], 1); assert.ok(c.d.runtime.logBuffer.some((l) => l.mnemonic.includes('IPACCESS')));
}), { preset: 'routed', pre: cfg });
for (const [proto, p] of [['ip','icmp'], ['50','esp'], ['esp','esp']] as const) {
  add(68, `extended ${proto}, no ports`, 'config', `access-list 110 permit ${proto} 192.168.40.0 0.0.0.255 192.0.2.0 0.0.0.255`, fn('Filters source/destination and supported IP protocol.', (c) => {
    assert.equal(evalAce(c, 110, { proto: p }).permit, true); assert.equal(evalAce(c, 110, { proto: p, dst: WAN }).permit, false);
  }), { pre: cfg });
}
add(68, 'IP plus port', 'config', 'access-list 110 permit ip any eq 80 any', bad('Generic protocols cannot take port operators; use tcp or udp.'), { pre: cfg });
add(68, 'raw named port without operator', 'config', 'access-list 110 permit tcp any www any', bad('A port predicate needs an operator; see the next line.'), { pre: cfg });
add(68, 'additional raw-IP protocol', 'config', 'access-list 110 permit gre any any log', partial('GRE is stored/preserved, but there is no GRE packet generator or forwarding test.', (c) => assert.equal(c.d.config.acls['110'].entries[0].protocol, 'gre')), { pre: cfg });
for (const [op, n, good, badPort] of [['lt','80',79,80], ['gt','80',81,80], ['eq','80',80,79], ['neq','80',79,80], ['range','80 81',81,82]] as const) {
  for (const proto of ['tcp','udp'] as const) for (const side of ['src','dst'] as const) {
    const field = side === 'src' ? 'sport' : 'dport';
    add(71, `${proto} ${op} ${side}`, 'config', `access-list 110 permit ${proto} ${side === 'src' ? `any ${op} ${n} any` : `any any ${op} ${n}`}`, fn('Passing and failing boundary packets exercise the parsed port operator.', (c) => {
      assert.equal(evalAce(c, 110, { proto, [field]: good }).permit, true); assert.equal(evalAce(c, 110, { proto, [field]: badPort }).permit, false);
    }), { pre: cfg });
  }
}
add(71, 'named ports both sides', 'config', 'access-list 110 permit tcp any eq www any eq telnet log', fn('Both predicates use named TCP service ports; either side can fail.', (c) => {
  assert.equal(evalAce(c, 110, { proto: 'tcp', sport: 80, dport: 23 }).permit, true); assert.equal(evalAce(c, 110, { proto: 'tcp', sport: 81, dport: 23 }).permit, false);
}), { pre: cfg });
add(71, 'UDP named SNMP port', 'config', 'access-list 110 permit udp any any eq snmp', fn('UDP service name matches port 161, not the trap receiver port 162.', (c) => {
  assert.equal(evalAce(c, 110, { proto: 'udp', dport: 161 }).permit, true); assert.equal(evalAce(c, 110, { proto: 'udp', dport: 162 }).permit, false);
}), { pre: cfg });
add(71, 'TCP established', 'config', 'access-list 110 permit tcp any any established', partial('Model rejects the initial SYN and permits established-flow packets; IOS checks ACK or RST flags, not connection state.', (c) => {
  assert.equal(evalAce(c, 110, { proto: 'tcp', tcpSyn: true }).permit, false); assert.equal(evalAce(c, 110, { proto: 'tcp', tcpSyn: false }).permit, true);
}), { pre: cfg });
add(71, 'UDP established', 'config', 'access-list 110 deny udp any any established', bad('established is TCP-only, despite the merged TCP/UDP template.'), { pre: cfg });
for (const [kind, type] of [['8','echo'],['echo','echo'],['echo-reply','echo-reply'],['unreachable','unreachable']] as const) {
  add(75, `ICMP ${kind}`, 'config', `access-list 110 deny icmp any any ${kind} log`, fn('Matches the targeted ICMP kind; other types use the later permit.', (c) => {
    c.x('access-list 110 permit ip any any'); assert.equal(evalAce(c, 110, { icmpType: type }).permit, false);
    assert.equal(evalAce(c, 110, { icmpType: type === 'echo' ? 'echo-reply' : 'echo' }).permit, true);
  }), { pre: cfg });
}
for (const kind of ['redirect','traceroute']) {
  add(75, `ICMP ${kind} keyword`, 'config', `access-list 110 deny icmp any any ${kind}`, partial('Stores the ICMP keyword, but no modeled flow emits this ICMP type (traceroute utility uses TTL exceeded, not ICMP type 30).', (c) => assert.equal(c.d.config.acls['110'].entries[0].icmpType, kind)), { pre: cfg });
}
for (const k of ['ping','unreachables']) add(75, `paper shorthand ${k}`, 'config', `access-list 110 deny icmp any any ${k}`, bad('Descriptive prose, not an ICMP type keyword; use echo/echo-reply or unreachable.'), { pre: cfg });
for (const [dir, where] of [['in','lan'],['out','wan']] as const) {
  add(80, dir, 'config-if', `ip access-group 110 ${dir}`, fn('Forwarded traffic now drops on the bound interface/direction and increments the ACE counter.', (c) => {
    assert.equal(flow(c).forward.reason, `acl-${dir}`); assert.equal(c.d.runtime.aclHits['110:10'], 1);
  }), { preset: 'routed', pre: [...cfg, 'access-list 110 deny icmp any any', intf(where)] });
}
add(81, 'suppress ICMP unreachable', 'config-if', 'no ip unreachables', fn('Denied ping no longer returns U and now times out.', (c) => assert.equal(flow(c).symbol, '.')), { preset: 'routed', pre: [...cfg, 'access-list 110 deny icmp any any', intf(), 'ip access-group 110 in'] });
add(83, 'numbered VTY selection', 'config', 'line vty 0 4', mode('config-line'), { pre: cfg });
add(84, 'permitted source vs other source', 'config-line', 'access-class 10 in', fn('Two modeled Telnet TCP requests reach the port, only the listed source is accepted.', (c) => {
  const probe = (fromDeviceId: string) => sendFlow(c.w, { fromDeviceId, dst: LAN, proto: 'tcp', dport: 23 });
  assert.equal(probe('A').vty?.accepted, true); assert.equal(probe('B').vty?.reason, 'access-class');
}), { preset: 'linked', pre: [...cfg, `access-list 10 permit ${A}`, 'line vty 0 4', 'password cisco', 'login'] });
add(86, 'remove whole list', 'config', 'no access-list 110', fn('Existing bind stops denying after numbered list deletion.', (c) => { assert.equal(c.d.config.acls['110'], undefined); assert.equal(flow(c).ok, true); }), { preset: 'routed', before: (b) => { b.x('access-list 110 deny ip any any', `interface ${b.lan}`, 'ip access-group 110 in'); assert.equal(flow(b).ok, false); }, pre: cfg });
add(87, 'counter reflects live traffic', 'priv', 'show access-lists', shown('Shows the ACE with one match after one forward packet.', /deny icmp any any.*\(1 match/), { preset: 'routed', before: (b) => { b.x('access-list 110 deny icmp any any', `interface ${b.lan}`, 'ip access-group 110 in'); flow(b); } });

// C: ISR and C9300L Network Advantage over routed data ports; router-only and unresolved switch forms are separate.
const catRotary = ck('unresolved', 'Router guide documents rotary. Exact Catalyst C9300L 17.3 support is unverified; this profile refuses it.', out(/rotary.*unverified/i), 'rejected');
const PWL = 'access-list 1 permit 192.168.40.0 0.0.0.255';
const MAP = 'ip nat inside source list 1 pool PUB';
const POOL = `ip nat pool PUB ${GLOBAL} 203.0.113.11 netmask ${MASK}`;
const SINGLE = `ip nat pool PUB ${GLOBAL} ${GLOBAL} netmask ${MASK}`;
const STAT = `ip nat inside source static ${A} ${GLOBAL}`;
const ROLES = (b: Bench) => [`interface ${b.lan}`, 'ip nat inside', 'exit', `interface ${b.wan}`, 'ip nat outside', 'exit'];
const natBefore = (...lines: Text[]) => (b: Bench) => { b.x(...ROLES(b), ...lines.map((s) => typeof s === 'function' ? s(b) : s)); };
const mapping = (c: Context, from = 'A', global = GLOBAL) => {
  const f = http(c, from, C); assert.equal(f.ok, true, f.summary); assert.equal(f.forward.received?.src, global);
  assert.equal(f.reverse?.atDeviceId, from);
  assert.equal(f.reverse?.received?.dst, from === 'A' ? A : B);
  assert.ok(f.forward.steps.some((step) => step.deviceId === 'X' && step.stage === 'nat-inside' && step.verdict === 'changed'));
  assert.ok(f.reverse?.steps.some((step) => step.deviceId === 'X' && step.stage === 'nat-outside' && step.verdict === 'changed'));
  return f;
};
const natEx = (before?: Case['before'], pre: readonly Text[] = cfg, sw?: Check) => ({ preset: 'routed' as const, before, pre, switch: sw });
add(94, '1:1 source and return translation', 'config', STAT, fn('Inside A is translated outbound; new outside request to global address reaches A.', (c) => {
  mapping(c); const f = http(c, 'C', GLOBAL); assert.equal(f.ok, true, f.summary); assert.equal(f.forward.atDeviceId, 'A');
}), natEx(natBefore()));
for (const [poolLine, aclLine, ruleLine, overload] of [[95,96,97,false], [98,99,100,true]] as const) {
  const pool = overload ? SINGLE : POOL;
  const rule = `${MAP}${overload ? ' overload' : ''}`;
  const verifyMapping = (c: Context) => {
    if (!overload) { mapping(c); mapping(c, 'B', '203.0.113.11'); }
    else {
      const a = mapping(c), b = mapping(c, 'B');
      assert.notEqual(a.forward.received?.sport, b.forward.received?.sport);
    }
  };
  const proof = overload ? 'Two TCP sessions share a global IPv4 address and get disjoint source ports.' : 'Two local hosts receive different, reversible IPv4 mappings from the pool.';
  add(poolLine, overload ? 'one-address PAT pool' : 'two-address dynamic pool', 'config', pool, fn(proof, (c) => { c.x(rule); verifyMapping(c); }), natEx(natBefore(PWL)));
  add(aclLine, overload ? 'PAT source ACL' : 'dynamic source ACL', 'config', PWL, fn(proof + ' ACL selects the LAN, not remote hosts.', (c) => {
    verifyMapping(c); assert.equal(evalAce(c, 1, { src: C }).permit, false);
  }), natEx(natBefore(pool, rule)));
  add(ruleLine, overload ? 'pool overload PAT' : 'pool without overload', 'config', rule, fn(proof, verifyMapping), natEx(natBefore(pool, PWL)));
}
const ROTPOOL = `ip nat pool REAL ${A} ${B} prefix-length 24 type rotary`;
const ROTACE = `access-list 2 permit ${GLOBAL}`;
const ROTMAP = 'ip nat inside destination list 2 pool REAL';
const rotate = (c: Context) => {
  for (const [port, which] of [[6010, 'A'], [6011, 'B'], [6012, 'A'], [6011, 'B']] as const) {
    const f = http(c, 'C', GLOBAL, port); assert.equal(f.ok, true, f.summary); assert.equal(f.forward.atDeviceId, which); assert.equal(f.repliedFrom, GLOBAL);
  }
  assert.notEqual(flow(c, 'C', GLOBAL).forward.atDeviceId, 'A', 'ICMP does not use TCP rotary');
};
add(102, 'TCP rotary / prefix length', 'config', ROTPOOL, fn('Each new TCP session rotates across pool addresses; reused tuple remains sticky.', (c) => { c.x(ROTMAP); rotate(c); }), natEx(natBefore(ROTACE), cfg, catRotary));
add(103, 'implicit host wildcard', 'config', ROTACE, fn('Only the virtual IP matches; real TCP traffic to it is load-distributed.', (c) => {
  assert.equal(evalAce(c, 2, { src: GLOBAL }).permit, true); assert.equal(evalAce(c, 2, { src: '203.0.113.11' }).permit, false); rotate(c);
}), { ...natEx((b) => { if (b.isr) natBefore(ROTPOOL, ROTMAP)(b); }), switch: fn('Standard bare address means a single host; rotary is not part of the Catalyst model.', (c) => {
  assert.equal(evalAce(c, 2, { src: GLOBAL }).permit, true); assert.equal(evalAce(c, 2, { src: '203.0.113.11' }).permit, false);
}) });
add(105, 'destination rotary rule', 'config', ROTMAP, fn('TCP only, round robin with sticky sessions and inverse VIP rewrite.', rotate), natEx((b) => { if (b.isr) natBefore(ROTPOOL, ROTACE)(b); else natBefore(ROTACE)(b); }, cfg, catRotary));
for (const [l, role, where, opposite] of [[106,'inside','lan','outside'],[107,'outside','wan','inside']] as const) {
  add(l, role, 'config-if', `ip nat ${role}`, fn('Without both roles no rewrite; placing the missing role makes static translation take effect.', (c) => { mapping(c); }),
    natEx((b) => { b.x(STAT, `interface ${where === 'lan' ? b.wan : b.lan}`, `ip nat ${opposite}`); assert.equal(flow(b).forward.received?.src, A); }, ci(where)));
}
// Deliberately use a different static global address when static and PAT coexist.
const populatedMixed = (b: Bench) => {
  natBefore(`ip nat inside source static ${A} 203.0.113.100`, SINGLE, `access-list 1 permit ${B}`, `${MAP} overload`)(b);
  assert.equal(http(b, 'B', C).forward.received?.src, GLOBAL);
};
add(109, 'populated table', 'priv', 'show ip nat translations', fn('Shows a real TCP flow and a separate static address mapping.', (_c, o) => {
  assert.match(o.output, /^---\s+203\.0\.113\.100\s+192\.168\.40\.10/m);
  assert.match(o.output, /^tcp\s+203\.0\.113\.10:49152\s+192\.168\.40\.11:49152/m);
}), natEx(populatedMixed, []));
add(110, 'real statistics', 'priv', 'show ip nat statistics', fn('Reports both interfaces and nonzero hit count from the flow.', (c, o) => {
  assert.ok(o.output.includes(c.lan) && o.output.includes(c.wan)); assert.match(o.output, /Hits: [1-9]\d*/);
}), natEx(populatedMixed, []));
add(111, 'NAT debug stub', 'priv', 'debug ip nat', display('Simulation notice only, no live NAT debug; translation counters are separate.', note(/Debugging is not simulated/)), { before: populatedMixed, preset: 'routed' });
add(112, 'clear live table, not rules', 'priv', 'clear ip nat trans *', fn('Deletes dynamic translations; static rules remain and traffic allocates again.', (c) => {
  assert.deepEqual(c.d.runtime.natTranslations, []); assert.equal(c.d.config.nat.staticRules[0]?.local, A); mapping(c, 'B'); assert.ok(c.d.runtime.natTranslations.length);
}), natEx(populatedMixed, []));

// Companion probes to the paper's basic NAT examples; no change to the paper inventory.
add(94, 'static TCP translation to a literal global port', 'config', `ip nat inside source static tcp ${A} 80 ${GLOBAL} 8080`, fn('External TCP/8080 is rewritten to A:80; client receives the answer from the mapped endpoint.', (c) => {
  const f = sendFlow(c.w, { fromDeviceId: 'C', dst: GLOBAL, proto: 'tcp', dport: 8080 });
  assert.equal(f.ok, true, f.summary); assert.equal(f.forward.atDeviceId, 'A'); assert.equal(f.forward.received?.dport, 80);
  assert.equal(f.repliedFrom, GLOBAL); assert.equal(f.reverse?.received?.sport, 8080);
}), natEx(natBefore()));
add(100, 'routed interface PAT (explicit overload)', 'config', (b) => `ip nat inside source list 1 interface ${b.wan} overload`, fn('A and B use the WAN interface IPv4 address with different ports; both replies return to the correct host.', (c) => {
  const a = mapping(c, 'A', WAN), b = mapping(c, 'B', WAN);
  assert.notEqual(a.forward.received?.sport, b.forward.received?.sport);
}), natEx(natBefore(PWL)));
add(100, 'unsupported route-map variant (Catalyst 17.3)', 'config', 'ip nat inside source route-map SELECT pool PUB',
  ck('correct hardware rejection', 'Cisco 17.3 explicitly excludes route-mapped NAT.', out(/route-mapped NAT is not supported/i), 'rejected'), { ...natEx(natBefore(POOL)), sOnly: true });
add(97, 'explicit deny in NAT selector', 'config', MAP, fn('ISR evaluates a deny ACE without applying NAT; the separately permitted source translates.', (c) => {
  assert.equal(http(c, 'A', C).forward.received?.src, A); mapping(c, 'B');
}), natEx(natBefore(POOL, `access-list 1 deny ${A}`, PWL), cfg,
  ck('correct hardware rejection', 'Catalyst 17.3 explicitly excludes deny ACEs from NAT selectors, not from general ACLs.', out(/explicit deny ACE/i), 'rejected')));
add(106, 'on an L2 access port (Catalyst)', 'config-if', 'ip nat inside',
  ck('correct hardware rejection', 'An L2 port cannot attach NAT; remains a switchport without a NAT role.', (c, o) => {
    assert.match(o.output, /layer-2 switchport/); assert.ok(c.d.config.interfaces[c.lan].switchport); assert.equal(c.d.config.interfaces[c.lan].natRole, undefined);
  }, 'rejected'), { sOnly: true, pre: ci() });
add(106, 'on an SVI (Catalyst scope boundary)', 'config-if', 'ip nat inside',
  ck('unresolved', 'Only physical routed ports are documented for this 17.3 front-panel profile. Exact C9300L SVI support is not established.', out(/SVI.*not modeled/i), 'rejected'),
  { sOnly: true, pre: [...cfg, 'interface Vlan1', `ip address ${LAN} ${MASK}`] });

// D: for each contributing form construct both endpoints through the CLI, insert the audited command at its proper point,
// then send an actual protected flow. The switch has no IKEv1 crypto-map mode on the hardware modeled here.
const catCrypto = hw('Catalyst 9300L does not support this IKEv1/crypto-map VPN. Later 9300X IPsec is IKEv2/SVTI only.');
const catCryptoExec = unsure('No IKEv1 crypto-map VPN on this SKU; exact availability of this operational keyword was not tested on real hardware.');
const DACL = 'access-list 120 permit ip any any';
const crypto = (wan: string, peer: string, o: Record<number, string> = {}) => [
  `crypto isakmp key auditkey address ${peer}`, 'crypto isakmp policy 10', 'encryption aes', 'hash sha', 'authentication pre-share',
  'group 2', 'lifetime 3600', 'exit', 'crypto ipsec transform-set TS esp-aes esp-sha-hmac', 'mode tunnel', 'exit', DACL,
  'crypto map CM 10 ipsec-isakmp', 'match address 120', `set peer ${peer}`, 'set transform-set TS',
  'set security-association lifetime seconds 3600', 'set security-association lifetime kilobytes 4608000', 'exit', `interface ${wan}`, 'crypto map CM',
].map((s, i) => o[i] ?? s);
const cryptoBoth = (b: Bench) => { if (b.isr) { b.p(...crypto(b.peerWan, WAN)); b.x(...crypto(b.wan, PEER)); assert.equal(flow(b).forward.encrypted, true); } };
const dcase = (line: number, index: number, m: ModeName, text: Text, variant: string, label: Label = 'functional', override?: Record<number,string>) => {
  const command = (b: Bench) => typeof text === 'function' ? text(b) : text;
  const build = (b: Bench) => crypto(b.wan, PEER, { ...override, [index]: command(b) });
  const proof = label === 'display-only' ? 'Stored in config; model does not expire or rekey IKE/IPsec SAs.'
    : variant.includes('RSA') ? 'Accepted and stored, but a matched RSA policy still refuses modeled IKE negotiation.'
    : label === 'partial' ? 'Agreed by both peers and traffic is marked protected; model always wraps as ESP and does not implement actual cipher/AH/compression behavior.'
    : 'Completing both CLI endpoints gives a working protected flow and usable SAs.';
  add(line, variant, m, text, ck(label, proof, (c) => {
    commands(c.w, 'X', [...build(c).slice(index + 1), 'end'], c.s);
    const f = flow(c);
    if (variant.includes('RSA')) { assert.equal(f.forward.reason, 'ipsec-negotiation-failed'); assert.match(f.forward.reasonText ?? '', /could not|cannot/i); assert.ok(f.forward.steps.some((s) => /only supports pre-shared keys/.test(s.detail ?? s.text))); }
    else { assert.equal(f.ok, true, f.summary); assert.equal(f.forward.encrypted, true, f.summary); assert.ok(c.d.runtime.ikeSas.length && c.d.runtime.ipsecSas.length); }
    if (variant.startsWith('transform mode ')) {
      const expectedMode = variant.split(' ').at(-1);
      assert.equal(c.d.runtime.ipsecSas[0]?.mode, expectedMode);
      const direct = sendFlow(c.w, { fromDeviceId: 'X', srcAddr: WAN, dst: PEER, proto: 'icmp' });
      assert.ok(direct.forward.steps.some((s) => s.deviceId === 'X' && s.stage === 'crypto' && s.verdict === 'changed' && s.text.includes(`ESP, ${expectedMode} mode`)), direct.summary);
    }
    if (label === 'display-only') {
      if (m === 'config-isakmp') assert.match(execNow(c, 'X', 'show crypto isakmp policy').output, /lifetime:\s+120 seconds/);
      else assert.ok(execNow(c, 'X', 'show running-config').output.includes(command(c)));
      c.w.tick += 100_000; const again = flow(c); assert.equal(again.forward.encrypted, true); assert.notEqual(again.forward.negotiated, true);
    }
  }), {
    preset: 'routed', before: (b) => { if (b.isr) b.p(...crypto(b.peerWan, WAN, { ...override, ...(index === 0 || index === 14 ? {} : { [index]: command(b) }) })); },
    pre: [...cfg, ...Array.from({ length: index }, (_, i): Text => (b) => build(b)[i])],
    prerequisite: 'ISR peer configured through CLI; securityk9 assumed by simulator.', switch: catCrypto,
    switchBlock: m === 'config' || m === 'config-if' ? undefined : (b) => build(b)[m === 'config-isakmp' ? 1 : m === 'cfg-crypto-trans' ? 8 : 12],
  });
  // A Catalyst test takes a minimal path to the audited command or nearest unavailable context, without unrelated IKE commands.
};
dcase(123, 0, 'config', `crypto isakmp key auditkey address ${PEER}`, 'peer IP PSK');
dcase(124, 1, 'config', 'crypto isakmp policy 10', 'policy entry');
for (const a of ['aes','aes 192','aes 256','des','3des']) dcase(125, 2, 'config-isakmp', `encryption ${a}`, `IKE ${a}`);
for (const a of ['sha','sha256','sha384','sha512','md5']) dcase(126, 3, 'config-isakmp', `hash ${a}`, `IKE ${a}`);
dcase(127, 4, 'config-isakmp', 'authentication pre-share', 'PSK authentication');
for (const a of ['rsa-sig','rsa-encr']) dcase(127, 4, 'config-isakmp', `authentication ${a}`, `RSA ${a}`, 'partial');
for (const a of [1,2,14]) dcase(128, 5, 'config-isakmp', `group ${a}`, `DH ${a}`);
dcase(129, 6, 'config-isakmp', 'lifetime 120', 'IKE timer', 'display-only');
for (const [a, l] of [['esp-aes esp-sha-hmac','functional'], ['esp-3des esp-md5-hmac','functional'], ['esp-gcm 256','functional'], ['ah-sha-hmac','partial'], ['esp-null esp-sha-hmac','partial'], ['esp-aes comp-lzs','partial']] as const) {
  dcase(131, 8, 'config', `crypto ipsec transform-set TS ${a}`, a, l);
}
for (const a of ['tunnel','transport']) dcase(132, 9, 'cfg-crypto-trans', `mode ${a}`, `transform mode ${a}`);
// L134 is a cross-reference, but independently tests the mirrored selectors as a precondition.
add(134, 'mirrored protected subnets', 'config', `access-list 120 permit ip 192.168.40.0 0.0.0.255 192.0.2.0 0.0.0.255`, fn('Mirror-image ACEs permit negotiation; changing the peer selector to the same direction prevents it.', (c) => {
  c.x(...crypto(c.wan, PEER).filter((_, i) => i !== 11)); assert.equal(flow(c).forward.encrypted, true);
  c.p('no access-list 120', 'access-list 120 permit ip 192.168.40.0 0.0.0.255 192.0.2.0 0.0.0.255');
  execNow(c, 'X', 'clear crypto sa'); assert.equal(flow(c).forward.reason, 'ipsec-negotiation-failed');
}), { preset: 'routed', pre: cfg, before: (b) => { if (b.isr) b.p(...crypto(b.peerWan, WAN, { 11: 'access-list 120 permit ip 192.0.2.0 0.0.0.255 192.168.40.0 0.0.0.255' })); },
  switch: partial('ACL evaluates normally, but the Catalyst 9300L has no IKEv1 crypto map to consume the mirrored selector.', (c) => {
    assert.equal(evalAce(c, 120).permit,true); assert.equal(evalAce(c,120,{src:C,dst:A}).permit,false);
  }) });
dcase(136, 12, 'config', 'crypto map CM 10 ipsec-isakmp', 'static map entry');
dcase(137, 13, 'config-crypto-map', 'match address 120', 'traffic selector');
dcase(138, 14, 'config-crypto-map', `set peer ${PEER}`, 'peer bound to map');
dcase(139, 15, 'config-crypto-map', 'set transform-set TS', 'referenced transform');
dcase(140, 16, 'config-crypto-map', 'set security-association lifetime seconds 120', 'IPsec time limit', 'display-only');
dcase(141, 17, 'config-crypto-map', 'set security-association lifetime kilobytes 2560', 'IPsec volume limit', 'display-only');
dcase(144, 20, 'config-if', 'crypto map CM', 'bind to WAN');
add(145, 'unbind WAN', 'config-if', 'no crypto map CM', fn('Removes the interface binding and renders subsequent traffic unprotected or rejected by peer.', (c) => {
  assert.equal(c.d.config.interfaces[c.wan].cryptoMap, undefined); assert.equal(flow(c).forward.encrypted, false);
}), { preset: 'routed', before: cryptoBoth, pre: ci('wan'), switch: catCrypto });
for (const [l, text, re] of [[147,'show crypto isakmp policy',/AES|aes/], [148,'show crypto isakmp sa',/QM_IDLE/], [149,'show crypto ipsec sa',/#pkts encaps: [1-9]/], [150,'show crypto ipsec transform-set',/esp-aes.*esp-sha-hmac/], [151,'show crypto map',/CM[\s\S]*198\.51\.100\.2/]] as const) {
  add(l, 'real modeled state', 'priv', text, shown('Shows the populated config or negotiated SA packet counters, not an empty template.', re), { preset: 'routed', before: cryptoBoth, switch: catCryptoExec });
}
for (const [l, t] of [[153,'debug crypto isakmp'],[154,'debug crypto ipsec'],[155,'no debug all']] as const) {
  add(l, 'debug toggle stub', 'priv', t, display('Accepted with a simulation notice; no debug hooks or job state.', note(/Debugging is not simulated/)));
}
add(157, 'clear phase 2', 'priv', 'clear crypto sa', fn('Clears local ESP SAs; next flow negotiates again.', (c) => {
  assert.equal(c.d.runtime.ipsecSas.length, 0); assert.equal(flow(c).forward.negotiated, true);
}), { preset: 'routed', before: cryptoBoth, switch: catCryptoExec });
add(158, 'clear phase 1 abbreviation', 'priv', 'clear crypto isa', fn('Removes local IKE SA; existing phase-2 SA is not cleared by this command.', (c) => {
  assert.equal(c.d.runtime.ikeSas.length, 0); assert.ok(c.d.runtime.ipsecSas.length);
}), { preset: 'routed', before: cryptoBoth, switch: catCryptoExec });
add(159, 'bad clear notation', 'priv', 'no crypto ipsec sa', bad('Use clear crypto sa (or a documented targeted clear form).'), { preset: 'routed', before: cryptoBoth });

// E: do not give credit for deliberately rejecting legacy forms as though they executed.
const oldQ = hw('This legacy queueing family was removed from IOS XE; use MQC and show policy-map interface.', 'rejected');
const oldQUncertain = unsure('Model deliberately rejects. Cisco documents the legacy feature migration, not explicit removal of this keyword on this exact image.', 'rejected');
for (const tier of ['high','medium','normal','low']) add(170, `legacy PQ ${tier}`, 'config', `priority-list 1 protocol ip ${tier} list 110`, oldQUncertain, { pre: cfg });
for (const [name, limits] of [['omitted',''],['high',' 20'],['high/medium',' 20 40'],['high/medium/normal',' 20 40 60'],['all tiers',' 20 40 60 80']]) {
  add(172, `legacy PQ queue-limit ${name}`, 'config', `priority-list 1 queue-limit${limits}`, oldQUncertain, { pre: cfg });
}
for (const [l, mode, text] of [[174,'config-if','priority-group 1'], [175,'priv','show queueing priority'],
  [177,'config','queue-list 1 protocol ip 2 list 110'], [178,'config','queue-list 1 queue 2 limit 30'],
  [179,'config','queue-list 1 queue 2 byte-count 3000'], [180,'config-if','custom-queue-list 1'], [181,'priv','show queueing custom'],
  [184,'config-if','no fair-queue'], [185,'config-if','fair-queue'], [187,'priv','show queueing fair']] as const) {
  add(l, text, mode, text, [174,177,178,179].includes(l) ? oldQUncertain : oldQ, { pre: mode === 'config-if' ? ci('wan') : mode === 'config' ? cfg : [] });
}
for (const [name, params] of [['none',''],['threshold',' 64'],['dynamic',' 64 256'],['all',' 64 256 0']]) {
  add(186, `legacy interface WFQ ${name}`, 'config-if', `fair-queue${params}`, oldQ, { pre: ci('wan') });
}
const MATCH = 'match access-group 110';
const QA = 'access-list 110 permit icmp any any';
const QNAME = 'class-map AUDIT';
const POLICY = 'policy-map OUT';
const CLS = 'class AUDIT';
const BIND = 'service-policy output OUT';
const attach = (b: Bench) => [`interface ${b.wan}`, 'bandwidth 128', BIND];
const qsetup = [QA, QNAME, MATCH, 'exit', POLICY, CLS];
const inClass = (c: Context, name = 'AUDIT') => assert.equal(flow(c).forward.qos.find((q) => q.deviceId === 'X')?.className, name);
const qend = (c: Context, ...lines: string[]) => commands(c.w, 'X', [...lines, 'end'], c.s);
for (const t of ['', ' match-all', ' match-any']) {
  const testClass = (c: Context) => {
    qend(c, MATCH, 'match access-group 111', 'exit', POLICY, CLS, 'exit', 'exit', ...attach(c));
    inClass(c, t === ' match-any' ? 'AUDIT' : 'class-default');
  };
  add(189, t.trim() || 'default match-all', 'config', `class-map${t} AUDIT`, fn('For two predicates, disjoint ACEs produce the expected AND/OR classification of a forwarded ICMP packet.', testClass), {
    preset: 'routed', before: (b) => b.x(QA, 'access-list 111 permit tcp any any'), pre: cfg,
    switch: partial('Model applies router multi-predicate semantics; Catalyst 17.3 physical port supports one match command per class map.', testClass),
  });
}
add(190, 'numbered ACL in a match-all class', 'config-cmap', MATCH, fn('ACL match classifies ICMP but not TCP.', (c) => {
  qend(c, 'exit', POLICY, CLS, 'exit', 'exit', ...attach(c)); inClass(c);
  assert.equal(http(c, 'A', C).forward.qos.find((q) => q.deviceId === 'X')?.className, 'class-default');
}), { preset: 'routed', pre: [...cfg, QA, QNAME] });
add(190, 'numbered ACL in match-any', 'config-cmap', MATCH, fn('An ACL match contributes to the OR predicate.', (c) => {
  qend(c, 'exit', POLICY, CLS, 'exit', 'exit', ...attach(c)); inClass(c);
}), { preset: 'routed', pre: [...cfg, QA, 'class-map match-any AUDIT'], switch: partial('Model accepts numbered ACL even in match-any; Catalyst docs require named extended ACL here.', (c) => {
  qend(c, 'exit', POLICY, CLS, 'exit', 'exit', ...attach(c)); inClass(c);
}) });
add(191, 'create policy', 'config', POLICY, fn('Creates a usable map that can classify traffic when attached.', (c) => { qend(c, CLS, 'exit', 'exit', ...attach(c)); inClass(c); }), { preset: 'routed', pre: [...cfg, QA, QNAME, MATCH, 'exit'] });
add(192, 'policy user class', 'config-pmap', CLS, fn('Selected traffic is recorded under the user class.', (c) => { qend(c, 'exit', 'exit', ...attach(c)); inClass(c); }), { preset: 'routed', pre: [...cfg, ...qsetup.slice(0, -1)] });
const qPriority = (kbps: number, burst?: number) => (c: Context) => {
  if (burst !== undefined) assert.equal(c.d.config.qos.policyMaps[0].classes[0].priority?.burstBytes, burst);
  qend(c, 'exit', 'exit', ...attach(c)); inClass(c); const p = qosPlan(c.w, 'X', c.wan);
  assert.equal(p.classes.find((q) => q.className === 'AUDIT')?.kbps, kbps);
  const load = qosLoad(c.w, { deviceId: 'X', iface: c.wan, offered: [
    { label: 'priority', kbps: 2_000_000, flow: { fromDeviceId: 'A', dst: C, proto: 'icmp' } },
    { label: 'other', kbps: 2_000_000, flow: { fromDeviceId: 'B', dst: C, proto: 'tcp', dport: 80 } },
  ] });
  assert.equal(load.rows[0].deliveredKbps, kbps);
};
const qclass = { preset: 'routed' as const, pre: (['configure terminal', QA, QNAME, MATCH, 'exit', POLICY, CLS] as const) };
add(193, 'numeric bandwidth', 'config-pmap-c', 'priority 16', fn('Classifies and limits priority traffic to 16 kbit/s in congestion load model.', qPriority(16)), qclass);
add(194, 'same numeric form, no burst', 'config-pmap-c', 'priority 16', fn('Same form as L193, numeric kbit/s, not the literal word kbps.', qPriority(16)), qclass);
add(194, 'numeric plus explicit burst', 'config-pmap-c', 'priority 16 1600', partial('Rate is used in QoS load; burst is stored, not exercised by the fluid model.', qPriority(16, 1600)), qclass);
add(195, 'percentage of configured bandwidth', 'config-pmap-c', 'priority percent 10', fn('On the modeled 128 kbit/s interface, congested priority traffic receives 12.8 kbit/s.', qPriority(12.8)), qclass);
add(196, 'fallback class', 'config-pmap', 'class class-default', fn('Unclassified forwarded traffic falls in default class.', (c) => { qend(c, 'exit', 'exit', ...attach(c)); inClass(c, 'class-default'); }), { preset: 'routed', pre: [...cfg, POLICY] });
const fair = (c: Context) => {
  qend(c, 'exit', 'exit', ...attach(c));
  const q = qosLoad(c.w, { deviceId: 'X', iface: c.wan, offered: [
    { label: 'A', kbps: 2_000_000, flow: { fromDeviceId: 'A', dst: C, proto: 'icmp' } },
    { label: 'B', kbps: 3_000_000, flow: { fromDeviceId: 'B', dst: C, proto: 'icmp' } },
  ] });
  assert.equal(q.ok, true); assert.match(q.rows[0].treatment, /fair-queue/);
  assert.ok(q.rows[0].deliveredKbps > 0); assert.equal(q.rows[0].deliveredKbps, q.rows[1].deliveredKbps);
};
add(197, 'MQC fair queue (not interface WFQ)', 'config-pmap-c', 'fair-queue', fn('Equal shares in modeled saturated class-default.', fair), {
  preset: 'routed', pre: [...cfg, POLICY, 'class class-default'], switch: partial('Model applies ISR-style per-flow fairness; Catalyst 17.3 hardware scheduling is different and exact CLI availability is unverified.', fair),
});
const qlimit = (c: Context) => assert.equal(c.d.config.qos.policyMaps[0].classes[0].queueLimit, 40);
add(198, 'packet queue depth', 'config-pmap-c', 'queue-limit 40', display('Queue depth is saved; no packet-level bounded queues or tail drops.', qlimit), {
  ...qclass, switch: partial('Simulator stores packets; 9300 17.3 documentation says packets are not supported as the queue-limit unit; use percent.', qlimit),
});
add(198, 'explicit packets unit contrast', 'config-pmap-c', 'queue-limit 40 packets', display('Same stored queue limit; no packet queue is simulated.', qlimit), {
  ...qclass, switch: partial('Model accepts a unit visible in Catalyst CLI help but unsupported for 9300 per the 17.3 reference.', qlimit),
});
add(199, 'sheet underscore typo', 'config-if', 'service_policy output OUT', bad('Use service-policy (hyphen).'), { preset: 'routed', pre: ci('wan') });
add(199, 'output application', 'config-if', BIND, fn('A real routed packet is classified by attached policy.', (c) => inClass(c)), {
  preset: 'routed', pre: [...qclass.pre, 'exit', 'exit', intf('wan'), 'bandwidth 128'],
});
add(200, 'show classifier', 'priv', 'show class-map', shown('Displays the live class with the configured ACL match.', /AUDIT[\s\S]*access-group\s+110/), { before: (b) => b.x(QA, QNAME, MATCH) });
add(201, 'show policy actions', 'priv', 'show policy-map', shown('Prints the policy and priority rate from its current definition.', /OUT[\s\S]*AUDIT[\s\S]*16/), { before: (b) => b.x(...qsetup, 'priority 16') });

// F: leases verify address, network, gateway, exclusions and relay rather than just pool config.
const DHCP = 'ip dhcp pool AUDIT';
const NET = `network 192.168.40.0 ${MASK}`;
const DG = `default-router ${LAN}`;
const dh = (b: Bench, id = 'A') => { getPc(b.w, id).nic.mode = 'dhcp'; return dhcpAcquire(b.w, id); };
const addrLease = (c: Context, expect: string, mask = MASK) => { const r = dh(c); assert.equal(r.ok, true, r.reasonText ?? 'DHCP acquisition failed'); assert.equal(r.address, expect); assert.equal(r.mask, mask); return r; };
add(208, 'create pool used by client', 'config', DHCP, fn('After entering pool and setting network, the client obtains a lease from it.', (c) => { qend(c, NET, DG); assert.equal(addrLease(c, '192.168.40.2').gateway, LAN); }), { preset: 'linked', pre: cfg });
for (const [label, tail, mask] of [['dotted mask',` ${MASK}`,MASK],['slash prefix',' /25','255.255.255.128'],['classful default','',MASK]] as const) {
  add(209, label, 'dhcp-config', `network 192.168.40.0${tail}`, fn('Client actually acquires a lease with the chosen mask.', (c) => { addrLease(c, '192.168.40.2', mask); }), { preset: 'linked', pre: [...cfg,DHCP] });
}
add(209, 'bare numeric prefix not CLI', 'dhcp-config', 'network 192.168.40.0 25', bad('IOS command expects /25 (or a dotted mask).', 'rejected'), { pre: [...cfg,DHCP] });
add(210, 'gateway option delivered', 'dhcp-config', DG, fn('Client receives its default gateway through DHCP.', (c) => assert.equal(addrLease(c, '192.168.40.2').gateway, LAN)), { preset: 'linked', pre: [...cfg,DHCP,NET] });
for (const [label, tail, expect] of [['one excluded address','','192.168.40.3'],['inclusive range',' 192.168.40.5','192.168.40.6']]) {
  add(212, label, 'config', `ip dhcp excluded-address 192.168.40.2${tail}`, fn('Allocation skips the excluded address(es).', (c) => { addrLease(c, expect); }), { preset: 'linked', pre: [...cfg,DHCP,NET,'exit'] });
}
add(214, 'unicast relay to remote DHCP', 'config-if', `ip helper-address ${PEER}`, fn('Client broadcast now receives a lease from the remote router, with gateway belonging to the client LAN.', (c) => {
  const r = addrLease(c, '192.168.40.2'); assert.equal(r.gateway, LAN); assert.equal(r.server, PEER); assert.ok(r.steps.some((s) => /relay/i.test(s.text)));
}), { preset: 'routed', pre: ci(), before: (b) => b.p(DHCP,NET,DG) });
add(217, 'remove the active pool', 'config', 'no ip dhcp pool AUDIT', fn('Deletes the pool and its binding; no fresh client lease is possible.', (c) => {
  assert.equal(c.d.runtime.dhcpBindings.length, 0); assert.equal(dh(c).ok, false);
}), { preset: 'linked', pre: cfg, before: (b) => { b.x(DHCP,NET,DG); assert.equal(dh(b).ok, true); } });

// G: audit the prompts written on paper separately from the corrected configuration mode.
for (const [l, text] of [[231,'alias exec auditroute show ip route'], [236,'menu AUDIT text 1 View interface status'], [237,'menu AUDIT command 1 show ip interface brief']] as const) {
  add(l, 'printed EXEC prompt', 'priv', text, bad('Creation belongs in global configuration, not privileged EXEC.'));
  if (l === 231) add(l, 'global config; executable alias', 'config', text, fn('Invoking the alias runs the live RIB command.', (c) => {
    assert.deepEqual(execNow(c, 'X', 'auditroute').output, execNow(c, 'X', 'show ip route').output);
    assert.match(execNow(c, 'X', 'auditroute').output, /192\.0\.2\.0/);
  }), { preset: 'routed', pre: cfg });
  else add(l, 'global config; passive menu entry', 'config', text, display('Saved in running config; EXEC menu invocation is not implemented.', (c) => {
    assert.ok(execNow(c, 'X', 'show running-config').output.includes(text)); assert.notEqual(execNow(c, 'X', 'menu AUDIT').status, 'ok');
  }), { pre: cfg });
}
add(232, 'custom EXEC alias visible', 'priv', 'show aliases', shown('Shows the configured alias and actual expansion.', /auditroute\s+show ip route/), { before: (b) => b.x('alias exec auditroute show ip route') });
const logHost = `logging ${C}`;
const srcIf = 'logging source-interface Loopback 0';
const loopback = (b: Bench) => b.x('interface Loopback0', 'ip address 203.0.113.9 255.255.255.255');
const logProbe = (b: Bench, level: number) => syslogProbe(b.w, 'X', level)[0];
add(242, 'legacy hostname-less IPv4 shorthand', 'config', logHost, fn('A real UDP/514 delivery reaches the configured station.', (c) => assert.equal(logProbe(c, 5)?.received, true)), { preset: 'routed', pre: cfg });
add(243, 'source interface with space', 'config', srcIf, fn('Collector sees configured loopback address instead of egress address.', (c) => assert.equal(logProbe(c, 5)?.seenFrom, '203.0.113.9')), { preset: 'routed', before: loopback, pre: [...cfg,logHost] });
const logLevels = ['emergencies','alerts','critical','errors','warnings','notifications','informational','debugging'];
const levelCase = (line: number, value: string, n: number) => add(line, `threshold ${value}`, 'config', `logging trap ${value}`, fn('Collector receives levels at or below the threshold, not higher ones.', (c) => {
  for (let i = 0; i <= 7; i++) assert.equal(logProbe(c, i)?.received === true, i <= n, `severity ${i}`);
}), { preset: 'routed', pre: [...cfg,logHost] });
for (const [i, k] of logLevels.entries()) { levelCase(244, String(i), i); levelCase(244,k,i); }
levelCase(247,'debugging',7); levelCase(248,'warnings',4); levelCase(249,'errors',3);
add(251, 'restore egress source', 'config', 'no logging source-interface', fn('Collector now sees WAN egress IPv4 address.', (c) => assert.equal(logProbe(c, 5)?.seenFrom, WAN)), { preset: 'routed', before: loopback, pre: [...cfg,logHost,srcIf] });
add(252, 'disable remote logging', 'config', 'no logging trap', fn('Even severity 0 no longer reaches the remote collector; logging trap warnings re-enables it.', (c) => {
  assert.notEqual(logProbe(c, 0)?.received, true); c.x('logging trap warnings'); assert.equal(logProbe(c, 0)?.received, true);
}), { preset: 'routed', pre: [...cfg,logHost,'logging trap warnings'] });

const sn = (c: Bench, from: 'A'|'B' = 'A', oid = 'sysName', write = false) => snmpRequest(c.w, from, { host: LAN, community: 'audit', oid, op: write ? 'set' : 'get', value: 'Modified by modeled manager' });
const snset = (c: Bench) => sn(c, 'A', 'sysContact', true);
const ro = 'snmp-server community audit ro';
for (const access of ['', 'ro', 'rw']) for (const withAcl of [false,true]) {
  const text = `snmp-server community audit${access ? ` ${access}` : ''}${withAcl ? ' 10' : ''}`;
  add(259, `${access || 'default RO'}, ${withAcl ? 'numbered ACL' : 'no ACL'}`, 'config', text, fn('GET, permitted/denied SET and source-filter results match the configured community.', (c) => {
    assert.equal(sn(c).ok, true); assert.equal(snset(c).ok, access === 'rw'); assert.equal(sn(c, 'B').ok, !withAcl);
  }), { preset: 'linked', pre: withAcl ? [...cfg,`access-list 10 permit ${A}`] : cfg });
}
const viewIn = 'snmp-server view VIEW 1.3.6.1.2.1.1 included';
const viewOut = 'snmp-server view VIEW 1.3.6.1.2.1.1.5 excluded';
add(261, 'numeric include subtree', 'config', viewIn, fn('SNMP GET works for MIB-2 system but not interface subtree.', (c) => {
  c.x('snmp-server community audit view VIEW ro'); assert.equal(sn(c).ok, true); assert.equal(sn(c, 'A', 'ifNumber').ok, false);
}), { preset: 'linked', pre: cfg });
add(261, 'more specific numeric exclude', 'config', viewOut, fn('More-specific exclusion denies sysName; sysLocation remains visible.', (c) => {
  assert.equal(sn(c).ok, false); assert.equal(sn(c, 'A', 'sysLocation').ok, true);
}), { preset: 'linked', pre: [...cfg,viewIn,'snmp-server community audit view VIEW ro'] });
add(261, 'symbolic subtree', 'config', 'snmp-server view VIEW system included', fn('Named system root includes sysName but excludes ifNumber.', (c) => {
  c.x('snmp-server community audit view VIEW ro'); assert.equal(sn(c).ok, true); assert.equal(sn(c, 'A', 'ifNumber').ok, false);
}), { preset: 'linked', pre: cfg });
add(261, 'wildcard in numeric subtree', 'config', 'snmp-server view VIEW 1.3.6.1.2.1.1.*.0 included', fn('Numeric wildcard arcs expose matching scalar leaves, not unrelated MIB objects.', (c) => {
  c.x('snmp-server community audit view VIEW ro'); assert.equal(sn(c).ok, true); assert.equal(sn(c, 'A', 'ifNumber').ok, false);
}), { preset: 'linked', pre: cfg });
for (const a of ['', 'ro', 'rw']) for (const withAcl of [false,true]) {
  const text = `snmp-server community audit view VIEW${a ? ` ${a}` : ''}${withAcl ? ' 10' : ''}`;
  add(262, `view, ${a || 'default RO'}, ${withAcl ? 'numbered ACL' : 'no ACL'}`, 'config', text, fn('Input community activates both view and source filtering; RO/RW applies to allowed leaves.', (c) => {
    assert.equal(sn(c).ok, false); assert.equal(sn(c,'A','sysContact').ok, true); assert.equal(sn(c,'B','sysContact').ok, !withAcl);
    assert.equal(snset(c).ok, a === 'rw'); assert.equal(sn(c,'A','sysName',true).ok, false);
  }), { preset: 'linked', pre: [...cfg,viewIn,viewOut,...(withAcl ? [`access-list 10 permit ${A}`] : [])] });
}
for (const [l, key, oid] of [[264,'location','sysLocation'],[265,'contact','sysContact']] as const) {
  add(l, 'live OID value', 'config', `snmp-server ${key} Model Only`, fn('A real modeled SNMP request retrieves the configured value.', (c) => assert.match(sn(c,'A',oid).text, /STRING: Model Only/)), { preset: 'linked', pre: [...cfg,ro] });
}
for (const [l,text,why] of [[266,'snmp-server packetsize 484','Bounds are parsed and config saved; model never fragments/sizes SNMP PDUs to the configured limit.'],
 [267,'snmp-server ifindex persist','Saved in config; no verification of real cross-boot interface index allocation.'],
 [268,'snmp-server system-shutdown','Saved in config; simulator cannot remotely reload via SNMP.']] as const) {
  add(l, 'passive setting', 'config', text, display(why, (c) => assert.ok(execNow(c,'X','show running-config').output.includes(text))), { pre: cfg,
    switch: l === 266 ? undefined : ck('unresolved', 'Simulator stores the setting. Exact form on 9300L 17.3 is unverified; documented persistence form is snmp ifmib ifindex persist.', (c) => assert.ok(execNow(c,'X','show running-config').output.includes(text))) });
}
const host = `snmp-server host ${C}`;
const TRAPS = 'snmp-server enable traps';
const emit = (b: Bench, kind: string) => emitSnmpTrap(b.w, 'X', kind, `Audit ${kind}`);
const coveredNotifications = (b: Bench) => {
  const summary: ScenarioSummary = { id: 'coverage-notifications', title: 'Notification coverage', features: ['snmp'], family: 'lab', minutes: 1, level: 1, blurb: '', seedable: false };
  const def: ScenarioDef = { summary, build: (seed) => ({
    summary, seed, brief: { intro: '', items: [] }, diagram: { nodes: [], links: [] },
    bench: b.w.order.map((id) => { const { model, label, x, y } = b.w.devices[id]; return { id, model, label, x, y }; }),
    initial: {
      cables: [...b.w.cables, { kind: 'console', a: { deviceId: 'A', port: 'COM1' }, b: { deviceId: 'X', port: 'Console' } }],
      configs: Object.fromEntries(b.w.order.filter((id) => isIos(b.w.devices[id])).map((id) => {
        // Scenario seeding is a merge, so make enabled interfaces explicit (running-config omits no shutdown).
        const up = Object.values(getIos(b.w, id).config.interfaces).filter((intf) => !intf.shutdown);
        const explicit = up.map((intf) => `!\ninterface ${intf.name}\n no shutdown`).join('\n');
        return [id, renderRunningConfig(b.w, id).replace(/\nend\n$/, `\n${explicit}\nend\n`)];
      })),
      pcs: Object.fromEntries(['A', 'B', 'C'].map((id) => { const { nic, services } = getPc(b.w, id); return [id, { ...nic, services }]; })),
    },
    requirements: [], guide: [], solution: { cables: [], pcs: {}, configs: {}, notes: [] }, hardwareNotes: [],
    grade: () => ({ requirements: [], orderIssues: [] }), guideProgress: () => ({}),
  }) };
  const lab = new Lab({ scenarios: [def], now: () => 1 });
  assert.equal(lab.startScenario(summary.id, 'free').ok, true);
  const apply = (config: string) => { const result = lab.applyConfigText('X', config, 'merge'); assert.equal(result.ok, true, result.message ?? JSON.stringify(result.lines)); };
  const received = () => getPc(lab.getState().world!, 'C').runtime.traps;
  return { apply, received, configChange: () => apply('snmp-server location Audit'), linkBounce: () => {
    apply(`interface ${b.lan}\n shutdown`);
    apply(`interface ${b.lan}\n no shutdown`);
  } };
};
const checkSavedHost = (c: Context, version: '2c' | '3', type: string, level?: string) => {
  const before = structuredClone(c.d.config.snmp.hosts);
  const rendered = execNow(c, 'X', 'show running-config').output.split('\n').find((text) => text.startsWith(host));
  assert.equal(rendered, `${host}${type === 'informs' ? ' informs' : ''} version ${version}${level ? ` ${level}` : ''} audituser config snmp`);
  assert.match(execNow(c, 'X', 'show snmp host').output, /Notification types: config snmp/);
  assert.equal(applyConfigText(c.w, 'X', rendered!, 'merge').ok, true);
  saveStartupConfig(c.w, 'X');
  reloadDevice(c.w, 'X');
  assert.deepEqual(getIos(c.w, 'X').config.snmp.hosts, before);
  assert.equal(emit(c, 'config').length, 0);
};
for (const [label, opts] of [['default',''],['explicit traps',' traps'],['v1 traps',' traps version 1'],['v2c traps',' traps version 2c']]) {
  add(270, label, 'config', `${host}${opts} audit`, partial('A real Lab config-file edit delivers one modeled UDP/162 trap; wire PDUs are not emulated.', (c) => {
    const l = coveredNotifications(c); l.configChange(); assert.deepEqual(l.received().map((t) => t.community), ['audit']);
  }), { preset: 'routed', pre: [...cfg,TRAPS] });
}
add(270, 'v2c informs', 'config', `${host} informs version 2c audituser config snmp`, display('Host and filters survive running-config re-import and reload; no inform request, acknowledgment or retry.', (c) => {
  checkSavedHost(c, '2c', 'informs');
}), { preset: 'routed', pre: [...cfg,TRAPS] });
for (const [label, version] of [['informs implicit version', ''], ['v1 informs impossible', ' version 1']]) {
  add(270, label, 'config', `${host} informs${version} audit`, ck('ill-formed paper notation', 'SNMPv1 (also the default) has no informs; the command is rejected without creating a target.', (c, o) => {
    assert.match(o.output, /SNMPv1 does not support informs/); assert.deepEqual(c.d.config.snmp.hosts, []); assert.deepEqual(emit(c, 'config'), []);
  }, 'rejected'), { preset: 'routed', pre: [...cfg,TRAPS] });
}
for (const kind of ['traps','informs']) for (const sec of ['auth','noauth','priv']) {
  add(270, `v3 ${kind} ${sec}`, 'config', `${host} ${kind} version 3 ${sec} audituser config snmp`, display('Security level and types survive running-config re-import and reload. No SNMPv3 USM or delivery.', (c) => {
    assert.equal(c.d.config.snmp.hosts[0]?.securityLevel, sec);
    checkSavedHost(c, '3', kind, sec);
  }), { preset: 'routed', pre: [...cfg,TRAPS] });
}
add(270, 'same host and type, updated community', 'config', `${host} traps version 2c second`, fn('Old settings are replaced for this host/kind; a real config event reaches the collector once with the new community.', (c) => {
  const l = coveredNotifications(c); l.configChange(); assert.deepEqual(l.received().map((t) => t.community), ['second']);
}), { preset: 'routed', pre: [...cfg,TRAPS,`${host} traps version 2c first`] });
add(270, 'v3 omitted security selector', 'config', `${host} traps version 3 audituser config snmp`, display('Omitted v3 level defaults to noauth, survives render/reload, and does not send.', (c) => {
  assert.equal(c.d.config.snmp.hosts[0]?.securityLevel, 'noauth'); checkSavedHost(c, '3', 'traps', 'noauth');
}), { preset: 'routed', pre: [...cfg,TRAPS] });
add(270, 'host notification family filter', 'config', `${host} audit snmp`, fn('After config save/boot, real link events pass the host filter and config events are suppressed.', (c) => {
  saveStartupConfig(c.w, 'X'); reloadDevice(c.w, 'X');
  assert.deepEqual(getIos(c.w, 'X').config.snmp.hosts[0]?.notificationTypes, ['snmp']);
  const l = coveredNotifications(c); l.configChange(); assert.deepEqual(l.received(), []);
  l.linkBounce(); assert.equal(l.received().length, 2); assert.ok(l.received().every((t) => t.text.startsWith('Line protocol')));
}), { preset: 'routed', pre: [...cfg,TRAPS] });
add(270, 'collector hostname', 'config', 'snmp-server host collector.example.net audit', gap('Host IDs can be resolved names on IOS; model supports IPv4 literals only.'), { pre: cfg });
add(275, 'source IPv4 address', 'config', 'snmp-server trap-source Loopback0', fn('A real config event reaches the collector with the loopback source address.', (c) => {
  const l = coveredNotifications(c); l.configChange(); assert.deepEqual(l.received().map((t) => t.from), ['203.0.113.9']);
}), { preset: 'routed', before: loopback, pre: [...cfg,`${host} audit`,TRAPS] });
add(276, 'enable all modeled notifications', 'config', TRAPS, partial('Config-file edits and both link transitions deliver traps; this is not a full Cisco notification catalog.', (c) => {
  const l = coveredNotifications(c); l.configChange(); assert.equal(l.received().length, 1);
  l.linkBounce(); assert.equal(l.received().filter((t) => t.text.startsWith('Line protocol')).length, 2);
}), { preset: 'routed', pre: [...cfg,`${host} audit`] });
add(276, 'enable notification type', 'config', `${TRAPS} config`, fn('Config-file edit generates a trap; line-protocol changes generate no link trap or trace with only config enabled.', (c) => {
  const l = coveredNotifications(c); l.configChange(); assert.equal(l.received().length, 1);
  l.linkBounce(); assert.equal(l.received().filter((t) => t.text.startsWith('Line protocol')).length, 0);
  assert.deepEqual(emit(c, 'snmp linkdown'), []);
}), { preset: 'routed', pre: [...cfg,`${host} audit`] });
add(276, 'SNMP typed notification option', 'config', `${TRAPS} snmp linkdown`, fn('A genuine line-protocol bounce delivers only linkDown.', (c) => {
  const l = coveredNotifications(c); l.linkBounce(); assert.equal(l.received().length, 1); assert.match(l.received()[0].text, /changed state to down$/);
}), { preset: 'routed', pre: [...cfg,`${host} audit`] });
add(276, 'SNMP family and multiple event options', 'config', `${TRAPS} snmp authentication linkdown linkup`, partial('Both link transitions deliver independently from one selector; authenticationFailure is not produced.', (c) => {
  const l = coveredNotifications(c); l.linkBounce(); assert.deepEqual(l.received().map((t) => t.text.split(' ').at(-1)), ['down', 'up']);
  assert.deepEqual(emit(c, 'snmp authentication'), []);
}), { preset: 'routed', pre: [...cfg,`${host} audit`] });
add(278, 'disable agent', 'config', 'no snmp-server', fn('Existing model SNMP access and notifications stop; subsequent config and link events deliver nothing.', (c) => {
  assert.equal(sn(c).ok, false); assert.deepEqual(emit(c, 'config'), []);
  const l = coveredNotifications(c); l.configChange(); l.linkBounce(); assert.deepEqual(l.received(), []);
}), { preset: 'routed', pre: [...cfg,ro,`${host} audit`,TRAPS], before: (b) => { b.x(ro, `${host} audit`, TRAPS); assert.equal(sn(b).ok, true); } });
