# KSS NetLab — architecture and working rules

> Original implementation design. For the verified 0.2.0 behavior, superseding decisions, and limitations, start with [FINAL VALIDATION](FINAL-VALIDATION.html), [device coverage](COMMAND_COVERAGE.md), and the `final-*.md` evidence reports.

Read this file, `docs/COURSE.md`, and the contract files listed in §4 before writing code.

## 1. Product
A browser-only simulator that rehearses a hands-on Cisco exam. The student receives an assignment sheet and a bench of
unconnected, unconfigured devices (2× ISR 4331, 2× Catalyst 9300L, PCs). They must:
1. cable the devices port-to-port with the correct cable type (Ethernet straight-through, Ethernet crossover, serial DCE/DTE, console),
2. connect a console cable from a PC before any terminal can be opened (always required),
3. configure the devices through an IOS-like terminal or by editing/applying a configuration file,
4. verify with show commands, ping, telnet, and
5. get graded on what the network actually does.

Modes: **guided** (ordered steps; a state-changing action that belongs to another step or device is stopped and explained),
**free** (any order, Check on demand, hints and tools available), **exam** (no hints/tools, optional ~3 h timer, graded at the end;
order problems are only reported). The user is a student with dyslexia and ADHD: plain English, short sentences, one thing at a time,
generous spacing, colour always paired with a text label.

No server. Everything runs in the browser; the app is built into ONE self-contained `dist/index.html`.
It may run inside a sandboxed iframe: `localStorage`, clipboard and downloads can throw or be unavailable — always guard and offer a fallback.

## 2. Layers
```
src/engine/      "backend": pure TypeScript, deterministic, no DOM, no React, no timers, no Math.random
  types.ts       shared state + contracts (World is plain JSON)
  ip.ts          IPv4 / interface-name / port helpers
  world.ts       device catalogue, factory defaults, world helpers
  cli/           IOS CLI: framework.ts (grammar engine) + commands/*.ts (one module per feature) + index.ts (installCli)
  config/        render.ts (running-config text) + apply.ts (config-file text → device)
  sim/           physical links, switching, routing, ACL, NAT, IPsec, QoS, DHCP, services, traces
  pc/            PC command prompt
  lab.ts         Lab class implementing LabApi (sessions, journal, guided gating, persistence)
  labapi.ts      the only interface the UI uses
src/scenarios/   assignments: brief, bench, requirements + behavioural checks, guide steps, model solution, faults
src/ui/          React UI (only talks to LabApi through useLab()/useLabState())
tests/           node:test suites, mirrored by area (tests/cli, tests/sim, tests/config, tests/scenarios, tests/lab)
docs/            this file, COURSE.md, HARDWARE_NOTES.md, course/ sources
```

## 3. Hard rules for all code
- TypeScript, **erasable syntax only**: no `enum`, no `namespace`, no constructor parameter properties. Classes are fine.
- Relative imports **include the `.ts`/`.tsx` extension**. Type-only imports **must** use `import type { … }`
  (engine files are executed directly by Node, which strips types; a value import of a type crashes at run time).
- Engine code must run under plain Node 24: `node --test "tests/**/*.test.ts"`. Tests use `node:test` + `node:assert/strict`. No test framework.
- Type-check with `npx tsc --noEmit -p tsconfig.json` (other agents work in parallel: ignore errors in files you do not own, fix all in yours).
- Do **not** add npm packages, edit `package.json`, `tsconfig.json`, `vite.config.ts`, or any file marked "Owned by the orchestrator".
  If a contract is missing something, work around it inside your own module and describe the gap in your final report.
- Only create/modify files you own (see your brief). Never run `git` commands. Never delete other agents' files.
- World state is plain JSON (structuredClone-safe). Engine functions take `world` explicitly; no hidden global state except the CLI command registry.
- Deterministic: no `Date.now()`/`Math.random()` in the engine. Use `world.tick` and `world.nextId`.
- User-facing text: plain English, short sentences, no jargon without the plain meaning. IOS output: faithful to real IOS XE wording.
- Do not invent Cisco behaviour. Where real IOS XE and the course's reference solution differ, the simulator follows the
  reference solution and the difference is recorded as a "hardware note" (see §6.9) — never silently.

