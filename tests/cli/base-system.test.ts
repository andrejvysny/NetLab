import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDevice, createWorld, getIos } from '../../src/engine/world.ts';
import { execLine, helpFor, inspectLine, interrupt, startSession } from '../../src/engine/cli/framework.ts';
import { installCli } from '../../src/engine/cli/index.ts';
import { simSecretEncode, type7Encode } from '../../src/engine/config/render.ts';
import type { World } from '../../src/engine/types.ts';

installCli();

function lab() {
  const w: World = createWorld();
  addDevice(w, { id: 'r1', model: 'isr4331', label: 'R1', x: 0, y: 0 });
  getIos(w, 'r1').runtime.setupDialogDone = true;
  const { session } = startSession(w, 'r1', 'console');
  const run = (l: string) => execLine(w, session, l);
  run('enable'); run('configure terminal');
  return { w, s: session, run, cfg: () => getIos(w, 'r1').config };
}

test('hostname: legal, illegal (warned but applied like IOS), no hostname', () => {
  const { run, cfg } = lab();
  let o = run('host R1');
  assert.equal(o.prompt, 'R1(config)#'); assert.equal(o.output, ''); assert.equal(o.mutated, true); assert.equal(o.feature, 'system');
  o = run('hostname R_1');
  assert.equal(o.output, '% Hostname contains one or more illegal characters.\n');
  assert.equal(o.prompt, 'R_1(config)#'); assert.equal(o.notes.length, 1);
  assert.match(run('hostname 123').output, /illegal characters/);
  assert.match(run('hostname R1-').output, /illegal characters/);
  assert.equal(run('hostname Core-R1').output, '');
  run('no hostname');
  assert.equal(cfg().hostname, 'Router');
  assert.equal(run('hostname').status, 'incomplete');
});

test('enable secret / enable password, encrypted forms, same-password warning, no forms', () => {
  const { run, cfg } = lab();
  run('enable secret class');
  assert.equal(cfg().enableSecret, 'class');
  let o = run('enable password class');
  assert.equal(o.status, 'rejected');
  assert.match(o.output, /^The enable password you have chosen is the same as your enable secret\.\nThis is not recommended\.  Re-enter the enable password\./);
  assert.equal(cfg().enablePassword, undefined);
  o = run('enable password cisco');
  assert.equal(o.status, 'ok'); assert.equal(cfg().enablePassword, 'cisco'); assert.match(o.notes[0], /secret/);
  assert.equal(run('enable secret cisco').status, 'rejected');
  run(`enable password 7 ${type7Encode('pa55')}`);
  assert.equal(cfg().enablePassword, 'pa55');
  assert.equal(run('enable password 7 ZZZ').output, 'Invalid encrypted password\n');
  run(`enable secret 9 ${simSecretEncode('t0p')}`);
  assert.equal(cfg().enableSecret, 't0p');
  const unverified = run('enable secret 9 unsupported-hash');
  assert.equal(unverified.status, 'rejected');
  assert.match(unverified.output, /cannot verify/);
  assert.equal(cfg().enableSecret, 't0p');
  run('enable secret 0 plain');
  assert.equal(cfg().enableSecret, 'plain');
  run('no enable secret'); run('no enable password');
  assert.equal(cfg().enableSecret, undefined); assert.equal(cfg().enablePassword, undefined);
  run('enable secret level 15 lvl');
  assert.equal(cfg().enableSecret, 'lvl');
});

test('service password-encryption and ip domain-lookup (both spellings)', () => {
  const { run, cfg } = lab();
  run('service password-encryption');
  assert.equal(cfg().servicePasswordEncryption, true);
  run('no service password-encryption');
  assert.equal(cfg().servicePasswordEncryption, false);
  assert.equal(cfg().ipDomainLookup, true);
  run('no ip domain-lookup');
  assert.equal(cfg().ipDomainLookup, false);
  run('ip domain lookup');
  assert.equal(cfg().ipDomainLookup, true);
  run('no ip domain lookup');
  assert.equal(cfg().ipDomainLookup, false);
  run('ip domain-lookup');
  assert.equal(cfg().ipDomainLookup, true);
  run('ip domain-name kss.local');
  assert.deepEqual(cfg().extraLines, ['ip domain name kss.local']);
  run('ip domain name lab.local');
  assert.deepEqual(cfg().extraLines, ['ip domain name lab.local']);
  run('no ip domain name');
  assert.deepEqual(cfg().extraLines, []);
});

