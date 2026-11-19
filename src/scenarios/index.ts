/**
 * Scenario registry: every assignment the lab can load.
 * `SCENARIOS` and `getScenario` are the contract. The helpers below are for the Lab controller and for tests:
 *   applyInitial(world, instance)   put the pre-built parts of a scenario on a fresh bench (cables, configs, PCs, leases)
 *   applySolution(world, instance)  apply the model solution (or, for a broken network, the documented fixes)
 *   benchWorld(instance)            a new world with the bench devices of the scenario
 *   stepScripts(instance)           what each guide step's example does, in replayable form
 * Owned by the scenario agent.
 */
import type { ScenarioDef } from '../engine/types.ts';
import { ALL_SCENARIOS } from './catalog.ts';

export const SCENARIOS: ScenarioDef[] = ALL_SCENARIOS;
export function getScenario(id: string): ScenarioDef | undefined { return SCENARIOS.find((s) => s.summary.id === id); }

export { applyInitial, applySolution, benchWorld, startWorld } from './apply.ts';
export type { ApplyOutcome } from './apply.ts';
export { faultsOf, specOf, stepScripts } from './build.ts';
export { faultCatalogue } from './faults.ts';
export type { Fault } from './faults.ts';
export type { Action } from './checks.ts';
export { caseSpec } from './spec.ts';
