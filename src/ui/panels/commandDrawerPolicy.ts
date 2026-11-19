import { COMMAND_SHEET } from '../../content/commandSheet.ts';
import type { CommandSheetSection } from '../../engine/labapi.ts';
import type { LabMode } from '../../engine/types.ts';

export function deviceSupportAvailable(mode: LabMode): boolean {
  return mode === 'guided' || mode === 'free';
}

// Use the canonical paper sections, not a lab's annotated or mock reference. Exam exposes only paper text.
export const EXAM_COMMAND_SHEET: CommandSheetSection[] = COMMAND_SHEET
  .filter(({ id }) => /^sheet-(?:[a-f]|g-(?:alias|syslog|snmp))$/.test(id))
  .map((section) => ({ ...section, lines: section.lines.map(({ text }) => ({ text })) }));
