/** Tiny notice bus shared by all UI code. The app shell renders the notices; any component may raise one. Owned by the orchestrator. */
export interface Notice {
  id: number;
  kind: 'info' | 'ok' | 'warn' | 'bad' | 'guide';
  title: string;
  text?: string;
  /** Feature colour for 'guide' notices (see theme.css data-feature). */
  feature?: string;
  /** Milliseconds before auto-dismiss; 0 = stays until closed. Default 6000 (guide/bad: 0). */
  ttl?: number;
}
type Listener = (notices: Notice[]) => void;
let notices: Notice[] = [];
let nextId = 1;
const listeners = new Set<Listener>();
const emit = () => { for (const l of listeners) l(notices); };

export function notify(n: Omit<Notice, 'id'>): number {
  const notice: Notice = { ttl: n.kind === 'guide' || n.kind === 'bad' ? 0 : 6000, ...n, id: nextId++ };
  notices = [...notices.slice(-4), notice];
  emit();
  return notice.id;
}
export function dismissNotice(id: number): void { notices = notices.filter((n) => n.id !== id); emit(); }
export function getNotices(): Notice[] { return notices; }
export function subscribeNotices(listener: Listener): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
