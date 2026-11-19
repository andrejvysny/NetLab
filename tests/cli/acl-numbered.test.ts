/** Numbered access lists: accepted forms, normalisation, port names vs numbers, ICMP types, student errors, `no` forms, parseAce. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, addDevice, getIos } from '../../src/engine/world.ts';
import { startSession, execLine, helpFor } from '../../src/engine/cli/framework.ts';
import type { Ace, AddrMatch } from '../../src/engine/types.ts';
import { PORT_NAMES } from '../../src/engine/ip.ts';
import * as acl from '../../src/engine/cli/commands/acl.ts';
import { parseAce, TCP_PORT_KEYWORDS, UDP_PORT_KEYWORDS } from '../../src/engine/cli/commands/acl.ts';
acl.install();

const PROMPT = 'Router(config)#';
function lab() {
  const w = createWorld();
  addDevice(w, { id: 'r1', model: 'isr4331', label: 'R1', x: 0, y: 0 });
  const { session: s } = startSession(w, 'r1', 'console');
  s.mode = 'config';
  const dev = getIos(w, 'r1');
  const run = (l: string) => execLine(w, s, l);
  const ok = (l: string) => { const o = run(l); assert.equal(o.status, 'ok', `"${l}" → ${o.status}\n${o.output}`); return o; };
  /** The single entry an `access-list N …` line produced in an empty list. */
  const one = (l: string): Ace => {
    const id = l.split(/\s+/)[1];
    delete dev.config.acls[id];
    ok(l);
    assert.equal(dev.config.acls[id].entries.length, 1);
    return dev.config.acls[id].entries[0];
  };
  return { w, s, dev, run, ok, one };
}
const any: AddrMatch = { kind: 'any' };
const host = (address: string): AddrMatch => ({ kind: 'host', address });
const net = (address: string, wildcard: string): AddrMatch => ({ kind: 'net', address, wildcard });
/** Caret line that IOS prints under the token starting at `token` in `line`. */
const caretUnder = (line: string, token: string) => ' '.repeat(PROMPT.length + line.indexOf(token)) + '^';

test('standard lists: address forms and normalisation', () => {
  const { dev, one, ok } = lab();
  assert.deepEqual(one('access-list 1 permit 192.168.100.0 0.0.0.255'), { seq: 10, action: 'permit', protocol: 'ip', src: net('192.168.100.0', '0.0.0.255'), dst: any });
  assert.deepEqual(one('access-list 10 permit host 192.168.100.10').src, host('192.168.100.10'));
  assert.deepEqual(one('access-list 10 permit 192.168.100.10').src, host('192.168.100.10'), 'no wildcard = one host');
  assert.deepEqual(one('access-list 10 permit 192.168.100.10 0.0.0.0').src, host('192.168.100.10'), 'A 0.0.0.0 → host A');
  assert.deepEqual(one('access-list 10 deny any').src, any);
  assert.deepEqual(one('access-list 10 permit 0.0.0.0 255.255.255.255').src, any, '0.0.0.0 255.255.255.255 → any');
  assert.deepEqual(one('access-list 10 permit 192.168.100.77 0.0.0.255').src, net('192.168.100.0', '0.0.0.255'), 'wildcard bits cleared');
  assert.deepEqual(one('access-list 1300 deny 10.0.0.0 0.255.255.255 log'), { seq: 10, action: 'deny', protocol: 'ip', src: net('10.0.0.0', '0.255.255.255'), dst: any, log: true });
  assert.equal(dev.config.acls['1300'].type, 'standard');
  assert.equal(dev.config.acls['1300'].named, false);
  // sequence numbers 10, 20, 30
  ok('access-list 5 permit host 1.1.1.1');
  ok('access-list 5 permit host 2.2.2.2');
  ok('access-list 5 deny any');
  assert.deepEqual(dev.config.acls['5'].entries.map((e) => e.seq), [10, 20, 30]);
  // the same entry twice is kept once
  ok('access-list 5 permit host 2.2.2.2');
  assert.equal(dev.config.acls['5'].entries.length, 3);
});

