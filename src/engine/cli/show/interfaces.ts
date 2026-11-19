/**
 * Interface verification screens: show ip interface brief, show interfaces [<if>] [status|description|trunk],
 * show ip interface [<if>], show controllers [<if>], show vlan brief, show mac address-table, show protocols.
 * Live state comes from the simulation (interfaceState, linkInfo, serialClock, l2Reach); packet counters from runtime.ifCounters.
 */
import { natRoleOn } from '../../natProfile.ts';
import type { InterfaceConfig, IosDevice, World } from '../../types.ts';
import { bandwidthKbps, interfaceState, l2Reach, linkInfo, serialClock } from '../../sim/index.ts';
import { ifOrder, isEthernet, isL2, isPhysicalPort, isSerial, jitter, joinLines, macOf, padL, padR } from './util.ts';
import { maskToPrefix, shortIfName } from '../../ip.ts';
import { ethernetMedium } from '../../world.ts';

/** 'up' / 'down' / 'administratively down' and the line-protocol word, as IOS prints them. */
export function stateOf(world: World, dev: IosDevice, name: string): { status: string; protocol: string; up: boolean } {
  const s = interfaceState(world, dev.id, name);
  return { status: s.status, protocol: s.protocol, up: s.status === 'up' && s.protocol === 'up' };
}

/** Method column of show ip interface brief. */
function method(ifc: InterfaceConfig): string {
  if ((ifc.extraLines ?? []).some((l) => /^ip address dhcp/.test(l.trim()))) return 'DHCP';
  if (ifc.ip) return 'manual';
  return 'unset';
}

export function ipInterfaceBrief(world: World, dev: IosDevice): string {
  const out = ['Interface              IP-Address      OK? Method Status                Protocol'];
  for (const name of ifOrder(dev)) {
    const ifc = dev.config.interfaces[name];
    const st = stateOf(world, dev, name);
    const ip = ifc.ip && !isL2(dev, name) ? ifc.ip.address : 'unassigned';
    out.push(`${padR(name, 22)} ${padR(ip, 15)} YES ${padR(method(ifc), 6)} ${padR(st.status, 21)} ${st.protocol}`);
  }
  return joinLines(out);
}

// ───────────────────────────── show interfaces ─────────────────────────────
function hasQueueingPolicy(dev: IosDevice, ifc: InterfaceConfig): boolean {
  const pm = dev.config.qos.policyMaps.find((p) => p.name === ifc.servicePolicyOut);
  if (!pm) return false;
  const queueing = (name: string | undefined, depth: number): boolean => {
    const p = dev.config.qos.policyMaps.find((x) => x.name === name);
    if (!p || depth > 3) return false;
    return p.classes.some((c) => c.priority || c.bandwidth || c.fairQueue || c.shapeAverage || c.queueLimit !== undefined || queueing(c.servicePolicy, depth + 1));
  };
  return queueing(pm.name, 0);
}

function headerLine(world: World, dev: IosDevice, name: string): string {
  const st = stateOf(world, dev, name);
  let line = `${name} is ${st.status}, line protocol is ${st.protocol}`;
  if (dev.kind === 'switch' && isPhysicalPort(dev, name)) {
    line += st.status === 'administratively down' ? ' (disabled)' : st.up ? ' (connected)' : ' (notconnect)';
  }
  if (name.startsWith('Vlan')) line += ' , Autostate Enabled';
  return line;
}

function mediaText(dev: IosDevice, name: string): string {
  const p = dev.ports.find((port) => port.name === name);
  if (p && ethernetMedium(p, dev.config.interfaces[name]) === 'sfp') return 'SFP (not installed)';
  return dev.kind === 'switch' ? '10/100/1000BaseTX' : 'RJ45';
}

