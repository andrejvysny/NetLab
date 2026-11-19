/** DHCP (ARCHITECTURE §6.6): local pools, exclusions, conflict check, bindings, relay, failure reasons. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADDR, GI, SE, acl, any, brokenLab, deny, eq, pc, permit, r1, r2, referenceLab, setAcl, smallLab, staticPc, unplug } from './fixtures.ts';
import { dhcpAcquire, dhcpRelease, sendFlow } from '../../src/engine/sim/index.ts';
import { getIos, getPc } from '../../src/engine/world.ts';
import type { World } from '../../src/engine/types.ts';

const GI1 = 'GigabitEthernet0/0/1';

/** smallLab with every PC set to DHCP and one pool per LAN on R1. */
function dhcpLab(): World {
  const w = smallLab();
  for (const id of ['PC1', 'PC2', 'PC3']) getPc(w, id).nic = { mode: 'dhcp', mac: getPc(w, id).nic.mac };
  getIos(w, 'R1').config.dhcp.pools = [
    { name: 'A', network: { address: '10.0.1.0', mask: '255.255.255.0' }, defaultRouters: ['10.0.1.1'], dnsServers: ['8.8.8.8'] },
    { name: 'B', network: { address: '10.0.2.0', mask: '255.255.255.0' }, defaultRouters: ['10.0.2.1'], dnsServers: [] },
  ];
  return w;
}

test('local pool: lowest free address, the pool is chosen by the interface that hears the request', () => {
  const w = dhcpLab();
  const a = dhcpAcquire(w, 'PC1');
  assert.deepEqual([a.ok, a.address, a.mask, a.gateway, a.server], [true, '10.0.1.2', '255.255.255.0', '10.0.1.1', '10.0.1.1']);
  assert.equal(getPc(w, 'PC1').nic.dns, '8.8.8.8');
  // .1 is skipped because the router answers its own test ping
  assert.ok(a.steps.some((s) => /R1 pings 10\.0\.1\.1 before offering it: R1 answers, so the address is in use and is skipped/.test(s.text)));
  const b = dhcpAcquire(w, 'PC2');
  assert.equal(b.address, '10.0.1.3', 'the next free address');
  const c = dhcpAcquire(w, 'PC3');
  assert.deepEqual([c.address, c.gateway, c.server], ['10.0.2.2', '10.0.2.1', '10.0.2.1']);
  assert.deepEqual(getIos(w, 'R1').runtime.dhcpBindings.map((x) => `${x.pool} ${x.address} ${x.clientId}`), [
    `A 10.0.1.2 ${getPc(w, 'PC1').nic.mac}`, `A 10.0.1.3 ${getPc(w, 'PC2').nic.mac}`, `B 10.0.2.2 ${getPc(w, 'PC3').nic.mac}`,
  ]);
  // the leases work
  assert.equal(sendFlow(w, { fromDeviceId: 'PC1', dst: '10.0.2.2', proto: 'icmp' }).ok, true);
  // every step is a DHCP step with a sentence
  assert.ok(a.steps.every((s) => s.feature === 'dhcp' && s.text.length > 10));
});

test('the same client gets the same address again; a release frees it', () => {
  const w = dhcpLab();
  assert.equal(dhcpAcquire(w, 'PC1').address, '10.0.1.2');
  assert.equal(dhcpAcquire(w, 'PC2').address, '10.0.1.3');
  const again = dhcpAcquire(w, 'PC1');
  assert.equal(again.address, '10.0.1.2');
  assert.ok(again.steps.some((s) => /already has a lease for PC1, so it offers the same address 10\.0\.1\.2 again/.test(s.text)));
  assert.equal(getIos(w, 'R1').runtime.dhcpBindings.length, 2);
  dhcpRelease(w, 'PC1');
  assert.equal(getPc(w, 'PC1').nic.address, undefined);
  assert.equal(getPc(w, 'PC1').nic.gateway, undefined);
  assert.deepEqual(getIos(w, 'R1').runtime.dhcpBindings.map((x) => x.address), ['10.0.1.3']);
  // PC3 moved into LAN A takes the freed address
  unplug(w, 'PC3', 'Ethernet0');
  w.cables.push({ id: 'm', kind: 'straight', a: { deviceId: 'PC3', port: 'Ethernet0' }, b: { deviceId: 'SW1', port: 'GigabitEthernet1/0/3' } });
  assert.equal(dhcpAcquire(w, 'PC3').address, '10.0.1.2');
  assert.equal(dhcpAcquire(w, 'PC1').address, '10.0.1.4');
  // releasing a static PC changes nothing
  staticPc(w, 'PC2', '10.0.1.20', '255.255.255.0', '10.0.1.1');
  dhcpRelease(w, 'PC2');
  assert.equal(getPc(w, 'PC2').nic.address, '10.0.1.20');
});

