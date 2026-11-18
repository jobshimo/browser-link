// Real-Chrome end-to-end net (`pnpm test:e2e`): the BUILT extension in an
// isolated headless Chrome, the BUILT server over MCP stdio, a tab connected
// without a human, and tool calls whose effects are asserted, so the
// extension half of every call (background.ts perform* handlers) runs for real.
// Then flow recording by demonstration on a tab of its own (recordingChecks:
// click, navigation step, Stop, Discard, the setting turned off mid-recording).
// Then the Activity and Admin windows: opened, focused when asked again, and
// opened afresh once closed (windowChecks).
// Then the interface language: switch EN | ES in the popup, open Activity and
// Admin windows follow without reload, and the choice survives a reopen.
// Last, the second transport (cdpDirectChecks, cdp-direct.mjs): a second
// headless Chrome without the extension, enabled and granted with the built
// CLI in the run's isolated data dir, driven by the same server.
//
// Isolation: free ports passed through BROWSER_LINK_WS_PORT / _IPC_PORT, a
// patched temp copy of the extension, temp profile, data dir and HOME. The
// owner's own browser-link on 17529/17530 is never touched (asserted at the end).
//
// The bridge enforces the exact extension Origin, so a full pass on a given
// Chrome proves its service worker announced chrome-extension://<pinned id>;
// a keyless copy of the same build (another id) is refused (bridge.refused).
//
// Env: CHROME_PATH (Chrome/Chromium >= 118), E2E_NO_SANDBOX=1 (Linux CI),
// E2E_EXPECT_FAIL=<tool> forces that tool's assertion to fail (RED probe),
// E2E_RESULT_FILE=<path> where the browser record goes (default
// packages/e2e/build/e2e-result.json; also appended to GITHUB_STEP_SUMMARY
// when set, titled with E2E_LEG), E2E_RECORD=<path> writes every tool call's
// request and result there (scripts/e2e-diff.mjs compares two of them),
// E2E_EXT_DIST / E2E_SERVER_CLI / E2E_SERVER_EXTENSION_ID run another build
// (lib.mjs buildPaths). E2E_ADAPTER_COVERAGE=0 skips the adapter coverage
// check (R6 condition 1, adapter-coverage.mjs), which is on by default;
// scripts/e2e-diff.mjs turns it off, since a base build may predate it.
// With it, the in-worker contract run (packages/extension/contract/) reaches
// the adapter methods the calls cannot (R6 primary path, slice 19).
// Exit 0 only when every call passes; 1 names the failing tool.
// Shape and numbers: packages/plan/lab/2026-11-09-e2e-net/README.md.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  CAPTURE_FILE,
  CHROME_STDERR_MAX,
  Cdp,
  DEFAULT_PORTS,
  E2E_DIR,
  PAGE_FILE,
  SERVER_CLI,
  colorNear,
  decodePng,
  evaluateUntil,
  extensionCopy,
  freePort,
  isAlive,
  isolatedServerEnv,
  errorText,
  jsLiteral,
  killPid,
  launchChrome,
  now,
  originProbe,
  pinnedExtensionId,
  portOwners,
  refOf,
  removeDir,
  resolveChrome,
  sleep,
  stopChrome,
  waitHttp,
  waitExtensionIds,
  waitServiceWorker,
  resultRecord,
  writeResult,
} from './lib.mjs';
import { uncalledCases } from './tool-cases.mjs';
import { cdpTabOf, enableCdpDirect } from './cdp-direct.mjs';
import {
  adapterCoverageSummary,
  adapterSourceMismatches,
  uncalledAdapterFunctions,
} from './adapter-coverage.mjs';
import { buildContract, CONTRACT_SOURCE_URL } from '../../extension/contract/build.mjs';

const CALL_TIMEOUT_MS = 45_000;
const TOTAL_TIMEOUT_MS = 300_000;
const REPORT_BYTES = Buffer.from(Array.from({ length: 2048 }, (_, i) => (i * 7 + 3) % 256));
const ATTACHMENTS = {
  '/file.bin': { name: 'e2e-report.bin', bytes: REPORT_BYTES },
  '/other.bin': { name: 'e2e-other.bin', bytes: Buffer.from(REPORT_BYTES).reverse() },
  // Executable types browser.download refuses by default (S3).
  '/setup.exe': { name: 'setup.exe', bytes: REPORT_BYTES },
  '/invoice.pdf.exe': { name: 'invoice.pdf.exe', bytes: REPORT_BYTES },
};
const EXPECT_FAIL = (process.env.E2E_EXPECT_FAIL ?? '').replace(/^browser\./, '');
const ADAPTER_COVERAGE = process.env.E2E_ADAPTER_COVERAGE !== '0';
/** The in-worker contract run's own budget: its alarm round trip included. */
const CONTRACT_TIMEOUT_MS = 120_000;
const FRAME_FILE = join(E2E_DIR, 'pages/frame.html');
/** The exact body /data.json answers (non-ASCII included): network_body must
 * return it unchanged. */
const DATA_BODY = '{"e2e":"network-body","n":7,"s":"ñ✓"}';
/** What each download situation served, by path: `requests` counts every
 * request, `methods` lists them in order. */
const served = {};

/**
 * The download situations of S2/S3, each answering a re-fetch differently.
 * Returns false for any other path.
 * - /post.pdf: a PDF to POST (with Content-Length); a GET answers 405.
 * - /token.bin: binary once (a one-time token), then 200 text/html.
 * - /chunked.bin: the report bytes with no Content-Length (chunked).
 * - /gzip.bin: the report bytes gzip-encoded, Content-Length of the gzip.
 */
function serveDownloadSituation(q, r, path) {
  const situations = ['/post.pdf', '/token.bin', '/chunked.bin', '/gzip.bin'];
  if (!situations.includes(path)) return false;
  const seen = (served[path] ??= { requests: 0, methods: [] });
  seen.requests++;
  seen.methods.push(q.method);
  // Drain a form body before answering.
  q.resume();
  const attachment = (name, type, bytes, extra = {}) => {
    r.writeHead(200, {
      'content-type': type,
      'content-disposition': `attachment; filename="${name}"`,
      'content-length': bytes.length,
      ...extra,
    });
    r.end(bytes);
  };
  if (path === '/post.pdf') {
    if (q.method === 'POST') {
      q.on('end', () => attachment('e2e-post.pdf', 'application/pdf', REPORT_BYTES));
    } else {
      r.writeHead(405, { 'content-type': 'text/html', allow: 'POST' });
      r.end('<p>Method not allowed</p>');
    }
  } else if (path === '/token.bin') {
    if (seen.requests === 1) {
      attachment('e2e-token.bin', 'application/octet-stream', REPORT_BYTES);
    } else {
      r.writeHead(200, { 'content-type': 'text/html' });
      r.end('<p>This link has expired</p>');
    }
  } else if (path === '/chunked.bin') {
    r.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-disposition': 'attachment; filename="e2e-chunked.bin"',
    });
    r.write(REPORT_BYTES.subarray(0, 1024));
    r.end(REPORT_BYTES.subarray(1024));
  } else {
    attachment('e2e-gzip.bin', 'application/octet-stream', gzipSync(REPORT_BYTES), {
      'content-encoding': 'gzip',
    });
  }
  return true;
}

class StepFailure extends Error {
  constructor(step, reason) {
    super(`${step}: ${reason}`);
    this.step = step;
  }
}

const temps = [];
/** Steps that failed without stopping the run (each already printed). */
const deferredFailures = [];
const state = {
  http: undefined,
  chrome: undefined,
  cdp: undefined,
  client: undefined,
  // The second Chrome (no extension) the cdp-direct cases drive, and the
  // harness's own CDP connection to it (used only to close it).
  cdpChrome: undefined,
  cdpChromeCdp: undefined,
};
/** The browser this run used, recorded at the end whatever the outcome. */
const browserSeen = { jsonVersion: undefined, cdpVersion: undefined };
let serverPid;
let serverStderr = '';
/** E2E_RECORD: every tool call in order, with what the run needs to
 * normalise it (normalise.mjs); written at the end whatever the outcome. */
const RECORD_FILE = process.env.E2E_RECORD ? resolve(process.env.E2E_RECORD) : undefined;
/** Every call's tool and label, kept whether or not E2E_RECORD is set: the
 * tool-to-case table is checked against it when the run ends. */
const calledCases = [];
const record = { calls: [], context: { home: undefined, temps, ports: [] } };

/** The one place a tool is called: records request and result (or the
 * thrown error) when E2E_RECORD is set. A `poll` call repeats until ready,
 * so how many there are varies; normalise.mjs keeps the last of a run. */
async function callTool(tool, args, { label, poll = false } = {}) {
  calledCases.push({ tool, label });
  const entry = RECORD_FILE ? { tool, label, args, ...(poll ? { poll } : {}) } : undefined;
  if (entry) record.calls.push(entry);
  try {
    const res = await state.client.callTool({ name: tool, arguments: args }, undefined, {
      timeout: CALL_TIMEOUT_MS,
    });
    if (entry) entry.result = res;
    return res;
  } catch (e) {
    if (entry) entry.thrown = errorText(e);
    throw e;
  }
}

