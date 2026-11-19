import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getIos, getPc } from '../../src/engine/world.ts';
import { cableId, makeLab, ok, openConsole, plugConsole, port, SE, world } from './fixture.ts';

const collector = '10.0.1.10';
function bench() {
  const { lab } = makeLab();
  ok(lab.startScenario('mini-prebuilt', 'free'));
  plugConsole(lab, 'PC1', 'R1');
  const id = openConsole(lab, 'R1');
  const cli = (line: string) => {
    const out = lab.sessionExec(id, line);
    assert.equal(out.status, 'ok', `${line}: ${out.output}`);
    return out.output;
  };
  cli('enable');
  const config = (...lines: string[]) => { cli('configure terminal'); lines.forEach(cli); cli('end'); };
  const pc = () => getPc(world(lab), 'PC1');
  return { lab, id, cli, config, pc };
}

test('actual CLI edits and serial/cable link edges each dispatch once, independent of syslog suppression', () => {
  const { lab, id, cli, config, pc } = bench();
  config('no logging on', `snmp-server host ${collector} version 2c notify`, 'snmp-server enable traps config',
    'snmp-server enable traps snmp linkdown linkup');
  assert.deepEqual(pc().runtime.traps.map((t) => t.community), ['notify']);
  assert.deepEqual(pc().runtime.syslog, []);
  assert.match(cli('show logging'), /Syslog logging: disabled \(no logging on\)/);
  config('snmp-server enable traps config'); // no-op command and exit: no config trap
  cli('configure terminal');
  assert.equal(lab.sessionExec(id, 'not-a-command').status, 'invalid');
  cli('end');
  assert.equal(pc().runtime.traps.length, 1);

  const edge = cableId(lab, port('R1', SE));
  ok(lab.removeCable(edge));
  ok(lab.connectCable('serial', port('R1', SE), port('R2', SE), { dceEnd: 'a' }));
  assert.deepEqual(pc().runtime.traps.slice(1).map((t) => t.text), [
    `Line protocol on Interface ${SE}, changed state to down`, `Line protocol on Interface ${SE}, changed state to up`,
  ]);
  assert.match(cli('show snmp'), /enabled, 3 modeled attempts, 3 collected/);
  config('no snmp-server enable traps');
  ok(lab.removeCable(cableId(lab, port('R1', SE))));
  assert.equal(pc().runtime.traps.length, 3);
  assert.match(cli('show snmp'), /disabled, 3 modeled attempts, 3 collected/);
});

test('file edits and successful SNMP SET produce config traps; no-ops, GET and atomic failure do not', () => {
  const { lab, config, pc } = bench();
  config(`snmp-server host ${collector} audit config`, 'snmp-server enable traps config', 'snmp-server community writer rw');
  lab.clearPcLog('PC1', 'traps');
  const merge = () => lab.applyConfigText('R1', 'snmp-server location Room 1', 'merge');
  assert.equal(merge().ok, true);
  assert.equal(merge().ok, true);
  assert.equal(lab.applyConfigText('R1', 'hostname Broken\nnot-a-command', 'replace').ok, false);
  assert.equal(pc().runtime.traps.length, 1);
  const host = getIos(world(lab), 'R1').config.interfaces['GigabitEthernet0/0/0'].ip!.address;
  const query = { host, community: 'writer', oid: 'sysLocation.0' };
  assert.equal(lab.pcSnmp('PC1', { ...query, op: 'get' }).ok, true);
  assert.equal(lab.pcSnmp('PC1', { ...query, op: 'set', value: 'Room 1' }).ok, true);
  assert.equal(pc().runtime.traps.length, 1);
  assert.equal(lab.pcSnmp('PC1', { ...query, op: 'set', value: 'Room 2' }).ok, true);
  assert.deepEqual(pc().runtime.traps.map((t) => t.text), ['Configured from console by console', 'Configured by SNMP SET']);
});

test('console copy and reload preserve valid host syntax, selectors and dispatch behavior', () => {
  const { lab, id, cli, config, pc } = bench();
  config(`snmp-server host ${collector} version 2c modeled snmp`, `snmp-server host ${collector} informs version 3 priv saveduser config`,
    'snmp-server host 10.0.2.2 version 3 otheruser snmp', 'snmp-server enable traps', 'no snmp-server enable traps snmp linkdown');
  const before = structuredClone(getIos(world(lab), 'R1').config.snmp);
  assert.match(lab.sessionExec(id, 'copy running-config startup-config').prompt, /Destination filename/);
  assert.match(lab.sessionExec(id, '').output, /bytes copied|\[OK\]/);
  assert.match(lab.sessionExec(id, 'reload').prompt, /Proceed with reload/);
  assert.match(lab.sessionExec(id, '').output, /SYS-5-RELOAD/);
  assert.deepEqual(getIos(world(lab), 'R1').config.snmp, before);
  assert.deepEqual(pc().runtime.traps, []); // no boot traps or config trap to the link-only v2c host
  cli('enable');
  assert.match(cli('show snmp host'), /v3 priv\nNotification types: config[\s\S]*v3 noauth\nNotification types: snmp/);
  ok(lab.removeCable(cableId(lab, port('R1', SE))));
  assert.deepEqual(pc().runtime.traps, []);
  ok(lab.connectCable('serial', port('R1', SE), port('R2', SE), { dceEnd: 'a' }));
  assert.deepEqual(pc().runtime.traps.map((t) => t.community), ['modeled']);
});
