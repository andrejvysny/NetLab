/** PC window: network settings, command prompt, serial terminal, syslog server, SNMP tool, services. */
import { useEffect, useId, useState } from 'react';
import type React from 'react';
import type { ActionResult, GuideBlock, SnmpReply } from '../../../engine/labapi.ts';
import type { PcDevice, PcServices } from '../../../engine/types.ts';
import { useLab, useLabState } from '../../labContext.tsx';
import { consoleNeededText, useBench } from '../benchContext.ts';
import type { ConsoleLink } from '../benchContext.ts';
import { attempt, errText } from '../util.ts';
import { GuideCard, TerminalView } from './TerminalView.tsx';

type PcTab = 'net' | 'cmd' | 'term' | 'syslog' | 'snmp' | 'services';
const TABS: { id: PcTab; label: string }[] = [
  { id: 'net', label: 'Network' },
  { id: 'cmd', label: 'Command Prompt' },
  { id: 'term', label: 'Terminal' },
  { id: 'syslog', label: 'Syslog' },
  { id: 'snmp', label: 'SNMP' },
  { id: 'services', label: 'Services' },
];
const SEVERITY = ['emergency', 'alert', 'critical', 'error', 'warning', 'notice', 'info', 'debug'];
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

function Switch({ on, onChange, label }: { on: boolean; onChange: (on: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className={`wb-switch${on ? ' is-on' : ''}`} onClick={() => onChange(!on)}>
      <span className="wb-switch-knob" aria-hidden="true" />
      <span className="wb-switch-text">{on ? 'On' : 'Off'}</span>
    </button>
  );
}

function ResultNote({ result }: { result: { ok: boolean; text: string; blocked?: GuideBlock } | null }) {
  if (!result) return null;
  if (result.blocked) return <GuideCard block={result.blocked} />;
  return <div className={`note ${result.ok ? 'ok' : 'bad'}`} role="status">{result.text}</div>;
}

function NetworkTab({ pc }: { pc: PcDevice }) {
  const lab = useLab();
  const nic = pc.nic ?? { mode: 'dhcp' as const, mac: '' };
  const [mode, setMode] = useState<'static' | 'dhcp'>(nic.mode === 'static' ? 'static' : 'dhcp');
  const [address, setAddress] = useState(nic.mode === 'static' ? nic.address ?? '' : '');
  const [mask, setMask] = useState(nic.mode === 'static' ? nic.mask ?? '' : '');
  const [gateway, setGateway] = useState(nic.mode === 'static' ? nic.gateway ?? '' : '');
  const [dns, setDns] = useState(nic.mode === 'static' ? nic.dns ?? '' : '');
  const [result, setResult] = useState<{ ok: boolean; text: string; blocked?: GuideBlock } | null>(null);
  const uid = useId();

  const bad = {
    address: address.trim() !== '' && !IPV4.test(address.trim()),
    mask: mask.trim() !== '' && !IPV4.test(mask.trim()),
    gateway: gateway.trim() !== '' && !IPV4.test(gateway.trim()),
    dns: dns.trim() !== '' && !IPV4.test(dns.trim()),
  };
  const canSave = address.trim() !== '' && mask.trim() !== '' && !bad.address && !bad.mask && !bad.gateway && !bad.dns;

  const finish = (res: ActionResult, okText: () => string, failText: string) => {
    if (res?.blocked) { setResult({ ok: false, text: res.blocked.reason, blocked: res.blocked }); return; }
    if (res?.ok) setResult({ ok: true, text: okText() });
    else setResult({ ok: false, text: res?.message || failText });
  };
  const liveNic = () => {
    const d = attempt(() => lab.getState().world?.devices[pc.id], undefined);
    return d && d.kind === 'pc' ? d.nic : undefined;
  };
  const saveStatic = () => {
    let res: ActionResult;
    try {
      res = lab.setPcNic(pc.id, {
        mode: 'static', address: address.trim(), mask: mask.trim(),
        gateway: gateway.trim() || undefined, dns: dns.trim() || undefined,
      });
    } catch (e) { res = { ok: false, message: `The settings could not be saved: ${errText(e)}` }; }
    finish(res, () => `Saved. ${pc.label} now uses ${address.trim()} with mask ${mask.trim()}${gateway.trim() ? ` and gateway ${gateway.trim()}` : ' and no gateway'}.`, 'The settings were not accepted.');
  };
  const askDhcp = () => {
    let res: ActionResult;
    try { res = lab.setPcNic(pc.id, { mode: 'dhcp' }); }
    catch (e) { res = { ok: false, message: `DHCP could not be started: ${errText(e)}` }; }
    finish(res, () => {
      const n = liveNic();
      if (!n?.address) return res.message || 'DHCP is on, but no address was received yet.';
      return `Address received: ${n.address} with mask ${n.mask ?? '?'}${n.gateway ? `, gateway ${n.gateway}` : ', no gateway'}${n.dhcpServer ? `. DHCP server: ${n.dhcpServer}` : ''}.`;
    }, 'No DHCP server answered. This PC has no address.');
  };

  return (
    <div className="wb-pane stack">
      <div className="wb-pane-head">
        <h3>Network settings</h3>
        <span className="muted">Adapter Ethernet0 · MAC <span className="mono">{nic.mac || 'unknown'}</span></span>
      </div>

      <dl className="wb-facts" aria-label="Current network settings">
        <div><dt>Mode</dt><dd>{nic.mode === 'static' ? 'Static (typed by hand)' : 'DHCP (automatic)'}</dd></div>
        <div><dt>IP address</dt><dd className="mono">{nic.address || 'none'}</dd></div>
        <div><dt>Subnet mask</dt><dd className="mono">{nic.mask || 'none'}</dd></div>
        <div><dt>Default gateway</dt><dd className="mono">{nic.gateway || 'none'}</dd></div>
        {nic.mode === 'dhcp' && <div><dt>DHCP server</dt><dd className="mono">{nic.dhcpServer || 'none'}</dd></div>}
        {nic.dns ? <div><dt>DNS server</dt><dd className="mono">{nic.dns}</dd></div> : null}
      </dl>

      <fieldset className="wb-choice">
        <legend>How does this PC get its address?</legend>
        <label className={`wb-choice-item${mode === 'static' ? ' is-on' : ''}`}>
          <input type="radio" name={`${uid}-mode`} checked={mode === 'static'} onChange={() => { setMode('static'); setResult(null); }} />
          <span><strong>Static</strong> — I type the address</span>
        </label>
        <label className={`wb-choice-item${mode === 'dhcp' ? ' is-on' : ''}`}>
          <input type="radio" name={`${uid}-mode`} checked={mode === 'dhcp'} onChange={() => { setMode('dhcp'); setResult(null); }} />
          <span><strong>DHCP</strong> — a DHCP server gives the address</span>
        </label>
      </fieldset>

      {mode === 'static' ? (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); if (canSave) saveStatic(); }}>
          <div className="wb-form-grid">
            <label className="field">IP address
              <input className="mono" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="192.168.1.10" inputMode="decimal" autoComplete="off" spellCheck={false} aria-invalid={bad.address} />
              {bad.address && <span className="wb-field-err">Use four numbers with dots, like 192.168.1.10</span>}
            </label>
            <label className="field">Subnet mask
              <input className="mono" value={mask} onChange={(e) => setMask(e.target.value)} placeholder="255.255.255.0" inputMode="decimal" autoComplete="off" spellCheck={false} aria-invalid={bad.mask} />
              {bad.mask && <span className="wb-field-err">Use four numbers with dots, like 255.255.255.0</span>}
            </label>
            <label className="field">Default gateway
              <input className="mono" value={gateway} onChange={(e) => setGateway(e.target.value)} placeholder="192.168.1.1" inputMode="decimal" autoComplete="off" spellCheck={false} aria-invalid={bad.gateway} />
              {bad.gateway && <span className="wb-field-err">Use four numbers with dots, or leave it empty</span>}
            </label>
            <label className="field">DNS server (optional)
              <input className="mono" value={dns} onChange={(e) => setDns(e.target.value)} placeholder="" inputMode="decimal" autoComplete="off" spellCheck={false} aria-invalid={bad.dns} />
              {bad.dns && <span className="wb-field-err">Use four numbers with dots, or leave it empty</span>}
            </label>
          </div>
          <div className="row">
            <button type="submit" className="btn btn-primary" disabled={!canSave}>Save static address</button>
            {!canSave && <span className="muted">Fill in the IP address and the subnet mask.</span>}
          </div>
        </form>
      ) : (
        <div className="row">
          <button type="button" className="btn btn-primary" onClick={askDhcp}>
            {nic.mode === 'dhcp' && nic.address ? 'Ask for an address again (renew)' : 'Ask the DHCP server for an address'}
          </button>
        </div>
      )}
      <ResultNote result={result} />
    </div>
  );
}

