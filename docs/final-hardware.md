---
schema: netlab.final-audit.v1
scope: hardware
models: [ISR4331, NIM-2T, C9300L-24T-4G]
scenario: case-study-2026
simulated_ios_xe: { isr4331: '17.03.04a', c9300l: '17.03.04' }
verification: simulator-and-vendor-docs-only
physical_equipment_tested: false
browser_interaction_tested: false
findings:
  - { id: ISR4331-GE-MEDIA, status: fixed, evidence: [C1, C2, C3] }
  - { id: C9300L-FIXED-UPLINKS, status: fixed, evidence: [C4, C5] }
  - { id: NIM-2T-BAY-AND-ROLES, status: fixed, evidence: [C1, C2, C6, C7, C8] }
  - { id: CONTROLLER-STATE-AND-CLOCK, status: fixed-with-bounded-model, evidence: [C7, C8, C9] }
  - { id: LEGACY-SAVE-INVENTORY, status: fixed, evidence: [C1, C2, C4, C5] }
  - { id: STRICT-CABLE-CLASSROOM-RULE, status: retained-simulator-policy, evidence: [C5] }
files:
  engine:
    - src/engine/types.ts
    - src/engine/world.ts
    - src/engine/sim/physical.ts
    - src/engine/cli/commands/interface.ts
    - src/engine/cli/show/interfaces.ts
    - src/engine/cli/show/system.ts
    - src/engine/lab/persist.ts
  bench:
    - src/ui/bench/geometry.ts
    - src/ui/bench/DeviceFace.tsx
    - src/ui/bench/BenchCanvas.tsx
    - src/ui/bench/Inspector.tsx
    - src/ui/bench/Workbench.tsx
    - src/ui/bench/util.ts
    - src/ui/bench/bench.css
  tests:
    - tests/lab/hardware-fidelity.test.ts
    - tests/sim/physical.test.ts
    - tests/cli/base-interface.test.ts
  report: docs/final-hardware.md
checks:
  - { id: targeted-and-case-e2e, status: pass, tests: 63, failed: 0 }
  - { id: targeted-final-recheck, status: pass, tests: 35, failed: 0 }
  - { id: hardware-after-bench-role-labels, status: pass, tests: 4, failed: 0 }
  - { id: full-shared-suite, status: pass, tests: 857, failed: 0 }
  - { id: typecheck, status: pass }
  - { id: temporary-production-bundle, status: pass }
retained_limits: [no-sfp-transceivers, no-physical-retest, no-exact-nim-controller-transcript, nominal-dce-fallback, classroom-128000, simplified-phy-and-leds, strict-cabling-is-course-policy]
---

# Final hardware audit — ISR4331 / C9300L-24T-4G

## Before and after

