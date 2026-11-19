/** IPsec with crypto maps (ARCHITECTURE §6.4): negotiation, SA tables, counters, clear-text check, ACL interaction. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADDR, SE, acl, any, deny, eq, host, permit, ping, r1, r2, referenceLab, setAcl, snmp, staticPc, tcp } from './fixtures.ts';
import { probeFlow, sendFlow } from '../../src/engine/sim/index.ts';
import type { World } from '../../src/engine/types.ts';

/** Reference lab with static PC addresses, so that no packet has crossed the WAN yet (no SAs). */
function quietLab(mutate?: (w: World) => void): World {
  return referenceLab({
    acquire: false,
    mutate: (w) => {
      staticPc(w, 'PC2', ADDR.pc2, '255.255.255.0', ADDR.r1Lan);
      staticPc(w, 'PC3', ADDR.pc3, '255.255.255.192', ADDR.r2Lan);
      mutate?.(w);
    },
  });
}

test('the first protected packet negotiates the tunnel; SAs appear on both routers with counters', () => {
  const w = quietLab();
  assert.equal(r1(w).runtime.ipsecSas.length, 0);
  const f = sendFlow(w, ping('PC1', ADDR.pc3));
  assert.equal(f.ok, true, f.summary);
  assert.equal(f.forward.negotiated, true, 'this packet created the SA');
  assert.equal(f.forward.encrypted, true);
  assert.equal(f.reverse?.negotiated, undefined, 'the reply reuses it');
  assert.equal(f.reverse?.encrypted, true);
  const neg = f.forward.steps.find((s) => s.stage === 'crypto' && /negotiates/.test(s.text));
  assert.match(neg?.text ?? '', /^R1 has no IPsec tunnel for this kind of traffic yet, so it negotiates one with R2 \(IKE\) and succeeds\.$/);
  assert.match(neg?.detail ?? '', /ISAKMP policy 10 \(aes, sha, pre-share, group 2\) matches R2 policy 10/);
  assert.match(neg?.detail ?? '', /pre-shared keys match/);
  assert.match(neg?.detail ?? '', /transform-set TS \(esp-aes esp-sha-hmac, tunnel\)/);
  assert.match(neg?.detail ?? '', /R2 crypto map CM 10: set peer 60\.50\.30\.1/);

  const a = r1(w).runtime.ipsecSas;
  const b = r2(w).runtime.ipsecSas;
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  assert.deepEqual(
    { iface: a[0].iface, map: a[0].mapName, seq: a[0].seq, local: a[0].localEndpoint, remote: a[0].remoteEndpoint, transform: a[0].transform, mode: a[0].mode },
    { iface: SE, map: 'CM', seq: 10, local: ADDR.r1Wan, remote: ADDR.r2Wan, transform: 'esp-aes esp-sha-hmac', mode: 'tunnel' });
  assert.deepEqual(a[0].localIdent, { address: '0.0.0.0', mask: '0.0.0.0', protocol: 1, port: 0 });
  assert.deepEqual(a[0].remoteIdent, { address: '0.0.0.0', mask: '0.0.0.0', protocol: 1, port: 0 });
  assert.deepEqual([b[0].localEndpoint, b[0].remoteEndpoint], [ADDR.r2Wan, ADDR.r1Wan]);
  assert.deepEqual([a[0].spiOut, a[0].spiIn], [b[0].spiIn, b[0].spiOut], 'the SPIs of the two routers are mirror images');
  assert.notEqual(a[0].spiIn, a[0].spiOut);
  // one packet each way
  assert.deepEqual([a[0].encaps, a[0].decaps, b[0].encaps, b[0].decaps], [1, 1, 1, 1]);
  assert.deepEqual(r1(w).runtime.ikeSas.map((s) => [s.local, s.remote, s.state]), [[ADDR.r1Wan, ADDR.r2Wan, 'QM_IDLE']]);
  assert.deepEqual(r2(w).runtime.ikeSas.map((s) => [s.local, s.remote, s.state]), [[ADDR.r2Wan, ADDR.r1Wan, 'QM_IDLE']]);

  // more pings use the same SA and only move the counters
  const again = sendFlow(w, ping('PC2', ADDR.pc3));
  assert.equal(again.forward.negotiated, undefined);
  sendFlow(w, ping('PC3', ADDR.pc1Public));
  assert.equal(r1(w).runtime.ipsecSas.length, 1);
  assert.deepEqual([a[0].encaps, a[0].decaps, b[0].encaps, b[0].decaps], [3, 3, 3, 3]);
  // the crypto ACL entries count their matches
  assert.equal(r1(w).runtime.aclHits['120:50'], 3);
  assert.equal(r2(w).runtime.aclHits['120:50'], 3);
});