## 4. Contracts (read them; they are the specification)
- `src/engine/types.ts` — every shared type. `World` → `Device` (`IosDevice` | `PcDevice`) → `IosConfig` (structured configuration)
  and `IosRuntime` (tables/counters). Also `Packet`, `FlowSpec`, `FlowResult`, `Delivery`, `TraceStep`, scenario/grading types.
- `src/engine/world.ts` — `createWorld`, `addDevice(world, seed)`, `defaultIosConfig`, `getIos/getPc`, `peerOf`, `cableAt`, `cloneWorld`, `nextId`.
- `src/engine/ip.ts` — address math, `parseIfName`, `shortIfName`, `parsePort`, `portName`, `PORT_NAMES`.
- `src/engine/cli/framework.ts` — pattern DSL, `registerCommands`, `registerPending`, `registerSessionHook`, `startSession`, `execLine`,
  `inspectLine`, `helpFor`, `completeLine`, `interrupt`, `currentInterfaces`, `filterOutput`. Example usage: `tests/cli/framework.test.ts`.
- `src/engine/config/render.ts`, `apply.ts` — signatures fixed (stubs until implemented).
- `src/engine/labapi.ts` — `LabApi`, `LabState` and all view types for the UI.
- `src/ui/theme.css`, `src/ui/features.ts`, `src/ui/labContext.tsx` — design tokens, feature/cable metadata, React hooks.

### 4.1 CLI command modules (`src/engine/cli/commands/<name>.ts`)
Each module exports `commands: CommandDef[]` and `install()` (registers commands, pending handlers, session hooks).
`src/engine/cli/index.ts` already imports every module; call `installCli()` once before using the CLI.
Conventions:
- A handler mutates `env.device.config` (structured `IosConfig`) or `env.device.runtime`. Never store text blobs except in `extraLines`.
- Validate like IOS and reject with the real IOS message via `env.reject('% …')`.
- `feature` on each command drives guided-mode gating and the journal: choose the topic the command belongs to
  (`ip nat inside` → 'nat', `ip access-group` → 'acl', `crypto map X` on an interface → 'ipsec', `service-policy` → 'qos',
  `ip helper-address` → 'dhcp', `ip address`/`shutdown`/`bandwidth`/`clock rate` → 'interface', show/ping → 'verify').
- `mutates` defaults to true in configuration modes and false in EXEC. Set `mutates: false` on pure navigation
  (`interface X`, `line vty 0 4`, `router rip` …) so guided mode never blocks moving around.
- Sub-mode context lives in `session.ctx` (config-if: `{ ifNames: string[], range?: boolean }`; define and document keys for your modes).
- Write `no` forms as explicit patterns. Provide `help` texts for keywords so `?` is useful.
- Valid IOS commands that the simulator does not model should be accepted, stored in `extraLines`, and flagged with
  `env.note('Accepted, but not simulated: …')` rather than rejected.

### 4.2 Simulation API (`src/engine/sim/index.ts` must export exactly these; extra exports are fine)
```ts
linkInfo(world, ref: PortRef): { cabled: boolean; cable?: Cable; peer?: PortRef; usable: boolean; dce?: boolean; problem?: string }
interfaceState(world, deviceId, ifName): { status: 'up' | 'down' | 'administratively down'; protocol: 'up' | 'down'; problem?: string }
routingTable(world, deviceId): RouteEntry[]            // connected, local, static, RIP/OSPF (simplified), sorted like `show ip route`
lookupRoute(world, deviceId, dst): RouteEntry | null   // longest prefix match
ownAddresses(world, deviceId): { address: string; mask: string; iface: string; up: boolean }[]
sendFlow(world, spec: FlowSpec): FlowResult            // request + reply through the network; mutates runtime (counters, NAT, SAs)
probeFlow(world, spec: FlowSpec): FlowResult           // same on a clone of the world; never mutates
traceroute(world, fromDeviceId, dst, opts?): { hops: { ttl: number; address?: string; symbol: string }[]; reached: boolean }
dhcpAcquire(world, pcId): { ok: boolean; address?: string; mask?: string; gateway?: string; server?: string; reasonText?: string; steps: TraceStep[] }
dhcpRelease(world, pcId): void
snmpRequest(world, fromDeviceId, req: { host: string; community: string; op: 'get' | 'set'; oid: string; value?: string }): { ok: boolean; text: string; flow: FlowResult }
emitSyslog(world, deviceId, severity: number, mnemonic: string, text: string): void   // buffer + send to logging hosts
aclEvaluate(acl: Acl | undefined, packet: Packet): { permit: boolean; ace?: Ace; implicit: boolean }
```

