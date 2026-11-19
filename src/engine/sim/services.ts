/**
 * What a device does with a packet addressed to itself (ARCHITECTURE §6.7): ping answers, Telnet on the vty lines,
 * SNMP agent, implicit IKE listener on routers; HTTP/FTP/Telnet servers, syslog and SNMP-trap receivers on PCs.
 */
import type { AppData, DropReason, IosDevice, Packet, PcDevice, VtyRange, World } from '../types.ts';
import { MODEL_INFO } from '../world.ts';
import { aclEvaluate, aclEvidence, countHit } from './acl.ts';
import type { Ctx, SimPacket, VtyDecision, WalkState } from './model.ts';
import { addStep } from './model.ts';
import { interfaceState } from './physical.ts';
import { describePacket, isIosDevice, portText } from './text.ts';

export interface LocalResult {
  ok: boolean;
  reason?: DropReason;
  reasonText?: string;
  /** Answer to send back (echo reply, SYN-ACK, reset, SNMP response). */
  reply?: SimPacket;
  /** ICMP error to send back (port unreachable). */
  icmpError?: SimPacket;
  vty?: VtyDecision;
}

export function initialTtl(dev: IosDevice | PcDevice): number {
  if (dev.kind === 'pc') return dev.os === 'macos' ? 64 : 128;
  return 255;
}

function answer(dev: IosDevice | PcDevice, p: SimPacket, patch: Partial<SimPacket>): SimPacket {
  return {
    src: p.dst, dst: p.src, proto: p.proto, sport: p.dport, dport: p.sport,
    ttl: initialTtl(dev), bytes: p.bytes, ...patch,
  };
}

/** Copy of a packet that is safe to quote inside an ICMP error. */
function quote(p: SimPacket): Packet {
  const { inner: _inner, errFor: _errFor, ...rest } = p;
  void _inner; void _errFor;
  return rest;
}

/** ICMP error from `fromAddr` back to the source of `offending`. Never built for ICMP errors themselves. */
export function icmpErrorFor(
  fromAddr: string, offending: SimPacket, type: 'unreachable' | 'admin-prohibited' | 'time-exceeded', code?: 'net' | 'host' | 'port' | 'admin',
): SimPacket | undefined {
  if (offending.proto === 'icmp' && offending.icmpType !== 'echo' && offending.icmpType !== 'echo-reply' && offending.icmpType !== undefined) return undefined;
  if (offending.tcpRst) return undefined;
  return { src: fromAddr, dst: offending.src, proto: 'icmp', icmpType: type, icmpCode: code, ttl: 255, bytes: 56, errFor: quote(offending) };
}

// ───────────────────────────── vty ─────────────────────────────

export function vtyAllowsTelnet(line: VtyRange): boolean {
  const t = line.transportInput;
  return t === undefined || t === 'all' || t === 'telnet ssh' || t === 'telnet';
}

/** Walk configured line numbers in the same order as the terminal, skipping unconfigured gaps. */
function nextVtyRange(lines: VtyRange[], inUse: number): VtyRange | undefined {
  let offset = inUse;
  for (const range of [...lines].sort((a, b) => a.first - b.first)) {
    const count = range.last - range.first + 1;
    if (offset < count) return range;
    offset -= count;
  }
  return undefined;
}

/**
 * Would a Telnet connection from `sourceAddr` be accepted by the vty lines of this device, and if not, why?
 * `lineNumber` inspects a particular VTY instead of selecting by current occupancy. The SSH server is not modeled.
 * `sourceAddr` is the client address as the device sees it (after NAT). Pure: counts nothing.
 */
