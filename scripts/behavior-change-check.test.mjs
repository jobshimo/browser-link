// The behavior-change label's guard (scripts/behavior-change-check.mjs).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  behaviorChangeProblems,
  expectedLabelsOf,
  expectedLabelsOutput,
  main,
} from './behavior-change-check.mjs';

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

// The `Expected labels:` line (design 7(b), revision 14).
const listed = `${ok.body}\nExpected labels: browser.drag.cdp, browser.canvas_screenshot.cdp\n`;

test('the Expected labels line is parsed, validated, unique and sorted', () => {
  assert.deepEqual(expectedLabelsOf(listed), {
    entries: ['browser.canvas_screenshot.cdp', 'browser.drag.cdp'],
  });
  assert.deepEqual(expectedLabelsOf('Summary\r\n  expected labels:  a.b \r\nMore'), {
    entries: ['a.b'],
  });
  assert.deepEqual(expectedLabelsOf('no such line'), { entries: [] });
  assert.deepEqual(behaviorChangeProblems({ ...ok, body: listed }), []);
});

test('a labelled PR with a malformed, empty or repeated Expected labels line fails', () => {
  for (const line of [
    'Expected labels: browser.drag.cdp; rm -rf /',
    'Expected labels: $(id)',
    'Expected labels: a.b,,c.d',
    'Expected labels:',
    'Expected labels: a.b\nExpected labels: c.d',
  ]) {
    const problems = behaviorChangeProblems({ ...ok, body: `${ok.body}\n${line}` });
    assert.equal(problems.length, 1, line);
    assert.match(problems[0], /"Expected labels:" line is invalid/, line);
  }
});

test('unlabelled (RED): the Expected labels line is ignored, even when malformed', () => {
  const body = `${listed}\nExpected labels: $(id)`;
  assert.deepEqual(behaviorChangeProblems({ labelled: false, title: ok.title, body }), []);
  assert.deepEqual(expectedLabelsOutput({ labelled: false, body: listed }), []);
  assert.deepEqual(expectedLabelsOutput({ labelled: true, body: listed }), [
    'browser.canvas_screenshot.cdp',
    'browser.drag.cdp',
  ]);
});

test('main writes only the validated list to GITHUB_OUTPUT, and only for a labelled PR', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bl-bc-check-'));
  const quiet = [console.error, console.log];
  console.error = () => {};
  console.log = () => {};
  try {
    const out = (name) => join(dir, name);
    const env = { BEHAVIOR_CHANGE: 'true', PR_TITLE: ok.title, PR_BODY: listed };
    assert.equal(main({ ...env, GITHUB_OUTPUT: out('labelled') }), 0);
    assert.equal(
      readFileSync(out('labelled'), 'utf8'),
      'expected_labels=browser.canvas_screenshot.cdp,browser.drag.cdp\n',
    );
    assert.equal(main({ ...env, BEHAVIOR_CHANGE: 'false', GITHUB_OUTPUT: out('unlabelled') }), 0);
    assert.equal(readFileSync(out('unlabelled'), 'utf8'), 'expected_labels=\n');
    // A malformed line fails the check and writes nothing.
    const bad = `${ok.body}\nExpected labels: a.b\nexpected_labels=injected`;
    assert.equal(
      main({ ...env, PR_BODY: `${bad}\nExpected labels: x;y`, GITHUB_OUTPUT: out('bad') }),
      1,
    );
    assert.throws(() => readFileSync(out('bad'), 'utf8'), /ENOENT/);
  } finally {
    [console.error, console.log] = quiet;
    rmSync(dir, { recursive: true, force: true });
  }
});
