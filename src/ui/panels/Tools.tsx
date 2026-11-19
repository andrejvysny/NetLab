/** Learning tools (guided/free only): packet walkthrough (lab.trace) and QoS load test (lab.qosLoad). Owned by the app-shell agent. */
import { Icon } from '../icons.tsx';
import { useMemo, useState } from 'react';
import type { AppData, FlowResult, FlowSpec, IosDevice, PcDevice, World } from '../../engine/types.ts';
import type { QosLoadResult } from '../../engine/labapi.ts';
import { useLab, useLabState } from '../labContext.tsx';
import { Tabs, TabPanel } from './ui.tsx';
import { DeliveryFacts, TraceSteps } from './TraceView.tsx';
import { useDeviceLabel } from './TaskPanel.tsx';
import { errorText, looksLikeIp } from './safe.ts';

function shortIf(name: string): string {
  return name.replace(/^GigabitEthernet/, 'Gi').replace(/^Serial/, 'Se').replace(/^Loopback/, 'Lo').replace(/^FastEthernet/, 'Fa');
}

interface KnownAddr { address: string; text: string; deviceId: string }

function knownAddresses(world: World | null): KnownAddr[] {
  if (!world || !world.devices) return [];
  const out: KnownAddr[] = [];
  for (const id of world.order ?? Object.keys(world.devices)) {
    const d = world.devices[id];
    if (!d) continue;
    if (d.kind === 'pc') {
      const a = (d as PcDevice).nic?.address;
      if (a) out.push({ address: a, deviceId: id, text: `${d.label} — ${a}` });
    } else {
      for (const i of Object.values((d as IosDevice).config?.interfaces ?? {})) {
        if (i.ip?.address) out.push({ address: i.ip.address, deviceId: id, text: `${d.label} ${shortIf(i.name)} — ${i.ip.address}` });
        for (const s of i.secondary ?? []) out.push({ address: s.address, deviceId: id, text: `${d.label} ${shortIf(i.name)} (secondary) — ${s.address}` });
      }
    }
  }
  return out;
}

// ───────────────────────── packet walkthrough ─────────────────────────

interface Preset { id: string; label: string; proto: 'icmp' | 'tcp' | 'udp'; port?: number; custom?: boolean }
const PRESETS: Preset[] = [
  { id: 'ping', label: 'Ping (ICMP)', proto: 'icmp' },
  { id: 'http', label: 'Web — HTTP (TCP 80)', proto: 'tcp', port: 80 },
  { id: 'ftp', label: 'FTP (TCP 21)', proto: 'tcp', port: 21 },
  { id: 'telnet', label: 'Telnet (TCP 23)', proto: 'tcp', port: 23 },
  { id: 'ssh', label: 'TCP 22 (SSH path only)', proto: 'tcp', port: 22 },
  { id: 'snmp', label: 'SNMP (UDP 161)', proto: 'udp', port: 161 },
  { id: 'syslog', label: 'Syslog (UDP 514)', proto: 'udp', port: 514 },
  { id: 'tcp', label: 'Other TCP port…', proto: 'tcp', custom: true },
  { id: 'udp', label: 'Other UDP port…', proto: 'udp', custom: true },
];

const SYMBOL: Record<FlowResult['symbol'], { word: string; icon: string; state: string }> = {
  '!': { word: 'It works', icon: '✓', state: 'pass' },
  '.': { word: 'No answer', icon: '…', state: 'fail' },
  U: { word: 'Unreachable', icon: '✗', state: 'fail' },
};

