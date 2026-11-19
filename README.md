# KSS NetLab

A browser-only lab simulator for the KSS practical exam (Cisco ISR 4331 routers, Catalyst 9300L switches, PCs).
You get an assignment and an uncabled bench. You plug in the right cables, connect a console cable, configure the
devices in an IOS-style terminal or by applying a configuration file, and the lab grades what the network really does.

It imitates the parts of Cisco IOS XE that the course uses. It is not real IOS. Notes in each report say where the
real devices may behave differently.

The Catalyst **C9300L-24T-4G / IOS XE 17.3** bench has an explicit **Network Advantage** classroom profile
for basic IPv4 static NAT, pool NAT, and PAT on routed front-panel Ethernet ports. It is not ISR NAT on a
switchport or SVI. The default course handout still uses the ISR. See [Catalyst NAT scope and verification](docs/final-catalyst.md).

## Run it
- Easiest: unzip the release and open `KSS-NetLab.html` in a desktop browser. The fonts and simulator are bundled; no server is needed. If your browser blocks storage, use Settings → Export lab before closing. After a source build the equivalent file is `dist/index.html`.
- From source: `npm install`, then `npm run dev` (development) or `npm run build` (writes `dist/index.html`).
- Tests: `npm test` (Node 24 or newer). Type check: `npm run typecheck`.

## Layout
- `src/engine/` — the simulation "backend", pure TypeScript with no browser code:
  `cli/` (IOS command line), `config/` (running-config text), `sim/` (cables, routing, ACL, NAT, IPsec, QoS, DHCP,
  services), `pc/` (PC command prompt), `lab.ts` (controller behind the `LabApi` interface).
- `src/scenarios/` — assignments, guide steps, behavioural grading, model solutions, planted faults.
- `src/ui/` — React interface (bench canvas, terminals, task panel, report, tools). It only talks to `LabApi`.
- `docs/` — architecture, course facts, hardware notes.

## Final correctness review · 0.2.0

Open [the validation report](docs/FINAL-VALIDATION.html) for release test evidence and remaining limits. [Command inventory and Cisco references](docs/COMMAND_COVERAGE.md); the reproducible [CSV](docs/command-coverage.csv) and in-app **Commands → Device support** separate working, partial, syntax-only, unsupported and release-dependent forms. **Settings → Bench rules → WAN QoS profile** switches between classroom-compatible and after-encryption practice outside Exam mode. Practice scores are not instructor-issued marks.
