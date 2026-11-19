/**
 * PC command prompt (Windows cmd / macOS Terminal). Implemented by the PC-shell agent; signatures fixed by the orchestrator.
 *
 * - Windows PCs (os 'windows'): prompt `C:\Users\student>` — see ./windows.ts.
 * - macOS PCs (os 'macos'): prompt `student@MacBook ~ % ` — see ./macos.ts.
 * Every network command is a real flow through the simulation (sendFlow, traceroute, dhcpAcquire/dhcpRelease), so it
 * creates NAT translations, IPsec SAs and counters. Output follows the real operating system; remarks of the simulator
 * itself are in brackets starting with "(Simulator:". Nothing here ever throws.
 *
 * Telnet to a router/switch whose vty line accepts the connection returns `telnet: { deviceId, remoteAddr, host, port }`
 * with empty output: `remoteAddr` is the client address as the router sees it (after NAT, taken from the delivered
 * packet), so the lab can open the vty session and run the login dialogue.
 */
import type { World } from '../types.ts';
import { macExec, MAC_PROMPT } from './macos.ts';
import { windowsExec, WIN_PROMPT } from './windows.ts';

export interface PcCmdResult {
  /** Text printed by the command (lines end with '\n'). */
  output: string;
  /** Realistic pause before the output is complete (ping timeouts, connection attempts). */
  delayMs?: number;
  /** `cls` / `clear`. */
  clear?: boolean;
  /** `telnet <router>` was accepted by an IOS device: the lab opens a vty CLI session on it. */
  telnet?: { deviceId: string; remoteAddr: string; host: string; port: number };
}

/** Prompt text, e.g. 'C:\\Users\\student>' or 'student@MacBook ~ % '. */
export function pcPrompt(world: World, pcId: string): string {
  const d = world?.devices?.[pcId];
  return d && d.kind === 'pc' && d.os === 'macos' ? MAC_PROMPT : WIN_PROMPT;
}

/** Run one command line typed in the PC's command prompt. May mutate the world (DHCP release/renew, counters). */
export function pcExec(world: World, pcId: string, line: string): PcCmdResult {
  const d = world?.devices?.[pcId];
  if (!d || d.kind !== 'pc') return { output: '' };
  const text = typeof line === 'string' ? line.replace(/[\r\n]+/g, ' ') : '';
  if (text.trim() === '') return { output: '' };
  world.tick++;
  try {
    const r = d.os === 'macos' ? macExec(world, d, text) : windowsExec(world, d, text);
    const res: PcCmdResult = { output: r.output };
    if (r.delayMs && r.delayMs > 0) res.delayMs = r.delayMs;
    if (r.clear) res.clear = true;
    if (r.telnet) res.telnet = r.telnet;
    return res;
  } catch (e) {
    // Never throw into the UI: report the problem inside the prompt instead.
    const why = e instanceof Error ? e.message : String(e);
    return { output: `(Simulator: this command could not be run: ${why})\n` };
  }
}
