/**
 * The ACL, NAT, SNMP and logging lines of both reference configurations in docs/COURSE.md, typed exactly as written
 * (read from the document) and in common abbreviated forms, must give the expected structured configuration.
 * Only the acl/nat/snmp/logging modules are installed; `interface X` is simulated by setting the config-if context.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createWorld, addDevice, getIos } from '../../src/engine/world.ts';
import { startSession, execLine, inspectLine } from '../../src/engine/cli/framework.ts';
import type { CliSession } from '../../src/engine/cli/framework.ts';
import type { Ace, AddrMatch, World } from '../../src/engine/types.ts';
import * as acl from '../../src/engine/cli/commands/acl.ts';
import * as nat from '../../src/engine/cli/commands/nat.ts';
import * as snmp from '../../src/engine/cli/commands/snmp.ts';
import * as logging from '../../src/engine/cli/commands/logging.ts';
acl.install(); nat.install(); snmp.install(); logging.install();

const course = readFileSync(new URL('../../docs/COURSE.md', import.meta.url), 'utf8');
function listing(title: string): string[] {
  const at = course.indexOf(title);
  assert.ok(at >= 0, `COURSE.md has "${title}"`);
  const start = course.indexOf('```', at) + 3;
  const end = course.indexOf('```', start);
  return course.slice(start, end).split('\n').filter((l) => l.trim() !== '');
}
const R1 = listing('## Reference configuration — R1');
const R2raw = listing('## Reference configuration — R2');
/** R2's listing says "(class-maps, policy-maps, ACL 120, matchGuaranteed, matchPriority: identical to R1)". */
function sharedAclBlocks(): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const l of R1) {
    if (/^access-list 120 /.test(l)) { out.push(l); inBlock = false; continue; }
    if (/^ip access-list extended (matchGuaranteed|matchPriority)$/.test(l)) { out.push(l); inBlock = true; continue; }
    if (inBlock && /^ /.test(l)) { out.push(l); continue; }
    inBlock = false;
  }
  return out;
}
const R2 = R2raw.flatMap((l) => (/^\(class-maps/.test(l) ? sharedAclBlocks() : [l]));

const MINE_GLOBAL = /^(access-list|ip access-list|ip nat|snmp-server|logging)\b/;
const MINE_IF = /^ (ip access-group|ip nat (inside|outside)$)/;

function makeRouter(): { w: World; s: CliSession } {
  const w = createWorld();
  addDevice(w, { id: 'r1', model: 'isr4331', label: 'R1', x: 0, y: 0 });
  const { session } = startSession(w, 'r1', 'console');
  session.mode = 'config';
  return { w, s: session };
}
/** Feed a listing: our lines are executed, other modules' lines only move the mode the way IOS would. */
function feed(w: World, s: CliSession, lines: string[]): { line: string; status: string; feature: string; mutated: boolean }[] {
  const dev = getIos(w, 'r1');
  const ran: { line: string; status: string; feature: string; mutated: boolean }[] = [];
  let block: 'mine' | 'if' | 'other' = 'other';
  for (const line of lines) {
    if (!/^ /.test(line)) {
      const ifm = /^interface (\S+)$/.exec(line);
      if (ifm) {
        dev.config.interfaces[ifm[1]] ??= { name: ifm[1], shutdown: false };
        s.mode = 'config-if'; s.ctx = { ifNames: [ifm[1]] }; block = 'if';
        continue;
      }
      if (MINE_GLOBAL.test(line)) {
        const o = execLine(w, s, line);
        ran.push({ line, status: o.status, feature: o.feature, mutated: o.mutated });
        block = 'mine';
        continue;
      }
      s.mode = 'config'; s.ctx = {}; block = 'other';
      continue;
    }
    if ((block === 'mine' && /^ (permit|deny|remark|\d+ )/.test(line)) || (block === 'if' && MINE_IF.test(line))) {
      const o = execLine(w, s, line);
      ran.push({ line, status: o.status, feature: o.feature, mutated: o.mutated });
    }
  }
  return ran;
}

const any: AddrMatch = { kind: 'any' };
const host = (address: string): AddrMatch => ({ kind: 'host', address });
const net = (address: string, wildcard: string): AddrMatch => ({ kind: 'net', address, wildcard });
const eq = (p: number) => ({ op: 'eq' as const, ports: [p] });
const std = (seq: number, src: AddrMatch): Ace => ({ seq, action: 'permit', protocol: 'ip', src, dst: any });
const tcpUdp = (proto: 'tcp' | 'udp', port: number, side: 'dst' | 'src', seq: number): Ace => (side === 'dst'
  ? { seq, action: 'permit', protocol: proto, src: any, dst: any, dstPort: eq(port) }
  : { seq, action: 'permit', protocol: proto, src: any, srcPort: eq(port), dst: any });
const guaranteed = (start: number): Ace[] => {
  const out: Ace[] = []; let seq = start;
  for (const [proto, port] of [['tcp', 23], ['tcp', 22], ['udp', 161], ['udp', 162]] as const) {
    out.push(tcpUdp(proto, port, 'dst', seq)); seq += 10;
    out.push(tcpUdp(proto, port, 'src', seq)); seq += 10;
  }
  return out;
};
const ACL120: Ace[] = (() => {
  const g = guaranteed(10);
  // 120 = guaranteed entries with "permit icmp any any" after the four TCP entries
  const icmp: Ace = { seq: 50, action: 'permit', protocol: 'icmp', src: any, dst: any };
  return [...g.slice(0, 4), icmp, ...g.slice(4).map((e) => ({ ...e, seq: e.seq + 10 }))];
})();
const SHARED = {
  '120': { id: '120', type: 'extended', named: false, entries: ACL120 },
  matchGuaranteed: { id: 'matchGuaranteed', type: 'extended', named: true, entries: guaranteed(10) },
  matchPriority: { id: 'matchPriority', type: 'extended', named: true, entries: [{ seq: 10, action: 'permit', protocol: 'icmp', src: any, dst: any }] },
};
const R1_ACLS = {
  '1': { id: '1', type: 'standard', named: false, entries: [std(10, net('192.168.100.0', '0.0.0.255'))] },
  '10': { id: '10', type: 'standard', named: false, entries: [std(10, host('192.168.100.10')), std(20, host('60.50.40.2'))] },
  '11': { id: '11', type: 'standard', named: false, entries: [std(10, host('192.168.100.10'))] },
  '110': {
    id: '110', type: 'extended', named: false, entries: [
      { seq: 10, action: 'deny', protocol: 'ip', src: host('192.168.100.10'), dst: host('2.2.2.2') },
      { seq: 20, action: 'permit', protocol: 'icmp', src: host('192.168.100.101'), dst: net('60.50.40.0', '0.0.0.63') },
      { seq: 30, action: 'permit', protocol: 'tcp', src: host('192.168.100.101'), dst: net('60.50.40.0', '0.0.0.63'), dstPort: eq(80) },
      { seq: 40, action: 'deny', protocol: 'ip', src: host('192.168.100.101'), dst: net('60.50.40.0', '0.0.0.63') },
      { seq: 50, action: 'permit', protocol: 'ip', src: any, dst: any },
    ],
  },
  ...SHARED,
  allowPC1: { id: 'allowPC1', type: 'standard', named: true, entries: [std(10, host('192.168.100.10'))] },
};
const R2_ACLS = {
  '10': { id: '10', type: 'standard', named: false, entries: [std(10, host('60.50.50.100')), std(20, host('60.50.40.2'))] },
  '11': { id: '11', type: 'standard', named: false, entries: [std(10, host('60.50.50.100'))] },
  ...SHARED,
  allowPC1: { id: 'allowPC1', type: 'standard', named: true, entries: [std(10, host('60.50.50.100'))] },
};
const SNMP = {
  communities: [{ name: 'D105read', access: 'ro', acl: '10' }, { name: 'D105write', access: 'rw', acl: '11' }],
  hosts: [], enableTraps: [], views: [],
};

function checkR1(w: World): void {
  const c = getIos(w, 'r1').config;
  assert.deepEqual(c.acls, R1_ACLS);
  assert.deepEqual(c.nat, {
    pools: [], insideDestinationRules: [],
    staticRules: [{ local: '192.168.100.10', global: '60.50.50.100' }],
    dynamicRules: [{ acl: '1', interface: 'Serial0/1/0', overload: true }],
  });
  assert.deepEqual(c.snmp, SNMP);
  assert.deepEqual(c.logging, { hosts: ['192.168.100.10'], sourceInterface: 'Loopback0' });
  assert.equal(c.interfaces['GigabitEthernet0/0/0'].aclIn, '110');
  assert.equal(c.interfaces['GigabitEthernet0/0/0'].natRole, 'inside');
  assert.equal(c.interfaces['Serial0/1/0'].natRole, 'outside');
  assert.equal(c.interfaces['Serial0/1/0'].aclIn, undefined);
}

test('COURSE.md listings were found and contain the expected lines', () => {
  assert.ok(R1.includes('access-list 110 permit tcp host 192.168.100.101 60.50.40.0 0.0.0.63 eq www'));
  assert.ok(R1.includes('ip nat inside source list 1 interface Serial0/1/0 overload'));
  assert.ok(R2.includes('access-list 120 permit udp any eq snmptrap any'), 'R2 gets the shared ACL blocks from R1');
  assert.ok(R2.includes(' permit icmp any any'));
});

test('R1 reference configuration typed exactly as written', () => {
  const { w, s } = makeRouter();
  const ran = feed(w, s, R1);
  for (const r of ran) assert.equal(r.status, 'ok', `"${r.line}" → ${r.status}`);
  assert.equal(ran.length, 40, 'every acl/nat/snmp/logging line of R1 ran (31 ACL, 2 NAT, 4 SNMP/logging, 3 interface)');
  // features and mutation flags
  for (const r of ran) {
    const want = /^(access-list|ip access-list| (permit|deny)| ip access-group)/.test(r.line) ? 'acl'
      : /nat/.test(r.line) ? 'nat' : /^snmp/.test(r.line) ? 'snmp' : 'syslog';
    assert.equal(r.feature, want, r.line);
    assert.equal(r.mutated, !/^ip access-list /.test(r.line), `mutates: ${r.line}`);
  }
  checkR1(w);
});

test('R2 reference configuration typed exactly as written', () => {
  const { w, s } = makeRouter();
  const ran = feed(w, s, R2);
  for (const r of ran) assert.equal(r.status, 'ok', `"${r.line}" → ${r.status}`);
  const c = getIos(w, 'r1').config;
  assert.deepEqual(c.acls, R2_ACLS);
  assert.deepEqual(c.nat, { pools: [], staticRules: [], dynamicRules: [], insideDestinationRules: [] });
  assert.deepEqual(c.snmp, SNMP);
  assert.deepEqual(c.logging, { hosts: ['60.50.50.100'], sourceInterface: 'Loopback0' });
  assert.equal(c.interfaces['GigabitEthernet0/0/0'].aclIn, undefined);
  assert.equal(c.interfaces['Serial0/1/0'].natRole, undefined);
});

test('R1 typed with common abbreviations gives the same configuration', () => {
  const { w, s } = makeRouter();
  const dev = getIos(w, 'r1');
  for (const n of ['Loopback0', 'Loopback100']) dev.config.interfaces[n] = { name: n, shutdown: false };
  const run = (line: string) => { const o = execLine(w, s, line); assert.equal(o.status, 'ok', `"${line}" → ${o.status}\n${o.output}`); return o; };
  s.mode = 'config-if'; s.ctx = { ifNames: ['GigabitEthernet0/0/0'] };
  run('ip access-g 110 in');
  run('ip nat ins');
  s.mode = 'config-if'; s.ctx = { ifNames: ['Serial0/1/0'] };
  run('ip nat out');
  s.mode = 'config'; s.ctx = {};
  run('ip nat in so st 192.168.100.10 60.50.50.100');
  run('ip nat in so li 1 int s0/1/0 over');
  run('access-l 1 per 192.168.100.0 0.0.0.255');
  run('access-l 10 per ho 192.168.100.10');
  run('acc 10 permit host 60.50.40.2');
  run('access-list 11 permit 192.168.100.10');
  run('access-list 110 de ip ho 192.168.100.10 ho 2.2.2.2');
  run('access-list 110 per icmp ho 192.168.100.101 60.50.40.0 0.0.0.63');
  run('access-l 110 permit tcp host 192.168.100.101 60.50.40.0 0.0.0.63 eq 80');
  run('access-list 110 deny ip host 192.168.100.101 60.50.40.0 0.0.0.63');
  run('access-list 110 permit ip any any');
  run('access-list 120 per tcp an an eq 23');
  run('access-list 120 per tcp any eq tel any');
  run('access-list 120 per tcp any any eq 22');
  run('access-list 120 per tcp any eq 22 any');
  run('access-list 120 per icmp any any');
  run('access-list 120 per udp any any eq 161');
  run('access-list 120 per udp any eq snmp any');
  run('access-list 120 per udp any any eq 162');
  run('access-list 120 per udp any eq snmpt any');
  run('ip access-list ext matchGuaranteed');
  assert.equal(s.mode, 'config-ext-nacl');
  for (const l of ['per tcp any any eq 23', 'per tcp any eq telnet any', 'per tcp any any eq 22', 'per tcp any eq 22 any',
    'per udp any any eq snmp', 'per udp any eq 161 any', 'per udp any any eq snmptrap', 'per udp any eq 162 any']) run(l);
  run('ip access-list extended matchPriority');
  run('permit icmp any any');
  run('ip access-list st allowPC1');
  assert.equal(s.mode, 'config-std-nacl');
  run('per 192.168.100.10');
  run('snmp-s comm D105read ro 10');
  assert.equal(s.mode, 'config', 'a global command typed in a named-ACL mode leaves that mode');
  run('snmp-server com D105write RW 11');
  run('logg source-interface lo0');
  run('logg so Loopback0');
  run('logg 192.168.100.10');
  checkR1(w);
});

test('R2 typed with common abbreviations gives the same configuration', () => {
  const exact = makeRouter();
  feed(exact.w, exact.s, R2);
  const { w, s } = makeRouter();
  getIos(w, 'r1').config.interfaces['Loopback0'] = { name: 'Loopback0', shutdown: false };
  const run = (line: string) => { const o = execLine(w, s, line); assert.equal(o.status, 'ok', `"${line}" → ${o.status}\n${o.output}`); };
  for (const l of R2) if (/^(access-list 120 |ip access-list extended match| permit (tcp|udp|icmp) any)/.test(l)) run(l);
  s.mode = 'config'; s.ctx = {};
  run('access-li 10 p h 60.50.50.100');
  run('access-li 10 p 60.50.40.2 0.0.0.0');
  run('access-list 11 permit 60.50.50.100');
  run('ip access-l st allowPC1');
  run('pe 60.50.50.100');
  run('snmp-s community D105read RO 10');
  run('snmp-s community D105write RW 11');
  run('logg source-i Loopback 0');
  run('logg 60.50.50.100');
  const a = getIos(exact.w, 'r1').config; const b = getIos(w, 'r1').config;
  assert.deepEqual(b.acls, a.acls);
  assert.deepEqual(b.snmp, a.snmp);
  assert.deepEqual(b.logging, a.logging);
  assert.deepEqual(b.acls, R2_ACLS);
});

test('named-ACL navigation does not count as a configuration change', () => {
  const { w, s } = makeRouter();
  assert.deepEqual(inspectLine(w, s, 'ip access-list extended matchGuaranteed'), { status: 'ok', feature: 'acl', mutates: false });
  assert.deepEqual(inspectLine(w, s, 'ip access-list standard allowPC1'), { status: 'ok', feature: 'acl', mutates: false });
  assert.deepEqual(inspectLine(w, s, 'access-list 110 permit ip any any'), { status: 'ok', feature: 'acl', mutates: true });
  assert.deepEqual(inspectLine(w, s, 'ip nat inside source list 1 interface Serial0/1/0 overload'), { status: 'ok', feature: 'nat', mutates: true });
  assert.deepEqual(inspectLine(w, s, 'snmp-server community D105read RO 10'), { status: 'ok', feature: 'snmp', mutates: true });
  assert.deepEqual(inspectLine(w, s, 'logging source-interface Loopback0'), { status: 'ok', feature: 'syslog', mutates: true });
  s.mode = 'config-if'; s.ctx = { ifNames: ['GigabitEthernet0/0/0'] };
  assert.deepEqual(inspectLine(w, s, 'ip access-group 110 in'), { status: 'ok', feature: 'acl', mutates: true });
  assert.deepEqual(inspectLine(w, s, 'ip nat inside'), { status: 'ok', feature: 'nat', mutates: true });
  s.mode = 'priv'; s.ctx = {};
  assert.deepEqual(inspectLine(w, s, 'clear access-list counters'), { status: 'ok', feature: 'acl', mutates: false });
  assert.deepEqual(inspectLine(w, s, 'clear ip nat translation *'), { status: 'ok', feature: 'nat', mutates: false });
});
