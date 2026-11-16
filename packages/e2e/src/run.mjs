// Real-Chrome end-to-end net (`pnpm test:e2e`): the BUILT extension in an
// isolated headless Chrome, the BUILT server over MCP stdio, a tab connected
// without a human, and tool calls whose effects are asserted, so the
// extension half of every call (background.ts perform* handlers) runs for real.
// Then the interface language: switch EN | ES in the popup, open Activity and
// Admin windows follow without reload, and the choice survives a reopen.
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
// E2E_EXPECT_FAIL=<tool> forces that tool's assertion to fail (RED probe).
// Exit 0 only when every call passes; 1 names the failing tool.
// Shape and numbers: packages/plan/lab/2026-11-09-e2e-net/README.md.
import { existsSync, readFileSync, readdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  Cdp,
  DEFAULT_PORTS,
  PAGE_FILE,
  SERVER_CLI,
  evaluateUntil,
  extensionCopy,
  freePort,
  isAlive,
  killPid,
  launchChrome,
  now,
  originProbe,
  pinnedExtensionId,
  portOwners,
  removeDir,
  resolveChrome,
  sleep,
  stopChrome,
  waitHttp,
  waitExtensionIds,
  waitServiceWorker,
} from './lib.mjs';

const CALL_TIMEOUT_MS = 45_000;
const TOTAL_TIMEOUT_MS = 180_000;
const REPORT_BYTES = Buffer.from(Array.from({ length: 2048 }, (_, i) => (i * 7 + 3) % 256));
const ATTACHMENTS = {
  '/file.bin': { name: 'e2e-report.bin', bytes: REPORT_BYTES },
  '/other.bin': { name: 'e2e-other.bin', bytes: Buffer.from(REPORT_BYTES).reverse() },
};
const EXPECT_FAIL = (process.env.E2E_EXPECT_FAIL ?? '').replace(/^browser\./, '');

class StepFailure extends Error {
  constructor(step, reason) {
    super(`${step}: ${reason}`);
    this.step = step;
  }
}

const temps = [];
const state = { http: undefined, chrome: undefined, cdp: undefined, client: undefined };
let serverPid;
let serverStderr = '';

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

/** One MCP tool call: must succeed, then `check(body, text)` must return true
 * (or a string saying what is wrong). Prints `tool ok ms`, or `label ok ms`
 * when a second check of the same tool needs its own name. */
