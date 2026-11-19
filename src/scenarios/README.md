# Scenarios (`src/scenarios`)

Assignments for the lab: brief, bench, pre-built parts, behavioural grading, guide, model solution, hardware notes.
`index.ts` exports the contract (`SCENARIOS`, `getScenario`) plus helpers for the Lab controller and for tests.

## One generator
Every scenario is a `Spec` (spec.ts): addresses, rules and numbers of one assignment, the list of graded `parts`
and the list of `prebuilt` parts. `buildInstance(spec)` (build.ts) turns it into a `ScenarioInstance`.
Each part builder (parts/*.ts) returns, from the same Spec: model configuration lines, cables, PC settings,
requirements with checks, and guide steps with a replayable script. So brief, checks, guide and solution cannot disagree.

| File | What it holds |
|---|---|
| `spec.ts` | `Spec`, services, address helpers, the reference plan (`caseSpec()`), derived model addresses (`model()`) |
| `catalog.ts` | the scenario list; `variedSpec(seed, stream)` = the case study with seeded facts; broken networks; course labs |
| `build.ts` | the generator; example text of guide steps; troubleshooting guide; result cache; `stepScripts`, `faultsOf`, `specOf` |
| `env.ts` | role discovery from the cabling, addresses as configured, cached probes on private copies of the world |
| `checks.ts` | requirement / check / step types, gating (`needs`), partial credit |
| `parts/base.ts` | cabling, console, names + addresses + interface state, PC addressing, default routes + reachability, saving |
| `parts/dhcp.ts`, `nat.ts`, `acl.ts`, `ipsec.ts`, `qos.ts`, `mgmt.ts` | one topic each (case-study form and course-lab form) |
| `faults.ts` | fault catalogue for broken networks: break, ticket, "still present?" test, fix |
| `order.ts` | order observations from the journal |
| `brief.ts` | sheet texts, givens, topology picture, bench layout |
| `hardwareNotes.ts` | rows of the final table of docs/HARDWARE_NOTES.md and the choice per scenario |
| `apply.ts` | `benchWorld`, `applyInitial`, `startWorld`, `applySolution` |

## Grading rules
- Roles come from the cabling: R1's LAN port is the one wired to PC1, the WAN link is the R1–R2 link, R2's LAN port is
  the one wired to PC3. Addresses are read from what is configured. Any ports and, where the sheet leaves it open,
  any addresses pass.
- Checks probe behaviour on private copies of the world (`env.probe`, `probeWorld`). Configuration is read only where
  behaviour cannot show it: routing protocol / number of static routes, clock rate on the DCE end, interface bandwidth,
  shaper rate, type of an access list in the ACL lab, "running-config is saved".
- Packet probes start with fresh NAT/IPsec session state and an idle VTY on private copies. Live DHCP leases are retained. Only an IPsec tunnel that a probe negotiated is carried
  to later probes (the engine re-checks a tunnel against the configuration before using it), which roughly halves grading time.
- A check with `needs` is "not judged yet" until the named checks of the same requirement pass. Negative authorization checks also inspect effective first-match source policy, not just whether a disconnected client receives no reply.
- Earned practice points = weights × share of passed checks (rounded to a tenth). The complete case has 18 practice points; task 9 and saving do not change that score. See [grading scope and hardware profiles](../../docs/final-grading.md).
- `grade` and `guideProgress` never change the world they are given and ignore the logical clock. The last result is
  reused while devices, cables and settings are unchanged.

## What the Lab controller can rely on
- `initial`: apply cables first, then configuration text with `applyConfigText(…, 'merge')`, then PC setups, then one DHCP
  request per PC that is set to DHCP (bench order), and save the configured routers. `applyInitial(world, inst)` does this.
- PC setups in `initial.pcs` and `solution.pcs` are complete: a static PC always has address, mask and gateway.
- `solution` of a broken network = the fixes (configuration lines per router), the correct cabling, the correct PC setups.
- `stepScripts(inst)`: per guide step, the actions its example describes (`cable`, `uncable`, `config`, `exec`, `pc`,
  `renew`, `note`). A `pc` action inside a script may carry only `services`. `renew` is only used where a lease will succeed.
- Journal: order observations read `via`, `mode` ('priv', 'config', 'config-if', 'config-line'), `ok`, `mutated`, `blocked`,
  `feature` ('cabling' for network cables, 'console' for console cables) and the typed `line`. `guideProgress` does not read the journal.
- Seeds are non-negative integers. Seed 0 is always the reference plan of docs/COURSE.md.
