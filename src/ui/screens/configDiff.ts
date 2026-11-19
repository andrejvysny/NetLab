/**
 * Line-level comparison of a model configuration with the student's running configuration.
 * Lines are compared by their section path (e.g. "interface Serial0/1/0 › clock rate 128000"), so the same
 * sub-command under two different interfaces is not confused. Order is NOT compared (the checks test behaviour).
 * IOS boilerplate (version, boot markers, unused interfaces…) is shown as neutral, never as "extra".
 * Owned by the app-shell agent.
 */

export interface DiffLine { text: string; status: 'same' | 'missing' | 'extra' | 'neutral' }
export interface ConfigDiff { model: DiffLine[]; student: DiffLine[]; missing: number; extra: number }

const SKIP_TOP = [
  /^building configuration/i, /^current configuration/i, /^last configuration change/i, /^nvram config last updated/i,
  /^version\s/, /^service (timestamps|password-encryption|config)/, /^no service /, /^platform /, /^no platform /, /^boot-(start|end)-marker/, /^boot /,
  /^license /, /^memory /, /^diagnostic /, /^spanning-tree /, /^redundancy/, /^mode none/, /^control-plane/, /^ip forward-protocol/,
  /^no ip http/, /^ip http /, /^ip tftp/, /^login on-success/, /^multilink /, /^hw-module/, /^subscriber /, /^no aaa new-model/,
  /^call-home/, /^transceiver/, /^vrf definition/, /^crypto pki/, /^no device-tracking/, /^ip ssh /, /^line (con|aux) 0/, /^end$/,
  /^startup-config is not present/,
];
const SKIP_CHILD = [/^stopbits /, /^transport input none/, /^negotiation auto/, /^no mop /, /^media-type /, /^no ip address$/, /^shutdown$/, /^speed auto/, /^duplex auto/, /^description .*unused/i];

function norm(s: string): string {
  return s.trim().replace(/\s+/g, ' ')
    // ACL sequence numbers inside named ACLs are shown by IOS but not typed by the student
    .replace(/^\d+ (permit|deny|remark) /, '$1 ')
    // "no ip domain lookup" and "no ip domain-lookup" are the same command
    .replace(/^no ip domain lookup$/, 'no ip domain-lookup')
    // "logging host x" == "logging x"
    .replace(/^logging host /, 'logging ')
    // standard ACL: "access-list 10 permit 1.2.3.4" == "access-list 10 permit host 1.2.3.4"
    .replace(/^(access-list \d{1,2} (?:permit|deny)) host (\S+)$/, '$1 $2')
    .replace(/^(permit|deny) host (\d+\.\d+\.\d+\.\d+)$/, '$1 $2');
}

interface Parsed { text: string; key: string; top: string; isChild: boolean; skip: boolean }

function parse(text: string): Parsed[] {
  const out: Parsed[] = [];
  const stack: { indent: number; text: string }[] = [];
  for (const raw of (text ?? '').split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    const t = line.trim();
    if (!t || t === '!' || t.startsWith('!')) {
      // a "!" closes every open section in running-config output
      if (t === '!' || t.startsWith('!')) stack.length = 0;
      continue;
    }
    const indent = line.length - line.trimStart().length;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const n = norm(t);
    const key = [...stack.map((s) => s.text), n].join(' › ');
    const top = stack.length ? stack[0].text : n;
    const isChild = stack.length > 0;
    const skip = isChild ? SKIP_CHILD.some((r) => r.test(n)) || SKIP_TOP.some((r) => r.test(top)) : SKIP_TOP.some((r) => r.test(n));
    out.push({ text: line, key, top, isChild, skip });
    stack.push({ indent, text: n });
  }
  return out;
}

export function diffConfigs(model: string, student: string): ConfigDiff {
  const m = parse(model);
  const s = parse(student);
  const mKeys = new Set(m.map((x) => x.key));
  const sKeys = new Set(s.map((x) => x.key));
  const mTops = new Set(m.filter((x) => !x.isChild).map((x) => x.top));
  // A student section (e.g. an unused interface) that does not exist in the model and only holds boilerplate is neutral.
  const sectionHasContent = new Map<string, boolean>();
  for (const x of s) if (x.isChild && !x.skip) sectionHasContent.set(x.top, true);
  const modelLines: DiffLine[] = m.map((x) => ({ text: x.text, status: x.skip ? 'neutral' : sKeys.has(x.key) ? 'same' : 'missing' }));
  const studentLines: DiffLine[] = s.map((x) => {
    if (x.skip) return { text: x.text, status: 'neutral' };
    if (mKeys.has(x.key)) return { text: x.text, status: 'same' };
    const sectionHeader = !x.isChild && /^interface /.test(x.top) && !mTops.has(x.top) && !sectionHasContent.get(x.top);
    if (sectionHeader) return { text: x.text, status: 'neutral' };
    return { text: x.text, status: 'extra' };
  });
  return {
    model: modelLines,
    student: studentLines,
    missing: modelLines.filter((l) => l.status === 'missing').length,
    extra: studentLines.filter((l) => l.status === 'extra').length,
  };
}
