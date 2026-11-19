/**
 * IPsec (IKEv1 crypto maps) — feature 'ipsec'.
 *
 * Global:      crypto isakmp policy <1-10000> · crypto isakmp key … · [no] crypto isakmp enable
 *              crypto ipsec transform-set <name> <transforms…> · crypto ipsec security-association lifetime …
 *              crypto map <name> <seq> [ipsec-isakmp] · no forms
 * Sub-modes:   config-isakmp (encryption/hash/authentication/group/lifetime), cfg-crypto-trans (mode),
 *              config-crypto-map (match address, set peer/transform-set/pfs/security-association lifetime, qos pre-classify, description)
 * Interface:   [no] crypto map <name>
 * Priv EXEC:   clear crypto sa | isakmp | session
 *
 * session.ctx keys defined here:
 *   config-isakmp      { isakmpPolicy: number }                 (ISAKMP policy priority)
 *   cfg-crypto-trans   { transformSet: string }                 (transform-set name)
 *   config-crypto-map  { cryptoMap: string; seq: number }       (crypto map name + entry sequence number)
 *
 * Any change to configuration that live SAs depend on clears this device's IKE and IPsec SAs
 * (runtime.ikeSas / runtime.ipsecSas); the simulator renegotiates them on the next matching packet.
 */
import type { CryptoConfig, CryptoMapEntry, InterfaceConfig, IsakmpPolicy } from '../../types.ts';
import type { Args, CmdEnv, CommandDef } from '../framework.ts';
import { currentInterfaces, registerCommands } from '../framework.ts';

// ───────────────────────────── IOS messages ─────────────────────────────
export const MSG = {
  newMapNote: '% NOTE: This new crypto map will remain disabled until a peer\n        and a valid access list have been configured.',
  isakmpOn: '%CRYPTO-6-ISAKMP_ON_OFF: ISAKMP is ON',
  isakmpOff: '%CRYPTO-6-ISAKMP_ON_OFF: ISAKMP is OFF',
  emptyMap: 'Cannot apply empty map to interface',
  noTransformSet: (name: string) => `ERROR: transform set with tag "${name}" does not exist.`,
  // Wording of the two refusals below could not be verified against a real IOS XE 17.3 router.
  transformSetInUse: (name: string, maps: string[]) => `% Transform set ${name} is in use by crypto map ${maps.join(', ')}. Remove it from the crypto map first.`,
  mapApplied: (name: string, ifs: string[]) => `% Crypto map ${name} is applied to interface ${ifs.join(', ')}. Remove it from the interface first.`,
};

// ───────────────────────────── Transforms ─────────────────────────────
interface TransformInfo { name: string; group: 'C1' | 'C2' | 'A' | 'H' | 'Z'; keySizes?: boolean; help: string }
/** Transform names offered by IOS XE 17.3 `crypto ipsec transform-set NAME ?`. */
export const TRANSFORMS: TransformInfo[] = [
  { name: 'ah-md5-hmac', group: 'H', help: 'AH-HMAC-MD5 transform' },
  { name: 'ah-sha-hmac', group: 'H', help: 'AH-HMAC-SHA transform' },
  { name: 'ah-sha256-hmac', group: 'H', help: 'AH-HMAC-SHA256 transform' },
  { name: 'ah-sha384-hmac', group: 'H', help: 'AH-HMAC-SHA384 transform' },
  { name: 'ah-sha512-hmac', group: 'H', help: 'AH-HMAC-SHA512 transform' },
  { name: 'comp-lzs', group: 'Z', help: 'IP Compression using the LZS compression algorithm' },
  { name: 'esp-3des', group: 'C1', help: 'ESP transform using 3DES(EDE) cipher (168 bits)' },
  { name: 'esp-aes', group: 'C1', keySizes: true, help: 'ESP transform using AES cipher' },
  { name: 'esp-des', group: 'C1', help: 'ESP transform using DES cipher (56 bits)' },
  { name: 'esp-gcm', group: 'C2', keySizes: true, help: 'ESP transform using GCM cipher' },
  { name: 'esp-gmac', group: 'C2', keySizes: true, help: 'ESP transform using GMAC cipher' },
  { name: 'esp-md5-hmac', group: 'A', help: 'ESP transform using HMAC-MD5 auth' },
  { name: 'esp-null', group: 'C1', help: 'ESP transform w/o cipher' },
  { name: 'esp-sha-hmac', group: 'A', help: 'ESP transform using HMAC-SHA auth' },
  { name: 'esp-sha256-hmac', group: 'A', help: 'ESP transform using HMAC-SHA256 auth' },
  { name: 'esp-sha384-hmac', group: 'A', help: 'ESP transform using HMAC-SHA384 auth' },
  { name: 'esp-sha512-hmac', group: 'A', help: 'ESP transform using HMAC-SHA512 auth' },
];
const names = (pred: (t: TransformInfo) => boolean) => TRANSFORMS.filter(pred).map((t) => t.name).join('|');

