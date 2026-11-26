/**
 * Contract test between the Lab and the workbench's terminal model (src/ui/bench/windows/termModel.ts, plain TypeScript):
 * what the Lab returns must show up correctly on the student's terminal — console messages, guide cards, a closed console
 * after the cable is pulled, Telnet inside the PC's command prompt, prompts that change behind the terminal's back.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GI, R1_CONFIG, cableBench, cableId, makeLab, ok, plugConsole, port } from './fixture.ts';
import { TermModel, TermRegistry } from '../../src/ui/bench/windows/termModel.ts';
import type { ExecView, LabApi, SessionView } from '../../src/engine/labapi.ts';
import type { Lab } from '../../src/engine/lab.ts';

function setup(id = 'mini', mode: 'guided' | 'free' = 'free') {
  const { lab } = makeLab();
  ok(lab.startScenario(id, mode));
  lab.updateSettings({ terminalPaging: false });
  const registry = new TermRegistry(lab);
  // the workbench calls syncAll() after every lab change
  lab.subscribe(() => registry.syncAll());
  return { lab, registry };
}
/** What the workbench's connectConsole() does. */
function connect(lab: Lab, registry: TermRegistry, deviceId: string): TermModel {
  const r = lab.openConsole(deviceId);
  assert.ok(r.ok, r.ok ? '' : r.message);
  const model = registry.console(deviceId);
  if (r.ok) model.attach(r.session, r.banner);
  return model;
}
function send(model: TermModel, ...lines: string[]): void {
  for (const l of lines) {
    assert.equal(model.phase, 'input', `terminal is ready for "${l}"`);
    model.setLine(l, l.length);
    model.enter();
  }
}
const screen = (model: TermModel) => model.plainText().split('\n');

test('console terminal: dialog, prompts and interface messages appear like on a real console', () => {
  const { lab, registry } = setup();
  cableBench(lab);
  plugConsole(lab, 'PC1', 'R1');
  const term = connect(lab, registry, 'R1');
  assert.equal(term.prompt, 'Would you like to enter the initial configuration dialog? [yes/no]: ');
  send(term, 'no', '', 'enable', 'configure terminal', 'hostname R1', `interface ${GI}`, 'ip address 10.0.1.1 255.255.255.0', 'no shutdown', 'end');
  const text = screen(term);
  assert.ok(text.includes('         --- System Configuration Dialog ---'));
  assert.ok(text.includes('Press RETURN to get started!'));
  const at = text.indexOf('R1(config-if)#no shutdown');
  assert.ok(at > 0);
  assert.match(text[at + 1], /^\*Mar  1 .*%LINK-3-UPDOWN: Interface GigabitEthernet0\/0\/0, changed state to up$/);
  assert.match(text[at + 2], /%LINEPROTO-5-UPDOWN/);
  assert.equal(text[at + 3], 'R1(config-if)#end');
  assert.match(text[at + 4], /%SYS-5-CONFIG_I: Configured from console by console$/);
  assert.equal(text.at(-1), 'R1#');
  assert.equal(term.phase, 'input');
  // a link change made on the bench is shown with the next thing the device prints
  ok(lab.removeCable(cableId(lab, port('PC1', 'Ethernet0'))));
  send(term, '');
  assert.match(screen(term).at(-3) ?? '', /changed state to down$/);
});

test('console terminal: pulling the cable closes it, plugging it back continues the same session', () => {
  const { lab, registry } = setup();
  plugConsole(lab, 'PC1', 'R1');
  const term = connect(lab, registry, 'R1');
  send(term, 'no', '', 'enable', 'configure terminal', 'hostname R1', 'interface loopback 1');
  assert.equal(term.prompt, 'R1(config-if)#');
  ok(lab.removeCable(cableId(lab, port('PC1', 'COM1'))));
  assert.equal(term.phase, 'closed');
  assert.match(term.closedReason, /console cable is not connected/);
  ok(lab.connectCable('console', port('PC1', 'COM1'), port('R1', 'Console')));
  assert.equal(term.phase, 'closed', 'the student opens it again himself');
  const again = connect(lab, registry, 'R1');
  assert.equal(again, term);
  assert.equal(term.phase, 'input');
  assert.equal(term.prompt, 'R1(config-if)#');
  assert.ok(screen(term).includes('── connected again ──'));
  send(term, 'ip address 9.9.9.9 255.255.255.255', 'end');
  assert.equal(term.prompt, 'R1#');
  // logout: closed, and opening again starts a new EXEC with the "Press RETURN" text
  send(term, 'exit');
  assert.equal(term.phase, 'closed');
  connect(lab, registry, 'R1');
  assert.equal(term.prompt, 'R1>');
  assert.ok(screen(term).some((l) => /R1 con0 is now available/.test(l)));
});