export function vtyDecision(world: World, deviceId: string, sourceAddr: string, service: 'telnet' | 'ssh' = 'telnet', lineNumber?: number): VtyDecision {
  const dev = world.devices[deviceId];
  const name = dev?.label ?? deviceId;
  const svc = 'Telnet';
  if (!isIosDevice(dev)) return { accepted: false, reason: 'not-ios', text: `${name} is not a router or switch.` };
  if (service === 'ssh') return {
    accepted: false, reason: 'ssh-not-modeled',
    text: `The TCP 22 probe reaches ${name}, but this simulator does not run an SSH server.`,
  };
  const lines = dev.config.lines.vty;
  if (lines.length === 0) {
    return { accepted: false, reason: 'no-vty', text: `${name} has no vty lines, so nobody can connect to it remotely. Configure "line vty 0 4".` };
  }
  const line = lineNumber === undefined
    ? nextVtyRange(lines, dev.runtime.vtyInUse)
    : lines.find((l) => lineNumber >= l.first && lineNumber <= l.last);
  if (!line) {
    return { accepted: false, reason: 'no-free-line', text: lineNumber !== undefined
      ? `${name} does not have a VTY line ${lineNumber}.`
      : `All vty lines of ${name} are in use. Close a remote session or configure more lines.` };
  }
  const where = `line vty ${line.first} ${line.last}`;
  if (!vtyAllowsTelnet(line)) {
    return {
      accepted: false, reason: 'transport-input', line,
      text: `${name} refuses the ${svc} connection: "transport input ${line.transportInput}" on ${where} does not allow ${svc}.`,
    };
  }
  if (line.accessClassIn) {
    const acl = dev.config.acls[line.accessClassIn];
    const r = aclEvaluate(acl, { src: sourceAddr, dst: '0.0.0.0', proto: 'tcp', sport: 0, dport: 23, tcpSyn: true, ttl: 64, bytes: 0 });
    if (!r.permit) {
      return {
        accepted: false, reason: 'access-class', line, acl: line.accessClassIn, ace: r.ace, implicit: r.implicit,
        text: `${name} refuses the ${svc} connection from ${sourceAddr}: "access-class ${line.accessClassIn} in" on ${where} does not permit that address.`,
      };
    }
  }
  let login: VtyDecision['login'];
  if (line.login === false) login = 'none';
  else if (line.login === 'local') login = dev.config.users.some((u) => u.secret !== '') ? 'local' : 'local-no-users';
  else login = line.password ? 'password' : 'password-not-set';
  const after = login === 'password' ? ' and asks for the line password'
    : login === 'password-not-set' ? ', but the line has "login" without a password: the router answers "Password required, but none set" and closes the session'
      : login === 'local' ? ' and asks for a username and password'
        : login === 'local-no-users' ? ', but "login local" is set and no user with a password exists, so nobody can log in'
          : ' without asking for a password ("no login")';
  return {
    accepted: true, line, acl: line.accessClassIn, login,
    text: `${name} accepts the ${svc} connection from ${sourceAddr} on ${where}${after}.`,
  };
}

// ───────────────────────────── SNMP agent ─────────────────────────────
const OID_NAMES: Record<string, string> = {
  sysDescr: '1.3.6.1.2.1.1.1.0', sysObjectID: '1.3.6.1.2.1.1.2.0', sysUpTime: '1.3.6.1.2.1.1.3.0',
  sysContact: '1.3.6.1.2.1.1.4.0', sysName: '1.3.6.1.2.1.1.5.0', sysLocation: '1.3.6.1.2.1.1.6.0',
  ifNumber: '1.3.6.1.2.1.2.1.0',
};
const OID_LABELS: Record<string, string> = Object.fromEntries(Object.entries(OID_NAMES).map(([k, v]) => [v, `${k}.0`]));
const VIEW_TREES: Record<string, string> = {
  iso: '1', internet: '1.3.6.1', 'mib-2': '1.3.6.1.2.1', system: '1.3.6.1.2.1.1',
  interfaces: '1.3.6.1.2.1.2', ifTable: '1.3.6.1.2.1.2.2', ifEntry: '1.3.6.1.2.1.2.2.1',
};

/** In the modeled MIB, the longest matching view subtree decides. Unlisted objects are outside the view. */
function inView(dev: IosDevice, name: string, oid: string): boolean {
  const arcs = oid.split('.');
  let best = 0;
  let allowed = false;
  for (const view of dev.config.snmp.views) {
    if (view.name !== name) continue;
    const base = view.oid.split('::').at(-1)!;
    const numeric = VIEW_TREES[base] ?? OID_NAMES[base]?.replace(/\.0$/, '') ?? normalizeOid(base);
    const subtree = numeric.split('.');
    if (subtree.length < best || !subtree.every((arc, i) => i < arcs.length && (arc === '*' || arc === arcs[i]))) continue;
    // When two supported rules tie, prefer the exclusion rather than exposing an object unexpectedly.
    if (subtree.length > best || !view.included) allowed = view.included;
    best = subtree.length;
  }
  return allowed;
}

