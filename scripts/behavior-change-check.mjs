// The behavior-change label is the one way past the e2e differential, so it
// has to mean something: a labelled PR must name the expected difference in
// its description, and a refactor never carries the label (a refactor is
// what the differential exists to hold equal).
//
// The description needs a line that starts with `Expected difference:`
// followed by non-empty text (the tool, the field, old and new values).
//
// It may also carry one `Expected labels:` line: the call labels of the e2e
// record (or label prefixes, packages/e2e/src/expected-labels.mjs) the change
// is expected to make differ, comma-separated, each [A-Za-z0-9._-]+. It is
// read only on a labelled PR; a malformed or repeated line fails the check.
// With GITHUB_OUTPUT set, the validated list is written there as
// `expected_labels=<a,b>` (empty when there is none) for the differential
// step, which passes it to scripts/e2e-diff.mjs as an argument.
//
// Run by the e2e-diff job. The title and body arrive only through the
// environment (PR_TITLE, PR_BODY), never interpolated into a shell script;
// BEHAVIOR_CHANGE is `true` when the PR carries the label.
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseLabelList } from '../packages/e2e/src/expected-labels.mjs';

const EXPECTED_LINE = /^[ \t]*Expected difference:[ \t]*(\S.*)$/im;
const LABELS_LINE = /^[ \t]*Expected labels:(.*)$/gim;
/** `refactor:` and `refactor(core):`, with the breaking-change `!` allowed. */
const REFACTOR_TITLE = /^\s*refactor(\(core\))?!?:/i;

/** The `Expected labels:` line of a description: `{ entries }` (empty when
 * there is no line) or `{ error }`. */
export function expectedLabelsOf(body = '') {
  const lines = [...String(body).matchAll(LABELS_LINE)];
  if (lines.length === 0) return { entries: [] };
  if (lines.length > 1) return { error: 'more than one "Expected labels:" line' };
  const { entries, error } = parseLabelList(lines[0][1]);
  if (error) return { error };
  if (entries.length === 0) return { error: 'the "Expected labels:" line lists no label' };
  return { entries };
}

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
  const labels = expectedLabelsOf(body);
  if (labels.error) {
    problems.push(
      `the "Expected labels:" line is invalid (${labels.error}): one line, comma-separated call labels or label prefixes, each [A-Za-z0-9._-]+`,
    );
  }
  return problems;
}

/** The list the differential gets: only from a labelled, sound PR. */
export function expectedLabelsOutput({ labelled, body = '' }) {
  if (!labelled) return [];
  return expectedLabelsOf(body).entries ?? [];
}

export function main(env = process.env) {
  const pr = {
    labelled: env.BEHAVIOR_CHANGE === 'true',
    title: env.PR_TITLE ?? '',
    body: env.PR_BODY ?? '',
  };
  const problems = behaviorChangeProblems(pr);
  for (const p of problems) console.error(`behavior-change-check: ${p}`);
  if (problems.length > 0) return 1;
  const entries = expectedLabelsOutput(pr);
  if (entries.length) console.log(`behavior-change-check: expected labels: ${entries.join(', ')}`);
  // Validated entries only ([A-Za-z0-9._-] and commas): no newline can reach
  // the output file.
  if (env.GITHUB_OUTPUT)
    appendFileSync(env.GITHUB_OUTPUT, `expected_labels=${entries.join(',')}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
