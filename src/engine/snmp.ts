import type { ModeledSnmpTrap, SnmpConfig, SnmpHost } from './types.ts';

export const MODELED_SNMP_TRAPS: readonly ModeledSnmpTrap[] = ['config', 'snmp linkdown', 'snmp linkup'];

/** Last assignment wins for each address and notification kind (also for older serialized labs). */
export function effectiveSnmpHosts(config: SnmpConfig): SnmpHost[] {
  const byKind = new Map<string, SnmpHost>();
  for (const h of config.hosts) byKind.set(`${h.address}|${h.type}`, h);
  return [...byKind.values()];
}

export function modeledSnmpHost(host: SnmpHost): boolean {
  return host.type === 'traps' && host.version !== '3';
}

export function validSnmpHost(host: SnmpHost): boolean {
  return host.type !== 'informs' || host.version === '2c' || host.version === '3';
}

/** A global selector is unqualified (all), a family, or a family plus a list of options. */
export function snmpSelectorMatches(selector: string, trap: ModeledSnmpTrap): boolean {
  if (selector === 'all' || selector === '') return true;
  const [family, ...options] = selector.split(' ');
  const [eventFamily, eventOption] = trap.split(' ');
  return family === eventFamily && (!options.length || options.includes(eventOption));
}

export function enabledSnmpTraps(config: SnmpConfig): ModeledSnmpTrap[] {
  return MODELED_SNMP_TRAPS.filter((trap) => !config.disableTraps?.includes(trap) && config.enableTraps.some((s) => snmpSelectorMatches(s, trap)));
}

export function hostAllowsSnmpTrap(host: SnmpHost, trap: ModeledSnmpTrap): boolean {
  return modeledSnmpHost(host) && (!host.notificationTypes?.length || host.notificationTypes.includes(trap.split(' ')[0]));
}
