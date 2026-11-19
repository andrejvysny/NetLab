/** Dry-run guided checks use the same executor as the commit. No parallel parser or mode machine. */
import type { World } from '../types.ts';
import { applyConfigText, type ConfigStep } from '../config/apply.ts';
import { renderRunningConfig } from '../config/render.ts';
import { cloneWorld } from '../world.ts';

export function classifyConfigFile(world: World, deviceId: string, text: string): ConfigStep[] {
  const out: ConfigStep[] = [];
  applyConfigText(cloneWorld(world), deviceId, text, 'merge', (step) => out.push(step), true);
  return out;
}

/** A valid replacement may restore existing settings; it must not quietly drop work done in other steps. */
export function replaceEqualsMerge(world: World, deviceId: string, text: string): boolean {
  const candidate = cloneWorld(world);
  const merged = cloneWorld(world);
  const replacement = applyConfigText(candidate, deviceId, text, 'replace');
  if (!replacement.ok) return true; // Invalid replacements never commit; let the editor report their line errors.
  applyConfigText(merged, deviceId, text, 'merge');
  return renderRunningConfig(candidate, deviceId) === renderRunningConfig(merged, deviceId);
}
