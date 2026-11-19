// The expected-labels list (expected-labels.mjs): the parser the PR check,
// the differential and the harness share, and the harness's record-only
// wrapper (design 7(b), revision 14).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isListed,
  labelMatches,
  MAX_ENTRIES,
  parseLabelList,
  recordOnlyRunner,
} from './expected-labels.mjs';

test('parseLabelList: comma-separated entries, trimmed, unique and sorted', () => {
  assert.deepEqual(parseLabelList(' browser.drag.cdp, browser.canvas_screenshot.cdp '), {
    entries: ['browser.canvas_screenshot.cdp', 'browser.drag.cdp'],
  });
  assert.deepEqual(parseLabelList('a.b,a.b'), { entries: ['a.b'] });
  assert.deepEqual(parseLabelList('error.timeout,make-closed,i18n_x'), {
    entries: ['error.timeout', 'i18n_x', 'make-closed'],
  });
  for (const empty of ['', '   ', undefined, null]) {
    assert.deepEqual(parseLabelList(empty), { entries: [] });
  }
});

test('parseLabelList: anything outside [A-Za-z0-9._-] is refused, never escaped', () => {
  for (const bad of [
    'a.b;rm -rf /',
    'a b',
    '$(id)',
    'a`b`',
    'a\nb',
    'a.b,"c"',
    'ñ',
    'a/b',
    'a,,b',
    'a.b,',
  ]) {
    const r = parseLabelList(bad);
    assert.equal(r.entries, undefined, bad);
    assert.equal(typeof r.error, 'string', bad);
  }
});

test('parseLabelList: a list longer than MAX_ENTRIES is refused', () => {
  const many = Array.from({ length: MAX_ENTRIES + 1 }, (_, i) => `x.n${String(i)}`).join(',');
  assert.match(parseLabelList(many).error, /more than/);
  const enough = Array.from({ length: MAX_ENTRIES }, (_, i) => `x.n${String(i)}`).join(',');
  assert.equal(parseLabelList(enough).entries.length, MAX_ENTRIES);
});

test('labelMatches: the label itself, or a prefix of three or more segments at a dot', () => {
  assert.ok(labelMatches('browser.drag.cdp', 'browser.drag.cdp'));
  assert.ok(labelMatches('browser.drag.cdp.html5', 'browser.drag.cdp'));
  assert.ok(!labelMatches('browser.drag.cdpx', 'browser.drag.cdp'));
  assert.ok(!labelMatches('browser.drag', 'browser.drag.cdp'));
  // Fewer than three segments: only that exact label. A default label is the
  // tool name, so `browser.click` is valid but never covers `browser.click.cdp`.
  assert.ok(labelMatches('browser.click', 'browser.click'));
  assert.ok(!labelMatches('browser.click.cdp', 'browser.click'));
  assert.ok(!labelMatches('browser.drag.cdp', 'browser.drag'));
  assert.ok(!labelMatches('error.timeout.x', 'error.timeout'));
  assert.ok(!labelMatches('browser.drag.cdp', 'browser'));
  assert.ok(labelMatches('make-closed', 'make-closed'));
  assert.ok(!labelMatches(undefined, 'a.b'));
  assert.ok(isListed('error.timeout', ['browser.drag', 'error.timeout']));
  assert.ok(!isListed('error.timeout', []));
});

class StepFailure extends Error {}
const runner = (entries) => {
  const seen = [];
  const recordOnly = recordOnlyRunner({
    entries,
    isFailure: (e) => e instanceof StepFailure,
    onListedFailure: (label) => seen.push(label),
  });
  return { recordOnly, seen };
};
const failing = () => Promise.reject(new StepFailure('canvas_screenshot.cdp: tool error'));

test('record-only (rule 2, RED): a listed case that fails is swallowed and reported', async () => {
  const { recordOnly, seen } = runner(['browser.canvas_screenshot.cdp']);
  assert.equal(await recordOnly('browser.canvas_screenshot.cdp', failing), undefined);
  assert.deepEqual(seen, ['browser.canvas_screenshot.cdp']);
  // A passing listed case returns its value.
  assert.equal(await recordOnly('browser.canvas_screenshot.cdp', async () => 7), 7);
  assert.equal(seen.length, 1);
});

test('record-only (rule 2, RED): any other case still asserts', async () => {
  const { recordOnly, seen } = runner(['browser.canvas_screenshot.cdp']);
  await assert.rejects(recordOnly('browser.click.cdp', failing), StepFailure);
  // A one-segment entry does not cover a namespace.
  await assert.rejects(runner(['browser']).recordOnly('browser.click.cdp', failing), StepFailure);
  // An error that is not a case failure (setup, a crash) is never swallowed.
  await assert.rejects(
    recordOnly('browser.canvas_screenshot.cdp', () => Promise.reject(new TypeError('boom'))),
    TypeError,
  );
  assert.deepEqual(seen, []);
});

test('record-only: without a list every case asserts (HEAD and self-diff runs)', async () => {
  const { recordOnly, seen } = runner([]);
  await assert.rejects(recordOnly('browser.canvas_screenshot.cdp', failing), StepFailure);
  assert.equal(await recordOnly('x', async () => 'v'), 'v');
  assert.deepEqual(seen, []);
});