test('every crypto ACL line gets its own SA pair; the answer direction reuses the mirrored SA', () => {
  const w = quietLab();
  const t = sendFlow(w, tcp('PC1', ADDR.r2Wan, 23));
  assert.equal(t.ok, true, t.summary);
  assert.equal(t.forward.negotiated, true);
  assert.equal(t.reverse?.negotiated, undefined, 'R2 answers through the SA that R1 opened');
  const s = sendFlow(w, snmp('PC1', ADDR.r2Wan, 'D105read'));
  assert.equal(s.forward.negotiated, true);
  const idents = (w2: World, id: 'R1' | 'R2') => (id === 'R1' ? r1(w2) : r2(w2)).runtime.ipsecSas.map((x) => `${x.localIdent.protocol}/${x.localIdent.port} → ${x.remoteIdent.protocol}/${x.remoteIdent.port}`);
  assert.deepEqual(idents(w, 'R1'), ['6/0 → 6/23', '17/0 → 17/161']);
  assert.deepEqual(idents(w, 'R2'), ['6/23 → 6/0', '17/161 → 17/0']);
  // a Telnet from the R2 side to R1 matches the same kind of entry on R2 and builds a second pair in the other sense
  const back = sendFlow(w, tcp('PC3', ADDR.r1Wan, 23));
  assert.equal(back.forward.negotiated, true);
  assert.deepEqual(idents(w, 'R2'), ['6/23 → 6/0', '17/161 → 17/0', '6/0 → 6/23']);
  assert.equal(r1(w).runtime.ikeSas.length, 1, 'still one ISAKMP SA between the two routers');
});

test('traffic that the crypto ACL does not select crosses in clear and builds no SA', () => {
  const w = quietLab();
  const f = sendFlow(w, tcp('PC1', ADDR.pc3, 80));
  assert.equal(f.ok, true);
  assert.deepEqual([f.forward.encrypted, f.reverse?.encrypted, f.forward.negotiated], [false, false, undefined]);
  assert.equal(r1(w).runtime.ipsecSas.length + r2(w).runtime.ipsecSas.length, 0);
  assert.equal(r1(w).runtime.ikeSas.length, 0);
  const note = f.forward.steps.find((s) => s.stage === 'crypto');
  assert.equal(note?.verdict, 'info');
  assert.match(note?.text ?? '', /Crypto map CM on Serial0\/1\/0 does not select this packet, so it is sent without encryption/);
});

test('a deny entry in the crypto ACL exempts traffic on both routers (first match wins)', () => {
  const w = quietLab((x) => {
    r1(x).config.acls['120'].entries.unshift({ seq: 5, action: 'deny', protocol: 'icmp', src: host(ADDR.r1Wan), dst: host(ADDR.r2Wan) });
    r2(x).config.acls['120'].entries.unshift({ seq: 5, action: 'deny', protocol: 'icmp', src: host(ADDR.r2Wan), dst: host(ADDR.r1Wan) });
  });
  const f = sendFlow(w, ping('R1', ADDR.r2Wan));
  assert.equal(f.ok, true, f.summary);
  assert.deepEqual([f.forward.encrypted, f.reverse?.encrypted], [false, false]);
  // other ICMP is still protected
  assert.equal(sendFlow(w, ping('PC1', ADDR.pc3)).forward.encrypted, true);
});

test('clear text where encryption is expected is dropped and logged', () => {
  // R1's map entry is incomplete (no transform-set): IOS ignores it, so R1 sends ICMP in clear — R2 refuses it
  const w = quietLab((x) => { r1(x).config.crypto.maps[0].entries[0].transformSets = []; });
  const f = sendFlow(w, ping('PC1', ADDR.pc3));
  assert.deepEqual([f.ok, f.symbol, f.forward.reason, f.forward.atDeviceId, f.forward.encrypted], [false, '.', 'ipsec-expected', 'R2', false]);
  assert.match(f.forward.steps.find((s) => s.deviceId === 'R1' && s.stage === 'crypto')?.detail ?? '', /crypto map CM 10 is incomplete and ignored \(missing: set transform-set\)/);
  const drop = f.forward.steps.at(-1)!;
  assert.deepEqual([drop.stage, drop.feature, drop.verdict], ['decrypt', 'ipsec', 'drop']);
  assert.match(drop.detail ?? '', /access list 120 entry 50 "permit icmp any any" matches the packet with source and destination swapped/);
  assert.deepEqual(r2(w).runtime.logBuffer.map((m) => [m.severity, m.mnemonic]), [[4, 'CRYPTO-4-RECVD_PKT_NOT_IPSEC']]);
  // HTTP is not covered by the crypto ACL, so it is fine in clear
  assert.equal(sendFlow(w, tcp('PC1', ADDR.pc3, 80)).ok, true);
});

