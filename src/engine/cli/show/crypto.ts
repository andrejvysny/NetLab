/**
 * IPsec / ISAKMP screens: show crypto isakmp policy|sa|key, show crypto ipsec sa|transform-set, show crypto map,
 * show crypto session. SA tables come from runtime.ikeSas / runtime.ipsecSas (both routers hold their half).
 */
import type { Ace, Acl, AddrMatch, CryptoMapEntry, IkeSa, IosDevice, IpsecSa, IsakmpPolicy, PortMatch, Selector, World } from '../../types.ts';
import { wildcardToMask } from '../../ip.ts';
import { joinLines, padL, padR, secondsAt } from './util.ts';

// ───────────────────────────── ISAKMP policy ─────────────────────────────
const ENC: Record<string, string> = {
  des: 'DES - Data Encryption Standard (56 bit keys).',
  '3des': 'Three key triple DES',
  aes: 'AES - Advanced Encryption Standard (128 bit key.)',
  'aes 192': 'AES - Advanced Encryption Standard (192 bit key.)',
  'aes 256': 'AES - Advanced Encryption Standard (256 bit key.)',
};
const HASH: Record<string, string> = {
  sha: 'Secure Hash Standard', md5: 'Message Digest 5', sha256: 'Secure Hash Standard 2 (256 bit)',
  sha384: 'Secure Hash Standard 2 (384 bit)', sha512: 'Secure Hash Standard 2 (512 bit)',
};
const AUTH: Record<string, string> = { 'pre-share': 'Pre-Shared Key', 'rsa-sig': 'Rivest-Shamir-Adleman Signature', 'rsa-encr': 'Rivest-Shamir-Adleman Encryption' };
const DH: Record<number, string> = {
  1: '#1 (768 bit)', 2: '#2 (1024 bit)', 5: '#5 (1536 bit)', 14: '#14 (2048 bit)', 15: '#15 (3072 bit)', 16: '#16 (4096 bit)',
  19: '#19 (256 bit ecp)', 20: '#20 (384 bit ecp)', 21: '#21 (521 bit ecp)', 24: '#24 (2048 bit, 256 bit subgroup)',
};
function suite(p: { encryption: string; hash: string; authentication: string; group: number; lifetime: number }): string[] {
  return [
    `\tencryption algorithm:\t${ENC[p.encryption] ?? p.encryption}`,
    `\thash algorithm:\t\t${HASH[p.hash] ?? p.hash}`,
    `\tauthentication method:\t${AUTH[p.authentication] ?? p.authentication}`,
    `\tDiffie-Hellman group:\t${DH[p.group] ?? `#${p.group}`}`,
    `\tlifetime:\t\t${p.lifetime} seconds, no volume limit`,
  ];
}
export function isakmpPolicy(dev: IosDevice): string {
  const out = ['', 'Global IKE policy'];
  for (const p of [...dev.config.crypto.isakmpPolicies].sort((a: IsakmpPolicy, b: IsakmpPolicy) => a.priority - b.priority)) {
    out.push(`Protection suite of priority ${p.priority}`, ...suite(p));
  }
  out.push('Default protection suite', ...suite({ encryption: 'des', hash: 'sha', authentication: 'rsa-sig', group: 1, lifetime: 86400 }));
  return out.join('\n');
}