/**
 * The combination rules are encoded in the grammar (one ESP cipher, one ESP authenticator, one AH transform,
 * comp-lzs once; GCM/GMAC carry their own integrity so they take no ESP authenticator; key sizes only after
 * esp-aes/esp-gcm/esp-gmac). An illegal combination is therefore answered by the framework itself with the
 * real "% Invalid input detected at '^' marker." under the offending transform, exactly like the IOS parser,
 * and '?' after each transform lists only what may still follow. Any order is accepted.
 */
function transformSetPatterns(prefix: string): string[] {
  const piece: Record<string, string[]> = {
    C1: [`{c:${names((t) => t.group === 'C1' && !t.keySizes)}}`, `{c:${names((t) => t.group === 'C1' && !!t.keySizes)}} [{ks:128|192|256}]`],
    C2: [`{c:${names((t) => t.group === 'C2')}} [{ks:128|192|256}]`],
    A: [`{a:${names((t) => t.group === 'A')}}`],
    H: [`{h:${names((t) => t.group === 'H')}}`],
    Z: [`{z:${names((t) => t.group === 'Z')}}`],
  };
  const sets: string[][] = [];
  for (const c of ['', 'C1', 'C2']) for (const a of ['', 'A']) for (const h of ['', 'H']) for (const z of ['', 'Z']) {
    if (c === 'C2' && a) continue;
    if (!c && !a && !h) continue;
    sets.push([c, a, h, z].filter(Boolean));
  }
  const perms = (xs: string[]): string[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p])));
  const out: string[] = [];
  for (const set of sets) {
    for (const order of perms(set)) {
      let variants = [''];
      for (const g of order) variants = variants.flatMap((v) => piece[g].map((p) => (v ? `${v} ${p}` : p)));
      for (const v of variants) out.push(`${prefix} ${v}`);
    }
  }
  return out;
}

/** Transforms in the order typed, canonical names, key size kept unless it is the default 128 ('esp-aes 256'). */
function orderedTransforms(env: CmdEnv, args: Args): string[] {
  const chosen = [args.c, args.a, args.h, args.z].filter((x): x is string => typeof x === 'string');
  const toks = env.line.split(/\s+/).slice(4); // crypto ipsec transform-set NAME …
  const out: string[] = [];
  const left = [...chosen];
  for (const tok of toks) {
    const low = tok.toLowerCase();
    if (/^\d/.test(low)) {
      const ks = ['128', '192', '256'].find((k) => k.startsWith(low)) ?? low;
      if (ks !== '128' && out.length) out[out.length - 1] += ' ' + ks;
      continue;
    }
    const hit = left.find((n) => n === low) ?? left.find((n) => n.startsWith(low));
    if (!hit) continue;
    left.splice(left.indexOf(hit), 1);
    out.push(hit);
  }
  for (const n of left) out.push(n); // defensive: never lose a captured transform
  return out;
}

// ───────────────────────────── Helpers ─────────────────────────────
const cfg = (env: CmdEnv): CryptoConfig => env.device.config.crypto;

/** Drop this device's SAs: they are renegotiated with the new settings on the next matching packet. */
export function invalidateSas(env: CmdEnv): void {
  env.device.runtime.ipsecSas = [];
  env.device.runtime.ikeSas = [];
}

function defaultPolicy(priority: number): IsakmpPolicy {
  return { priority, encryption: 'des', hash: 'sha', authentication: 'rsa-sig', group: 1, lifetime: 86400 };
}
function currentPolicy(env: CmdEnv): IsakmpPolicy {
  const n = Number(env.session.ctx.isakmpPolicy);
  let p = cfg(env).isakmpPolicies.find((x) => x.priority === n);
  if (!p) { p = defaultPolicy(n); insertPolicy(env, p); }
  return p;
}
function insertPolicy(env: CmdEnv, p: IsakmpPolicy): void {
  const list = cfg(env).isakmpPolicies;
  list.push(p);
  list.sort((a, b) => a.priority - b.priority);
}
/** Set one ISAKMP policy attribute; clears SAs when the value really changed. */
function setPolicy<K extends keyof IsakmpPolicy>(env: CmdEnv, key: K, value: IsakmpPolicy[K]): void {
  const p = currentPolicy(env);
  if (p[key] !== value) { p[key] = value; invalidateSas(env); }
}