/** 'sysName', 'sysName.0', 'SNMPv2-MIB::sysName.0', '.1.3.6.1.2.1.1.5.0' → '1.3.6.1.2.1.1.5.0'. */
export function normalizeOid(oid: string): string {
  let s = oid.trim();
  const colon = s.lastIndexOf('::');
  if (colon >= 0) s = s.slice(colon + 2);
  if (s.startsWith('.')) s = s.slice(1);
  const m = /^([A-Za-z][A-Za-z0-9]*)((?:\.\d+)*)$/.exec(s);
  if (m) {
    const base = m[1];
    if (OID_NAMES[base]) return m[2] === '' || m[2] === '.0' ? OID_NAMES[base] : OID_NAMES[base].replace(/\.0$/, '') + m[2];
    if (base === 'ifDescr') return `1.3.6.1.2.1.2.2.1.2${m[2]}`;
    if (base === 'ifAdminStatus') return `1.3.6.1.2.1.2.2.1.7${m[2]}`;
    if (base === 'ifOperStatus') return `1.3.6.1.2.1.2.2.1.8${m[2]}`;
  }
  return s;
}

/** Name of an OID for output: '1.3.6.1.2.1.1.5.0' → 'sysName.0'. */
export function oidLabel(oid: string): string {
  const n = normalizeOid(oid);
  if (OID_LABELS[n]) return OID_LABELS[n];
  const m = /^1\.3\.6\.1\.2\.1\.2\.2\.1\.(2|7|8)\.(\d+)$/.exec(n);
  if (m) return `${m[1] === '2' ? 'ifDescr' : m[1] === '7' ? 'ifAdminStatus' : 'ifOperStatus'}.${m[2]}`;
  return n;
}

function snmpRead(world: World, dev: IosDevice, oid: string): string | null {
  const info = MODEL_INFO[dev.model];
  switch (oid) {
    case OID_NAMES.sysDescr:
      return dev.kind === 'router'
        ? `STRING: Cisco IOS Software [Amsterdam], ISR Software (X86_64_LINUX_IOSD-UNIVERSALK9-M), Version ${info.ios}, RELEASE SOFTWARE`
        : `STRING: Cisco IOS Software [Amsterdam], Catalyst L3 Switch Software (CAT9K_IOSXE), Version ${info.ios}, RELEASE SOFTWARE`;
    case OID_NAMES.sysObjectID: return dev.kind === 'router' ? 'OID: 1.3.6.1.4.1.9.1.2068' : 'OID: 1.3.6.1.4.1.9.1.2530';
    case OID_NAMES.sysUpTime: return `Timeticks: (${world.tick * 100}) ${world.tick} ticks`;
    case OID_NAMES.sysContact: return `STRING: ${dev.config.snmp.contact ?? ''}`;
    case OID_NAMES.sysName: return `STRING: ${dev.config.hostname}`;
    case OID_NAMES.sysLocation: return `STRING: ${dev.config.snmp.location ?? ''}`;
    case OID_NAMES.ifNumber: return `INTEGER: ${Object.keys(dev.config.interfaces).length}`;
  }
  const m = /^1\.3\.6\.1\.2\.1\.2\.2\.1\.(2|7|8)\.(\d+)$/.exec(oid);
  if (m) {
    const names = Object.keys(dev.config.interfaces);
    const name = names[Number(m[2]) - 1];
    if (!name) return null;
    if (m[1] === '2') return `STRING: ${name}`;
    if (m[1] === '7') return dev.config.interfaces[name].shutdown ? 'INTEGER: down(2)' : 'INTEGER: up(1)';
    const st = interfaceState(world, dev.id, name);
    return st.status === 'up' && st.protocol === 'up' ? 'INTEGER: up(1)' : 'INTEGER: down(2)';
  }
  return null;
}

function snmpWrite(dev: IosDevice, oid: string, value: string): boolean {
  switch (oid) {
    case OID_NAMES.sysContact: dev.config.snmp.contact = value; return true;
    case OID_NAMES.sysName: dev.config.hostname = value; return true;
    case OID_NAMES.sysLocation: dev.config.snmp.location = value; return true;
    default: return false;
  }
}

