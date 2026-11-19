/** Physical layer and interface state (ARCHITECTURE §5). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GI, SE, buildBench, cable, r1, r2, referenceLab, unplug } from './fixtures.ts';
import { canPlug, checkCable, consolePeer, interfaceState, linkInfo, portLed, requiredEthernetCable, serialClock } from '../../src/engine/sim/index.ts';
import { getIos } from '../../src/engine/world.ts';

const ref = (deviceId: string, port: string) => ({ deviceId, port });
const state = (w: Parameters<typeof interfaceState>[0], d: string, i: string) => {
  const s = interfaceState(w, d, i);
  return `${s.status}/${s.protocol}`;
};

test('factory state: router ports are shut down, switch ports are down until cabled, Vlan1 is shut down', () => {
  const w = buildBench();
  assert.equal(state(w, 'R1', GI), 'administratively down/down');
  assert.equal(state(w, 'R1', SE), 'administratively down/down');
  assert.equal(state(w, 'SW1', 'GigabitEthernet1/0/1'), 'down/down');
  assert.match(interfaceState(w, 'SW1', 'GigabitEthernet1/0/1').problem ?? '', /No cable is plugged into SW1 GigabitEthernet1\/0\/1/);
  assert.equal(state(w, 'SW1', 'Vlan1'), 'administratively down/down');
  assert.equal(state(w, 'PC1', 'Ethernet0'), 'down/down');
  assert.equal(linkInfo(w, ref('R1', GI)).cabled, false);
  assert.equal(linkInfo(w, ref('R1', GI)).usable, false);
  assert.equal(portLed(w, ref('R1', GI)), 'off');
  // unknown interfaces do not throw
  assert.equal(state(w, 'R1', 'GigabitEthernet9/9/9'), 'down/down');
  assert.equal(state(w, 'R1', 'Console'), 'down/down');
  assert.equal(state(w, 'nobody', GI), 'down/down');
});

test('strict Ethernet rules: unlike ends need straight-through, like ends need crossover', () => {
  const w = buildBench();
  const d = (id: string) => w.devices[id];
  assert.equal(requiredEthernetCable(d('PC1'), d('SW1')), 'straight');
  assert.equal(requiredEthernetCable(d('R1'), d('SW1')), 'straight');
  assert.equal(requiredEthernetCable(d('R1'), d('R2')), 'crossover');
  assert.equal(requiredEthernetCable(d('PC1'), d('R1')), 'crossover');
  assert.equal(requiredEthernetCable(d('PC1'), d('PC2')), 'crossover');
  assert.equal(requiredEthernetCable(d('SW1'), d('SW2')), 'crossover');

  const cases: [string, string, string, string, 'straight' | 'crossover', string | null][] = [
    ['PC1', 'Ethernet0', 'SW1', 'GigabitEthernet1/0/1', 'straight', null],
    ['PC1', 'Ethernet0', 'SW1', 'GigabitEthernet1/0/1', 'crossover', 'Crossover cable between a PC and a switch: this pair needs a straight-through cable.'],
    ['SW1', 'GigabitEthernet1/0/24', 'R1', GI, 'crossover', 'Crossover cable between a router and a switch: this pair needs a straight-through cable.'],
    ['R1', 'GigabitEthernet0/0/1', 'R2', 'GigabitEthernet0/0/1', 'crossover', null],
    ['R1', 'GigabitEthernet0/0/1', 'R2', 'GigabitEthernet0/0/1', 'straight', 'Straight-through cable between two routers: this pair needs a crossover cable.'],
    ['R2', GI, 'PC3', 'Ethernet0', 'straight', 'Straight-through cable between a PC and a router: this pair needs a crossover cable.'],
    ['PC1', 'Ethernet0', 'PC2', 'Ethernet0', 'straight', 'Straight-through cable between two PCs: this pair needs a crossover cable.'],
    ['SW1', 'GigabitEthernet1/0/5', 'SW2', 'GigabitEthernet1/0/5', 'straight', 'Straight-through cable between two switches: this pair needs a crossover cable.'],
    ['SW1', 'GigabitEthernet1/0/5', 'SW2', 'GigabitEthernet1/0/5', 'crossover', null],
  ];
  for (const [a, pa, b, pb, kind, problem] of cases) {
    const r = checkCable(w, kind, ref(a, pa), ref(b, pb));
    assert.equal(r.fits, true);
    assert.equal(r.usable, problem === null, `${kind} ${a}–${b}`);
    assert.equal(r.problem ?? null, problem);
    // with auto-MDIX either type works
    const auto = buildBench({ strictCables: false });
    assert.equal(checkCable(auto, kind, ref(a, pa), ref(b, pb)).usable, true);
  }
});

test('plugs and sockets: serial only fits serial; RJ-45 fits Ethernet and Console but gives no link in the wrong socket', () => {
  const w = buildBench();
  // serial
  assert.deepEqual(checkCable(w, 'serial', ref('R1', SE), ref('R2', SE)), { fits: true, usable: true });
  assert.equal(checkCable(w, 'serial', ref('R1', SE), ref('R2', GI)).fits, false);
  assert.equal(checkCable(w, 'straight', ref('R1', SE), ref('R2', SE)).fits, false);
  assert.equal(checkCable(w, 'console', ref('PC1', 'COM1'), ref('R1', SE)).fits, false);
  // Ethernet cable in a console port: fits, no link
  const eth = checkCable(w, 'straight', ref('SW1', 'GigabitEthernet1/0/3'), ref('R1', 'Console'));
  assert.deepEqual([eth.fits, eth.usable], [true, false]);
  assert.match(eth.problem ?? '', /Ethernet cable is plugged into the console port of R1/);
  // console cable in an Ethernet port: fits, no console
  const con = checkCable(w, 'console', ref('PC1', 'COM1'), ref('R1', GI));
  assert.deepEqual([con.fits, con.usable], [true, false]);
  assert.match(con.problem ?? '', /console cable is plugged into R1 GigabitEthernet0\/0\/0, which is an Ethernet port/);
  // console cable the right way
  assert.deepEqual(checkCable(w, 'console', ref('PC1', 'COM1'), ref('R1', 'Console')), { fits: true, usable: true });
  assert.deepEqual(checkCable(w, 'console', ref('SW1', 'Console'), ref('PC2', 'COM1')), { fits: true, usable: true });
  // nonsense
  assert.equal(checkCable(w, 'console', ref('R1', 'Console'), ref('R2', 'Console')).fits, false);
  assert.equal(checkCable(w, 'straight', ref('PC1', 'COM1'), ref('SW1', 'GigabitEthernet1/0/1')).fits, false);
  assert.equal(checkCable(w, 'straight', ref('R1', GI), ref('R1', 'GigabitEthernet0/0/1')).usable, false);
  assert.equal(checkCable(w, 'straight', ref('R1', 'nope'), ref('R2', GI)).fits, false);

  // a wrongly plugged cable keeps the interface down and names the reason
  cable(w, 'console', ['PC1', 'COM1'], ['R1', GI]);
  r1(w).config.interfaces[GI].shutdown = false;
  assert.equal(state(w, 'R1', GI), 'down/down');
  assert.match(interfaceState(w, 'R1', GI).problem ?? '', /Plug it into the port marked CON/);
  assert.equal(portLed(w, ref('R1', GI)), 'amber');
  assert.equal(consolePeer(w, 'PC1'), null);
});

test('console access needs a console cable between a COM port and a CON port', () => {
  const w = buildBench();
  assert.equal(consolePeer(w, 'R1'), null);
  assert.equal(consolePeer(w, 'PC1'), null);
  cable(w, 'console', ['PC1', 'COM1'], ['R1', 'Console']);
  assert.equal(consolePeer(w, 'R1'), 'PC1');
  assert.equal(consolePeer(w, 'PC1'), 'R1');
  assert.equal(portLed(w, ref('R1', 'Console')), 'green');
  assert.equal(linkInfo(w, ref('R1', 'Console')).usable, true);
  // moved to the switch
  unplug(w, 'R1', 'Console');
  cable(w, 'console', ['SW1', 'Console'], ['PC1', 'COM1']);
  assert.equal(consolePeer(w, 'R1'), null);
  assert.equal(consolePeer(w, 'PC1'), 'SW1');
  // an Ethernet cable in the CON port is no console
  cable(w, 'straight', ['PC2', 'Ethernet0'], ['R2', 'Console']);
  assert.equal(consolePeer(w, 'R2'), null);
  assert.equal(state(w, 'PC2', 'Ethernet0'), 'down/down');
});

test('serial link: DCE end, clocking, shutdown on either end, encapsulation', () => {
  const w = buildBench();
  cable(w, 'serial', ['R1', SE], ['R2', SE], 'a');
  assert.equal(linkInfo(w, ref('R1', SE)).dce, true);
  assert.equal(linkInfo(w, ref('R2', SE)).dce, false);
  assert.deepEqual(linkInfo(w, ref('R1', SE)).peer, ref('R2', SE));
  // both shut down
  assert.equal(serialClock(w, 'R2', SE)?.active, false);
  assert.equal(state(w, 'R1', SE), 'administratively down/down');
  r1(w).config.interfaces[SE].shutdown = false;
  assert.equal(state(w, 'R1', SE), 'down/down');
  assert.match(interfaceState(w, 'R1', SE).problem ?? '', /other end of the cable \(R2 Serial0\/1\/0\) is shut down/);
  assert.equal(state(w, 'R2', SE), 'administratively down/down');
  r2(w).config.interfaces[SE].shutdown = false;
  // no clock rate configured: the link still comes up with the simulator's nominal fallback
  assert.equal(state(w, 'R1', SE), 'up/up');
  assert.equal(state(w, 'R2', SE), 'up/up');
  assert.deepEqual(serialClock(w, 'R2', SE), { dceDeviceId: 'R1', dceIf: SE, configured: undefined, effective: 2000000, active: true });
  r1(w).config.interfaces[SE].clockRate = 128000;
  assert.deepEqual(serialClock(w, 'R2', SE), { dceDeviceId: 'R1', dceIf: SE, configured: 128000, effective: 128000, active: true });
  assert.equal(portLed(w, ref('R1', SE)), 'green');
  // encapsulation mismatch: up/down on both ends
  r2(w).config.interfaces[SE].encapsulation = 'ppp';
  assert.equal(state(w, 'R1', SE), 'up/down');
  assert.equal(state(w, 'R2', SE), 'up/down');
  assert.equal(portLed(w, ref('R1', SE)), 'amber');
  assert.equal(serialClock(w, 'R2', SE)?.active, true, 'HDLC/PPP mismatch does not remove physical clocking');
  r1(w).config.interfaces[SE].encapsulation = 'ppp';
  assert.equal(state(w, 'R1', SE), 'up/up');
  // DCE on the other end
  const w2 = buildBench();
  cable(w2, 'serial', ['R1', SE], ['R2', 'Serial0/1/1'], 'b');
  assert.equal(linkInfo(w2, ref('R1', SE)).dce, false);
  assert.equal(linkInfo(w2, ref('R2', 'Serial0/1/1')).dce, true);
});

test('loopbacks are up unless shut down; an SVI needs an active port in its VLAN', () => {
  const w = referenceLab();
  assert.equal(state(w, 'R1', 'Loopback0'), 'up/up');
  r1(w).config.interfaces['Loopback0'].shutdown = true;
  assert.equal(state(w, 'R1', 'Loopback0'), 'administratively down/down');

  const sw1 = getIos(w, 'SW1');
  sw1.config.interfaces['Vlan1'].shutdown = false;
  assert.equal(state(w, 'SW1', 'Vlan1'), 'up/up');
  const sw2 = getIos(w, 'SW2');
  sw2.config.interfaces['Vlan1'].shutdown = false;
  assert.equal(state(w, 'SW2', 'Vlan1'), 'up/down', 'SW2 has no cabled port');
  assert.match(interfaceState(w, 'SW2', 'Vlan1').problem ?? '', /no active port in VLAN 1/);
  // a switch port can be shut down too
  sw1.config.interfaces['GigabitEthernet1/0/1'].shutdown = true;
  assert.equal(state(w, 'SW1', 'GigabitEthernet1/0/1'), 'administratively down/down');
  assert.equal(state(w, 'PC1', 'Ethernet0'), 'down/down');
  assert.equal(portLed(w, ref('PC1', 'Ethernet0')), 'amber');
});

test('unplugging a cable takes the link down on both ends', () => {
  const w = referenceLab();
  assert.equal(state(w, 'R2', GI), 'up/up');
  assert.equal(portLed(w, ref('PC3', 'Ethernet0')), 'green');
  unplug(w, 'PC3', 'Ethernet0');
  assert.equal(state(w, 'R2', GI), 'down/down');
  assert.equal(state(w, 'PC3', 'Ethernet0'), 'down/down');
  assert.equal(portLed(w, ref('PC3', 'Ethernet0')), 'off');
});

test('one cable per port: canPlug refuses occupied ports and plugs that do not fit, and warns about useless combinations', () => {
  const w = referenceLab();
  const busy = canPlug(w, 'straight', ref('PC1', 'Ethernet0'), ref('SW1', 'GigabitEthernet1/0/5'));
  assert.equal(busy.ok, false);
  assert.match(busy.problem ?? '', /PC1 Ethernet0 already has a cable/);
  assert.deepEqual(canPlug(w, 'straight', ref('SW1', 'GigabitEthernet1/0/5'), ref('R1', 'GigabitEthernet0/0/1')), { ok: true });
  assert.equal(canPlug(w, 'serial', ref('R1', 'Serial0/1/1'), ref('R2', 'GigabitEthernet0/0/2')).ok, false);
  const useless = canPlug(w, 'straight', ref('SW1', 'GigabitEthernet1/0/5'), ref('R2', 'Console'));
  assert.equal(useless.ok, true);
  assert.match(useless.warning ?? '', /console port of R2/);
  const wrongType = canPlug(w, 'crossover', ref('SW1', 'GigabitEthernet1/0/5'), ref('R1', 'GigabitEthernet0/0/1'));
  assert.deepEqual([wrongType.ok, wrongType.warning], [true, 'Crossover cable between a router and a switch: this pair needs a straight-through cable.']);
});