// ───────────────────────────── ISAKMP SA ─────────────────────────────
function counterpart(world: World, dev: IosDevice, sa: IkeSa): IkeSa | undefined {
  for (const id of world.order) {
    const d = world.devices[id];
    if (!d || d.kind === 'pc' || d.id === dev.id) continue;
    const s = d.runtime.ikeSas.find((x) => x.local === sa.remote && x.remote === sa.local);
    if (s) return s;
  }
  return undefined;
}
/** IOS lists the initiator's address as src. The SA created first belongs to the initiator. */
function ikeEnds(world: World, dev: IosDevice, sa: IkeSa): { dst: string; src: string } {
  const other = counterpart(world, dev, sa);
  const initiator = !other || sa.id < other.id;
  return initiator ? { dst: sa.remote, src: sa.local } : { dst: sa.local, src: sa.remote };
}
export function connId(dev: IosDevice, sa: IkeSa): number {
  const i = dev.runtime.ikeSas.indexOf(sa);
  return sa.state === 'QM_IDLE' ? 1001 + Math.max(0, i) : 0;
}
export function isakmpSa(world: World, dev: IosDevice): string {
  const out = ['IPv4 Crypto ISAKMP SA', 'dst             src             state          conn-id status'];
  for (const sa of dev.runtime.ikeSas) {
    const e = ikeEnds(world, dev, sa);
    out.push(`${padR(e.dst, 15)} ${padR(e.src, 15)} ${padR(sa.state, 14)}${padL(connId(dev, sa), 8)} ACTIVE`);
  }
  out.push('', 'IPv6 Crypto ISAKMP SA', '');
  return joinLines(out);
}
export function isakmpSaDetail(world: World, dev: IosDevice): string {
  const out = [
    'Codes: C - IKE configuration mode, D - Dead Peer Detection',
    '       K - Keepalives, N - NAT-traversal',
    '       T - cTCP encapsulation, X - IKE Extended Authentication',
    '       psk - Preshared key, rsig - RSA signature',
    '       renc - RSA encryption',
    'IPv4 Crypto ISAKMP SA',
    '',
    'C-id  Local           Remote          I-VRF  Status Encr Hash   Auth DH Lifetime Cap.',
    '',
  ];
  const pol = [...dev.config.crypto.isakmpPolicies].sort((a, b) => a.priority - b.priority)[0];
  for (const sa of dev.runtime.ikeSas) {
    const life = Math.max(0, 86400 - (secondsAt(world.tick) - secondsAt(sa.createdTick)));
    const hh = String(Math.floor(life / 3600)).padStart(2, '0');
    const mm = String(Math.floor((life % 3600) / 60)).padStart(2, '0');
    const ss = String(life % 60).padStart(2, '0');
    const encr = pol?.encryption.replace(' ', '') ?? 'des';
    out.push(`${padR(connId(dev, sa), 6)}${padR(sa.local, 16)}${padR(sa.remote, 16)}${padR('', 7)}${padR(sa.state === 'QM_IDLE' ? 'ACTIVE' : 'DELETE', 7)}${padR(encr, 5)}${padR(pol?.hash ?? 'sha', 7)}${padR('psk', 5)}${padR(pol?.group ?? 1, 3)}${hh}:${mm}:${ss}`);
    out.push('       Engine-id:Conn-id =  SW:' + connId(dev, sa));
  }
  out.push('', 'IPv6 Crypto ISAKMP SA', '');
  return joinLines(out);
}
export function isakmpKey(dev: IosDevice): string {
  const out = ['Keyring      Hostname/Address                            Preshared Key', ''];
  for (const k of dev.config.crypto.isakmpKeys) {
    const a = k.mask && k.mask !== '255.255.255.255' ? `${k.address} [${k.mask}]` : k.address;
    out.push(`${padR('default', 13)}${padR(a, 44)}${k.key}`);
  }
  return joinLines(out);
}

// ───────────────────────────── IPsec SA ─────────────────────────────
const PROTO_NUM: Record<string, number> = { ip: 0, icmp: 1, tcp: 6, udp: 17, gre: 47, esp: 50, ahp: 51, eigrp: 88, ospf: 89 };
function sel(a: AddrMatch, port: PortMatch | undefined, proto: Ace['protocol']): Selector {
  const protocol = typeof proto === 'number' ? proto : (PROTO_NUM[proto] ?? 0);
  const p = port && port.op === 'eq' && port.ports.length === 1 ? port.ports[0] : 0;
  if (a.kind === 'any') return { address: '0.0.0.0', mask: '0.0.0.0', protocol, port: p };
  if (a.kind === 'host') return { address: a.address, mask: '255.255.255.255', protocol, port: p };
  return { address: a.address, mask: wildcardToMask(a.wildcard), protocol, port: p };
}
function selText(s: Selector): string { return `(${s.address}/${s.mask}/${s.protocol}/${s.port})`; }
function sameSel(a: Selector, b: Selector): boolean { return a.address === b.address && a.mask === b.mask && a.protocol === b.protocol && a.port === b.port; }
function hex(n: number): string { return `0x${(n >>> 0).toString(16).toUpperCase()}(${n >>> 0})`; }
function transformText(t: string): string {
  return t.replace(/esp-aes (128|192|256)\b/g, 'esp-$1-aes');
}
function lifetimeLine(world: World, sa: IpsecSa | undefined, entry: CryptoMapEntry | undefined): string {
  const secs = entry?.saLifetimeSeconds ?? 3600;
  const kb = entry?.saLifetimeKilobytes ?? 4608000;
  const left = sa ? Math.max(0, secs - (secondsAt(world.tick) - secondsAt(sa.createdTick))) : secs;
  const usedKb = sa ? Math.ceil((sa.encaps + sa.decaps) * 0.15) : 0;
  return `        sa timing: remaining key lifetime (k/sec): (${Math.max(0, kb - 1 - usedKb)}/${left})`;
}
function saBlock(world: World, dev: IosDevice, sa: IpsecSa, which: 'in' | 'out', entry: CryptoMapEntry | undefined, conn: number): string[] {
  const spi = which === 'in' ? sa.spiIn : sa.spiOut;
  const aes = /aes/.test(sa.transform);
  return [
    `      spi: ${hex(spi)}`,
    `        transform: ${transformText(sa.transform)} ,`,
    `        in use settings ={${sa.mode === 'tunnel' ? 'Tunnel' : 'Transport'}, }`,
    `        conn id: ${conn}, flow_id: ESG:${conn - 2000}, sibling_flags FFFFFFFF80000048, crypto map: ${sa.mapName}`,
    lifetimeLine(world, sa, entry),
    `        IV size: ${aes ? 16 : 8} bytes`,
    '        replay detection support: Y',
    '        Status: ACTIVE(ACTIVE)',
    '',
  ];
}
interface Flow { local: Selector; remote: Selector; peer: string; entry?: CryptoMapEntry; sas: IpsecSa[] }

