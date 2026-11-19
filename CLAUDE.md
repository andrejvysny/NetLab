# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

KSS NetLab: browser-only Cisco lab simulator (ISR 4331 routers, Catalyst 9300L switches, PCs) for the KSS practical exam. Student cables an empty bench, opens a console, configures via IOS-like CLI or config file, and is graded on what the network actually does. Imitates IOS XE 17.3 as used by the course; not real IOS.

## Commands
- Install: `npm install` (README uses npm; a `bun.lock` also exists).
- Dev server: `npm run dev`
- Build: `npm run build` → single self-contained `dist/index.html` (vite-plugin-singlefile + `scripts/postbuild.mjs`, which escapes `</head>`/`<body` sequences in inlined JS and appends font licences). `KSS-NetLab.html` at repo root is the release bundle.
- Typecheck: `npm run typecheck` (`tsc --noEmit -p tsconfig.json`)
- All tests: `npm test` (= `node --test "tests/**/*.test.ts"`). **Requires Node 24+** (native TS type stripping); no test framework, only `node:test` + `node:assert/strict`.
- One area: `node --test "tests/sim/**/*.test.ts"`; one file: `node --test tests/lab/grading.test.ts`; one test: add `--test-name-pattern "<regex>"`.
- Command coverage audit: `node scripts/command-coverage.mjs [--json|--csv] [--section A..G] [--device isr4331|c9300l] [--line N]` (probes `docs/course/cheat-sheet.txt`).
- `src/content/deviceSupport.generated.ts` is generated — do not hand edit; regenerate with `node scripts/generate-device-support.ts`. Snapshot CSV: `node scripts/command-coverage.mjs --csv > docs/command-coverage.csv`. `tests/content/` fails if either is stale (e.g. after changing CLI behaviour).
- Browser smoke (needs local Chrome + puppeteer-core, not a dependency): `CHROME_PATH=… node scripts/browser-smoke.mjs dist/index.html`, `node scripts/verified-worked-ui.mjs dist/index.html`.

## Architecture
```
src/engine/     pure TS "backend": deterministic, no DOM/React/timers/Math.random/Date.now
  types.ts      all shared types; World is plain JSON (structuredClone-safe)
  world.ts ip.ts  device catalogue/factory defaults, address + interface-name helpers
  cli/          framework.ts = pattern-DSL grammar engine; commands/*.ts = one module per feature; show/ = show output; index.ts installCli()
  config/       render.ts (IosConfig → running-config text), apply.ts (config text → device)
  sim/          what the network does: physical, switching, routing, acl, nat, ipsec, qos, dhcp, services, pipeline, flow (see sim/README.md)
  pc/           PC command prompt
  lab.ts + lab/ Lab controller implementing LabApi (sessions, journal, guided gating, persistence/storage)
  labapi.ts     the ONLY interface the UI uses
src/scenarios/  assignments as a Spec → buildInstance(): brief, checks, guide steps, model solution, faults (see scenarios/README.md)
src/ui/         React 19 UI; talks to engine only via LabApi (useLab()/useLabState())
src/content/    command sheet + generated device-support data
tests/          node:test, mirrored by area: cli, config, content, lab, pc, scenarios, sim
```

Key flows:
- CLI: each `commands/<name>.ts` exports `commands: CommandDef[]` + `install()`; handlers mutate structured `env.device.config` / `runtime` (text only in `extraLines`), reject with real IOS messages via `env.reject('% …')`. `feature` tag drives guided-mode gating and the journal; set `mutates: false` on pure navigation (`interface X`, `line vty …`). Valid-but-unmodelled IOS commands: accept, store in `extraLines`, `env.note('Accepted, but not simulated: …')`. Sub-mode state lives in `session.ctx`.
- Sim never parses CLI text; reads `IosConfig` + runtime tables. Public API fixed in `sim/index.ts` (ARCHITECTURE §4.2): `sendFlow` mutates, `probeFlow` runs on a clone.
- Router packet order (`sim/pipeline.ts`, keep exactly): inbound ACL → IPsec decrypt → NAT outside→inside → local delivery → routing → NAT inside→outside → crypto map encrypt → outbound ACL → QoS classify → transmit.
- Grading is behavioural: roles inferred from cabling, checks probe private world copies; config inspected only where behaviour can't show it. `grade`/`guideProgress` never mutate the world. Seed 0 = reference plan of `docs/COURSE.md`.
- Modes: guided (ordered steps, out-of-step mutations blocked), free, exam (no hints/tools, graded at end).

## Hard rules
- **Erasable TS syntax only**: no `enum`, `namespace`, constructor parameter properties (`erasableSyntaxOnly`). Engine runs directly under Node.
- Relative imports **include `.ts`/`.tsx` extension**; type-only imports **must** use `import type` (value import of a type crashes at runtime under Node type stripping).
- Engine determinism: use `world.tick` / `world.nextId`, never `Date.now()`/`Math.random()`.
- App may run in a sandboxed iframe: guard `localStorage`, clipboard, downloads (can throw) and offer fallbacks.
- Don't invent Cisco behaviour. Where real IOS XE differs from the course reference solution, follow the reference and record it as a hardware note (`docs/HARDWARE_NOTES.md`, `src/scenarios/hardwareNotes.ts`).
- User-facing text: plain English, short sentences (target user has dyslexia/ADHD); colour always paired with a text label. IOS output: faithful IOS XE wording.
- Don't add npm packages.

## Docs
- `docs/ARCHITECTURE.md` — original design + simulation decisions (§5 physical rules, §6 ACL/NAT/IPsec/QoS/DHCP/management semantics). Superseded where `docs/FINAL-VALIDATION.html` and `docs/final-*.md` say so.
- `docs/COURSE.md` — course facts and reference plan; `docs/COMMAND_COVERAGE.md` — command inventory; `docs/final-catalyst.md` — Catalyst Network Advantage NAT profile (`src/engine/natProfile.ts`).
- `src/engine/sim/README.md` — runtime key conventions (`aclHits`, `qosCounters`, ICMP id in `sport`, trace-step text rules) and deliberate simplifications.
