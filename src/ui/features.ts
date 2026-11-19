/** Feature labels shared by all UI code. Colours come from theme.css via data-feature="…". Owned by the orchestrator. */
import type { CableKind, Feature } from '../engine/types.ts';

export const FEATURE_META: Record<Feature, { label: string }> = {
  cabling: { label: 'Cabling' },
  console: { label: 'Console' },
  system: { label: 'Basics' },
  interface: { label: 'Interfaces' },
  routing: { label: 'Routing' },
  dhcp: { label: 'DHCP' },
  acl: { label: 'ACL' },
  nat: { label: 'NAT' },
  ipsec: { label: 'IPsec' },
  qos: { label: 'QoS' },
  vty: { label: 'Telnet access' },
  snmp: { label: 'SNMP' },
  syslog: { label: 'Syslog' },
  switching: { label: 'Switch' },
  pc: { label: 'PC setup' },
  verify: { label: 'Verify' },
};

export const CABLE_META: Record<CableKind, { label: string; short: string; hint: string; cssVar: string; dash?: string; width: number }> = {
  straight: { label: 'Ethernet straight-through', short: 'Straight', hint: 'Different device types: PC or router to a switch.', cssVar: '--cable-straight', width: 3 },
  crossover: { label: 'Ethernet crossover', short: 'Crossover', hint: 'Same device types: router to router, PC to router, switch to switch.', cssVar: '--cable-crossover', dash: '10 6', width: 3 },
  serial: { label: 'Serial DCE/DTE', short: 'Serial', hint: 'Router serial port to router serial port. The DCE end sets the clock.', cssVar: '--cable-serial', width: 5 },
  console: { label: 'Console (rollover)', short: 'Console', hint: "PC serial port to a device's CON port. Needed before you can open a terminal.", cssVar: '--cable-console', dash: '2 5', width: 2.5 },
};