test('console terminal: guided mode shows a guide card and does not send the line; a paste stops there', () => {
  const { lab, registry } = setup('mini', 'guided');
  plugConsole(lab, 'PC1', 'R1');
  const term = connect(lab, registry, 'R1');
  send(term, 'no', '', 'enable', 'configure terminal');
  term.paste('hostname R1\ninterface g0/0/0\nno shutdown\n');
  const text = term.plainText();
  assert.match(text, /\[Guide — step 1: Cable the bench\] You typed "hostname R1"\. Basic device settings are step 2\./);
  assert.match(text, /Paste stopped here\. 2 more lines were not sent\./);
  assert.equal(term.prompt, 'Router(config)#');
  assert.equal(lab.getState().journal.filter((e) => e.blocked).length, 1);
});

test('console terminal: a config file changes the hostname and the prompt follows', () => {
  const { lab, registry } = setup();
  cableBench(lab);
  plugConsole(lab, 'PC1', 'R1');
  const term = connect(lab, registry, 'R1');
  send(term, 'no', '', 'enable');
  assert.equal(term.prompt, 'Router#');
  assert.equal(lab.applyConfigText('R1', R1_CONFIG, 'merge').ok, true);
  assert.equal(term.prompt, 'R1#', 'picked up by sync() after the lab changed');
  send(term, '');
  assert.match(term.plainText(), /%SYS-5-CONFIG_I: Configured from console by console/);
});

test('PC command prompt: telnet turns the window into the router session and exit gives the prompt back', () => {
  const { lab, registry } = setup('mini-prebuilt');
  const cmd = registry.pc('PC1', 'windows', 'PC1');
  assert.equal(cmd.prompt, 'C:\\Users\\student>');
  send(cmd, 'ping 10.0.12.2');
  assert.ok(screen(cmd).includes('Reply from 10.0.12.2'));
  send(cmd, 'telnet 10.0.12.2');
  assert.equal(cmd.session?.kind, 'telnet');
  assert.deepEqual([cmd.prompt, cmd.secret], ['Password: ', true]);
  send(cmd, 'cisco');
  assert.deepEqual([cmd.prompt, cmd.secret], ['R2>', false]);
  assert.ok(!cmd.plainText().includes('cisco'), 'the password is not echoed');
  send(cmd, 'exit');
  assert.equal(cmd.session, null);
  assert.equal(cmd.prompt, 'C:\\Users\\student>');
  assert.equal(cmd.phase, 'input');
  send(cmd, 'ipconfig');
  assert.ok(screen(cmd).includes('IPv4 Address: 10.0.1.10'));
});

test('reload over Telnet: the Telnet window falls back to the PC prompt and the console restarts', () => {
  const { lab, registry } = setup('mini-prebuilt');
  plugConsole(lab, 'PC1', 'R2');
  const con = connect(lab, registry, 'R2');
  send(con, 'enable', 'configure terminal', 'enable secret class', 'line console 0', 'length 6', 'exit',
    'line vty 0 4', 'length 0', 'end', 'write memory', 'configure terminal');
  assert.equal(con.prompt, 'R2(config)#');
  const cmd = registry.pc('PC1', 'windows', 'PC1');
  send(cmd, 'telnet 10.0.12.2', 'cisco');
  assert.equal(cmd.session?.termLength, 0, 'the Telnet session inherits the selected VTY line length');
  send(cmd, 'enable', 'class', 'reload', '');
  assert.equal(cmd.session, null);
  assert.equal(cmd.prompt, 'C:\\Users\\student>');
  assert.equal(con.phase, 'input');
  assert.equal(con.prompt, 'R2>', 'the console prompt was reset by the reload');
  assert.equal(con.session?.termLength, 6, 'the existing console now reflects the saved default');
  send(con, '');
  assert.match(con.plainText(), /%SYS-5-RELOAD: Reload requested by vty0 \(10\.0\.1\.10\)/);
  assert.match(con.plainText(), /Press RETURN to get started!/);
});

