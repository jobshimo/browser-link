// The behavior-change label's guard (scripts/behavior-change-check.mjs).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { behaviorChangeProblems, main } from './behavior-change-check.mjs';

const ok = {
  labelled: true,
  title: 'feat(extension): wider click',
  body: 'Expected difference: browser.click default settle_ms 300 -> 500',
};

test('a PR without the label is not checked', () => {
  assert.deepEqual(
    behaviorChangeProblems({ labelled: false, title: 'refactor(core): x', body: '' }),
    [],
  );
});

test('a labelled PR naming the expected difference passes', () => {
  assert.deepEqual(behaviorChangeProblems(ok), []);
  const body = 'Summary\n\n  expected difference: browser.type result.text changes\n\nMore';
  assert.deepEqual(behaviorChangeProblems({ ...ok, body }), []);
});

test('a labelled PR without the line, or with it empty, fails', () => {
  for (const body of [
    '',
    'no marker here',
    'Expected difference:',
    'Expected difference:   \nnext line',
    'The Expected difference: is inline',
  ]) {
    const problems = behaviorChangeProblems({ ...ok, body });
    assert.equal(problems.length, 1, body);
    assert.match(problems[0], /Expected difference:/);
  }
});

test('a labelled refactor PR fails whatever its body says', () => {
  for (const title of ['refactor(core): move a', 'refactor: tidy', 'Refactor(core)!: x']) {
    const problems = behaviorChangeProblems({ ...ok, title });
    assert.equal(problems.length, 1, title);
    assert.match(problems[0], /refactor PR must not carry/);
  }
  // Both problems at once are both reported.
  assert.equal(
    behaviorChangeProblems({ labelled: true, title: 'refactor: x', body: '' }).length,
    2,
  );
});

test('other titles are not refactors', () => {
  for (const title of [
    'feat: x',
    'fix(core): refactor: later',
    'refactored: x',
    'refactor(extension): x',
  ]) {
    assert.deepEqual(behaviorChangeProblems({ ...ok, title }), [], title);
  }
});

test('main reads the PR only from the environment and returns the exit code', () => {
  const quiet = console.error;
  console.error = () => {};
  try {
    assert.equal(main({ BEHAVIOR_CHANGE: 'false' }), 0);
    assert.equal(main({ BEHAVIOR_CHANGE: 'true', PR_TITLE: ok.title, PR_BODY: ok.body }), 0);
    assert.equal(main({ BEHAVIOR_CHANGE: 'true', PR_TITLE: ok.title, PR_BODY: '' }), 1);
  } finally {
    console.error = quiet;
  }
});
