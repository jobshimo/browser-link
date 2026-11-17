// The differential's normalise table (normalise.mjs): what two runs of the
// same build may differ in is rewritten; everything else is compared as is.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  TIME_KEYS,
  canonical,
  collapsePolls,
  imageSummary,
  normaliseRecord,
} from './normalise.mjs';

const textResult = (body) => ({ content: [{ type: 'text', text: JSON.stringify(body) }] });
const record = (calls, context = {}, extra = {}) => ({
  ok: true,
  chrome: 'HeadlessChrome/118.0.5993.70',
  context: { home: undefined, temps: [], ports: [], ...context },
  calls,
  ...extra,
});
const bodyOf = (normalised, i = 0) => normalised.calls[i].result.content[0].json;

/** A minimal PNG header (signature + IHDR): enough for imageSummary. */
function pngB64(width, height, fill = 0) {
  const buf = Buffer.alloc(80, fill);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'latin1');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf.toString('base64');
}

test('ids are renamed by first appearance and keep identity across args and results', () => {
  const r = normaliseRecord(
    record([
      { tool: 'browser.flow', args: {}, result: textResult({ flow_id: 'flow_aaa' }) },
      { tool: 'browser.flow', args: {}, result: textResult({ flow_id: 'flow_bbb' }) },
      { tool: 'browser.flow_status', args: { flow_id: 'flow_aaa' }, result: textResult({}) },
    ]),
  );
  assert.equal(bodyOf(r, 0).flow_id, '<flow#1>');
  assert.equal(bodyOf(r, 1).flow_id, '<flow#2>');
  assert.equal(r.calls[2].args.flow_id, '<flow#1>');
});

test("Chrome's own ids (requestId, frameId, targetId, ...) are renamed", () => {
  const r = normaliseRecord(
    record([
      {
        tool: 'browser.network',
        args: {},
        result: textResult({
          requestId: '51916.43',
          frameId: 'F1',
          loaderId: 'L1',
          targetId: 'T1',
          backendNodeId: 7,
          executionContextId: 3,
          scriptId: '12',
        }),
      },
    ]),
  );
  assert.deepEqual(bodyOf(r), {
    requestId: '<request#1>',
    frameId: '<frame#1>',
    loaderId: '<loader#1>',
    targetId: '<target#1>',
    backendNodeId: '<node#1>',
    executionContextId: '<context#1>',
    scriptId: '<script#1>',
  });
});

test('a known id inside free text gets its name; refs and snapshot ids keep their suffix', () => {
  const r = normaliseRecord(
    record([
      {
        tool: 'browser.snapshot',
        args: {},
        result: textResult({
          doc_id: 'ggz92ghgmwkfke0i',
          snapshot_id: 'ggz92ghgmwkfke0i:s2',
          ref: 'ggz92g:e12',
          note: 'request 51916.43 of ggz92ghgmwkfke0i',
        }),
      },
      { tool: 'browser.click', args: { ref: 'ggz92g:e3' }, result: textResult({}) },
    ]),
  );
  const b = bodyOf(r);
  assert.equal(b.doc_id, '<doc#1>');
  assert.equal(b.snapshot_id, '<doc#1>:s2');
  assert.equal(b.ref, '<ref-doc#1>:e12');
  assert.equal(b.note, 'request 51916.43 of <doc#1>');
  assert.equal(r.calls[1].args.ref, '<ref-doc#1>:e3');
});