test('typo in EXEC mode with no ip domain-lookup does not wait', () => {
  const { run } = lab();
  run('no ip domain-lookup'); run('end');
  const o = run('shwo');
  assert.equal(o.delayMs, undefined);
  assert.match(o.output, /^Translating "shwo"\n% Unknown command or computer name/);
});

test('banner motd: one line, several lines, ^C delimiter, no banner', () => {
  const { w, s, run, cfg } = lab();
  let o = run('banner motd #Authorized access only#');
  assert.equal(o.status, 'ok'); assert.equal(o.output, '');
  assert.equal(cfg().bannerMotd, 'Authorized access only');
  o = run('banner motd $');
  assert.equal(o.output, "Enter TEXT message.  End with the character '$'.\n");
  assert.equal(o.prompt, '');
  run('Welcome to R1');
  o = run('Keep out$ ignored');
  assert.equal(o.prompt, 'Router(config)#');
  assert.equal(cfg().bannerMotd, '\nWelcome to R1\nKeep out');
  run('banner motd ^CHello^C');
  assert.equal(cfg().bannerMotd, 'Hello');
  run('banner #Short#');
  assert.equal(cfg().bannerMotd, 'Short');
  assert.equal(run('banner motd').status, 'rejected');
  run('no banner motd');
  assert.equal(cfg().bannerMotd, undefined);
  // Ctrl-C while typing a banner keeps the old one
  run('banner motd #Old#');
  run('banner motd #');
  interrupt(w, s, 'ctrl-c');
  assert.equal(cfg().bannerMotd, 'Old');
  // other banners are accepted as extra lines
  o = run('banner login #Login please#');
  assert.equal(o.status, 'ok'); assert.match(o.notes[0], /not simulated/);
  assert.deepEqual(cfg().extraLines, ['banner login ^CLogin please^C']);
  run('no banner login');
  assert.deepEqual(cfg().extraLines, []);
});

test('username: privilege, secret/password, type 0/7, autocommand, no username', () => {
  const { run, cfg } = lab();
  run('username admin privilege 15 secret s3cret');
  run('username reportuser privilege 15 password 0 troper');
  run(`username bob password 7 ${type7Encode('bobpw')}`);
  assert.deepEqual(cfg().users, [
    { name: 'admin', secret: 's3cret', privilege: 15 },
    { name: 'reportuser', secret: 'troper', privilege: 15 },
    { name: 'bob', secret: 'bobpw' },
  ]);
  run('username bob secret newpw');
  assert.equal(cfg().users.find((u) => u.name === 'bob')!.secret, 'newpw');
  let o = run('username reportuser autocommand menu report');
  assert.equal(o.status, 'ok');
  assert.deepEqual(cfg().extraLines, ['username reportuser autocommand menu report']);
  run('no username reportuser');
  assert.deepEqual(cfg().users.map((u) => u.name), ['admin', 'bob']);
  assert.deepEqual(cfg().extraLines, []);
  o = run('username x secret');
  assert.equal(o.status, 'incomplete');
});

test('alias: exec/configure/interface, replace, expansion, no alias', () => {
  const { run, cfg } = lab();
  run('alias exec ct configure terminal');
  run('alias configure h hostname');
  run('alias exec ct conf t');
  assert.deepEqual(cfg().aliases, [
    { mode: 'exec', name: 'ct', command: 'conf t' },
    { mode: 'configure', name: 'h', command: 'hostname' },
  ]);
  assert.equal(run('h EDGE').prompt, 'EDGE(config)#');
  run('end');
  assert.equal(run('ct').prompt, 'EDGE(config)#');
  run('no alias exec ct');
  assert.equal(cfg().aliases.length, 1);
  assert.equal(run('alias line x y').status, 'invalid');
});

