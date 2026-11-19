/** Browser-safe types and search for the generated course-sheet audit index. */
import type { ExecStatus, ModeName } from '../engine/cli/index.ts';

export const SUPPORT_MODELS = ['isr4331', 'c9300l'] as const;
export type SupportModel = typeof SUPPORT_MODELS[number];
export const SUPPORT_STATUSES = {
  functional: { label: 'Functional', meaning: 'An independent check observed the intended modeled behavior.' },
  partial: { label: 'Partial', meaning: 'Some behavior works, but the probe found a material limit.' },
  'display-only': { label: 'Display-only', meaning: 'The lab responds or saves the setting without running the underlying feature.' },
  unsupported: { label: 'Unsupported', meaning: 'The lab does not accept a form documented for in-scope hardware.' },
  'hardware-rejection': { label: 'Hardware rejection', meaning: 'The lab refusal matches a documented model, interface, or link-role restriction.' },
  'ill-formed': { label: 'Ill-formed', meaning: 'The paper notation or argument combination is not usable CLI as written.' },
  unresolved: { label: 'Unresolved', meaning: 'Hardware support for the exact form was not established; the lab result is still recorded.' },
} as const;
export type SupportStatus = keyof typeof SUPPORT_STATUSES;

export const SUPPORT_SECTIONS = {
  A: 'Setup & routing', B: 'ACL', C: 'NAT', D: 'IPsec', E: 'QoS', F: 'DHCP', G: 'Management',
} as const;
export type SupportSection = keyof typeof SUPPORT_SECTIONS;

export type SupportProbe = readonly [
  model: SupportModel, status: SupportStatus, outcome: ExecStatus, variant: string, input: string,
  mode: ModeName, evidenceIndex: number, blocked?: readonly [command: string, mode: ModeName],
];
export type SupportSource = readonly [
  section: SupportSection, page: number, line: number, lastLine: number, paper: string, probes: readonly SupportProbe[],
];
export interface DeviceSupportData {
  source: string;
  models: Record<SupportModel, { name: string; ios: string; networkLicense?: string }>;
  evidence: readonly string[];
  sources: readonly SupportSource[];
}

export interface SupportFilters {
  model: SupportModel | 'all';
  status: SupportStatus | 'all';
  query: string;
}

/** Keep paper order and match both printed notation and the concrete example or blocker. */
export function searchSupport(data: DeviceSupportData, { model, status, query }: SupportFilters) {
  const normalize = (term: string) => term.trim().toLowerCase().replace(/\s+/g, ' ');
  const q = normalize(query);
  return data.sources.flatMap((source) => {
    const matchesPaper = !q || normalize(source[4]).includes(q);
    return source[5].flatMap((probe) => {
      const [probeModel, probeStatus, , , input, , , blocked] = probe;
      if ((model !== 'all' && probeModel !== model) || (status !== 'all' && probeStatus !== status)) return [];
      if (!matchesPaper && !normalize(input).includes(q) && !normalize(blocked?.[0] ?? '').includes(q)) return [];
      return [{ source, probe }];
    });
  });
}