test('timing: the listed result keys, ISO and HTTP dates; nothing else', () => {
  const r = normaliseRecord(
    record([
      {
        tool: 'browser.flow',
        args: { timeout_ms: 5000, settle_ms: 0, duration_ms: 300 },
        result: textResult({
          settle: { duration_ms: 151, mutation_count: 4 },
          duration_ms_actual: 434,
          elapsed_ms: 3,
          durationMs: 9,
          started_at: 1794904133234,
          finished_at: 1794904133247,
          timestamp: 1794904113670.873,
          expires_at: 1794905934426,
          ended_at: 1794905934000,
          taken_at_ms: 1794904133240,
          timeout_ms: 5000,
          settle_ms: 0,
          elapsedMs: 3,
          other_at: 1794904133234,
          format: 1794904133234,
          note: 'id 1794904133215 kept',
          last_ok_at: '2026-11-17T08:28:37.942Z',
          Date: 'Tue, 17 Nov 2026 08:28:53 GMT',
          url: 'http://127.0.0.1:5000/capture.html?n=1794904133215',
        }),
      },
    ]),
  );
  // Recorded args are never masked: a changed default is a difference.
  assert.deepEqual(r.calls[0].args, { timeout_ms: 5000, settle_ms: 0, duration_ms: 300 });
  assert.deepEqual(bodyOf(r), {
    settle: { duration_ms: '<ms>', mutation_count: 4 },
    duration_ms_actual: '<ms>',
    elapsed_ms: '<ms>',
    durationMs: '<ms>',
    started_at: '<ms>',
    finished_at: '<ms>',
    timestamp: '<ms>',
    expires_at: '<ms>',
    ended_at: '<ms>',
    taken_at_ms: '<ms>',
    // Not in TIME_KEYS: compared as is.
    timeout_ms: 5000,
    settle_ms: 0,
    elapsedMs: 3,
    other_at: 1794904133234,
    format: 1794904133234,
    note: 'id 1794904133215 kept',
    last_ok_at: '<iso>',
    Date: '<http-date>',
    url: 'http://127.0.0.1:<port>/capture.html?n=<ms>',
  });
});

test('every key in TIME_KEYS is masked in a result, at any depth', () => {
  assert.ok(TIME_KEYS.length > 0);
  for (const key of TIME_KEYS) {
    const run = (v) =>
      normaliseRecord(
        record([
          {
            tool: 'browser.click',
            args: {},
            result: textResult({ [key]: v, deep: [{ [key]: v }] }),
          },
        ]),
      );
    assert.deepEqual(bodyOf(run(17)), { [key]: '<ms>', deep: [{ [key]: '<ms>' }] }, key);
    assert.equal(canonical(run(17)), canonical(run(1794904133234)), key);
  }
});

test('a changed timeout_ms or settle_ms is a difference, in args and in a result', () => {
  const run = (args, body) =>
    normaliseRecord(record([{ tool: 'browser.wait_for', args, result: textResult(body) }]));
  const base = run({ timeout_ms: 5000, settle_ms: 0 }, { timeout_ms: 5000, settle_ms: 0 });
  for (const changed of [
    run({ timeout_ms: 8000, settle_ms: 0 }, { timeout_ms: 5000, settle_ms: 0 }),
    run({ timeout_ms: 5000, settle_ms: 50 }, { timeout_ms: 5000, settle_ms: 0 }),
    run({ timeout_ms: 5000, settle_ms: 0 }, { timeout_ms: 8000, settle_ms: 0 }),
    run({ timeout_ms: 5000, settle_ms: 0 }, { timeout_ms: 5000, settle_ms: 50 }),
  ]) {
    assert.notEqual(canonical(changed), canonical(base));
  }
  // A listed key nested in args (a flow step's own value) is not masked either.
  const flow = (ms) =>
    normaliseRecord(
      record([
        {
          tool: 'browser.flow',
          args: { steps: [{ drag: { duration_ms: ms } }] },
          result: textResult({}),
        },
      ]),
    );
  assert.notEqual(canonical(flow(100)), canonical(flow(200)));
});

test('paths: backslashes, drive letters, HOME, temp dirs, ports and the Chrome version', () => {
  const r = normaliseRecord(
    record(
      [
        {
          tool: 'browser.download',
          args: {},
          result: textResult({
            path: 'C:\\Users\\me\\AppData\\Local\\Temp\\bl-e2e-data-sYaYsv\\downloads\\a.bin',
            home: 'C:\\Users\\me\\AppData\\Local\\Temp\\bl-e2e-home-Ab12Cd\\.claude',
            other: '/tmp/bl-e2e-profile-Q1w2E3/x',
            app_key: '127-0-0-1-54039',
            ws_port: 54039,
            count: 54039,
            ua: 'HeadlessChrome/118.0.5993.70 Safari',
          }),
        },
      ],
      {
        home: 'C:\\Users\\me\\AppData\\Local\\Temp\\bl-e2e-home-Ab12Cd',
        temps: [
          'C:\\Users\\me\\AppData\\Local\\Temp\\bl-e2e-data-sYaYsv',
          'C:\\Users\\me\\AppData\\Local\\Temp\\bl-e2e-home-Ab12Cd',
        ],
        ports: [54039],
      },
    ),
  );
  assert.deepEqual(bodyOf(r), {
    path: '<tmp>/bl-e2e-data/downloads/a.bin',
    home: '<home>/.claude',
    other: '/tmp/bl-e2e-profile/x',
    app_key: '127-0-0-1-<port>',
    ws_port: '<port>',
    count: 54039,
    ua: 'HeadlessChrome/<chrome> Safari',
  });
});

