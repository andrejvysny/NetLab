/**
 * System screens: show version, show clock, show history, show hosts, show arp / show ip arp, show cdp [neighbors [detail]],
 * show inventory, show platform, show flash:, show license, show aliases, show debugging, show privilege, show sessions.
 * CDP neighbours and ARP entries are derived from the cabling and the interface state (no protocol timers).
 */
import type { CliSession } from '../framework.ts';
import type { IosDevice, World } from '../../types.ts';
import { MODEL_INFO, networkLicenseFor } from '../../world.ts';
import { inSubnet, ipToInt } from '../../ip.ts';
import { interfaceState, l2Reach, linkInfo } from '../../sim/index.ts';
import { baseMac, cdpIfName, clockText, ifOrder, isEthernet, isL2, isPhysicalPort, jitter, joinLines, macOf, padL, padR, serialNo, uptimeSeconds, uptimeText } from './util.ts';

function up(world: World, deviceId: string, ifName: string): boolean {
  const s = interfaceState(world, deviceId, ifName);
  return s.status === 'up' && s.protocol === 'up';
}
function hasSerialNim(dev: IosDevice): boolean { return dev.ports.some((p) => p.kind === 'serial'); }

// ───────────────────────────── show version ─────────────────────────────
const GPL = [
  'Cisco IOS-XE software, Copyright (c) 2005-2021 by cisco Systems, Inc.',
  'All rights reserved.  Certain components of Cisco IOS-XE software are',
  'licensed under the GNU General Public License ("GPL") Version 2.0.  The',
  'software code licensed under GPL Version 2.0 is free software that comes',
  'with ABSOLUTELY NO WARRANTY.  You can redistribute and/or modify such',
  'GPL code under the terms of GPL Version 2.0.  For more details, see the',
  'documentation or "License Notice" file accompanying the IOS-XE software,',
  'or the applicable URL provided on the flyer accompanying the IOS-XE',
  'software.',
];
const CRYPTO_NOTICE = [
  'This product contains cryptographic features and is subject to United',
  'States and local country laws governing import, export, transfer and',
  'use. Delivery of Cisco cryptographic products does not imply',
  'third-party authority to import, export, distribute or use encryption.',
  'Importers, exporters, distributors and users are responsible for',
  'compliance with U.S. and local country laws. By using this product you',
  'agree to comply with applicable laws and regulations. If you are unable',
  'to comply with U.S. and local laws, return this product immediately.',
  '',
  'A summary of U.S. laws governing Cisco cryptographic products may be found at:',
  'http://www.cisco.com/wwl/export/crypto/tool/stqrg.html',
  '',
  'If you require further assistance please contact us by sending email to',
  'export@cisco.com.',
];
export function routerVersionLine(): string {
  return 'Cisco IOS Software [Amsterdam], ISR Software (X86_64_LINUX_IOSD-UNIVERSALK9-M), Version 17.3.4a, RELEASE SOFTWARE (fc3)';
}
export function switchVersionLine(): string {
  return 'Cisco IOS Software [Amsterdam], Catalyst L3 Switch Software (CAT9K_IOSXE), Version 17.3.4, RELEASE SOFTWARE (fc3)';
}
export function showVersion(world: World, dev: IosDevice): string {
  const up = uptimeText(uptimeSeconds(world));
  const upCp = uptimeText(uptimeSeconds(world) + 130);
  const host = dev.config.hostname;
  const reg = dev.config.extraLines.find((l) => /^config-register\s/.test(l))?.split(/\s+/)[1];
  if (dev.kind === 'router') {
    const gi = dev.ports.filter((p) => p.kind === 'ethernet').length;
    const se = dev.ports.filter((p) => p.kind === 'serial').length;
    const sec = dev.config.extraLines.some((l) => /^license boot level securityk9/.test(l));
    const out = [
      `Cisco IOS XE Software, Version ${MODEL_INFO.isr4331.ios}`,
      routerVersionLine(),
      'Technical Support: http://www.cisco.com/techsupport',
      'Copyright (c) 1986-2021 by Cisco Systems, Inc.',
      'Compiled Tue 20-Jul-21 04:59 by mcpre',
      '', '', ...GPL, '', '',
      'ROM: 16.7(5r)',
      '',
      `${host} uptime is ${up}`,
      `Uptime for this control processor is ${upCp}`,
      'System returned to ROM by Reload Command',
      `System image file is "bootflash:${MODEL_INFO.isr4331.image}"`,
      'Last reload reason: Reload Command',
      '', '', '', ...CRYPTO_NOTICE, '', '', '',
      'Technology Package License Information: ',
      '',
      '-----------------------------------------------------------------',
      'Technology    Type         Technology-package   Technology-package',
      '                           Current              Next Reboot  ',
      '------------------------------------------------------------------',
      'appxk9           Smart License    None                 None',
      'uck9             Smart License    None                 None',
      `securityk9       Smart License    securityk9           ${sec ? 'securityk9' : 'securityk9'}`,
      'ipbase           Smart License    ipbasek9             ipbasek9',
      '',
      'The current crypto throughput level is 250000 kbps ',
      '', '',
      'Smart Licensing Status: Smart Licensing Using Policy',
      '',
      'cisco ISR4331/K9 (1RU) processor with 1795999K/6147K bytes of memory.',
      `Processor board ID ${serialNo(world, dev.id, 'chassis')}`,
      'Router operating mode: Autonomous',
      `${gi} Gigabit Ethernet interfaces`,
    ];
    if (se) out.push(`${se} Serial interfaces`);
    out.push(
      '32768K bytes of non-volatile configuration memory.',
      '4194304K bytes of physical memory.',
      '3207167K bytes of flash memory at bootflash:.',
      '',
      `Configuration register is ${reg ?? '0x2102'}`,
    );
    return joinLines(out);
  }
  const mac = baseMac(world, dev.id).replace(/\./g, '').replace(/(..)(?=.)/g, '$1:');
  const networkLicense = networkLicenseFor(dev);
  const advantage = networkLicense === 'network-advantage';
  const sn = serialNo(world, dev.id, 'chassis', 'FOC');
  const gi = dev.ports.filter((p) => p.kind === 'ethernet').length;
  const out = [
    `Cisco IOS XE Software, Version ${MODEL_INFO.c9300l.ios}`,
    switchVersionLine(),
    'Technical Support: http://www.cisco.com/techsupport',
    'Copyright (c) 1986-2021 by Cisco Systems, Inc.',
    'Compiled Fri 18-Jun-21 04:39 by mcpre',
    '', '', ...GPL, '', '',
    'ROM: IOS-XE ROMMON',
    'BOOTLDR: System Bootstrap, Version 17.3.2r, RELEASE SOFTWARE (P)',
    '',
    `${host} uptime is ${up}`,
    `Uptime for this control processor is ${upCp}`,
    'System returned to ROM by Reload Command',
    'System image file is "flash:packages.conf"',
    'Last reload reason: Reload Command',
    '', '', '', ...CRYPTO_NOTICE, '', '', '',
    'Technology Package License Information: ',
    '',
    '------------------------------------------------------------------------------',
    'Technology-package                                     Technology-package',
    'Current                        Type                       Next reboot  ',
    '------------------------------------------------------------------------------',
    `${networkLicense}      Smart License                 ${networkLicense}`,
    ...(advantage ? ['dna-advantage          Subscription Smart License    dna-advantage',
      'AIR License Level: AIR DNA Advantage', 'Next reload AIR license Level: AIR DNA Advantage'] : []),
    '',
    `Classroom profile: ${advantage ? 'Network Advantage' : 'Network Essentials'} (modeled entitlement)`,
    '',
    'Smart Licensing Status: Smart Licensing Using Policy',
    '',
    'cisco C9300L-24T-4G (X86) processor with 1338934K/6147K bytes of memory.',
    `Processor board ID ${sn}`,
    'Running SMU Patch Level: none',
    '1 Virtual Ethernet interface',
    `${gi} Gigabit Ethernet interfaces`,
    '2048K bytes of non-volatile configuration memory.',
    '8388608K bytes of physical memory.',
    '1638400K bytes of Crash Files at crashinfo:.',
    '11264000K bytes of Flash at flash:.',
    '',
    `Base Ethernet MAC Address          : ${mac}`,
    'Motherboard Assembly Number        : 73-19405-03',
    `Motherboard Serial Number          : ${serialNo(world, dev.id, 'mb', 'FOC')}`,
    'Model Revision Number              : A0',
    'Motherboard Revision Number        : A0',
    'Model Number                       : C9300L-24T-4G',
    `System Serial Number               : ${sn}`,
    'CLEI Code Number                   : ',
    '', '',
    'Switch Ports Model              SW Version        SW Image              Mode   ',
    '------ ----- -----              ----------        ----------            ----   ',
    `*    1 ${gi}    C9300L-24T-4G      ${MODEL_INFO.c9300l.ios}          CAT9K_IOSXE           INSTALL`,
    '', '',
    `Configuration register is ${reg ?? '0x102'}`,
  ];
  return joinLines(out);
}