function PacketWalk() {
  const lab = useLab();
  const state = useLabState();
  const label = useDeviceLabel();
  const world = state.world;
  const devices = (world?.order ?? []).map((id) => world?.devices[id]).filter((d): d is NonNullable<typeof d> => !!d);
  const known = useMemo(() => knownAddresses(world), [world]);
  const [from, setFrom] = useState<string>(() => devices.find((d) => d.kind === 'pc')?.id ?? devices[0]?.id ?? '');
  const [dst, setDst] = useState('');
  const [presetId, setPresetId] = useState('ping');
  const [port, setPort] = useState('8080');
  const [community, setCommunity] = useState('public');
  const [srcAddr, setSrcAddr] = useState('');
  const [result, setResult] = useState<FlowResult | null>(null);
  const [error, setError] = useState('');
  const preset = PRESETS.find((p) => p.id === presetId) ?? PRESETS[0];
  const fromDev = world?.devices[from];
  const ownAddrs = known.filter((k) => k.deviceId === from);
  const portNum = preset.custom ? Number(port) : preset.port;
  const dstOk = looksLikeIp(dst);
  const portOk = !preset.custom || (Number.isInteger(portNum) && (portNum ?? 0) >= 1 && (portNum ?? 0) <= 65535);

  const run = () => {
    setError('');
    setResult(null);
    if (!fromDev) { setError('Choose where the packet starts.'); return; }
    if (!dstOk) { setError('Type a destination address like 60.50.40.2, or pick one from the list.'); return; }
    if (!portOk) { setError('The port must be a number from 1 to 65535.'); return; }
    let app: AppData | undefined;
    if (presetId === 'snmp') app = { kind: 'snmp', op: 'get', community: community || 'public', oid: '1.3.6.1.2.1.1.1.0' };
    if (presetId === 'syslog') app = { kind: 'syslog', severity: 6, mnemonic: 'SYS-6-TEST', text: 'Test message from the packet walkthrough' };
    const spec: FlowSpec = { fromDeviceId: from, dst: dst.trim(), proto: preset.proto, dport: preset.proto === 'icmp' ? undefined : portNum, app };
    if (srcAddr && fromDev.kind !== 'pc') spec.srcAddr = srcAddr;
    try {
      const r = lab.trace(spec);
      if (r && 'error' in r) setError(r.error);
      else if (r) setResult(r);
      else setError('The lab gave no answer.');
    } catch (e) {
      setError(`The walkthrough failed: ${errorText(e)}`);
    }
  };

  if (!world || devices.length === 0) return <p className="muted">There are no devices on the bench.</p>;
  const sym = result ? SYMBOL[result.symbol] ?? SYMBOL['.'] : null;
  return (
    <div className="nl-tool stack">
      <p className="muted">Follow one packet through the network, step by step. Each step says what a device did with it, and why.</p>
      <div className="nl-form">
        <label className="field">
          <span>1. Start at</span>
          <select value={from} onChange={(e) => { setFrom(e.target.value); setSrcAddr(''); }} data-autofocus>
            {devices.map((d) => <option key={d.id} value={d.id}>{d.label} ({d.kind === 'pc' ? 'PC' : d.kind})</option>)}
          </select>
        </label>
        {fromDev && fromDev.kind !== 'pc' && ownAddrs.length > 0 ? (
          <label className="field">
            <span>Source address <span className="muted">(like “ping … source”)</span></span>
            <select value={srcAddr} onChange={(e) => setSrcAddr(e.target.value)}>
              <option value="">Automatic — the interface the packet leaves from</option>
              {ownAddrs.map((a) => <option key={a.address} value={a.address}>{a.text}</option>)}
            </select>
          </label>
        ) : null}
        <label className="field">
          <span>2. Send to address</span>
          <input type="text" inputMode="decimal" className="input mono" value={dst} onChange={(e) => setDst(e.target.value)} placeholder="e.g. 60.50.40.2" aria-invalid={dst !== '' && !dstOk} />
        </label>
        <label className="field">
          <span>…or pick a known address</span>
          <select value={known.some((k) => k.address === dst) ? dst : ''} onChange={(e) => { if (e.target.value) setDst(e.target.value); }}>
            <option value="">{known.length ? 'Choose…' : 'No addresses configured yet'}</option>
            {known.map((k) => <option key={`${k.deviceId}-${k.address}`} value={k.address}>{k.text}</option>)}
          </select>
        </label>
        <label className="field">
          <span>3. Traffic</span>
          <select value={presetId} onChange={(e) => setPresetId(e.target.value)}>
            {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </label>
        {preset.custom ? (
          <label className="field">
            <span>{preset.proto.toUpperCase()} port</span>
            <input type="number" min={1} max={65535} className="input mono" value={port} onChange={(e) => setPort(e.target.value)} aria-invalid={!portOk} />
          </label>
        ) : null}
        {presetId === 'snmp' ? (
          <label className="field">
            <span>SNMP community</span>
            <input type="text" className="input mono" value={community} onChange={(e) => setCommunity(e.target.value)} />
          </label>
        ) : null}
      </div>
      <div className="row">
        <button type="button" className="btn btn-primary btn-lg" onClick={run}>▶ Send the packet</button>
      </div>
      {error ? <p className="note bad" role="alert">{error}</p> : null}
      {result && sym ? (
        <div className="nl-walk-result stack" aria-live="polite">
          <div className="nl-verdict-box" data-state={sym.state}>
            <span className="nl-verdict-word"><span aria-hidden="true">{sym.icon}</span> {sym.word}</span>
            <p>{result.summary}</p>
          </div>
          <section aria-labelledby="walk-fwd">
            <h3 id="walk-fwd" className="nl-walk-h">The way there</h3>
            <TraceSteps steps={result.forward?.steps} deviceLabel={label} />
            <DeliveryFacts d={result.forward} deviceLabel={label} />
          </section>
          {result.reverse ? (
            <section aria-labelledby="walk-rev">
              <h3 id="walk-rev" className="nl-walk-h">The way back (the reply)</h3>
              <TraceSteps steps={result.reverse.steps} deviceLabel={label} />
              <DeliveryFacts d={result.reverse} deviceLabel={label} />
            </section>
          ) : result.forward?.ok ? <p className="muted">No reply is expected for this traffic.</p> : null}
        </div>
      ) : null}
    </div>
  );
}

// ───────────────────────── QoS load test ─────────────────────────

interface Row { label: string; proto: 'icmp' | 'tcp' | 'udp'; port?: number; kbps: number }
const DEFAULT_ROWS: Row[] = [
  { label: 'Ping (ICMP)', proto: 'icmp', kbps: 24 },
  { label: 'Telnet (TCP 23)', proto: 'tcp', port: 23, kbps: 20 },
  { label: 'TCP 22 (SSH path only)', proto: 'tcp', port: 22, kbps: 10 },
  { label: 'SNMP (UDP 161)', proto: 'udp', port: 161, kbps: 10 },
  { label: 'Web (TCP 80)', proto: 'tcp', port: 80, kbps: 60 },
  { label: 'FTP (TCP 21)', proto: 'tcp', port: 21, kbps: 40 },
];

function QosLoad() {
  const lab = useLab();
  const state = useLabState();
  const world = state.world;
  const routers = (world?.order ?? []).map((id) => world?.devices[id]).filter((d): d is IosDevice => !!d && d.kind === 'router');
  const [rid, setRid] = useState(routers[0]?.id ?? '');
  const router = routers.find((r) => r.id === rid);
  const ifaces = Object.values(router?.config?.interfaces ?? {}).filter((i) => /^(Serial|GigabitEthernet|FastEthernet)/.test(i.name));
  const preferred = ifaces.find((i) => i.servicePolicyOut) ?? ifaces.find((i) => i.name.startsWith('Serial')) ?? ifaces[0];
  const [ifName, setIfName] = useState(preferred?.name ?? '');
  const iface = ifaces.find((i) => i.name === ifName) ?? preferred;
  const peerAddr = useMemo(() => {
    if (!world || !router || !iface) return '';
    const cable = world.cables.find((c) => (c.a.deviceId === router.id && c.a.port === iface.name) || (c.b.deviceId === router.id && c.b.port === iface.name));
    if (!cable) return '';
    const peer = cable.a.deviceId === router.id && cable.a.port === iface.name ? cable.b : cable.a;
    const pd = world.devices[peer.deviceId];
    if (!pd) return '';
    if (pd.kind === 'pc') return (pd as PcDevice).nic?.address ?? '';
    return (pd as IosDevice).config?.interfaces?.[peer.port]?.ip?.address ?? '';
  }, [world, router, iface]);
  const [dstEdit, setDstEdit] = useState<string | null>(null);
  const dst = dstEdit ?? peerAddr;
  const [rows, setRows] = useState<Row[]>(DEFAULT_ROWS);
  const [result, setResult] = useState<QosLoadResult | null>(null);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState('');
  const total = rows.reduce((s, r) => s + r.kbps, 0);

  const setKbps = (i: number, v: number) => { setRows(rows.map((r, j) => (j === i ? { ...r, kbps: Math.max(0, Math.min(400, Math.round(v) || 0)) } : r))); setStale(true); };

  const run = () => {
    setError('');
    if (!router || !iface) { setError('Choose a router and an interface.'); return; }
    if (!looksLikeIp(dst)) { setError('Type the address of a device on the far side of this link (for example the other router).'); return; }
    try {
      const r = lab.qosLoad({
        deviceId: router.id,
        iface: iface.name,
        offered: rows.filter((r) => r.kbps > 0).map((r) => ({ label: r.label, kbps: r.kbps, flow: { fromDeviceId: router.id, dst, proto: r.proto, dport: r.port } })),
      });
      setResult(r);
      setStale(false);
    } catch (e) {
      setError(`The load test failed: ${errorText(e)}`);
    }
  };

  if (routers.length === 0) return <p className="muted">There is no router on the bench.</p>;
  const scale = Math.max(1, total, result?.linkKbps ?? 0, ...(result?.rows ?? []).map((r) => r.offeredKbps));
  return (
    <div className="nl-tool stack">
      <p className="muted">Estimate how the configured policy shares a busy link. This model does not measure throughput, queue delay, or drops on hardware.</p>
      <div className="nl-form">
        <label className="field">
          <span>Router</span>
          <select value={rid} onChange={(e) => { setRid(e.target.value); setIfName(''); setDstEdit(null); setStale(true); }}>
            {routers.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Outgoing interface</span>
          <select value={iface?.name ?? ''} onChange={(e) => { setIfName(e.target.value); setDstEdit(null); setStale(true); }}>
            {ifaces.map((i) => <option key={i.name} value={i.name}>{i.name}{i.servicePolicyOut ? ` — policy ${i.servicePolicyOut}` : ' — no QoS policy'}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Traffic goes to <span className="muted">(far side of the link)</span></span>
          <input type="text" className="input mono" value={dst} onChange={(e) => { setDstEdit(e.target.value); setStale(true); }} placeholder="e.g. 60.50.30.2" />
        </label>
      </div>
      <fieldset className="nl-qos-rows">
        <legend>Offered traffic, in kbit/s</legend>
        {rows.map((r, i) => (
          <div key={r.label} className="nl-qos-row">
            <label htmlFor={`qos-r${i}`} className="nl-qos-label">{r.label}</label>
            <input id={`qos-r${i}`} type="range" min={0} max={200} step={2} value={r.kbps} onChange={(e) => setKbps(i, Number(e.target.value))} aria-valuetext={`${r.kbps} kilobits per second`} />
            <input type="number" min={0} max={400} className="input nl-qos-num" value={r.kbps} onChange={(e) => setKbps(i, Number(e.target.value))} aria-label={`${r.label}, kbit/s`} />
          </div>
        ))}
        <p className="nl-qos-total">Total offered: <b>{total} kbit/s</b></p>
      </fieldset>
      <div className="row">
        <button type="button" className="btn btn-primary btn-lg" onClick={run}>▶ Run the load test</button>
        <button type="button" className="btn btn-ghost" onClick={() => { setRows(DEFAULT_ROWS); setStale(true); }}>Reset numbers</button>
      </div>
      {error ? <p className="note bad" role="alert">{error}</p> : null}
      {result ? (
        <div className="nl-qos-result stack" aria-live="polite">
          {stale ? <p className="note warn">You changed something. Press Run again to update these results.</p> : null}
          {!result.ok ? <p className="note bad">{result.message ?? 'The load test could not run.'}</p> : (
            <>
              <p className="nl-qos-sum">
                Modeled link rate <b>{result.linkKbps} kbit/s</b>. Shaped to <b>{result.shapedKbps} kbit/s</b>.{' '}
                {result.rows.reduce((s, r) => s + r.offeredKbps, 0) > result.shapedKbps ? 'You offered more than fits, so QoS decides who goes first.' : 'Everything fits, so nothing has to wait.'}
              </p>
              {result.message ? <p className="note">{result.message}</p> : null}
              <ul className="nl-qos-bars">
                {result.rows.map((r, i) => {
                  const lost = Math.max(0, Math.round((r.offeredKbps - r.deliveredKbps) * 10) / 10);
                  return (
                    <li key={i} className="nl-qos-bar">
                      <div className="row nl-qos-bar-head">
                        <strong>{r.label}</strong>
                        <span className="badge nl-qos-class">{r.className}</span>
                      </div>
                      <p className="nl-qos-treat">{r.treatment}</p>
                      <div className="nl-bar-line">
                        <span className="nl-bar-name">Offered</span>
                        <span className="nl-bar"><span className="nl-bar-fill is-offered" style={{ width: `${(r.offeredKbps / scale) * 100}%` }} /></span>
                        <span className="nl-bar-val">{r.offeredKbps} kbit/s</span>
                      </div>
                      <div className="nl-bar-line">
                        <span className="nl-bar-name">Est. served</span>
                        <span className="nl-bar"><span className="nl-bar-fill is-delivered" style={{ width: `${(r.deliveredKbps / scale) * 100}%` }} /></span>
                        <span className="nl-bar-val">{r.deliveredKbps} kbit/s</span>
                      </div>
                      {lost > 0 ? <p className="nl-qos-lost"><Icon name="alert" /> {lost} kbit/s above the modeled allocation.</p> : <p className="nl-qos-ok">✓ Fits within the modeled allocation.</p>}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function Tools() {
  const [tab, setTab] = useState<'walk' | 'qos'>('walk');
  return (
    <div className="nl-tools">
      <Tabs tabs={[{ id: 'walk', label: 'Packet walkthrough', icon: 'path' }, { id: 'qos', label: 'QoS load test', icon: 'layers' }]} value={tab} onChange={setTab} label="Tools" idBase="tools" />
      <TabPanel idBase="tools" id={tab} className="nl-tools-body">
        {tab === 'walk' ? <PacketWalk /> : <QosLoad />}
      </TabPanel>
    </div>
  );
}
