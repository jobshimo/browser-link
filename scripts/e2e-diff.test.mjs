// The differential's gate (scripts/e2e-diff.mjs): two normalised records
// are equal, or the first differing call is printed with both values.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { normaliseRecord } from '../packages/e2e/src/normalise.mjs';
import {
  cacheBaseRecord,
  EXIT,
  exitCode,
  expectedEntriesFor,
  expectedLabelsVerdict,
  firstDifference,
  formatDifference,
  formatExpectedLabels,
  gateExit,
  harnessEnv,
  leafPath,
  parseArgs,
  summaryMarkdown,
  thrownKind,
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

test('behavior-change without a list (follow-up rule 4, RED): equal passes, a difference fails; self-diff, harness or setup failures still fail', () => {
  const label = { behaviorChange: true };
  // A behavior change only unit tests see (#84, #85): the builds are equal.
  assert.equal(gateExit(EXIT.equal, label), 0);
  // No blanket excuse: a difference needs the Expected labels line.
  assert.equal(gateExit(EXIT.difference, label), 1);
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
  const noLine = summaryMarkdown({
    code: EXIT.difference,
    behaviorChange: true,
    differingLabels: ['click'],
    reports: [diff],
  });
  assert.match(noLine, /^## e2e differential\n/);
  assert.match(noLine, /FAIL \(difference\)\. The PR carries the `behavior-change` label but/);
  assert.match(noLine, /no `Expected labels:` line: add one naming every call label/);
  assert.match(noLine, /push or\ntoggle the label/);
  assert.match(noLine, /^Differing labels: `click`$/m);
  assert.ok(noLine.includes(`\`\`\`text\n${diff}\n\`\`\``));
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

// Expected labels (design 7(b), revision 14): a behavior-change PR lists the
// labels whose difference it expects; the base run records them without
// asserting; the gate compares per label.

/** A raw call as run.mjs records it: the result as MCP text, or an error. */
const rawCall = (label, tool, body, isError = false) => ({
  tool,
  label,
  args: { tab_id: 'cdp:1' },
  result: {
    content: [{ type: 'text', text: typeof body === 'string' ? body : JSON.stringify(body) }],
    ...(isError ? { isError: true } : {}),
  },
});
/** The P1 shape: the base predates canvas_screenshot and drag on cdp-direct,
 * so its record-only run recorded both cases as tool errors. */
const p1Records = () => {
  const common = [
    rawCall('browser.list_tabs.cdp', 'browser.list_tabs', [{ tab_id: 'cdp:1' }]),
    rawCall('browser.click.cdp', 'browser.click', { ok: true }),
  ];
  const base = normaliseRecord({
    ok: true,
    calls: [
      ...common,
      rawCall(
        'browser.canvas_screenshot.cdp',
        'browser.canvas_screenshot',
        'Error: canvas_screenshot is not supported over cdp-direct in v1',
        true,
      ),
      rawCall('browser.drag.cdp', 'browser.drag', 'Error: drag is not supported', true),
    ],
  });
  const head = normaliseRecord({
    ok: true,
    calls: [
      ...common,
      rawCall('browser.canvas_screenshot.cdp', 'browser.canvas_screenshot', {
        ok: true,
        format: 'png',
      }),
      rawCall('browser.drag.cdp', 'browser.drag', { drag_mode: 'html5' }),
    ],
  });
  return { base, head };
};
const P1_LIST = ['browser.canvas_screenshot.cdp', 'browser.drag.cdp'];
const gateOf = (base, head, entries) => {
  const expected = expectedLabelsVerdict(base, head, entries);
  const code = exitCode({ differs: firstDifference(base, head) !== null });
  return gateExit(code, { behaviorChange: true, expected });
};

test('expected labels: a synthetic P1 base whose listed cases failed passes when every difference is listed', () => {
  const { base, head } = p1Records();
  const verdict = expectedLabelsVerdict(base, head, P1_LIST);
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.equalEntries, []);
  assert.deepEqual(verdict.unexpected, []);
  assert.equal(verdict.residual, null);
  assert.deepEqual(
    verdict.listed.map((r) => [r.entry, r.differs, r.labels]),
    [
      ['browser.canvas_screenshot.cdp', true, ['browser.canvas_screenshot.cdp']],
      ['browser.drag.cdp', true, ['browser.drag.cdp']],
    ],
  );
  assert.equal(gateOf(base, head, P1_LIST), EXIT.equal);
});

test('expected labels (rule 3, RED): a listed label that comes out equal fails the gate', () => {
  const { base, head } = p1Records();
  for (const entries of [
    [...P1_LIST, 'browser.click.cdp'],
    // A stale entry no call carries is equal too.
    [...P1_LIST, 'browser.no_such_case.cdp'],
  ]) {
    const verdict = expectedLabelsVerdict(base, head, entries);
    assert.equal(verdict.ok, false, entries.join());
    assert.deepEqual(verdict.equalEntries, [entries[2]]);
    assert.equal(gateOf(base, head, entries), EXIT.difference);
    assert.match(formatExpectedLabels(verdict), /listed but equal/);
  }
  // Two equal builds with a list: nothing differs, so the list fails.
  assert.equal(gateOf(base, structuredClone(base), P1_LIST), EXIT.difference);
});

test('expected labels (rule 4, RED): a differing label outside the list fails the gate', () => {
  const { base, head } = p1Records();
  const verdict = expectedLabelsVerdict(base, head, ['browser.canvas_screenshot.cdp']);
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.unexpected, ['browser.drag.cdp']);
  assert.match(formatExpectedLabels(verdict), /differing but not listed: browser\.drag\.cdp/);
  assert.equal(gateOf(base, head, ['browser.canvas_screenshot.cdp']), EXIT.difference);
  // A later call changed by a listed one (tab state after a drag) must be
  // listed too.
  const later = structuredClone(head);
  later.calls[1].result.content[0].json = { ok: false };
  assert.deepEqual(expectedLabelsVerdict(base, later, P1_LIST).unexpected, ['browser.click.cdp']);
  assert.equal(gateOf(base, later, P1_LIST), EXIT.difference);
  assert.equal(gateOf(base, later, [...P1_LIST, 'browser.click.cdp']), EXIT.equal);
});

test('expected labels (rule 4): an unlisted call moved, or the run outcome changed, fails', () => {
  const { base, head } = p1Records();
  const moved = structuredClone(head);
  [moved.calls[0], moved.calls[1]] = [moved.calls[1], moved.calls[0]];
  const verdict = expectedLabelsVerdict(base, moved, P1_LIST);
  assert.deepEqual(verdict.unexpected, []);
  assert.notEqual(verdict.residual, null);
  assert.equal(verdict.ok, false);
  const failed = structuredClone(head);
  failed.ok = false;
  assert.equal(expectedLabelsVerdict(base, failed, P1_LIST).residual.path, 'ok');
});

test('expected labels (follow-up rule 1, RED): an entry of three or more segments is a prefix; fewer, only that exact label', () => {
  const { base, head } = p1Records();
  // Two segments: a tool name, which is a default label, never a prefix.
  const two = expectedLabelsVerdict(base, head, ['browser.canvas_screenshot', 'browser.drag']);
  assert.equal(two.ok, false);
  assert.deepEqual(two.equalEntries, ['browser.canvas_screenshot', 'browser.drag']);
  assert.deepEqual(two.unexpected, P1_LIST);
  const click = expectedLabelsVerdict(base, head, [...P1_LIST, 'browser.click']);
  assert.deepEqual(click.listed.find((r) => r.entry === 'browser.click').labels, []);
  assert.deepEqual(click.equalEntries, ['browser.click']);
  const broad = expectedLabelsVerdict(base, head, ['browser']);
  assert.equal(broad.ok, false);
  assert.deepEqual(broad.equalEntries, ['browser']);
  assert.deepEqual(broad.unexpected, P1_LIST);
  // Three segments still prefix: `browser.drag.cdp` covers `browser.drag.cdp.html5`.
  const sub = structuredClone({ base, head });
  for (const r of [sub.base, sub.head]) r.calls[3].label = 'browser.drag.cdp.html5';
  const three = expectedLabelsVerdict(sub.base, sub.head, P1_LIST);
  assert.equal(three.ok, true);
  assert.deepEqual(three.listed[1].labels, ['browser.drag.cdp.html5']);
});

test('expected labels (follow-up rule 2, RED): a thrown transport error on a listed base call does not count and shows as noise', () => {
  const { base, head } = p1Records();
  for (const thrown of [
    'MCP error -32001: Request timed out',
    'MCP error -32000: Connection closed',
    'socket hang up',
  ]) {
    const noisy = structuredClone(base);
    delete noisy.calls[3].result;
    noisy.calls[3].thrown = thrown;
    const verdict = expectedLabelsVerdict(noisy, head, P1_LIST);
    assert.equal(verdict.ok, false, thrown);
    assert.deepEqual(verdict.equalEntries, ['browser.drag.cdp'], thrown);
    assert.deepEqual(verdict.noise, [{ label: 'browser.drag.cdp', thrown }], thrown);
    assert.match(formatExpectedLabels(verdict), /noise \(does not count for browser\.drag\.cdp\)/);
    const md = summaryMarkdown({
      code: EXIT.difference,
      behaviorChange: true,
      expected: verdict,
      reports: [],
    });
    assert.ok(md.includes('- noise on `browser.drag.cdp` (the base call threw, does not count)'));
    assert.equal(gateOf(noisy, head, P1_LIST), EXIT.difference);
  }
});

test("expected labels (follow-up rule 2): an McpError that is the tool's counts as a tool error", () => {
  const { base, head } = p1Records();
  const tool = structuredClone(base);
  delete tool.calls[3].result;
  tool.calls[3].thrown = 'MCP error -32602: Invalid arguments for tool browser.drag';
  const verdict = expectedLabelsVerdict(tool, head, P1_LIST);
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.noise, []);
  assert.equal(thrownKind('MCP error -32602: Invalid params'), 'tool');
  assert.equal(thrownKind('MCP error -32603: Internal error'), 'tool');
  assert.equal(thrownKind('MCP error -32001: Request timed out'), 'noise');
  assert.equal(thrownKind('MCP error -32000: Connection closed'), 'noise');
  assert.equal(thrownKind('fetch failed'), 'noise');
  assert.equal(thrownKind(undefined), 'noise');
});

test('follow-up rule 3 (RED): the workflow does not run on edited; the list needs a push or a label toggle', () => {
  const yml = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const types = /^ {4}types: \[([^\]]*)\]$/m.exec(yml);
  assert.ok(types, 'pull_request types line');
  const list = types[1].split(',').map((t) => t.trim());
  assert.deepEqual(list, ['opened', 'synchronize', 'reopened', 'labeled', 'unlabeled']);
});