const text = (res) =>
  (res?.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

function json(res) {
  try {
    return JSON.parse(res?.content?.[0]?.text ?? '');
  } catch {
    return null;
  }
}

/** One MCP tool call: must succeed, then `check(body, text, res)` must return true
 * (or a string saying what is wrong). Prints `tool ok ms`, or `label ok ms`
 * when a second check of the same tool needs its own name. */
async function call(tool, args, check, { print = true, label = tool, poll = false } = {}) {
  const short = label.replace(/^browser\./, '');
  const t = now();
  let res;
  try {
    res = await callTool(tool, args, { label, poll });
  } catch (e) {
    throw new StepFailure(short, errorText(e));
  }
  const ms = Math.round(now() - t);
  if (res.isError) throw new StepFailure(short, `tool error: ${text(res).slice(0, 300)}`);
  let verdict = check ? check(json(res), text(res), res) : true;
  if (print && EXPECT_FAIL === short) verdict = 'forced failure (E2E_EXPECT_FAIL)';
  if (verdict !== true) throw new StepFailure(short, `${String(verdict)} (${String(ms)} ms)`);
  if (print) console.log(`${label} ok ${String(ms)}`);
  return res;
}

/** One MCP tool call whose refusal is the expected outcome: never throws on
 * a tool error, returns `{ isError, body, text }` for the caller to judge. */
async function attempt(tool, args, label, { poll = false } = {}) {
  let res;
  try {
    res = await callTool(tool, args, { label, poll });
  } catch (e) {
    throw new StepFailure(label, errorText(e));
  }
  return { isError: res.isError === true, body: json(res), text: text(res) };
}

/** Walk wrap_up's step-1 report for the pending reader with this name. */
function findReaderId(node, name) {
  if (!node || typeof node !== 'object') return undefined;
  if (node.name === name && Number.isInteger(node.id)) return node.id;
  for (const v of Object.values(node)) {
    const r = findReaderId(v, name);
    if (r !== undefined) return r;
  }
  return undefined;
}

async function main() {
  const chromePath = resolveChrome();
  const [wsPort, ipcPort, cdpPort] = [await freePort(), await freePort(), await freePort()];

  // The test page over http (a real origin, like an app; not file://).
  const html = readFileSync(PAGE_FILE);
  // Two attachment files for the download steps (answered again on every GET:
  // selector mode re-fetches the URL Chrome reported); everything else is the page.
  const frameHtml = readFileSync(FRAME_FILE);
  const fixtures = {
    '/frame.html': frameHtml,
    '/capture.html': readFileSync(CAPTURE_FILE),
    '/interact.html': readFileSync(join(E2E_DIR, 'pages/interact.html')),
    '/opened.html': readFileSync(join(E2E_DIR, 'pages/opened.html')),
  };
  state.http = createServer((q, r) => {
    const path = (q.url ?? '/').split('?')[0];
    if (Object.hasOwn(fixtures, path)) {
      r.writeHead(200, { 'content-type': 'text/html' });
      r.end(fixtures[path]);
      return;
    }
    if (path === '/data.json') {
      r.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      r.end(DATA_BODY);
      return;
    }
    if (serveDownloadSituation(q, r, path)) return;
    const file = ATTACHMENTS[path];
    if (file) {
      r.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename="${file.name}"`,
        'content-length': file.bytes.length,
      });
      r.end(file.bytes);
      return;
    }
    r.writeHead(200, { 'content-type': 'text/html' });
    r.end(html);
  });
  await new Promise((r) => state.http.listen(0, '127.0.0.1', r));
  const page = `http://127.0.0.1:${String(state.http.address().port)}/`;

  // Temp data dir with the instruction refresh off, and a temp HOME: on boot
  // the server rewrites outdated agent-instruction blocks under HOME.
  const dataDir = mkdtempSync(join(tmpdir(), 'bl-e2e-data-'));
  temps.push(dataDir);
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ instructionsAutoRefresh: false }));
  const homeDir = mkdtempSync(join(tmpdir(), 'bl-e2e-home-'));
  temps.push(homeDir);
  record.context.home = homeDir;
  record.context.ports.push(wsPort, ipcPort, cdpPort, state.http.address().port);
  const extDir = extensionCopy(wsPort);
  temps.push(extDir);
  // The same build without the manifest `key`: another id, which the bridge
  // must refuse (exact Origin, since 1.0.0).
  const keylessDir = extensionCopy(wsPort, { withoutKey: true });
  temps.push(keylessDir);

  // 1. Chrome + the extension.
  const pinnedId = await pinnedExtensionId();
  const { version, extId, loadedKeylessId, loadMode } = await startChrome(
    chromePath,
    cdpPort,
    extDir,
    keylessDir,
    pinnedId,
  );
  const { cdp } = state;
  browserSeen.jsonVersion = version;
  try {
    browserSeen.cdpVersion = await cdp.send('Browser.getVersion');
  } catch {
    // recorded as null; the extension.id line below still names the browser
  }
  // The manifest `key` pins the id; the patched temp copy must keep it.
  if (extId !== pinnedId) {
    throw new StepFailure('extension.id', `Chrome assigned ${extId}, the server pins ${pinnedId}`);
  }
  console.log(`extension.id ok ${extId} (${version.Browser}, loaded with ${loadMode})`);
  const sw = await waitServiceWorker(cdp, extId, 15_000);

  // 2. The server, stdio MCP, isolated.
  const serverEnv = isolatedServerEnv({ wsPort, ipcPort, dataDir, homeDir });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_CLI],
    env: serverEnv,
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (d) => {
    serverStderr += String(d);
  });
  state.client = new Client({ name: 'browser-link-e2e', version: '0.0.0' });
  await state.client.connect(transport);
  serverPid = transport.pid ?? undefined;
  await waitHttp(`http://127.0.0.1:${String(wsPort)}/version`, 15_000);
  for (const port of DEFAULT_PORTS) {
    if (serverPid && portOwners(port).includes(serverPid)) {
      throw new StepFailure('isolation', `the e2e server holds default port ${String(port)}`);
    }
  }

  // 3. Open the page as a tab and read its chrome tab id from the worker.
  await cdp.send('Target.createTarget', { url: page });
  const { sessionId: swSession } = await cdp.send('Target.attachToTarget', {
    targetId: sw.targetId,
    flatten: true,
  });
  // R6 condition 1: count calls in the worker from before the tab connects
  // (the adapters are built on connect), checked after the tool calls.
  if (ADAPTER_COVERAGE) {
    await cdp.send('Profiler.enable', {}, swSession);
    await cdp.send(
      'Profiler.startPreciseCoverage',
      { callCount: true, detailed: false },
      swSession,
    );
  }
  const tabId = await evaluateUntil(
    cdp,
    `chrome.tabs.query({}).then(ts => (ts.find(t => t.url === ${jsLiteral(page)} && t.status === 'complete') || {}).id ?? null)`,
    swSession,
    15_000,
  );

  // 4. Connect it with the popup's own message, from an extension page
  //    (a worker's runtime.sendMessage never reaches its own onMessage).
  const { targetId: popupTarget } = await cdp.send('Target.createTarget', {
    url: `chrome-extension://${extId}/popup.html`,
  });
  const { sessionId: popupSession } = await cdp.send('Target.attachToTarget', {
    targetId: popupTarget,
    flatten: true,
  });
  const connected = await evaluateUntil(
    cdp,
    `chrome.runtime.sendMessage(${jsLiteral({ action: 'connect', tabId })})`,
    popupSession,
    15_000,
  );
  if (!connected.ok) throw new StepFailure('connect', JSON.stringify(connected));
  await cdp.send('Target.closeTarget', { targetId: popupTarget });

  // The worker reads the bridge's handshake verdict cross-origin (what the
  // popup falls back on when an upgrade is refused): accepted here.
  const verdict = await cdp.evaluate(
    `fetch('http://127.0.0.1:${String(wsPort)}/handshake-check', { cache: 'no-store' }).then((r) => r.text())`,
    swSession,
  );
  if (verdict !== '{"accepted":true}') throw new StepFailure('handshake-check', verdict);
  console.log(`handshake-check ok ${verdict}`);

  // Informational: the Origin the worker's WebSocket and fetch announce.
  const { port: probePort, seen, close: closeProbe } = await originProbe();
  try {
    await cdp.evaluate(
      `(async () => {
        await new Promise((res) => {
          const ws = new WebSocket('ws://127.0.0.1:${String(probePort)}');
          ws.onclose = () => res(true);
        });
        try { await fetch('http://127.0.0.1:${String(probePort)}/', { cache: 'no-store' }); } catch {}
        return true;
      })()`,
      swSession,
    );
  } finally {
    closeProbe();
  }
  console.log(
    `worker.origin websocket=${String(seen.websocket)} fetch=${String(seen.fetch)} sec-fetch-site=${String(seen.fetchSite)}`,
  );

  // 5. The calls.
  const tl = now();
  // Ready means listed WITH its page fingerprint (`build`, `view_sig`). The
  // observer pushes them as soon as it is installed on this already-loaded
  // page, before the tab's bridge socket is registered; the extension keeps
  // that report and delivers it on registration, so no navigation is needed.
  // All list_tabs polls stay consecutive, so only the last, ready one is kept
  // (normalise.mjs collapsePolls).
  const ready = (t) =>
    t.url === page && typeof t.build === 'string' && typeof t.view_sig === 'string';
  let tab;
  while (!tab) {
    const r = await call('browser.list_tabs', {}, undefined, { print: false, poll: true });
    const tabs = json(r);
    tab = Array.isArray(tabs) ? tabs.find(ready) : undefined;
    if (!tab && now() - tl > CALL_TIMEOUT_MS) {
      throw new StepFailure(
        'list_tabs',
        'the connected tab was never listed with its page fingerprint (build, view_sig)',
      );
    }
    if (!tab) await sleep(100);
  }
  if (EXPECT_FAIL === 'list_tabs') {
    throw new StepFailure('list_tabs', 'forced failure (E2E_EXPECT_FAIL)');
  }
  console.log(`browser.list_tabs ok ${String(Math.round(now() - tl))}`);
  const T = tab.tab_id;

  const met = (_b, t) => /"met":\s*true/.test(t) || 'expect not met';
  await call(
    'browser.snapshot',
    { tab_id: T },
    (_b, t) => t.includes('Add item') || 'snapshot lacks the Add item button',
  );
  const found = await call(
    'browser.find',
    { tab_id: T, text: 'Add item', role: 'button' },
    (_b, t) => refOf(t) !== undefined || 'no ref returned',
  );
  const ref = refOf(text(found));
  await call(
    'browser.type',
    { tab_id: T, selector: '#name', text: 'alpha' },
    (b) => b?.sensitive_field === false || `sensitive_field is ${String(b?.sensitive_field)}`,
  );
  // S2: a password field is reported, and the trail stores the marker, not the text.
  await call(
    'browser.type',
    { tab_id: T, selector: '#pw', text: 'e2e-secret' },
    (b) => b?.sensitive_field === true || `sensitive_field is ${String(b?.sensitive_field)}`,
    { label: 'browser.type.sensitive' },
  );
  await call(
    'browser.activity',
    { tool: 'browser.type', limit: 1 },
    (b, t) =>
      (b?.records?.[0]?.payload === '[sensitive field]' && !t.includes('e2e-secret')) ||
      `stored payload is ${JSON.stringify(b?.records?.[0]?.payload)}`,
    { label: 'browser.activity.sensitive' },
  );
  await call('browser.click', { tab_id: T, ref, expect: { text_appears: 'Added: alpha' } }, met);
  await call(
    'browser.wait_for',
    { tab_id: T, selector: '#done', condition: 'visible', timeout_ms: 5000 },
    (b) => b?.matched === true || 'not matched',
  );
  await call(
    'browser.press',
    { tab_id: T, key: 'Enter', selector: '#name', expect: { text_appears: 'Items: 2' } },
    met,
  );
  // browser.read runs only a KEPT reader: evaluate names it, wrap_up keeps it.
  const setup = { print: false };
  const reader = 'item-count-text';
  await call(
    'browser.evaluate',
    { tab_id: T, expression: "document.querySelector('#count').textContent", as: reader },
    undefined,
    setup,
  );
  const report = await call('browser.wrap_up', {}, undefined, setup);
  const id = findReaderId(json(report), reader);
  if (id === undefined) throw new StepFailure('read', 'wrap_up did not offer the reader');
  await call('browser.wrap_up', { readers: { keep: [{ id, name: reader }] } }, undefined, setup);
  await call(
    'browser.read',
    { tab_id: T, name: reader },
    (_b, t) => t.includes('Items: 2') || `unexpected: ${t.slice(0, 100)}`,
  );
  // The press's submit hid #done and reveals it 300 ms later (index.html).
  // Left pending, that reveal lands either before the flow or inside its
  // first step's settle window, depending on how long the calls above took,
  // and the step that counts the mutation varies from run to run. One
  // wait_for call (not a polled evaluate: pending_wrap_up stays fixed) lets
  // it land before the flow starts.
  await call(
    'browser.wait_for',
    { tab_id: T, selector: '#done', condition: 'visible', timeout_ms: 5000 },
    (b) => b?.matched === true || 'not matched',
    setup,
  );
  await call(
    'browser.flow',
    {
      tab_id: T,
      steps: [
        { type: { selector: '#name', text: 'gamma', clear: true } },
        { find: { text: 'Add item', role: 'button' } },
        { click: { expect: { text_appears: 'Items: 3' } } },
        { wait_for: { selector: '#done', condition: 'visible' } },
      ],
    },
    (_b, t) => !/"ok":\s*false/.test(t) || 'a step failed',
  );

  await errorPaths(T);
  await ruleChecks(T);
  // Right after the rule checks left the page scrolled: where a miss was
  // seen. Recorded, not thrown, so the steps below still run; it fails the run.
  for (const step of [clickAfterScroll, clickFrameElement, clickOpensDialog]) {
    try {
      await step(T);
    } catch (e) {
      if (!(e instanceof StepFailure)) throw e;
      console.log(`e2e: FAIL ${errorText(e)}`);
      deferredFailures.push(e.step);
    }
  }
  // The download steps start scrolled to the bottom, away from #dl: the
  // selector capture must scroll its target into view and still land on it.
  await scrollToBottom(T);

  await downloadChecks({
    T,
    origin: new URL(page).origin,
    downloadsDir: join(dataDir, 'downloads'),
    cdp,
    swSession,
  });
  await recorded(() => downloadStressAfterScroll(T, join(dataDir, 'downloads')));

  await pageReadAndCapture(T, page);

  await dragPermissionTabsFlows(T, page, cdp);

  await recorded(() => recordingChecks(cdp, extId, swSession, page));

  await windowChecks(cdp, extId);

  if (ADAPTER_COVERAGE) {
    const contract = await inWorkerContract(cdp, swSession, extDir);
    await adapterCoverage(cdp, swSession, extDir, extId, contract);
  }

  // Since 1.0.0 the bridge accepts only an Origin exactly equal to
  // chrome-extension://<pinned id> (or a configured id; none here), so the
  // connected tab and the nine calls above prove that this browser's
  // service-worker socket announced the pinned Origin.
  console.log(
    `bridge.origin ok ${String(version.Browser)} announced chrome-extension://${extId} and the bridge accepted it (exact Origin enforced)`,
  );

  await languageChecks(cdp, extId);

  // A second extension (another id) tries to connect and must be refused.
  const keylessId =
    loadedKeylessId ?? (await cdp.send('Extensions.loadUnpacked', { path: keylessDir })).id;
  await refusedExtension(cdp, swSession, page, keylessId);

  await cdpDirectChecks({ chromePath, serverEnv, page });
}

/**
 * Flow recording by demonstration (slice 20), on a tab of its own: the
 * popup's own messages (`startRecording`, `recordingStatus`, `stopRecording`,
 * `discardRecording`) over a tab connected for the purpose. A real click is
 * captured, a real navigation adds its `wait_for` step and re-installs the
 * recorder, Stop keeps both steps for review, Discard clears them, and
 * turning the setting off during a recording discards it at once. No tool
 * call is made, so the run's record is untouched; the worker's adapter for
 * tab events is reached here (R6 condition 1).
 */