## 5. Bench and physical rules
- Devices: `isr4331` (Gi0/0/0–2, Serial0/1/0–1 when the serial NIM is installed, Console), `c9300l` (Gi1/0/1–24, Console),
  PCs (Ethernet0, COM1 serial/USB-serial).
- One cable per port. A serial cable only fits serial ports. RJ-45 plugs fit any RJ-45 socket (Ethernet and Console), so wrong
  combinations are physically possible but give no link: an Ethernet cable in a CON port, or a console cable in an Ethernet port.
- Console access: a `console` cable between a PC's COM1 and a device's Console port. Without it no terminal can be opened on that device.
- Ethernet cable type, `settings.strictCables === true`: PC and router ports are MDI, switch ports are MDI-X.
  Unlike ends (PC/router ↔ switch) need **straight**; like ends (router ↔ router, PC ↔ router, PC ↔ PC, switch ↔ switch) need **crossover**.
  The wrong type keeps the link down. With `strictCables === false` (auto-MDIX) either type works.
- Serial: one end is DCE (`cable.dceEnd`). `clock rate` is accepted only on the DCE end (`%Error: This command applies only to DCE interfaces`).
  A DCE end without an explicit clock rate uses the platform default 2000000 bit/s (link still comes up). Both ends need the same encapsulation.
- Interface status: `administratively down/down` when shut down; `down/down` when no usable cable or the far end is shut/unpowered;
  `up/up` otherwise (serial `up/down` on encapsulation mismatch). Loopbacks are up unless shut down. Router physical ports start shut down.
- Switches forward between ports in the same VLAN (all ports VLAN 1 by default, no configuration needed). No spanning-tree simulation.

## 6. Simulation decisions
### 6.1 Order of operations on a router (classic IOS order — keep exactly)
For every packet a router receives or originates: inbound ACL on the ingress interface (the packet as it arrives: an ESP packet is
checked as ESP, and its decrypted inner packet is not checked against the inbound ACL again) → IPsec decryption if the packet is ESP
addressed to this router → NAT outside→inside (when the ingress interface is `ip nat outside`) → local delivery if the destination is one
of this router's addresses → routing → NAT inside→outside (ingress interface `ip nat inside`, or router-originated, and egress interface
`ip nat outside`) → crypto map on the egress interface (match → encrypt; tunnel mode adds a new header: egress interface address → peer) →
outbound ACL → QoS classification → transmit.
A clear-text packet that arrives on an interface with a crypto map and matches the mirror of a permit entry of that map's ACL is dropped
(it should have been encrypted; real IOS logs %CRYPTO-4-RECVD_PKT_NOT_IPSEC).

### 6.2 ACL
First match wins, implicit `deny ip any any` at the end, an ACL name that is referenced but not defined permits everything.
An ACL-dropped transit packet makes the router answer ICMP administratively-prohibited (ping shows `U`) unless `no ip unreachables`.
Standard ACLs match the source only. `established` matches non-SYN TCP. Per-ACE hit counters in `runtime.aclHits`.

### 6.3 NAT
Static entries win over dynamic rules. Dynamic: `ip nat inside source list <acl> {pool <p> | interface <if>} [overload]`.
Overload = PAT (ICMP identifier counts as the port). Translations are recorded in `runtime.natTranslations` and reused for the reply.
Static NAT works in both directions (a session started from outside to the global address is translated to the local host).
On ISR, the static global may be an address on the router’s own loopback (the course solution does this); qualifying router-originated traffic can be translated as well.
Transit NAT uses the `ip nat inside` / `ip nat outside` interface roles. The Catalyst 9300L allowlist in `natProfile.ts` is a
separate Network Advantage profile: addressed routed front-panel ports, explicit interface overload, permit-only selector ACLs,
and no rotary or SVI attachment. See [Catalyst NAT](final-catalyst.md) for model limits.