function currentTransformSet(env: CmdEnv) {
  const name = String(env.session.ctx.transformSet);
  let ts = cfg(env).transformSets.find((t) => t.name === name);
  if (!ts) { ts = { name, transforms: [], mode: 'tunnel' }; cfg(env).transformSets.push(ts); }
  return ts;
}

function currentEntry(env: CmdEnv): CryptoMapEntry {
  const name = String(env.session.ctx.cryptoMap);
  const seq = Number(env.session.ctx.seq);
  let map = cfg(env).maps.find((m) => m.name === name);
  if (!map) { map = { name, entries: [] }; cfg(env).maps.push(map); }
  let e = map.entries.find((x) => x.seq === seq);
  if (!e) { e = newEntry(seq); map.entries.push(e); map.entries.sort((a, b) => a.seq - b.seq); }
  return e;
}
const newEntry = (seq: number): CryptoMapEntry => ({ seq, type: 'ipsec-isakmp', peers: [], transformSets: [] });
/** Apply a change to the current crypto map entry; clears SAs when something changed. */
function editEntry(env: CmdEnv, change: (e: CryptoMapEntry) => void): void {
  const e = currentEntry(env);
  const before = JSON.stringify(e);
  change(e);
  if (JSON.stringify(e) !== before) invalidateSas(env);
}

function interfacesWithMap(env: CmdEnv, mapName?: string): string[] {
  return Object.values(env.device.config.interfaces)
    .filter((i) => i.cryptoMap && (mapName === undefined || i.cryptoMap === mapName))
    .map((i) => i.name);
}

/** Store an accepted-but-not-simulated global line, replacing an earlier line with the same `key` prefix. */
function putExtraLine(env: CmdEnv, keyPrefix: string, line: string | null): void {
  const lines = env.device.config.extraLines;
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].startsWith(keyPrefix)) lines.splice(i, 1);
  if (line) lines.push(line);
}

// ───────────────────────────── Help texts ─────────────────────────────
const H: Record<string, string> = {
  no: 'Negate a command or set its defaults',
  default: 'Set a command to its defaults',
  crypto: 'Encryption module',
  isakmp: 'Configure ISAKMP policy',
  policy: 'Set policy for an ISAKMP protection suite',
  '<prio>': 'Priority of protection suite',
  key: 'Set pre-shared key for remote peer',
  '<key>': 'The UNENCRYPTED (cleartext) user password',
  '0': 'Specifies an UNENCRYPTED password will follow',
  '6': 'Specifies an ENCRYPTED password will follow',
  address: 'define shared key with IP address',
  '<addr>': 'Peer address',
  '<mask>': 'Peer address mask',
  hostname: 'define shared key with hostname',
  '<host>': 'hostname of peer with whom a key is shared',
  'no-xauth': 'Bypasses XAuth for this peer',
  enable: 'Enable ISAKMP',
  ipsec: 'Configure IPSEC policy',
  'transform-set': 'Define transform and settings',
  '<tsname>': 'Transform set tag',
  'security-association': 'Security association parameters',
  lifetime: 'security association lifetime',
  seconds: 'Time-based key duration in seconds',
  kilobytes: 'Volume-based key duration',
  '<secs>': 'Security association duration in seconds',
  '<kb>': 'Security association duration in kilobytes encrypted',
  map: 'Enter a crypto map',
  '<map>': 'Crypto map tag',
  '<seq>': 'Sequence to insert into crypto map entry',
  'ipsec-isakmp': 'IPSEC w/ISAKMP',
  '128': '128 bit keys.',
  '192': '192 bit keys.',
  '256': '256 bit keys.',
};
for (const t of TRANSFORMS) H[t.name] = t.help;
const GLOBAL_HELP = { ...H };