function speedDuplex(dev: IosDevice, name: string, up: boolean): string | null {
  const ifc = dev.config.interfaces[name];
  if (!isEthernet(name)) return null;
  const media = mediaText(dev, name);
  if (media.startsWith('SFP')) return `  media type is ${media}`;
  const dup = ifc.duplex && ifc.duplex !== 'auto' ? ifc.duplex : undefined;
  const spd = ifc.speed && ifc.speed !== 'auto' ? ifc.speed : undefined;
  if (dev.kind === 'switch') {
    const d = dup ? `${dup[0].toUpperCase()}${dup.slice(1)}-duplex` : up ? 'Full-duplex' : 'Auto-duplex';
    const s = spd ? `${spd}Mb/s` : up ? '1000Mb/s' : 'Auto-speed';
    return `  ${d}, ${s}, media type is ${media}`;
  }
  const d = dup ? `${dup[0].toUpperCase()}${dup.slice(1)} Duplex` : up ? 'Full Duplex' : 'Auto Duplex';
  const s = spd ? `${spd}Mbps` : up ? '1000Mbps' : 'Auto Speed';
  return `  ${d}, ${s}, link type is ${spd || dup ? 'force-up' : 'auto'}, media type is ${media}`;
}

function hardwareLine(world: World, dev: IosDevice, name: string): string {
  const mac = macOf(world, dev.id, name);
  const addr = mac ? `, address is ${mac} (bia ${mac})` : '';
  if (name.startsWith('Loopback')) return '  Hardware is Loopback';
  if (name.startsWith('Vlan')) return `  Hardware is Ethernet SVI${addr}`;
  if (isSerial(name)) return '  Hardware is NIM-2T';
  if (dev.kind === 'switch') return `  Hardware is Gigabit Ethernet${addr}`;
  return `  Hardware is ISR4331-3x1GE${addr}`;
}

function lastIo(world: World, key: string, count: number): string {
  if (count <= 0) return 'never';
  return `00:00:${String(jitter(key, world.tick, 0, 9)).padStart(2, '0')}`;
}

/** One `show interfaces` block. */
export function interfaceBlock(world: World, dev: IosDevice, name: string): string {
  const ifc = dev.config.interfaces[name];
  const st = stateOf(world, dev, name);
  const loop = name.startsWith('Loopback');
  const vlan = name.startsWith('Vlan');
  const serial = isSerial(name);
  const out: string[] = [headerLine(world, dev, name), hardwareLine(world, dev, name)];
  if (ifc.description) out.push(`  Description: ${ifc.description}`);
  if (ifc.ip && !isL2(dev, name)) out.push(`  Internet address is ${ifc.ip.address}/${maskToPrefix(ifc.ip.mask)}`);
  const bw = bandwidthKbps(ifc, name);
  const dly = loop ? 5000 : serial ? 20000 : 10;
  out.push(`  MTU ${loop ? 1514 : 1500} bytes, BW ${bw} Kbit/sec, DLY ${dly} usec, `);
  out.push('     reliability 255/255, txload 1/255, rxload 1/255');
  if (loop) out.push('  Encapsulation LOOPBACK, loopback not set');
  else if (serial) {
    if (ifc.encapsulation === 'ppp') out.push(`  Encapsulation PPP, LCP ${st.up ? 'Open' : 'Closed'}, loopback not set`);
    else out.push('  Encapsulation HDLC, crc 16, loopback not set');
  } else out.push('  Encapsulation ARPA, loopback not set');
  if (serial || loop || dev.kind === 'switch' && !vlan) out.push('  Keepalive set (10 sec)');
  else out.push('  Keepalive not supported ');
  if (serial && ifc.encapsulation === 'ppp' && st.up) out.push('  Open: IPCP, CDPCP');
  const sd = speedDuplex(dev, name, st.up);
  if (sd) {
    out.push(sd);
    out.push(dev.kind === 'switch' ? '  input flow-control is on, output flow-control is unsupported ' : '  output flow-control is off, input flow-control is off');
  }
  if (isEthernet(name) || vlan) out.push('  ARP type: ARPA, ARP Timeout 04:00:00');
  const c = dev.runtime.ifCounters[name] ?? { in: 0, out: 0 };
  out.push(`  Last input ${lastIo(world, name + 'i', c.in)}, output ${lastIo(world, name + 'o', c.out)}, output hang never`);
  out.push('  Last clearing of "show interface" counters never');
  const inMax = loop ? 75 : dev.kind === 'switch' && !vlan ? 2000 : 375;
  out.push(`  Input queue: 0/${inMax}/0/0 (size/max/drops/flushes); Total output drops: 0`);
  out.push(`  Queueing strategy: ${hasQueueingPolicy(dev, ifc) ? 'Class-based queueing' : 'fifo'}`);
  out.push(`  Output queue: 0/${loop ? 0 : 40} (size/max)`);
  out.push('  5 minute input rate 0 bits/sec, 0 packets/sec');
  out.push('  5 minute output rate 0 bits/sec, 0 packets/sec');
  out.push(`     ${c.in} packets input, ${c.in * 100} bytes, 0 no buffer`);
  out.push('     Received 0 broadcasts (0 IP multicasts)');
  out.push('     0 runts, 0 giants, 0 throttles ');
  out.push(`     0 input errors, 0 CRC, 0 frame, 0 overrun, 0 ignored${serial || loop ? ', 0 abort' : ''}`);
  if (isEthernet(name)) out.push('     0 watchdog, 0 multicast, 0 pause input');
  out.push(`     ${c.out} packets output, ${c.out * 100} bytes, 0 underruns`);
  out.push('     Output 0 broadcasts (0 IP multicasts)');
  out.push('     0 output errors, 0 collisions, 0 interface resets');
  out.push('     0 unknown protocol drops');
  if (isEthernet(name)) {
    out.push('     0 babbles, 0 late collision, 0 deferred');
    out.push(`     ${st.up ? 0 : 1} lost carrier, 0 no carrier, 0 pause output`);
  }
  out.push('     0 output buffer failures, 0 output buffers swapped out');
  if (serial) {
    const link = linkInfo(world, { deviceId: dev.id, port: name });
    out.push(`     ${st.up ? 1 : 0} carrier transitions`);
    if (!link.cabled || !link.usable) out.push('     DCD=down  DSR=down  DTR=down  RTS=down  CTS=down');
    else if (st.up || st.protocol === 'down' && st.status === 'up') out.push('     DCD=up  DSR=up  DTR=up  RTS=up  CTS=up');
    else out.push(`     DCD=down  DSR=down  DTR=${ifc.shutdown ? 'down' : 'up'}  RTS=${ifc.shutdown ? 'down' : 'up'}  CTS=down`);
  }
  return joinLines(out);
}

