// The differential's normalise table (normalise.mjs): what two runs of the
// same build may differ in is rewritten; everything else is compared as is.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonical, collapsePolls, imageSummary, normaliseRecord } from './normalise.mjs';

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

test('timing: *_ms keys, the named keys, epoch ms under *at/time keys, ISO and HTTP dates', () => {
  const r = normaliseRecord(
    record([
      {
        tool: 'browser.flow',
        args: { timeout_ms: 5000 },
        result: textResult({
          settle: { duration_ms: 151, mutation_count: 4 },
          duration_ms_actual: 434,
          elapsedMs: 3,
          durationMs: 9,
          started_at: 1794904133234,
          finished_at: 1794904133247,
          timestamp: 1794904113670.873,
          expires_at: 1794905934426,
          small_at: 12,
          last_ok_at: '2026-11-17T08:28:37.942Z',
          Date: 'Tue, 17 Nov 2026 08:28:53 GMT',
          url: 'http://127.0.0.1:5000/capture.html?n=1794904133215',
        }),
      },
    ]),
  );
  assert.equal(r.calls[0].args.timeout_ms, '<ms>');
  assert.deepEqual(bodyOf(r), {
    settle: { duration_ms: '<ms>', mutation_count: 4 },
    duration_ms_actual: '<ms>',
    elapsedMs: '<ms>',
    durationMs: '<ms>',
    started_at: '<ms>',
    finished_at: '<ms>',
    timestamp: '<ms>',
    expires_at: '<ms>',
    small_at: 12,
    last_ok_at: '<iso>',
    Date: '<http-date>',
    url: 'http://127.0.0.1:<port>/capture.html?n=<ms>',
  });
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
        result: textResult([{ extension_version: '1.3.7', title: 'v 1.3.7', version: 'x' }]),
      },
    ]),
  );
  assert.deepEqual(bodyOf(r), [{ extension_version: '<version>', title: 'v 1.3.7', version: 'x' }]);
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
