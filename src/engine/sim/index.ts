/**
 * KSS NetLab simulation engine — public API (ARCHITECTURE §4.2).
 *
 * Everything here reads the structured configuration (IosConfig) and the runtime tables of a World.
 * No CLI text is parsed. All functions are deterministic; only the ones marked "mutates" change the world.
 *
 *   linkInfo, interfaceState            physical layer and interface status (§5)
 *   routingTable, lookupRoute           C/L/S/R/O routes, longest-prefix match
 *   ownAddresses                        addresses of a device with interface state
 *   sendFlow (mutates), probeFlow       request + reply through the packet pipeline (§6.1)
 *   traceroute (mutates unless probe)   TTL-based path discovery
 *   dhcpAcquire, dhcpRelease (mutate)   DHCP client/server/relay (§6.6)
 *   snmpRequest (mutates)               SNMP get/set (§6.7)
 *   emitSyslog (mutates)                log buffer + UDP 514 to the logging hosts (§6.7)
 *   aclEvaluate                         first match wins, implicit deny (§6.2)
 * Extras for grading and tools: qosPlan, qosLoad, vtyDecision, staticRouteStatus, syslogProbe, emitSnmpTrap, checkCable,
 * canPlug, consolePeer, portLed, serialClock, qosCounter, describePacket and the result types.
 */
export type {
  RouteEntry, OwnAddress, LinkInfo, IfState, VtyDecision, SimFlowResult, QosPlan, QosPlanClass,
} from './model.ts';

export { linkInfo, interfaceState, checkCable, canPlug, requiredEthernetCable, consolePeer, portLed, serialClock, isUp } from './physical.ts';
export { l2Reach, resolveNeighbor, findOwners } from './switching.ts';
export type { L2Endpoint, L2Hop } from './switching.ts';
export { routingTable, lookupRoute, ownAddresses, staticRouteStatus, routeText, bandwidthKbps, defaultBandwidthKbps } from './routing.ts';
export type { StaticRouteStatus } from './routing.ts';
export { aclEvaluate, aceMatches, aceText, aclEvidence } from './acl.ts';
export { qosPlan, qosCounter, qosCounterKey } from './qos.ts';
export { qosLoad } from './qosload.ts';
export { translationRow } from './nat.ts';
export { vtyAllowsTelnet, vtyDecision, normalizeOid, oidLabel, dhcpServiceEnabled } from './services.ts';
export { sendFlow, probeFlow, traceroute, snmpRequest, emitSyslog, syslogProbe, syslogBlockReason, emitSnmpTrap } from './flow.ts';
export type { TracerouteHop, TracerouteOptions } from './flow.ts';
export { dhcpAcquire, dhcpRelease } from './dhcp.ts';
export type { DhcpResult } from './dhcp.ts';
export { describePacket } from './text.ts';
export { OUTBOUND_ACL_FILTERS_LOCAL_PACKETS } from './pipeline.ts';