function snmpAgent(ctx: Ctx, st: WalkState, dev: IosDevice, ifName: string | undefined, p: SimPacket): LocalResult {
  const world = ctx.world;
  const snmp = dev.config.snmp;
  const hdr = describePacket(p);
  const stepOf = (verdict: 'ok' | 'drop' | 'info', text: string, detail?: string) =>
    addStep(st, { deviceId: dev.id, stage: 'local', feature: 'snmp', verdict, text, detail, iface: ifName, header: hdr });
  const app = p.app;
  if (!app || app.kind !== 'snmp' || (app.op !== 'get' && app.op !== 'set')) {
    const text = `${dev.label} received a packet on the SNMP port (UDP 161) that is not an SNMP request, so it does not answer.`;
    stepOf('drop', text);
    return { ok: false, reason: 'service-denied', reasonText: text };
  }
  const silent = (why: string, detail?: string): LocalResult => {
    const text = `${dev.label} stays silent on the SNMP ${app.op} request from ${p.src}, so the sender sees a timeout: ${why}`;
    stepOf('drop', text, detail);
    return { ok: false, reason: 'service-denied', reasonText: text };
  };
  const com = snmp.communities.find((c) => c.name === app.community);
  if (!com) return silent(`the community "${app.community}" is not configured on ${dev.label}.`, `configured: ${snmp.communities.map((c) => `snmp-server community ${c.name} ${c.access.toUpperCase()}${c.acl ? ' ' + c.acl : ''}`).join('; ')}`);
  const line = `snmp-server community ${com.name} ${com.access.toUpperCase()}${com.acl ? ' ' + com.acl : ''}`;
  if (com.acl) {
    const acl = dev.config.acls[com.acl];
    const r = aclEvaluate(acl, p);
    countHit(dev.runtime, com.acl, r.ace);
    if (!r.permit) {
      return silent(`access list ${com.acl} of community "${com.name}" does not permit the source ${p.src}.`, `${line} — ${aclEvidence(com.acl, acl, r)}`);
    }
  }
  if (app.op === 'set' && com.access !== 'rw') {
    return silent(`community "${com.name}" is read-only (RO). Writing needs a read-write (RW) community.`, line);
  }
  const oid = normalizeOid(app.oid ?? 'sysName');
  let response: AppData;
  if (com.view && !inView(dev, com.view, oid)) {
    stepOf('info', `${dev.label} returns an SNMP error: MIB view ${com.view} does not expose ${oidLabel(oid)} to community "${com.name}".`);
    return { ok: true, reply: answer(dev, p, { app: { kind: 'snmp', op: 'response', community: com.name, oid, error: app.op === 'set' ? 'noAccess' : 'noSuchName' }, bytes: 90 }) };
  }
  if (app.op === 'get') {
    const value = snmpRead(world, dev, oid);
    response = value === null
      ? { kind: 'snmp', op: 'response', community: com.name, oid, error: 'noSuchName' }
      : { kind: 'snmp', op: 'response', community: com.name, oid, value };
  } else {
    const done = snmpWrite(dev, oid, app.value ?? '');
    response = done
      ? { kind: 'snmp', op: 'response', community: com.name, oid, value: snmpRead(world, dev, oid) ?? '' }
      : { kind: 'snmp', op: 'response', community: com.name, oid, error: snmpRead(world, dev, oid) === null ? 'noSuchName' : 'notWritable' };
  }
  stepOf('ok', `${dev.label} accepts the SNMP ${app.op} request (community "${com.name}") and answers.`, line);
  return { ok: true, reply: answer(dev, p, { app: response, bytes: 90 }) };
}

/** `service dhcp` is the default; the CLI persists only its negative form. */
export function dhcpServiceEnabled(dev: IosDevice): boolean {
  return !dev.config.extraLines.includes('no service dhcp');
}