async function recordingChecks(cdp, extId, swSession, page) {
  const t = now();
  const url = new URL(`interact.html?rec=${String(Date.now())}`, page).href;
  const { targetId } = await cdp.send('Target.createTarget', { url });
  const { sessionId: tabSession } = await cdp.send('Target.attachToTarget', {
    targetId,
    flatten: true,
  });
  await evaluateUntil(cdp, `document.readyState === 'complete'`, tabSession, 15_000);
  const tabId = await evaluateUntil(
    cdp,
    `chrome.tabs.query({}).then(ts => (ts.find(t => t.url === ${jsLiteral(url)} && t.status === 'complete') || {}).id ?? null)`,
    swSession,
    15_000,
  );
  const popup = await openPage(cdp, extId, 'popup.html');
  const ask = (message) =>
    cdp.evaluate(
      `chrome.runtime.sendMessage(${jsLiteral({ ...message, tabId })})`,
      popup.sessionId,
    );
  const statusIs = (what, want) =>
    evaluateUntil(
      cdp,
      `chrome.runtime.sendMessage(${jsLiteral({ action: 'recordingStatus', tabId })}).then((s) => (${want}) ? s : null)`,
      popup.sessionId,
      10_000,
    ).catch(() => {
      throw new StepFailure('recording', `the recording never reached: ${what}`);
    });
  const setting = (on) =>
    cdp.evaluate(
      `chrome.storage.local.set({ flowRecordingEnabled: ${String(on)} })`,
      popup.sessionId,
    );
  try {
    // The tab may already be connecting by itself (a tab Chrome opens is picked
    // up by the extension); either way it ends up connected.
    await ask({ action: 'connect' });
    await evaluateUntil(
      cdp,
      `chrome.runtime.sendMessage(${jsLiteral({ action: 'status', tabId })}).then((s) => s.connected)`,
      popup.sessionId,
      15_000,
    );

    // The setting is off by default: Record is refused until it is turned on.
    const refused = await ask({ action: 'startRecording' });
    if (refused?.ok !== false || refused.code !== 'recording-disabled') {
      throw new StepFailure('recording', `start with the setting off: ${JSON.stringify(refused)}`);
    }
    await setting(true);
    let started;
    for (let i = 0; i < 50 && !started?.ok; i++) {
      started = await ask({ action: 'startRecording' });
      if (!started.ok) await sleep(100);
    }
    if (!started?.ok) throw new StepFailure('recording', `start: ${JSON.stringify(started)}`);
    const again = await ask({ action: 'startRecording' });
    if (again?.code !== 'recording-in-progress') {
      throw new StepFailure('recording', `a second start: ${JSON.stringify(again)}`);
    }

    // A real (trusted) click on #tick is captured as one step.
    const at = await cdp.evaluate(
      `(() => { const r = document.querySelector('#tick').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
      tabSession,
    );
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send(
        'Input.dispatchMouseEvent',
        { type, x: at.x, y: at.y, button: 'left', clickCount: 1 },
        tabSession,
      );
    }
    await statusIs('one captured step', 's.active && s.stepCount === 1');

    // A navigation adds its wait_for step; the recorder is installed again.
    await cdp.send('Page.navigate', { url: new URL('opened.html', page).href }, tabSession);
    await statusIs('a navigation step', 's.active && s.stepCount === 2');

    const stopped = await ask({ action: 'stopRecording' });
    const want = [
      { click: { selector: '#tick' } },
      { wait_for: { expression: "document.readyState === 'complete'" } },
    ];
    if (JSON.stringify(stopped) !== JSON.stringify({ ok: true, steps: want, capped: false })) {
      throw new StepFailure('recording', `stop answered ${JSON.stringify(stopped)}`);
    }
    const review = await statusIs('review', 's.reviewing && !s.active');
    if (review.stepCount !== 2 || JSON.stringify(review.steps) !== JSON.stringify(want)) {
      throw new StepFailure('recording', `review shows ${JSON.stringify(review)}`);
    }
    const discarded = await ask({ action: 'discardRecording' });
    if (!discarded?.ok) throw new StepFailure('recording', `discard: ${JSON.stringify(discarded)}`);
    await statusIs('nothing left after Discard', '!s.active && !s.reviewing && s.stepCount === 0');

    // Turning the setting off WHILE recording discards the recording at once.
    const second = await ask({ action: 'startRecording' });
    if (!second?.ok) throw new StepFailure('recording', `second start: ${JSON.stringify(second)}`);
    await statusIs('an active second recording', 's.active');
    await setting(false);
    await statusIs('nothing left after the setting went off', '!s.active && !s.reviewing');
  } finally {
    await cdp
      .evaluate(`chrome.storage.local.remove('flowRecordingEnabled')`, popup.sessionId)
      .catch(() => undefined);
    await ask({ action: 'disconnect' }).catch(() => undefined);
    await cdp.send('Target.closeTarget', { targetId: popup.targetId }).catch(() => undefined);
    await cdp.send('Target.closeTarget', { targetId }).catch(() => undefined);
  }
  stepDone('recording', t);
}

/**
 * The Activity and Admin windows (slice 21), through the popup's own messages
 * (`openActivityWindow`, `openAdminWindow`): each opens its page in a popup
 * window, a second ask focuses that same window instead of opening another,
 * and once it is closed the next ask opens a fresh one. No tool call is made,
 * so the run's record is untouched; the worker's `Windows` adapter and
 * `Runtime.pageUrl` are reached here (R6 condition 1).
 */
async function windowChecks(cdp, extId) {
  const t = now();
  const popup = await openPage(cdp, extId, 'popup.html');
  const ask = (action) =>
    cdp.evaluate(`chrome.runtime.sendMessage(${jsLiteral({ action })})`, popup.sessionId);
  const close = (windowId) =>
    cdp.evaluate(`chrome.windows.remove(${String(windowId)})`, popup.sessionId);
  const opened = [];
  try {
    for (const [action, page] of [
      ['openActivityWindow', 'activity.html'],
      ['openAdminWindow', 'admin.html'],
    ]) {
      const first = await ask(action);
      if (first?.ok !== true || !(first.windowId > 0)) {
        throw new StepFailure('windows', `${action}: ${JSON.stringify(first)}`);
      }
      opened.push(first.windowId);
      const shows = await cdp.evaluate(
        `chrome.windows.get(${String(first.windowId)}, { populate: true }).then((w) => w.type + ' ' + (w.tabs?.[0]?.pendingUrl || w.tabs?.[0]?.url || ''))`,
        popup.sessionId,
      );
      if (shows !== `popup chrome-extension://${extId}/${page}`) {
        throw new StepFailure('windows', `${action} opened ${String(shows)}`);
      }
      const again = await ask(action);
      if (again?.windowId !== first.windowId) {
        throw new StepFailure('windows', `${action} again: ${JSON.stringify(again)}, not focus`);
      }
      await close(first.windowId);
      const fresh = await ask(action);
      if (!(fresh?.windowId > 0) || fresh.windowId === first.windowId) {
        throw new StepFailure('windows', `${action} after close: ${JSON.stringify(fresh)}`);
      }
      opened.push(fresh.windowId);
    }
  } finally {
    for (const windowId of opened) await close(windowId).catch(() => undefined);
    await cdp.send('Target.closeTarget', { targetId: popup.targetId }).catch(() => undefined);
  }
  stepDone('windows', t);
}

/**
 * cdp-direct, the second transport (cdp-direct.mjs): a second headless Chrome
 * without the extension, on its own free debugging port; the built CLI enables
 * cdp-direct on that port and records a grant in the run's isolated data dir
 * while the server runs (the gate reads both on every call); then the same
 * server drives the Chrome's tab directly. One case per tool the arch spec
 * names, each asserting its effect, and the click-on-a-missing-selector error
 * with its exact text (the extension's error.action answers the same).
 */
async function cdpDirectChecks({ chromePath, serverEnv, page }) {
  const t0 = now();
  const port = await freePort();
  record.context.ports.push(port);
  state.cdpChrome = launchChrome({ chromePath, port });
  temps.push(state.cdpChrome.profile);
  const version = await waitHttp(`http://127.0.0.1:${String(port)}/json/version`, 20_000);
  state.cdpChromeCdp = await Cdp.open(version.webSocketDebuggerUrl);
  try {
    enableCdpDirect({ serverCli: SERVER_CLI, env: serverEnv, port });
  } catch (e) {
    throw new StepFailure('cdp.enable', errorText(e));
  }

  // The Chrome's one page (about:blank) is listed as a cdp: tab.
  const tl = now();
  let tab;
  while (!tab) {
    const r = await call('browser.list_tabs', {}, undefined, {
      print: false,
      poll: true,
      label: 'browser.list_tabs.cdp',
    });
    tab = cdpTabOf(json(r));
    if (!tab && now() - tl > CALL_TIMEOUT_MS) {
      throw new StepFailure('list_tabs.cdp', 'no cdp: tab listed after enable and grant');
    }
    if (!tab) await sleep(100);
  }
  const C = tab.tab_id;
  const target = `${page}?cdp`;

  await call(
    'browser.navigate',
    { tab_id: C, url: target },
    (b) => b?.url === target || `landed on ${JSON.stringify(b?.url)}`,
    { label: 'browser.navigate.cdp' },
  );
  await call(
    'browser.snapshot',
    { tab_id: C },
    (_b, t) => t.includes('Add item') || 'snapshot lacks the Add item button',
    { label: 'browser.snapshot.cdp' },
  );
  const found = await call(
    'browser.find',
    { tab_id: C, text: 'Add item', role: 'button' },
    (_b, t) => refOf(t) !== undefined || 'no ref returned',
    { label: 'browser.find.cdp' },
  );
  const ref = refOf(text(found));
  await call(
    'browser.type',
    { tab_id: C, selector: '#name', text: 'delta' },
    (b) => b?.sensitive_field === false || `sensitive_field is ${String(b?.sensitive_field)}`,
    { label: 'browser.type.cdp' },
  );
  // The typed text is in the field (the click below also submits it).
  // A string value comes back as the text itself.
  await call(
    'browser.evaluate',
    { tab_id: C, expression: "document.querySelector('#name').value" },
    (_b, t) => t === 'delta' || `#name holds ${JSON.stringify(t)}`,
    { label: 'browser.evaluate.value.cdp' },
  );
  await call(
    'browser.click',
    { tab_id: C, ref, expect: { text_appears: 'Added: delta' } },
    (_b, t) => /"met":\s*true/.test(t) || 'expect not met',
    { label: 'browser.click.cdp' },
  );
  await call(
    'browser.evaluate',
    { tab_id: C, expression: "document.querySelector('#count').textContent" },
    (_b, t) => t === 'Items: 1' || `#count is ${JSON.stringify(t)}`,
    { label: 'browser.evaluate.cdp' },
  );

  // An error case: the call must fail with exactly `want`.
  const expectCdpError = async (label, tool, args, want) => {
    const t = now();
    const r = await attempt(tool, args, label);
    if (!r.isError || r.text !== want) {
      throw new StepFailure(
        label,
        `expected isError with exactly ${JSON.stringify(want)}; isError=${String(r.isError)} answer: ${JSON.stringify(r.text.slice(0, 400))}`,
      );
    }
    stepDone(label, t);
  };

  // The error path: a click whose selector matches nothing.
  await expectCdpError(
    'error.action.cdp',
    'browser.click',
    { tab_id: C, selector: '#e2e-no-such-element' },
    'Error: Element not found: #e2e-no-such-element',
  );

  // wait_for in network_url mode is refused on cdp-direct (no capture buffers):
  // an action failure with the core's exact sentence, not a timeout.
  await expectCdpError(
    'error.wait-for-network.cdp',
    'browser.wait_for',
    { tab_id: C, network_url: '/api', timeout_ms: 300 },
    'Error: wait_for: network_url mode is not supported over cdp-direct in v1 (no network buffering) — use a tab connected through the Chrome extension instead.',
  );

  // The sensitive path on cdp-direct: the type into the password field reads
  // the focused field first, then its failing expectation is tagged
  // `sensitive`; the error is the executor's text, and the trail stores the
  // marker, never the typed text (the extension's error.sensitive, same text).
  await expectCdpError(
    'error.sensitive.cdp',
    'browser.type',
    {
      tab_id: C,
      selector: '#pw',
      text: 'e2e-secret-cdp',
      clear: true,
      settle_ms: 0,
      expect: { selector_appears: '#pw' },
    },
    'Error: expectation not met: selector_appears "#pw" was already present before the action',
  );
  await call(
    'browser.activity',
    { tool: 'browser.type', limit: 1 },
    (b, tx) =>
      (b?.records?.[0]?.payload === '[sensitive field]' && !tx.includes('e2e-secret-cdp')) ||
      `stored payload is ${JSON.stringify(b?.records?.[0]?.payload)}`,
    { label: 'browser.activity.error-sensitive.cdp' },
  );
  console.log(`cdp-direct ok${String(Math.round(now() - t0))} (all cases, Chrome start included)`);
}

/**
 * The in-worker contract run (design section 8, R6, primary path): the
 * adapters' contracts, bundled from the same sources with the same esbuild
 * options as background.js (checked on the embedded sources), evaluated in
 * the extension's service worker while coverage runs. First a teardown probe
 * (every case that creates a window, a tab, a page or a storage key fails on
 * purpose right after creating it), then the real run; after each, the
 * browser must hold exactly the tabs, windows and contract keys it held
 * before. Returns the evaluated text, which the coverage step maps like the
 * shipped bundle.
 */
async function inWorkerContract(cdp, swSession, extDir) {
  const t = now();
  const dir = mkdtempSync(join(tmpdir(), 'bl-e2e-contract-'));
  temps.push(dir);
  const { script, map } = await buildContract(dir);
  const mismatches = adapterSourceMismatches(
    JSON.parse(readFileSync(join(extDir, 'background.js.map'), 'utf8')),
    JSON.parse(readFileSync(map, 'utf8')),
  );
  if (mismatches.length > 0) throw new StepFailure('contract.sources', mismatches.join('; '));
  const bundle = `${readFileSync(script, 'utf8')}
//# sourceURL=${CONTRACT_SOURCE_URL}
`;
  const loaded = await cdp.send('Runtime.evaluate', { expression: bundle }, swSession);
  if (loaded.exceptionDetails) {
    throw new StepFailure('contract.load', loaded.exceptionDetails.text);
  }
  const run = (options) => {
    let timer;
    return Promise.race([
      cdp.evaluate(`globalThis.browserLinkContract(${jsLiteral(options)})`, swSession),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new StepFailure('contract.in-worker', `no answer in ${String(CONTRACT_TIMEOUT_MS)} ms`),
          );
        }, CONTRACT_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(timer));
  };
  // What the browser holds that a contract case may create: every tab, every
  // window, and the contract's storage keys.
  const held = `Promise.all([chrome.tabs.query({}), chrome.windows.getAll(), chrome.storage.local.get(null)]).then(([tabs, windows, stored]) => JSON.stringify({ tabs: tabs.map((x) => x.id).sort(), windows: windows.map((x) => x.id).sort(), keys: Object.keys(stored).filter((k) => k.startsWith('browser-link-contract:')) }))`;
  const leftNothing = async (step, before) => {
    try {
      await evaluateUntil(
        cdp,
        `${held}.then((now) => now === ${jsLiteral(before)})`,
        swSession,
        5_000,
      );
    } catch {
      const after = await cdp.evaluate(held, swSession);
      throw new StepFailure(step, `left behind: before ${before}, after ${after}`);
    }
  };

  // Teardown probe: each case that creates a window, a tab, a page or a key
  // fails on purpose right after creating it; the browser must hold exactly
  // what it held before.
  const beforeProbe = await cdp.evaluate(held, swSession);
  const probed = await run({ probe: true });
  const unforced = probed.filter((r) => r.ok || !String(r.error).includes('forced failure'));
  if (probed.length === 0 || unforced.length > 0) {
    throw new StepFailure(
      'contract.teardown',
      JSON.stringify(unforced.length > 0 ? unforced : probed),
    );
  }
  await leftNothing('contract.teardown', beforeProbe);
  console.log(
    `contract.teardown ok ${String(probed.length)} failing cases left no tab, window or key behind`,
  );

  const before = await cdp.evaluate(held, swSession);
  const results = await run({});
  const failed = results.filter((r) => !r.ok);
  if (results.length === 0 || failed.length > 0) {
    const list = failed.map((r) => `${r.name}: ${r.error}`).join('; ');
    throw new StepFailure('contract.in-worker', list || 'no contract case ran');
  }
  await leftNothing('contract.in-worker', before);
  const cases = results.map((r) => `${r.name} (${String(r.ms)} ms)`).join(', ');
  console.log(`contract.in-worker ok ${String(Math.round(now() - t))} ms: ${cases}`);
  return bundle;
}

