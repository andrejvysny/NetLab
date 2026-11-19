/**
 * The command sheet must reproduce docs/course/cheat-sheet.txt (the paper the student may use in the exam)
 * faithfully: all sections, every line, only obvious typos fixed (and each fix mentioned in the note).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { COMMAND_SHEET } from '../../src/content/commandSheet.ts';
import { FEATURE_META } from '../../src/ui/features.ts';

const SHEET = readFileSync(new URL('../../docs/course/cheat-sheet.txt', import.meta.url), 'utf8');
const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();
const texts = COMMAND_SHEET.flatMap((s) => s.lines.map((l) => norm(l.text)));
const paper = COMMAND_SHEET.filter((s) => s.id !== 'extra-verify');
const paperTexts = paper.flatMap((s) => s.lines.map((l) => norm(l.text)));

/** Typos of the paper sheet that the simulator's copy fixes (paper → fixed). */
const FIXES: [string, string][] = [
  ['service_policy', 'service-policy'],
  ['kpbs', 'kbps'],
  ['pnumber-of-packets', 'number-of-packets'],
  ['network-addressr', 'network-address'],
  ['destination- IP', 'destination-IP'],
  ['wildcard mask icmp', 'wildcard-mask icmp'],
  ['[dest- port]', '[dest-port]'],
  ['[operator-dest -port]', '[operator-dest-port]'],
  ['ip-address-of- syslog-server', 'ip-address-of-syslog-server'],
  ['Router #', 'Router#'],
  ['[ACL-number ]', '[ACL-number]'],
  ['[view view-name ]', '[view view-name]'],
];
const fix = (s: string): string => FIXES.reduce((acc, [a, b]) => acc.split(a).join(b), norm(s));

test('all sections A–G are present, in order, with UI feature keys, plus the extra section at the end', () => {
  const titles = COMMAND_SHEET.map((s) => s.title);
  for (const [i, letter] of ['A)', 'B)', 'C)', 'D)', 'E)', 'F)', 'G)'].entries()) {
    assert.ok(paper.some((s) => s.title.startsWith(letter)), `section ${letter} missing`);
    if (i > 0) assert.ok(titles.findIndex((t) => t.startsWith(letter)) > titles.findIndex((t) => t.startsWith(['A)', 'B)', 'C)', 'D)', 'E)', 'F)', 'G)'][i - 1])));
  }
  const byLetter = (p: string) => paper.filter((s) => s.title.startsWith(p)).map((s) => s.feature);
  assert.deepEqual(byLetter('A)'), ['system']);
  assert.deepEqual(byLetter('B)'), ['acl']);
  assert.deepEqual(byLetter('C)'), ['nat']);
  assert.deepEqual(byLetter('D)'), ['ipsec']);
  assert.deepEqual(byLetter('E)'), ['qos']);
  assert.deepEqual(byLetter('F)'), ['dhcp']);
  assert.ok(byLetter('G)').includes('snmp') && byLetter('G)').includes('syslog'));
  for (const s of COMMAND_SHEET) assert.ok(s.feature in FEATURE_META, `${s.id}: unknown feature ${s.feature}`);
  const last = COMMAND_SHEET[COMMAND_SHEET.length - 1];
  assert.equal(last.id, 'extra-verify');
  assert.match(last.title, /^Not on the paper sheet/);
  assert.equal(last.feature, 'verify');
  assert.equal(new Set(COMMAND_SHEET.map((s) => s.id)).size, COMMAND_SHEET.length, 'section ids are unique');
});

test('no empty lines, notes and warnings are short single paragraphs', () => {
  for (const s of COMMAND_SHEET) {
    assert.ok(s.lines.length > 0, s.id);
    for (const l of s.lines) {
      assert.ok(l.text.trim().length > 0, `${s.id}: empty line`);
      assert.equal(l.text, l.text.trim(), `${s.id}: "${l.text}" has outer spaces`);
      assert.ok(!l.text.includes('\n'), l.text);
      if (l.note !== undefined) {
        assert.ok(l.note.trim().length > 0 && !l.note.includes('\n') && l.note.length <= 130, `note too long or empty: ${l.note}`);
        assert.ok(!/[.!?] [A-Z][a-z]+ [a-z]/.test(l.note.replace(/e\.g\. /g, '')), `note is more than one sentence: ${l.note}`);
      }
      if (l.warn !== undefined) assert.ok(l.warn.trim().length > 0 && !l.warn.includes('\n') && l.warn.length <= 240, `warn: ${l.warn}`);
    }
  }
});