/** Flows of one interface: one per permit entry of the crypto ACLs (as IOS lists them), plus SAs that fit none. */
function flowsFor(dev: IosDevice, ifName: string): { mapName: string; flows: Flow[] } | null {
  const mapName = dev.config.interfaces[ifName]?.cryptoMap;
  if (!mapName) return null;
  const map = dev.config.crypto.maps.find((m) => m.name === mapName);
  const sas = dev.runtime.ipsecSas.filter((s) => s.iface === ifName && s.mapName === mapName);
  const used = new Set<IpsecSa>();
  const flows: Flow[] = [];
  for (const e of [...(map?.entries ?? [])].sort((a, b) => a.seq - b.seq)) {
    const acl: Acl | undefined = e.matchAcl ? dev.config.acls[e.matchAcl] : undefined;
    if (!acl || !e.peers.length) continue;
    for (const ace of acl.entries) {
      if (ace.action !== 'permit') continue;
      const local = sel(ace.src, ace.srcPort, ace.protocol);
      const remote = sel(ace.dst, ace.dstPort, ace.protocol);
      const mine = sas.filter((s) => s.seq === e.seq && sameSel(s.localIdent, local) && sameSel(s.remoteIdent, remote));
      mine.forEach((s) => used.add(s));
      flows.push({ local, remote, peer: mine[0]?.remoteEndpoint ?? e.peers[0], entry: e, sas: mine });
    }
  }
  for (const s of sas) {
    if (used.has(s)) continue;
    const e = map?.entries.find((x) => x.seq === s.seq);
    flows.push({ local: s.localIdent, remote: s.remoteIdent, peer: s.remoteEndpoint, entry: e, sas: [s] });
  }
  return { mapName, flows };
}
function cryptoIfaces(dev: IosDevice): string[] {
  return Object.keys(dev.config.interfaces).filter((n) => !!dev.config.interfaces[n].cryptoMap).sort();
}
export function ipsecSa(world: World, dev: IosDevice, peerFilter?: string, ifFilter?: string): string {
  const out: string[] = [];
  let conn = 2001;
  for (const ifName of cryptoIfaces(dev)) {
    if (ifFilter && ifName !== ifFilter) continue;
    const f = flowsFor(dev, ifName);
    if (!f) continue;
    const local = dev.config.interfaces[ifName].ip?.address ?? '0.0.0.0';
    const flows = f.flows.filter((x) => !peerFilter || x.peer === peerFilter);
    if (!flows.length && peerFilter) continue;
    out.push('', `interface: ${ifName}`, `    Crypto map tag: ${f.mapName}, local addr ${local}`);
    for (const fl of flows) {
      const enc = fl.sas.reduce((n, s) => n + s.encaps, 0);
      const dec = fl.sas.reduce((n, s) => n + s.decaps, 0);
      const sa = fl.sas[fl.sas.length - 1];
      out.push(
        '',
        '   protected vrf: (none)',
        `   local  ident (addr/mask/prot/port): ${selText(fl.local)}`,
        `   remote ident (addr/mask/prot/port): ${selText(fl.remote)}`,
        `   current_peer ${fl.peer} port 500`,
        '     PERMIT, flags={origin_is_acl,}',
        `    #pkts encaps: ${enc}, #pkts encrypt: ${enc}, #pkts digest: ${enc}`,
        `    #pkts decaps: ${dec}, #pkts decrypt: ${dec}, #pkts verify: ${dec}`,
        '    #pkts compressed: 0, #pkts decompressed: 0',
        '    #pkts not compressed: 0, #pkts compr. failed: 0',
        '    #pkts not decompressed: 0, #pkts decompress failed: 0',
        '    #send errors 0, #recv errors 0',
        '',
        `     local crypto endpt.: ${sa?.localEndpoint ?? local}, remote crypto endpt.: ${sa?.remoteEndpoint ?? fl.peer}`,
        `     plaintext mtu ${sa ? 1438 : 1500}, path mtu 1500, ip mtu 1500, ip mtu idb ${ifName}`,
        `     current outbound spi: ${sa ? hex(sa.spiOut) : '0x0(0)'}`,
        `     PFS (Y/N): ${fl.entry?.pfsGroup !== undefined ? 'Y' : 'N'}, DH group: ${fl.entry?.pfsGroup !== undefined ? `group${fl.entry.pfsGroup}` : 'none'}`,
        '',
        '     inbound esp sas:',
      );
      if (sa) out.push(...saBlock(world, dev, sa, 'in', fl.entry, conn)); else out.push('');
      out.push('     inbound ah sas:', '', '     inbound pcp sas:', '', '     outbound esp sas:');
      if (sa) { out.push(...saBlock(world, dev, sa, 'out', fl.entry, conn + 1)); conn += 2; } else out.push('');
      out.push('     outbound ah sas:', '', '     outbound pcp sas:');
    }
  }
  return joinLines(out);
}