test('images become { format, width, height, sha256 } (MCP block, base64 field, data URL)', () => {
  const png = pngB64(64, 32);
  const summary = imageSummary(png);
  assert.equal(summary.format, 'png');
  assert.equal(summary.width, 64);
  assert.equal(summary.height, 32);
  assert.match(summary.sha256, /^[0-9a-f]{64}$/);
  const r = normaliseRecord(
    record([
      {
        tool: 'browser.screenshot',
        args: {},
        result: {
          content: [
            { type: 'image', data: png, mimeType: 'image/png' },
            {
              type: 'text',
              text: JSON.stringify({ image_b64: png, url: `data:image/png;base64,${png}` }),
            },
          ],
        },
      },
    ]),
  );
  assert.deepEqual(r.calls[0].result.content[0], { type: 'image', image: summary });
  assert.deepEqual(r.calls[0].result.content[1].json, { image_b64: summary, url: summary });
  assert.notEqual(imageSummary(pngB64(64, 32, 1)).sha256, summary.sha256);
});

test('console, network and events entries compare as sorted; ids follow the sorted order', () => {
  const a = [
    { level: 'log', text: 'b', request_id: 'r-9' },
    { level: 'log', text: 'a', request_id: 'r-7' },
  ];
  const run = (entries) =>
    normaliseRecord(record([{ tool: 'browser.console', args: {}, result: textResult(entries) }]));
  assert.equal(canonical(run(a)), canonical(run([...a].reverse())));
  assert.deepEqual(bodyOf(run(a)), [
    { level: 'log', text: 'a', request_id: '<request#1>' },
    { level: 'log', text: 'b', request_id: '<request#2>' },
  ]);
  // Other tools keep their order.
  const list = (entries) =>
    normaliseRecord(record([{ tool: 'browser.find', args: {}, result: textResult(entries) }]));
  assert.notEqual(canonical(list(['x', 'y'])), canonical(list(['y', 'x'])));
});

test('error strings are compared as is: a one-token change is a difference', () => {
  const err = (text) =>
    normaliseRecord(
      record([
        {
          tool: 'browser.click',
          args: { selector: '#nobox' },
          result: { content: [{ type: 'text', text }], isError: true },
        },
      ]),
    );
  const a = err('Error: Element #nobox has no visible box');
  assert.deepEqual(a.calls[0].result, {
    content: [{ type: 'text', text: 'Error: Element #nobox has no visible box' }],
    isError: true,
  });
  assert.notEqual(canonical(a), canonical(err('Error: Element #nobox has no visible frame')));
});

test('a run of identical poll calls keeps only its last; other calls stay', () => {
  const p = (state) => ({ tool: 'browser.flow_status', args: { flow_id: 'f' }, poll: true, state });
  const calls = [p('running'), p('running'), p('cancelled'), { tool: 'browser.ping', args: {} }];
  assert.deepEqual(
    collapsePolls(calls).map((c) => c.state ?? c.tool),
    ['cancelled', 'browser.ping'],
  );
  const notPoll = { tool: 'browser.flow_status', args: { flow_id: 'f' } };
  assert.equal(collapsePolls([notPoll, notPoll]).length, 2);
});

test("wait_for's poll count becomes <count>; the same key in another tool does not", () => {
  const r = normaliseRecord(
    record([
      { tool: 'browser.wait_for', args: {}, result: textResult({ matched: true, checks: 3 }) },
      { tool: 'browser.find', args: {}, result: textResult({ checks: 3 }) },
    ]),
  );
  assert.deepEqual(bodyOf(r, 0), { matched: true, checks: '<count>' });
  assert.deepEqual(bodyOf(r, 1), { checks: 3 });
});