test('every line of the paper sheet appears (wrapped lines joined, only the listed typos fixed)', () => {
  const skip = (raw: string): boolean => {
    const t = raw.trim();
    return t === '' || t.startsWith('Test – konfiguračné príkazy') || /^\d+$/.test(t) || t === 'Zoznam niektorých konfiguračných príkazov'
      || /^[A-G]\) /.test(t) || ['ALIAS', 'MENU', 'SYSLOG Server logging', 'SNMP'].includes(t);
  };
  const missing: string[] = [];
  let checked = 0;
  for (const raw of SHEET.split('\n')) {
    if (skip(raw)) continue;
    checked++;
    const want = fix(raw);
    if (!paperTexts.some((t) => t.includes(want))) missing.push(want);
  }
  assert.ok(checked >= 160, `only ${checked} sheet lines were checked`);
  assert.deepEqual(missing, []);
});

test('spot check: distinctive sheet lines appear exactly, in the sheet notation', () => {
  const exact = [
    'Router>enable',
    'Router(config)#banner motd #message#',
    'Router(config-line)#logging synchronous',
    'Router(config-if)#clock rate 56000 {DCE interface}',
    'Router(config-router)#network network-address wildcard-mask area area-number',
    'Router(config)#ip route 0.0.0.0 0.0.0.0 ip-address-of-next-hop-router',
    'Router#copy running-config startup-config',
    'Pozn.: Vypnúť debug - undebug all',
    'Router(config)# access-list 1-99 permit|deny source-IP-address wildcard-mask [log]',
    'Router(config-if)# ip access-group ACL number in | out',
    'Router(config-if)# no ip unreachables',
    'access-class number in',
    'Router(config)#ip nat inside source static ip-add-local ip-add-global',
    'Router(config)#ip nat inside source list number pool pool-name overload',
    'Router(config)#ip nat pool pool-name start-ip-add end-ip-add prefix-length bits type rotary',
    'Router(config)#ip nat inside destination list acl-number pool pool-name',
    'Router#clear ip nat trans *',
    'Router(config)# crypto isakmp key key-value address destination-ip-address',
    'Router(crypto-isakmp)# group 1/ group 2 “Key exchange—D-H”',
    'Router(config)# crypto ipsec transform-set transform-set-name transform1 transform2….',
    'Router(cfg-crypto-trans)# mode tunnel/transport',
    'Router(config-crypto-map)# set security-association lifetime kilobytes number',
    'Router# show crypto ipsec sa',
    'clear crypto isa',
    'Router(config)#priority-list list-number protocol protocol-name {high | medium | normal | low} list ACL-number',
    'Router(config)# queue-list list-number queue queue-number byte-count byte-count-number',
    'Router(config-if)# fair-queue [congestive-discard-threshold [dynamic-queues [reservable-queues]]]',
    'Router(config)#class-map [match-all | match-any] class-map-name',
    'Router(config-pmap-c)# priority percent percent',
    'Router(config-if)# service-policy output policy-map-name',
    'Router(dhcp-config)#network network-address [mask | prefix-length]',
    'Router(config)#ip dhcp excluded-address low-address [high-address]',
    'Router(config-if)#ip helper-address ip-address',
    'Router#alias exec shortcut command',
    'Router#menu name command item command',
    'Router(config)# logging source-interface interface-type interface-number',
    'Router(config)#logging trap warnings',
    'Router(config)#snmp-server community community-name [view view-name] [ro | rw] [ACL-number]',
    'Router(config)#snmp-server host host-id [traps | informs][version {1 | 2c | 3 [auth | noauth | priv]} ] community-name',
    'Router(config)# snmp-server enable traps [notification-type [notification-options]]',
    'Router(config)#snmp-server ifindex persist',
  ];
  assert.ok(exact.length >= 25);
  for (const e of exact) {
    assert.ok(paperTexts.includes(norm(e)), `missing: ${e}`);
    // and the line really is on the paper (after the typo fixes)
    const onPaper = SHEET.split('\n').some((raw) => fix(raw).startsWith(norm(e).slice(0, 40)) || norm(e).startsWith(fix(raw).slice(0, 40)) && fix(raw).length > 10);
    assert.ok(onPaper, `not on the paper sheet: ${e}`);
  }
  // duplicated lines of the paper stay duplicated (line by line)
  assert.equal(paperTexts.filter((t) => t === 'Router(config-router)#network network-address').length, 2);
  assert.equal(paperTexts.filter((t) => t === 'Router(config)#ip nat pool pool-name start-ip-add end-ip-add netmask mask').length, 2);
  assert.equal(paperTexts.filter((t) => t === 'Router(config-line)#password cisco').length, 2);
});