// ───────────────────────────── local delivery: IOS ─────────────────────────────
export function iosLocal(ctx: Ctx, st: WalkState, dev: IosDevice, ifName: string | undefined, p: SimPacket): LocalResult {
  const hdr = describePacket(p);
  const world = ctx.world;
  const ownerIf = Object.values(dev.config.interfaces).find((c) => c.ip?.address === p.dst || c.secondary?.some((s) => s.address === p.dst))?.name;
  const mine = `${p.dst}${ownerIf ? ` (${ownerIf})` : ''}`;
  const local = (verdict: 'ok' | 'drop', feature: 'interface' | 'vty' | 'ipsec' | 'dhcp' | 'snmp', text: string, detail?: string) =>
    addStep(st, { deviceId: dev.id, stage: 'local', feature, verdict, text, detail, iface: ifName, header: hdr });

  if (p.proto === 'icmp') {
    if (p.icmpType === 'echo' || p.icmpType === undefined) {
      local('ok', 'interface', `${dev.label} owns ${mine}, so it answers the ping itself.`);
      return { ok: true, reply: answer(dev, p, { icmpType: 'echo-reply' }) };
    }
    local('ok', 'interface', `${dev.label} receives the ${p.icmpType === 'echo-reply' ? 'ping reply' : 'ICMP message'}.`);
    return { ok: true };
  }

  if (p.proto === 'tcp') {
    if (!p.tcpSyn) {
      local('ok', 'interface', `${dev.label} receives the TCP answer.`);
      return { ok: true };
    }
    if (p.dport === 23 || p.dport === 22) {
      const service = p.dport === 23 ? 'telnet' : 'ssh';
      const d = vtyDecision(world, dev.id, p.src, service);
      if (d.acl) {
        const acl = dev.config.acls[d.acl];
        countHit(dev.runtime, d.acl, d.ace ?? aclEvaluate(acl, { ...p, dst: '0.0.0.0' }).ace);
      }
      const detail = d.line
        ? `line vty ${d.line.first} ${d.line.last}${d.line.accessClassIn ? `: access-class ${d.line.accessClassIn} in` : ''}${d.line.transportInput ? `, transport input ${d.line.transportInput}` : ''}`
        : undefined;
      if (!d.accepted) {
        local('drop', 'vty', d.text, detail);
        return { ok: false, reason: d.reason === 'ssh-not-modeled' ? 'port-closed' : 'service-denied', reasonText: d.text, vty: d, reply: answer(dev, p, { tcpSyn: false, tcpRst: true, bytes: 40 }) };
      }
      local('ok', 'vty', d.text, detail);
      return { ok: true, vty: d, reply: answer(dev, p, { tcpSyn: false, bytes: 44 }) };
    }
    const text = `${dev.label} has no service on TCP port ${portText(p.dport, 'tcp')}, so it refuses the connection.`;
    local('drop', 'interface', text);
    return { ok: false, reason: 'port-closed', reasonText: text, reply: answer(dev, p, { tcpSyn: false, tcpRst: true, bytes: 40 }) };
  }

  if (p.proto === 'udp') {
    if (p.dport === 161) {
      if (dev.config.snmp.communities.length > 0) return snmpAgent(ctx, st, dev, ifName, p);
      // §6.7: no usable community → silence (the manager sees a timeout).
      const text = `SNMP is not enabled on ${dev.label} (no "snmp-server community"), so it does not answer the request.`;
      local('drop', 'snmp', text);
      return { ok: false, reason: 'service-denied', reasonText: text };
    }
    if (p.dport === 500) {
      if (dev.kind === 'router' && dev.config.crypto.isakmpEnabled) {
        local('ok', 'ipsec', `${dev.label} receives the IKE negotiation packet.`);
        return { ok: true };
      }
      const text = dev.kind === 'router'
        ? `ISAKMP is switched off on ${dev.label} ("no crypto isakmp enable"), so it does not answer IKE.`
        : `${dev.label} is not an IPsec gateway and does not answer IKE.`;
      local('drop', 'ipsec', text);
      return { ok: false, reason: 'port-closed', reasonText: text };
    }
    if (p.dport === 67 && p.app?.kind === 'dhcp') {
      if (!dhcpServiceEnabled(dev)) {
        const text = `${dev.label} ignores the DHCP packet: "no service dhcp" disables both its DHCP server and relay agent.`;
        local('drop', 'dhcp', text, 'Enter "service dhcp" to reenable both.');
        return { ok: false, reason: 'service-denied', reasonText: text };
      }
      local('ok', 'dhcp', `${dev.label} receives the DHCP packet.`);
      return { ok: true };
    }
    if (p.app?.kind === 'snmp' && p.app.op === 'response') {
      local('ok', 'snmp', `${dev.label} receives the SNMP response.`);
      return { ok: true };
    }
    const text = `${dev.label} has no service on UDP port ${portText(p.dport, 'udp')}.`;
    local('drop', 'interface', text);
    return { ok: false, reason: 'port-closed', reasonText: text, icmpError: icmpErrorFor(p.dst, p, 'unreachable', 'port') };
  }

  const text = `${dev.label} does not know what to do with this packet.`;
  local('drop', 'interface', text);
  return { ok: false, reason: 'port-closed', reasonText: text };
}

// ───────────────────────────── local delivery: PC ─────────────────────────────
const PC_TCP: Record<number, { key: 'http' | 'ftp' | 'telnet'; name: string }> = {
  80: { key: 'http', name: 'web server (HTTP)' },
  21: { key: 'ftp', name: 'FTP server' },
  23: { key: 'telnet', name: 'Telnet server' },
};