/**
 * R6 condition 1: every function of every extension adapter was called by
 * the run so far, or by the in-worker contract run (V8 coverage of the
 * worker, adapter-coverage.mjs). A function with zero calls fails the run,
 * naming it.
 */
async function adapterCoverage(cdp, swSession, extDir, extId, contractBundle) {
  const { result } = await cdp.send('Profiler.takePreciseCoverage', {}, swSession);
  await cdp.send('Profiler.stopPreciseCoverage', {}, swSession);
  const url = `chrome-extension://${extId}/background.js`;
  const script = result.find((entry) => entry.url === url);
  if (!script) throw new StepFailure('adapter.coverage', `no coverage for ${url}`);
  const contractScript = result.find((entry) => entry.url === CONTRACT_SOURCE_URL);
  if (!contractScript) {
    throw new StepFailure('adapter.coverage', `no coverage for ${CONTRACT_SOURCE_URL}`);
  }
  const contract = { bundle: contractBundle, functions: contractScript.functions };
  const bundle = readFileSync(join(extDir, 'background.js'), 'utf8');
  const uncalled = uncalledAdapterFunctions(bundle, script.functions, contract);
  if (uncalled.length > 0) {
    const list = uncalled.map((u) => `${u.file}:${String(u.line)} ${u.name}`).join(', ');
    throw new StepFailure('adapter.coverage', `adapter functions never called: ${list}`);
  }
  const summary = adapterCoverageSummary(bundle, script.functions, contract);
  console.log(`adapter.coverage ok ${summary.join(', ')}`);
}

/**
 * A click whose target must first be scrolled into view must land on it.
 * Scrolled to the bottom, then #add (top of the page) is clicked five times
 * without `expect`: each ok:true result without `hit_element` claims the
 * click hit #add, so each must add one item.
 */
/**
 * A click on a frame element itself (here the cross-origin iframe): the
 * press is delivered into the child document, where the hit check cannot
 * see it, so the click must not fail and must say it was not verified.
 */
async function clickFrameElement(T) {
  const label = 'browser.click.frame-element';
  const t = now();
  const r = await attempt(
    'browser.click',
    { tab_id: T, selector: '#cross-frame', settle_ms: 0 },
    label,
  );
  if (r.isError || r.body?.hit_check !== 'not_verifiable' || !r.body?.hit_check_note) {
    throw new StepFailure('click.frame-element', `answer: ${r.text.slice(0, 400)}`);
  }
  stepDone(label, t);
}

/**
 * A click that opens a native alert: the page thread freezes until the
 * dialog is answered. The click must answer anyway, without failing, and
 * say a dialog opened; the dialog is closed afterwards in every case.
 */
async function clickOpensDialog(T) {
  const label = 'browser.click.opens-dialog';
  const t = now();
  const pending = attempt(
    'browser.click',
    { tab_id: T, selector: '#alert-btn', settle_ms: 0 },
    label,
  ).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  const early = await Promise.race([pending, sleep(8000).then(() => null)]);
  const closed = await attempt('browser.dialog_respond', { tab_id: T, accept: true }, label);
  const answer = early ?? (await Promise.race([pending, sleep(10_000).then(() => null)]));
  const dialog = `dialog_respond: ${closed.text.slice(0, 200)}`;
  if (early === null) {
    throw new StepFailure(
      'click.opens-dialog',
      `the click did not answer within 8 s while the alert was open; after closing it: ${answer ? (answer.error?.message ?? answer.value.text.slice(0, 300)) : 'still no answer'}; ${dialog}`,
    );
  }
  if (answer.error) throw answer.error;
  const r = answer.value;
  if (
    r.isError ||
    r.body?.hit_check !== 'not_verifiable' ||
    !/dialog/i.test(String(r.body?.hit_check_note)) ||
    closed.isError
  ) {
    throw new StepFailure('click.opens-dialog', `answer: ${r.text.slice(0, 400)}; ${dialog}`);
  }
  stepDone(label, t);
}

async function clickAfterScroll(T) {
  const label = 'browser.click.after-scroll';
  const t = now();
  const count = "document.querySelector('#items').children.length";
  const misses = [];
  for (let i = 1; i <= 5; i++) {
    await scrollToBottom(T);
    const before = await pageValue(T, count);
    const r = await attempt('browser.click', { tab_id: T, selector: '#add', settle_ms: 0 }, label);
    const after = await pageValue(T, count);
    if (r.isError || r.body?.hit_element) {
      misses.push(`try ${String(i)}: ${r.text.slice(0, 200)}`);
    } else if (after !== before + 1) {
      misses.push(
        `try ${String(i)}: answered ${JSON.stringify(r.body)} but items went ${String(before)} -> ${String(after)}`,
      );
    }
  }
  if (misses.length) {
    throw new StepFailure(
      'click.after-scroll',
      `${String(misses.length)} of 5 clicks reported as done did not reach #add: ${misses.join(' | ')}`,
    );
  }
  stepDone(label, t);
}

/**
 * The press must never be delivered to something other than the target.
 * Scrolled to the bottom, the cross-origin frame is drawn where #dl lands
 * once the click scrolls it into view, and Chrome can still route the mouse
 * by the frame drawn before that scroll, into the foreign frame. It showed
 * after a click that opened an alert (the download step follows one): each
 * of the thirty tries opens and closes the alert, scrolls to the bottom,
 * then `browser.download` on #dl must save the file (before the press waited
 * for a move seen on the target, 2 and 6 of 30 failed). Prints the median
 * call time.
 */
async function downloadStressAfterScroll(T, downloadsDir) {
  const label = 'browser.download.stress-after-scroll';
  const t = now();
  const TRIES = 30;
  const misses = [];
  const times = [];
  for (let i = 1; i <= TRIES; i++) {
    // What the download step follows: a click that opened an alert, closed.
    await attempt('browser.click', { tab_id: T, selector: '#alert-btn', settle_ms: 0 }, label);
    await attempt('browser.dialog_respond', { tab_id: T, accept: true }, label);
    await scrollToBottom(T);
    const c = now();
    const r = await attempt(
      'browser.download',
      { tab_id: T, selector: '#dl', timeout_ms: 10_000 },
      label,
    );
    times.push(now() - c);
    if (r.isError || !insideDir(r.body?.path, downloadsDir)) {
      misses.push(`try ${String(i)}: ${r.text.slice(0, 300)}`);
    }
  }
  times.sort((a, b) => a - b);
  const median = Math.round(times[Math.floor(times.length / 2)]);
  console.log(`${label} median ${String(median)} ms over ${String(TRIES)}`);
  if (misses.length) {
    throw new StepFailure(
      'download.stress-after-scroll',
      `${String(misses.length)} of ${String(TRIES)} downloads failed: ${misses.join(' | ')}`,
    );
  }
  stepDone(label, t);
}

/** A page value read through browser.evaluate (setup, not a checked step). */
/** Poll a quiet call (not printed, never forced to fail) until `ready(body)`. */
async function pollUntil(tool, args, ready, label, timeoutMs = 5_000) {
  const t0 = now();
  for (;;) {
    const body = json(await call(tool, args, undefined, { print: false, poll: true }));
    if (ready(body)) return body;
    if (now() - t0 > timeoutMs) {
      throw new StepFailure(
        label,
        `not ready after ${String(timeoutMs)} ms: ${JSON.stringify(body)?.slice(0, 300)}`,
      );
    }
    await sleep(100);
  }
}

/** The PNG an image result carries: from the MCP image block when there is
 * one (browser.screenshot), else from `image_b64` (canvas_screenshot). */
function pngOf(b, res) {
  const block = res?.content?.find((c) => c.type === 'image');
  const b64 = block ? block.data : b?.image_b64;
  if (typeof b64 !== 'string' || b64.length === 0) return { error: 'no image data' };
  const bytes = Buffer.from(b64, 'base64');
  try {
    return { img: decodePng(bytes), bytes, mimeType: block?.mimeType };
  } catch (e) {
    return { error: `image does not decode: ${errorText(e)}` };
  }
}

const RED = [255, 0, 0];
const BLUE = [0, 0, 255];

/**
 * Page read and capture: the tab navigates to capture.html (a canvas with a
 * red left half and a blue right half, an open dialog, three console lines
 * and one fetch with a known body), and each tool is asserted on what it
 * promises there. Every case fails under E2E_EXPECT_FAIL=<tool>.
 */
async function pageReadAndCapture(T, page) {
  const target = new URL(`capture.html?n=${String(Date.now())}`, page).href;
  const title = 'e2e capture page';
  const describe = (b) => JSON.stringify(b)?.slice(0, 300);

  // navigate: lands on the URL, waits for load, and the document is new
  // (a mark left on the old one is gone). A failed call is recorded, not
  // thrown: the tab may still have loaded the page, which ping then proves.
  await pageValue(T, '(window.__e2eOldDocument = true)');
  await recorded(() =>
    call(
      'browser.navigate',
      { tab_id: T, url: target },
      (b) => (b?.url === target && b?.title === title) || `landed on ${describe(b)}`,
    ),
  );
  const mark = await pageValue(T, 'window.__e2eOldDocument === true');
  if (mark !== false) {
    throw new StepFailure('navigate', `the old document survived (mark ${String(mark)})`);
  }

  await call(
    'browser.ping',
    { tab_id: T },
    (b) => (b?.url === target && b?.title === title) || `ping says ${describe(b)}`,
  );

  // state: where the tab is, its viewport, and the open <dialog> by its label.
  await call('browser.state', { tab_id: T }, (b) => {
    if (b?.url !== target || b?.title !== title) return `url/title ${describe(b)}`;
    const { w, h } = b.viewport ?? {};
    if (!(Number.isInteger(w) && w > 0 && Number.isInteger(h) && h > 0)) {
      return `viewport ${describe(b.viewport)}`;
    }
    const dialog = (b.dialogs ?? []).find((d) => d.label === 'e2e note');
    return dialog?.role === 'dialog' || `dialogs ${describe(b.dialogs)}`;
  });

  // canvas_screenshot: the backing store as drawn, and a crop of its right half.
  await call('browser.canvas_screenshot', { tab_id: T }, (b, _t, res) => {
    if (b?.ok !== true || b.format !== 'png') return `result ${describe(b)}`;
    if (b.canvas_pixels?.w !== 64 || b.canvas_pixels?.h !== 32) {
      return `canvas_pixels ${describe(b.canvas_pixels)}`;
    }
    if (b.canvas_size?.w !== 128 || b.canvas_size?.h !== 64) {
      return `canvas_size ${describe(b.canvas_size)}`;
    }
    const { img, error } = pngOf(b, res);
    if (error) return error;
    if (img.width !== 64 || img.height !== 32) return `image is ${img.width}x${img.height}`;
    const [left, right] = [img.pixel(8, 16), img.pixel(56, 16)];
    return (
      (colorNear(left, RED) && colorNear(right, BLUE)) ||
      `left ${left.join(',')} / right ${right.join(',')}, expected red / blue`
    );
  });
  await call(
    'browser.canvas_screenshot',
    { tab_id: T, region: { x: 32, y: 0, w: 32, h: 32 } },
    (b, _t, res) => {
      const r = b?.region;
      if (r?.x !== 32 || r?.y !== 0 || r?.w !== 32 || r?.h !== 32) return `region ${describe(r)}`;
      const { img, error } = pngOf(b, res);
      if (error) return error;
      if (img.width !== 32 || img.height !== 32) return `crop is ${img.width}x${img.height}`;
      const corners = [img.pixel(0, 0), img.pixel(31, 31)];
      return corners.every((p) => colorNear(p, BLUE)) || `crop corners ${describe(corners)}`;
    },
    { label: 'browser.canvas_screenshot.region' },
  );

  // screenshot: a real PNG image block whose size matches the metadata, and
  // the page as painted (the canvas at 128x64 CSS px, red | blue).
  let dpr = 1;
  await call(
    'browser.screenshot',
    { tab_id: T, mode: 'element', selector: '#pic' },
    (b, _t, res) => {
      const { img, bytes, mimeType, error } = pngOf(b, res);
      if (error) return error;
      if (mimeType !== 'image/png' || b?.format !== 'png' || b?.mode !== 'element') {
        return `mime ${String(mimeType)}, meta ${describe(b)}`;
      }
      if (img.width !== b.width || img.height !== b.height || bytes.length !== b.bytes) {
        return `image ${img.width}x${img.height} ${bytes.length} B, meta ${describe(b)}`;
      }
      dpr = img.width / 128;
      if (!(dpr >= 1) || img.height !== 64 * dpr) return `element image ${img.width}x${img.height}`;
      const [left, right] = [img.pixel(32 * dpr, 32 * dpr), img.pixel(96 * dpr, 32 * dpr)];
      return (
        (colorNear(left, RED) && colorNear(right, BLUE)) ||
        `left ${left.join(',')} / right ${right.join(',')}, expected red / blue`
      );
    },
  );
  await call(
    'browser.screenshot',
    { tab_id: T },
    (b, _t, res) => {
      const { img, bytes, error } = pngOf(b, res);
      if (error) return error;
      if (b?.mode !== 'viewport' || img.width !== b.width || img.height !== b.height) {
        return `image ${img.width}x${img.height}, meta ${describe(b)}`;
      }
      if (bytes.length !== b.bytes || img.width < 200 || img.height < 100) {
        return `implausible viewport image ${img.width}x${img.height} ${bytes.length} B`;
      }
      const p = img.pixel(32 * dpr, 16 * dpr);
      return colorNear(p, RED) || `top-left of the canvas is ${p.join(',')}, expected red`;
    },
    { label: 'browser.screenshot.viewport' },
  );

  // console: the page's own lines, with level and text as logged.
  const marker = 'e2e-console-marker 42';
  await pollUntil(
    'browser.console',
    { tab_id: T },
    (b) => Array.isArray(b) && b.some((e) => e.text === marker),
    'console',
  );
  await call('browser.console', { tab_id: T }, (b) => {
    const e = Array.isArray(b) ? b.find((x) => x.text === marker) : undefined;
    return (e?.level === 'log' && e?.source === 'console') || `no log entry ${describe(e ?? b)}`;
  });
  await call(
    'browser.console',
    { tab_id: T, level: 'error' },
    (b) =>
      (Array.isArray(b) &&
        b.every((e) => e.level === 'error') &&
        b.some((e) => e.text === 'e2e-console-error')) ||
      `level error gave ${describe(b)}`,
    { label: 'browser.console.error' },
  );

  // network: the page's fetch, finished, with method, status and type; then
  // network_body returns exactly what the server sent.
  const dataUrl = new URL(`data.json${new URL(target).search}`, page).href;
  const filter = { tab_id: T, url_filter: `data.json${new URL(target).search}` };
  const isData = (e) => e.url === dataUrl && typeof e.finished_at === 'number';
  await pollUntil('browser.network', filter, (b) => Array.isArray(b) && b.some(isData), 'network');
  const listed = await call('browser.network', filter, (b) => {
    const e = b.find(isData);
    if (!b.every((x) => x.url.includes('data.json'))) return `url_filter let in ${describe(b)}`;
    return (
      (e.method === 'GET' &&
        e.status === 200 &&
        e.mime_type === 'application/json' &&
        typeof e.request_id === 'string') ||
      `entry ${describe(e)}`
    );
  });
  const requestId = json(listed).find(isData).request_id;
  await call(
    'browser.network_body',
    { tab_id: T, request_id: requestId },
    (b) =>
      (b?.body === DATA_BODY && b?.base64Encoded === false) ||
      `body ${describe(b)}, expected ${DATA_BODY}`,
  );

  // wait_for in network_url mode: the page fetches a URL nobody has fetched
  // yet (one setup evaluate schedules it 300 ms out, so the wait starts first,
  // and no evaluate is polled), and the wait ends when that finished request's
  // URL contains the needle.
  const needle = 'e2e-wait-net';
  await pageValue(
    T,
    `setTimeout(() => { fetch('/data.json?${needle}=1', { cache: 'no-store' }); }, 300); 'scheduled'`,
  );
  await call(
    'browser.wait_for',
    { tab_id: T, network_url: needle, timeout_ms: 5000 },
    (b) => b?.matched === true || `network_url wait answered ${describe(b)}`,
    { label: 'browser.wait_for.network' },
  );

  // console level "warn" (the value the tool's enum offers) must return the
  // page's console.warn line. Recorded, not thrown: the steps after it still run.
  const all = json(await call('browser.console', { tab_id: T }, undefined, { print: false }));
  const stored = Array.isArray(all) ? all.find((e) => e.text === 'e2e-console-warn') : undefined;
  await recorded(() =>
    call(
      'browser.console',
      { tab_id: T, level: 'warn' },
      (b) =>
        (Array.isArray(b) && b.some((e) => e.text === 'e2e-console-warn')) ||
        `level warn gave ${describe(b)}; the line is stored as ${describe(stored)}`,
      { label: 'browser.console.warn' },
    ),
  );
}