| ID | Before audit | Fix and student-visible effect |
| --- | --- | --- |
| `ISR4331-GE-MEDIA` | All three logical data GEs were drawn and accepted as copper. The CLI stored `media-type sfp` but the copper link still worked. | The I/O bank follows **GE 0/0/0** across the top row (RJ-45 left, SFP right, one IOS interface); **GE 0/0/1** (RJ-45) and **GE 0/0/2** (SFP) are separate lower connectors. An empty SFP cage rejects every cable in the lab tray. Forcing `media-type sfp` on the combo drops the copper link at both ends without unplugging it; `media-type rj45`, `auto-select`, or `no media-type` lets copper work again in the optics-free bench. Fixed-media ports cannot be converted via this command. |
| `C9300L-FIXED-UPLINKS` | Only 24 copper downlinks appeared; the switch's fixed SFP bank was absent from bench and CLI (`show version` separately assumed four hidden uplinks). | Two copper banks of 12, odd ports above even, `Gi1/0/1–24`; a separate right-hand **1G SFP** bank `Gi1/1/1–4`, not `Te1/1/x`, not a removable network module. CLI reports the empty SFP media and counts 28 GE interfaces once. The console in the combined bench view is labeled as the rear RJ-45 console. |
| `NIM-2T-BAY-AND-ROLES` | The installed serial ports were numbered correctly (0/1/0–1), but the generic serial bay did not distinguish NIM slots. A legacy serial cable without `dceEnd` was DCE at A in the simulator, but not in the `clock rate` command. | The optional NIM-2T is in **NIM Slot 1 (0/1)**, immediately right of the GE bank; **NIM Slot 2 (0/2)** is shown empty, with no clickable ports. The back-to-back Smart Serial lead identifies one DCE and one DTE from its orientation. CLI, status and controller diagnostics use the same fallback for old saves (A). Invalid serial endpoints cannot furnish a clock. |
| `CONTROLLER-STATE-AND-CLOCK` | The controller showed clocks detected with the DTE administratively shut down; an HDLC/PPP mismatch was shown as controller Down even though the physical interface was Up. It claimed a hardware default and printed made-up driver addresses. Clock-rate handling used a generic port-adapter list (e.g. 256000 and 512000 rounded away). | Controllers distinguish no cable, DCE rate, DTE detected/stopped, physical/admin state, and line protocol. Enabled endpoints can have clock with `up/down` on HDLC/PPP mismatch. A shutdown or unplug stops detection in the simulator, and `no clock rate` clears the configured value. Use Cisco's documented NIM rate list and bounds for supported rates, with a nearest-documented-rate simulation for other inputs and a visibly caveated exact 128000 for the assignment. The nominal unconfigured 2 Mb/s fallback is explicitly labeled **NetLab**, not a Cisco default. |
| `LEGACY-SAVE-INVENTORY` | Version-1 saves contained the old port records and lacked the switch uplink interface configuration. Reopening them verbatim would bypass corrected inventory. | Both Open/Import and Continue reconcile v1 port inventory, preserve NIM presence and existing configs, and supply defaults only for missing interfaces. Existing endpoints, journal, startup-config and report are not rewritten. An impossible old copper-to-SFP cable is retained as a removable **incompatible saved cable**; it never links and the user can unplug it and choose a real RJ-45 port. No automatic rewiring. |
| `STRICT-CABLE-CLASSROOM-RULE` | Strict MDI/MDI-X matching could be mistaken for the behavior of the specified switch. | Deliberately retain the exercise's explicit **Strict cable rules** setting and wrong-cable faults. Cisco documents Auto-MDIX enabled by default on supported Catalyst copper ports; NetLab's relaxed setting is an approximation (either lab Ethernet lead), not per-port Auto-MDIX emulation. Neither setting makes copper fit a bare SFP cage. |

## Cisco sources and confidence