export function showClock(world: World, dev: IosDevice, detail: boolean): string {
  const t = clockText(dev, world);
  return detail ? `${t}\nNo time source` : t;
}
export function showHistory(s: CliSession): string {
  return s.history.slice(-20).map((l) => `  ${l}`).join('\n');
}

export function showHosts(dev: IosDevice): string {
  const cfg = dev.config;
  const dn = cfg.extraLines.find((l) => l.startsWith('ip domain name '))?.slice('ip domain name '.length);
  const ns = cfg.extraLines.find((l) => l.startsWith('ip name-server '))?.slice('ip name-server '.length);
  const out = [
    'Name lookup view: Global',
    dn ? `Default domain is ${dn}` : 'Default domain is not set',
    cfg.ipDomainLookup ? 'Name/address lookup uses domain service' : 'Name/address lookup uses static mappings',
    `Name servers are ${ns ?? '255.255.255.255'}`,
    '',
    'Codes: UN - unknown, EX - expired, OK - OK, ?? - revalidate',
    '       temp - temporary, perm - permanent',
    '       NA - Not Applicable None - Not defined',
    '',
    'Host                      Port  Flags      Age Type   Address(es)',
  ];
  for (const l of cfg.extraLines) {
    const m = /^ip host (\S+)\s+(.*)$/.exec(l);
    if (!m) continue;
    const rest = m[2].split(/\s+/).filter((x) => /^\d+\.\d+\.\d+\.\d+$/.test(x));
    out.push(`${padR(m[1], 25)} ${padR('None', 5)} ${padR('(perm, OK)', 10)} ${padL(0, 3)} ${padR('IP', 6)} ${rest.join(' ')}`);
  }
  return joinLines(out);
}

