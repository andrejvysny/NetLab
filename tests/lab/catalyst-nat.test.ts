import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Lab } from '../../src/engine/lab.ts';
import type { SavedLab } from '../../src/engine/lab/persist.ts';
import type { FlowSpec, ScenarioDef } from '../../src/engine/types.ts';
import { getIos } from '../../src/engine/world.ts';
import { GI, cableId, consoleToConfig, miniScenario, ok, plugConsole, port, world } from './fixture.ts';

const LAN = 'GigabitEthernet1/0/1', WAN = 'GigabitEthernet1/0/2', UNUSED = 'GigabitEthernet1/0/3';
const A = '192.168.40.10', B = '192.168.40.11', C = '192.0.2.10';
const GW = '192.168.40.1', OUT = '198.51.100.1', PEER = '198.51.100.2', OUTGW = '192.0.2.1';
const G = '203.0.113.10', G2 = '203.0.113.11', MASK = '255.255.255.0';
const roles = `ip routing
interface ${LAN}
 no switchport
 ip address ${GW} ${MASK}
 ip nat inside
!
interface ${WAN}
 no switchport
 ip address ${OUT} ${MASK}
 ip nat outside
!
ip route 192.0.2.0 ${MASK} ${PEER}
`;
const selector = `ip access-list standard INSIDE
 permit 192.168.40.0 0.0.0.255
!`;
const pool = `ip nat pool PUBLIC ${G} ${G2} netmask ${MASK}`;
const stat = `ip nat inside source static ${A} ${G}`;
const scenarios: ScenarioDef[] = [{
  ...miniScenario(),
  build(seed) {
    const base = miniScenario().build(seed);
    return { ...base, bench: [
      { id: 'NAT', model: 'c9300l', label: 'Catalyst', x: 0, y: 0 },
      { id: 'L2', model: 'c9300l', label: 'LAN switch', x: 0, y: 0 },
      { id: 'ISP', model: 'isr4331', label: 'ISR peer', x: 0, y: 0 },
      ...['A', 'B', 'C'].map((id) => ({ id, model: 'pc-windows' as const, label: id, x: 0, y: 0 })),
    ] };
  },
}];

function bench() {
  const lab = new Lab({ scenarios, storage: null }); // Real IOS console and PC command runner.
  ok(lab.startScenario('mini', 'free'));
  const wire = (kind: 'straight' | 'crossover', a: string, p: string, b: string, q: string) =>
    ok(lab.connectCable(kind, port(a, p), port(b, q)));
  wire('crossover', 'NAT', LAN, 'L2', LAN);
  wire('straight', 'A', 'Ethernet0', 'L2', WAN);
  wire('straight', 'B', 'Ethernet0', 'L2', UNUSED);
  wire('straight', 'NAT', WAN, 'ISP', 'GigabitEthernet0/0/1');
  wire('crossover', 'C', 'Ethernet0', 'ISP', GI);
  for (const [id, address, gateway] of [['A', A, GW], ['B', B, GW], ['C', C, OUTGW]]) {
    ok(lab.setPcNic(id, { mode: 'static', address, mask: MASK, gateway }));
    lab.setPcService(id, 'http', true);
  }
  const apply = (dev: string, text: string, how: 'merge' | 'replace' = 'merge') => {
    const r = lab.applyConfigText(dev, text, how);
    assert.equal(r.ok, true, JSON.stringify(r));
  };
  plugConsole(lab, 'C', 'ISP');
  apply('ISP', `interface ${GI}
 ip address ${OUTGW} ${MASK}
 no shutdown
!
interface GigabitEthernet0/0/1
 ip address ${PEER} ${MASK}
 no shutdown
!
ip route 203.0.113.0 ${MASK} ${OUT}
`); // No return route to the private LAN: success must depend on NAT.
  const id = consoleToConfig(lab, 'A', 'NAT');
  const command = (s: string, status = 'ok') => {
    const r = lab.sessionExec(id, s);
    assert.equal(r.status, status, `${s}: ${r.output}`);
    return r.output;
  };
  command('end');
  const http = (from: string, to: string, vs = to === C ? 'C' : 'A') => {
    const output = lab.pcExec(from, `curl -I http://${to}`).output;
    assert.match(output, /HTTP\/1\.1 200 OK/);
    assert.ok(output.includes(`SimHTTP/1.0 (${vs})`), output);
  };
  const trace = (from: string, dst: string, extra: Partial<FlowSpec> = {}) => {
    const f = lab.trace({ fromDeviceId: from, dst, proto: 'tcp', sport: 49152, dport: 80, ...extra });
    if ('error' in f) throw new Error(f.error);
    return f;
  };
  return { lab, id, command, http, trace, apply, dev: () => getIos(world(lab), 'NAT') };
}