/**
 * Drag, permission, tabs and flow control: the tab navigates to
 * interact.html (an HTML5 draggable card and its drop zone, a button that
 * opens a new tab, a counter a flow clicks up) and each tool is asserted on
 * the effect it promises in the page. Every case fails under
 * E2E_EXPECT_FAIL=<tool>.
 */
async function dragPermissionTabsFlows(T, page, cdp) {
  const nonce = `?n=${String(Date.now())}`;
  const target = new URL(`interact.html${nonce}`, page).href;
  const describe = (b) => JSON.stringify(b)?.slice(0, 300);
  const quiet = { print: false };
  await call(
    'browser.navigate',
    { tab_id: T, url: target },
    (b) => b?.url === target || `landed on ${describe(b)}`,
    quiet,
  );

  // drag: an HTML5 drag of #card onto #zone; the page's drop handler reads
  // the text the dragstart put in the dataTransfer.
  let t = now();
  await call(
    'browser.drag',
    { tab_id: T, from_selector: '#card', to_selector: '#zone', duration_ms: 300 },
    (b) =>
      (b?.drag_mode === 'html5' && b.from?.selector === '#card' && b.to?.selector === '#zone') ||
      `result ${describe(b)}`,
    quiet,
  );
  // A string comes back from evaluate as raw text: JSON-encode it to read it.
  const dropped = await pageValue(
    T,
    "JSON.stringify(document.querySelector('#dropped').textContent)",
  );
  if (dropped !== 'dropped: e2e-card') {
    throw new StepFailure('drag', `the page shows ${JSON.stringify(dropped)}, expected a drop`);
  }
  stepDone('browser.drag', t);

  // set_permission: the state the page reads through navigator.permissions
  // follows each call (granted, denied, then back to prompt), for its origin.
  t = now();
  const origin = new URL(page).origin;
  const geolocation = () =>
    pageValue(
      T,
      "navigator.permissions.query({ name: 'geolocation' }).then((s) => JSON.stringify(s.state))",
    );
  const before = await geolocation();
  const read = [];
  for (const state_ of ['granted', 'denied', 'prompt']) {
    await call(
      'browser.set_permission',
      { tab_id: T, origin, name: 'geolocation', state: state_ },
      (b) =>
        (b?.origin === origin &&
          b.name === 'geolocation' &&
          b.state === state_ &&
          b.applied_as === 'location') ||
        `result ${describe(b)}`,
      quiet,
    );
    read.push(await geolocation());
  }
  if (before !== 'prompt' || read.join() !== 'granted,denied,prompt') {
    throw new StepFailure(
      'set_permission',
      `the page read ${String(before)} then ${read.join(' / ')}, expected prompt then granted / denied / prompt`,
    );
  }
  stepDone('browser.set_permission', t);

  // wait_for_tab: a click that opens a new tab; the tool returns that tab,
  // claimed and connected (ping answers from the opened page).
  t = now();
  const opened = new URL(`opened.html${nonce}`, page).href;
  const [waited] = await Promise.all([
    call(
      'browser.wait_for_tab',
      { opened_from: T, url_substring: 'opened.html', timeout_ms: 15_000 },
      (b) =>
        (b?.matched === true &&
          typeof b.tab_id === 'string' &&
          b.tab_id !== T &&
          b.url === opened &&
          b.claimed === true) ||
        `result ${describe(b)}`,
      quiet,
    ),
    pageValue(T, "document.querySelector('#open-tab').click(), true"),
  ]);
  const N = json(waited).tab_id;
  let pinged;
  for (const t0 = now(); now() - t0 < 5_000; await sleep(100)) {
    // Polled: how many pings ran before the title landed depends on timing.
    pinged = await attempt('browser.ping', { tab_id: N }, 'wait_for_tab', { poll: true });
    if (!pinged.isError && pinged.body?.title === 'e2e opened tab') break;
  }
  if (pinged.isError || pinged.body?.url !== opened || pinged.body?.title !== 'e2e opened tab') {
    throw new StepFailure('wait_for_tab', `the new tab ${N} answers ${pinged.text.slice(0, 300)}`);
  }
  stepDone('browser.wait_for_tab', t);
  const { targetInfos } = await cdp.send('Target.getTargets');
  for (const info of targetInfos.filter((i) => i.type === 'page' && i.url === opened)) {
    await cdp.send('Target.closeTarget', { targetId: info.targetId });
  }

  // flow_status / flow_cancel: a detached flow clicks #tick every 200 ms;
  // its status reads running, it is cancelled, its status reads cancelled
  // with the manifest of what it did, and the counter stops moving.
  // How far the counter got depends on timing, so the recorded reads answer
  // the assertion (a boolean), never the raw count.
  const TICKS = "Number(document.querySelector('#ticks').textContent)";
  const started = json(
    await call(
      'browser.flow',
      {
        tab_id: T,
        detach: true,
        steps: [
          {
            repeat: {
              max_iterations: 200,
              delay_ms: 200,
              steps: [{ click: { selector: '#tick', settle_ms: 0 } }],
            },
          },
        ],
      },
      (b) => (b?.detached === true && typeof b.flow_id === 'string') || `detach ${describe(b)}`,
      quiet,
    ),
  );
  const flowId = started.flow_id;
  const ids = { tab_id: T, flow_id: flowId };
  // The wait is inside ONE evaluate (see `scrollToBottom`): the server counts
  // every evaluate as pending_wrap_up, so a polled wait made the count the
  // next result carries depend on how fast the flow ticked.
  const ticked = await pageValue(
    T,
    `new Promise((r) => { const t0 = Date.now(); const f = () => (${TICKS} >= 2 ? r(true) : Date.now() - t0 > 10000 ? r(false) : setTimeout(f, 20)); f(); })`,
  );
  if (ticked !== true) throw new StepFailure('flow_status', 'the flow never clicked #tick');
  await call(
    'browser.flow_status',
    ids,
    (b) =>
      (b?.flow_id === flowId &&
        b.state === 'running' &&
        b.detached === true &&
        b.manifest === undefined &&
        b.iterations_completed >= 1) ||
      `status ${describe(b)}`,
  );

  t = now();
  await call(
    'browser.flow_cancel',
    ids,
    (b) =>
      (b?.cancel_requested === true &&
        b.flow_id === flowId &&
        (b.state === 'cancelled' || (b.state === 'running' && b.cancelling === true))) ||
      `cancel ${describe(b)}`,
    quiet,
  );
  await pollUntil('browser.flow_status', ids, (b) => b?.state !== 'running', 'flow_cancel');
  // The count at the stop is kept in the page; after five periods of the
  // flow the read answers whether it is unchanged (and the count, only when
  // it is not, for the failure message).
  await pageValue(T, `(window.__e2eTicksAtStop = ${TICKS}) >= 2`);
  await sleep(1_000);
  const still = await pageValue(
    T,
    `${TICKS} === window.__e2eTicksAtStop || \`\${window.__e2eTicksAtStop} -> \${${TICKS}}\``,
  );
  if (still !== true) {
    throw new StepFailure('flow_cancel', `#tick moved after the stop: ${String(still)}`);
  }
  stepDone('browser.flow_cancel', t);
  await call(
    'browser.flow_status',
    ids,
    (b) =>
      (b?.state === 'cancelled' &&
        b.stopped_by === 'cancelled' &&
        typeof b.ended_at === 'number' &&
        Array.isArray(b.manifest)) ||
      `status after cancel ${describe(b)}`,
    { label: 'browser.flow_status.cancelled' },
  );

  // flow_status after the record cap: ten more detached flows end, one at a
  // time (one detached flow per tab). The worker keeps ten records
  // (MAX_DETACHED_FLOW_RECORDS), so the eleventh evicts the oldest finished
  // one and its status answers `unknown`. This is also the only case that
  // reaches the detached-flow store's `remove` (R6, condition 1).
  for (let i = 0; i < 10; i += 1) {
    const more = json(
      await call(
        'browser.flow',
        { tab_id: T, detach: true, steps: [{ sleep: { ms: 1 } }] },
        (b) => (b?.detached === true && typeof b.flow_id === 'string') || `detach ${describe(b)}`,
        quiet,
      ),
    );
    await pollUntil(
      'browser.flow_status',
      { tab_id: T, flow_id: more.flow_id },
      (b) => b?.state !== 'running',
      'flow_status.evicted',
    );
  }
  await call(
    'browser.flow_status',
    ids,
    (b) =>
      (b?.flow_id === flowId && b.state === 'unknown') || `status after the cap ${describe(b)}`,
    { label: 'browser.flow_status.evicted' },
  );
}

/** Run a step; a StepFailure is printed and recorded (it fails the run)
 * instead of stopping the steps after it. */
async function recorded(step) {
  try {
    await step();
  } catch (e) {
    if (!(e instanceof StepFailure)) throw e;
    console.log(`e2e: FAIL ${errorText(e)}`);
    deferredFailures.push(e.step);
  }
}

/** Scroll to the bottom once the page is quiet. An add click hides #done for
 * 300 ms (index.html); scrolled meanwhile, the page is one line shorter, and
 * the scroll offset the call records differs from run to run. The wait is
 * inside ONE evaluate: the server counts every successful evaluate as
 * pending_wrap_up, so a polled wait would make that count vary. */
async function scrollToBottom(T) {
  const quiet =
    "new Promise((r) => { const f = () => (document.getElementById('done').hidden ? setTimeout(f, 20) : r()); f(); })";
  return pageValue(
    T,
    `${quiet}.then(() => (window.scrollTo(0, document.body.scrollHeight), window.scrollY))`,
  );
}

