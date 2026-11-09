/**
 * The one table that turns a thrown (or `isError`) tool message into a
 * failure category. Two consumers read it:
 *   - the map learner (`map/learning.ts`), which stores the category as a
 *     selector's `last_reason`;
 *   - the activity trail (`activity/extract.ts`), which stores it as the
 *     row's `flag`.
 *
 * The patterns match the stable prefixes the transports emit: `ref-stale:`
 * (`flow.ts`), the retargeted click message (`retargetedClickMessage`),
 * `expectation not met` (`cdp/expect.ts`), the bridge's `Tool '<name>' timed
 * out` and `Element not found:`.
 *
 * Before this table each consumer kept its own regex list, and the lists
 * had drifted apart. Where they disagreed on the same message shape, each
 * consumer keeps the behaviour it had through an override on the rule,
 * named for the consumer and carrying the reason. The default patterns are
 * the activity table's; `errors/categories.test.ts` pins both consumers'
 * previous mapping fixture by fixture.
 */

export type ErrorCategory = 'ref-stale' | 'retargeted' | 'expect-failed' | 'timeout' | 'not-found';

/** A consumer whose mapping differs from the default rules. */
export type ErrorCategoryConsumer = 'map-learner';

export interface ErrorCategoryOverride {
  consumer: ErrorCategoryConsumer;
  /** Replaces the rule's pattern for this consumer. */
  pattern?: RegExp;
  /** Replaces the rule's position (its index in the table) for this
   * consumer; rules are tested in ascending rank, first match wins. */
  rank?: number;
  reason: string;
}

export interface ErrorCategoryRule {
  category: ErrorCategory;
  pattern: RegExp;
  overrides?: readonly ErrorCategoryOverride[];
}

/** Tested in this order by default; the first match wins. */
export const ERROR_CATEGORIES: readonly ErrorCategoryRule[] = [
  { category: 'ref-stale', pattern: /\bref-stale\b/ },
  {
    category: 'retargeted',
    pattern: /\bretargeted\b|\bClick would land on\b/,
    overrides: [
      {
        consumer: 'map-learner',
        pattern: /\bretargeted\b|^Click would land on /,
        rank: -1,
        reason:
          'the learner always tested retargeted before ref-stale and only ' +
          'accepted the click message at the start of the error',
      },
    ],
  },
  {
    category: 'expect-failed',
    pattern: /\bexpectation not met\b/,
    overrides: [
      {
        consumer: 'map-learner',
        pattern: /expectation not met/,
        reason: 'the learner never required word boundaries around the phrase',
      },
    ],
  },
  {
    category: 'timeout',
    pattern: /\bTool '[^']*' timed out\b/,
    overrides: [
      {
        consumer: 'map-learner',
        pattern: /^Tool '.*' timed out after/,
        reason:
          'the learner only accepted the bridge timeout at the start of the ' +
          'error and with its "after <ms>" suffix',
      },
    ],
  },
  { category: 'not-found', pattern: /^Element not found:/ },
];

interface ResolvedRule {
  category: ErrorCategory;
  pattern: RegExp;
  rank: number;
}

function rulesFor(consumer: ErrorCategoryConsumer | undefined): readonly ResolvedRule[] {
  return ERROR_CATEGORIES.map((rule, index) => {
    const override = rule.overrides?.find((o) => o.consumer === consumer);
    return {
      category: rule.category,
      pattern: override?.pattern ?? rule.pattern,
      rank: override?.rank ?? index,
    };
  }).sort((a, b) => a.rank - b.rank);
}

const DEFAULT_RULES = rulesFor(undefined);
const MAP_LEARNER_RULES = rulesFor('map-learner');

/** The category of a tool error message, or null when no rule matches.
 * Without `consumer` the default rules apply (the activity flags); a named
 * consumer gets its overrides. */
export function categorise(
  message: string,
  consumer?: ErrorCategoryConsumer,
): ErrorCategory | null {
  const rules = consumer === 'map-learner' ? MAP_LEARNER_RULES : DEFAULT_RULES;
  for (const rule of rules) if (rule.pattern.test(message)) return rule.category;
  return null;
}