test("browser-link's own release number becomes <version>; other values do not", () => {
  const r = normaliseRecord(
    record([
      {
        tool: 'browser.list_tabs',
        args: {},
        result: textResult([
          { extension_version: '1.3.7', server_version: '1.3.7', title: 'v 1.3.7', version: 'x' },
        ]),
      },
    ]),
  );
  assert.deepEqual(bodyOf(r), [
    { extension_version: '<version>', server_version: '1.3.7', title: 'v 1.3.7', version: 'x' },
  ]);
});

test('a call that threw keeps its message; ok and the call labels are kept', () => {
  const r = normaliseRecord(
    record(
      [{ tool: 'browser.ping', label: 'ping.late', args: {}, thrown: 'Request timed out' }],
      {},
      { ok: false },
    ),
  );
  assert.deepEqual(r, {
    ok: false,
    calls: [{ label: 'ping.late', tool: 'browser.ping', args: {}, thrown: 'Request timed out' }],
  });
});

test('both accepted flow_cancel outcomes normalise equal; any other state does not', () => {
  const common = {
    flow_id: 'flow_aaa',
    tab_id: 7,
    detached: true,
    started_at: 1_700_000_000_000,
    steps: 1,
    cancel_requested: true,
    pending_wrap_up: 64,
  };
  const cancelled = {
    ...common,
    state: 'cancelled',
    ended_at: 1_700_000_001_000,
    steps_completed: 1,
    iterations_completed: 2,
    stopped_by: 'cancelled',
    manifest: [{ iterations: [[{ ok: true }], [{ ok: true }]], stopped_by: 'cancelled' }],
  };
  const cancelling = {
    ...common,
    state: 'running',
    cancelling: true,
    expires_at: 1_700_000_900_000,
    steps_completed: 0,
    iterations_completed: 1,
  };
  const cancel = (body) =>
    normaliseRecord(record([{ tool: 'browser.flow_cancel', args: {}, result: textResult(body) }]));
  const a = cancel(cancelled);
  assert.equal(canonical(a), canonical(cancel(cancelling)));
  assert.deepEqual(bodyOf(a), {
    flow_id: '<flow#1>',
    tab_id: '<tab#1>',
    detached: true,
    started_at: '<ms>',
    steps: 1,
    cancel_requested: true,
    pending_wrap_up: 64,
    state: '<cancel-accepted>',
    steps_completed: '<count>',
    iterations_completed: '<count>',
  });
  for (const other of [
    { ...cancelling, cancelling: false },
    { ...common, state: 'running', iterations_completed: 1 },
    { ...cancelled, state: 'failed' },
  ]) {
    assert.notEqual(canonical(cancel(other)), canonical(a));
    assert.equal(bodyOf(cancel(other)).state, other.state);
  }
  // The same body under another tool keeps its state.
  const status = normaliseRecord(
    record([{ tool: 'browser.flow_status', args: {}, result: textResult(cancelled) }]),
  );
  assert.equal(bodyOf(status).state, 'cancelled');
  assert.equal(bodyOf(status).iterations_completed, 2);
});

test('flow_cancel: each shape-only key is dropped, the progress counts are masked, the rest is kept', () => {
  const cancel = (body) =>
    bodyOf(
      normaliseRecord(
        record([{ tool: 'browser.flow_cancel', args: {}, result: textResult(body) }]),
      ),
    );
  const running = { state: 'running', cancelling: true };
  const cancelled = { state: 'cancelled' };
  // Present in only one of the two accepted shapes: dropped.
  for (const [key, value, shape] of [
    ['cancelling', true, running],
    ['expires_at', 1_700_000_900_000, running],
    ['ended_at', 1_700_000_001_000, cancelled],
    ['stopped_by', 'cancelled', cancelled],
    ['manifest', [{ ok: true }], cancelled],
  ]) {
    assert.equal(Object.hasOwn(cancel({ ...shape, [key]: value }), key), false, key);
  }
  // How far the flow got when the stop landed: kept as present, value masked.
  for (const key of ['steps_completed', 'iterations_completed']) {
    assert.equal(cancel({ ...running, [key]: 3 })[key], '<count>', key);
    assert.equal(Object.hasOwn(cancel(running), key), false, key);
  }
  // Anything else is compared: a new or changed field is a difference.
  assert.equal(cancel({ ...running, error: 'boom' }).error, 'boom');
  assert.equal(cancel({ ...running, manifest_truncated: true }).manifest_truncated, true);
  assert.equal(cancel({ ...running, steps: 2 }).steps, 2);
});
