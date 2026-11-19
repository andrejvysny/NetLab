/** World factory, device catalogue and factory-default configurations. Owned by the orchestrator. */
import type {
  BenchDeviceSeed, Cable, Device, DeviceModel, InterfaceConfig, IosConfig, IosDevice, IosRuntime, NetworkLicense, PcDevice,
  PortRef, PortSpec, World, WorldSettings,
} from './types.ts';

export const MODEL_INFO: Record<DeviceModel, { kind: 'router' | 'switch' | 'pc'; name: string; ios?: string; image?: string; networkLicense?: NetworkLicense }> = {
  isr4331: { kind: 'router', name: 'Cisco ISR 4331', ios: '17.03.04a', image: 'isr4300-universalk9.17.03.04a.SPA.bin' },
  c9300l: { kind: 'switch', name: 'Cisco Catalyst 9300L-24T-4G', ios: '17.03.04', image: 'cat9k_iosxe.17.03.04.SPA.bin', networkLicense: 'network-advantage' },
  'pc-windows': { kind: 'pc', name: 'Windows PC' },
  'pc-macos': { kind: 'pc', name: 'MacBook (USB serial adapter)' },
};

export function networkLicenseFor(dev: IosDevice): NetworkLicense | undefined {
  return dev.networkLicense ?? MODEL_INFO[dev.model].networkLicense;
}

export function portsFor(model: DeviceModel, serialModule = true): PortSpec[] {
  if (model === 'isr4331') {
    // ISR 4331 hardware guide, figure 1-23: upper row shares GE 0/0/0; lower row GE 0/0/1 (RJ-45), GE 0/0/2 (SFP).
    const p: PortSpec[] = [
      { name: 'GigabitEthernet0/0/0', short: 'Gi0/0/0', kind: 'ethernet', media: 'combo' },
      { name: 'GigabitEthernet0/0/1', short: 'Gi0/0/1', kind: 'ethernet' },
      { name: 'GigabitEthernet0/0/2', short: 'Gi0/0/2', kind: 'ethernet', media: 'sfp' },
    ];
    if (serialModule) for (const n of [0, 1]) p.push({ name: `Serial0/1/${n}`, short: `Se0/1/${n}`, kind: 'serial' });
    p.push({ name: 'Console', short: 'CON', kind: 'console' });
    return p;
  }
  if (model === 'c9300l') {
    const p: PortSpec[] = [];
    for (let n = 1; n <= 24; n++) p.push({ name: `GigabitEthernet1/0/${n}`, short: `Gi1/0/${n}`, kind: 'ethernet' });
    for (let n = 1; n <= 4; n++) p.push({ name: `GigabitEthernet1/1/${n}`, short: `Gi1/1/${n}`, kind: 'ethernet', media: 'sfp' });
    p.push({ name: 'Console', short: 'CON', kind: 'console' });
    return p;
  }
  return [
    { name: 'Ethernet0', short: 'Eth0', kind: 'ethernet' },
    { name: 'COM1', short: model === 'pc-macos' ? 'USB' : 'COM1', kind: 'rs232' },
  ];
}

export function defaultSettings(): WorldSettings {
  return { strictCables: true, qosClassifiesInnerHeader: true };
}

export function createWorld(settings: Partial<WorldSettings> = {}): World {
  return { schema: 1, devices: {}, order: [], cables: [], settings: { ...defaultSettings(), ...settings }, tick: 0, nextId: 1 };
}

export function emptyRuntime(): IosRuntime {
  return {
    setupDialogDone: false, natTranslations: [], natHits: 0, natMisses: 0, aclHits: {}, dhcpBindings: [],
    ikeSas: [], ipsecSas: [], qosCounters: {}, ifCounters: {}, logBuffer: [], vtyInUse: 0,
  };
}

function defaultPhysicalInterface(kind: 'router' | 'switch', name: string): InterfaceConfig {
  return kind === 'router' ? { name, shutdown: true } : { name, shutdown: false, switchport: { mode: 'dynamic', accessVlan: 1 } };
}

/** Factory-default configuration, as the device has it straight out of the box (nothing configured). */
export function defaultIosConfig(kind: 'router' | 'switch', ports: PortSpec[]): IosConfig {
  const interfaces: Record<string, InterfaceConfig> = {};
  for (const p of ports) {
    if (p.kind !== 'ethernet' && p.kind !== 'serial') continue;
    interfaces[p.name] = defaultPhysicalInterface(kind, p.name);
  }
  if (kind === 'switch') interfaces['Vlan1'] = { name: 'Vlan1', shutdown: true };
  return {
    hostname: kind === 'router' ? 'Router' : 'Switch',
    servicePasswordEncryption: false,
    ipDomainLookup: true,
    ipRouting: kind === 'router',
    users: [],
    aliases: [],
    interfaces,
    staticRoutes: [],
    ospf: [],
    dhcp: { excluded: [], pools: [] },
    acls: {},
    nat: { pools: [], staticRules: [], dynamicRules: [], insideDestinationRules: [] },
    crypto: { isakmpEnabled: true, isakmpPolicies: [], isakmpKeys: [], transformSets: [], maps: [] },
    qos: { classMaps: [], policyMaps: [] },
    snmp: { communities: [], hosts: [], enableTraps: [], views: [] },
    logging: { hosts: [] },
    lines: { console: { login: false }, vty: [{ first: 0, last: 4, login: true }] },
    vlans: kind === 'switch' ? { '1': { name: 'default' } } : {},
    extraLines: [],
  };
}