test('console pager: Enter advances one line, Space a page, Ctrl-C aborts and length zero disables paging', () => {
  const { lab, registry } = setup();
  lab.updateSettings({ terminalPaging: true });
  plugConsole(lab, 'PC1', 'R1');
  const term = connect(lab, registry, 'R1');
  send(term, 'no', 'en', 'term len 5', 'sh run');
  assert.equal(term.phase, 'more');
  const n = screen(term).length;
  assert.equal(term.anyKey('Enter'), true);
  assert.equal(screen(term).length, n + 1);
  assert.equal(term.anyKey(' '), true);
  assert.equal(screen(term).length, n + 5);
  term.interrupt('ctrl-c');
  assert.equal(term.phase, 'input');
  assert.equal(term.prompt, 'Router#');
  send(term, 'terminal length 0', 'show run');
  assert.equal(term.phase, 'input');
  assert.equal(term.prompt, 'Router#');
});

test('console terminal never shows EXEC or echoes a password when login is interrupted', () => {
  const { lab, registry } = setup();
  plugConsole(lab, 'PC1', 'R1');
  const term = connect(lab, registry, 'R1');
  send(term, 'no', 'en', 'conf t', 'line con 0', 'password classroom', 'login', 'end', 'exit');
  connect(lab, registry, 'R1');
  assert.equal(term.prompt, 'Password: ');
  term.interrupt('ctrl-z');
  assert.equal(term.prompt, 'Password: ');
  term.interrupt('ctrl-c');
  assert.equal(term.prompt, 'Password: ');
  const before = term.plainText();
  send(term, 'classroom');
  assert.equal(term.prompt, 'Router>');
  assert.doesNotMatch(term.plainText().slice(before.length), /classroom/);
});

test('bulk console paste keeps blank confirmation lines, checks copied prompts, and stops unsafe trailing lines', () => {
  const { lab, registry } = setup();
  plugConsole(lab, 'PC1', 'R1');
  const term = connect(lab, registry, 'R1');
  term.paste('no\r\n\r\nenable\r\nconfigure terminal\r\nRouter(config)#hostname R1\r\nR1(config)#end\r\nR1#copy running-config startup-config\r\n\r\n');
  assert.equal(term.prompt, 'R1#');
  assert.match(lab.getConfigText('R1', 'startup'), /\nhostname R1\n/);
  term.paste('configure terminal\ninterface g0/0/0\ndescription first\ninterface g0/0/9\ndescription must-not-run\n');
  assert.match(term.plainText(), /Paste stopped here\. 1 more line was not sent/);
  assert.doesNotMatch(lab.getConfigText('R1', 'running'), /must-not-run/);
  term.paste('Other(config-if)#description wrong-device\nend\n');
  assert.match(term.plainText(), /pasted prompt does not match this terminal/);
  assert.equal(term.prompt, 'R1(config-if)#');
  term.paste('end\nreload\n\n');
  assert.match(term.prompt, /Save\?|Proceed with reload/);
  assert.match(term.plainText(), /Paste stopped here/);
});