async function call(tool, args, check, { print = true, label = tool } = {}) {
  const short = label.replace(/^browser\./, '');
  const t = now();
  let res;
  try {
    res = await state.client.callTool({ name: tool, arguments: args }, undefined, {
      timeout: CALL_TIMEOUT_MS,
    });
  } catch (e) {
    throw new StepFailure(short, e.message);
  }
  const ms = Math.round(now() - t);
  if (res.isError) throw new StepFailure(short, `tool error: ${text(res).slice(0, 300)}`);
  let verdict = check ? check(json(res), text(res)) : true;
  if (print && EXPECT_FAIL === short) verdict = 'forced failure (E2E_EXPECT_FAIL)';
  if (verdict !== true) throw new StepFailure(short, `${String(verdict)} (${String(ms)} ms)`);
  if (print) console.log(`${label} ok ${String(ms)}`);
  return res;
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
  state.http = createServer((q, r) => {
    const file = ATTACHMENTS[(q.url ?? '/').split('?')[0]];
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
  // The manifest `key` pins the id; the patched temp copy must keep it.
  if (extId !== pinnedId) {
    throw new StepFailure('extension.id', `Chrome assigned ${extId}, the server pins ${pinnedId}`);
  }
  console.log(`extension.id ok ${extId} (${version.Browser}, loaded with ${loadMode})`);
  const sw = await waitServiceWorker(cdp, extId, 15_000);

  // 2. The server, stdio MCP, isolated.
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_CLI],
    env: {
      ...process.env,
      BROWSER_LINK_WS_PORT: String(wsPort),
      BROWSER_LINK_IPC_PORT: String(ipcPort),
      BROWSER_LINK_DATA_DIR: dataDir,
      HOME: homeDir,
      USERPROFILE: homeDir,
      COPILOT_HOME: join(homeDir, '.copilot'),
    },
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
  const tabId = await evaluateUntil(
    cdp,
    `chrome.tabs.query({}).then(ts => (ts.find(t => t.url === ${JSON.stringify(page)} && t.status === 'complete') || {}).id ?? null)`,
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
    `chrome.runtime.sendMessage(${JSON.stringify({ action: 'connect', tabId })})`,
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
  let tab;
  while (!tab) {
    const r = await call('browser.list_tabs', {}, undefined, { print: false });
    const tabs = json(r);
    tab = Array.isArray(tabs) ? tabs.find((t) => t.url === page) : undefined;
    if (!tab && now() - tl > CALL_TIMEOUT_MS) {
      throw new StepFailure('list_tabs', 'the connected tab was never listed');
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
    (_b, t) => /[a-z0-9]{1,16}:e\d+/.test(t) || 'no ref returned',
  );
  const ref = /[a-z0-9]{1,16}:e\d+/.exec(text(found))[0];
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

  await downloadChecks({
    T,
    origin: new URL(page).origin,
    downloadsDir: join(dataDir, 'downloads'),
    cdp,
    swSession,
  });

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
}

/** Names of the files in `dir` (empty when it does not exist yet). */
const listDir = (dir) => (existsSync(dir) ? readdirSync(dir).sort() : []);

/** Chrome's own download list, read from the extension's worker. */
const chromeDownloads = (cdp, swSession) =>
  cdp.evaluate(
    'chrome.downloads.search({}).then((l) => l.map((d) => ({ url: d.url, state: d.state, error: d.error ?? null, startTime: d.startTime ?? null })))',
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
  if (wrong.length) throw downloadFailure(label, wrong.join('; '), res);
  try {
    const left = (await chromeDownloads(cdp, swSession)).filter((d) => d.url === fileUrl);
    if (left.length) {
      throw downloadFailure(label, `Chrome's list still holds ${JSON.stringify(left)}`, res);
    }
  } catch (e) {
    if (e instanceof StepFailure) throw e;
    console.log(
      `${label} note: Chrome's download list unreadable (${e.message}); erase not verified`,
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
      `harness: could not open the second tab: ${e.message}`,
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
    chromeNote = `Chrome list unreadable (${e.message}), not verified`;
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
    `chrome.tabs.query({}).then(ts => (ts.find(t => t.url === ${JSON.stringify(url)} && t.status === 'complete') || {}).id ?? null)`,
    swSession,
    15_000,
  );
  const { targetId } = await cdp.send('Target.createTarget', {
    url: `chrome-extension://${keylessId}/popup.html`,
  });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const result = await evaluateUntil(
    cdp,
    `chrome.runtime.sendMessage(${JSON.stringify({ action: 'connect', tabId })})`,
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
  },
  es: {
    footer: 'manual · por pestaña · solo loopback',
    notice: 'Ver aviso',
    activity: 'Actividad',
    status: 'Estado',
    cdpDirectEnabled: 'cdp-direct activado',
    hidePasswordValues: 'Ocultar a los agentes el valor de las contraseñas',
    activityHideSensitive: 'Ocultar los valores sensibles en el registro de actividad',
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
      `${footer} === ${JSON.stringify(I18N[from].footer)}`,
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
      `document.querySelector('.admin-section-title')?.textContent === ${JSON.stringify(I18N[from].status)}`,
      admin.sessionId,
      `admin status section not in ${from}`,
    );
  });

  await check('i18n.switch', async (name) => {
    await cdp.evaluate(
      `document.querySelector('.lang-switch button[data-lang="${to}"]').click()`,
      popup.sessionId,
    );
    await expectSoon(
      cdp,
      name,
      `document.documentElement.lang === '${to}' && ${footer} === ${JSON.stringify(I18N[to].footer)} && document.querySelector('.lang-switch button[data-lang="${to}"]').getAttribute('aria-pressed') === 'true' && document.getElementById('notice-open').textContent === ${JSON.stringify(I18N[to].notice)}`,
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
      `window.__e2eNoReload === 1 && document.documentElement.lang === '${to}' && document.querySelector('h1').textContent.trim() === ${JSON.stringify(I18N[to].activity)}`,
      activity.sessionId,
      'Activity did not follow without reload',
    );
    await expectSoon(
      cdp,
      name,
      `window.__e2eNoReload === 1 && document.querySelector('.admin-section-title')?.textContent === ${JSON.stringify(I18N[to].status)}`,
      admin.sessionId,
      'Admin did not follow without reload',
    );
  });

  // Console-only settings: the server's readout, the command under it, no control.
  await check('admin.console-only', async (name) => {
    // cdp-direct and the two hide settings (changed only from the console):
    // the server's readout, the command under it, no control, and an info
    // control (a button with an accessible name, pointing at a text) beside the label.
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
    ];
    for (const [key, commands] of rows) {
      const label = JSON.stringify(I18N[to][key]);
      const seen = await cdp.evaluate(
        `(() => { const row = [...document.querySelectorAll('.admin-row')].find((r) => r.querySelector('.admin-row-label')?.textContent === ${label}); if (!row) return null; const note = row.nextElementSibling; const info = row.querySelector('button.admin-info'); const text = info ? document.getElementById(info.getAttribute('aria-describedby') ?? '') : null; return { controls: row.querySelectorAll('input, select, button:not(.admin-info)').length, value: row.querySelector('.admin-row-value')?.textContent ?? null, command: note?.classList.contains('admin-note') ? note.textContent : null, infoName: info?.getAttribute('aria-label') ?? null, infoText: text?.textContent ?? null }; })()`,
        admin.sessionId,
      );
      if (
        !seen ||
        seen.controls !== 0 ||
        !seen.value ||
        !commands.includes(seen.command) ||
        !seen.infoName?.trim() ||
        !seen.infoText?.trim()
      ) {
        throw new StepFailure(name, `${key} row ${JSON.stringify(seen)}`);
      }
    }
    // Every console-only row has the info control, not only these three.
    const withoutInfo = await cdp.evaluate(
      `[...document.querySelectorAll('.admin-row')].filter((r) => r.querySelector('button.admin-info') && !r.querySelector('button.admin-info').getAttribute('aria-label')?.trim()).length`,
      admin.sessionId,
    );
    if (withoutInfo !== 0) {
      throw new StepFailure(name, `${withoutInfo} info control(s) without an accessible name`);
    }
  });

  await check('i18n.persisted', async (name) => {
    await cdp.send('Target.closeTarget', { targetId: popup.targetId });
    const again = await openPage(cdp, extId, 'popup.html');
    await expectSoon(
      cdp,
      name,
      `document.documentElement.lang === '${to}' && ${footer} === ${JSON.stringify(I18N[to].footer)}`,
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
} catch (e) {
  exitCode = 1;
  const why = e instanceof StepFailure ? e.message : `setup: ${String(e?.stack ?? e)}`;
  console.log(`e2e: FAIL ${why}`);
  const tail = serverStderr.split('\n').filter(Boolean).slice(-15);
  if (tail.length) console.error(`server stderr (tail):\n${tail.join('\n')}`);
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
console.log(`e2e: ${exitCode === 0 ? 'ok' : 'FAIL'} in ${String(Math.round(now() - T0))} ms`);
process.exit(exitCode);
