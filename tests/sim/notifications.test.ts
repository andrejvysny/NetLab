import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reloadDevice, saveStartupConfig } from '../../src/engine/config/apply.ts';
import { emitSnmpTrap, emitSyslog, syslogProbe } from '../../src/engine/sim/index.ts';
import { getIos, getPc } from '../../src/engine/world.ts';
import { C, fixture } from '../content/coverage-fixture.ts';

const HOST = `snmp-server host ${C}`;
const TRAPS = 'snmp-server enable traps';

test('SNMP global and host suppression is trace-silent, including a saved exception under all', () => {
  const { w, x } = fixture('isr4331', 'routed');
  const trap = (type: string) => emitSnmpTrap(w, 'X', type, 'event');
  x(`${HOST} version 3 priv v3user config snmp`, `${HOST} informs version 2c inactive`, TRAPS);
  assert.deepEqual(trap('config'), []);
  assert.equal(getIos(w, 'X').runtime.notificationCounters, undefined);
  x(`${HOST} version 2c audit snmp`, `no ${TRAPS} snmp linkdown`);
  saveStartupConfig(w, 'X');
  reloadDevice(w, 'X');
  const dev = getIos(w, 'X');
  assert.deepEqual(dev.config.snmp.disableTraps, ['snmp linkdown']);
  assert.deepEqual(trap('config'), []);
  assert.deepEqual(trap('linkDown'), []);
  assert.deepEqual(trap('snmp authentication'), []);
  assert.equal(dev.runtime.notificationCounters, undefined);
  assert.equal(trap('linkUp')[0].forward.ok, true);
  x(`${TRAPS} snmp LINKD`);
  assert.equal(trap('linkDown')[0].forward.ok, true);
  assert.equal(dev.config.snmp.disableTraps, undefined);
  assert.deepEqual(getIos(w, 'X').runtime.notificationCounters?.snmp?.[C], { attempts: 2, collected: 2 });
});

test('attempted but denied notifications are not counted as collected; their ACL log is not recursively dispatched', () => {
  const { w, x, p, peerWan } = fixture('isr4331', 'routed');
  x(`${HOST} audit`, `${TRAPS} config`, `logging host ${C}`);
  p(`logging host ${C}`, `access-list 101 deny udp any host ${C} eq 162 log`, `access-list 101 deny udp any host ${C} eq 514 log`,
    'access-list 101 permit ip any any', `interface ${peerWan}`, 'ip access-group 101 in');
  const collector = getPc(w, 'C');
  const source = getIos(w, 'X');
  const transit = getIos(w, 'P');
  const result = emitSnmpTrap(w, 'X', 'config', 'denied');
  assert.equal(result.length, 1);
  assert.equal(result[0].forward.reason, 'acl-in');
  assert.deepEqual(source.runtime.notificationCounters?.snmp?.[C], { attempts: 1, collected: 0 });
  assert.deepEqual(collector.runtime.traps, []);
  assert.equal(transit.runtime.logBuffer.filter((l) => l.mnemonic.includes('IPACCESS')).length, 1, 'local logging still occurs');
  assert.equal(transit.runtime.notificationCounters?.syslog, undefined, 'no derived syslog datagram from a trap');
  emitSyslog(w, 'X', 5, 'AUDIT', 'denied');
  assert.deepEqual(source.runtime.notificationCounters?.syslog?.[C], { attempts: 1, collected: 0 });
  assert.deepEqual(collector.runtime.syslog, []);
  assert.equal(transit.runtime.logBuffer.filter((l) => l.mnemonic.includes('IPACCESS')).length, 2);
  assert.equal(transit.runtime.notificationCounters?.syslog, undefined, 'no derived syslog datagram from a syslog datagram');
  x('no logging on');
  assert.deepEqual(syslogProbe(w, 'X', 0), []);
  emitSyslog(w, 'X', 0, 'AUDIT', 'suppressed');
  assert.deepEqual(source.runtime.notificationCounters?.syslog?.[C], { attempts: 1, collected: 0 });
  assert.equal(source.runtime.logBuffer.some((l) => l.text === 'suppressed'), false);
});