// ───────────────────────────── ARP ─────────────────────────────
interface ArpRow { addr: string; age: string; mac: string; iface: string }
export function arpRows(world: World, dev: IosDevice): ArpRow[] {
  const rows: ArpRow[] = [];
  for (const name of ifOrder(dev)) {
    const ifc = dev.config.interfaces[name];
    if (!ifc.ip || isL2(dev, name) || !(isEthernet(name) || name.startsWith('Vlan'))) continue;
    if (!up(world, dev.id, name)) continue;
    const mine = macOf(world, dev.id, name) ?? '0000.0000.0000';
    rows.push({ addr: ifc.ip.address, age: '-', mac: mine, iface: name });
    for (const s of ifc.secondary ?? []) rows.push({ addr: s.address, age: '-', mac: mine, iface: name });
    for (const ep of l2Reach(world, dev.id, name)) {
      const d = world.devices[ep.deviceId];
      if (!d || !up(world, ep.deviceId, ep.ifName)) continue;
      const mac = macOf(world, ep.deviceId, ep.ifName);
      if (!mac) continue;
      const addrs: string[] = [];
      if (d.kind === 'pc') { if (d.nic.address) addrs.push(d.nic.address); }
      else {
        const c = d.config.interfaces[ep.ifName];
        if (c?.ip && !isL2(d, ep.ifName)) addrs.push(c.ip.address, ...(c.secondary ?? []).map((x) => x.address));
      }
      for (const a of addrs) {
        if (!inSubnet(a, ifc.ip.address, ifc.ip.mask)) continue;
        rows.push({ addr: a, age: String(jitter(a, world.tick, 0, 3)), mac, iface: name });
      }
    }
  }
  return rows.sort((a, b) => ipToInt(a.addr) - ipToInt(b.addr));
}
export function showArp(world: World, dev: IosDevice, filter?: { addr?: string; iface?: string }): string {
  const out = ['Protocol  Address          Age (min)  Hardware Addr   Type   Interface'];
  for (const r of arpRows(world, dev)) {
    if (filter?.addr && r.addr !== filter.addr) continue;
    if (filter?.iface && r.iface !== filter.iface) continue;
    out.push(`Internet  ${padR(r.addr, 15)}${padL(r.age, 11)}  ${padR(r.mac, 14)}  ARPA   ${r.iface}`);
  }
  return joinLines(out);
}

