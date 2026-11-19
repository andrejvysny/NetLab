/**
 * Bring any assignment to its model solution through LabApi, the quick way a student could: plug what is missing, send
 * each configuration as a file through the console, save, set up the PCs, ask for DHCP leases.
 */
import assert from 'node:assert/strict';
import type { LabApi } from '../../src/engine/labapi.ts';
import type { GradeReport, PortRef, SolutionCable } from '../../src/engine/types.ts';

const same = (a: PortRef, b: PortRef): boolean => a.deviceId === b.deviceId && a.port === b.port;

function must(r: { ok: boolean; message?: string }, what: string): void {
  assert.equal(r.ok, true, `${what}: ${r.message ?? 'failed'}`);
}
function world(lab: LabApi) { const w = lab.getState().world; assert.ok(w, 'a lab is open'); return w; }

/** Plug a solution cable; whatever sits in its two ports is unplugged first. An identical cable is left alone. */
function plug(lab: LabApi, c: SolutionCable): void {
  const w = world(lab);
  const there = w.cables.find((x) => x.kind === c.kind
    && ((same(x.a, c.a) && same(x.b, c.b) && (x.dceEnd ?? 'a') === (c.dceEnd ?? 'a')) || (same(x.a, c.b) && same(x.b, c.a) && c.kind !== 'serial')));
  if (there) return;
  for (const ref of [c.a, c.b]) {
    const id = lab.portStatus(ref).cableId;
    if (id) must(lab.removeCable(id), `unplug ${ref.deviceId} ${ref.port}`);
  }
  must(lab.connectCable(c.kind, c.a, c.b, { dceEnd: c.dceEnd }), `plug ${c.kind} ${c.a.deviceId} ${c.a.port} – ${c.b.deviceId} ${c.b.port}`);
}

/** Make sure a console cable reaches the device (moving the first PC's cable when no PC is connected to it). */
function consoleTo(lab: LabApi, deviceId: string): void {
  if (lab.consolePcOf(deviceId)) return;
  const w = world(lab);
  const dev = w.devices[deviceId];
  const con = dev.ports.find((p) => p.kind === 'console');
  assert.ok(con, `${deviceId} has a console port`);
  const stale = lab.portStatus({ deviceId, port: con.name }).cableId;
  if (stale) must(lab.removeCable(stale), 'free the console port');
  const pcs = w.order.filter((id) => w.devices[id].kind === 'pc');
  const com = (pc: string): PortRef => ({ deviceId: pc, port: w.devices[pc].ports.find((p) => p.kind === 'rs232')?.name ?? 'COM1' });
  const pc = pcs.find((id) => !lab.portStatus(com(id)).cableId) ?? pcs[0];
  assert.ok(pc, 'the bench has a PC');
  const old = lab.portStatus(com(pc)).cableId;
  if (old) must(lab.removeCable(old), 'unplug the console cable');
  must(lab.connectCable('console', com(pc), { deviceId, port: con.name }), `console cable ${pc} → ${deviceId}`);
}

export function solveWithFiles(lab: LabApi): GradeReport {
  const sol = lab.solution();
  assert.ok(sol, 'the model solution is available');
  for (const c of sol.cables) plug(lab, c);
  for (const [deviceId, text] of Object.entries(sol.configs)) {
    consoleTo(lab, deviceId);
    const rep = lab.applyConfigText(deviceId, text, 'merge');
    assert.equal(rep.blocked, undefined, `the file for ${deviceId} was stopped: ${rep.blocked?.reason}`);
    assert.deepEqual(rep.lines.filter((l) => !l.ok).map((l) => `${l.lineNo}: ${l.line} → ${l.output.trim()}`), [], `${deviceId} accepts its model configuration`);
  }
  for (const [id, setup] of Object.entries(sol.pcs)) {
    for (const [service, on] of Object.entries(setup.services ?? {})) lab.setPcService(id, service as 'http', !!on);
    if (setup.mode === 'static' && setup.address) must(lab.setPcNic(id, { mode: 'static', address: setup.address, mask: setup.mask, gateway: setup.gateway }), `${id} static`);
  }
  // every PC on DHCP asks (again), in bench order — as after "ipconfig /renew" on each of them
  const w = world(lab);
  for (const id of w.order) {
    const d = w.devices[id];
    if (d.kind !== 'pc') continue;
    const wanted = sol.pcs[id]?.mode ?? d.nic.mode;
    if (wanted !== 'dhcp') continue;
    const eth = d.ports.find((p) => p.kind === 'ethernet');
    if (eth && lab.portStatus({ deviceId: id, port: eth.name }).cableId) lab.setPcNic(id, { mode: 'dhcp' });
  }
  // save every configured router or switch (write memory on its console)
  for (const id of w.order) {
    if (w.devices[id].kind === 'pc' || !(id in sol.configs || id === 'R1' || id === 'R2')) continue;
    consoleTo(lab, id);
    const open = lab.openConsole(id);
    assert.ok(open.ok, open.ok ? '' : open.message);
    if (!open.ok) continue;
    const sid = open.session.id;
    if (/initial configuration dialog/.test(open.session.prompt)) { lab.sessionExec(sid, 'no'); lab.sessionExec(sid, ''); }
    for (let i = 0; i < 3; i++) {
      const p = lab.getState().sessions.find((s) => s.id === sid)?.prompt ?? '';
      if (p.endsWith('>')) lab.sessionExec(sid, 'enable');
      else if (/\(config[^)]*\)#$/.test(p)) lab.sessionExec(sid, 'end');
      else break;
    }
    lab.sessionExec(sid, 'write memory');
  }
  return lab.check();
}