test('typo fixes are mentioned in the note; the uncorrected forms are gone', () => {
  const find = (start: string) => COMMAND_SHEET.flatMap((s) => s.lines).find((l) => l.text.startsWith(start));
  assert.match(find('Router(config-if)# service-policy')?.note ?? '', /service_policy/);
  assert.match(find('Router(config-pmap-c)# priority kbps')?.note ?? '', /kpbs/);
  assert.match(find('Router(config-pmap-c)# queue-limit')?.note ?? '', /pnumber-of-packets/);
  assert.match(find('Router(dhcp-config)#network')?.note ?? '', /network-addressr/);
  for (const bad of ['service_policy', 'kpbs', 'pnumber', 'network-addressr', 'Router #', 'dest- port', 'destination- IP']) {
    assert.ok(!texts.some((t) => t.includes(bad)), `still contains "${bad}"`);
  }
});

test('hardware caveats sit on the lines they apply to', () => {
  const lines = COMMAND_SHEET.flatMap((s) => s.lines);
  const warnOf = (start: string) => lines.filter((l) => l.text.startsWith(start)).map((l) => l.warn ?? '');
  for (const legacy of ['Router(config)#priority-list', 'Router(config-if)#priority-group', 'Router(config)#queue-list', 'Router(config)# queue-list', 'Router(config-if)#custom-queue-list']) {
    const w = warnOf(legacy);
    assert.ok(w.length > 0 && w.every((x) => /ISR 4331|IOS XE/.test(x)), `${legacy}: ${w}`);
  }
  assert.ok(warnOf('Router(config-if)# fair-queue').every((w) => /IOS XE/.test(w)));
  assert.ok(warnOf('Router(config-if)# no fair-queue').every((w) => /IOS XE/.test(w)));
  assert.ok(warnOf('Router# show queueing').every((w) => /show policy-map interface/.test(w)));
  assert.match(warnOf('Router(config-if)#clock rate')[0], /DCE/);
  assert.match(warnOf('Router(config-if)#clock rate')[0], /clock rate \?/);
  assert.match(warnOf('Router(crypto-isakmp)# group')[0], /17\.11/);
  assert.match(warnOf('Router(crypto-isakmp)# encryption')[0], /17\.11/);
  assert.match(warnOf('Router(config)# crypto ipsec transform-set')[0], /17\.11/);
  assert.match(warnOf('Router(config)#crypto map map-name')[0], /qos pre-classify/);
  assert.match(warnOf('Router(config-if)# service-policy')[0], /bandwidth 128/);
  // the MQC fair-queue inside a class is valid on IOS XE: no "does not exist" warning there
  assert.ok(!/does not exist/.test(warnOf('Router(config-pmap-c)# fair-queue')[0]));
  // lines without a hardware issue carry no warning
  assert.equal(warnOf('Router>enable')[0], '');
});

test('the extra section lists the verification commands worth knowing', () => {
  const extra = COMMAND_SHEET.find((s) => s.id === 'extra-verify');
  assert.ok(extra);
  const t = extra.lines.map((l) => l.text);
  for (const cmd of ['show ip interface brief', 'show ip route', 'show access-lists', 'show ip nat translations', 'show crypto isakmp sa', 'show crypto ipsec sa',
    'show policy-map interface', 'show ip dhcp binding', 'show controllers serial', 'show cdp neighbors', 'show running-config | section']) {
    assert.ok(t.some((x) => x.startsWith(cmd)), `missing ${cmd}`);
  }
});


test('NAT annotations distinguish Catalyst entitlement and routed ports from the default ISR handout', () => {
  const lines = COMMAND_SHEET.find((s) => s.id === 'sheet-c')!.lines;
  assert.match(lines.find((l) => l.text.endsWith('#ip nat inside'))?.warn ?? '', /Network Advantage.*no switchport.*not L2 switchports or SVIs in this lab/);
  assert.match(lines.find((l) => l.text.endsWith('bits type rotary'))?.warn ?? '', /ISR-only.*unverified/);
  assert.match(lines.find((l) => l.text.endsWith('pool pool-name overload'))?.warn ?? '', /interface <routed-port> overload.*up\/up/);
});