const ISAKMP_HELP: Record<string, string> = {
  no: H.no, default: H.default,
  encryption: 'Set encryption algorithm for protection suite',
  des: 'DES - Data Encryption Standard (56 bit keys).',
  '3des': 'Three key triple DES',
  aes: 'AES - Advanced Encryption Standard.',
  '128': '128 bit keys.', '192': '192 bit keys.', '256': '256 bit keys.',
  hash: 'Set hash algorithm for protection suite',
  sha: 'Secure Hash Standard',
  md5: 'Message Digest 5',
  sha256: 'Secure Hash Standard 2 (256 bit)',
  sha384: 'Secure Hash Standard 2 (384 bit)',
  sha512: 'Secure Hash Standard 2 (512 bit)',
  authentication: 'Set authentication method for protection suite',
  'pre-share': 'Pre-Shared Key',
  'rsa-sig': 'Rivest-Shamir-Adleman Signature',
  'rsa-encr': 'Rivest-Shamir-Adleman Encryption',
  group: 'Set the Diffie-Hellman group',
  '1': 'Diffie-Hellman group 1 (768 bit)',
  '2': 'Diffie-Hellman group 2 (1024 bit)',
  '5': 'Diffie-Hellman group 5 (1536 bit)',
  '14': 'Diffie-Hellman group 14 (2048 bit)',
  '15': 'Diffie-Hellman group 15 (3072 bit)',
  '16': 'Diffie-Hellman group 16 (4096 bit)',
  '19': 'Diffie-Hellman group 19 (256 bit ecp)',
  '20': 'Diffie-Hellman group 20 (384 bit ecp)',
  '21': 'Diffie-Hellman group 21 (521 bit ecp)',
  '24': 'Diffie-Hellman group 24 (2048 bit, 256 bit subgroup)',
  lifetime: 'Set lifetime for ISAKMP security association',
  '<secs>': 'lifetime in seconds',
};

const MAP_HELP: Record<string, string> = {
  no: H.no,
  match: 'Match values.',
  address: 'Match address of packets to encrypt.',
  '<acl>': 'IP access-list number or name',
  set: 'Set values for encryption/decryption',
  peer: 'Allowed Encryption/Decryption peer.',
  '<peer>': 'IP address of peer',
  'transform-set': 'Specify list of transform sets in priority order',
  '<t1>': 'Proposal tag',
  pfs: 'Specify pfs settings',
  group1: 'D-H Group1 (768-bit modulus)',
  group2: 'D-H Group2 (1024-bit modulus)',
  group5: 'D-H Group5 (1536-bit modulus)',
  group14: 'D-H Group14 (2048-bit modulus)',
  group15: 'D-H Group15 (3072-bit modulus)',
  group16: 'D-H Group16 (4096-bit modulus)',
  group19: 'D-H Group19 (256-bit elliptic curve)',
  group20: 'D-H Group20 (384-bit elliptic curve)',
  group21: 'D-H Group21 (521-bit elliptic curve)',
  group24: 'D-H Group24 (2048-bit modulus & 256-bit subgroup)',
  'security-association': 'Security association parameters',
  lifetime: 'security association lifetime',
  seconds: 'Time-based key duration in seconds',
  kilobytes: 'Volume-based key duration',
  '<secs>': 'Security association duration in seconds',
  '<kb>': 'Security association duration in kilobytes encrypted',
  qos: 'Quality of Service related commands',
  'pre-classify': 'Enable QOS classification before packets are tunnel encapsulated',
  description: 'Description of the crypto map statement policy',
  '<text>': 'Description for the crypto map statement policy',
};

// ───────────────────────────── Commands ─────────────────────────────
const ENC = '{alg:des|3des}';
const ENC_AES = '{alg:aes} [{bits:128|192|256}]';
const HASHES = '{h:sha|md5|sha256|sha384|sha512}';
const AUTHS = '{auth:pre-share|rsa-sig|rsa-encr}';
const GROUPS = '{g:1|2|5|14|15|16|19|20|21|24}';
const PFS = '{g:group1|group2|group5|group14|group15|group16|group19|group20|group21|group24}';
const isReset = (env: CmdEnv) => env.has('no') || env.has('default');
/** IPsec crypto maps exist on the ISR 4331 only (the Catalyst 9300L has no crypto map support). */
const R: ('router' | 'switch')[] = ['router'];