### 6.4 IPsec (IKEv1 crypto maps)
A packet leaving an interface whose crypto map entry's ACL permits it needs an SA to the entry's peer. Negotiation succeeds when:
both routers can exchange IKE (UDP 500) and ESP between the two endpoint addresses; ISAKMP is enabled; a common ISAKMP policy exists
(encryption, hash, authentication, DH group equal); matching pre-shared keys configured for each other's address (0.0.0.0 = any);
the peer has a crypto map on the receiving interface with an entry whose `set peer` is the initiator's address, a common transform-set
(same transforms and mode), and an ACL containing the **mirror** of the initiator's matching entry (the initiator's selectors must be
covered by a mirrored permit entry). On failure the packet is dropped (`ipsec-negotiation-failed`) and the reason is explained in the trace.
SAs are stored on both routers (`runtime.ikeSas`, `runtime.ipsecSas`) with encaps/decaps counters. `Delivery.negotiated` marks the packet that created an SA.
Traffic not matched by the crypto ACL is forwarded in clear. IKE and ESP packets themselves are never re-matched against the crypto ACL.

### 6.5 QoS (MQC)
`service-policy output` on an interface classifies each transmitted packet: first matching class in policy order, else `class-default`.
A parent class with `shape average` and a nested `service-policy` is classified again in the child policy. Record both in `Delivery.qos`
and count in `runtime.qosCounters`. `settings.qosClassifiesInnerHeader` (default true) decides whether an IPsec-protected packet is
classified by its original header or as ESP; `qos pre-classify` on the crypto map entry always forces the original header.
`percent` values derive from the interface `bandwidth` (default: serial 1544 kbit/s, GigabitEthernet 1000000 kbit/s).
Legacy queueing (`priority-list`, `queue-list`, `priority-group`, `custom-queue-list`, interface `fair-queue`) does not exist on IOS XE:
reject as invalid input and add a note pointing to class-map/policy-map.

### 6.6 DHCP
Server: pools selected by the subnet of the receiving interface, or by `giaddr` for relayed requests; excluded ranges honoured; lowest free
address first; before offering, the server pings the candidate and skips it if something answers; bindings in `runtime.dhcpBindings`
(same client gets the same address again). Relay: `ip helper-address` on the interface that hears the broadcast forwards it as unicast UDP 67
from that interface's address (giaddr) through the normal packet path; the server's reply must be routable back to giaddr.
The PC then holds address, mask and default gateway (`default-router`).

### 6.7 Management
Telnet to a router (TCP 23): accepted when a vty line exists, its `transport input` permits telnet (undefined = permit) and its
`access-class … in` permits the source address **as the router sees it** (after NAT); otherwise the connection is refused.
The password/login dialogue is done by the CLI session hooks (`login` without a password → "Password required, but none set").
SNMP (UDP 161): the request is answered only if the community exists, its ACL (if any) permits the source, and `set` uses an RW community;
otherwise silence (timeout). Syslog: messages go to every `logging` host from the `logging source-interface` address (default: egress interface)
as UDP 514 through the normal packet path; a PC with the syslog service on records them with the source address.

### 6.8 Platform look and feel
ISR 4331 with IOS XE 17.3 naming (`GigabitEthernet0/0/0`, `Serial0/1/0`), Catalyst 9300L (`GigabitEthernet1/0/1`).
A factory-fresh device starts with the initial configuration dialog on the console. `ip domain-lookup` is on by default, so a typo in
EXEC mode triggers the familiar DNS wait (the framework already does this).

### 6.9 Hardware notes
Known places where the lab's real routers may behave differently from the course's reference solution are collected in
`docs/HARDWARE_NOTES.md` (researched separately) and shown to the student in reports as advice, never as lost points.

## 7. Testing and reporting
- Every module ships tests that pass: `node --test "tests/<area>/**/*.test.ts"`. Keep tests fast and deterministic.
- Finish with: typecheck of your files clean, your tests green. Do not leave skipped tests without listing them in your report.
- Final report (short): files created, public functions/commands delivered, test count and result (paste the summary line),
  known gaps or deviations from this document, and any contract gaps.
