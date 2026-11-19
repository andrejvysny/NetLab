/** CLI entry point: registers every command module exactly once. Owned by the orchestrator. */
import * as execMod from './commands/exec.ts';
import * as systemMod from './commands/system.ts';
import * as interfaceMod from './commands/interface.ts';
import * as lineMod from './commands/line.ts';
import * as routingMod from './commands/routing.ts';
import * as dhcpMod from './commands/dhcp.ts';
import * as switchMod from './commands/switch.ts';
import * as aclMod from './commands/acl.ts';
import * as natMod from './commands/nat.ts';
import * as snmpMod from './commands/snmp.ts';
import * as loggingMod from './commands/logging.ts';
import * as cryptoMod from './commands/crypto.ts';
import * as qosMod from './commands/qos.ts';
import * as showconfigMod from './commands/showconfig.ts';
import * as showMod from './commands/show.ts';
import * as execnetMod from './commands/execnet.ts';

let installed = false;
/** Idempotent. Call before using execLine/startSession. */
export function installCli(): void {
  if (installed) return;
  installed = true;
  for (const m of [execMod, systemMod, interfaceMod, lineMod, routingMod, dhcpMod, switchMod, aclMod, natMod, snmpMod, loggingMod, cryptoMod, qosMod, showconfigMod, showMod, execnetMod]) m.install();
}
export * from './framework.ts';