test('wildcard typed as a subnet mask is accepted as typed and masks the address bits', () => {
  const { dev, ok } = lab();
  const o = ok('access-list 1 permit 192.168.100.0 255.255.255.0');
  assert.deepEqual(dev.config.acls['1'].entries[0].src, net('0.0.0.0', '255.255.255.0'));
  assert.equal(o.output, '', 'IOS prints nothing');
  assert.ok(o.notes.some((n) => /looks like a subnet mask/.test(n) && /0\.0\.0\.255/.test(n)), o.notes.join('\n'));
  const o2 = ok('access-list 110 permit ip 192.168.100.0 255.255.255.0 any');
  assert.deepEqual(dev.config.acls['110'].entries[0].src, net('0.0.0.0', '255.255.255.0'));
  assert.ok(o2.notes.length > 0);
});

test('extended lists: protocols, addresses, ports and flags', () => {
  const { one } = lab();
  assert.deepEqual(one('access-list 110 permit tcp host 192.168.100.101 60.50.40.0 0.0.0.63 eq www'),
    { seq: 10, action: 'permit', protocol: 'tcp', src: host('192.168.100.101'), dst: net('60.50.40.0', '0.0.0.63'), dstPort: { op: 'eq', ports: [80] } });
  assert.deepEqual(one('access-list 101 deny udp 10.0.0.0 0.0.0.255 gt 1023 host 1.1.1.1 range 100 200 log'), {
    seq: 10, action: 'deny', protocol: 'udp', src: net('10.0.0.0', '0.0.0.255'), srcPort: { op: 'gt', ports: [1023] },
    dst: host('1.1.1.1'), dstPort: { op: 'range', ports: [100, 200] }, log: true,
  });
  assert.deepEqual(one('access-list 101 permit tcp any any established'), { seq: 10, action: 'permit', protocol: 'tcp', src: any, dst: any, established: true });
  assert.deepEqual(one('access-list 101 permit tcp any any eq www established log'),
    { seq: 10, action: 'permit', protocol: 'tcp', src: any, dst: any, dstPort: { op: 'eq', ports: [80] }, established: true, log: true });
  assert.deepEqual(one('access-list 101 permit tcp any neq 23 any lt 1024'),
    { seq: 10, action: 'permit', protocol: 'tcp', src: any, srcPort: { op: 'neq', ports: [23] }, dst: any, dstPort: { op: 'lt', ports: [1024] } });
  for (const p of ['esp', 'ahp', 'gre', 'ospf', 'eigrp', 'ip'] as const) {
    assert.equal(one(`access-list 101 permit ${p} host 60.50.30.1 host 60.50.30.2`).protocol, p);
  }
  assert.equal(one('access-list 101 permit 50 host 1.1.1.1 host 2.2.2.2').protocol, 'esp', 'protocol numbers with a name become the name');
  assert.equal(one('access-list 101 permit 6 any any').protocol, 'tcp');
  assert.equal(one('access-list 101 permit 51 any any').protocol, 'ahp');
  assert.equal(one('access-list 101 permit 112 any any').protocol, 112);
  assert.equal(one('access-list 101 permit pim any any').protocol, 103, 'keywords without an AclProtocol name are stored as numbers');
  assert.deepEqual(one('access-list 2000 deny tcp any host 10.1.1.1 eq 23').dstPort, { op: 'eq', ports: [23] }, 'expanded range');
  // address normalisation in extended lists
  assert.deepEqual(one('access-list 101 permit ip 10.0.0.5 0.0.0.255 10.1.1.1 0.0.0.0').src, net('10.0.0.0', '0.0.0.255'));
  assert.deepEqual(one('access-list 101 permit ip 10.0.0.5 0.0.0.255 10.1.1.1 0.0.0.0').dst, host('10.1.1.1'));
  assert.deepEqual(one('access-list 101 permit ip 0.0.0.0 255.255.255.255 any').src, any);
  assert.deepEqual(one('access-list 101 permit ip any 10.0.0.0 0.255.0.255').dst, net('10.0.0.0', '0.255.0.255'), 'non-contiguous wildcard is fine');
});