function SyslogTab({ pc }: { pc: PcDevice }) {
  const lab = useLab();
  const on = !!pc.services?.syslog;
  const rows = Array.isArray(pc.runtime?.syslog) ? pc.runtime.syslog : [];
  return (
    <div className="wb-pane stack">
      <div className="wb-pane-head">
        <h3>Syslog server</h3>
        <Switch on={on} label="Syslog server" onChange={(v) => attempt(() => lab.setPcService(pc.id, 'syslog', v), undefined)} />
        <span className="muted">{on ? 'Listening on UDP port 514.' : 'The server is off. Messages sent to this PC are lost.'}</span>
      </div>
      <div className="row wb-list-head">
        <strong>{rows.length} message{rows.length === 1 ? '' : 's'} received</strong>
        <button type="button" className="btn btn-sm" disabled={!rows.length} onClick={() => attempt(() => lab.clearPcLog(pc.id, 'syslog'), undefined)}>Clear list</button>
      </div>
      {rows.length === 0 ? (
        <p className="wb-empty">No messages yet.</p>
      ) : (
        <div className="wb-table-wrap" tabIndex={0} aria-label="Received syslog messages">
          <table className="wb-table">
            <thead><tr><th>No.</th><th>From</th><th>Level</th><th>Message</th></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td>{i + 1}</td>
                  <td className="mono">{r?.from ?? '?'}</td>
                  <td>{r?.severity ?? '?'} {SEVERITY[Number(r?.severity)] ? `(${SEVERITY[Number(r?.severity)]})` : ''}</td>
                  <td className="mono wb-wrap">{r?.mnemonic ? `%${String(r.mnemonic).replace(/^%/, '')}: ` : ''}{r?.text ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

interface SnmpLog { id: number; op: 'get' | 'set'; host: string; oid: string; value?: string; reply: SnmpReply }
function SnmpTab({ pc }: { pc: PcDevice }) {
  const lab = useLab();
  const [host, setHost] = useState('');
  const [community, setCommunity] = useState('');
  const [op, setOp] = useState<'get' | 'set'>('get');
  const [oid, setOid] = useState('sysName.0');
  const [value, setValue] = useState('');
  const [log, setLog] = useState<SnmpLog[]>([]);
  const uid = useId();
  const traps = Array.isArray(pc.runtime?.traps) ? pc.runtime.traps : [];
  const ready = host.trim() !== '' && community.trim() !== '' && oid.trim() !== '' && (op === 'get' || value !== '');

  const send = () => {
    let reply: SnmpReply;
    try {
      const r = lab.pcSnmp(pc.id, { host: host.trim(), community: community.trim(), op, oid: oid.trim(), value: op === 'set' ? value : undefined });
      reply = { ok: !!r?.ok, text: typeof r?.text === 'string' && r.text ? r.text : r?.ok ? 'Answer received.' : 'No answer (timeout).' };
    } catch (e) { reply = { ok: false, text: `The request could not be sent: ${errText(e)}` }; }
    setLog((l) => [{ id: (l[0]?.id ?? 0) + 1, op, host: host.trim(), oid: oid.trim(), value: op === 'set' ? value : undefined, reply }, ...l].slice(0, 30));
  };

  return (
    <div className="wb-pane stack">
      <div className="wb-pane-head"><h3>SNMP tool</h3><span className="muted">Read (get) or change (set) one value on a router.</span></div>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); if (ready) send(); }}>
        <div className="wb-form-grid">
          <label className="field">Router address (host)
            <input className="mono" value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.1" autoComplete="off" spellCheck={false} />
          </label>
          <label className="field">Community (the SNMP password)
            <input className="mono" type="password" value={community} onChange={(e) => setCommunity(e.target.value)} autoComplete="off" spellCheck={false} />
          </label>
          <fieldset className="wb-choice wb-choice--inline">
            <legend>Operation</legend>
            <label className={`wb-choice-item${op === 'get' ? ' is-on' : ''}`}><input type="radio" name={`${uid}-op`} checked={op === 'get'} onChange={() => setOp('get')} /><span><strong>Get</strong> — read</span></label>
            <label className={`wb-choice-item${op === 'set' ? ' is-on' : ''}`}><input type="radio" name={`${uid}-op`} checked={op === 'set'} onChange={() => setOp('set')} /><span><strong>Set</strong> — write</span></label>
          </fieldset>
          <label className="field">OID (which value)
            <input className="mono" value={oid} onChange={(e) => setOid(e.target.value)} list={`${uid}-oids`} autoComplete="off" spellCheck={false} />
            <datalist id={`${uid}-oids`}>
              <option value="sysName.0" /><option value="sysLocation.0" /><option value="sysContact.0" /><option value="sysDescr.0" /><option value="sysUpTime.0" />
            </datalist>
          </label>
          {op === 'set' && (
            <label className="field">New value
              <input className="mono" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="off" spellCheck={false} />
            </label>
          )}
        </div>
        <div className="row">
          <button type="submit" className="btn btn-primary" disabled={!ready}>{op === 'get' ? 'Send get request' : 'Send set request'}</button>
          {!ready && <span className="muted">Fill in host, community and OID{op === 'set' ? ', and the new value' : ''}.</span>}
        </div>
      </form>

      {log.length > 0 && (
        <div className="stack wb-tight" aria-live="polite">
          <div className="row wb-list-head"><strong>Answers</strong><button type="button" className="btn btn-sm" onClick={() => setLog([])}>Clear list</button></div>
          {log.map((l) => (
            <div key={l.id} className={`note ${l.reply.ok ? 'ok' : 'bad'}`}>
              <div className="wb-snmp-req"><strong>{l.reply.ok ? 'Answer' : 'No answer'}</strong> · {l.op} <span className="mono">{l.oid}</span>{l.op === 'set' ? <> = <span className="mono">{l.value}</span></> : null} on <span className="mono">{l.host}</span></div>
              <pre className="wb-pre">{l.reply.text}</pre>
            </div>
          ))}
        </div>
      )}

      <div className="row wb-list-head">
        <strong>{traps.length} trap{traps.length === 1 ? '' : 's'} received</strong>
        <button type="button" className="btn btn-sm" disabled={!traps.length} onClick={() => attempt(() => lab.clearPcLog(pc.id, 'traps'), undefined)}>Clear list</button>
      </div>
      {traps.length === 0 ? <p className="wb-empty">No traps yet.</p> : (
        <div className="wb-table-wrap" tabIndex={0} aria-label="Received SNMP traps">
          <table className="wb-table">
            <thead><tr><th>No.</th><th>From</th><th>Trap</th></tr></thead>
            <tbody>
              {traps.map((t, i) => (
                <tr key={i}><td>{i + 1}</td><td className="mono">{t?.from ?? '?'}</td><td className="mono wb-wrap">{t?.text ?? ''}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ServicesTab({ pc }: { pc: PcDevice }) {
  const lab = useLab();
  const items: { key: keyof PcServices; name: string; text: string }[] = [
    { key: 'http', name: 'HTTP server', text: 'Web server, TCP port 80.' },
    { key: 'ftp', name: 'FTP server', text: 'File server, TCP port 21.' },
    { key: 'telnet', name: 'Telnet server', text: 'Remote login to this PC, TCP port 23.' },
  ];
  return (
    <div className="wb-pane stack">
      <div className="wb-pane-head"><h3>Services on {pc.label}</h3><span className="muted">A service that is off does not answer.</span></div>
      <ul className="wb-services">
        {items.map((it) => {
          const on = !!pc.services?.[it.key];
          return (
            <li key={it.key} className="wb-service">
              <div><strong>{it.name}</strong><div className="muted">{it.text}</div></div>
              <Switch on={on} label={it.name} onChange={(v) => attempt(() => lab.setPcService(pc.id, it.key, v), undefined)} />
            </li>
          );
        })}
      </ul>
      <p className="muted">The syslog server has its own tab.</p>
    </div>
  );
}

function ConsoleTab({ pc, visible, focusToken }: { pc: PcDevice; visible: boolean; focusToken: number }) {
  const lab = useLab();
  const state = useLabState();
  const bench = useBench();
  const target = attempt(() => lab.consoleTargetOf(pc.id), null);
  const [connection, setConnection] = useState<{ target: string; link: ConsoleLink } | null>(null);
  const link = connection?.target === target ? connection?.link : undefined;
  const connect = (id: string) => setConnection({ target: id, link: bench.connectConsole(id) });
  const targetLabel = target ? state.world?.devices[target]?.label ?? target : '';

  useEffect(() => {
    if (!visible) return;
    if (!target) { setConnection(null); return; }
    connect(target);
    // Re-run when the cable moves to another device.
  }, [visible, target, bench]);

  if (!target) {
    return (
      <div className="wb-pane stack">
        <div className="wb-pane-head"><h3>Serial terminal</h3></div>
        <div className="note warn">
          <strong>Nothing is connected to {pc.ports?.find((p) => p.kind === 'rs232')?.short ?? 'COM1'}.</strong>
          <p>Plug a Console (rollover) cable from this PC into the CON port of a router or a switch. Then come back to this tab.</p>
        </div>
        <button type="button" className="btn" onClick={() => bench.pickConsoleCable()}>Pick up the console cable</button>
      </div>
    );
  }
  if (!link) return <div className="wb-pane"><p className="muted">Connecting…</p></div>;
  if (!link.ok) {
    return (
      <div className="wb-pane stack">
        <div className="note bad"><strong>The terminal could not connect to {targetLabel}.</strong><p>{link.message || consoleNeededText(targetLabel)}</p></div>
        <button type="button" className="btn" onClick={() => connect(target)}>Try again</button>
      </div>
    );
  }
  return (
    <TerminalView
      model={link.model}
      variant="ios"
      visible={visible}
      focusToken={visible ? focusToken : undefined}
      label={`Console of ${targetLabel}`}
      onReopen={() => connect(target)}
    />
  );
}

export function PcWindow({ pcId, focusToken }: { pcId: string; focusToken: number }) {
  const state = useLabState();
  const bench = useBench();
  const [tab, setTab] = useState<PcTab>('net');
  const [seen, setSeen] = useState<Record<string, boolean>>({ net: true });
  const uid = useId();
  const dev = state.world?.devices[pcId];
  const select = (t: PcTab) => { setTab(t); setSeen((s) => (s[t] ? s : { ...s, [t]: true })); };
  // Opened or picked in the dock: the keyboard lands on the current tab (the terminal tabs take it themselves).
  useEffect(() => {
    if (tab === 'cmd' || tab === 'term') return;
    document.getElementById(`${uid}-tab-${tab}`)?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusToken]);
  const onTabKey = (e: React.KeyboardEvent) => {
    const i = TABS.findIndex((t) => t.id === tab);
    const next = e.key === 'ArrowRight' ? TABS[(i + 1) % TABS.length] : e.key === 'ArrowLeft' ? TABS[(i + TABS.length - 1) % TABS.length] : null;
    if (!next) return;
    e.preventDefault();
    select(next.id);
    requestAnimationFrame(() => document.getElementById(`${uid}-tab-${next.id}`)?.focus());
  };
  if (!dev || dev.kind !== 'pc') return <div className="wb-pane"><p className="note warn">This PC is not on the bench any more.</p></div>;
  const pc = dev;
  const syslogCount = Array.isArray(pc.runtime?.syslog) ? pc.runtime.syslog.length : 0;

  return (
    <div className="wb-pc">
      <div className="wb-tabs" role="tablist" aria-label={`${pc.label} tools`} onKeyDown={onTabKey}>
        {TABS.map((t) => (
          <button
            key={t.id} id={`${uid}-tab-${t.id}`} type="button" role="tab" aria-selected={tab === t.id} aria-controls={`${uid}-panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1} className={`wb-tab${tab === t.id ? ' is-on' : ''}`} onClick={() => select(t.id)}
          >
            {t.label}{t.id === 'syslog' && syslogCount > 0 ? <span className="wb-tab-count">{syslogCount}</span> : null}
          </button>
        ))}
      </div>
      {TABS.map((t) => (
        <div key={t.id} id={`${uid}-panel-${t.id}`} role="tabpanel" aria-labelledby={`${uid}-tab-${t.id}`} hidden={tab !== t.id} className={`wb-tabpanel wb-tabpanel--${t.id}`}>
          {!seen[t.id] ? null :
            t.id === 'net' ? <NetworkTab pc={pc} /> :
            t.id === 'cmd' ? <TerminalView model={bench.registry.pc(pc.id, pc.os === 'macos' ? 'macos' : 'windows', pc.label)} variant="cmd" visible={tab === 'cmd'} focusToken={tab === 'cmd' ? focusToken : undefined} label={`Command prompt of ${pc.label}`} /> :
            t.id === 'term' ? <ConsoleTab pc={pc} visible={tab === 'term'} focusToken={focusToken} /> :
            t.id === 'syslog' ? <SyslogTab pc={pc} /> :
            t.id === 'snmp' ? <SnmpTab pc={pc} /> :
            <ServicesTab pc={pc} />}
        </div>
      ))}
    </div>
  );
}