export function showInterfaces(world: World, dev: IosDevice, only?: string): string {
  const names = only ? [only] : ifOrder(dev);
  return names.map((n) => interfaceBlock(world, dev, n)).join('\n');
}

export function interfacesDescription(world: World, dev: IosDevice): string {
  const out = [`${padR('Interface', 30)} ${padR('Status', 14)} ${padR('Protocol', 8)} Description`];
  for (const name of ifOrder(dev)) {
    const st = stateOf(world, dev, name);
    const ifc = dev.config.interfaces[name];
    out.push(`${padR(shortIfName(name), 30)} ${padR(st.status === 'administratively down' ? 'admin down' : st.status, 14)} ${padR(st.protocol, 8)} ${ifc.description ?? ''}`);
  }
  return joinLines(out);
}

// ───────────────────────────── show ip interface ─────────────────────────────
function aclLine(word: string, acl: string | undefined): string {
  return `  ${word} access list is ${acl ?? 'not set'}`;
}
export function ipInterfaceBlock(world: World, dev: IosDevice, name: string): string {
  const ifc = dev.config.interfaces[name];
  const st = stateOf(world, dev, name);
  const out: string[] = [`${name} is ${st.status}, line protocol is ${st.protocol}`];
  if (!ifc.ip || isL2(dev, name)) {
    out.push('  Internet protocol processing disabled');
    return joinLines(out);
  }
  out.push(`  Internet address is ${ifc.ip.address}/${maskToPrefix(ifc.ip.mask)}`);
  out.push('  Broadcast address is 255.255.255.255');
  out.push('  Address determined by setup command');
  out.push(`  MTU is ${name.startsWith('Loopback') ? 1514 : 1500} bytes`);
  const helpers = ifc.helperAddresses ?? [];
  if (helpers.length === 0) out.push('  Helper address is not set');
  else if (helpers.length === 1) out.push(`  Helper address is ${helpers[0]}`);
  else {
    out.push(`  Helper addresses are ${helpers[0]}`);
    for (const h of helpers.slice(1)) out.push(`                       ${h}`);
  }
  out.push('  Directed broadcast forwarding is disabled');
  for (const s of ifc.secondary ?? []) out.push(`  Secondary address ${s.address}/${maskToPrefix(s.mask)}`);
  out.push('  Outgoing Common access list is not set ');
  out.push(aclLine('Outgoing', ifc.aclOut));
  out.push('  Inbound Common access list is not set ');
  out.push(aclLine('Inbound ', ifc.aclIn));
  out.push(`  Proxy ARP is ${(ifc.extraLines ?? []).includes('no ip proxy-arp') ? 'disabled' : 'enabled'}`);
  out.push('  Local Proxy ARP is disabled');
  out.push('  Security level is default');
  out.push('  Split horizon is enabled');
  out.push(`  ICMP redirects are ${(ifc.extraLines ?? []).includes('no ip redirects') ? 'never' : 'always'} sent`);
  out.push(`  ICMP unreachables are ${ifc.noIpUnreachables ? 'never' : 'always'} sent`);
  out.push('  ICMP mask replies are never sent');
  out.push('  IP fast switching is enabled');
  out.push('  IP Flow switching is disabled');
  out.push('  IP CEF switching is enabled');
  out.push('  IP CEF switching turbo vector');
  out.push('  IP Null turbo vector');
  out.push('  Associated unicast routing topologies:');
  out.push(`        Topology "base", operation state is ${st.up ? 'UP' : 'DOWN'}`);
  out.push('  IP multicast fast switching is enabled');
  out.push('  IP multicast distributed fast switching is disabled');
  out.push('  IP route-cache flags are Fast, CEF');
  out.push('  Router Discovery is disabled');
  out.push('  IP output packet accounting is disabled');
  out.push('  IP access violation accounting is disabled');
  out.push('  TCP/IP header compression is disabled');
  out.push('  RTP/IP header compression is disabled');
  out.push('  Probe proxy name replies are disabled');
  out.push('  Policy routing is disabled');
  const natRole = natRoleOn(dev, name);
  out.push(natRole ? `  Network address translation is enabled, interface in domain ${natRole}` : '  Network address translation is disabled');
  out.push('  BGP Policy Mapping is disabled');
  const input: string[] = [];
  if (ifc.aclIn) input.push('Access List');
  if (natRole === 'inside') input.push('NAT Inside');
  if (natRole === 'outside') input.push('NAT Outside');
  if (ifc.cryptoMap) input.push('IPSec input classification');
  input.push('MCI Check');
  out.push(`  Input features: ${input.join(', ')}`);
  const output: string[] = [];
  if (natRole === 'outside') output.push('Post-routing NAT Outside');
  if (ifc.cryptoMap) output.push('IPSec output classification');
  if (ifc.aclOut) output.push('Access List');
  if (ifc.servicePolicyOut) output.push('QoS Classification');
  if (output.length) out.push(`  Output features: ${output.join(', ')}`);
  out.push('  IPv4 WCCP Redirect outbound is disabled');
  out.push('  IPv4 WCCP Redirect inbound is disabled');
  out.push('  IPv4 WCCP Redirect exclude is disabled');
  return joinLines(out);
}
export function showIpInterface(world: World, dev: IosDevice, only?: string): string {
  const names = only ? [only] : ifOrder(dev);
  return names.map((n) => ipInterfaceBlock(world, dev, n)).join('\n');
}

