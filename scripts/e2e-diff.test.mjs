// The differential's gate (scripts/e2e-diff.mjs): two normalised records
// are equal, or the first differing call is printed with both values.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EXIT, exitCode, firstDifference, formatDifference, leafPath } from './e2e-diff.mjs';

const call = (label, json) => ({
  label,
  tool: 'browser.click',
  args: { tab_id: '<tab#1>' },
  result: { content: [{ type: 'text', json }] },
});
const rec = (calls, ok = true) => ({ ok, calls });

test('equal records have no difference', () => {
  const a = rec([call('click', { clicked: 'e1' }), call('press', { ok: true })]);
  assert.equal(firstDifference(a, structuredClone(a)), null);
});

test('the first differing call is reported with both values and the leaf path', () => {
  const base = rec([call('click', { ok: true }), call('press', { text: 'Added: alpha' })]);
  const head = rec([call('click', { ok: true }), call('press', { text: 'Added: alpho' })]);
  const diff = firstDifference(base, head);
  assert.equal(diff.index, 1);
  assert.equal(diff.path, 'result.content[0].json.text');
  assert.deepEqual(diff.base, base.calls[1]);
  assert.deepEqual(diff.head, head.calls[1]);
  const out = formatDifference(diff);
  assert.match(
    out,
    /^e2e-diff: first difference at call #1 \(press\), at result\.content\[0\]\.json\.text$/m,
  );
  assert.ok(out.includes('"text": "Added: alpha"'));
  assert.ok(out.includes('"text": "Added: alpho"'));
  assert.ok(out.indexOf('--- base') < out.indexOf('Added: alpha'));
  assert.ok(out.indexOf('--- head') < out.indexOf('Added: alpho'));
});

test('only the first of several differences is reported', () => {
  const base = rec([call('a', { n: 1 }), call('b', { n: 2 })]);
  const head = rec([call('a', { n: 9 }), call('b', { n: 9 })]);
  assert.equal(firstDifference(base, head).index, 0);
});

test('a record with fewer calls differs at the first missing call', () => {
  const base = rec([call('a', {}), call('b', {})]);
  const head = rec([call('a', {})]);
  const diff = firstDifference(base, head);
  assert.equal(diff.index, 1);
  assert.equal(diff.head, undefined);
  assert.match(formatDifference(diff), /--- head\n\(no such call\)/);
});

test('a run that passed and one that failed differ even with equal calls', () => {
  const diff = firstDifference(rec([], true), rec([], false));
  assert.equal(diff.path, 'ok');
});

test('key order does not matter; an added key does', () => {
  assert.equal(leafPath({ a: 1, b: 2 }, { b: 2, a: 1 }), null);
  assert.equal(leafPath({ a: 1 }, { a: 1, b: 2 }), 'b');
  assert.equal(leafPath([1, 2], [1, 3]), '[1]');
});

test('the names of the two sides are printed', () => {
  const diff = firstDifference(rec([call('a', { n: 1 })]), rec([call('a', { n: 2 })]));
  const out = formatDifference(diff, ['head', 'head-2']);
  assert.match(out, /^--- head$/m);
  assert.match(out, /^--- head-2$/m);
});

test('exit codes: 0 equal, 1 difference, 2 harness failure, 3 setup error; highest wins', () => {
  assert.equal(exitCode({}), 0);
  assert.equal(exitCode({ differs: true }), 1);
  assert.equal(exitCode({ harnessFailed: true }), 2);
  assert.equal(exitCode({ harnessFailed: true, differs: true }), 2);
  assert.equal(exitCode({ setupError: true }), 3);
  assert.equal(exitCode({ setupError: true, harnessFailed: true, differs: true }), 3);
  assert.deepEqual(EXIT, { equal: 0, difference: 1, harness: 2, setup: 3 });
});