async function pageValue(T, expression, { poll = false } = {}) {
  const res = await call('browser.evaluate', { tab_id: T, expression }, undefined, {
    print: false,
    poll,
  });
  const b = json(res);
  return b && typeof b === 'object' && 'value' in b ? b.value : b;
}

/**
 * Error paths (slice 3b): one case per ToolFailure kind a Chrome tab can
 * reach, with the exact error text the tool answers today. `unknown-tool` is
 * not here: no MCP path sends one (contract suite only).
 */
async function errorPaths(T) {
  // `want`: the exact error text, or a RegExp when part of it (a stack trace)
  // is Chrome's own and may change between versions.
  const expectError = async (name, tool, args, want, extra) => {
    const label = `error.${name}`;
    const t = now();
    const r = await attempt(tool, { tab_id: T, ...args }, label);
    const matches = want instanceof RegExp ? want.test(r.text) : r.text === want;
    if (!r.isError || !matches) {
      const expected =
        want instanceof RegExp
          ? `text matching ${String(want)}`
          : `exactly ${JSON.stringify(want)}`;
      throw new StepFailure(
        label,
        `expected isError with ${expected}; isError=${String(r.isError)} answer: ${JSON.stringify(r.text.slice(0, 400))}`,
      );
    }
    if (extra) await extra();
    stepDone(label, t);
  };

  // action: a click whose selector matches nothing.
  await expectError(
    'action',
    'browser.click',
    { selector: '#e2e-no-such-element' },
    'Error: Element not found: #e2e-no-such-element',
  );

  // thrown: the evaluated expression throws.
  await expectError(
    'thrown',
    'browser.evaluate',
    { expression: "(() => { throw new Error('e2e-boom'); })()" },
    // The message line exactly, then only that a stack follows: the frame
    // text (`at <anonymous>:1:16`) is Chrome's own and is not pinned.
    /^Error: Error: e2e-boom\n {4}at \S/,
  );

  // timeout: wait_for expires on a selector that never appears.
  // Today it is an ordinary answer, not an error: matched false, reason timeout.
  {
    const label = 'error.timeout';
    const t = now();
    const r = await attempt(
      'browser.wait_for',
      { tab_id: T, selector: '#e2e-never', condition: 'visible', timeout_ms: 300 },
      label,
    );
    if (r.isError || r.body?.matched !== false || r.body?.reason !== 'timeout') {
      throw new StepFailure(
        label,
        `expected matched:false reason:"timeout" and no isError; isError=${String(r.isError)} answer: ${JSON.stringify(r.text.slice(0, 400))}`,
      );
    }
    stepDone(label, t);
  }

  // sensitive: a type into a password field fails (its expect already held);
  // the error text is the executor's own, and the trail stores the marker.
  await expectError(
    'sensitive',
    'browser.type',
    {
      selector: '#pw',
      text: 'e2e-secret-2',
      clear: true,
      settle_ms: 0,
      expect: { selector_appears: '#pw' },
    },
    'Error: expectation not met: selector_appears "#pw" was already present before the action',
    async () => {
      await call(
        'browser.activity',
        { tool: 'browser.type', limit: 1 },
        (b, tx) =>
          (b?.records?.[0]?.payload === '[sensitive field]' && !tx.includes('e2e-secret-2')) ||
          `stored payload is ${JSON.stringify(b?.records?.[0]?.payload)}`,
        { print: false, label: 'browser.activity.error-sensitive' },
      );
    },
  );
}

/**
 * The 1.1.0 rules a jsdom unit test cannot prove: the click resolver on a
 * target with no box (D4), the focus check of type/press, what settle sees
 * in closed shadow roots and frames (D5), and cut snapshot/find results (D6).
 */
async function ruleChecks(T) {
  // D4: no box, no force: refused, nothing clicked.
  let label = 'browser.click.no-box';
  let t = now();
  let r = await attempt('browser.click', { tab_id: T, selector: '#nobox' }, label);
  let result = await pageValue(T, "document.querySelector('#result').textContent");
  if (!/has no visible box/.test(r.text) || r.body?.ok === true || result === 'Hidden clicked') {
    throw new StepFailure(
      'click.no-box',
      `expected a refusal naming "has no visible box" and no click; isError=${String(r.isError)} result=${JSON.stringify(result)} answer: ${r.text.slice(0, 400)}`,
    );
  }
  stepDone(label, t);

  // D4: no box, force: the element's own click(), and the result says so.
  await call(
    'browser.click',
    { tab_id: T, selector: '#nobox', force: true, expect: { text_appears: 'Hidden clicked' } },
    (b, tx) =>
      (typeof b?.programmatic_click === 'string' && /"met":\s*true/.test(tx)) ||
      `programmatic_click ${JSON.stringify(b?.programmatic_click)}; ${tx.slice(0, 300)}`,
    { label: 'browser.click.forced-no-box' },
  );

  // type / press on an element that does not take focus: refused, nothing sent.
  for (const [tool, args, verb] of [
    ['browser.type', { text: 'zzz-unfocused' }, 'typed'],
    ['browser.press', { key: 'x' }, 'pressed'],
  ]) {
    label = `${tool}.no-focus`;
    t = now();
    const before = await pageValue(
      T,
      "[...document.querySelectorAll('input')].map((i) => i.value).join('|')",
    );
    r = await attempt(tool, { tab_id: T, selector: '#nofocus', ...args }, label);
    const after = await pageValue(
      T,
      "[...document.querySelectorAll('input')].map((i) => i.value).join('|')",
    );
    const want = `did not take focus (it is not focusable), so nothing was ${verb}`;
    if (!r.text.includes(want) || r.body?.ok === true || before !== after) {
      throw new StepFailure(
        label.replace(/^browser\./, ''),
        `expected "${want}" and no input changed; inputs ${JSON.stringify(before)} -> ${JSON.stringify(after)}; answer: ${r.text.slice(0, 400)}`,
      );
    }
    stepDone(label, t);
  }

  // D5: a closed shadow root attached after the page observer is watched.
  const settleOf = (b) => b?.settle ?? {};
  await call('browser.click', { tab_id: T, selector: '#make-closed' }, undefined, {
    print: false,
    label: 'make-closed',
  });
  await call(
    'browser.click',
    { tab_id: T, selector: '#poke-closed' },
    (b) => {
      const s = settleOf(b);
      return (
        (s.mutation_count >= 1 && s.unobserved?.shadow_roots === undefined) ||
        `settle ${JSON.stringify(s).slice(0, 500)}`
      );
    },
    { label: 'browser.click.settle-closed-shadow' },
  );
  // Documented limit: a closed root attached while the page parsed, before
  // any observer, cannot be known and is not reported. Informational.
  const early = await call('browser.click', { tab_id: T, selector: '#poke-early' }, undefined, {
    print: false,
    label: 'poke-early',
  });
  const es = settleOf(json(early));
  console.log(
    `browser.click.settle-closed-early info: mutation_count=${String(es.mutation_count)} unobserved=${JSON.stringify(es.unobserved?.shadow_roots ?? null)}`,
  );

  // D5: a same-origin frame is watched, a change made by the click itself
  // and one made during the settle wait; the cross-origin one is reported.
  for (const [selector, label] of [
    ['#poke-frame', 'browser.click.settle-frames'],
    ['#poke-frame-late', 'browser.click.settle-frames-late'],
  ]) {
    await call(
      'browser.click',
      { tab_id: T, selector },
      (b) => {
        const s = settleOf(b);
        const wrong = [];
        if (!(s.mutation_count >= 1)) wrong.push('the same-origin frame change was not counted');
        if (s.unobserved?.cross_origin_frames !== 1) wrong.push('cross_origin_frames is not 1');
        if (!/Cross-origin frames cannot be watched/.test(String(s.unobserved?.hint))) {
          wrong.push('no cross-origin hint');
        }
        return (
          wrong.length === 0 || `${wrong.join('; ')}: settle ${JSON.stringify(s).slice(0, 600)}`
        );
      },
      { label },
    );
  }

  // D6: a cut snapshot says it was cut and how much.
  await call(
    'browser.snapshot',
    { tab_id: T, only_interactive: true, max_interactive: 3 },
    (b, tx) => {
      const cut = b?.truncated;
      return (
        (Number.isInteger(cut?.interactive) &&
          cut.interactive > 0 &&
          Number.isInteger(cut?.next_offset?.interactive ?? cut?.next_offset)) ||
        `truncated ${JSON.stringify(cut)}; ${tx.slice(0, 200)}`
      );
    },
    { label: 'browser.snapshot.cut' },
  );
  // D6: a cut find: 8 matches, 5 candidates, 3 counted as left out.
  await call(
    'browser.find',
    { tab_id: T, text: 'Row action', role: 'button' },
    (b) =>
      (b?.reason === 'multiple-matches' &&
        b?.candidates?.length === 5 &&
        b?.truncated?.candidates === 3) ||
      `reason=${String(b?.reason)} candidates=${String(b?.candidates?.length)} truncated=${JSON.stringify(b?.truncated)}`,
    { label: 'browser.find.cut' },
  );
}

/** Names of the files in `dir` (empty when it does not exist yet). */
const listDir = (dir) => (existsSync(dir) ? readdirSync(dir).sort() : []);

/** Chrome's own download list, read from the extension's worker. */
const chromeDownloads = (cdp, swSession) =>
  cdp.evaluate(
    'chrome.downloads.search({}).then((l) => l.map((d) => ({ url: d.url, finalUrl: d.finalUrl ?? null, state: d.state, error: d.error ?? null, startTime: d.startTime ?? null, filename: d.filename ?? null, exists: d.exists ?? null, totalBytes: d.totalBytes ?? null, fileSize: d.fileSize ?? null, mime: d.mime ?? null })))',
    swSession,
  );

/** Print `label ok ms`, or fail it when E2E_EXPECT_FAIL names it. */
function stepDone(label, t) {
  const short = label.replace(/^browser\./, '');
  if (EXPECT_FAIL === short) throw new StepFailure(short, 'forced failure (E2E_EXPECT_FAIL)');
  console.log(`${label} ok ${String(Math.round(now() - t))}`);
}

/** A saved path lies directly inside the downloads dir (case-insensitive on Windows). */
function insideDir(path, dir) {
  const norm = (p) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
  return typeof path === 'string' && norm(join(path, '..')) === norm(dir);
}

/** The step's failure: the reason, what the tool said, and the whole result,
 * so a product failure (state / error / chrome_download) reads differently
 * from a harness one. */
function downloadFailure(label, why, res) {
  const b = json(res);
  const seen = b
    ? `state=${String(b.state)} error=${String(b.error)} chrome_download=${String(b.chrome_download)}`
    : 'no JSON result';
  return new StepFailure(
    label.replace(/^browser\./, ''),
    `${why}; ${seen}; full result: ${text(res).slice(0, 1500)}`,
  );
}

/** Windows only: what is wrong with a saved file's Mark-of-the-Web (its
 * `:Zone.Identifier` stream with ZoneId=3, as Chrome writes it). */
function markOfTheWebProblems(b) {
  if (process.platform !== 'win32') return [];
  const wrong = [];
  if (b?.mark_of_the_web !== 'written') {
    wrong.push(`mark_of_the_web is ${String(b?.mark_of_the_web)}`);
  }
  try {
    const zone = readFileSync(`${String(b?.path)}:Zone.Identifier`, 'utf8');
    if (!/^ZoneId=3\r?$/m.test(zone)) wrong.push(`Zone.Identifier lacks ZoneId=3: ${zone}`);
  } catch (e) {
    wrong.push(`no Zone.Identifier stream on ${String(b?.path)}: ${errorText(e)}`);
  }
  return wrong;
}

/** What is wrong with a saved download: right place, right bytes, no leftovers. */
function savedProblems(b, downloadsDir, files) {
  const wrong = [];
  if (b?.ok !== true) wrong.push(`ok is ${String(b?.ok)}`);
  if (b?.state !== 'complete') wrong.push(`state is ${String(b?.state)}`);
  if (b?.bytes !== REPORT_BYTES.length) {
    wrong.push(`bytes is ${String(b?.bytes)}, served ${String(REPORT_BYTES.length)}`);
  }
  if (!insideDir(b?.path, downloadsDir)) {
    wrong.push(`path ${String(b?.path)} is not inside ${downloadsDir}`);
  } else if (!existsSync(b.path)) {
    wrong.push(`path ${b.path} does not exist`);
  } else if (!readFileSync(b.path).equals(REPORT_BYTES)) {
    wrong.push('file content differs from the served bytes');
  }
  const found = listDir(downloadsDir);
  if (found.some((n) => /\.(part|crdownload|tmp)$/i.test(n)) || found.length !== files) {
    wrong.push(
      `downloads dir holds [${found.join(', ')}], expected ${String(files)} finished file(s)`,
    );
  }
  return wrong;
}

/**
 * `browser.download`, three ways. The first decides whether the selector
 * capture works on this Chrome at all: it needs the clicked tab's own debugger
 * session to receive `Page.downloadWillBegin`.
 */