// ───────────────────────────── show controllers ─────────────────────────────
export function controllersBlock(world: World, dev: IosDevice, name: string): string {
  const out: string[] = [`Interface ${name}`];
  if (isSerial(name)) {
    out.push('Hardware is NIM-2T');
    const link = linkInfo(world, { deviceId: dev.id, port: name });
    const clk = serialClock(world, dev.id, name);
    if (!clk) {
      out.push(link.cabled ? 'No usable serial cable attached' : 'No serial cable attached');
    } else if (link.dce) {
      out.push(`DCE V.35, clock rate ${clk.effective}${clk.configured === undefined ? ' (NetLab fallback; no clock rate configured)' : ''}`);
      if (!clk.active) out.push('Clock path inactive: one or both ports are shut down.');
    } else {
      out.push(clk.active ? 'DTE V.35 TX and RX clocks detected.' : 'DTE V.35 clocks stopped.');
    }
    const st = stateOf(world, dev, name);
    out.push(`Smart Serial, NIM subslot ${name.slice('Serial'.length, name.lastIndexOf('/'))}`);
    out.push(`Interface state: ${st.status === 'administratively down' ? 'Administratively down' : st.status === 'up' ? 'Up' : 'Down'}`);
    out.push(`Line protocol: ${st.protocol}`);
    return joinLines(out);
  }
  if (isEthernet(name)) {
    const st = stateOf(world, dev, name);
    out.push(dev.kind === 'switch' ? 'Hardware is Gigabit Ethernet' : 'Hardware is ISR4331-3x1GE');
    out.push(` MAC address: ${macOf(world, dev.id, name) ?? 'unknown'}`);
    const media = mediaText(dev, name);
    const mode = media.startsWith('SFP') ? '' : `, Speed: ${st.up ? '1000 Mbps' : 'Auto'}, Duplex: ${st.up ? 'Full' : 'Auto'}`;
    out.push(` Link: ${st.up ? 'up' : 'down'}${mode}, Media type: ${media}`);
    return joinLines(out);
  }
  return joinLines([...out, 'No controller information available for this interface.']);
}
export function showControllers(world: World, dev: IosDevice, only?: string): string {
  const names = only ? [only] : ifOrder(dev).filter((n) => isPhysicalPort(dev, n));
  return names.map((n) => controllersBlock(world, dev, n)).join('\n\n');
}

