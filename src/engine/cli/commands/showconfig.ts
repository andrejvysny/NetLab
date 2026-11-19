/** show running-config / show running-config interface <if> / show startup-config (rendered by config/render.ts). */
import type { CommandDef } from '../framework.ts';
import { registerCommands } from '../framework.ts';
import { invalidToken } from './system.ts';
import { normIf } from '../show/util.ts';
import { renderInterfaceConfig, renderRunningConfig } from '../../config/render.ts';

/** Lab estimates for NVRAM size shown by `show startup-config` ("Using N out of … bytes"). */
const NVRAM_BYTES: Record<string, number> = { isr4331: 33554432, c9300l: 2097152 };

/** The startup-config as `show startup-config` prints it: "Using …" line instead of the running-config header. */
export function startupConfigView(text: string, model: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  if (/^Building configuration/.test(lines[0] ?? '')) {
    i = 1;
    while (i < lines.length && lines[i].trim() === '') i++;
    if (/^Current configuration\s*:/.test(lines[i] ?? '')) i++;
  }
  const body = lines.slice(i).join('\n').replace(/\n*$/, '\n');
  const used = new TextEncoder().encode(body).length;
  const capacity = NVRAM_BYTES[model];
  return `Using ${used}${capacity === undefined ? '' : ` out of ${capacity}`} bytes\n${body}`;
}

export const commands: CommandDef[] = [
  {
    modes: 'priv', pattern: 'show running-config', feature: 'verify', mutates: false,
    help: { show: 'Show running system information', 'running-config': 'Current operating configuration' },
    run(env) { env.print(renderRunningConfig(env.world, env.device.id) + '\n'); },
  },
  {
    modes: 'priv', pattern: 'show running-config interface <ifname:if>', feature: 'verify', mutates: false,
    help: { interface: 'Show interface configuration', '<ifname>': 'Interface name' },
    run(env, args) {
      const text = renderInterfaceConfig(env.device, normIf(String(args.ifname)));
      if (text === null) return invalidToken(env, 3);
      env.print(text + '\n');
    },
  },
  {
    modes: 'priv', pattern: 'show startup-config', feature: 'verify', mutates: false,
    help: { 'startup-config': 'Contents of startup configuration' },
    run(env) {
      const saved = env.device.startupConfig;
      if (saved === null || saved === undefined || saved.trim() === '') { env.print('startup-config is not present'); return; }
      env.print(startupConfigView(saved, env.device.model) + '\n');
    },
  },
];
export function install(): void { registerCommands(commands); }