// These are separate lab instances, not chained packet fixtures or config-only assertions.
for (const mode of ['static', 'dynamic', 'pool PAT', 'interface PAT'] as const) {
  test(`real Lab: ${mode} forwards through the C9300L and reverses through the ISR peer`, () => {
    const { lab, apply, trace, http, command, dev } = bench();
    const rule = mode === 'static' ? stat : mode === 'interface PAT' ? `ip nat inside source list INSIDE interface ${WAN} overload` :
      `${pool}\nip nat inside source list INSIDE pool PUBLIC${mode === 'pool PAT' ? ' overload' : ''}`;
    apply('NAT', `${roles}${selector}\n${rule}`);
    assert.equal(dev().networkLicense, 'network-advantage');
    const version = command('show version');
    assert.match(version, /Version 17\.03\.04/);
    assert.match(version, /Classroom profile: Network Advantage/);
    assert.match(version, /Model Number\s+: C9300L-24T-4G/);
    assert.match(command('show license'), /network-advantage/);
    const expected = mode === 'interface PAT' ? OUT : G;
    const f = trace('A', C), reverse = f.reverse;
    assert.equal(f.ok, true, f.summary);
    assert.equal(f.forward.received?.src, expected);
    assert.equal(reverse?.received?.dst, A);
    assert.ok(f.forward.steps.some((s) => s.deviceId === 'NAT' && s.stage === 'nat-inside' && s.iface === WAN && s.verdict === 'changed'));
    assert.ok(reverse?.steps.some((s) => s.deviceId === 'NAT' && s.stage === 'nat-outside' && s.iface === WAN && s.verdict === 'changed'));
    assert.equal(dev().runtime.natTranslations.length, 0, 'Trace runs on a copy, not the live Lab state');
    http('A', C);
    if (mode === 'static') http('C', G); // Unsolicited connection to the static global.
    else http('B', C);
    const rows = dev().runtime.natTranslations;
    assert.equal(rows.length, 2);
    assert.equal(rows[0].insideGlobal, expected);
    assert.equal(rows[1].insideGlobal, mode === 'dynamic' ? G2 : expected);
    assert.match(command('show ip nat translations'), /tcp\s+\d+\.\d+\.\d+\.\d+:\d+\s+192\.168\.40\.10:\d+/);
    assert.match(command('show ip nat translations verbose'), /created at lab tick \d+/);
    assert.match(command('show ip nat statistics'), /Hits: 4  Misses: 0/);
    if (mode !== 'static') assert.match(command('show access-lists INSIDE'), /\(2 matches\)/);
    if (mode.endsWith('PAT')) {
      const a = trace('A', C, { sport: 40000 });
      const b = trace('B', C, { sport: rows[0].insideGlobalPort });
      assert.equal(a.forward.received?.src, expected);
      assert.equal(b.forward.received?.src, expected);
      assert.notEqual(b.forward.received?.sport, rows[0].insideGlobalPort, 'a real persisted A mapping occupies that port');
      assert.equal(b.reverse?.received?.dst, B);
      assert.equal(b.reverse?.received?.dport, rows[0].insideGlobalPort);
    }
    const config = lab.getConfigText('NAT', 'running');
    assert.match(config, /ip nat (inside|outside)/);
    assert.ok(!config.includes('license boot level'), 'no license command is needed');
    command('clear ip nat translation *');
    assert.deepEqual(dev().runtime.natTranslations, []);
    http('A', C);
    const reopened = new Lab({ scenarios, storage: null });
    ok(reopened.importLab(lab.exportLab()));
    assert.equal(getIos(world(reopened), 'NAT').networkLicense, 'network-advantage');
    apply('NAT', config, 'replace'); // Running-config round trip; can configure ACLs after NAT mappings.
    http('A', C);
  });
}

test('real Lab: L2 switching does not translate, SVI attachment is unresolved, and switching back removes a role', () => {
  const { lab, dev, command, apply, trace, http } = bench();
  apply('NAT', stat);
  command('configure terminal');
  command(`interface ${LAN}`);
  assert.match(command('ip nat inside', 'rejected'), /layer-2 switchport/);
  command(`interface ${WAN}`);
  assert.match(command('ip nat outside', 'rejected'), /layer-2 switchport/);
  command('interface Vlan1');
  assert.match(command('ip nat inside', 'rejected'), /SVI.*not modeled/);
  command('end');
  assert.equal(dev().config.interfaces[LAN].natRole, undefined);
  // Move B to the device under test: the flow actually crosses its L2 switching plane.
  const b = port('B', 'Ethernet0');
  ok(lab.removeCable(cableId(lab, b)));
  ok(lab.connectCable('straight', b, port('NAT', UNUSED)));
  http('A', B, 'B');
  const l2 = trace('A', B);
  assert.equal(l2.forward.received?.src, A);
  assert.ok(l2.forward.steps.some((s) => s.deviceId === 'NAT' && s.stage === 'switch'));
  assert.ok(!l2.forward.steps.some((s) => s.feature === 'nat'));
  assert.equal(trace('A', C).ok, false);
  assert.match(command('show ip nat statistics'), /Hits: 0  Misses: 0/);
  ok(lab.removeCable(cableId(lab, b)));
  ok(lab.connectCable('straight', b, port('L2', UNUSED)));
  apply('NAT', roles);
  http('A', C);
  apply('NAT', `interface ${LAN}\n switchport`);
  assert.equal(dev().config.interfaces[LAN].natRole, undefined);
  assert.equal(trace('A', C).ok, false);
  assert.match(command('show ip nat translations'), /Total number of translations: 1/, 'only the configured static mapping remains visible');
});