test('follow-up rule 4 (RED): labelled without a line, equal passes and a difference fails asking for the line', () => {
  const { base, head } = p1Records();
  const differs = exitCode({ differs: firstDifference(base, head) !== null });
  assert.equal(gateExit(differs, { behaviorChange: true }), EXIT.difference);
  assert.equal(gateExit(EXIT.equal, { behaviorChange: true }), EXIT.equal);
  const md = summaryMarkdown({
    code: differs,
    behaviorChange: true,
    differingLabels: expectedLabelsVerdict(base, head, []).unexpected,
    reports: [],
  });
  assert.match(md, /no `Expected labels:` line/);
  assert.match(md, /^Differing labels: `browser\.canvas_screenshot\.cdp`, `browser\.drag\.cdp`$/m);
  // With a list, answer 2's rules apply.
  assert.equal(gateOf(base, head, P1_LIST), EXIT.equal);
});

test('expected labels, unlabelled (RED): without the label the list is never read', () => {
  const { base, head } = p1Records();
  const expected = expectedLabelsVerdict(base, head, P1_LIST);
  assert.equal(gateExit(EXIT.difference, { behaviorChange: false, expected }), EXIT.difference);
  assert.equal(gateExit(EXIT.harness, { behaviorChange: false, expected }), EXIT.harness);
  const opts = parseArgs(['origin/main', '--expected-labels', P1_LIST.join(',')]);
  assert.deepEqual(opts.expectedLabels, P1_LIST);
  assert.deepEqual(expectedEntriesFor(opts), []);
  assert.deepEqual(
    expectedEntriesFor(
      parseArgs(['origin/main', '--behavior-change', '--expected-labels', P1_LIST.join(',')]),
    ),
    P1_LIST,
  );
  // CI passes an empty value when the PR has no line.
  assert.deepEqual(
    expectedEntriesFor(parseArgs(['origin/main', '--behavior-change', '--expected-labels', ''])),
    [],
  );
  assert.throws(() => parseArgs(['origin/main', '--expected-labels', 'a;rm -rf']), /not \[A-Za-z/);
});

test('expected labels, self-diff (RED): two HEAD runs differing is never excused by the list', () => {
  const ok = { ok: true };
  assert.equal(
    gateExit(EXIT.difference, { behaviorChange: true, selfDiffers: true, expected: ok }),
    EXIT.difference,
  );
  assert.deepEqual(
    expectedEntriesFor(
      parseArgs(['--self-diff-only', '--behavior-change', '--expected-labels', P1_LIST[0]]),
    ),
    [],
  );
});

test('expected labels: a harness or setup failure is never excused; no verdict means not met', () => {
  const ok = { ok: true };
  assert.equal(gateExit(EXIT.harness, { behaviorChange: true, expected: ok }), EXIT.harness);
  assert.equal(gateExit(EXIT.setup, { behaviorChange: true, expected: ok }), EXIT.setup);
  assert.equal(gateExit(EXIT.difference, { behaviorChange: true, expected: { ok: false } }), 1);
});

test('expected labels (rules 1, 2, 5): only the base run gets the record-only list; a hand-set value never reaches a run', () => {
  const inherited = { PATH: '/bin', E2E_RECORD_ONLY: 'browser', E2E_EXPECT_FAIL: 'click' };
  const where = { root: '/r', scratch: '/s' };
  const head = harnessEnv(inherited, { ...where, name: 'head' });
  assert.equal('E2E_RECORD_ONLY' in head, false);
  assert.equal('E2E_EXPECT_FAIL' in head, false);
  assert.equal(head.PATH, '/bin');
  assert.equal(head.E2E_ADAPTER_COVERAGE, '0');
  const base = harnessEnv(inherited, { ...where, name: 'base', recordOnly: P1_LIST });
  assert.equal(base.E2E_RECORD_ONLY, P1_LIST.join(','));
  assert.equal('E2E_RECORD_ONLY' in harnessEnv(inherited, { ...where, name: 'base' }), false);
});

test('expected labels (rule 6): a record-only base run is never written to the cache', () => {
  const file = '/cache/e2e-base-record.json';
  assert.equal(cacheBaseRecord({ passed: true, baseRecord: file }), true);
  assert.equal(cacheBaseRecord({ passed: true, baseRecord: file, expectedEntries: [] }), true);
  assert.equal(
    cacheBaseRecord({ passed: true, baseRecord: file, expectedEntries: P1_LIST }),
    false,
  );
  assert.equal(cacheBaseRecord({ passed: false, baseRecord: file }), false);
  assert.equal(cacheBaseRecord({ passed: true, baseRecord: undefined }), false);
});

test('expected labels (rule 7): the summary lists each listed label with both results', () => {
  const { base, head } = p1Records();
  const expected = expectedLabelsVerdict(base, head, P1_LIST);
  const md = summaryMarkdown({
    code: EXIT.difference,
    behaviorChange: true,
    expected,
    reports: [],
  });
  assert.match(md, /every difference is in its `Expected labels:` list/);
  assert.match(md, /^### Expected labels$/m);
  for (const label of P1_LIST) {
    assert.ok(md.includes(`- \`${label}\`: differs`), label);
  }
  assert.match(md, /--- base\nbrowser\.canvas_screenshot\.cdp: .*not supported over cdp-direct/);
  assert.match(md, /--- head\nbrowser\.canvas_screenshot\.cdp: .*"format":"png"/);
  const failed = summaryMarkdown({
    code: EXIT.difference,
    behaviorChange: true,
    expected: expectedLabelsVerdict(base, head, ['browser.drag.cdp']),
    reports: [],
  });
  assert.match(failed, /FAIL \(expected labels\)/);
  const equal = summaryMarkdown({
    code: EXIT.equal,
    behaviorChange: true,
    expected: expectedLabelsVerdict(base, base, P1_LIST),
    reports: [],
  });
  assert.ok(equal.includes('- `browser.drag.cdp`: **equal on base and head**'));
});
