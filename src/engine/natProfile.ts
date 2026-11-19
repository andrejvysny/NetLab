/** Catalyst IOS XE 17.3 classroom boundary; see docs/final-catalyst.md for source-to-scope mapping. */
import type { IosDevice, NatDynamicRule, World } from './types.ts';
import { networkLicenseFor } from './world.ts';
import { isUp } from './sim/physical.ts';

export function basicNatEnabled(dev: IosDevice): boolean {
  return dev.kind === 'router' || (dev.model === 'c9300l' && networkLicenseFor(dev) === 'network-advantage');
}

/** Hardware attachment scope is intentionally narrower than 'has an IPv4 address'. */
export function catalystNatPortProblem(dev: IosDevice, name: string): string | undefined {
  if (dev.kind !== 'switch') return;
  if (/^Vlan\d+$/.test(name)) return `NAT on SVIs is not modeled; C9300L 17.3 SVI attachment is not established for this front-panel lab.`;
  if (/^Port-channel/i.test(name)) return 'Catalyst 9300 IOS XE 17.3 does not support Port Channel NAT configuration.';
  const ifc = dev.config.interfaces[name];
  if (!ifc || !dev.ports.some((p) => p.kind === 'ethernet' && p.name === name)) return 'Use a routed front-panel Ethernet port for Catalyst NAT in this lab.';
  if (ifc.switchport) return `${name} is a layer-2 switchport. Use no switchport on a front-panel port before configuring NAT.`;
}

export function natRoleOn(dev: IosDevice, name: string | undefined): 'inside' | 'outside' | undefined {
  if (!name || !basicNatEnabled(dev) || catalystNatPortProblem(dev, name)) return;
  const ifc = dev.config.interfaces[name];
  if (dev.kind === 'switch' && !ifc?.ip) return;
  return ifc?.natRole;
}

export function catalystNatAclProblem(dev: IosDevice, aclId: string): string | undefined {
  if (dev.config.acls[aclId]?.entries.some((ace) => ace.action === 'deny')) {
    return `ACL ${aclId} has an explicit deny ACE; Catalyst 9300 IOS XE 17.3 NAT selectors support only explicit permit ACEs.`;
  }
}

/** Used at forwarding and show time, so ACL, addressing and link edits cannot leave an active but invalid mapping. */
export function catalystNatMappingProblem(world: World, dev: IosDevice, rule: NatDynamicRule): string | undefined {
  if (dev.kind !== 'switch') return;
  const aclProblem = catalystNatAclProblem(dev, rule.acl);
  if (aclProblem) return aclProblem;
  if (!dev.config.acls[rule.acl]?.entries.some((ace) => ace.action === 'permit')) return `ACL ${rule.acl} has no permit ACE.`;
  if (rule.pool) {
    const pool = dev.config.nat.pools.find((p) => p.name === rule.pool);
    if (!pool) return `Pool ${rule.pool} is not defined.`;
    if (pool.rotary) return `Rotary pools are not modeled on the Catalyst 9300L.`;
    return;
  }
  if (!rule.overload || !rule.interface) return 'Interface PAT requires an interface and explicit overload in this lab.';
  const portProblem = catalystNatPortProblem(dev, rule.interface);
  if (portProblem) return portProblem;
  if (!dev.config.interfaces[rule.interface].ip || !isUp(world, dev.id, rule.interface)) return `${rule.interface} needs a valid IPv4 address and must be up/up for interface PAT.`;
}