- **C1.** [Hardware Installation Guide for Cisco 4000 Series Integrated Services Routers — Overview, Figs. 1-22 and 1-23 and “Slots, Subslots (Bay), Ports, and Interfaces”](https://www.cisco.com/c/en/us/td/docs/routers/access/4400/hardware/installation/guide4400-4300/C4400_isr/Overview.html#89395), Cisco chapter header dated September 10, 2014. Figure 1-23's detail is the bank-label reference (including the shared upper GE 0/0/0 label); Figure 1-22 shows the bezel-side serial console. Prefer the model-specific figure and C2 over the family-level SFP LED table's potentially confusing port references.
- **C2.** [Same installation guide — Install and Upgrade Internal Modules and FRUs, Fig. 5-6 and footnote 1](https://www.cisco.com/c/en/us/td/docs/routers/access/4400/hardware/installation/guide4400-4300/C4400_isr/FRUs_Modules.html#66846): explicitly identifies combo, copper-only and SFP-only Ethernet and places NIM Slot 1 at left of NIM Slot 2. [Cisco 4000 Family ISR Data Sheet, Table 5](https://www.cisco.com/c/en/us/products/collateral/routers/4000-series-integrated-services-routers-isr/data_sheet-c78-732542.html) independently lists three onboard GE interfaces, two RJ-45 connectors, two SFP cages and two NIM slots for 4331/4331-DC.
- **C3.** [Cisco 4000 Series ISRs Software Configuration Guide, IOS XE 17 — SFP Auto-Detect and Auto-Failover, “Enabling Auto-Detect”](https://www.cisco.com/c/en/us/td/docs/routers/access/isr4400/software/configuration/xe-17/isr4400-sw-config-xe-17/sfp_auto_detect_and_auto_failover.html): selection of RJ-45 vs SFP on dual-media ports, and automatic selection after `no media-type`.
- **C4.** [Cisco Catalyst 9300 Series Switches Hardware Installation Guide — Product Overview, Table 2, “Front panel components of a Cisco Catalyst 9300L Series Switch,” and “Rear Panel”](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/hardware/install/b_c9300_hig/Product-overview.html), updated May 15, 2026. Table 2 is exact for the **24T-4G**: 24 copper downlinks and four fixed 1 GE SFP uplinks. Figures 4 and 11 establish 9300L family bank/rear-console placement; Figure 4 illustrates the 48P-4X, not a photo of the exact 24T-4G. The bench uses equivalent bank grouping and readable labels, not a cosmetic replica.
- **C5.** [Interface and Hardware Components Configuration Guide, IOS XE Amsterdam 17.3.x (Catalyst 9300), “Interface Configuration Mode,” “Default Ethernet Interface Configuration,” and “Configuring Auto-MDIX”](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/software/release/17-3/configuration_guide/int_hw/b_173_int_and_hw_9300_cg.pdf), first published July 31, 2020: independent interface bank numbers 0/1, standalone member 1, 1G SFP interface examples, and enabled-by-default Auto-MDIX for supported ports. Auto-MDIX on the onboard ISR 4331 ports was not independently verified.
- **C6.** [Cisco 4000 Series ISR Interfaces and Modules — Serial WAN Interfaces, NIM-2T row](https://www.cisco.com/c/en/us/products/routers/4000-series-integrated-services-routers-isr/relevant-interfaces-and-modules.html): Cisco's actual table uses a merged 4351/4331/4321 cell; it lists `3.13 / 17.5 / 18.3` as the minimum IOS XE / IOS XE SD-WAN / vManage versions. The lab models autonomous IOS XE, not SD-WAN. [Serial NIM data sheet, “Connectors and Cabling,” Tables 3 and 4, “Physical specifications”](https://www.cisco.com/c/en/us/products/collateral/routers/4000-series-integrated-services-routers-isr/datasheet-c78-732155.html) specifies Smart Serial, V.35 DCE/DTE cable variations, 8 Mb/s maximum and a single-width module with no slot restrictions. Bay 1 is the worked bench's choice, not where Cisco requires every NIM-2T to be installed.
- **C7.** [Configuring the Cisco 1-, 2-, and 4-Port Serial High-Speed WAN Interface Cards on the Cisco 4400 Series ISR, OL-31531-01 (Cisco Japanese edition)](https://www.cisco.com/c/dam/global/ja_jp/td/docs/ciam/high-speedwaninterfacecards/high-speedwaninterfacecar/cg/002/snim-config.pdf), June 30, 2014: “Timing Signals” and required feature configuration, steps 2, 4 and 5. This older 4400-series document describes the same synchronous NIM family: slot/subslot/port, DTE external timing, DCE clock config, HDLC default, and rates from 1200 to 8000000 b/s. The list includes 125000, 256000 and 512000; **128000 is not on it**. This is not proof that every ISR4331 17.3 image rejects (or rounds) 128000. Actual `clock rate ?` offers and nearest-rate behavior on this 4331/NIM/image were not captured.
- **C8.** [Cisco IOS Interface and Hardware Component Command Reference — `clock rate` and `clock rate (interface serial)`](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/interface/command/ir-cr-book/ir-c2.html): `no clock rate` on DCE restores a hardware-dependent default, and it can remove stale DCE configuration after a change to DTE. The guide's nonstandard-clock rounding example is for other adapters; do not use it to infer the NIM-2T's exact behavior or default value.
- **C9.** [Cisco IOS Interface and Hardware Component Command Reference — `show controllers serial`](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/interface/command/ir-cr-book/ir-s3.html) documents a privileged controller diagnostic and expressly says fields vary by card/config/status; the examples are not an ISR4331 NIM-2T IOS XE 17.3.4a transcript. [ISR 4000 IOS XE 17.3.x release notes](https://www.cisco.com/c/en/us/td/docs/routers/access/4400/release/xe-17-3/isr4k-rel-notes-xe-17-3.html) cover the release series and identify the 4331, but do not establish the exact controller text or clock default. NetLab keeps its existing command entry/aliases and shows a short pedagogical diagnostic instead of claiming firmware-exact output.

## Verification and intentional test changes

- Ran the actual `case-study-2026` through the `Lab` API, not the workbench stub. The existing free and guided end-to-end cases still grade **100%**. The new `tests/lab/hardware-fidelity.test.ts` exercises positive RJ-45 cabling, SFP rejections (straight/crossover/rollover/serial and relaxed mode), geometry/highlighting contracts, combo media changes, switch bank CLI and `show version`, a reversed DCE cable, shutdown on each side, PPP/HDLC mismatch/recovery, unplug, and legacy JSON import/autosave continuation.
- `tests/sim/physical.test.ts`: the old “available RJ-45” fixture incorrectly used `Gi0/0/2`. The one-port/wrong-polarity checks now use real copper `Gi0/0/1`; the new test expressly refuses `Gi0/0/2` rather than dropping coverage. The serial status tests distinguish active clocking from the nominal rate and from encapsulation state.
- `tests/cli/base-interface.test.ts`: the old rounded rate for the nonstandard input `130000` used the generic table's 128000. The expected approximation is now the nearest *documented NIM rate* (125000); exact 128000 remains a separate worked-lab exception. Added checks for representative documented rates and both bounds.
- **63/63** in the hardware, bench, persistence, CLI, and both real case-study E2E checks: `node --test tests/lab/hardware-fidelity.test.ts tests/sim/physical.test.ts tests/cli/base-interface.test.ts tests/cli/show-reference.test.ts tests/cli/show-fresh.test.ts tests/lab/bench.test.ts tests/lab/persistence.test.ts tests/lab/case-study.e2e.test.ts tests/lab/case-study.guided.e2e.test.ts`. **35/35** recheck of hardware-fidelity, physical, base-interface and show-reference tests (including the new switch count assertion). **857/857** with `npm test` in the shared workspace. After the final UI-only DCE/DTE label consistency change, the four hardware regressions, `npm run typecheck`, and the temporary production Vite bundle passed again. No package install, publishing, repo config changes, or Git actions.

## Residual limits

- No optical transceivers (including copper SFPs), optical leads, SFP auto-failover, USB console, management Ethernet, AUX, switching stack or arbitrary/hot-swappable module options are simulated here. The bench combines relevant sides of the chassis rather than flipping or replicating it. A cosmetic `SFP` socket and a CLI interface are not a working optical link.
- The default real ISR4331/NIM-2T DCE frequency, exact 128000 acceptance, cable/clock line wording and modem-control signal timings would require a real unit with its specific IOS XE release and NIM revision. The existing 2 Mb/s nominal DCE fallback and exact 128 kb/s course setting are simulation decisions. Nominal rate, configured `bandwidth` (a separate administrative field), and presence of clocks are distinct. DTE clock detection is gated on both ends being enabled; LEDs and timed signal/keepalive behavior are simplified. Copper speed negotiation, forced duplex mismatch and electrical signaling are not bench accuracy claims.
- Direct CLI `clock rate` requires a usable lead's DCE end; an unplugged port can still have a rate staged by importing a configuration file, and the setting never supplies clock when the lead assigns that port DTE. The generic command entry/privilege and help are not an exact IOS XE command grammar.
- The existing `cable-port-r1` fault has an unused Ethernet-WAN branch referencing `Gi0/0/2`; the currently registered broken networks use the serial case and a valid spare `Gi0/0/1`. If a future scenario uses that Ethernet-WAN branch, design a wrong-port fault around a real free copper jack, not a bare SFP cage.
- These are source and simulator checks only. No lab equipment or browser pointer walkthrough was used. A local bundle was produced only in `/tmp` for compilation verification.