test('real Lab: permit-only extended ACL, pool exhaustion, and ACL replacement do not reuse invalid state', () => {
  const { lab, dev, command, apply, trace, http } = bench();
  apply('NAT', `${roles}ip nat pool PUBLIC ${G} ${G} prefix-length 24
ip access-list extended NAT-WEB
 permit tcp 192.168.40.0 0.0.0.255 host ${C} eq www
!
ip nat inside source list NAT-WEB pool PUBLIC`);
  http('A', C);
  const notSelected = trace('B', C, { proto: 'icmp' });
  assert.equal(notSelected.forward.received?.src, B, 'the ACL cannot translate non-TCP');
  const exhaust = trace('B', C);
  assert.match(exhaust.forward.reasonText ?? '', /no free address/);
  assert.match(command('show ip nat statistics'), /Hits: 2  Misses: 0/);
  // The real PC command consumes the failure; unlike Trace it also updates the allocation counter.
  assert.match(lab.pcExec('B', `curl -I http://${C}`).output, /curl: \(/);
  assert.match(command('show ip nat statistics'), /Hits: 2  Misses: 1/);
  apply('NAT', `ip access-list extended NAT-WEB\n deny ip any any`);
  assert.match(command('show ip nat statistics'), /inactive: ACL NAT-WEB has an explicit deny ACE/);
  assert.match(command('show ip nat translations'), /Total number of translations: 0/);
  assert.equal(trace('A', C).forward.received?.src, A);
  assert.equal(dev().runtime.natHits, 2);
});

test('real Lab: explicit overload, liveness, and persisted Catalyst entitlement are enforced', () => {
  const { lab, dev, command, apply, trace, http } = bench();
  apply('NAT', `${roles}${selector}`);
  command('configure terminal');
  assert.match(command(`ip nat inside source list INSIDE interface ${WAN}`, 'rejected'), /explicit overload/);
  assert.match(command(`ip nat inside source list INSIDE interface ${UNUSED} overload`, 'rejected'), /layer-2 switchport/);
  command('end');
  apply('NAT', `interface ${UNUSED}\n no switchport\n ip address 203.0.113.80 ${MASK}\n!\nip nat inside source list INSIDE interface ${UNUSED} overload`);
  assert.match(command('show ip nat statistics'), /needs a valid IPv4 address and must be up\/up/);
  assert.equal(trace('A', C).forward.received?.src, A);
  apply('NAT', `ip nat inside source list INSIDE interface ${WAN} overload`);
  http('A', C);

  const data = JSON.parse(lab.exportLab()) as SavedLab;
  const old = new Lab({ scenarios, storage: null });
  delete getIos(data.world, 'NAT').networkLicense;
  ok(old.importLab(JSON.stringify(data)));
  assert.equal(getIos(world(old), 'NAT').networkLicense, 'network-advantage');
  getIos(data.world, 'NAT').networkLicense = 'network-essentials';
  const restricted = new Lab({ scenarios, storage: null });
  ok(restricted.importLab(JSON.stringify(data)));
  const sid = consoleToConfig(restricted, 'A', 'NAT');
  const deny = (line: string) => {
    const o = restricted.sessionExec(sid, line);
    assert.equal(o.status, 'rejected');
    assert.match(o.output, /requires the Network Advantage/);
  };
  deny(stat);
  // Existing saved boot syntax remains inert; it cannot change the classroom entitlement.
  restricted.sessionExec(sid, 'license boot level network-advantage');
  deny(stat);
  restricted.sessionExec(sid, 'end');
  assert.match(restricted.sessionExec(sid, 'show version').output, /Classroom profile: Network Essentials/);
  deny('show ip nat statistics');
  const f = restricted.trace({ fromDeviceId: 'A', dst: C, proto: 'tcp', dport: 80 });
  assert.ok(!('error' in f) && !f.ok && f.forward.received?.src === A);
  assert.equal(dev().runtime.natHits, 2);
});

test('real Lab: a pool on the outside LAN returns ICMP and UDP through the NAT address alias', () => {
  const { lab, dev, apply, command } = bench();
  const address = '198.51.100.10'; // The ISR must resolve the pool address on-link, not use a route to OUT.
  apply('NAT', `${roles}${selector}\nip nat pool ONLINK ${address} ${address} netmask ${MASK}\nip nat inside source list INSIDE pool ONLINK overload`);
  apply('ISP', 'snmp-server community lan ro');
  assert.match(lab.pcExec('A', `ping -n 1 ${C}`).output, /Reply from 192\.0\.2\.10/);
  const snmp = lab.pcSnmp('A', { host: PEER, community: 'lan', oid: 'sysName.0', op: 'get' });
  assert.equal(snmp.ok, true, snmp.text);
  assert.deepEqual(dev().runtime.natTranslations.map((r) => [r.proto, r.insideLocal, r.insideGlobal]), [['icmp', A, address], ['udp', A, address]]);
  assert.match(command('show ip nat statistics'), /Hits: 4  Misses: 0/);
});
