#!/usr/bin/env node
/** Chromium smoke test for a built index.html; uses an already-installed puppeteer-core (no npm install). */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const [htmlPath, ...widthArgs] = process.argv.slice(2);
if (!htmlPath || !process.env.CHROME_PATH) {
  console.error('Usage: CHROME_PATH=/path/to/chrome [PUPPETEER_CORE=/path/to/puppeteer-core] node scripts/browser-smoke.mjs /tmp/build/index.html [1440x900 1280x800 1024x768]');
  process.exit(2);
}
const require = createRequire(import.meta.url);
const puppeteer = require(process.env.PUPPETEER_CORE || 'puppeteer-core');
const widths = (widthArgs.length ? widthArgs : ['1440x900', '1280x800', '1024x768']).map((v) => {
  const pair = /^([1-9]\d{2,3})x([1-9]\d{2,3})$/.exec(v);
  assert(pair, `Invalid viewport ${v}`);
  return { width: Number(pair[1]), height: Number(pair[2]) };
});
const html = await readFile(resolve(htmlPath));
assert.match(html.toString('utf8'), /<script type="module"[^>]*>[\s\S]{100000,}<\/script>/, 'Expected a production HTML bundle with an inlined module');
const temp = await mkdtemp(join(tmpdir(), 'kss-netlab-browser-'));
const server = createServer((request, response) => {
  if (request.url === '/') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(html);
  } else if (request.url === '/favicon.ico') response.writeHead(204).end();
  else response.writeHead(404).end();
});
await new Promise((done, reject) => server.once('error', reject).listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${server.address().port}/`;
const face = (id) => `[data-device="${id}"]`;
const sticker = (id) => `${face(id)} .wb-sticker`;
const r1 = sticker('R1');
const port = (device, name) => `.wb-canvas [data-port-device="${device}"][data-port="${name}"]`;
const live = '.wb-win--terminal .wb-tl--live';
const out = '.wb-win--terminal [role="log"]';
const top = '.nl-top-actions button';
const closeWindow = '.wb-win-btn--close';
const cableDialog = (id) => `.wb-modal-box[aria-label="${id} needs a console cable"]`;
const need = cableDialog('R1');
const editor = '.wb-cfg .wb-editor-text';
const topModal = '.nl-modal';
const fixtures = {
  invalid: 'hostname BrowserInvalid\r\nnot-a-real-ios-command\r\nend\r\n',
  valid: 'hostname BrowserSmoke\r\ninterface GigabitEthernet0/0/0\r\n description Browser verified\r\n shutdown\r\nexit\r\nend\r\n',
};
for (const [id, text] of Object.entries(fixtures)) await writeFile(join(temp, `${id}.cfg`), text);

async function matches(page, selector, pattern, timeout = 5000) {
  try {
    await page.waitForFunction((s, source, flags) => [...document.querySelectorAll(s)].some((e) => new RegExp(source, flags).test(e.innerText ?? e.textContent ?? '')), { timeout }, selector, pattern.source, pattern.flags);
  } catch (e) {
    const actual = await page.$$eval(selector, (els) => els.map((el) => (el.innerText ?? el.textContent ?? '').slice(-500)));
    throw new Error(`Expected ${selector} to include ${pattern}; got ${JSON.stringify(actual)}`, { cause: e });
  }
}
async function button(page, scope, label) {
  const h = await page.waitForFunction((s, p, f) => [...document.querySelectorAll(s)].find((e) => e.getClientRects().length && new RegExp(p, f).test(e.innerText.trim().replace(/\s+/g, ' '))), {}, scope, label.source, label.flags)
    .catch(async (cause) => { throw new Error(`No button ${scope} matching ${label}; saw ${JSON.stringify(await page.$$eval(scope, (els) => els.map((e) => e.innerText)))}`, { cause }); });
  const el = h.asElement();
  assert(el);
  try { await el.click(); } finally { await h.dispose(); }
}
async function chord(page, modifier, key) {
  await page.keyboard.down(modifier);
  try { await page.keyboard.press(key); } finally { await page.keyboard.up(modifier); }
}
async function click(page, selector) {
  const h = await page.waitForSelector(selector, { visible: true });
  try { await h.click(); } finally { await h.dispose(); }
}
async function noText(page, selector, pattern) {
  const content = await page.$$eval(selector, (els) => els.map((e) => e.innerText ?? e.textContent ?? '').join('\n'));
  assert.doesNotMatch(content, pattern);
}
async function closeInspector(page) {
  if (await page.$('.wb-insp-x')) await click(page, '.wb-insp-x');
}
async function start(page, mode) {
  await page.goto(url, { waitUntil: 'load' });
  await button(page, '#fam-lab .nl-scard-btn', /^Lab: cabling and basic router setup/);
  await click(page, `label[data-mode="${mode}"]`);
  if (mode === 'exam') {
    await click(page, '.nl-start-timer input[type=number]');
    await chord(page, 'Control', 'a');
    await page.keyboard.type('5');
  }
  await button(page, '.nl-modal-foot button', /^Start in .* mode/);
  await page.waitForSelector(`.wb-root[data-mode="${mode}"]`, { visible: true });
  // Let layout settle after ResizeObserver fits the world and moves any overlapping devices.
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
}
async function hit(page, selector, kind) {
  const detail = await page.$eval(selector, (el, match) => {
    const r = el.getBoundingClientRect();
    const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
    const topmost = document.elementFromPoint(x, y);
    const dev = el.closest('[data-device]');
    return { x, y, device: dev?.getAttribute('data-device'), over: topmost?.outerHTML.slice(0, 200), ok: match === 'port' ? topmost?.closest('[data-port]') === el : topmost?.closest('[data-device]') === dev && !topmost?.closest('[data-port]') };
  }, kind);
  assert(detail.ok, `${selector} not hit-testable at (${detail.x}, ${detail.y}); saw ${detail.over}`);
  return detail;
}
async function openDevice(page, selector, right = false) {
  const { x, y, device } = await hit(page, selector, 'device');
  if (right) { await page.mouse.click(x, y, { button: 'right' }); return; }
  await page.evaluate(() => { window.__netlabSmokeInput.length = 0; });
  await page.mouse.click(x, y, { count: 2 });
  const events = await page.evaluate(() => window.__netlabSmokeInput.filter((e) => e.type === 'pointerdown' || e.type === 'dblclick'));
  assert.deepEqual(events.map((e) => [e.type, e.trusted, e.device, e.inspector]), [
    ['pointerdown', true, device, undefined], ['pointerdown', true, device, undefined], ['dblclick', true, device, undefined],
  ], `${device} at (${x}, ${y}) must receive both mouse downs and the native dblclick. Got ${JSON.stringify(events)}`);
}
async function verifyTrusted(page, expected) {
  const events = await page.evaluate(() => window.__netlabSmokeInput.slice());
  assert(events.some((e) => e.trusted && Object.entries(expected).every(([k, v]) => e[k] === v)), `No trusted browser event matching ${JSON.stringify(expected)}; last events ${JSON.stringify(events.slice(-12))}`);
}
async function dragCable(page, kind, from, to, cableExists = true) {
  const a = await hit(page, port(...from), 'port'), b = await hit(page, port(...to), 'port');
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  try {
    await page.mouse.move(b.x, b.y, { steps: 18 });
    await page.waitForSelector('.wb-band', { visible: true });
    const final = await hit(page, port(...to), 'port');
    assert.deepEqual([final.x, final.y], [b.x, b.y], 'Target moved under the pointer');
  } finally { await page.mouse.up(); }
  await verifyTrusted(page, { type: 'pointerdown', port: from.join('/'), buttons: 1 });
  await verifyTrusted(page, { type: 'pointermove', port: to.join('/'), buttons: 1 });
  await verifyTrusted(page, { type: 'pointerup', port: to.join('/'), buttons: 0 });
  await page.waitForSelector('.wb-band', { hidden: true });
  if (cableExists) await page.waitForSelector(`.wb-cable--${kind}`);
}
async function cmd(page, text, prompt) {
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
  if (prompt) await matches(page, live, prompt);
}
async function importConfig(page, id) {
  const [chooser] = await Promise.all([
    page.waitForFileChooser(), click(page, '.wb-cfg-tools button:nth-of-type(2)'),
  ]);
  await chooser.accept([join(temp, `${id}.cfg`)]);
  await matches(page, '.wb-confirm', new RegExp(`Replace the running config editor text with ${id}\\.cfg`));
}
async function exportConfig(page, dir) {
  await button(page, '.wb-cfg-tools button', /^Export/);
  const file = join(dir, 'R1-running-config.txt');
  for (let i = 0; i < 80; i++) {
    try { await access(file); return readFile(file, 'utf8'); } catch { await sleep(75); }
  }
  throw new Error(`No completed export download. Directory: ${(await readdir(dir)).join(', ')}`);
}
async function closeTopModal(page) {
  await page.keyboard.press('Escape');
  await page.waitForSelector(topModal, { hidden: true });
}
function progress(step) { console.log(`  ✓ ${step}`); }

async function guided(page) {
  await start(page, 'guided');
  await matches(page, '.nl-task [role="tab"][aria-selected="true"]', /^Steps/);
  await matches(page, '.nl-steps .nl-progress', /0 of \d+ steps done/);
  assert(await page.$('.nl-step-row:disabled'), 'Guided mode should lock later steps');
  await button(page, top, /\bTools$/);
  await matches(page, '.nl-side', /Packet walkthrough/);
  progress('guided mode opens Steps, locks later steps and permits Tools');
}

async function deviceGestures(page, id) {
  await start(page, 'free');
  const panel = `.wb-insp[aria-label="Selected device ${id}"]`;
  const showsPc = id === 'PC3';
  const opened = showsPc ? '.wb-win--pc' : cableDialog(id);
  const expectOpen = async () => {
    if (showsPc) await matches(page, `${opened} .wb-win-name`, /^PC3\b/);
    else await matches(page, opened, /terminal on R2 only opens through a console cable/);
  };
  const close = async () => {
    if (showsPc) await click(page, `${opened} ${closeWindow}`);
    else await page.keyboard.press('Escape');
    await page.waitForSelector(opened, { hidden: true });
  };
  const expectSelectionOnly = async () => {
    await page.waitForSelector(`${face(id)}.is-selected`, { visible: true });
    await page.waitForSelector(panel, { visible: true });
    assert.equal(await page.$(opened), null, `${id} single activation should select, not open`);
  };

  await openDevice(page, sticker(id));
  await expectOpen();
  await close();
  await closeInspector(page);

  const { x, y } = await hit(page, sticker(id), 'device');
  await page.mouse.click(x, y);
  await expectSelectionOnly();
  const selected = await hit(page, sticker(id), 'device');
  assert.deepEqual([selected.x, selected.y], [x, y], 'Showing the inspector must not move the label');
  await openDevice(page, sticker(id));
  await expectOpen();
  await close();
  await closeInspector(page);
  progress(`${id}: native double-click before and after single-click selection; label stays hit-testable`);

  if (showsPc) {
    // A click-only activation has no pointer sequence (e.g. an accessibility client).
    await page.$eval(face(id), (el) => el.click());
    await expectSelectionOnly();
    await closeInspector(page);
    await page.focus(face(id));
    await page.keyboard.press('Space');
    await expectSelectionOnly();
    await verifyTrusted(page, { type: 'keydown', key: ' ', device: id });
    await page.keyboard.press('Enter');
    await verifyTrusted(page, { type: 'keydown', key: 'Enter', device: id });
    await expectOpen();
    progress(`${id}: click-only activation and Space select; Enter opens`);
  }
}

async function freeBench(page, download) {
  await start(page, 'free');
  await button(page, top, /\bTools$/);
  await matches(page, '.nl-side', /Packet walkthrough/);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.nl-side', { hidden: true });
  await openDevice(page, r1);
  await matches(page, need, /terminal on R1 only opens through a console cable/);
  assert.equal(await page.$('.wb-win--terminal'), null);
  await page.keyboard.press('Escape');
  await page.waitForSelector(need, { hidden: true });
  await closeInspector(page);
  await openDevice(page, r1, true);
  await button(page, '.wb-menu [role="menuitem"]', /Config file/);
  await matches(page, need, /configuration file is sent to R1 through a console cable/);
  await button(page, `${need} button`, /Pick up the console cable/);
  await closeInspector(page);
  await dragCable(page, 'console', ['PC1', 'COM1'], ['R1', 'Console']);
  await matches(page, '.wb-insp', /PC1 COM1.*R1 CON/s);
  await closeInspector(page);
  await click(page, '.wb-tray-item--straight');
  await dragCable(page, 'straight', ['PC1', 'Ethernet0'], ['SW1', 'GigabitEthernet1/0/1']);
  await matches(page, '.wb-insp', /PC1 Eth0.*SW1 Gi1\/0\/1/s);
  await closeInspector(page);
  await click(page, '.wb-tray-item--serial');
  await dragCable(page, 'serial', ['R1', 'Serial0/1/0'], ['R2', 'Serial0/1/0'], false);
  await matches(page, '.wb-modal-box', /which end is DCE\?/);
  await button(page, '.wb-modal-choices button', /DCE at R1/);
  await page.waitForSelector('.wb-cable--serial');
  await matches(page, '.wb-insp', /R1 Se0\/1\/0.*DCE.*R2 Se0\/1\/0.*DTE/s);
  await closeInspector(page);
  progress('uncabled console and config both denied; real console, Ethernet and serial drags (DCE choice)');

  await openDevice(page, r1);
  await matches(page, live, /initial configuration dialog\? \[yes\/no\]:/i);
  assert.equal(await page.evaluate(() => document.activeElement?.matches('.wb-win--terminal .wb-term-input')), true, 'Double-click should focus terminal input');
  await cmd(page, 'no', /^(Router|R1)>\s*$/);
  await matches(page, out, /Press RETURN/i);
  await page.keyboard.press('Enter');
  await matches(page, live, /^(Router|R1)>\s*$/);
  await cmd(page, 'enable', /^(Router|R1)#\s*$/);
  await cmd(page, 'configure terminal', /\(config\)#\s*$/);
  await cmd(page, 'hostname BrowserBefore', /^BrowserBefore\(config\)#\s*$/);
  await cmd(page, 'interface GigabitEthernet0/0/0', /^BrowserBefore\(config-if\)#\s*$/);
  await cmd(page, 'description Should disappear on replace');
  await cmd(page, 'ip address 192.0.2.1 255.255.255.0');
  await cmd(page, 'exit', /^BrowserBefore\(config\)#\s*$/);
  await chord(page, 'Control', 'z');
  await matches(page, live, /^BrowserBefore#\s*$/);
  await verifyTrusted(page, { type: 'keydown', key: 'Enter', term: true });
  await verifyTrusted(page, { type: 'keydown', key: 'z', ctrl: true, term: true });
  await cmd(page, 'copy running-config startup-config', /Destination filename \[startup-config\]\?/);
  await page.keyboard.press('Enter');
  await matches(page, out, /\[OK\]/);
  await matches(page, live, /^BrowserBefore#\s*$/);
  await click(page, `.wb-win--terminal ${closeWindow}`);
  await closeInspector(page);
  progress('router opens on native double-click; setup NO/RETURN; EXEC → enable → global → interface → exit/Ctrl+Z; startup copied');

  for (const pc of [{ id: 'PC1', prompt: /^C:\\Users\\student>\s*$/, command: 'ipconfig', output: /Windows IP Configuration/ }, { id: 'PC3', prompt: /^student@MacBook ~ %\s*$/, command: 'ifconfig en0', output: /en0: flags=/ }]) {
    await openDevice(page, sticker(pc.id));
    await button(page, '.wb-win--pc [role="tab"]', /^Command Prompt$/);
    await matches(page, '.wb-win--pc .wb-tl--live', pc.prompt);
    await page.keyboard.type(pc.command);
    await page.keyboard.press('Enter');
    await matches(page, '.wb-win--pc [role="log"]', pc.output);
    await click(page, `.wb-win--pc ${closeWindow}`);
    await closeInspector(page);
  }
  progress('Windows CMD ipconfig and macOS shell ifconfig respond after native double-click');

  await openDevice(page, r1, true);
  await button(page, '.wb-menu [role="menuitem"]', /Config file/);
  await matches(page, '.wb-cfg-status', /Console connected through PC1/);
  const baseline = await page.$eval(editor, (e) => e.value);
  assert.match(baseline, /^hostname BrowserBefore$/m);
  assert.match(baseline, /^ description Should disappear on replace$/m);
  await importConfig(page, 'invalid');
  await button(page, '.wb-confirm button', /No, keep my text/);
  assert.equal(await page.$eval(editor, (e) => e.value), baseline);
  await importConfig(page, 'invalid');
  await button(page, '.wb-confirm button', /Yes, use the file/);
  assert.equal(await page.$eval(editor, (e) => e.value), fixtures.invalid.replace(/\r\n/g, '\n'));
  const replace = async () => {
    await button(page, '.wb-cfg-bar button', /^Replace running config/);
    await matches(page, '.wb-confirm', /startup configuration is not changed/);
    await button(page, '.wb-confirm button', /Yes, replace running config/);
  };
  await replace();
  await matches(page, '.wb-cfg-report', /1 line failed/);
  await button(page, '.wb-cfg-tools button', /Read from device/);
  await button(page, '.wb-confirm button', /Yes, read from device/);
  assert.equal(await page.$eval(editor, (e) => e.value), baseline, 'Invalid replacement must be atomic');
  await importConfig(page, 'valid');
  await button(page, '.wb-confirm button', /Yes, use the file/);
  await replace();
  await matches(page, '.wb-cfg-report', /All lines were accepted.*replace the running configuration/s);
  await button(page, '.wb-cfg-tools button', /Read from device/);
  const reloadConfirmation = await page.$('.wb-confirm');
  if (reloadConfirmation) await button(page, '.wb-confirm button', /Yes, read from device/);
  await matches(page, '.wb-cfg-status', /Loaded the running config from R1/);
  const running = await page.$eval(editor, (e) => e.value);
  assert.match(running, /^hostname BrowserSmoke$/m);
  assert.match(running, /^ description Browser verified$/m);
  assert.doesNotMatch(running, /Should disappear on replace|192\.0\.2\.1/);
  assert.equal(await exportConfig(page, download), running, 'Downloaded running config should equal the editor text');
  await button(page, '.wb-cfg .wb-tab', /^Startup config/);
  const startup = await page.$eval(editor, (e) => e.value);
  assert.match(startup, /^hostname BrowserBefore$/m);
  assert.match(startup, /^ description Should disappear on replace$/m);
  assert.doesNotMatch(startup, /BrowserSmoke/);
  await click(page, `.wb-win--config ${closeWindow}`);
  await closeInspector(page);
  await openDevice(page, r1);
  await matches(page, live, /^BrowserSmoke#\s*$/);
  progress('browser chooser: cancel/accept import, invalid atomic replace, valid replace, real byte-checked export, startup unchanged, IOS prompt refresh');
  await click(page, '.wb-win--terminal [aria-label="Minimise window to the dock"]');
  await closeInspector(page);
  const con = await hit(page, port('R1', 'Console'), 'port');
  await page.mouse.click(con.x, con.y);
  await button(page, '.wb-insp button', /^Unplug this cable$/);
  await page.waitForSelector('.wb-cable--console', { hidden: true });
  await click(page, '.wb-dock-chip.is-min');
  await matches(page, '.wb-win--terminal .wb-tclosed', /console.*(unplugged|disconnected|not connected)|no console cable/is);
  await click(page, '.wb-win--terminal .wb-tclosed button');
  await matches(page, need, /terminal on R1 only opens through a console cable/);
  progress('active console closes when unplugged; reopening without the cable is denied');
}

async function exam(page, testExpiry) {
  await start(page, 'exam');
  const locked = async () => {
    await noText(page, top, /\bTools$|\bCheck$/m);
    assert.equal(await page.$('.nl-side[aria-label="Tools"]'), null);
    assert.equal(await page.$('.nl-task [role="tab"][aria-controls$="-steps"]'), null);
  };
  await locked();
  await matches(page, '.nl-clock', /5 min left/);
  await click(page, '.nl-clock button[aria-label="Hide the time"]');
  await button(page, '.nl-clock-btn', /Show time/);
  await matches(page, '.nl-clock', /5 min left/);
  await button(page, top, /\bSettings$/);
  assert.deepEqual(await page.$$eval('.nl-set-sec[aria-labelledby="set-bench"] :is(input, select)', (els) => els.map((e) => e.disabled)), [true, true]);
  await closeTopModal(page);
  if (testExpiry) {
    // Advance the real Chromium page clock, not React state. User interactions remain genuine Chromium input.
    const cdp = await page.createCDPSession();
    const expired = new Promise((done) => cdp.once('Emulation.virtualTimeBudgetExpired', done));
    try {
      await cdp.send('Emulation.setVirtualTimePolicy', { policy: 'advance', budget: 315000, maxVirtualTimeTaskStarvationCount: 1000 });
      await Promise.race([expired, sleep(5000, null, { ref: false }).then(() => { throw new Error('Virtual exam timer did not elapse'); })]);
      await cdp.send('Emulation.setVirtualTimePolicy', { policy: 'advance' });
      await matches(page, '.nl-clock[data-state="up"]', /Time is up/);
      await matches(page, '.nl-notice-title', /^Time is up$/);
      await noText(page, top, /\bReport$/m);
      assert.equal(await page.$('.nl-report'), null, 'No automatic report at time-up');
      progress('exam clock expiry notifies and does not grade (315 s virtual time under CDP)');
    } finally { await cdp.detach(); }
  }
  await button(page, top, /Finish exam$/);
  await matches(page, topModal, /Finish the exam\?/);
  await button(page, '.nl-modal-foot button', /^Not yet$/);
  await page.waitForSelector(topModal, { hidden: true });
  assert.equal(await page.$('.nl-report'), null);
  await button(page, top, /Finish exam$/);
  await button(page, '.nl-modal-foot button', /^Yes, finish and grade$/);
  await matches(page, '.nl-report', /Your report.*final grade.*0 of 18 points/s);
  await closeTopModal(page);
  await matches(page, '.nl-top-left', /Exam finished/);
  await noText(page, top, /Finish exam/);
  await button(page, top, /\bReport$/);
  await matches(page, '.nl-report', /final grade.*0 of 18 points/s);
  await closeTopModal(page);
  await locked();
  progress('exam Tools/Check/Steps absent; strict cabling/WAN QoS settings locked; timer hide/show; cancel, manually grade and reopen 0/18 report');
}

let browser;
try {
  browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH, headless: true, userDataDir: join(temp, 'profile'),
    args: ['--disable-background-networking', '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', ...(process.env.CHROME_NO_SANDBOX === '1' ? ['--no-sandbox', '--disable-setuid-sandbox'] : [])],
  });
  console.log(`${await browser.version()} | ${resolve(htmlPath)} | sha256 ${createHash('sha256').update(html).digest('hex')}`);
  for (const [i, viewport] of widths.entries()) {
    const tag = `${viewport.width}x${viewport.height}`;
    console.log(tag);
    const dir = join(temp, `downloads-${i}`);
    await mkdir(dir);
    const context = await browser.createBrowserContext({ downloadBehavior: { policy: 'allow', downloadPath: dir } });
    const errors = [], warnings = [], isolated = new Set(), failedRequests = [], httpErrors = [];
    const page = await context.newPage();
    let viewportFailed = false;
    try {
      page.setDefaultTimeout(6500);
      await page.setViewport(viewport);
      await page.evaluateOnNewDocument(() => {
        const trace = window.__netlabSmokeInput = [];
        for (const type of ['pointerdown', 'pointermove', 'pointerup', 'dblclick', 'keydown']) {
          window.addEventListener(type, (e) => {
            const el = e.target instanceof Element ? e.target : null;
            const end = el?.closest('[data-port]');
            trace.push({ type, trusted: e.isTrusted, port: end ? `${end.dataset.portDevice}/${end.dataset.port}` : null, device: el?.closest('[data-device]')?.dataset.device, inspector: el?.closest('.wb-insp')?.getAttribute('aria-label'), buttons: e.buttons, term: !!el?.matches('.wb-term-input'), key: e.key, ctrl: !!e.ctrlKey });
            if (trace.length > 400) trace.shift();
          }, { capture: true, passive: true });
        }
      });
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); if (m.type() === 'warn' || m.type() === 'warning') warnings.push(m.text()); });
      page.on('pageerror', (e) => errors.push(e.stack ?? String(e)));
      page.on('error', (e) => errors.push(e.stack ?? String(e)));
      page.on('requestfailed', (r) => failedRequests.push(`${r.url()} ${r.failure()?.errorText}`));
      page.on('response', (r) => { if (r.status() >= 400) httpErrors.push(`${r.status()} ${r.url()}`); });
      await page.setRequestInterception(true);
      page.on('request', (r) => {
        const address = new URL(r.url());
        if (address.origin === new URL(url).origin || ['data:', 'blob:', 'about:'].includes(address.protocol)) return r.continue();
        isolated.add(address.origin);
        if (address.origin === 'https://fonts.googleapis.com') return r.respond({ status: 200, contentType: 'text/css', body: '/* offline smoke: intentional font fallback */' });
        return r.abort('blockedbyclient');
      });
      const phases = [
        ['guided', () => guided(page)],
        ['PC3 interaction', () => deviceGestures(page, 'PC3')],
        ['R2 interaction', () => deviceGestures(page, 'R2')],
        ['free bench', () => freeBench(page, dir)],
        ['exam', () => exam(page, i === 0)],
      ];
      for (const [name, run] of phases) {
        try { await run(); } catch (e) {
          viewportFailed = true;
          console.error(`  ✗ ${name}: ${e.stack ?? e}`);
          await page.screenshot({ path: join(temp, `${tag}-${name.replaceAll(' ', '-')}.png`) }).catch(() => {});
        }
      }
      console.log(`  runtime: ${errors.length} errors, ${warnings.length} warnings, ${failedRequests.length} failed network requests, ${httpErrors.length} HTTP errors; offline-intercepted origins: ${[...isolated].join(', ') || 'none'}`);
      for (const value of [...errors, ...warnings, ...failedRequests, ...httpErrors]) console.log(`    ${value}`);
      if (errors.length || failedRequests.length || httpErrors.length) viewportFailed = true;
    } finally { await context.close(); }
    if (viewportFailed) process.exitCode = 1;
  }
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
  await rm(join(temp, 'profile'), { recursive: true, force: true });
  if (process.exitCode || process.env.KEEP_BROWSER_RUN === '1') console.log(`Temporary browser evidence: ${temp}`);
  else await rm(temp, { recursive: true, force: true });
}