test('port names and numbers give the same entry', () => {
  const { one } = lab();
  const port = (l: string) => one(l).dstPort;
  assert.deepEqual(port('access-list 120 permit tcp any any eq www'), port('access-list 120 permit tcp any any eq 80'));
  assert.deepEqual(port('access-list 120 permit tcp any any eq telnet'), { op: 'eq', ports: [23] });
  assert.deepEqual(port('access-list 120 permit tcp any any eq tel'), { op: 'eq', ports: [23] }, 'port keywords may be abbreviated');
  assert.deepEqual(port('access-list 120 permit tcp any any eq ftp'), { op: 'eq', ports: [21] }, 'exact name wins over ftp-data');
  assert.deepEqual(port('access-list 120 permit tcp any any eq ftp-data'), { op: 'eq', ports: [20] });
  assert.deepEqual(port('access-list 120 permit udp any any eq snmp'), { op: 'eq', ports: [161] });
  assert.deepEqual(port('access-list 120 permit udp any any eq snmptrap'), { op: 'eq', ports: [162] });
  assert.deepEqual(port('access-list 120 permit udp any any eq domain'), { op: 'eq', ports: [53] });
  assert.deepEqual(port('access-list 120 permit tcp any any eq domain'), { op: 'eq', ports: [53] });
  assert.deepEqual(port('access-list 120 permit udp any any range bootps bootpc'), { op: 'range', ports: [67, 68] });
  assert.deepEqual(one('access-list 120 permit tcp any eq 22 any').srcPort, { op: 'eq', ports: [22] });
  // our IOS keyword tables agree with ip.ts PORT_NAMES wherever both know a name
  for (const [name, n] of Object.entries(PORT_NAMES)) {
    if (TCP_PORT_KEYWORDS[name] !== undefined) assert.equal(TCP_PORT_KEYWORDS[name], n, name);
    if (UDP_PORT_KEYWORDS[name] !== undefined) assert.equal(UDP_PORT_KEYWORDS[name], n, name);
  }
});

test('ICMP types by keyword or number', () => {
  const { one } = lab();
  const t = (l: string) => one(l).icmpType;
  assert.equal(t('access-list 101 permit icmp any any echo'), 'echo');
  assert.equal(t('access-list 101 permit icmp any any echo-reply'), 'echo-reply');
  assert.equal(t('access-list 101 deny icmp any any unr'), 'unreachable', 'abbreviated');
  assert.equal(t('access-list 101 deny icmp any any time-exceeded'), 'time-exceeded');
  assert.equal(t('access-list 101 deny icmp any any redirect'), 'redirect');
  assert.equal(t('access-list 101 deny icmp any any host-unreachable'), 'host-unreachable');
  assert.equal(t('access-list 101 deny icmp any any ttl-exceeded'), 'ttl-exceeded');
  assert.equal(t('access-list 101 permit icmp any any 8'), 'echo', 'numbers with a name become the name');
  assert.equal(t('access-list 101 permit icmp any any 0'), 'echo-reply');
  assert.equal(t('access-list 101 permit icmp any any 3 13'), 'administratively-prohibited');
  assert.equal(t('access-list 101 permit icmp any any 42'), 42);
  assert.equal(t('access-list 101 permit icmp any any 3 99'), '3 99');
  assert.deepEqual(one('access-list 101 permit icmp any any echo log'), { seq: 10, action: 'permit', protocol: 'icmp', src: any, dst: any, icmpType: 'echo', log: true });
  assert.equal(one('access-list 101 permit icmp any any').icmpType, undefined);
});

test('remarks do not use a sequence number of their own', () => {
  const { dev, ok } = lab();
  ok('access-list 110 remark Block PC1 from R2 loopback');
  ok('access-list 110 deny ip host 192.168.100.10 host 2.2.2.2');
  ok('access-list 110 remark everything else');
  ok('access-list 110 permit ip any any');
  assert.deepEqual(dev.config.acls['110'].entries.map((e) => [e.seq, e.action, e.remark]), [
    [10, 'remark', 'Block PC1 from R2 loopback'], [10, 'deny', undefined], [20, 'remark', 'everything else'], [20, 'permit', undefined],
  ]);
  ok('no access-list 110 remark everything else');
  assert.equal(dev.config.acls['110'].entries.length, 3);
  ok('no access-list 110 remark');
  assert.deepEqual(dev.config.acls['110'].entries.map((e) => e.action), ['deny', 'permit']);
});