function macFor(index: number): string {
  const h = (0x1000 + index * 0x11).toString(16).padStart(4, '0');
  return `00-50-56-C0-${h.slice(0, 2).toUpperCase()}-${h.slice(2).toUpperCase()}`;
}

export function addDevice(world: World, seed: BenchDeviceSeed): Device {
  if (world.devices[seed.id]) throw new Error(`device id in use: ${seed.id}`);
  const info = MODEL_INFO[seed.model];
  const ports = portsFor(seed.model, seed.serialModule !== false);
  let device: Device;
  if (info.kind === 'pc') {
    const pc: PcDevice = {
      id: seed.id, kind: 'pc', model: seed.model, label: seed.label, x: seed.x, y: seed.y, ports,
      os: seed.model === 'pc-macos' ? 'macos' : 'windows',
      nic: { mode: 'dhcp', mac: macFor(world.order.length + 1) },
      services: { http: false, ftp: false, telnet: false, syslog: false },
      runtime: { syslog: [], traps: [] },
    };
    device = pc;
  } else {
    const ios: IosDevice = {
      id: seed.id, kind: info.kind, model: seed.model, label: seed.label, x: seed.x, y: seed.y, ports,
      ...(info.networkLicense ? { networkLicense: info.networkLicense } : {}),
      config: defaultIosConfig(info.kind, ports), startupConfig: null, runtime: emptyRuntime(),
    };
    device = ios;
  }
  world.devices[seed.id] = device;
  world.order.push(seed.id);
  return device;
}

/** Reconcile schema-1 saved lab inventory without changing student config, NIM presence, cable endpoints or journal. */
export function restoreHardwareInventory(world: World): void {
  for (const dev of Object.values(world.devices)) {
    if (!isIos(dev) || (dev.model !== 'isr4331' && dev.model !== 'c9300l')) continue;
    if (dev.model === 'c9300l') dev.networkLicense ??= MODEL_INFO.c9300l.networkLicense;
    const hasNim = dev.ports.some((p) => p.kind === 'serial');
    dev.ports = portsFor(dev.model, hasNim);
    for (const p of dev.ports) {
      if (p.kind === 'ethernet' || p.kind === 'serial') {
        dev.config.interfaces[p.name] ??= defaultPhysicalInterface(dev.kind, p.name);
      }
    }
  }
}

/** The selected medium in this lab (uninstalled SFPs never carry traffic). Legacy config uses extraLines too. */
export function ethernetMedium(port: PortSpec, ifc?: InterfaceConfig): 'rj45' | 'sfp' {
  if (port.media === 'sfp') return 'sfp';
  return port.media === 'combo' && ifc?.extraLines?.some((line) => /^media-type\s+sfp$/i.test(line.trim())) ? 'sfp' : 'rj45';
}

export function isIos(d: Device | undefined): d is IosDevice { return !!d && (d.kind === 'router' || d.kind === 'switch'); }
export function isPc(d: Device | undefined): d is PcDevice { return !!d && d.kind === 'pc'; }
export function getIos(world: World, id: string): IosDevice {
  const d = world.devices[id];
  if (!isIos(d)) throw new Error(`not an IOS device: ${id}`);
  return d;
}
export function getPc(world: World, id: string): PcDevice {
  const d = world.devices[id];
  if (!isPc(d)) throw new Error(`not a PC: ${id}`);
  return d;
}
export function portSpec(world: World, ref: PortRef): PortSpec | undefined {
  return world.devices[ref.deviceId]?.ports.find((p) => p.name === ref.port);
}
export function cableAt(world: World, ref: PortRef): Cable | undefined {
  return world.cables.find((c) => (c.a.deviceId === ref.deviceId && c.a.port === ref.port) || (c.b.deviceId === ref.deviceId && c.b.port === ref.port));
}
/** The port at the other end of the cable plugged into `ref`, if any. */
export function peerOf(world: World, ref: PortRef): { cable: Cable; peer: PortRef; myEnd: 'a' | 'b' } | undefined {
  const cable = cableAt(world, ref);
  if (!cable) return undefined;
  const mine = cable.a.deviceId === ref.deviceId && cable.a.port === ref.port ? 'a' : 'b';
  return { cable, peer: mine === 'a' ? cable.b : cable.a, myEnd: mine };
}
export function cloneWorld(world: World): World { return structuredClone(world); }
export function nextId(world: World): number { return world.nextId++; }