test('exclusions and addresses that answer a ping are never handed out', () => {
  const w = dhcpLab();
  // PC2 squats on 10.0.1.2 with a static address; .3–.9 are excluded
  staticPc(w, 'PC2', '10.0.1.2', '255.255.255.0', '10.0.1.1');
  getIos(w, 'R1').config.dhcp.excluded = [{ low: '10.0.1.3', high: '10.0.1.9' }, { low: '10.0.1.11', high: '10.0.1.11' }];
  const a = dhcpAcquire(w, 'PC1');
  assert.equal(a.address, '10.0.1.10');
  assert.ok(a.steps.some((s) => /pings 10\.0\.1\.2 before offering it: PC2 answers/.test(s.text)));
  assert.ok(a.steps.some((s) => s.detail === 'ip dhcp excluded-address 10.0.1.3 10.0.1.9'));
  // a lease that later falls into an excluded range is replaced
  getIos(w, 'R1').config.dhcp.excluded.push({ low: '10.0.1.10', high: '10.0.1.10' });
  assert.equal(dhcpAcquire(w, 'PC1').address, '10.0.1.12');
  assert.deepEqual(getIos(w, 'R1').runtime.dhcpBindings.map((x) => x.address), ['10.0.1.12']);
});

test('small pools run out; a pool without default-router gives no gateway', () => {
  const w = dhcpLab();
  const c = getIos(w, 'R1').config;
  c.interfaces[GI].ip = { address: '10.0.1.1', mask: '255.255.255.252' };
  c.dhcp.pools[0] = { name: 'A', network: { address: '10.0.1.0', mask: '255.255.255.252' }, defaultRouters: [], dnsServers: [] };
  const a = dhcpAcquire(w, 'PC1');
  assert.deepEqual([a.ok, a.address, a.gateway], [true, '10.0.1.2', undefined]);
  assert.match(a.steps.at(-1)?.text ?? '', /no default gateway \(the pool has no "default-router"\)/);
  assert.equal('gateway' in getPc(w, 'PC1').nic, false);
  const b = dhcpAcquire(w, 'PC2');
  assert.equal(b.ok, false);
  assert.equal(b.reasonText, 'No DHCP server answered: Pool A on R1 has no free address left.');
  assert.equal(getPc(w, 'PC2').nic.address, undefined);
});

test('who can ask: static PCs, dead links and segments without a router are explained', () => {
  const w = dhcpLab();
  staticPc(w, 'PC1', '10.0.1.10', '255.255.255.0');
  const s = dhcpAcquire(w, 'PC1');
  assert.equal(s.ok, false);
  assert.match(s.reasonText ?? '', /PC1 uses a fixed \(static\) address/);
  assert.equal(getPc(w, 'PC1').nic.address, '10.0.1.10', 'a static PC keeps its address');
  // link down
  unplug(w, 'PC2', 'Ethernet0');
  assert.match(dhcpAcquire(w, 'PC2').reasonText ?? '', /its network link is down\. No cable is plugged into PC2 Ethernet0/);
  // the router interface is shut down: nobody hears the broadcast
  getIos(w, 'R1').config.interfaces[GI1].shutdown = true;
  assert.match(dhcpAcquire(w, 'PC3').reasonText ?? '', /its network link is down/);
  // router interface up but without an address
  getIos(w, 'R1').config.interfaces[GI1].shutdown = false;
  delete getIos(w, 'R1').config.interfaces[GI1].ip;
  assert.match(dhcpAcquire(w, 'PC3').reasonText ?? '', /No DHCP server answered: no router interface with an IP address is active on the link of PC3\. R1 GigabitEthernet0\/0\/1 is on the link but has no IP address/);
  // a PC in another VLAN is cut off from the server
  const v = dhcpLab();
  getIos(v, 'SW1').config.interfaces['GigabitEthernet1/0/2'].switchport = { mode: 'access', accessVlan: 20 };
  assert.match(dhcpAcquire(v, 'PC2').reasonText ?? '', /A broadcast does not cross a router/);
  assert.equal(dhcpAcquire(v, 'PC1').ok, true);
  // not a PC
  assert.equal(dhcpAcquire(v, 'R1').ok, false);
});