test('no access-list removes the whole numbered list (also with an entry after it)', () => {
  const { dev, ok, w } = lab();
  ok('access-list 110 deny ip host 192.168.100.10 host 2.2.2.2');
  ok('access-list 110 permit ip any any');
  dev.runtime.aclHits = { '110:10': 4, '120:10': 1 };
  const o = ok('no access-list 110 permit ip any any');
  assert.equal(dev.config.acls['110'], undefined);
  assert.ok(o.notes.some((n) => /whole access list 110/.test(n)));
  assert.deepEqual(dev.runtime.aclHits, { '120:10': 1 }, 'its counters go too');
  ok('access-list 10 permit any');
  ok('no access-list 10');
  assert.equal(dev.config.acls['10'], undefined);
  ok('no access-list 99');
  assert.equal(w.devices.r1.kind, 'router');
});

test('errors a student is likely to make', () => {
  const { run, dev } = lab();
  // port operator on protocol ip
  let line = 'access-list 110 permit ip any eq 80 any';
  let o = run(line);
  assert.equal(o.status, 'invalid');
  assert.equal(o.output, `${caretUnder(line, 'eq')}\n% Invalid input detected at '^' marker.\n`);
  line = 'access-list 110 permit ip any any eq 80';
  o = run(line);
  assert.equal(o.output.split('\n')[0], caretUnder(line, 'eq'));
  // missing destination / missing wildcard / missing port
  for (const l of ['access-list 110 permit tcp host 192.168.100.101', 'access-list 110 permit ip 10.0.0.0 any', 'access-list 110 permit tcp any any eq',
    'access-list 110 permit', 'access-list 10 permit', 'access-list 110 permit tcp any host']) {
    o = run(l);
    if (l === 'access-list 110 permit ip 10.0.0.0 any') { assert.equal(o.status, 'invalid', l); continue; }
    assert.equal(o.status, 'incomplete', l);
    assert.equal(o.output, '% Incomplete command.\n');
  }
  // wrong number range
  line = 'access-list 250 permit ip any any';
  o = run(line);
  assert.equal(o.status, 'invalid');
  assert.equal(o.output.split('\n')[0], caretUnder(line, '250'));
  // standard syntax with an extended number, and the other way round
  line = 'access-list 100 permit 192.168.1.0 0.0.0.255';
  o = run(line);
  assert.equal(o.output.split('\n')[0], caretUnder(line, '192.168.1.0'));
  line = 'access-list 10 permit tcp any any';
  o = run(line);
  assert.equal(o.output.split('\n')[0], caretUnder(line, 'tcp'));
  // IOS has no "ssh"/"https" keyword; UDP names on TCP and back
  for (const [l, tok] of [['access-list 110 permit tcp any any eq ssh', 'ssh'], ['access-list 110 permit tcp any any eq https', 'https'],
    ['access-list 110 permit udp any any eq www', 'www'], ['access-list 110 permit tcp any any eq snmp', 'snmp'],
    ['access-list 110 permit tcp any any eq 70000', '70000'], ['access-list 110 permit tcp any eq foo any', 'foo']] as const) {
    o = run(l);
    assert.equal(o.status, 'rejected', l);
    assert.equal(o.output, `${caretUnder(l, tok)}\n% Invalid input detected at '^' marker.\n`, l);
  }
  assert.ok(run('access-list 110 permit tcp any any eq ssh').notes.some((n) => /eq 22/.test(n)));
  assert.ok(run('access-list 110 permit udp any any eq www').notes.some((n) => /TCP port name/.test(n)));
  // ambiguous abbreviations
  o = run('access-list 110 permit tcp any any eq e');
  assert.equal(o.status, 'rejected');
  assert.equal(o.output, '% Ambiguous command:  "access-list 110 permit tcp any any eq e"\n');
  o = run('access-list 110 permit i any any');
  assert.equal(o.status, 'ambiguous');
  o = run('access-list 110 permit tcp any any e');
  assert.equal(o.status, 'ambiguous', 'eq or established');
  // icmp type out of range, established on udp, log twice
  assert.equal(run('access-list 110 permit icmp any any 300').status, 'invalid');
  assert.equal(run('access-list 110 permit udp any any established').status, 'invalid');
  assert.equal(run('access-list 110 permit ip any any log log').status, 'invalid');
  assert.equal(dev.config.acls['110'], undefined, 'nothing was stored by the failed lines');
  assert.equal(dev.config.acls['10'], undefined);
});