async function downloadChecks({ T, origin, downloadsDir, cdp, swSession }) {
  const fileUrl = `${origin}/file.bin`;
  const otherUrl = `${origin}/other.bin`;
  const quiet = (label) => ({ print: false, label });

  // 1. Selector mode: the click starts the download, the tab reports it.
  let label = 'browser.download.selector';
  let t = now();
  let res = await call(
    'browser.download',
    { tab_id: T, selector: '#dl', timeout_ms: 10_000 },
    undefined,
    quiet(label),
  );
  let b = json(res);
  let wrong = savedProblems(b, downloadsDir, 1);
  if (b?.chrome_download !== 'removed') {
    wrong.push(`chrome_download is ${String(b?.chrome_download)}`);
  }
  wrong.push(...markOfTheWebProblems(b));
  if (wrong.length) throw downloadFailure(label, wrong.join('; '), res);
  try {
    const left = (await chromeDownloads(cdp, swSession)).filter((d) => d.url === fileUrl);
    if (left.length) {
      throw downloadFailure(label, `Chrome's list still holds ${JSON.stringify(left)}`, res);
    }
  } catch (e) {
    if (e instanceof StepFailure) throw e;
    console.log(
      `${label} note: Chrome's download list unreadable (${errorText(e)}); erase not verified`,
    );
  }
  stepDone(label, t);

  // 2. URL mode on the same file: Chrome's download manager is not involved.
  label = 'browser.download.url';
  t = now();
  res = await call(
    'browser.download',
    { tab_id: T, url: fileUrl, timeout_ms: 10_000 },
    undefined,
    quiet(label),
  );
  wrong = savedProblems(json(res), downloadsDir, 2);
  wrong.push(...markOfTheWebProblems(json(res)));
  if (wrong.length) throw downloadFailure(label, wrong.join('; '), res);
  stepDone(label, t);

  // 3. A download that is not the tab's, while a selector that starts none
  //    waits. Another file opened in a second tab (its own target, no debugger
  //    of ours on it): Chrome starts a download, the clicked tab reports none.
  //    Browser.setDownloadBehavior is not used: it would change how the
  //    extension sees downloads.
  label = 'browser.download.unrelated';
  t = now();
  const before = listDir(downloadsDir);
  const waitStart = Date.now();
  const waiting = call(
    'browser.download',
    { tab_id: T, selector: '#idle', timeout_ms: 8000 },
    undefined,
    quiet(label),
  ).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await sleep(1500); // the click is done and the capture is waiting
  let otherTarget;
  try {
    ({ targetId: otherTarget } = await cdp.send('Target.createTarget', { url: otherUrl }));
  } catch (e) {
    await waiting;
    throw new StepFailure(
      'download.unrelated',
      `harness: could not open the second tab: ${errorText(e)}`,
    );
  }
  const answered = await waiting;
  const waitEnd = Date.now();
  if (answered.error) throw answered.error;
  res = answered.value;
  b = json(res);
  wrong = [];
  const unattributed =
    b?.ok === false &&
    b?.state === 'interrupted' &&
    b?.chrome_download === 'left_in_chrome' &&
    /capture failed/.test(String(b?.error));
  const after = listDir(downloadsDir);
  if (after.join('|') !== before.join('|')) {
    wrong.push(`downloads dir changed from [${before.join(', ')}] to [${after.join(', ')}]`);
  }
  // Did Chrome itself create the unrelated download during the wait? Its own
  // list answers (the item's startTime against the wait's wall-clock window);
  // `null` when the list could not say.
  let createdDuringWait = null;
  let harness = null;
  let chromeNote;
  try {
    let item;
    const t0 = now();
    while (!item && now() - t0 < 5000) {
      item = (await chromeDownloads(cdp, swSession)).find((d) => d.url === otherUrl);
      if (!item) await sleep(200);
    }
    if (!item) {
      createdDuringWait = false;
      harness = `Chrome never listed ${otherUrl}, so no download was created during the wait`;
    } else {
      const started = Date.parse(String(item.startTime));
      if (Number.isFinite(started)) {
        createdDuringWait = started >= waitStart - 1000 && started <= waitEnd + 1000;
        if (!createdDuringWait) {
          harness = `Chrome lists ${otherUrl} but it started at ${String(item.startTime)}, outside the wait`;
        }
      }
      if (item.state === 'interrupted' || item.error) {
        wrong.push(`the unrelated download was cancelled: ${JSON.stringify(item)}`);
      }
    }
    chromeNote = item ? `Chrome kept it (${item.state})` : 'not listed by Chrome';
  } catch (e) {
    chromeNote = `Chrome list unreadable (${errorText(e)}), not verified`;
  }
  try {
    await cdp.send('Target.closeTarget', { targetId: otherTarget });
  } catch {
    // a download tab may close itself
  }
  // Only the unattributed outcome passes. A timeout is what a capture that
  // saw nothing answers, so it proves nothing about attribution: it is a
  // harness failure when no download was created during the wait, and a
  // product failure when Chrome shows one was.
  if (!unattributed) {
    if (createdDuringWait === true) {
      wrong.push(
        'Chrome shows the unrelated download was created during the wait, so only the unattributed outcome passes (ok:false, interrupted, left_in_chrome, "capture failed")',
      );
    } else {
      harness ??= `the capture did not answer unattributed (state ${String(b?.state)}) and Chrome's list could not show whether a download was created during the wait`;
    }
  }
  if (harness) {
    console.log(
      `${label} note: nothing was proven about attribution (${harness}); outcome ${String(b?.state)}; ${chromeNote}`,
    );
    throw downloadFailure(
      label,
      `harness: ${harness}${wrong.length ? `; also: ${wrong.join('; ')}` : ''}`,
      res,
    );
  }
  if (wrong.length) throw downloadFailure(label, wrong.join('; '), res);
  console.log(`${label} outcome: unattributed (interrupted, left_in_chrome); ${chromeNote}`);
  stepDone(label, t);

  await downloadSituations({ T, origin, downloadsDir, cdp, swSession });
}

/** Chrome's own entry for `url`, once it is no longer in progress (null
 * when Chrome never listed it within 10 s). */
async function chromeEntry(cdp, swSession, url) {
  const t0 = now();
  let item;
  while (now() - t0 < 10_000) {
    item = (await chromeDownloads(cdp, swSession)).find((d) => d.url === url);
    if (item && item.state !== 'in_progress') return item;
    await sleep(200);
  }
  return item ?? null;
}

/** What is wrong with Chrome's kept copy: listed, complete, on disk, and
 * holding the bytes the first request served. */
function keptProblems(item) {
  if (!item) return ['Chrome does not list the download'];
  const wrong = [];
  if (item.state !== 'complete') wrong.push(`Chrome's copy is ${String(item.state)}`);
  if (item.exists === false || !item.filename || !existsSync(item.filename)) {
    wrong.push(`Chrome's file ${String(item.filename)} is gone`);
  } else if (!readFileSync(item.filename).equals(REPORT_BYTES)) {
    wrong.push(`Chrome's file ${item.filename} does not hold the served bytes`);
  }
  return wrong;
}

/**
 * The S2/S3 download situations, through the real browser. A selector-mode
 * capture whose re-fetch cannot be proven identical to Chrome's download
 * fails and keeps Chrome's copy (owner decision D17); executable types are
 * refused before anything is written.
 */
async function downloadSituations({ T, origin, downloadsDir, cdp, swSession }) {
  const failedKept = async (label, selector, path, extra) => {
    const t = now();
    const before = listDir(downloadsDir);
    const res = await call(
      'browser.download',
      { tab_id: T, selector, timeout_ms: 10_000 },
      undefined,
      { print: false, label },
    );
    const b = json(res);
    const wrong = [];
    if (b?.ok !== false) wrong.push(`ok is ${String(b?.ok)}`);
    if (b?.chrome_download !== 'left_in_chrome') {
      wrong.push(`chrome_download is ${String(b?.chrome_download)}`);
    }
    // Every capture failure (an HTTP error on the re-fetch, a mismatch, an
    // unknown size) starts with "the capture failed" and says Chrome's copy stays.
    if (!/^the capture failed: /.test(String(b?.error))) {
      wrong.push('error does not start with "the capture failed"');
    }
    if (!/was not erased/.test(String(b?.error))) {
      wrong.push("error does not say Chrome's copy was kept");
    }
    if (extra && !extra.test(String(b?.error))) wrong.push(`error does not match ${String(extra)}`);
    const after = listDir(downloadsDir);
    if (after.join('|') !== before.join('|')) {
      wrong.push(`downloads dir changed from [${before.join(', ')}] to [${after.join(', ')}]`);
    }
    const item = await chromeEntry(cdp, swSession, `${origin}${path}`);
    wrong.push(...keptProblems(item));
    if (wrong.length) throw downloadFailure(label, wrong.join('; '), res);
    console.log(
      `${label} outcome: failed, kept (Chrome totalBytes=${String(item.totalBytes)}, requests ${JSON.stringify(served[path]?.methods)}): ${String(b.error).slice(0, 160)}`,
    );
    stepDone(label, t);
  };

  // POST form: Chrome's download came from a POST; the GET re-fetch answers 405.
  await failedKept('browser.download.post', '#dl-post', '/post.pdf');
  // One-time token: the re-fetch answers 200 text/html.
  await failedKept('browser.download.one-time', '#dl-token', '/token.bin');
  // No Content-Length: Chrome cannot report the size, so nothing is proven.
  await failedKept('browser.download.chunked', '#dl-chunked', '/chunked.bin', /size/);

  // gzip: either outcome is safe; anything else (wrong bytes saved, or a
  // failure that erased Chrome's copy) is not. The outcome is printed.
  let label = 'browser.download.gzip';
  let t = now();
  const before = listDir(downloadsDir);
  let res = await call(
    'browser.download',
    { tab_id: T, selector: '#dl-gzip', timeout_ms: 10_000 },
    undefined,
    { print: false, label },
  );
  let b = json(res);
  const item = await chromeEntry(cdp, swSession, `${origin}/gzip.bin`);
  let wrong;
  let outcome;
  if (b?.ok === true) {
    outcome = 'saved';
    wrong = savedProblems(b, downloadsDir, before.length + 1);
    if (b?.chrome_download !== 'removed')
      wrong.push(`chrome_download is ${String(b?.chrome_download)}`);
    wrong.push(...markOfTheWebProblems(b));
  } else {
    outcome = 'failed, kept';
    wrong = keptProblems(item);
    if (b?.chrome_download !== 'left_in_chrome') {
      wrong.push(`chrome_download is ${String(b?.chrome_download)}`);
    }
    const after = listDir(downloadsDir);
    if (after.join('|') !== before.join('|')) wrong.push('downloads dir changed');
  }
  if (wrong.length) throw downloadFailure(label, wrong.join('; '), res);
  console.log(
    `${label} outcome: ${outcome} (Chrome totalBytes=${String(item?.totalBytes)} fileSize=${String(item?.fileSize)}; served gzip ${String(gzipSync(REPORT_BYTES).length)} bytes, decoded ${String(REPORT_BYTES.length)}): ${String(b?.error ?? b?.path).slice(0, 200)}`,
  );
  stepDone(label, t);

  // A selector whose click fails says the click failed, not only that no
  // download started.
  label = 'browser.download.click-failed';
  t = now();
  const failed = await attempt(
    'browser.download',
    { tab_id: T, selector: '#nobox', timeout_ms: 3000 },
    label,
  );
  if (
    !failed.text.includes('the click that should start the download failed') ||
    !failed.text.includes('has no visible box') ||
    failed.body?.ok === true
  ) {
    throw new StepFailure('download.click-failed', `answer: ${failed.text.slice(0, 400)}`);
  }
  stepDone(label, t);

  // Executable types are refused, double extension included; nothing written.
  for (const name of ['setup.exe', 'invoice.pdf.exe']) {
    label = `browser.download.refused-${name}`;
    t = now();
    const dirBefore = listDir(downloadsDir);
    res = await call(
      'browser.download',
      { tab_id: T, url: `${origin}/${name}`, timeout_ms: 10_000 },
      undefined,
      { print: false, label },
    );
    b = json(res);
    wrong = [];
    if (b?.ok !== false) wrong.push(`ok is ${String(b?.ok)}`);
    if (b?.path !== null) wrong.push(`path is ${String(b?.path)}`);
    if (!/is an executable file type/.test(String(b?.error))) {
      wrong.push('error does not say "is an executable file type"');
    }
    if (listDir(downloadsDir).join('|') !== dirBefore.join('|'))
      wrong.push('downloads dir changed');
    if (wrong.length) throw downloadFailure(label, wrong.join('; '), res);
    stepDone(label, t);
  }
}

/** Chrome with the extension loaded. `Extensions.loadUnpacked` when this
 * Chrome has it (current stable ignores `--load-extension`); the keyless
 * copy is then loaded later the same way. Otherwise, chosen by that
 * capability and not by version, a relaunch with `--load-extension` for both
 * copies (older Chrome, such as 118, has no such CDP method). */
