// The behavior-change label is the one way past the e2e differential, so it
// has to mean something: a labelled PR must name the expected difference in
// its description, and a refactor never carries the label (a refactor is
// what the differential exists to hold equal).
//
// The description needs a line that starts with `Expected difference:`
// followed by non-empty text (the tool, the field, old and new values).
//
// Run by the e2e-diff job. The title and body arrive only through the
// environment (PR_TITLE, PR_BODY), never interpolated into a shell script;
// BEHAVIOR_CHANGE is `true` when the PR carries the label.
import { pathToFileURL } from 'node:url';

const EXPECTED_LINE = /^[ \t]*Expected difference:[ \t]*(\S.*)$/im;
/** `refactor:` and `refactor(core):`, with the breaking-change `!` allowed. */
const REFACTOR_TITLE = /^\s*refactor(\(core\))?!?:/i;

/** What is wrong with a PR, as a list of messages (empty when sound). The
 * check applies only to a PR that carries the label. */
export function behaviorChangeProblems({ labelled, title = '', body = '' }) {
  if (!labelled) return [];
  const problems = [];
  if (REFACTOR_TITLE.test(title)) {
    problems.push(
      'a refactor PR must not carry the behavior-change label: remove the label, or retitle the PR if it changes behavior',
    );
  }
  if (!EXPECTED_LINE.test(body)) {
    problems.push(
      'the PR description must name the expected difference: add a line "Expected difference: <tool, field, old value, new value>"',
    );
  }
  return problems;
}

export function main(env = process.env) {
  const problems = behaviorChangeProblems({
    labelled: env.BEHAVIOR_CHANGE === 'true',
    title: env.PR_TITLE ?? '',
    body: env.PR_BODY ?? '',
  });
  for (const p of problems) console.error(`behavior-change-check: ${p}`);
  return problems.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