// ───────────────────────────── switch views ─────────────────────────────
function switchPorts(dev: IosDevice): string[] { return ifOrder(dev).filter((n) => isPhysicalPort(dev, n)); }

export function interfacesStatus(world: World, dev: IosDevice): string {
  const out = ['Port         Name               Status       Vlan       Duplex  Speed Type '];
  for (const name of switchPorts(dev)) {
    const ifc = dev.config.interfaces[name];
    const st = stateOf(world, dev, name);
    const status = st.status === 'administratively down' ? 'disabled' : st.up ? 'connected' : 'notconnect';
    const vlan = !ifc.switchport ? 'routed' : ifc.switchport.mode === 'trunk' ? 'trunk' : String(ifc.switchport.accessVlan);
    const dupCfg = ifc.duplex && ifc.duplex !== 'auto' ? ifc.duplex : undefined;
    const spdCfg = ifc.speed && ifc.speed !== 'auto' ? ifc.speed : undefined;
    const duplex = dupCfg ?? (st.up ? 'a-full' : 'auto');
    const speed = spdCfg ?? (st.up ? 'a-1000' : 'auto');
    out.push(`${padR(shortIfName(name), 13)}${padR((ifc.description ?? '').slice(0, 18), 19)}${padR(status, 13)}${padR(vlan, 11)}${padL(duplex, 6)} ${padL(speed, 6)} ${mediaText(dev, name)}`);
  }
  return joinLines(out);
}

export function interfacesTrunk(world: World, dev: IosDevice): string {
  const trunks = switchPorts(dev).filter((n) => dev.config.interfaces[n].switchport?.mode === 'trunk' && stateOf(world, dev, n).up);
  if (!trunks.length) return '';
  const out = ['', 'Port        Mode             Encapsulation  Status        Native vlan'];
  for (const t of trunks) out.push(`${padR(shortIfName(t), 12)}${padR('on', 17)}${padR('802.1q', 15)}${padR('trunking', 14)}1`);
  out.push('', 'Port        Vlans allowed on trunk');
  for (const t of trunks) out.push(`${padR(shortIfName(t), 12)}1-4094`);
  out.push('', 'Port        Vlans allowed and active in management domain');
  const vl = Object.keys(dev.config.vlans).map(Number).sort((a, b) => a - b).join(',');
  for (const t of trunks) out.push(`${padR(shortIfName(t), 12)}${vl}`);
  return joinLines(out);
}

