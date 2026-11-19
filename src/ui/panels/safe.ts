/**
 * Guarded browser helpers. The app may run in a sandboxed iframe where localStorage, the clipboard and
 * downloads throw or silently do nothing. Every helper returns a result instead of throwing.
 * Owned by the app-shell agent.
 */

/** Run `fn`; on any exception return `fallback`. */
export function safeCall<T>(fn: () => T, fallback: T): T {
  try {
    const v = fn();
    return v === undefined || v === null ? fallback : v;
  } catch {
    return fallback;
  }
}

export function storageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
export function storageSet(key: string, value: string): boolean {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/** Try to download a text file. Returns false when the browser refused. (A sandbox may also ignore it silently.) */
export function downloadText(filename: string, text: string, mime = 'text/plain'): boolean {
  try {
    const blob = new Blob([text], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => { try { URL.revokeObjectURL(url); } catch { /* ignore */ } }, 4000);
    return true;
  } catch {
    return false;
  }
}

/** Copy text. Tries the async clipboard API first, then the old execCommand trick. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/** Select the text inside an element so the user can press Ctrl+C when copying is blocked. */
export function selectElementText(el: Element | null): void {
  if (!el) return;
  try {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  } catch {
    /* ignore */
  }
}

export function readFileText(file: File): Promise<string> {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ''));
    r.onerror = () => reject(r.error ?? new Error('Could not read the file.'));
    r.readAsText(file);
  });
}

/** Safe file name part from a title. */
export function fileSlug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'lab';
}

export function todayStamp(): string {
  try {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  } catch {
    return 'export';
  }
}

export function formatDateTime(ms: number): string {
  try {
    return new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

/** "1 h 05 min" / "12 min" / "under 1 min". roundUp is for countdowns (3 h 00 min at the start, not 2 h 59 min). */
export function formatDuration(ms: number, roundUp = false): string {
  const totalMin = Math.max(0, roundUp ? Math.ceil(ms / 60000) : Math.floor(ms / 60000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0 && m === 0) return 'under 1 min';
  if (h === 0) return `${m} min`;
  return `${h} h ${String(m).padStart(2, '0')} min`;
}

export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/** Plain IPv4 check for form fields (the UI does not import engine helpers). */
export function looksLikeIp(s: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s.trim());
  return !!m && m.slice(1).every((o) => Number(o) <= 255);
}