test('an inbound ACL sees the ESP packet, not what is inside it', () => {
  const allowTunnel = (x: World, ike: boolean, esp: boolean) => {
    const entries = [];
    if (ike) entries.push(permit('udp', host(ADDR.r1Wan), host(ADDR.r2Wan), { dstPort: eq(500) }));
    if (esp) entries.push(permit('esp', host(ADDR.r1Wan), host(ADDR.r2Wan)));
    entries.push(deny('ip', any, any));
    setAcl(r2(x).config, acl('150', 'extended', entries));
    r2(x).config.interfaces[SE].aclIn = '150';
  };
  const w = quietLab((x) => allowTunnel(x, true, true));
  const f = sendFlow(w, ping('PC1', ADDR.pc3));
  assert.equal(f.ok, true, f.summary);
  const aclStep = f.forward.steps.find((s) => s.deviceId === 'R2' && s.stage === 'acl-in');
  assert.match(aclStep?.detail ?? '', /permit esp host 60\.50\.30\.1 host 60\.50\.30\.2/);
  assert.equal(aclStep?.header, 'ESP 60.50.30.1 → 60.50.30.2 [ICMP echo 60.50.50.100 → 60.50.40.2]');
  // the decrypted ICMP packet is not checked against the list again; clear-text HTTP is
  const web = sendFlow(w, tcp('PC1', ADDR.pc3, 80));
  assert.deepEqual([web.forward.reason, web.forward.atDeviceId], ['acl-in', 'R2']);

  // IKE blocked: nothing can be negotiated, and the reason names UDP 500 and the list
  const noIke = quietLab((x) => allowTunnel(x, false, true));
  const g = sendFlow(noIke, ping('PC1', ADDR.pc3));
  assert.equal(g.forward.reason, 'ipsec-negotiation-failed');
  assert.match(g.summary, /R1 cannot reach the peer 60\.50\.30\.2 to negotiate \(IKE uses UDP port 500\): R2 drops the packet: access list 150, applied inbound on Serial0\/1\/0/);
  // ESP blocked: the routers agree, but the tunnel cannot carry anything
  const noEsp = quietLab((x) => allowTunnel(x, true, false));
  const h = sendFlow(noEsp, ping('PC1', ADDR.pc3));
  assert.equal(h.forward.reason, 'ipsec-negotiation-failed');
  assert.match(h.summary, /ESP packets from 60\.50\.30\.1 cannot reach 60\.50\.30\.2/);
  assert.equal(r1(noEsp).runtime.ipsecSas.length, 0);
  assert.deepEqual(r1(noEsp).runtime.ikeSas.map((s) => s.state), ['QM_IDLE'], 'phase 1 itself worked');
});

