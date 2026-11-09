import { describe, expect, test } from 'vitest';
import { classifyOutcome } from '../map/learning.js';
import { classifyFlag } from '../activity/extract.js';
import { ERROR_CATEGORIES, categorise } from './categories.js';

/*
 * One fixture table for both consumers of the error-category rules: the
 * map learner (`classifyOutcome` over a thrown error) and the activity
 * flags (`classifyFlag` over a thrown error). Every row pins what each
 * consumer returned BEFORE the two regex tables were merged; `null` means
 * the consumer did not categorise that message. Rows where the two columns
 * differ are the known disagreements, kept through named per-consumer
 * overrides in `categories.ts`.
 */
interface Fixture {
  message: string;
  mapLearner: string | null;
  activity: string | null;
}

const FIXTURES: readonly Fixture[] = [
  // Messages the transports actually emit (taken from both consumers' tests).
  {
    message:
      'Click would land on div.wrap, not on #save: scroll or expand its container, or target the element that receives clicks; force: true clicks there anyway',
    mapLearner: 'retargeted',
    activity: 'retargeted',
  },
  {
    message: 'retargeted: click would land on an ancestor',
    mapLearner: 'retargeted',
    activity: 'retargeted',
  },
  {
    message: 'ref-stale: abc:e1 not found in document abc',
    mapLearner: 'ref-stale',
    activity: 'ref-stale',
  },
  {
    message: 'ref-stale: e12 not found in document d3',
    mapLearner: 'ref-stale',
    activity: 'ref-stale',
  },
  {
    message: 'expectation not met: url_changed',
    mapLearner: 'expect-failed',
    activity: 'expect-failed',
  },
  {
    message: 'expectation not met: url_changed after 3000ms',
    mapLearner: 'expect-failed',
    activity: 'expect-failed',
  },
  { message: "Tool 'click' timed out after 15000ms", mapLearner: 'timeout', activity: 'timeout' },
  {
    message: "Tool 'browser.click' timed out after 30000ms",
    mapLearner: 'timeout',
    activity: 'timeout',
  },
  { message: 'Element not found: #save', mapLearner: 'not-found', activity: 'not-found' },
  { message: 'Element not found: #missing', mapLearner: 'not-found', activity: 'not-found' },
  // Nothing matches.
  { message: 'tab_id required', mapLearner: null, activity: null },
  { message: 'Tab t1 is not connected', mapLearner: null, activity: null },
  // Disagreements between the two former tables (same message shape,
  // different verdict), derived from their regexes.
  // 1. Precedence: the learner tested `retargeted` before `ref-stale`, the
  //    activity table `ref-stale` first.
  {
    message: 'ref-stale: e1 retargeted to a sibling',
    mapLearner: 'retargeted',
    activity: 'ref-stale',
  },
  // 2. The learner anchored "Click would land on " at the start; the
  //    activity table accepts it anywhere.
  {
    message: 'Error: Click would land on div.wrap, not on #save',
    mapLearner: null,
    activity: 'retargeted',
  },
  // 3. The learner required "timed out after" at the start; the activity
  //    table accepts "timed out" anywhere.
  {
    message: "Error: Tool 'browser.click' timed out after 30000ms",
    mapLearner: null,
    activity: 'timeout',
  },
  { message: "Tool 'browser.click' timed out", mapLearner: null, activity: 'timeout' },
  // 4. The learner's tool name could contain a quote (`.*`), the activity
  //    table's could not (`[^']*`).
  { message: "Tool 'it's' timed out after 1ms", mapLearner: 'timeout', activity: null },
  // 5. The learner did not require word boundaries around
  //    "expectation not met"; the activity table did.
  { message: 'unexpectation not met', mapLearner: 'expect-failed', activity: null },
];

describe('error categories — both consumers keep their previous mapping', () => {
  const args = { tab_id: 't1', selector: '#save' };

  test.each(FIXTURES)('map learner: $message → $mapLearner', ({ message, mapLearner }) => {
    const outcome = classifyOutcome('browser.click', args, undefined, new Error(message));
    expect(outcome).toEqual(mapLearner === null ? null : { ok: false, reason: mapLearner });
  });

  test.each(FIXTURES)('activity flags: $message → $activity', ({ message, activity }) => {
    expect(classifyFlag('browser.click', {}, undefined, new Error(message))).toBe(activity);
  });
});

describe('categorise — the one shared table', () => {
  test.each(FIXTURES)('default (activity) rules: $message → $activity', ({ message, activity }) => {
    expect(categorise(message)).toBe(activity);
  });

  test.each(FIXTURES)(
    'map-learner overrides: $message → $mapLearner',
    ({ message, mapLearner }) => {
      expect(categorise(message, 'map-learner')).toBe(mapLearner);
    },
  );

  test('the table is the union of both former tables: one rule per category', () => {
    expect(ERROR_CATEGORIES.map((rule) => rule.category).sort()).toEqual([
      'expect-failed',
      'not-found',
      'ref-stale',
      'retargeted',
      'timeout',
    ]);
  });

  test('every override names its consumer and says why', () => {
    for (const rule of ERROR_CATEGORIES) {
      for (const override of rule.overrides ?? []) {
        expect(override.consumer).toBe('map-learner');
        expect(override.reason.length).toBeGreaterThan(20);
      }
    }
  });
});
