/** Recognises inline IOS credential commands so unsupported secret formats can be refused. */
const IOS_PROMPT = /^[A-Za-z0-9][\w.\-]*(?:\([\w\-]+\))?[#>]\s*/;

interface Credential { word: 'password' | 'secret' | 'key' | 'community' | 'host'; start: number; text: string }
function credential(line: string): Credential | undefined {
  const prompt = line.trimStart().match(IOS_PROMPT)?.[0] ?? '';
  const offset = line.length - line.trimStart().length + prompt.length;
  const tokens = [...line.slice(offset).matchAll(/\S+/g)];
  let i = 0;
  const is = (at: number, word: string): boolean => !!tokens[at] && word.startsWith(tokens[at][0].toLowerCase());
  const take = (at: number, word: Credential['word']): Credential | undefined => {
    if (!tokens[at]) return undefined;
    const start = offset + tokens[at].index!;
    return { word, start, text: line.slice(start) };
  };
  if (is(i, 'do')) i++;
  if (is(i, 'no')) i++;
  // This also handles credentials embedded in an alias definition.
  while (is(i, 'alias') && ['configure', 'interface', 'exec'].some((mode) => is(i + 1, mode))) i += 3;
  if (is(i, 'no')) i++;
  let j = i;
  if (is(i, 'enable')) j++;
  else if (is(i, 'username')) {
    j += 2;
    if (is(j, 'privilege') && !is(j, 'password')) j += 2;
  }
  for (const word of ['secret', 'password'] as const) if (is(j, word)) {
    // An explicit privilege level is metadata, not the password.
    return take(is(j + 1, 'level') && /^\d+$/.test(tokens[j + 2]?.[0] ?? '') ? j + 3 : j + 1, word);
  }
  if (is(i, 'crypto') && is(i + 1, 'isakmp') && is(i + 2, 'key')) return take(i + 3, 'key');
  if (is(i, 'snmp-server') && is(i + 1, 'community')) return take(i + 2, 'community');
  if (is(i, 'snmp-server') && is(i + 1, 'host')) return take(i + 3, 'host');
  return undefined;
}

/** Warn about imported secrets for which the simulator cannot perform the real authentication. */
export function unsupportedCredentialType(line: string): boolean {
  const c = credential(line);
  if (!c || /^\s*no\s/i.test(line)) return false;
  const value = c.text.trim();
  if (c.word === 'secret') {
    if (/^[58]\s+\S/.test(value)) return true;
    if (!/^9\s+\S/.test(value)) return false;
    const body = /^9\s+\$9\$sim\$([./0-9A-Za-z]*)$/.exec(value)?.[1];
    return body === undefined || body.length % 4 === 1;
  }
  if (c.word === 'key') return /^6\s+\S+\s+(?:a\w*|h\w*)\s/i.test(value);
  return false;
}
export const UNSUPPORTED_CREDENTIAL = '% This encrypted credential is not supported by the simulator. Use a new lab-only credential, not a real password or key.\n';
