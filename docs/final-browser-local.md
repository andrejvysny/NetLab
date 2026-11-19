# Local Chromium verification

**Result after fix:** The production smoke passes at 1440 × 900, 1280 × 800 and 1024 × 768. A real double-click opens PC3 and reaches R2’s console-required dialog, with or without prior selection. The harness no longer substitutes the inspector’s **Open** button.

## Before and after: PC3 / R2 device activation

In a fresh **Free** session of **Lab: cabling and basic router setup**, double-click the device label without selecting the device first. Before the fix, the first trusted `pointerdown` on the device opened the inspector over the label; the next trusted `pointerdown` and `dblclick` went to the inspector. In the narrowest R2 test, the same coordinates happened to hit **Open terminal**, so a visible dialog alone was not proof that the device received the double-click.

| Tested on the same strict harness | 1440 × 900 | 1280 × 800 | 1024 × 768 |
| --- | --- | --- | --- |
| Before: PC3, unselected | Fail: inspector intercepted | Fail: inspector intercepted | Fail: inspector intercepted |
| Before: R2, unselected | Pass | Fail: inspector intercepted | Fail: inspector intercepted (dialog opened incidentally) |
| After: PC3 and R2, unselected and after a single selection click | Pass | Pass | Pass |
| After: PC3 click without a pointer sequence or Space selects; Enter opens | Pass | Pass | Pass |

Completed clicks now select the device; the browser still handles double-click recognition. The inspector chooses space around the selected face using the current bench view, without shifting the canvas or waiting on a timer. The regression checks assert that both trusted mouse downs and the trusted `dblclick` hit the same device. They also check that a single click selects without opening and leaves the label in place and still hit-testable. The earlier adjacent release bundle also reproduced the PC3 failure (`/agent/workspace/KSS-NetLab.html`, SHA-256 `b7b58963e97b73659cab42191ed24eae7103c2a1aa29113cdf0e379fd6a7471c`).

- Before: Vite 8.3.8 + postbuild, `/tmp/kss-netlab-browser-build.lXbURb/index.html`, SHA-256 `127e49f51d8c14a37613ef7624ca030437dab4ae62f88c88bc23333ce616ecd6`. Strict harness exit 1, log `/tmp/kss-browser-smoke-latch-before.log`, screenshots `/tmp/kss-netlab-browser-FbQ2Yz/`.
- After: Vite 8.3.8 + postbuild, `/tmp/kss-netlab-latch-build.qlofiW/index.html`, SHA-256 `4b2e5b4564154d86c9b808ad69ca7fdee516eb7232aa9ea26edf74f00dcb29b7`. Exit 0, log `/tmp/kss-browser-smoke-latch-after.log`, actual configuration downloads `/tmp/kss-netlab-browser-ugPehf/`.
- Both: Chrome for Testing 157.0.8103.78 in headless mode, preinstalled `puppeteer-core` 24.43.1, fresh browser storage per viewport; tests used Guided, Free and Exam modes.

## Other checks on the fixed build

| Actual UI check | 1440 × 900 | 1280 × 800 | 1024 × 768 |
| --- | --- | --- | --- |
| Guided opens Steps and locks later steps; Guided/Free allow Tools | Pass | Pass | Pass |
| Initial terminal/config require a console cable; console, Ethernet and serial port-to-port drags; choose DCE on R1 | Pass | Pass | Pass |
| R1 double-click focuses console; first-run dialog, enable/global/interface modes, exit, Ctrl+Z and saving startup config | Pass | Pass | Pass |
| Windows CMD `ipconfig`; macOS shell `ifconfig en0` reached through native device double-click | Pass | Pass | Pass |
| Config file chooser cancel/accept; failed replacement is atomic; valid replacement clears old settings, leaves startup intact and updates console prompt; download matches the editor byte for byte | Pass | Pass | Pass |
| Unplugging the console closes the session; reopening without it is denied | Pass | Pass | Pass |
| Exam locks Tools, Check, Steps and bench rules; timer hide/show; cancel finish, manually grade and reopen 0/18 report | Pass | Pass | Pass |
| Timeout shows notice but does not auto-grade | Pass (CDP virtual time) | Not repeated | Not repeated |
| Runtime console/page errors, console warnings, failed requests or HTTP errors | 0 each | 0 each | 0 each |

## Rerun on the candidate `dist/index.html`

```bash
cd /agent/workspace/kss-netlab
npm run build  # Vite + scripts/postbuild.mjs
export CHROME_PATH=/home/vercel-sandbox/.cache/puppeteer/chrome/linux-157.0.8103.78/chrome-linux64/chrome
export PUPPETEER_CORE="$(npm root -g)/hyperframes/node_modules/puppeteer-core"
CHROME_NO_SANDBOX=1 node scripts/browser-smoke.mjs dist/index.html 1440x900 1280x800 1024x768
```

Omit the build command if `dist/index.html` is already the candidate you need to verify. Use paths to an existing Chromium and `puppeteer-core` if running outside this sandbox. Set `CHROME_NO_SANDBOX=1` only if your isolated container requires it. Set `KEEP_BROWSER_RUN=1` to retain downloads after a pass; evidence is retained automatically on failure.

To build without touching the project's `dist/`, use the following instead of `npm run build`, then give the harness `"$out/index.html"` in place of `dist/index.html`. The copied postbuild script uses a symlink so its fixed `dist/` path resolves to this isolated output.

```bash
out=$(mktemp -d /tmp/kss-netlab-browser-build.XXXXXX)
./node_modules/.bin/vite build --outDir "$out"
mkdir -p "$out/postbuild/scripts"
cp scripts/postbuild.mjs "$out/postbuild/scripts/"
ln -s "$out" "$out/postbuild/dist"
node "$out/postbuild/scripts/postbuild.mjs"
rm -r "$out/postbuild"
```

The script serves only the supplied HTML on a random loopback port, prints its SHA-256 and uses a temporary profile, fixtures and downloads. Normal clicks, double-clicks, cable drags and keys use Chromium input. A separate click-only assertion uses `HTMLElement.click()` to verify selection without preceding pointer events; it is not a screen-reader test. File import uses Chromium’s file-chooser protocol after clicking **Import file…**, not an OS file-picker robot. Timer expiry advances Chromium virtual time by 315 s without mutating React state. External requests are blocked; the Google Fonts stylesheet is fulfilled with empty local CSS. This covers a top-level desktop page, not live font delivery, a hosted iframe, touch interaction, a full exam solution or physical network hardware.