async function startChrome(chromePath, cdpPort, extDir, keylessDir, pinnedId) {
  const open = async (loadExtensions) => {
    state.chrome = launchChrome({ chromePath, port: cdpPort, loadExtensions });
    temps.push(state.chrome.profile);
    const version = await waitHttp(`http://127.0.0.1:${String(cdpPort)}/json/version`, 20_000);
    state.cdp = await Cdp.open(version.webSocketDebuggerUrl);
    return version;
  };
  let version = await open([]);
  try {
    const { id: extId } = await state.cdp.send('Extensions.loadUnpacked', { path: extDir });
    return { version, extId, loadedKeylessId: undefined, loadMode: 'Extensions.loadUnpacked' };
  } catch (e) {
    if (!/wasn't found/.test(String(e?.message))) throw e;
  }
  await stopChrome(state.chrome, state.cdp);
  state.cdp.close();
  version = await open([extDir, keylessDir]);
  const ids = await waitExtensionIds(state.cdp, 2, 20_000);
  const extId = ids.includes(pinnedId) ? pinnedId : ids[0];
  const loadedKeylessId = ids.find((id) => id !== extId);
  return { version, extId, loadedKeylessId, loadMode: '--load-extension' };
}
/** The refused path through the real browser: the keyless copy (another id)
 * tries to connect a tab, and the popup-facing result carries the bridge's
 * refusal code and reason, which the server logged for that origin. */
async function refusedExtension(cdp, swSession, page, keylessId) {
  const t = now();
  const url = `${page}?refused`;
  const { targetId: refusedTab } = await cdp.send('Target.createTarget', { url });
  const tabId = await evaluateUntil(
    cdp,
    `chrome.tabs.query({}).then(ts => (ts.find(t => t.url === ${jsLiteral(url)} && t.status === 'complete') || {}).id ?? null)`,
    swSession,
    15_000,
  );
  const { targetId } = await cdp.send('Target.createTarget', {
    url: `chrome-extension://${keylessId}/popup.html`,
  });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const result = await evaluateUntil(
    cdp,
    `chrome.runtime.sendMessage(${jsLiteral({ action: 'connect', tabId })})`,
    sessionId,
    15_000,
  );
  await cdp.send('Target.closeTarget', { targetId });
  // Closed so the tab the nine calls drive is the foreground one again.
  await cdp.send('Target.closeTarget', { targetId: refusedTab });
  if (
    result.ok !== false ||
    result.code !== 'ws-handshake-refused' ||
    result.values?.reason !== 'origin-not-allowed'
  ) {
    throw new StepFailure('bridge.refused', JSON.stringify(result));
  }
  const origin = `chrome-extension://${keylessId}`;
  const logged = () =>
    serverStderr.split('\n').find((l) => l.includes(`Rejected WS handshake from origin ${origin}`));
  const t0 = now();
  while (!logged() && now() - t0 < 5_000) await sleep(50);
  if (!logged()) throw new StepFailure('bridge.refused', `no refusal logged for ${origin}`);
  console.log(
    `bridge.refused ok ${origin} -> ${result.code} reason=${result.values.reason} ${String(Math.round(now() - t))}`,
  );
}

/** The interface language through the real built extension (EN | ES in the
 * header): one line per check, `i18n.<check> ok ms`. */
const I18N = {
  en: {
    footer: 'manual · per-tab · loopback only',
    notice: 'Read notice',
    activity: 'Activity',
    status: 'Status',
    cdpDirectEnabled: 'cdp-direct enabled',
    hidePasswordValues: 'Hide password values from agents',
    activityHideSensitive: 'Hide sensitive values in the activity trail',
    idleTtl: 'Idle disconnect',
    claimTtl: 'Claim expiry between agents',
    consoleSection: 'Console settings',
    copy: 'Copy',
  },
  es: {
    footer: 'manual · por pestaña · solo loopback',
    notice: 'Ver aviso',
    activity: 'Actividad',
    status: 'Estado',
    cdpDirectEnabled: 'cdp-direct activado',
    hidePasswordValues: 'Ocultar a los agentes el valor de las contraseñas',
    activityHideSensitive: 'Ocultar los valores sensibles en el registro de actividad',
    idleTtl: 'Desconexión por inactividad',
    claimTtl: 'Vencimiento de la reserva entre agentes',
    consoleSection: 'Ajustes de la consola',
    copy: 'Copiar',
  },
};

async function openPage(cdp, extId, page) {
  const { targetId } = await cdp.send('Target.createTarget', {
    url: `chrome-extension://${extId}/${page}`,
  });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  // Ready once ui-language.ts has applied a language to <html>.
  await evaluateUntil(
    cdp,
    `document.documentElement.lang !== '' && document.readyState === 'complete'`,
    sessionId,
    15_000,
  );
  return { targetId, sessionId };
}

/** Evaluate until `expression` is truthy; a timeout is this check's failure. */
async function expectSoon(cdp, name, expression, sessionId, why) {
  try {
    return await evaluateUntil(cdp, expression, sessionId, 10_000);
  } catch {
    let seen = '';
    try {
      seen = JSON.stringify(
        await cdp.evaluate(
          `document.documentElement.lang + ' | ' + (document.querySelector('header')?.innerText ?? '')`,
          sessionId,
        ),
      );
    } catch {
      // page gone
    }
    throw new StepFailure(name, `${why}; page shows ${seen}`);
  }
}

async function check(name, run) {
  const t = now();
  await run(name);
  if (EXPECT_FAIL === name) throw new StepFailure(name, 'forced failure (E2E_EXPECT_FAIL)');
  console.log(`${name} ok ${String(Math.round(now() - t))}`);
}

async function languageChecks(cdp, extId) {
  const popup = await openPage(cdp, extId, 'popup.html');
  const activity = await openPage(cdp, extId, 'activity.html');
  const admin = await openPage(cdp, extId, 'admin.html');
  const footer = `document.querySelector('[data-i18n="popupFooter"]').textContent.trim()`;
  let from;
  let to;

  await check('i18n.default', async (name) => {
    from = await cdp.evaluate('document.documentElement.lang', popup.sessionId);
    if (from !== 'en' && from !== 'es') throw new StepFailure(name, `html lang is ${String(from)}`);
    to = from === 'en' ? 'es' : 'en';
    await expectSoon(
      cdp,
      name,
      `${footer} === ${jsLiteral(I18N[from].footer)}`,
      popup.sessionId,
      `footer not in ${from}`,
    );
    // Marks that only survive if these pages are never reloaded.
    for (const s of [activity.sessionId, admin.sessionId])
      await cdp.evaluate('window.__e2eNoReload = 1', s);
    // The Admin rows come from the server, in the window's language.
    await expectSoon(
      cdp,
      name,
      `document.querySelector('.admin-section-title')?.textContent === ${jsLiteral(I18N[from].status)}`,
      admin.sessionId,
      `admin status section not in ${from}`,
    );
  });

  await check('i18n.switch', async (name) => {
    await cdp.evaluate(
      `document.querySelector(${jsLiteral(`.lang-switch button[data-lang="${to}"]`)}).click()`,
      popup.sessionId,
    );
    await expectSoon(
      cdp,
      name,
      `document.documentElement.lang === ${jsLiteral(to)} && ${footer} === ${jsLiteral(I18N[to].footer)} && document.querySelector(${jsLiteral(`.lang-switch button[data-lang="${to}"]`)}).getAttribute('aria-pressed') === 'true' && document.getElementById('notice-open').textContent === ${jsLiteral(I18N[to].notice)}`,
      popup.sessionId,
      `popup did not switch to ${to}`,
    );
    // Selector on the title's row, far right, and the header neither wraps nor overflows.
    const layout = await cdp.evaluate(
      `(() => { const h = document.querySelector('header'); const s = h.lastElementChild.getBoundingClientRect(); const t = document.getElementById('app-name').getBoundingClientRect(); const hb = h.getBoundingClientRect(); return { last: h.lastElementChild.className, overflow: h.scrollWidth > h.clientWidth, sameRow: s.top < t.bottom && s.bottom > t.top, right: hb.right - s.right }; })()`,
      popup.sessionId,
    );
    if (layout.last !== 'lang-switch' || layout.overflow || !layout.sameRow || layout.right > 1) {
      throw new StepFailure(name, `header layout ${JSON.stringify(layout)}`);
    }
  });

  await check('i18n.live-windows', async (name) => {
    await expectSoon(
      cdp,
      name,
      `window.__e2eNoReload === 1 && document.documentElement.lang === ${jsLiteral(to)} && document.querySelector('h1').textContent.trim() === ${jsLiteral(I18N[to].activity)}`,
      activity.sessionId,
      'Activity did not follow without reload',
    );
    await expectSoon(
      cdp,
      name,
      `window.__e2eNoReload === 1 && document.querySelector('.admin-section-title')?.textContent === ${jsLiteral(I18N[to].status)}`,
      admin.sessionId,
      'Admin did not follow without reload',
    );
  });

  // Console-only settings (S4, 1.3.0): their own section under one visible
  // notice; each row the server's value and no control, then the exact
  // command with a Copy button; no hover info control anywhere.
  await check('admin.console-only', async (name) => {
    const section = await cdp.evaluate(
      `(() => { const title = [...document.querySelectorAll('.admin-section-title')].find((t) => t.textContent === ${jsLiteral(I18N[to].consoleSection)}); const notice = title?.nextElementSibling; return { title: !!title, notice: notice?.classList.contains('admin-section-notice') ? notice.textContent : null, info: document.querySelectorAll('.admin-info, .admin-info-text').length }; })()`,
      admin.sessionId,
    );
    if (!section.title || !section.notice?.trim() || section.info !== 0) {
      throw new StepFailure(name, `console section ${JSON.stringify(section)}`);
    }
    const rows = [
      [
        'cdpDirectEnabled',
        ['true', 'false'].map((v) => `browser-link config set cdp-direct.enabled ${v}`),
      ],
      [
        'hidePasswordValues',
        ['on', 'off'].map((v) => `browser-link config set hide-password-values ${v}`),
      ],
      [
        'activityHideSensitive',
        ['on', 'off'].map((v) => `browser-link config set activity.hide-sensitive ${v}`),
      ],
      ['idleTtl', ['browser-link config set idle-ttl 30']],
      ['claimTtl', ['browser-link config set claim-ttl 10']],
    ];
    for (const [key, commands] of rows) {
      const label = jsLiteral(I18N[to][key]);
      const seen = await cdp.evaluate(
        `(() => { const row = [...document.querySelectorAll('.admin-row')].find((r) => r.querySelector('.admin-row-label')?.textContent === ${label}); if (!row) return null; const line = row.nextElementSibling; const copy = line?.querySelector('button.admin-copy'); return { controls: row.querySelectorAll('input, select, button').length, value: row.querySelector('.admin-row-value')?.textContent ?? null, command: line?.classList.contains('admin-command') ? (line.querySelector('code')?.textContent ?? null) : null, copy: copy?.textContent ?? null, copyName: copy?.getAttribute('aria-label') ?? null }; })()`,
        admin.sessionId,
      );
      if (
        !seen ||
        seen.controls !== 0 ||
        !seen.value ||
        !commands.includes(seen.command) ||
        seen.copy !== I18N[to].copy ||
        !seen.copyName?.trim()
      ) {
        throw new StepFailure(name, `${key} row ${JSON.stringify(seen)}`);
      }
    }
  });

  await check('i18n.persisted', async (name) => {
    await cdp.send('Target.closeTarget', { targetId: popup.targetId });
    const again = await openPage(cdp, extId, 'popup.html');
    await expectSoon(
      cdp,
      name,
      `document.documentElement.lang === ${jsLiteral(to)} && ${footer} === ${jsLiteral(I18N[to].footer)}`,
      again.sessionId,
      'the choice did not survive reopening the popup',
    );
  });
}

async function teardown() {
  try {
    await state.client?.close();
  } catch {
    // server already gone
  }
  killPid(serverPid);
  if (state.chrome) await stopChrome(state.chrome, state.cdp);
  if (state.cdpChrome) await stopChrome(state.cdpChrome, state.cdpChromeCdp);
  state.cdpChromeCdp?.close();
  state.cdp?.close();
  state.http?.close();
  const left = [];
  for (const dir of temps) if (!(await removeDir(dir))) left.push(dir);
  if (left.length) console.error(`e2e: warning, temp dirs not removed: ${left.join(', ')}`);
}

const T0 = now();
// The owner's own browser-link (if running) must survive the run untouched.
const primaryBefore = [...new Set(DEFAULT_PORTS.flatMap((p) => portOwners(p)))];
let exitCode = 0;
let timer;
try {
  await Promise.race([
    main(),
    new Promise((_r, rej) => {
      timer = setTimeout(
        () => rej(new StepFailure('total', `over ${String(TOTAL_TIMEOUT_MS / 1000)} s`)),
        TOTAL_TIMEOUT_MS,
      );
    }),
  ]);
  if (deferredFailures.length) exitCode = 1;
  else {
    // A run that passed must have called every mapped tool under its case.
    const missing = uncalledCases(calledCases);
    if (missing.length) {
      exitCode = 1;
      console.log('e2e: FAIL tool-to-case table: ' + missing.join('; '));
    }
  }
} catch (e) {
  exitCode = 1;
  const why = e instanceof StepFailure ? e.message : `setup: ${String(e?.stack ?? e)}`;
  console.log(`e2e: FAIL ${why}`);
  const tail = serverStderr.split('\n').filter(Boolean).slice(-15);
  if (tail.length) console.error(`server stderr (tail):\n${tail.join('\n')}`);
  // A setup failure (a Chrome that never came up, among them) shows Chrome's own words.
  const chromeErr = state.chrome?.stderr.toString().trim();
  if (!(e instanceof StepFailure) && chromeErr) {
    console.error(`chrome stderr (last ${String(CHROME_STDERR_MAX / 1024)} KB):\n${chromeErr}`);
  }
} finally {
  clearTimeout(timer);
  await teardown();
}
const dead = primaryBefore.filter((pid) => !isAlive(pid));
if (primaryBefore.length === 0) {
  console.log('primary: none on 127.0.0.1:17529/17530');
} else if (dead.length) {
  exitCode = 1;
  console.log(`e2e: FAIL primary: pid ${dead.join(', ')} no longer alive`);
} else {
  console.log(`primary: pid ${primaryBefore.join(', ')} still alive`);
}
try {
  const file = writeResult(resultRecord({ ...browserSeen, ok: exitCode === 0 }));
  console.log(`e2e: browser record in ${file}`);
} catch (e) {
  console.error(`e2e: warning, browser record not written: ${String(e?.message ?? e)}`);
}
if (RECORD_FILE) {
  try {
    record.ok = exitCode === 0;
    record.chrome = browserSeen.jsonVersion?.Browser ?? null;
    mkdirSync(dirname(RECORD_FILE), { recursive: true });
    writeFileSync(RECORD_FILE, `${JSON.stringify(record)}\n`);
    console.log(`e2e: call record (${String(record.calls.length)} calls) in ${RECORD_FILE}`);
  } catch (e) {
    console.error(`e2e: warning, call record not written: ${String(e?.message ?? e)}`);
  }
}
console.log(`e2e: ${exitCode === 0 ? 'ok' : 'FAIL'} in ${String(Math.round(now() - T0))} ms`);
process.exit(exitCode);