test('an inbound ACL on the router interface can block the DHCP broadcast', () => {
  const w = dhcpLab();
  const c = getIos(w, 'R1').config;
  setAcl(c, acl('105', 'extended', [permit('ip', { kind: 'net', address: '10.0.1.0', wildcard: '0.0.0.255' }, any)]));
  c.interfaces[GI].aclIn = '105';
  const a = dhcpAcquire(w, 'PC1');
  assert.equal(a.ok, false);
  assert.match(a.reasonText ?? '', /R1 drops the DHCP request: access list 105, applied inbound on GigabitEthernet0\/0\/0, does not permit it \(UDP from 0\.0\.0\.0 port 68 to 255\.255\.255\.255 port 67\)/);
  // permit bootps and it works
  c.acls['105'].entries.unshift({ seq: 5, action: 'permit', protocol: 'udp', src: any, dst: any, dstPort: eq(67) });
  assert.equal(dhcpAcquire(w, 'PC1').ok, true);
  assert.equal(getIos(w, 'R1').runtime.aclHits['105:5'], 1);
  void deny;
});

test('relay: giaddr selects the pool, the offer must find its way back to the relay', () => {
  const w = referenceLab({ acquire: false });
  const a = dhcpAcquire(w, 'PC3');
  assert.equal(a.ok, true, a.reasonText ?? '');
  // the relayed request is an ordinary packet: its trace steps are part of the DHCP trace
  const hdr = a.steps.map((s) => s.header).filter((h): h is string => !!h);
  assert.ok(hdr.includes('UDP DHCP discover 60.50.40.1:67 → 60.50.30.1:67'));
  assert.ok(hdr.includes('UDP DHCP offer 60.50.30.1:67 → 60.50.40.1:67'));
  assert.ok(a.steps.some((s) => /the relay address 60\.50\.40\.1 selects pool LAN2 \(60\.50\.40\.0\/26\)/.test(s.text)));
  assert.ok(a.steps.some((s) => s.deviceId === 'R2' && /passes the offer on to PC3/.test(s.text)));

  // R1 cannot route the answer back to the relay address
  const noWayBack = brokenLab((x) => { r1(x).config.staticRoutes = []; });
  const b = dhcpAcquire(noWayBack, 'PC3');
  assert.equal(b.ok, false);
  assert.match(b.reasonText ?? '', /R1 offers 60\.50\.40\.\d+, but its answer to the relay address 60\.50\.40\.1 is lost: R1 has no route to 60\.50\.40\.1/);
  assert.equal(r1(noWayBack).runtime.dhcpBindings.some((x) => x.pool === 'LAN2'), false, 'a lost offer leaves no lease behind');
  // the helper points at the wrong router address (R2 itself)
  const self = brokenLab((x) => { r2(x).config.interfaces[GI].helperAddresses = [ADDR.r2Wan]; });
  assert.match(dhcpAcquire(self, 'PC3').reasonText ?? '', /R2 forwards the request to 60\.50\.30\.2, which is R2\. That device is not a DHCP server/);
  // the helper points at PC1's public address: a PC is not a DHCP server
  const toPc = brokenLab((x) => { r2(x).config.interfaces[GI].helperAddresses = [ADDR.pc1Public]; });
  assert.match(dhcpAcquire(toPc, 'PC3').reasonText ?? '', /which is PC1\. That device is not a DHCP server/);
  // several helpers: the first that leads to a server wins
  const two = brokenLab((x) => { r2(x).config.interfaces[GI].helperAddresses = ['60.50.30.3', ADDR.r1Wan]; });
  assert.equal(pc(two, 'PC3').nic.address, ADDR.pc3);
  // the WAN link is down
  const down = brokenLab((x) => { r1(x).config.interfaces[SE].shutdown = true; });
  assert.match(dhcpAcquire(down, 'PC3').reasonText ?? '', /it does not arrive: R2 has no route to 60\.50\.30\.1/);
});

test('if the server cannot see a conflict, the client finds it and declines the address', () => {
  // With a broken tunnel R1's test ping to 60.50.40.1 gets no answer, so R1 offers R2's own address first.
  const w = brokenLab((x) => { r2(x).config.crypto.isakmpKeys[0].key = 'wrong'; }, { acquire: false });
  const a = dhcpAcquire(w, 'PC3');
  assert.equal(a.ok, true, a.reasonText ?? '');
  assert.equal(a.address, '60.50.40.2');
  assert.ok(a.steps.some((s) => /pings 60\.50\.40\.1 before offering it: nobody answers/.test(s.text)));
  assert.ok(a.steps.some((s) => /PC3 finds that R2 GigabitEthernet0\/0\/0 already uses the offered address 60\.50\.40\.1, so it declines the offer/.test(s.text)));
  assert.deepEqual(r1(w).runtime.dhcpBindings.filter((x) => x.pool === 'LAN2').map((x) => x.address), ['60.50.40.2']);
});