test('peer and proposal problems are named precisely', () => {
  const cases: [string, (x: World) => void, RegExp][] = [
    ['wrong peer on R1', (x) => { r1(x).config.crypto.maps[0].entries[0].peers = ['60.50.30.3']; r1(x).config.crypto.isakmpKeys[0].address = '60.50.30.3'; },
      /R1 cannot reach the peer 60\.50\.30\.3 to negotiate/],
    ['R2 expects another peer', (x) => { r2(x).config.crypto.maps[0].entries[0].peers = ['1.1.1.1']; },
      /Crypto map CM on R2 has no entry with "set peer 60\.50\.30\.1".*It has: set peer 1\.1\.1\.1/],
    ['no key for the peer on R1', (x) => { r1(x).config.crypto.isakmpKeys = []; }, /R1 has no pre-shared key for the peer 60\.50\.30\.2/],
    ['ISAKMP disabled on R2', (x) => { r2(x).config.crypto.isakmpEnabled = false; }, /ISAKMP is switched off on R2/],
    ['no policy on R1', (x) => { r1(x).config.crypto.isakmpPolicies = []; }, /R1 has no ISAKMP policy/],
    ['PFS only on R2', (x) => { r2(x).config.crypto.maps[0].entries[0].pfsGroup = 2; }, /R2 requires PFS group 2/],
    ['map name not defined on R2', (x) => { r2(x).config.interfaces[SE].cryptoMap = 'OTHER'; }, /R2 Serial0\/1\/0 refers to crypto map OTHER, which is not defined/],
    ['WAN interface of R1 without address', (x) => { delete r1(x).config.interfaces[SE].ip; r1(x).config.staticRoutes = [{ prefix: '0.0.0.0', mask: '0.0.0.0', exitInterface: SE }]; },
      /Serial0\/1\/0 has no IP address to use as the tunnel endpoint/],
  ];
  for (const [name, mutate, re] of cases) {
    const f = sendFlow(quietLab(mutate), ping('PC1', ADDR.pc3));
    assert.equal(f.forward.reason, 'ipsec-negotiation-failed', name);
    assert.match(f.summary, re, name);
    assert.equal(f.symbol, '.', name);
  }
  // a wildcard key (address 0.0.0.0) matches any peer
  const wild = quietLab((x) => { r2(x).config.crypto.isakmpKeys = [{ key: 'KSS123', address: '0.0.0.0' }]; });
  assert.equal(sendFlow(wild, ping('PC1', ADDR.pc3)).ok, true);
});

test('SAs follow the configuration: a change that breaks the agreement tears the tunnel down, a fix brings it back', () => {
  const w = quietLab();
  assert.equal(sendFlow(w, ping('PC1', ADDR.pc3)).ok, true);
  assert.equal(r1(w).runtime.ipsecSas.length, 1);
  r2(w).config.crypto.isakmpKeys[0].key = 'changed';
  const f = sendFlow(w, ping('PC1', ADDR.pc3));
  assert.equal(f.forward.reason, 'ipsec-negotiation-failed');
  assert.equal(r1(w).runtime.ipsecSas.length, 0);
  assert.equal(r2(w).runtime.ipsecSas.length, 0);
  r2(w).config.crypto.isakmpKeys[0].key = 'KSS123';
  const g = sendFlow(w, ping('PC1', ADDR.pc3));
  assert.deepEqual([g.ok, g.forward.negotiated], [true, true]);
  // clearing the SAs on one router only ("clear crypto sa") is repaired by a new negotiation as well
  r2(w).runtime.ipsecSas = [];
  const h = sendFlow(w, ping('PC1', ADDR.pc3));
  assert.deepEqual([h.ok, h.forward.negotiated], [true, true]);
  assert.deepEqual([r1(w).runtime.ipsecSas.length, r2(w).runtime.ipsecSas.length], [1, 1]);
});

test('transport mode protects traffic between the two endpoints without a new header', () => {
  const w = quietLab((x) => {
    r1(x).config.crypto.transformSets[0].mode = 'transport';
    r2(x).config.crypto.transformSets[0].mode = 'transport';
  });
  const f = sendFlow(w, ping('R1', ADDR.r2Wan));
  assert.equal(f.ok, true, f.summary);
  const esp = f.forward.steps.find((s) => s.stage === 'crypto' && s.verdict === 'changed');
  assert.match(esp?.text ?? '', /transport mode/);
  assert.equal(esp?.header, 'ESP 60.50.30.1 → 60.50.30.2 [ICMP echo 60.50.30.1 → 60.50.30.2]');
  assert.equal(r1(w).runtime.ipsecSas[0].mode, 'transport');
  // traffic of other hosts cannot use transport mode: it is tunnelled
  const g = sendFlow(w, ping('PC1', ADDR.pc3));
  assert.equal(g.ok, true, g.summary);
  assert.match(g.forward.steps.find((s) => s.stage === 'crypto' && s.verdict === 'changed')?.text ?? '', /tunnel mode/);
});

test('probing a protected flow on a fresh lab reports the negotiation but leaves no SA behind', () => {
  const w = quietLab();
  const before = structuredClone(w);
  const f = probeFlow(w, ping('PC1', ADDR.pc3));
  assert.deepEqual([f.ok, f.forward.negotiated, f.forward.encrypted], [true, true, true]);
  assert.deepEqual(w, before);
});