// ───────────────────────────── CDP ─────────────────────────────
export function cdpEnabled(dev: IosDevice): boolean { return !dev.config.extraLines.includes('no cdp run'); }
interface CdpNeighbor { local: string; peerId: string; peerIf: string; peer: IosDevice; hold: number }
export function cdpNeighbors(world: World, dev: IosDevice): CdpNeighbor[] {
  const out: CdpNeighbor[] = [];
  for (const name of ifOrder(dev)) {
    if (!isPhysicalPort(dev, name) || !up(world, dev.id, name)) continue;
    if ((dev.config.interfaces[name].extraLines ?? []).includes('no cdp enable')) continue;
    const link = linkInfo(world, { deviceId: dev.id, port: name });
    if (!link.usable || !link.peer) continue;
    const peer = world.devices[link.peer.deviceId];
    if (!peer || peer.kind === 'pc' || !cdpEnabled(peer)) continue;
    if ((peer.config.interfaces[link.peer.port]?.extraLines ?? []).includes('no cdp enable')) continue;
    if (!up(world, peer.id, link.peer.port)) continue;
    const dn = peer.config.extraLines.find((l) => l.startsWith('ip domain name '))?.slice('ip domain name '.length);
    out.push({ local: name, peerId: dn ? `${peer.config.hostname}.${dn}` : peer.config.hostname, peerIf: link.peer.port, peer, hold: jitter(peer.id + name, world.tick, 121, 179) });
  }
  return out;
}
const CDP_CODES = [
  'Capability Codes: R - Router, T - Trans Bridge, B - Source Route Bridge',
  '                  S - Switch, H - Host, I - IGMP, r - Repeater, P - Phone, ',
  '                  D - Remote, C - CVTA, M - Two-port Mac Relay ',
  '',
];
function platformOf(d: IosDevice): { short: string; long: string; caps: string; capWords: string } {
  return d.kind === 'router'
    ? { short: 'ISR4331/K', long: 'cisco ISR4331/K9', caps: 'R B S I', capWords: 'Router Source-Route-Bridge Switch IGMP' }
    : { short: 'C9300L-24', long: 'cisco C9300L-24T-4G', caps: 'S I', capWords: 'Switch IGMP' };
}
export function showCdpNeighbors(world: World, dev: IosDevice, onlyIf?: string): string {
  if (!cdpEnabled(dev)) return '% CDP is not enabled';
  const out = [...CDP_CODES, 'Device ID        Local Intrfce     Holdtme    Capability  Platform  Port ID'];
  const list = cdpNeighbors(world, dev).filter((n) => !onlyIf || n.local === onlyIf);
  for (const n of list) {
    const p = platformOf(n.peer);
    const rest = `${padR(cdpIfName(n.local), 18)}${padR(n.hold, 3)}${padL(p.caps, 20)} ${padR(p.short, 9)} ${cdpIfName(n.peerIf)}`;
    if (n.peerId.length > 16) out.push(n.peerId, `${' '.repeat(17)}${rest}`);
    else out.push(`${padR(n.peerId, 17)}${rest}`);
  }
  out.push('', `Total cdp entries displayed : ${list.length}`);
  return joinLines(out);
}
function mgmtAddress(world: World, d: IosDevice, ifName: string): string | undefined {
  const c = d.config.interfaces[ifName];
  if (c?.ip && !isL2(d, ifName)) return c.ip.address;
  // switches advertise the address of an SVI
  for (const n of ifOrder(d)) {
    const x = d.config.interfaces[n];
    if (n.startsWith('Vlan') && x.ip && up(world, d.id, n)) return x.ip.address;
  }
  return undefined;
}
export function showCdpDetail(world: World, dev: IosDevice, onlyIf?: string): string {
  if (!cdpEnabled(dev)) return '% CDP is not enabled';
  const out: string[] = [];
  const list = cdpNeighbors(world, dev).filter((n) => !onlyIf || n.local === onlyIf);
  for (const n of list) {
    const p = platformOf(n.peer);
    const ip = mgmtAddress(world, n.peer, n.peerIf);
    out.push('-------------------------', `Device ID: ${n.peerId}`, 'Entry address(es): ');
    if (ip) out.push(`  IP address: ${ip}`);
    out.push(`Platform: ${p.long},  Capabilities: ${p.capWords} `);
    out.push(`Interface: ${n.local},  Port ID (outgoing port): ${n.peerIf}`);
    out.push(`Holdtime : ${n.hold} sec`, '', 'Version :');
    out.push(n.peer.kind === 'router' ? routerVersionLine() : switchVersionLine());
    out.push('Technical Support: http://www.cisco.com/techsupport', 'Copyright (c) 1986-2021 by Cisco Systems, Inc.',
      n.peer.kind === 'router' ? 'Compiled Tue 20-Jul-21 04:59 by mcpre' : 'Compiled Fri 18-Jun-21 04:39 by mcpre', '');
    out.push('advertisement version: 2');
    if (n.peer.kind === 'switch') {
      out.push(`Peer Source MAC: ${macOf(world, n.peer.id, n.peerIf) ?? ''}`);
      out.push("VTP Management Domain: ''", 'Native VLAN: 1');
    }
    if (isEthernet(n.local)) out.push('Duplex: full');
    out.push('Management address(es): ');
    if (ip) out.push(`  IP address: ${ip}`);
    out.push('', '');
  }
  out.push(`Total cdp entries displayed : ${list.length}`);
  return joinLines(out);
}
export function showCdp(dev: IosDevice): string {
  if (!cdpEnabled(dev)) return '% CDP is not enabled';
  return joinLines(['Global CDP information:', '\tSending CDP packets every 60 seconds', '\tSending a holdtime value of 180 seconds', '\tSending CDPv2 advertisements is  enabled']);
}