test('? help reads like IOS', () => {
  const { w, s } = lab();
  assert.match(helpFor(w, s, 'access-list '), /<1-99>\s+IP standard access list\n[\s\S]*<100-199>\s+IP extended access list/);
  assert.match(helpFor(w, s, 'access-list 110 '), /deny\s+Specify packets to reject\n\s+permit\s+Specify packets to forward\n\s+remark/);
  const protos = helpFor(w, s, 'access-list 110 permit ');
  for (const p of ['<0-255>', 'ahp', 'eigrp', 'esp', 'gre', 'icmp', 'ip ', 'ospf', 'tcp', 'udp']) assert.ok(protos.includes(p), p);
  assert.match(helpFor(w, s, 'access-list 110 permit tcp '), /A\.B\.C\.D\s+Source address\n\s+any\s+Any source host\n\s+host\s+A single source host/);
  const afterSrc = helpFor(w, s, 'access-list 110 permit tcp any ');
  for (const k of ['Destination address', 'Any destination host', 'eq ', 'range', 'neq']) assert.ok(afterSrc.includes(k), k);
  assert.match(helpFor(w, s, 'access-list 110 permit tcp any any eq '), /TCP port name.*www/);
  assert.match(helpFor(w, s, 'access-list 110 permit udp any any eq '), /UDP port name.*snmp/);
  assert.match(helpFor(w, s, 'access-list 110 permit tcp any any eq www '), /established[\s\S]*log[\s\S]*<cr>/);
  assert.match(helpFor(w, s, 'access-list 110 permit icmp any any '), /echo-reply\s+Echo reply/);
  assert.doesNotMatch(helpFor(w, s, 'access-list 110 permit ip any '), /\beq\b/, 'no port operators for ip');
  assert.match(helpFor(w, s, 'access-list 10 permit '), /A\.B\.C\.D[\s\S]*any[\s\S]*host/);
  assert.match(helpFor(w, s, 'access-list 10 permit 1.1.1.1 '), /Wildcard bits[\s\S]*log[\s\S]*<cr>/);
});

test('parseAce is usable on its own', () => {
  assert.deepEqual(parseAce('extended', 'permit tcp any any eq www'), { ace: { action: 'permit', protocol: 'tcp', src: any, dst: any, dstPort: { op: 'eq', ports: [80] } } });
  assert.deepEqual(parseAce('standard', 'deny 10.1.1.1'), { ace: { action: 'deny', protocol: 'ip', src: host('10.1.1.1'), dst: any } });
  assert.deepEqual(parseAce('extended', 'remark  allow web '), { ace: { action: 'remark', remark: 'allow web', protocol: 'ip', src: any, dst: any } });
  let r = parseAce('extended', 'permit ip any eq 80 any');
  assert.ok('error' in r && r.kind === 'invalid' && r.at === 'permit ip any '.length && r.error === "% Invalid input detected at '^' marker.");
  r = parseAce('extended', 'permit tcp any');
  assert.ok('error' in r && r.kind === 'incomplete' && r.error === '% Incomplete command.');
  r = parseAce('extended', 'permit tcp any any eq ssh');
  assert.ok('error' in r && r.kind === 'invalid' && /22/.test(r.hint ?? ''));
  r = parseAce('standard', 'permit 192.168.0.0 255.255.0.0');
  assert.ok('ace' in r && r.notes && r.notes.length === 2);
});
