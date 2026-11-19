/** A packet's path as a vertical sequence of step cards (used by the report and the packet walkthrough). Owned by the app-shell agent. */
import type { Delivery, TraceStage, TraceStep } from '../../engine/types.ts';
import { featureLabel } from './ui.tsx';

export const STAGE_TEXT: Record<TraceStage, string> = {
  origin: 'Starts here',
  link: 'On the cable',
  switch: 'Switch',
  ingress: 'Arrives',
  'acl-in': 'ACL, inbound',
  decrypt: 'Decrypt (IPsec)',
  'nat-outside': 'NAT, outside → inside',
  local: 'For this device',
  route: 'Routing',
  'nat-inside': 'NAT, inside → outside',
  crypto: 'Crypto map',
  'acl-out': 'ACL, outbound',
  qos: 'QoS',
  egress: 'Leaves',
  deliver: 'Delivered',
  drop: 'Dropped',
};
const VERDICT: Record<TraceStep['verdict'], { icon: string; word: string }> = {
  ok: { icon: '✓', word: 'OK' },
  changed: { icon: '✎', word: 'Changed' },
  drop: { icon: '✗', word: 'Dropped' },
  info: { icon: '•', word: 'Info' },
};

export function TraceSteps(props: { steps: TraceStep[] | undefined; deviceLabel: (id: string) => string; startNo?: number }) {
  const steps = Array.isArray(props.steps) ? props.steps : [];
  if (steps.length === 0) return <p className="muted">No steps were recorded.</p>;
  let prevDevice = '';
  return (
    <ol className="nl-trace" start={props.startNo ?? 1}>
      {steps.map((s, i) => {
        const newDevice = s.deviceId !== prevDevice;
        prevDevice = s.deviceId;
        const v = VERDICT[s.verdict] ?? VERDICT.info;
        return (
          <li key={i} className={`nl-tstep${newDevice ? ' is-newdev' : ''}`} data-feature={s.feature} data-verdict={s.verdict}>
            {newDevice ? <div className="nl-tstep-dev"><span aria-hidden="true">▸</span> {props.deviceLabel(s.deviceId)}</div> : null}
            <div className="nl-tstep-card">
              <div className="nl-tstep-top">
                <span className="nl-tstep-stage">{STAGE_TEXT[s.stage] ?? s.stage}</span>
                <span className="badge nl-fbadge-sm" data-feature={s.feature}>{featureLabel(s.feature)}</span>
                {s.iface ? <span className="nl-tstep-if mono">{s.iface}</span> : null}
                <span className="nl-verdict" data-verdict={s.verdict}><span aria-hidden="true">{v.icon}</span> {v.word}</span>
              </div>
              <p className="nl-tstep-text">{s.text}</p>
              {s.detail ? <p className="nl-tstep-detail mono"><span className="sr-only">Evidence: </span>{s.detail}</p> : null}
              {s.header ? <p className="nl-tstep-header mono"><span className="nl-tstep-hl">Packet</span> {s.header}</p> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** Extra facts about one direction: encrypted, negotiated, QoS classes, where it ended. */
export function DeliveryFacts(props: { d: Delivery | undefined; deviceLabel: (id: string) => string }) {
  const d = props.d;
  if (!d) return null;
  const facts: string[] = [];
  if (d.encrypted) facts.push('Crossed a link inside modeled ESP (no on-wire cryptography).');
  if (d.negotiated) facts.push('This packet started a new IPsec tunnel. On real routers the first packet is often lost while the tunnel is built.');
  for (const q of d.qos ?? []) facts.push(`QoS on ${props.deviceLabel(q.deviceId)} ${q.iface}: ${q.policy} → ${q.className}${q.childPolicy ? ` → ${q.childPolicy} → ${q.childClass ?? 'class-default'}` : ''}`);
  if (!d.ok && d.reasonText) facts.push(`✗ Stopped${d.atDeviceId ? ` at ${props.deviceLabel(d.atDeviceId)}` : ''}: ${d.reasonText}`);
  if (d.ok && d.received) facts.push(`✓ Arrived as ${d.received.proto.toUpperCase()} ${d.received.src} → ${d.received.dst}.`);
  if (!facts.length) return null;
  return <ul className="nl-facts">{facts.map((f, i) => <li key={i}>{f}</li>)}</ul>;
}
