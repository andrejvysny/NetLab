/** Renders the notice bus (src/ui/notify.ts): stackable, dismissible, polite live region. Owned by the app-shell agent. */
import { Icon } from '../icons.tsx';
import type { IconName } from '../icons.tsx';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { dismissNotice, getNotices, subscribeNotices } from '../notify.ts';
import type { Notice } from '../notify.ts';
import { featureIcon, featureLabel } from './ui.tsx';

const KIND: Record<Notice['kind'], { icon: IconName; word: string }> = {
  info: { icon: 'info', word: 'Note' },
  ok: { icon: 'check', word: 'Done' },
  warn: { icon: 'alert', word: 'Careful' },
  bad: { icon: 'x', word: 'Problem' },
  guide: { icon: 'guided', word: 'Guide' },
};

function NoticeCard(props: { n: Notice }) {
  const { n } = props;
  const [paused, setPaused] = useState(false);
  const ttl = n.ttl ?? 6000;
  useEffect(() => {
    if (!ttl || paused) return;
    const t = window.setTimeout(() => dismissNotice(n.id), ttl);
    return () => window.clearTimeout(t);
  }, [ttl, paused, n.id]);
  const k = KIND[n.kind] ?? KIND.info;
  const isGuide = n.kind === 'guide';
  return (
    <div
      className="nl-notice"
      data-kind={n.kind}
      data-feature={isGuide && n.feature ? n.feature : undefined}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <div className="nl-notice-kind">
        <span aria-hidden="true">{isGuide && n.feature ? featureIcon(n.feature) : <Icon name={k.icon} />}</span>
        <span>{isGuide && n.feature ? `${k.word} · ${featureLabel(n.feature)}` : k.word}</span>
      </div>
      <div className="nl-notice-main">
        <strong className="nl-notice-title">{n.title}</strong>
        {n.text ? <p className="nl-notice-text">{n.text}</p> : null}
      </div>
      <button type="button" className="btn btn-sm nl-notice-close" onClick={() => dismissNotice(n.id)} aria-label={`Close notice: ${n.title}`}>
        Close
      </button>
    </div>
  );
}

export function Notices() {
  const [list, setList] = useState<Notice[]>(() => getNotices());
  const [announce, setAnnounce] = useState('');
  const lastId = useRef(0);
  useEffect(() => subscribeNotices((ns) => {
    setList(ns);
    const latest = ns[ns.length - 1];
    if (latest && latest.id > lastId.current) {
      lastId.current = latest.id;
      setAnnounce(`${KIND[latest.kind]?.word ?? ''}: ${latest.title}. ${latest.text ?? ''}`);
    }
  }), []);
  return createPortal(
    <>
      <div className="sr-only nl-live" aria-live="polite" aria-atomic="true">{announce}</div>
      {list.length > 0 ? (
        <section className="nl-notices" aria-label="Messages">
          {list.length > 1 ? (
            <div className="nl-notices-head">
              <span className="muted">{list.length} messages</span>
              <button type="button" className="btn btn-sm" onClick={() => { for (const n of list) dismissNotice(n.id); }}>Close all</button>
            </div>
          ) : null}
          {list.map((n) => <NoticeCard key={n.id} n={n} />)}
        </section>
      ) : null}
    </>,
    document.body,
  );
}
