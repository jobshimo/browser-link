// The differential's gate (scripts/e2e-diff.mjs): two normalised records
// are equal, or the first differing call is printed with both values.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normaliseRecord } from '../packages/e2e/src/normalise.mjs';
import {
  EXIT,
  exitCode,
  firstDifference,
  formatDifference,
  gateExit,
  leafPath,
  summaryMarkdown,
} from './e2e-diff.mjs';

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

test('a changed timeout_ms or settle_ms is reported, in args and in a result', () => {
  const raw = (args, body) => ({
    ok: true,
    calls: [
      {
        tool: 'browser.wait_for',
        label: 'browser.wait_for',
        args,
        result: { content: [{ type: 'text', text: JSON.stringify(body) }] },
      },
    ],
  });
  const base = normaliseRecord(raw({ timeout_ms: 5000 }, { settle_ms: 0, elapsed_ms: 3 }));
  const sameTiming = normaliseRecord(raw({ timeout_ms: 5000 }, { settle_ms: 0, elapsed_ms: 9 }));
  assert.equal(firstDifference(base, sameTiming), null);
  const args = normaliseRecord(raw({ timeout_ms: 8000 }, { settle_ms: 0, elapsed_ms: 3 }));
  assert.equal(firstDifference(base, args).path, 'args.timeout_ms');
  const result = normaliseRecord(raw({ timeout_ms: 5000 }, { settle_ms: 50, elapsed_ms: 3 }));
  assert.equal(firstDifference(base, result).path, 'result.content[0].json.settle_ms');
});

test('behavior-change: a base difference passes; self-diff, harness or setup failures still fail', () => {
  const label = { behaviorChange: true };
  assert.equal(gateExit(EXIT.equal, label), 0);
  assert.equal(gateExit(EXIT.difference, label), 0);
  assert.equal(gateExit(EXIT.harness, label), 2);
  assert.equal(gateExit(EXIT.setup, label), 3);
  // Two runs of HEAD differing is the normalise table's fault, not the PR's.
  assert.equal(gateExit(EXIT.difference, { behaviorChange: true, selfDiffers: true }), 1);
  // Without the label the script's own code is the gate.
  for (const code of [0, 1, 2, 3]) {
    assert.equal(gateExit(code), code);
    assert.equal(gateExit(code, { behaviorChange: false }), code);
  }
});

test('the step summary names the verdict and carries each difference', () => {
  const diff = formatDifference(
    firstDifference(rec([call('click', { a: 1 })]), rec([call('click', { a: 2 })])),
  );
  const accepted = summaryMarkdown({
    code: EXIT.difference,
    behaviorChange: true,
    reports: [diff],
  });
  assert.match(accepted, /^## e2e differential\n/);
  assert.match(accepted, /difference, accepted: the PR carries the `behavior-change` label/);
  assert.match(accepted, /The PR description must name this difference/);
  assert.ok(accepted.includes(`\`\`\`text\n${diff}\n\`\`\``));
  const failed = summaryMarkdown({ code: EXIT.difference, behaviorChange: false, reports: [diff] });
  assert.match(failed, /FAIL \(difference\)/);
  assert.match(failed, /`behavior-change` label/);
  const equal = summaryMarkdown({ code: EXIT.equal, behaviorChange: true, reports: [] });
  assert.match(equal, /ok: no difference/);
  assert.match(equal, /label is set but the builds behave the same/);
  assert.match(
    summaryMarkdown({ code: EXIT.harness, behaviorChange: true, reports: [] }),
    /FAIL \(harness\)/,
  );
  const self = summaryMarkdown({
    code: EXIT.difference,
    behaviorChange: true,
    selfDiffers: true,
    reports: [diff],
  });
  assert.match(self, /Two runs of HEAD differ/);
  assert.match(self, /does not excuse this/);
});