test('credential-setting commands are echoed, recalled and journaled as typed; password prompts stay hidden', () => {
  const { lab, registry } = setup();
  plugConsole(lab, 'PC1', 'R1');
  const term = connect(lab, registry, 'R1');
  send(term, 'no', 'enable', 'configure terminal', 'ena sec fake-console-value', 'end');
  const sid = term.session!.id;
  assert.ok(lab.sessionHistory(sid).includes('ena sec fake-console-value'));
  assert.match(term.plainText(), /Router\(config\)#ena sec fake-console-value/);
  assert.match(JSON.stringify(lab.getState().journal), /ena sec fake-console-value/);
  send(term, 'disable');
  term.paste('enable\nfake-console-value\n');
  assert.equal(term.secret, true);
  assert.equal(term.line, '');
  assert.match(term.plainText(), /Paste stopped here/);
  send(term, 'fake-console-value');
  assert.equal(term.prompt, 'Router#');
  assert.equal(term.plainText().match(/fake-console-value/g)?.length, 1, 'only the config line, not the password reply');
});

test('authoritative console pager follows line defaults, aliases, do and reload', () => {
  const { lab, registry } = setup();
  lab.updateSettings({ terminalPaging: true });
  plugConsole(lab, 'PC1', 'R1');
  const file = lab.applyConfigText('R1', 'line console 0\n length 5\n!\nalias exec lp terminal length 0\nend\n', 'merge');
  assert.equal(file.ok, true);
  const term = connect(lab, registry, 'R1');
  assert.equal(term.session?.termLength, 5);
  send(term, 'enable', 'show running-config');
  assert.equal(term.phase, 'more');
  const paused = term.plainText();
  for (const key of ['?', 'Tab', 'x']) assert.equal(term.anyKey(key), true);
  assert.equal(term.phase, 'more');
  assert.equal(term.plainText(), paused);
  assert.equal(term.anyKey('q'), true);
  assert.equal(term.phase, 'input');
  send(term, 'lp', 'show running-config');
  assert.equal(term.phase, 'input');
  assert.equal(term.session?.termLength, 0);
  assert.equal(lab.getState().sessions[0]?.termLength, 0);
  send(term, 'terminal no length');
  assert.equal(term.session?.termLength, 5);
  send(term, 'configure terminal', 'do lp', 'do show running-config');
  assert.equal(term.phase, 'input');
  assert.equal(term.session?.termLength, 0);
  send(term, 'end', 'write memory', 'reload', '');
  term.anyKey('q');
  assert.equal(term.prompt, 'Router>');
  assert.equal(term.session?.termLength, 5);
  send(term, 'enable', 'show running-config');
  assert.equal(term.phase, 'more');
});

test('pending text and credentials are not CLI command prompts, even with an empty prompt', () => {
  const { lab, registry } = setup();
  plugConsole(lab, 'PC1', 'R1');
  const term = connect(lab, registry, 'R1');
  send(term, 'no', 'enable', 'configure terminal', 'banner motd !');
  assert.equal(term.prompt, '');
  assert.deepEqual(term.pendingInput, { kind: 'text', paste: 'manual' });
  term.setLine('Banner', 6);
  assert.equal(term.help(), false);
  assert.equal(term.complete(), false);
  term.paste('?');
  term.paste('unsent\nextra');
  term.historyPrev();
  assert.equal(term.line, 'Banner?');
  term.enter();
  send(term, '!', 'enable secret 0 hidden?login', 'end', 'disable', 'enable');
  assert.deepEqual(term.pendingInput, { kind: 'password', paste: 'manual' });
  assert.equal(term.help(), false);
  assert.equal(term.complete(), false);
  term.paste('hidden?login');
  assert.deepEqual(term.inputEcho(), { kind: 'hidden' });
  term.enter();
  assert.equal(term.prompt, 'Router#');
  assert.equal(term.pendingInput, null);
  assert.doesNotMatch(term.plainText(), /unsent/);
  assert.equal(term.plainText().match(/hidden\?login/g)?.length, 1, 'only the config line, not the password reply');
  assert.match(lab.getConfigText('R1', 'running'), /Banner\?/);
});

test('paste distinguishes a command rejection from the same text in successful IOS output', () => {
  const { lab, registry } = setup();
  plugConsole(lab, 'PC1', 'R1');
  const term = connect(lab, registry, 'R1');
  send(term, 'no', 'enable', 'configure terminal', 'banner motd !', "% Invalid input detected at '^' marker.", '!', 'end');
  const sid = term.session!.id;
  const outcome = lab.sessionExec(sid, 'enable 1');
  assert.equal(outcome.status, 'rejected');
  assert.match(outcome.output, /privilege level 15/);
  term.paste('enable 1\nterminal length 0\n');
  assert.equal(term.session?.termLength, 24);
  assert.match(term.plainText(), /1 more line was not sent/);
  term.paste('show running-config\nconfigure terminal\nhostname Applied\n');
  assert.equal(term.prompt, 'Applied(config)#');
  assert.equal(lab.sessionExec(sid, 'do show running-config').status, 'ok');
});

test('crypto isakmp key is shown in full while typing and after Enter', () => {
  const { lab, registry } = setup();
  plugConsole(lab, 'PC1', 'R1');
  const term = connect(lab, registry, 'R1');
  send(term, 'no', 'enable', 'configure terminal');
  const typed = 'crypto isakmp key cisco123 address 60.50.30.2';
  term.setLine(typed, typed.length);
  assert.deepEqual(term.inputEcho(), { kind: 'plain', text: typed });
  term.enter();
  assert.match(term.plainText(), /Router\(config\)#crypto isakmp key cisco123 address 60\.50\.30\.2$/m);
  assert.match(lab.getConfigText('R1', 'running'), /crypto isakmp key cisco123 address 60\.50\.30\.2/);
});

test('custom credential aliases echo, help, history and journal show the text as typed', () => {
  const { lab, registry } = setup();
  plugConsole(lab, 'PC1', 'R1');
  const term = connect(lab, registry, 'R1');
  send(term, 'no', 'enable', 'configure terminal', 'alias configure pwd enable secret', 'alias configure embedded enable password embedded-value');
  term.setLine('pwd alias-argument', 18);
  assert.deepEqual(term.inputEcho(), { kind: 'plain', text: 'pwd alias-argument' });
  assert.match(term.plainText(), /Router\(config\)#pwd alias-argument$/);
  term.enter();
  send(term, 'embedded', 'end', 'show aliases configure');
  assert.match(term.plainText(), /embedded {14}enable password embedded-value/);
  const sid = term.session!.id;
  assert.match(lab.getConfigText('R1', 'running'), /enable secret 9 \$9\$sim\$/);
  send(term, 'configure terminal');
  const rejected = lab.sessionExec(sid, 'pwd 9 $9$unsupported$hash-value');
  assert.equal(rejected.status, 'rejected');
  assert.deepEqual(rejected.echo, { kind: 'plain', text: 'pwd 9 $9$unsupported$hash-value' });
  assert.ok(lab.sessionHistory(sid).includes('pwd alias-argument'));
  assert.match(JSON.stringify(lab.getState().journal), /pwd alias-argument/);
});

test('failed imported startup copy and VTY reload retain running state and console/Telnet sessions', () => {
  const { lab, registry } = setup('mini-prebuilt');
  plugConsole(lab, 'PC1', 'R2');
  const first = connect(lab, registry, 'R2');
  send(first, 'enable', 'configure terminal', 'enable secret fake-enable-pw', 'end');
  const imported = JSON.parse(lab.exportLab());
  imported.world.devices.R2.startupConfig = 'hostname NeverCommitted\nlegacy-unknown statement\n!\nenable secret 9 $9$legacy$saved-toy-value\n';
  ok(lab.importLab(JSON.stringify(imported)));
  const con = connect(lab, registry, 'R2');
  send(con, 'enable', 'fake-enable-pw');
  con.paste('copy start run\n\nconfigure terminal\n');
  assert.match(con.plainText(), /startup-config line 2:.*startup-config line 4:.*Copy canceled.*Paste stopped/s);
  assert.equal(con.prompt, 'R2#');
  const cmd = registry.pc('PC1', 'windows', 'PC1');
  send(cmd, 'telnet 10.0.12.2', 'cisco', 'enable', 'fake-enable-pw', 'reload', 'no', '');
  assert.equal(cmd.prompt, 'R2#');
  assert.equal(cmd.session?.kind, 'telnet');
  assert.equal(con.prompt, 'R2#');
  assert.match(cmd.plainText(), /startup-config line 2:.*startup-config line 4:.*Reload canceled/s);
  assert.match(con.plainText(), /startup-config line 4: enable secret 9 \$9\$legacy\$saved-toy-value/);
  assert.doesNotMatch(cmd.plainText(), /fake-enable-pw/, 'password replies are not echoed');
  assert.doesNotMatch(cmd.plainText() + con.plainText(), /SYS-5-RELOAD|NeverCommitted/);
  assert.match(lab.getConfigText('R2', 'running'), /hostname R2/);
});

test('legacy mock fallback does not guess length from input and treats unknown prompts as manual', () => {
  const calls: string[] = [];
  const session: SessionView = { id: 'old', deviceId: 'r', kind: 'console', pcId: 'pc', title: 'Console', prompt: 'Router#', secret: false, closed: false };
  const result = (output = '', prompt = 'Router#'): ExecView => ({ output, prompt, secret: false, closed: false, notes: [] });
  const mock = {
    getState: () => ({ settings: { terminalPaging: true }, sessions: [session] }),
    sessionExec: (_id: string, line: string) => {
      calls.push(line);
      if (line === 'show long') return result('row\n'.repeat(30));
      if (line === 'invalid') return result('% Incomplete command.\n');
      if (line === 'reply') return result('', 'Freeform reply: ');
      return result();
    },
  } as unknown as LabApi;
  const term = new TermModel(mock, { kind: 'console', deviceId: 'r' });
  term.attach(session, '');
  send(term, 'terminal length 0', 'show long');
  assert.equal(term.phase, 'more');
  term.anyKey('q');
  term.paste('invalid\nunsubmitted\n');
  term.paste('reply\nunsubmitted\n');
  assert.deepEqual(calls, ['terminal length 0', 'show long', 'invalid', 'reply']);
  assert.equal(term.help(), false);
  assert.equal(term.complete(), false);
});