// ───────────────────────────── hardware ─────────────────────────────
export function showInventory(world: World, dev: IosDevice): string {
  const item = (name: string, descr: string, pid: string, vid: string, sn: string) =>
    [`NAME: "${name}", DESCR: "${descr}"`, `PID: ${padR(pid, 18)}, VID: ${padR(vid, 4)} , SN: ${sn}`, ''];
  if (dev.kind === 'router') {
    const out = [
      ...item('Chassis', 'Cisco ISR4331 Chassis', 'ISR4331/K9', 'V04', serialNo(world, dev.id, 'chassis')),
      ...item('Power Supply Module 0', '250W AC Power Supply for Cisco ISR 4330', 'PWR-4330-AC', 'V02', serialNo(world, dev.id, 'psu', 'PST')),
      ...item('Fan Tray', 'Cisco ISR4330 Fan Assembly', 'ACS-4330-FANASSY', '', ''),
      ...item('module 0', 'Cisco ISR4331 Built-In NIM controller', 'ISR4331/K9', '', ''),
      ...item('NIM subslot 0/0', 'Front Panel 3 ports Gigabitethernet Module', 'ISR4331-3x1GE', 'V01', ''),
    ];
    if (hasSerialNim(dev)) out.push(...item('NIM subslot 0/1', 'NIM-2T Dual Port Serial WAN Interface card', 'NIM-2T', 'V03', serialNo(world, dev.id, 'nim', 'FOC')));
    out.push(
      ...item('module R0', 'Cisco ISR4331 Route Processor', 'ISR4331/K9', 'V04', serialNo(world, dev.id, 'rp', 'FOC')),
      ...item('module F0', 'Cisco ISR4331 Forwarding Processor', 'ISR4331/K9', '', ''),
    );
    return joinLines(out);
  }
  return joinLines([
    ...item('c93xx Stack', 'c93xx Stack', 'C9300L-24T-4G', 'V02', serialNo(world, dev.id, 'chassis', 'FOC')),
    ...item('Switch 1', 'C9300L-24T-4G', 'C9300L-24T-4G', 'V02', serialNo(world, dev.id, 'chassis', 'FOC')),
    ...item('Switch 1 - Power Supply A', 'Switch 1 - Power Supply A', 'PWR-C5-125WAC', 'V02', serialNo(world, dev.id, 'psu', 'DTN')),
    ...item('Switch 1 FRU Uplink Module 1', '4x1G Uplink Module', 'C9300L-24T-4G', 'V02', ''),
  ]);
}
export function showPlatform(world: World, dev: IosDevice): string {
  const ago = (extra: number) => {
    const s = Math.max(0, uptimeSeconds(world) - extra);
    return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };
  const row = (slot: string, type: string, state: string, t: string) => `${padR(slot, 9)} ${padR(type, 19)} ${padR(state, 21)} ${t}`;
  const out = [
    'Chassis type: ISR4331/K9          ', '',
    'Slot      Type                State                 Insert time (ago) ',
    '--------- ------------------- --------------------- ----------------- ',
    row('0', 'ISR4331/K9', 'ok', ago(0)),
    row(' 0/0', 'ISR4331-3x1GE', 'ok', ago(70)),
  ];
  if (hasSerialNim(dev)) out.push(row(' 0/1', 'NIM-2T', 'ok', ago(70)));
  out.push(row('R0', 'ISR4331/K9', 'ok, active', ago(0)), row('F0', 'ISR4331-FP', 'ok, active', ago(0)),
    row('P0', 'PWR-4330-AC', 'ok', ago(25)), row('P2', 'ACS-4330-FANASSY', 'ok', ago(25)), '',
    'Slot      CPLD Version        Firmware Version                        ',
    '--------- ------------------- --------------------------------------- ',
    `${padR('0', 9)} ${padR('17100927', 19)} 16.7(5r)`, `${padR('R0', 9)} ${padR('17100927', 19)} 16.7(5r)`, `${padR('F0', 9)} ${padR('17100927', 19)} 16.7(5r)`);
  return joinLines(out);
}
export function showFlash(dev: IosDevice): string {
  if (dev.kind === 'router') {
    return joinLines([
      '-#- --length-- ---------date/time--------- path',
      '1          4096 May 11 2026 09:14:02 +00:00 /bootflash/',
      '2         16384 Jan 20 2026 10:05:11 +00:00 /bootflash/lost+found',
      '3          4096 May 18 2026 08:01:37 +00:00 /bootflash/tracelogs',
      '4     467568640 Jan 20 2026 10:20:01 +00:00 /bootflash/isr4300-universalk9.17.03.04a.SPA.bin',
      '5          1863 May 18 2026 08:00:58 +00:00 /bootflash/pnp-tech-time',
      '',
      '6730813440 bytes available (546553856 bytes used)',
    ]);
  }
  return joinLines([
    '-#- --length-- ---------date/time--------- path',
    '1          4096 May 18 2026 08:01:12 +00:00 /flash/',
    '2         16384 Jan 20 2026 09:58:40 +00:00 /flash/lost+found',
    '3          6851 Jan 20 2026 10:11:03 +00:00 /flash/packages.conf',
    '4     447452076 Jan 20 2026 10:10:45 +00:00 /flash/cat9k-rpbase.17.03.04.SPA.pkg',
    '5          1987 May 18 2026 08:00:58 +00:00 /flash/vlan.dat',
    '',
    '10196316160 bytes available (1197338624 bytes used)',
  ]);
}
export function showLicense(dev: IosDevice): string {
  if (dev.kind === 'router') {
    return joinLines([
      'License Usage:',
      '  License                 Entitlement Tag               Count Status',
      '  -----------------------------------------------------------------------------',
      '                          (ISR_4331_Security)               1 IN USE',
      '                          (ISR_4331_Foundation)             1 IN USE',
    ]);
  }
  const license = networkLicenseFor(dev);
  const advantage = license === 'network-advantage';
  return joinLines([
    'License Usage:',
    '  License                 Entitlement Tag               Count Status',
    '  -----------------------------------------------------------------------------',
    `  ${license}       (C9300L-24 ${advantage ? 'Network Advantage' : 'Network Essentials'})      1 IN USE`,
    ...(advantage ? ['  dna-advantage           (C9300L-24 DNA Advantage)         1 IN USE'] : []),
  ]);
}

