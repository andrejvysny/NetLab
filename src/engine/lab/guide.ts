/**
 * Guided mode: step status, the "is this allowed right now?" rule and the plain-words explanation of a refusal.
 *
 * Guided mode walks through the steps in order and never goes back. `reached` is the number of steps finished so far: a
 * step counts as finished when the scenario says it is satisfied WHILE it is the step being worked on. From then on it
 * stays finished — work on a later step often breaks the check of an earlier one for a while (IPsec configured on one
 * router only stops the pings that proved the routing step), and the guide must not send the student back for that.
 *
 * Rule (guided mode only): the guide stops the student from jumping AHEAD. A state-changing action is allowed when the
 * active step (step number reached + 1) or any step before it lists its feature in `allows` AND works on its device.
 * Work of finished steps stays possible on purpose: a step's check often turns green before the last line of its example
 * is typed, and earlier work must stay repairable. Features 'verify' and 'console' are always allowed. When every step
 * is finished nothing is blocked.
 *
 * Free mode has no order: every step shows what the scenario says about it right now.
 */
import type { GuideBlock } from '../labapi.ts';
import type { Feature, GuideStep, LabMode } from '../types.ts';

export type StepStatus = 'done' | 'active' | 'locked';

/** Guided mode: move on past every step that is satisfied now, starting from the step that was active. Never goes back. */
export function advance(guide: GuideStep[], progress: Record<string, boolean>, reached: number): number {
  let n = Math.max(0, Math.min(guide.length, Math.floor(reached) || 0));
  while (n < guide.length && progress[guide[n].id] === true) n++;
  return n;
}

/**
 * Guided: the first `reached` steps are done, the next one is active, everything after it is locked.
 * Free: a satisfied step shows as done wherever it is; the first unsatisfied one is active, the other unsatisfied ones locked.
 */
export function stepStatuses(guide: GuideStep[], progress: Record<string, boolean>, mode: LabMode, reached: number): StepStatus[] {
  if (mode === 'guided') return guide.map((_, i) => (i < reached ? 'done' : i === reached ? 'active' : 'locked'));
  const first = guide.findIndex((g) => progress[g.id] !== true);
  return guide.map((g, i) => (progress[g.id] === true ? 'done' : i === first ? 'active' : 'locked'));
}

/** Topic names in plain words, used as the subject of a sentence ("NAT is step 9."). */
export const FEATURE_WORDS: Record<Feature, string> = {
  cabling: 'Cabling',
  console: 'The console cable',
  system: 'Basic device settings',
  interface: 'Interface settings',
  routing: 'Routing',
  dhcp: 'DHCP',
  acl: 'Access lists (ACL)',
  nat: 'NAT',
  ipsec: 'IPsec',
  qos: 'QoS',
  vty: 'Telnet access (vty lines)',
  snmp: 'SNMP',
  syslog: 'Syslog',
  switching: 'Switch settings',
  pc: 'PC settings',
  verify: 'Checking',
};
/** Topics whose name is a plural ("Interface settings are step 4."). */
const PLURAL: Feature[] = ['system', 'interface', 'acl', 'switching', 'pc'];
function verb(feature: Feature, past: boolean): string {
  const many = PLURAL.includes(feature);
  return past ? (many ? 'were' : 'was') : (many ? 'are' : 'is');
}

function stepCovers(step: GuideStep, feature: Feature, deviceIds: string[]): boolean {
  if (!step.allows.includes(feature)) return false;
  return step.devices.length === 0 || deviceIds.some((d) => step.devices.includes(d));
}

export type GateResult =
  | { allowed: true; active?: GuideStep }
  | { allowed: false; active: GuideStep; owner?: GuideStep; wrongDevice: boolean };

/**
 * May an action of this feature on these devices run now (guided mode)? `reached` = number of finished steps.
 * `deviceIds`: the device a command is typed on; for a cable both ends (one end inside the step is enough).
 * A refusal names the later step the action belongs to, when there is one.
 */
export function gate(guide: GuideStep[], reached: number, feature: Feature, deviceIds: string[]): GateResult {
  const active = guide[reached];
  if (feature === 'verify' || feature === 'console') return { allowed: true, active };
  if (!active) return { allowed: true };
  if (guide.slice(0, reached + 1).some((g) => stepCovers(g, feature, deviceIds))) return { allowed: true, active };
  const owner = guide.slice(reached + 1).find((g) => stepCovers(g, feature, deviceIds));
  return { allowed: false, active, owner, wrongDevice: active.allows.includes(feature) };
}

export interface BlockTexts {
  /** What was tried, as a full sentence: 'You typed "ip nat inside".' */
  what: string;
  feature: Feature;
  /** Label of the device the action was aimed at, e.g. 'R2'. */
  deviceLabel: string;
  /** Labels of the devices the active step works on. */
  stepDeviceLabels: string[];
  /** Closing sentence: 'Nothing was changed.' */
  nothing: string;
}

function listWords(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** The message for the user. The block names the step to work on now (the active step). */
export function blockFor(result: Extract<GateResult, { allowed: false }>, t: BlockTexts): GuideBlock {
  const { active, owner, wrongDevice } = result;
  const topic = FEATURE_WORDS[t.feature] ?? 'This';
  const parts: string[] = [t.what];
  if (wrongDevice) {
    const where = t.stepDeviceLabels.length ? listWords(t.stepDeviceLabels) : 'another device';
    parts.push(`Step ${active.no} is about ${where}, not ${t.deviceLabel}.`);
    if (owner) parts.push(`${topic} on ${t.deviceLabel} ${verb(t.feature, owner.no < active.no)} step ${owner.no}.`);
    parts.push(`You are on step ${active.no}: ${active.title}.`);
    parts.push(`Do this step on ${where} first.`);
  } else {
    if (owner) {
      parts.push(`${topic} ${verb(t.feature, owner.no < active.no)} step ${owner.no}.`);
      parts.push(`You are on step ${active.no}: ${active.title}.`);
      parts.push(`Finish step ${active.no} first.`);
    } else {
      // No step of this guide uses it: there is nothing to wait for.
      parts.push(`${topic} ${verb(t.feature, false)} not part of this step, and no later step needs ${PLURAL.includes(t.feature) ? 'them' : 'it'}.`);
      parts.push(`You are on step ${active.no}: ${active.title}.`);
      parts.push(`Stay with step ${active.no}.`);
    }
  }
  parts.push(t.nothing);
  return { stepId: active.id, stepNo: active.no, stepTitle: active.title, reason: parts.join(' ') };
}
