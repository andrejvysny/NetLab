/** Things the windows share with the workbench: terminal models, config drafts, the console-connection helper. */
import { createContext, useContext } from 'react';
import type { TermModel, TermRegistry } from './windows/termModel.ts';

export interface ConfigDraft {
  running: { text: string; loaded: string | null };
  startup: { text: string; loaded: string | null };
  which: 'running' | 'startup';
}
export type ConsoleLink = { ok: true; model: TermModel } | { ok: false; message: string };

export interface BenchServices {
  registry: TermRegistry;
  /** lab.openConsole(deviceId) and, on success, the shared terminal model showing that session. */
  connectConsole(deviceId: string): ConsoleLink;
  /** Editor text per device, kept while the lab is open so closing a window never loses work. */
  configDrafts: Map<string, ConfigDraft>;
  /** Put the console cable in the user's hand (from an explanation that says one is needed). */
  pickConsoleCable(): void;
}
export const BenchContext = createContext<BenchServices | null>(null);
export function useBench(): BenchServices {
  const b = useContext(BenchContext);
  if (!b) throw new Error('BenchContext is missing');
  return b;
}

/** The standard explanation, in plain words, of why a terminal or config window cannot open. */
export function consoleNeededText(label: string): string {
  return `You can only talk to ${label} through a console cable. Plug a Console (rollover) cable into a PC's COM1 port and into the CON port of ${label}. Then open ${label} again.`;
}