export function transformSets(dev: IosDevice): string {
  const out = ['Transform set default: { esp-aes esp-sha-hmac  } ', '   will negotiate = { Transport,  }, ', '   '];
  for (const t of dev.config.crypto.transformSets) {
    out.push(`Transform set ${t.name}: { ${transformText(t.transforms.join(' '))}  } `);
    out.push(`   will negotiate = { ${t.mode === 'tunnel' ? 'Tunnel' : 'Transport'},  }, `);
    out.push('   ');
  }
  return out.map((l) => l).join('\n');
}

// ───────────────────────────── crypto map ─────────────────────────────
function oldAddr(a: AddrMatch): string {
  if (a.kind === 'any') return 'any';
  if (a.kind === 'host') return `host ${a.address}`;
  return a.wildcard === '0.0.0.0' ? `host ${a.address}` : `${a.address} ${a.wildcard}`;
}
function oldPort(pm: PortMatch | undefined): string {
  if (!pm) return '';
  const sym: Record<string, string> = { eq: '=', neq: '!=', lt: '<', gt: '>' };
  if (pm.op === 'range') return ` range ${pm.ports[0]} ${pm.ports[1]}`;
  return ` port ${sym[pm.op]} ${pm.ports[0]}`;
}
const PNAME: Record<number, string> = { 1: 'icmp', 6: 'tcp', 17: 'udp', 47: 'gre', 50: 'esp', 51: 'ahp' };
function cryptoAceText(aclId: string, ace: Ace): string {
  const proto = typeof ace.protocol === 'number' ? PNAME[ace.protocol] ?? String(ace.protocol) : ace.protocol;
  return `access-list ${aclId} ${ace.action} ${proto} ${oldAddr(ace.src)}${oldPort(ace.srcPort)} ${oldAddr(ace.dst)}${oldPort(ace.dstPort)}`;
}
export function cryptoMap(world: World, dev: IosDevice, ifFilter?: string): string {
  const out: string[] = [];
  const S = '        ';
  for (const m of dev.config.crypto.maps) {
    const ifs = Object.keys(dev.config.interfaces).filter((n) => dev.config.interfaces[n].cryptoMap === m.name);
    if (ifFilter && !ifs.includes(ifFilter)) continue;
    for (const e of [...m.entries].sort((a, b) => a.seq - b.seq)) {
      out.push(`Crypto Map IPv4 "${m.name}" ${e.seq} ${e.type}`);
      if (e.description) out.push(`${S}Description: ${e.description}`);
      if (!e.peers.length) out.push(`${S}No matching address list set.`);
      for (const p of e.peers) out.push(`${S}Peer = ${p}`);
      const acl = e.matchAcl ? dev.config.acls[e.matchAcl] : undefined;
      if (e.matchAcl && acl) {
        out.push(`${S}${acl.type === 'standard' ? 'Standard' : 'Extended'} IP access list ${e.matchAcl}`);
        for (const ace of acl.entries) if (ace.action !== 'remark') out.push(`${S}    ${cryptoAceText(e.matchAcl, ace)}`);
      } else if (e.matchAcl) out.push(`${S}Extended IP access list ${e.matchAcl} (not defined)`);
      else out.push(`${S}No matching address list set.`);
      const sa = dev.runtime.ipsecSas.find((s) => s.mapName === m.name && s.seq === e.seq);
      out.push(`${S}Current peer: ${sa?.remoteEndpoint ?? e.peers[0] ?? '0.0.0.0'}`);
      out.push(`${S}Security association lifetime: ${e.saLifetimeKilobytes ?? 4608000} kilobytes/${e.saLifetimeSeconds ?? 3600} seconds`);
      out.push(`${S}Dualstack (Y/N): N`);
      out.push(`${S}Responder-Only (Y/N): N`);
      out.push(`${S}PFS (Y/N): ${e.pfsGroup !== undefined ? 'Y' : 'N'}`);
      if (e.pfsGroup !== undefined) out.push(`${S}DH group:  group${e.pfsGroup}`);
      out.push(`${S}Mixed-mode : Disabled`);
      out.push(`${S}Transform sets={ `);
      for (const name of e.transformSets) {
        const t = dev.config.crypto.transformSets.find((x) => x.name === name);
        out.push(`${S}${S}${name}:  { ${t ? transformText(t.transforms.join(' ')) : ''}  } , `);
      }
      out.push(`${S}}`);
      if (e.qosPreClassify) out.push(`${S}QOS pre-classification`);
      out.push('');
    }
    out.push(`${S}Interfaces using crypto map ${m.name}:`);
    for (const i of ifs) out.push(`${S}${S}${i}`);
    out.push('');
  }
  return joinLines(out);
}