export function pcLocal(ctx: Ctx, st: WalkState, pc: PcDevice, p: SimPacket): LocalResult {
  const hdr = describePacket(p);
  const world = ctx.world;
  const deliver = (verdict: 'ok' | 'drop', feature: 'pc' | 'syslog' | 'snmp', text: string) =>
    addStep(st, { deviceId: pc.id, stage: 'deliver', feature, verdict, text, iface: 'Ethernet0', header: hdr });

  if (p.proto === 'icmp') {
    if (p.icmpType === 'echo' || p.icmpType === undefined) {
      deliver('ok', 'pc', `${pc.label} receives the ping from ${p.src} and answers.`);
      return { ok: true, reply: answer(pc, p, { icmpType: 'echo-reply' }) };
    }
    deliver('ok', 'pc', `${pc.label} receives the ${p.icmpType === 'echo-reply' ? `ping reply from ${p.src}` : `ICMP message from ${p.src}`}.`);
    return { ok: true };
  }

  if (p.proto === 'tcp') {
    if (!p.tcpSyn) {
      deliver('ok', 'pc', `${pc.label} receives the TCP answer from ${p.src}.`);
      return { ok: true };
    }
    const svc = PC_TCP[p.dport ?? -1];
    if (svc && pc.services[svc.key]) {
      deliver('ok', 'pc', `${pc.label} runs a ${svc.name} and accepts the connection from ${p.src}.`);
      return { ok: true, reply: answer(pc, p, { tcpSyn: false, bytes: 44 }) };
    }
    const text = svc
      ? `The ${svc.name} on ${pc.label} is switched off, so ${pc.label} refuses the connection to TCP port ${portText(p.dport, 'tcp')}.`
      : `${pc.label} has no service on TCP port ${portText(p.dport, 'tcp')}, so it refuses the connection.`;
    deliver('drop', 'pc', text);
    return { ok: false, reason: 'port-closed', reasonText: text, reply: answer(pc, p, { tcpSyn: false, tcpRst: true, bytes: 40 }) };
  }

  if (p.proto === 'udp') {
    const app = p.app;
    if (p.dport === 514) {
      if (pc.services.syslog) {
        const rec = app?.kind === 'syslog'
          ? { tick: world.tick, from: p.src, severity: app.severity, mnemonic: app.mnemonic, text: app.text }
          : { tick: world.tick, from: p.src, severity: 6, mnemonic: '', text: '(test packet without a syslog message)' };
        pc.runtime.syslog.push(rec);
        deliver('ok', 'syslog', `The syslog server on ${pc.label} records the message from ${p.src}.`);
        return { ok: true };
      }
      const text = `The syslog server on ${pc.label} is switched off, so the message to UDP port 514 is thrown away.`;
      deliver('drop', 'syslog', text);
      return { ok: false, reason: 'port-closed', reasonText: text, icmpError: icmpErrorFor(p.dst, p, 'unreachable', 'port') };
    }
    if (p.dport === 162) {
      if (pc.services.syslog) {
        const rec = app?.kind === 'snmp'
          ? { tick: world.tick, from: p.src, community: app.community, text: app.value ?? app.oid ?? 'trap' }
          : { tick: world.tick, from: p.src, community: '', text: '(test packet without a trap)' };
        pc.runtime.traps.push(rec);
        deliver('ok', 'snmp', `The management station on ${pc.label} records the SNMP trap from ${p.src}.`);
        return { ok: true };
      }
      const text = `No trap receiver is running on ${pc.label} (its management software is switched off), so the SNMP trap is thrown away.`;
      deliver('drop', 'snmp', text);
      return { ok: false, reason: 'port-closed', reasonText: text, icmpError: icmpErrorFor(p.dst, p, 'unreachable', 'port') };
    }
    if (app?.kind === 'snmp' && app.op === 'response') {
      deliver('ok', 'snmp', `${pc.label} receives the SNMP response from ${p.src}.`);
      return { ok: true };
    }
    if (app?.kind === 'dhcp') {
      deliver('ok', 'pc', `${pc.label} receives the DHCP packet.`);
      return { ok: true };
    }
    const text = `${pc.label} has no service on UDP port ${portText(p.dport, 'udp')}.`;
    deliver('drop', 'pc', text);
    return { ok: false, reason: 'port-closed', reasonText: text, icmpError: icmpErrorFor(p.dst, p, 'unreachable', 'port') };
  }

  const text = `${pc.label} ignores this packet.`;
  deliver('drop', 'pc', text);
  return { ok: false, reason: 'port-closed', reasonText: text };
}
