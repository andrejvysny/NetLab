/**
 * Walk through an assignment in guided mode exactly as its guide suggests: the scenario module publishes, per guide step,
 * what the step's example does ("step scripts"); this driver performs those actions through LabApi and fails when the
 * guide stops one of them or IOS refuses a line.
 */
import assert from 'node:assert/strict';
import type { ActionResult, LabApi } from '../../src/engine/labapi.ts';
import type { PcSetup, PortRef, ScenarioDef, ScenarioInstance, SolutionCable } from '../../src/engine/types.ts';

export type Action =
  | { kind: 'cable'; cable: SolutionCable }
  | { kind: 'uncable'; ref: PortRef }
  | { kind: 'config'; deviceId: string; lines: string[] }
  | { kind: 'exec'; deviceId: string; lines: string[] }
  | { kind: 'pc'; pcId: string; setup: PcSetup }
  | { kind: 'renew'; pcId: string }
  | { kind: 'note'; text: string };
export interface ScenarioModule {
  SCENARIOS?: ScenarioDef[];
  stepScripts?: (inst: ScenarioInstance) => { stepId: string; script: Action[] }[];
}

function allowed(r: ActionResult, what: string): void {
  assert.equal(r.blocked, undefined, `${what} was stopped by the guide: ${r.blocked?.reason}`);
  assert.equal(r.ok, true, `${what}: ${r.message ?? 'failed'}`);
}
const promptOf = (lab: LabApi, id: string): string => lab.getState().sessions.find((s) => s.id === id)?.prompt ?? '';

/** Type one line; fail when the guide stops it. (IOS refusals are collected from the journal afterwards, see refusedSince.) */
function typeLine(lab: LabApi, id: string, deviceId: string, line: string): void {
  const v = lab.sessionExec(id, line);
  assert.equal(v.blocked, undefined, `"${line}" on ${deviceId} was stopped by the guide: ${v.blocked?.reason}`);
}
/** Lines IOS did not accept since journal position `from`. Reading the state once per block keeps the test fast. */
function refusedSince(lab: LabApi, from: number): string[] {
  return lab.getState().journal.slice(from).filter((e) => !e.ok && !e.blocked).map((e) => `${e.deviceId}: ${e.line}`);
}
/** The console of a device, brought to privileged EXEC or to global configuration mode. */
export function consoleIn(lab: LabApi, deviceId: string, want: 'priv' | 'config'): string {
  const open = lab.openConsole(deviceId);
  assert.ok(open.ok, `console of ${deviceId}: ${open.ok ? '' : open.message}`);
  const id = open.ok ? open.session.id : '';
  if (/initial configuration dialog/.test(promptOf(lab, id))) { lab.sessionExec(id, 'no'); lab.sessionExec(id, ''); }
  for (let i = 0; i < 4; i++) {
    const p = promptOf(lab, id);
    if (p.endsWith('>')) typeLine(lab, id, deviceId, 'enable');
    else if (/\(config[^)]*\)#$/.test(p) && want === 'priv') typeLine(lab, id, deviceId, 'end');
    else if (/\(config[^)]+\)#$/.test(p) && want === 'config') typeLine(lab, id, deviceId, 'exit');
    else if (/[^)]#$/.test(p) && want === 'config') typeLine(lab, id, deviceId, 'configure terminal');
    else break;
  }
  assert.match(promptOf(lab, id), want === 'config' ? /\(config\)#$/ : /[^)]#$/, `${deviceId} is in ${want} mode`);
  return id;
}

export function perform(lab: LabApi, a: Action): void {
  switch (a.kind) {
    case 'cable': allowed(lab.connectCable(a.cable.kind, a.cable.a, a.cable.b, { dceEnd: a.cable.dceEnd }), `cable ${a.cable.a.deviceId}–${a.cable.b.deviceId}`); break;
    case 'uncable': { const id = lab.portStatus(a.ref).cableId; if (id) allowed(lab.removeCable(id), `unplug ${a.ref.deviceId} ${a.ref.port}`); break; }
    case 'config': {
      const id = consoleIn(lab, a.deviceId, 'config');
      const from = lab.getState().journal.length;
      for (const line of a.lines) typeLine(lab, id, a.deviceId, line.trim());
      typeLine(lab, id, a.deviceId, 'end');
      assert.deepEqual(refusedSince(lab, from), [], `IOS accepts the example lines of this step on ${a.deviceId}`);
      break;
    }
    case 'exec': {
      const id = consoleIn(lab, a.deviceId, 'priv');
      const from = lab.getState().journal.length;
      for (const line of a.lines) { if (line === '') lab.sessionExec(id, ''); else typeLine(lab, id, a.deviceId, line); }
      assert.deepEqual(refusedSince(lab, from), [], `IOS accepts the example commands of this step on ${a.deviceId}`);
      break;
    }
    case 'pc': {
      for (const [service, on] of Object.entries(a.setup.services ?? {})) lab.setPcService(a.pcId, service as 'http', !!on);
      if (a.setup.mode === 'static' && a.setup.address) {
        allowed(lab.setPcNic(a.pcId, { mode: 'static', address: a.setup.address, mask: a.setup.mask, gateway: a.setup.gateway }), `${a.pcId} static`);
      } else if (a.setup.mode === 'dhcp') {
        const r = lab.setPcNic(a.pcId, { mode: 'dhcp' });
        assert.equal(r.blocked, undefined, `DHCP on ${a.pcId} was stopped by the guide: ${r.blocked?.reason}`);
      }
      break;
    }
    case 'renew': {
      const r = lab.setPcNic(a.pcId, { mode: 'dhcp' });
      // (whether a lease arrives is the step's business: in a troubleshooting lab the first try may well fail)
      assert.equal(r.blocked, undefined, `renew on ${a.pcId} was stopped by the guide: ${r.blocked?.reason}`);
      break;
    }
    case 'note': break;
  }
}


/** Load src/scenarios/index.ts without failing when it is still a stub. */
export async function loadScenarios(): Promise<ScenarioModule> {
  try { return await import('../../src/scenarios/index.ts') as ScenarioModule; } catch { return {}; }
}

/**
 * Follow every guide step of the open guided lab in order. Returns a list of problems (empty = the walk-through was clean):
 * a step that was not the active one when its turn came, or not done after its example was followed.
 */
export function walkGuide(lab: LabApi, scripts: { stepId: string; script: Action[] }[]): string[] {
  const problems: string[] = [];
  const guide = () => lab.getState().scenario?.guide ?? [];
  for (const [i, step] of scripts.entries()) {
    const g = guide()[i];
    if (!g || g.id !== step.stepId) { problems.push(`script ${i + 1} (${step.stepId}) has no matching guide step`); continue; }
    if (g.status === 'locked') problems.push(`step ${g.no} (${g.title}) is still locked when its turn comes`);
    for (const a of step.script) perform(lab, a);
    if (guide()[i].status !== 'done') problems.push(`step ${g.no} (${g.title}) is not done after its example was followed`);
  }
  return problems;
}