// ───────────────────────────── crypto session ─────────────────────────────
function flowSide(x: Selector): string {
  const a = x.mask === '255.255.255.255' ? `host ${x.address}` : `${x.address}/${x.mask}`;
  return x.port ? `${a} port ${x.port}` : a;
}
export function cryptoSession(world: World, dev: IosDevice, detail: boolean): string {
  const out = ['Crypto session current status', ''];
  for (const ifName of cryptoIfaces(dev)) {
    const f = flowsFor(dev, ifName);
    if (!f) continue;
    const local = dev.config.interfaces[ifName].ip?.address ?? '0.0.0.0';
    const peers = [...new Set(f.flows.map((x) => x.peer))];
    for (const peer of peers) {
      const flows = f.flows.filter((x) => x.peer === peer);
      const ike = dev.runtime.ikeSas.find((s) => s.remote === peer && s.local === local);
      const active = flows.some((x) => x.sas.length > 0);
      const status = active ? 'UP-ACTIVE' : ike?.state === 'QM_IDLE' ? 'UP-IDLE' : 'DOWN';
      out.push(`Interface: ${ifName}`);
      if (detail) out.push(`Uptime: ${active ? '00:' + String(Math.floor((secondsAt(world.tick) % 3600) / 60)).padStart(2, '0') + ':' + String(secondsAt(world.tick) % 60).padStart(2, '0') : '00:00:00'}`);
      out.push(`Session status: ${padR(status, 14)}`);
      out.push(`Peer: ${peer} port 500 `);
      if (ike) {
        out.push('  Session ID: 0  ');
        out.push(`  IKEv1 SA: local ${local}/500 remote ${peer}/500 ${ike.state === 'QM_IDLE' ? 'Active' : 'Inactive'} `);
        if (detail) out.push(`          Capabilities:(none) connid:${connId(dev, ike)} lifetime:23:59:00`);
      }
      for (const fl of flows) {
        out.push(`  IPSEC FLOW: permit ${fl.local.protocol === 0 ? 'ip' : fl.local.protocol} ${flowSide(fl.local)} ${flowSide(fl.remote)} `);
        out.push(`        Active SAs: ${fl.sas.length * 2}, origin: crypto map`);
        if (detail) {
          const enc = fl.sas.reduce((n, s) => n + s.encaps, 0);
          const dec = fl.sas.reduce((n, s) => n + s.decaps, 0);
          out.push(`        Inbound:  #pkts dec'ed ${dec} drop 0 life (KB/Sec) ${fl.sas.length ? '4607999/3540' : '0/0'}`);
          out.push(`        Outbound: #pkts enc'ed ${enc} drop 0 life (KB/Sec) ${fl.sas.length ? '4607999/3540' : '0/0'}`);
        }
      }
      out.push('');
    }
  }
  return joinLines(out);
}
