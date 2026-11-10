// Real-Chrome end-to-end net (`pnpm test:e2e`): the BUILT extension in an
// isolated headless Chrome, the BUILT server over MCP stdio, a tab connected
// without a human, and nine tool calls whose effects are asserted, so the
// extension half of every call (background.ts perform* handlers) runs for real.
// Then the interface language: switch EN | ES in the popup, open Activity and
// Admin windows follow without reload, and the choice survives a reopen.
//
// Isolation: free ports passed through BROWSER_LINK_WS_PORT / _IPC_PORT, a
// patched temp copy of the extension, temp profile, data dir and HOME. The
// owner's own browser-link on 17529/17530 is never touched (asserted at the end).
//
// Env: CHROME_PATH (Chrome/Chromium >= 118), E2E_NO_SANDBOX=1 (Linux CI),
// E2E_EXPECT_FAIL=<tool> forces that tool's assertion to fail (RED probe).
// Exit 0 only when every call passes; 1 names the failing tool.
// Shape and numbers: packages/plan/lab/2026-11-09-e2e-net/README.md.
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  waitServiceWorker,
} from './lib.mjs';

const CALL_TIMEOUT_MS = 45_000;
const TOTAL_TIMEOUT_MS = 180_000;
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
 * (or a string saying what is wrong). Prints `tool ok ms`. */
async function call(tool, args, check, { print = true } = {}) {
  const short = tool.replace(/^browser\./, '');
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
  if (print) console.log(`${tool} ok ${String(ms)}`);
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
  state.http = createServer((_q, r) => {
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

  // 1. Chrome + the extension (branded Chrome ignores --load-extension).
  state.chrome = launchChrome({ chromePath, port: cdpPort });
  temps.push(state.chrome.profile);
  const version = await waitHttp(`http://127.0.0.1:${String(cdpPort)}/json/version`, 20_000);
  state.cdp = await Cdp.open(version.webSocketDebuggerUrl);
  const { cdp } = state;
  const { id: extId } = await cdp.send('Extensions.loadUnpacked', { path: extDir });
  // The manifest `key` pins the id; the patched temp copy must keep it.
  const pinnedId = await pinnedExtensionId();
  if (extId !== pinnedId) {
    throw new StepFailure('extension.id', `Chrome assigned ${extId}, the server pins ${pinnedId}`);
  }
  console.log(`extension.id ok ${extId}`);
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

  // 5. The nine calls.
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
  await call('browser.type', { tab_id: T, selector: '#name', text: 'alpha' });
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

  // 0.52.0 logs a lockout notice for every accepted handshake whose Origin
  // is not exactly the pinned extension's (a missing Origin included): none
  // here means the worker's bridge socket announced chrome-extension://<id>.
  const notice = serverStderr.split('\n').find((l) => l.includes('1.0.0 will refuse'));
  if (notice !== undefined) throw new StepFailure('bridge.origin', notice);
  console.log(`bridge.origin ok chrome-extension://${extId} (no lockout notice logged)`);

  await languageChecks(cdp, extId);
}

/** The interface language through the real built extension (EN | ES in the
 * header): one line per check, `i18n.<check> ok ms`. */
const I18N = {
  en: {
    footer: 'manual · per-tab · loopback only',
    notice: 'Read notice',
    activity: 'Activity',
    status: 'Status',
  },
  es: {
    footer: 'manual · por pestaña · solo loopback',
    notice: 'Ver aviso',
    activity: 'Actividad',
    status: 'Estado',
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
