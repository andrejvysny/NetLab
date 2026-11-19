/**
 * Solve an assignment the way the student would, using nothing but LabApi and the scenario's model solution:
 * plug the cables, move one console cable from device to device, answer the initial dialog, type every line of the
 * model configuration, save it, set up the PCs, check.
 */
import assert from 'node:assert/strict';
import type { LabApi } from '../../src/engine/labapi.ts';
import type { GradeReport, PortRef } from '../../src/engine/types.ts';
import { prepareConfigLines } from '../../src/engine/config/apply.ts';

export interface SolveResult {
  report: GradeReport;
  /** Lines typed on device consoles. */
  typed: number;
  /** Lines IOS did not accept, as 'R1: <line> → <output>'. */
  refused: string[];
}

function must(r: { ok: boolean; message?: string }, what: string): void {
  assert.equal(r.ok, true, `${what}: ${r.message ?? 'failed'}`);
}

/** Type one line on a console. Free mode never blocks and a configuration line never closes the console. */
function typeLine(lab: LabApi, sessionId: string, deviceId: string, line: string): void {
  const v = lab.sessionExec(sessionId, line);
  assert.equal(v.blocked, undefined, `free mode never blocks, but "${line}" on ${deviceId} was stopped: ${v.blocked?.reason}`);
  assert.equal(v.closed, false, `the console of ${deviceId} closed while typing "${line}"`);
}

export function solveThroughLabApi(lab: LabApi, scenarioId: string): SolveResult {
  must(lab.startScenario(scenarioId, 'free'), `start ${scenarioId} in free mode`);
  const sol = lab.solution();
  assert.ok(sol, 'free mode shows the model solution');
  const world = () => { const w = lab.getState().world; assert.ok(w); return w; };

  // 1. the network cables of the solution (the console cable is handled below)
  for (const c of sol.cables) {
    if (c.kind === 'console') continue;
    must(lab.connectCable(c.kind, c.a, c.b, { dceEnd: c.dceEnd }), `cable ${c.kind} ${c.a.deviceId} ${c.a.port} – ${c.b.deviceId} ${c.b.port}`);
  }

  // 2. every device of the solution through the console of the first PC
  const pcId = world().order.find((id) => world().devices[id].kind === 'pc');
  assert.ok(pcId, 'the bench has a PC for the console cable');
  const com = world().devices[pcId].ports.find((p) => p.kind === 'rs232');
  assert.ok(com, `${pcId} has a serial port`);
  const comRef: PortRef = { deviceId: pcId, port: com.name };
  const refused: string[] = [];
  let typed = 0;
  for (const [deviceId, text] of Object.entries(sol.configs)) {
    const dev = world().devices[deviceId];
    assert.ok(dev && dev.kind !== 'pc', `${deviceId} is a router or switch on the bench`);
    const con = dev.ports.find((p) => p.kind === 'console');
    assert.ok(con, `${deviceId} has a console port`);
    assert.equal(lab.openConsole(deviceId).ok, false, `no terminal on ${deviceId} before the console cable is there`);
    const old = lab.portStatus(comRef).cableId;
    if (old) must(lab.removeCable(old), 'unplug the console cable');
    must(lab.connectCable('console', comRef, { deviceId, port: con.name }), `console cable ${pcId} → ${deviceId}`);
    const open = lab.openConsole(deviceId);
    assert.ok(open.ok, `open the console of ${deviceId}: ${open.ok ? '' : open.message}`);
    if (!open.ok) continue;
    const id = open.session.id;
    if (/initial configuration dialog/.test(open.session.prompt)) { lab.sessionExec(id, 'no'); lab.sessionExec(id, ''); }
    const prompt = () => lab.getState().sessions.find((s) => s.id === id)?.prompt ?? '';
    assert.match(prompt(), />$/, `${deviceId} is at the user prompt`);
    const from = lab.getState().journal.length;
    typeLine(lab, id, deviceId, 'enable');
    typeLine(lab, id, deviceId, 'configure terminal');
    assert.match(prompt(), /\(config\)#$/, `${deviceId} is in configuration mode`);
    for (const pl of prepareConfigLines(text)) {
      if (pl.command === 'end') break;
      typeLine(lab, id, deviceId, pl.command);
      typed++;
    }
    typeLine(lab, id, deviceId, 'end');
    assert.match(prompt(), /#$/, `${deviceId} is back at the privileged prompt`);
    typeLine(lab, id, deviceId, 'copy running-config startup-config');
    lab.sessionExec(id, ''); // Destination filename [startup-config]?
    // the journal knows which lines IOS did not accept (read once per device: that keeps the run fast)
    for (const e of lab.getState().journal.slice(from)) if (!e.ok) refused.push(`${deviceId}: ${e.line}`);
    const saved = world().devices[deviceId];
    assert.ok(saved.kind !== 'pc' && saved.startupConfig !== null, `${deviceId} saved its configuration`);
  }

  // 3. the PCs: fixed addresses first, then the DHCP clients
  const pcs = Object.entries(sol.pcs);
  for (const [id, setup] of pcs) {
    for (const [service, on] of Object.entries(setup.services ?? {})) lab.setPcService(id, service as 'http', !!on);
    if (setup.mode === 'static') must(lab.setPcNic(id, { mode: 'static', address: setup.address, mask: setup.mask, gateway: setup.gateway }), `${id} static address`);
  }
  for (const [id, setup] of pcs) {
    if (setup.mode === 'dhcp') must(lab.setPcNic(id, { mode: 'dhcp' }), `${id} address from DHCP`);
  }
  // A cabled PC the solution does not mention is a DHCP client out of the box: ask for its address too.
  for (const id of world().order) {
    const d = world().devices[id];
    if (d.kind !== 'pc' || id in sol.pcs || d.nic.mode !== 'dhcp') continue;
    const eth = d.ports.find((p) => p.kind === 'ethernet');
    if (eth && lab.portStatus({ deviceId: id, port: eth.name }).cableId) lab.setPcNic(id, { mode: 'dhcp' });
  }

  return { report: lab.check(), typed, refused };
}

/** Readable list of what did not pass, for assertion messages. */
export function failures(report: GradeReport): string {
  return report.requirements.filter((r) => !r.pass || r.earned < r.points).map((r) => {
    const checks = r.checks.filter((c) => !c.pass).map((c) => `      ✗ ${c.label}: expected ${c.expected}; observed ${c.observed}`).join('\n');
    return `  ${r.no} ${r.title} (${r.earned}/${r.points})\n${checks}`;
  }).join('\n');
}