const DEFAULT_ALIASES: [string, string][] = [['h', 'help'], ['lo', 'logout'], ['p', 'ping'], ['r', 'resume'], ['s', 'show'], ['u', 'undebug'], ['un', 'undebug'], ['w', 'where']];
export function showAliases(dev: IosDevice, mode?: string): string {
  const out: string[] = [];
  const sections: [string, string][] = [['exec', 'Exec mode aliases:'], ['configure', 'Global configuration mode aliases:'], ['interface', 'Interface configuration mode aliases:']];
  for (const [m, title] of sections) {
    if (mode && m !== mode) continue;
    const mine = dev.config.aliases.filter((a) => a.mode === m).map((a) => [a.name, a.command] as [string, string]);
    const list = m === 'exec' ? [...DEFAULT_ALIASES.filter(([n]) => !mine.some(([x]) => x === n)), ...mine] : mine;
    if (!list.length) continue;
    out.push(title);
    for (const [n, c] of list) out.push(`  ${padR(n, 22)}${c}`);
    out.push('');
  }
  return joinLines(out);
}

export function showDebugging(): string {
  return joinLines(['IOSXE Conditional Debug Configs:', '', 'Conditional Debug Global State: Stop', '', 'IOSXE Packet Tracing Configs:', '', '', '',
    'Packet Infra debugs:', '', 'Ip Address                                               Port',
    '------------------------------------------------------|----------', '']);
}