export const commands: CommandDef[] = [
  // ── ISAKMP policy ──
  {
    modes: 'config', feature: 'ipsec', kinds: R, mutates: true,
    pattern: 'crypto isakmp policy <prio:int(1-10000)>',
    help: GLOBAL_HELP,
    run(env, a) {
      if (!cfg(env).isakmpPolicies.some((p) => p.priority === a.prio)) { insertPolicy(env, defaultPolicy(a.prio)); invalidateSas(env); }
      env.setMode('config-isakmp', { isakmpPolicy: a.prio });
    },
  },
  {
    modes: 'config', feature: 'ipsec', kinds: R,
    pattern: 'no crypto isakmp policy <prio:int(1-10000)>',
    help: GLOBAL_HELP,
    run(env, a) {
      const list = cfg(env).isakmpPolicies;
      const i = list.findIndex((p) => p.priority === a.prio);
      if (i >= 0) { list.splice(i, 1); invalidateSas(env); }
    },
  },
  {
    modes: 'config-isakmp', feature: 'ipsec', kinds: R,
    pattern: [`encryption ${ENC}`, `encryption ${ENC_AES}`, `no encryption [${ENC}]`, `no encryption [${ENC_AES}]`, 'default encryption'],
    help: ISAKMP_HELP,
    run(env, a) {
      if (isReset(env)) return setPolicy(env, 'encryption', 'des');
      const value = a.alg === 'aes' && a.bits && a.bits !== '128' ? `aes ${a.bits}` : String(a.alg);
      setPolicy(env, 'encryption', value);
    },
  },
  {
    modes: 'config-isakmp', feature: 'ipsec', kinds: R,
    pattern: [`hash ${HASHES}`, `no hash [${HASHES}]`, 'default hash'],
    help: ISAKMP_HELP,
    run(env, a) { setPolicy(env, 'hash', isReset(env) ? 'sha' : String(a.h)); },
  },
  {
    modes: 'config-isakmp', feature: 'ipsec', kinds: R,
    pattern: [`authentication ${AUTHS}`, `no authentication [${AUTHS}]`, 'default authentication'],
    help: ISAKMP_HELP,
    run(env, a) { setPolicy(env, 'authentication', isReset(env) ? 'rsa-sig' : (a.auth as IsakmpPolicy['authentication'])); },
  },
  {
    modes: 'config-isakmp', feature: 'ipsec', kinds: R,
    pattern: [`group ${GROUPS}`, `no group [${GROUPS}]`, 'default group'],
    help: ISAKMP_HELP,
    run(env, a) { setPolicy(env, 'group', isReset(env) ? 1 : Number(a.g)); },
  },
  {
    modes: 'config-isakmp', feature: 'ipsec', kinds: R,
    pattern: ['lifetime <secs:int(60-86400)>', 'no lifetime [<secs:int(60-86400)>]', 'default lifetime'],
    help: ISAKMP_HELP,
    run(env, a) { setPolicy(env, 'lifetime', isReset(env) ? 86400 : Number(a.secs)); },
  },

  // ── ISAKMP pre-shared keys ──
  {
    modes: 'config', feature: 'ipsec', kinds: R,
    pattern: [
      'crypto isakmp key <key:word> address <addr:ip> [<mask:mask>] [no-xauth]',
      'crypto isakmp key {enc:0|6} <key:word> address <addr:ip> [<mask:mask>] [no-xauth]',
    ],
    help: GLOBAL_HELP,
    run(env, a) {
      const keys = cfg(env).isakmpKeys;
      const entry: CryptoConfig['isakmpKeys'][number] = { key: String(a.key), address: a.addr };
      if (a.mask) entry.mask = a.mask;
      const i = keys.findIndex((k) => k.address === a.addr && (k.mask ?? '') === (a.mask ?? ''));
      if (i >= 0) {
        if (keys[i].key !== entry.key) { keys[i] = entry; invalidateSas(env); }
      } else { keys.push(entry); invalidateSas(env); }
      if (a.enc === '6') env.note('Accepted, but not simulated: encrypted (type 6) keys. The text you typed is used as the key itself.');
      if (env.has('no-xauth')) env.note('Accepted, but not simulated: no-xauth (XAuth is not part of the simulator).');
    },
  },
  {
    modes: 'config', feature: 'ipsec', kinds: R,
    pattern: [
      'crypto isakmp key <key:word> hostname <host:word> [no-xauth]',
      'crypto isakmp key {enc:0|6} <key:word> hostname <host:word> [no-xauth]',
    ],
    help: GLOBAL_HELP,
    run(env, a) {
      const lines = env.device.config.extraLines;
      for (let i = lines.length - 1; i >= 0; i--) if (/^crypto isakmp key .* hostname (\S+)/.exec(lines[i])?.[1] === a.host) lines.splice(i, 1);
      lines.push(`crypto isakmp key ${a.enc ? a.enc + ' ' : ''}${a.key} hostname ${a.host}${env.has('no-xauth') ? ' no-xauth' : ''}`);
      env.note('Accepted, but not simulated: pre-shared keys bound to a host name. Use "crypto isakmp key <key> address <ip>" for the lab.');
    },
  },
  {
    modes: 'config', feature: 'ipsec', kinds: R,
    pattern: [
      'no crypto isakmp key <key:word> address <addr:ip> [<mask:mask>] [no-xauth]',
      'no crypto isakmp key {enc:0|6} <key:word> address <addr:ip> [<mask:mask>] [no-xauth]',
      'no crypto isakmp key <key:word> hostname <host:word> [no-xauth]',
      'no crypto isakmp key {enc:0|6} <key:word> hostname <host:word> [no-xauth]',
    ],
    help: GLOBAL_HELP,
    run(env, a) {
      if (a.host) {
        const lines = env.device.config.extraLines;
        for (let i = lines.length - 1; i >= 0; i--) if (/^crypto isakmp key .* hostname (\S+)/.exec(lines[i])?.[1] === a.host) lines.splice(i, 1);
        return;
      }
      const keys = cfg(env).isakmpKeys;
      const before = keys.length;
      for (let i = keys.length - 1; i >= 0; i--) {
        if (keys[i].address === a.addr && (!a.mask || (keys[i].mask ?? '255.255.255.255') === a.mask)) keys.splice(i, 1);
      }
      if (keys.length !== before) invalidateSas(env);
    },
  },
  {
    modes: 'config', feature: 'ipsec', kinds: R,
    pattern: ['crypto isakmp enable', 'no crypto isakmp enable'],
    help: GLOBAL_HELP,
    run(env) {
      const on = !env.has('no');
      const c = cfg(env);
      if (c.isakmpEnabled === on) return;
      c.isakmpEnabled = on;
      invalidateSas(env);
      if (interfacesWithMap(env).length) env.print(on ? MSG.isakmpOn : MSG.isakmpOff);
    },
  },

  // ── Transform sets ──
  {
    modes: 'config', feature: 'ipsec', kinds: R, mutates: true,
    pattern: transformSetPatterns('crypto ipsec transform-set <tsname:word>'),
    help: GLOBAL_HELP,
    run(env, a) {
      const transforms = orderedTransforms(env, a);
      const list = cfg(env).transformSets;
      const ts = list.find((t) => t.name === a.tsname);
      if (!ts) { list.push({ name: a.tsname, transforms, mode: 'tunnel' }); invalidateSas(env); }
      else if (ts.transforms.join(' ') !== transforms.join(' ')) { ts.transforms = transforms; invalidateSas(env); }
      env.setMode('cfg-crypto-trans', { transformSet: a.tsname });
    },
  },
  {
    modes: 'config', feature: 'ipsec', kinds: R,
    pattern: 'no crypto ipsec transform-set <tsname:word> [<rest:text>]',
    help: GLOBAL_HELP,
    run(env, a) {
      const c = cfg(env);
      const i = c.transformSets.findIndex((t) => t.name === a.tsname);
      if (i < 0) return;
      const users = c.maps.filter((m) => m.entries.some((e) => e.transformSets.includes(a.tsname))).map((m) => m.name);
      if (users.length) env.reject(MSG.transformSetInUse(a.tsname, users));
      c.transformSets.splice(i, 1);
      invalidateSas(env);
    },
  },
  {
    modes: 'cfg-crypto-trans', feature: 'ipsec', kinds: R,
    pattern: ['mode {m:tunnel|transport}', 'no mode [{m:tunnel|transport}]', 'default mode'],
    help: {
      no: H.no, default: H.default, mode: 'encapsulation mode (transport/tunnel)',
      tunnel: 'tunnel (datagram encapsulation) mode', transport: 'transport (payload encapsulation) mode',
    },
    run(env, a) {
      const ts = currentTransformSet(env);
      const mode = isReset(env) ? 'tunnel' : (a.m as 'tunnel' | 'transport');
      if (ts.mode !== mode) { ts.mode = mode; invalidateSas(env); }
    },
  },
  {
    modes: 'config', feature: 'ipsec', kinds: R,
    pattern: [
      'crypto ipsec security-association lifetime seconds <secs:int(120-2592000)>',
      'crypto ipsec security-association lifetime kilobytes <kb:int(2560-4294967295)>',
      'no crypto ipsec security-association lifetime {kind:seconds|kilobytes} [<n:int>]',
    ],
    help: GLOBAL_HELP,
    run(env, a) {
      const kind = a.kind ?? (a.secs !== undefined ? 'seconds' : 'kilobytes');
      const prefix = `crypto ipsec security-association lifetime ${kind} `;
      if (env.has('no')) { putExtraLine(env, prefix, null); return; }
      putExtraLine(env, prefix, prefix + String(a.secs ?? a.kb));
      env.note('Accepted, but not simulated: the global IPsec SA lifetime (SAs in the simulator do not expire).');
    },
  },

  // ── Crypto map entries ──
  {
    modes: 'config', feature: 'ipsec', kinds: R, mutates: true,
    pattern: 'crypto map <map:word> <seq:int(1-65535)> [ipsec-isakmp]',
    help: GLOBAL_HELP,
    run(env, a) {
      const c = cfg(env);
      let map = c.maps.find((m) => m.name === a.map);
      if (!map) { map = { name: a.map, entries: [] }; c.maps.push(map); }
      if (!map.entries.some((e) => e.seq === a.seq)) {
        map.entries.push(newEntry(a.seq));
        map.entries.sort((x, y) => x.seq - y.seq);
        env.print(MSG.newMapNote);
        invalidateSas(env);
      }
      env.setMode('config-crypto-map', { cryptoMap: a.map, seq: a.seq });
    },
  },
  {
    modes: 'config', feature: 'ipsec', kinds: R,
    pattern: 'no crypto map <map:word> [<seq:int(1-65535)>] [ipsec-isakmp]',
    help: GLOBAL_HELP,
    run(env, a) {
      const c = cfg(env);
      const map = c.maps.find((m) => m.name === a.map);
      if (!map) return;
      const removesAll = a.seq === undefined || map.entries.every((e) => e.seq === a.seq);
      if (a.seq !== undefined && !map.entries.some((e) => e.seq === a.seq)) return;
      const applied = interfacesWithMap(env, a.map);
      if (removesAll && applied.length) env.reject(MSG.mapApplied(a.map, applied));
      if (removesAll) c.maps.splice(c.maps.indexOf(map), 1);
      else map.entries = map.entries.filter((e) => e.seq !== a.seq);
      invalidateSas(env);
    },
  },
  {
    modes: 'config-crypto-map', feature: 'ipsec', kinds: R,
    pattern: ['match address <acl:word>', 'no match address [<acl:word>]'],
    help: MAP_HELP,
    run(env, a) { editEntry(env, (e) => { if (env.has('no')) delete e.matchAcl; else e.matchAcl = String(a.acl); }); },
  },
  {
    modes: 'config-crypto-map', feature: 'ipsec', kinds: R,
    pattern: ['set peer <peer:ip>', 'no set peer [<peer:ip>]'],
    help: MAP_HELP,
    run(env, a) {
      editEntry(env, (e) => {
        if (!env.has('no')) { if (!e.peers.includes(a.peer)) e.peers.push(a.peer); }
        else e.peers = a.peer ? e.peers.filter((p) => p !== a.peer) : [];
      });
    },
  },
  {
    modes: 'config-crypto-map', feature: 'ipsec', kinds: R,
    pattern: ['set transform-set <t1:word> [<t2:word> [<t3:word> [<t4:word> [<t5:word> [<t6:word>]]]]]', 'no set transform-set [<rest:text>]'],
    help: MAP_HELP,
    run(env, a) {
      if (env.has('no')) { editEntry(env, (e) => { e.transformSets = []; }); return; }
      const wanted = [a.t1, a.t2, a.t3, a.t4, a.t5, a.t6].filter((x): x is string => typeof x === 'string');
      for (const n of wanted) if (!cfg(env).transformSets.some((t) => t.name === n)) env.reject(MSG.noTransformSet(n));
      editEntry(env, (e) => { e.transformSets = [...new Set(wanted)]; });
    },
  },
  {
    modes: 'config-crypto-map', feature: 'ipsec', kinds: R,
    pattern: [`set pfs [${PFS}]`, `no set pfs [${PFS}]`],
    help: MAP_HELP,
    run(env, a) {
      editEntry(env, (e) => {
        if (env.has('no')) delete e.pfsGroup;
        else e.pfsGroup = a.g ? Number(String(a.g).slice(5)) : 1;
      });
    },
  },
  {
    modes: 'config-crypto-map', feature: 'ipsec', kinds: R,
    pattern: [
      'set security-association lifetime seconds <secs:int(120-2592000)>',
      'set security-association lifetime kilobytes <kb:int(2560-4294967295)>',
      'no set security-association lifetime {kind:seconds|kilobytes} [<n:int>]',
    ],
    help: MAP_HELP,
    run(env, a) {
      editEntry(env, (e) => {
        if (env.has('no')) { if (a.kind === 'seconds') delete e.saLifetimeSeconds; else delete e.saLifetimeKilobytes; }
        else if (a.secs !== undefined) e.saLifetimeSeconds = a.secs;
        else e.saLifetimeKilobytes = a.kb;
      });
    },
  },
  {
    modes: 'config-crypto-map', feature: 'ipsec', kinds: R,
    pattern: ['qos pre-classify', 'no qos pre-classify'],
    help: MAP_HELP,
    run(env) {
      // This local classifier setting is not part of the negotiated SA.
      const e = currentEntry(env);
      if (env.has('no')) delete e.qosPreClassify; else e.qosPreClassify = true;
      if (env.world.settings.qosClassifiesInnerHeader) {
        env.note('This training profile already classifies the original header. The command is saved but does not change classification in this profile.');
      }
    },
  },
  {
    modes: 'config-crypto-map', feature: 'ipsec', kinds: R,
    pattern: ['description <text:text>', 'no description [<text:text>]'],
    help: MAP_HELP,
    run(env, a) {
      // A description does not affect negotiation: no SA reset.
      const e = currentEntry(env);
      if (env.has('no')) delete e.description; else e.description = String(a.text);
    },
  },

  // ── Interface ──
  {
    modes: 'config-if', feature: 'ipsec', kinds: R,
    pattern: 'crypto map <map:word>',
    help: { crypto: 'Encryption/Decryption commands', map: 'Assign a Crypto Map', '<map>': 'Crypto Map tag' },
    run(env, a) {
      const map = cfg(env).maps.find((m) => m.name === a.map);
      if (!map || map.entries.length === 0) env.reject(MSG.emptyMap);
      const before = interfacesWithMap(env).length;
      let changed = false;
      for (const i of currentInterfaces(env)) if (i.cryptoMap !== a.map) { i.cryptoMap = a.map; changed = true; }
      if (changed) invalidateSas(env);
      if (before === 0 && interfacesWithMap(env).length > 0 && cfg(env).isakmpEnabled) env.print(MSG.isakmpOn);
    },
  },
  {
    modes: 'config-if', feature: 'ipsec', kinds: R,
    pattern: 'no crypto map [<map:word>]',
    help: { no: H.no, crypto: 'Encryption/Decryption commands', map: 'Assign a Crypto Map', '<map>': 'Crypto Map tag' },
    run(env) {
      // IOS ignores the map name in the no form and removes whatever map the interface carries.
      const before = interfacesWithMap(env).length;
      let changed = false;
      for (const i of currentInterfaces(env)) if (i.cryptoMap) { delete (i as InterfaceConfig).cryptoMap; changed = true; }
      if (!changed) return;
      invalidateSas(env);
      if (before > 0 && interfacesWithMap(env).length === 0 && cfg(env).isakmpEnabled) env.print(MSG.isakmpOff);
    },
  },

  // ── Privileged EXEC ──
  {
    modes: 'priv', feature: 'ipsec', kinds: R,
    pattern: ['clear crypto sa', 'clear crypto sa peer <peer:ip>', 'clear crypto sa map <map:word>'],
    help: {
      clear: 'Reset functions', crypto: 'Clear crypto', sa: 'Clear all crypto SAs',
      peer: 'Clear all crypto SAs for a given crypto peer', map: 'Clear all crypto SAs for a given crypto map',
      '<peer>': 'IP address of crypto peer', '<map>': 'Crypto map tag',
    },
    run(env, a) {
      const rt = env.device.runtime;
      if (a.peer) rt.ipsecSas = rt.ipsecSas.filter((s) => s.remoteEndpoint !== a.peer);
      else if (a.map) rt.ipsecSas = rt.ipsecSas.filter((s) => s.mapName !== a.map);
      else rt.ipsecSas = [];
    },
  },
  {
    modes: 'priv', feature: 'ipsec', kinds: R,
    pattern: 'clear crypto isakmp [<id:int>]',
    help: { clear: 'Reset functions', crypto: 'Clear crypto', isakmp: 'Flush the ISAKMP database', '<id>': 'connection id of SA' },
    run(env, a) {
      const rt = env.device.runtime;
      rt.ikeSas = a.id === undefined ? [] : rt.ikeSas.filter((s) => s.id !== a.id);
    },
  },
  {
    modes: 'priv', feature: 'ipsec', kinds: R,
    pattern: ['clear crypto session', 'clear crypto session remote <peer:ip>'],
    help: { clear: 'Reset functions', crypto: 'Clear crypto', session: 'Clear crypto session', remote: 'Remote IKE address', '<peer>': 'Remote IKE address' },
    run(env, a) {
      const rt = env.device.runtime;
      if (a.peer) {
        rt.ipsecSas = rt.ipsecSas.filter((s) => s.remoteEndpoint !== a.peer);
        rt.ikeSas = rt.ikeSas.filter((s) => s.remote !== a.peer);
      } else invalidateSas(env);
    },
  },
];

export function install(): void { registerCommands(commands); }
