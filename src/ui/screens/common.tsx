/** Shared bits for the screens (family names, level text). Owned by the app-shell agent. */
import type { IconName } from '../icons.tsx';
import type { ScenarioFamily } from '../../engine/types.ts';

export const FAMILY_META: Record<ScenarioFamily, { title: string; text: string; icon: IconName; tone: string }> = {
  'case-study': { title: 'Case study', icon: 'doc', tone: 'ipsec', text: 'The 2026 assignment the exam is based on.' },
  variation: { title: 'Variations', icon: 'shuffle', tone: 'nat', text: 'The same kind of task with changes. You learn the idea, not the numbers.' },
  lab: { title: 'Course labs', icon: 'flask', tone: 'interface', text: 'Short labs. One topic at a time.' },
  broken: { title: 'Broken networks', icon: 'bug', tone: 'acl', text: 'Already built, but something is wrong. Find it and fix it.' },
  mock: { title: 'Mock exams', icon: 'exam', tone: 'qos', text: 'Full practice exams. Best done in Exam mode.' },
};
export const FAMILY_ORDER: ScenarioFamily[] = ['case-study', 'variation', 'lab', 'broken', 'mock'];

export function LevelText(props: { level: number }) {
  const words = ['', 'Gentle', 'Medium', 'Full exam level'];
  const lv = Math.min(3, Math.max(1, props.level || 1));
  return (
    <span className="nl-level" title={`Level ${lv} of 3`}>
      <span className="nl-level-dots" aria-hidden="true">
        {[1, 2, 3].map((i) => <span key={i} className={i <= lv ? 'on' : ''} />)}
      </span>
      Level {lv} · {words[lv]}
    </span>
  );
}