export function vlanBrief(dev: IosDevice): string {
  const out = ['', 'VLAN Name                             Status    Ports', '---- -------------------------------- --------- -------------------------------'];
  const ids = Object.keys(dev.config.vlans).map(Number).filter((v) => !(v >= 1002 && v <= 1005)).sort((a, b) => a - b);
  for (const v of ids) {
    const name = dev.config.vlans[String(v)]?.name ?? `VLAN${String(v).padStart(4, '0')}`;
    const ports = switchPorts(dev).filter((n) => {
      const sp = dev.config.interfaces[n].switchport;
      if (!sp || sp.mode === 'trunk') return false;
      // a dynamic port that negotiated a trunk is not listed; the simulator never negotiates trunks
      return sp.accessVlan === v;
    }).map(shortIfName);
    const groups: string[] = [];
    for (let i = 0; i < ports.length; i += 4) groups.push(ports.slice(i, i + 4).join(', '));
    out.push(`${padR(v, 4)} ${padR(name.slice(0, 32), 32)} ${padR('active', 9)} ${groups[0] ?? ''}`);
    for (const g of groups.slice(1)) out.push(`${' '.repeat(48)}${g}`);
  }
  for (const [v, n] of [[1002, 'fddi-default'], [1003, 'token-ring-default'], [1004, 'fddinet-default'], [1005, 'trnet-default']] as const) {
    out.push(`${padR(v, 4)} ${padR(n, 32)} act/unsup `);
  }
  return joinLines(out);
}

const CPU_MACS = ['0100.0ccc.cccc', '0100.0ccc.cccd', ...Array.from({ length: 16 }, (_, i) => `0180.c200.00${i.toString(16).padStart(2, '0')}`), '0180.c200.0021', 'ffff.ffff.ffff'];

/** Learned addresses: every layer-3 endpoint whose frames enter a port of this switch (derived from the cabling). */
export function macTable(world: World, dev: IosDevice, dynamicOnly: boolean): string {
  const rows: { vlan: number; mac: string; port: string }[] = [];
  const seen = new Set<string>();
  for (const id of world.order) {
    const d = world.devices[id];
    if (!d) continue;
    const ifs: string[] = d.kind === 'pc' ? ['Ethernet0'] : Object.keys(d.config.interfaces).filter((n) => isEthernet(n) || n.startsWith('Vlan'));
    for (const ifName of ifs) {
      if (d.kind === 'switch' && isPhysicalPort(d, ifName) && d.config.interfaces[ifName]?.switchport) continue; // layer-2 ports have no own address
      const mac = macOf(world, id, ifName);
      if (!mac) continue;
      for (const ep of l2Reach(world, id, ifName)) {
        for (const hop of ep.hops) {
          if (hop.switchId !== dev.id || hop.inPort.startsWith('Vlan')) continue;
          const key = `${hop.vlan}|${mac}`;
          if (seen.has(key)) continue;
          seen.add(key);
          rows.push({ vlan: hop.vlan, mac, port: shortIfName(hop.inPort) });
        }
      }
    }
  }
  rows.sort((a, b) => a.vlan - b.vlan || (a.mac < b.mac ? -1 : 1));
  const out = ['          Mac Address Table', '-------------------------------------------', '', 'Vlan    Mac Address       Type        Ports', '----    -----------       --------    -----'];
  let count = 0;
  if (!dynamicOnly) for (const m of CPU_MACS) { out.push(` All    ${m}    STATIC      CPU`); count++; }
  for (const r of rows) { out.push(`${padL(r.vlan, 4)}    ${r.mac}    ${padR('DYNAMIC', 12)}${r.port}`); count++; }
  out.push(`Total Mac Addresses for this criterion: ${count}`);
  return joinLines(out);
}

export function showProtocols(world: World, dev: IosDevice, only?: string): string {
  const out: string[] = [];
  if (!only) {
    out.push('Global values:');
    out.push(`  Internet Protocol routing is ${dev.config.ipRouting ? 'enabled' : 'disabled'}`);
  }
  for (const name of only ? [only] : ifOrder(dev)) {
    const ifc = dev.config.interfaces[name];
    const st = stateOf(world, dev, name);
    out.push(`${name} is ${st.status}, line protocol is ${st.protocol}`);
    if (ifc.ip && !isL2(dev, name)) out.push(`  Internet address is ${ifc.ip.address}/${maskToPrefix(ifc.ip.mask)}`);
  }
  return joinLines(out);
}