test('accepted-but-not-simulated globals: stored canonically, defaults not stored, note shown', () => {
  const { w, s, run, cfg } = lab();
  let o = run('no cdp run');
  assert.equal(o.status, 'ok'); assert.match(o.notes[0], /^Accepted, but not simulated: CDP\./);
  assert.deepEqual(cfg().extraLines, ['no cdp run']);
  run('cdp run');
  assert.deepEqual(cfg().extraLines, []);
  run('ip cef'); run('ip classless'); run('ip subnet-zero'); run('service timestamps log datetime msec');
  assert.deepEqual(cfg().extraLines, []);
  run('service timestamps debug uptime');
  run('no service pad');
  run('ip ssh version 2'); run('ip ssh version 1');
  run('ntp server 10.0.0.1'); run('ntp server 10.0.0.2 prefer'); run('no ntp server 10.0.0.1');
  run('ip http server'); run('no ip http secure-server');
  run('license boot level network-advantage addon dna-advantage');
  run('ip name-server 8.8.8.8');
  run('config-register 0x2102');
  assert.deepEqual(cfg().extraLines, [
    'service timestamps debug uptime', 'no service pad', 'ip ssh version 1', 'ntp server 10.0.0.2 prefer',
    'ip http server', 'no ip http secure-server', 'license boot level network-advantage addon dna-advantage',
    'ip name-server 8.8.8.8', 'config-register 0x2102',
  ]);
  o = run('config-register 0xZZ');
  assert.equal(o.status, 'rejected');
  assert.equal(o.output.split('\n')[0], ' '.repeat('Router(config)#config-register '.length) + '^');
  // informational lines from a saved configuration are accepted silently
  for (const l of ['version 17.3', 'boot-start-marker', 'boot-end-marker', 'ip forward-protocol nd']) {
    o = run(l); assert.equal(o.status, 'ok', l); assert.deepEqual(o.notes, []);
  }
  assert.equal(cfg().extraLines.length, 9);
  assert.deepEqual(inspectLine(w, s, 'no cdp run'), { status: 'ok', feature: 'system', mutates: true });
});

test('crypto key generate rsa: needs hostname and domain name, asks the modulus', () => {
  const { run } = lab();
  let o = run('crypto key generate rsa modulus 1024');
  assert.equal(o.output, '% Please define a hostname other than Router.\n');
  run('hostname R1');
  o = run('crypto key generate rsa');
  assert.equal(o.output, '% Please define a domain-name first.\n');
  run('ip domain-name kss.local');
  o = run('crypto key generate rsa general-keys modulus 1024');
  assert.match(o.output, /^The name for the keys will be: R1\.kss\.local\n$/);
  assert.match(o.notes[0], /1024-bit key was not created/);
  assert.equal(o.mutated, false);
  assert.equal(o.feature, 'vty');
  o = run('crypto key generate rsa');
  assert.equal(o.prompt, 'How many bits in the modulus [2048]: ');
  o = run('100');
  assert.match(o.output, /between 512 and 4096/); assert.equal(o.prompt, 'How many bits in the modulus [2048]: ');
  o = run('');
  assert.match(o.notes[0], /2048-bit key was not created/); assert.equal(o.prompt, 'R1(config)#');
});

test('menu title (multi-line) and menu items are kept as extra lines', () => {
  const { run, cfg } = lab();
  let o = run('menu report title ^');
  assert.equal(o.output, "Enter TEXT message.  End with the character '^'.\n");
  run('*** Reporting menu ***');
  o = run('^');
  assert.equal(o.prompt, 'Router(config)#');
  run('menu report text 1 Show IP Interface Brief');
  run('menu report command 1 shi');
  run('menu report command 1 show ip interface brief');
  assert.deepEqual(cfg().extraLines, [
    'menu report title ^C\n*** Reporting menu ***\n^C',
    'menu report text 1 Show IP Interface Brief',
    'menu report command 1 show ip interface brief',
  ]);
  run('no menu report');
  assert.deepEqual(cfg().extraLines, []);
});

test('? help lists the base global commands with IOS help texts', () => {
  const { w, s } = lab();
  const h = helpFor(w, s, '');
  assert.match(h, /hostname\s+Set system's network name/);
  assert.match(h, /banner\s+Define a login banner/);
  assert.match(h, /username\s+Establish User Name Authentication/);
  assert.match(helpFor(w, s, 'enable secret '), /0\s+Specifies an UNENCRYPTED password will follow/);
  assert.match(helpFor(w, s, 'service '), /password-encryption\s+Encrypt system passwords/);
});
