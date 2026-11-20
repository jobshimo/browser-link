// Experiment X1 (docs/design/cdp-direct-parity.md, section 6): what cdp-direct
// does today, with no DialogWatch, when a page opens a JavaScript dialog.
// Run: CHROME_PATH=<chrome> node x1-dialogs.mjs <label>   (stdout is the record)
// Drives the real built server over MCP exactly as packages/e2e/src/run.mjs
// does for its cdp-direct phase (second headless Chrome, cdp-direct enabled and
// granted with the built CLI in an isolated env), and observes the dialog
// events with the server's own CdpClient (dist/cdp/client.js) dialed the way
// transport.ts `dial` does (Target.getTargetInfo, then Page.enable).
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const E2E_SRC = resolve(HERE, '../../../e2e/src');
const SDK = resolve(HERE, '../../../e2e/node_modules/@modelcontextprotocol/sdk/dist/esm');
const SERVER_DIST = resolve(HERE, '../../../server/dist');
const lib = await import(pathToFileURL(join(E2E_SRC, 'lib.mjs')).href);
const { enableCdpDirect } = await import(pathToFileURL(join(E2E_SRC, 'cdp-direct.mjs')).href);
const { Client } = await import(pathToFileURL(join(SDK, 'client/index.js')).href);
const { StdioClientTransport } = await import(pathToFileURL(join(SDK, 'client/stdio.js')).href);
const { CdpClient } = await import(pathToFileURL(join(SERVER_DIST, 'cdp/client.js')).href);
const { sleep, now, freePort, launchChrome, waitHttp, Cdp, isolatedServerEnv, stopChrome } = lib;

const label = process.argv[2] ?? 'run';
const T0 = now();
const stamp = () => `+${String(Math.round(now() - T0)).padStart(6)}ms`;
const log = (...a) => console.log(stamp(), ...a);
const MAX_TEXT = 1500;
const clip = (s) =>
  s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)} [clipped ${s.length - MAX_TEXT} chars]` : s;

const chromePath = lib.resolveChrome();
const primaryBefore = [...new Set(lib.DEFAULT_PORTS.flatMap((p) => lib.portOwners(p)))];
log(`label=${label} chrome=${chromePath}`);
log(`owner primary pids on 17529/17530 before: ${JSON.stringify(primaryBefore)}`);

// --- environment: fixture over http, isolated server env, second Chrome ---
const html = readFileSync(join(HERE, 'fixture.html'));
const http = createServer((_q, r) => {
  r.writeHead(200, { 'content-type': 'text/html' });
  r.end(html);
});
await new Promise((r) => http.listen(0, '127.0.0.1', r));
const pageUrl = `http://127.0.0.1:${String(http.address().port)}/`;
const [wsPort, ipcPort, cdpPort] = [await freePort(), await freePort(), await freePort()];
const dataDir = mkdtempSync(join(tmpdir(), 'bl-x1-data-'));
writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ instructionsAutoRefresh: false }));
const homeDir = mkdtempSync(join(tmpdir(), 'bl-x1-home-'));
const serverEnv = isolatedServerEnv({ wsPort, ipcPort, dataDir, homeDir });
const chrome = launchChrome({ chromePath, port: cdpPort });
const version = await waitHttp(`http://127.0.0.1:${String(cdpPort)}/json/version`, 20_000);
log(
  `browser=${version.Browser} protocol=${version['Protocol-Version']} ports ws=${wsPort} ipc=${ipcPort} cdp=${cdpPort} page=${pageUrl}`,
);
const browser = await Cdp.open(version.webSocketDebuggerUrl);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [lib.SERVER_CLI],
  env: serverEnv,
  stderr: 'pipe',
});
let serverStderr = '';
transport.stderr?.on('data', (d) => (serverStderr += String(d)));
const mcp = new Client({ name: 'x1-dialogs', version: '0.0.0' });
await mcp.connect(transport);
await waitHttp(`http://127.0.0.1:${String(wsPort)}/version`, 15_000);
for (const out of enableCdpDirect({ serverCli: lib.SERVER_CLI, env: serverEnv, port: cdpPort })) {
  if (out.trim()) log(`cli: ${out.trim().replace(/\s+/g, ' ')}`);
}

const CALL_MS = 60_000;
/** One MCP call, timed; prints the exact answer. */
async function tool(name, args, note = '') {
  const t = now();
  let res;
  try {
    res = await mcp.callTool({ name, arguments: args }, undefined, { timeout: CALL_MS });
  } catch (e) {
    log(
      `CALL ${name} ${JSON.stringify(args)} ${note} -> THROWN after ${Math.round(now() - t)}ms: ${e?.message ?? e}`,
    );
    return { thrown: String(e?.message ?? e) };
  }
  const text = (res.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
  log(
    `CALL ${name} ${JSON.stringify(args)} ${note} -> isError=${res.isError === true} duration=${Math.round(now() - t)}ms`,
  );
  log(`  text: ${clip(text).replace(/\n/g, '\n        ')}`);
  return { isError: res.isError === true, text };
}

async function newTab(url) {
  const { targetId } = await browser.send('Target.createTarget', { url });
  const tabId = `cdp:${targetId}`;
  const t = now();
  for (;;) {
    const r = await mcp.callTool({ name: 'browser.list_tabs', arguments: {} }, undefined, {
      timeout: CALL_MS,
    });
    let tabs = [];
    try {
      tabs = JSON.parse(r.content[0].text);
    } catch {
      // not json
    }
    if (Array.isArray(tabs) && tabs.some((x) => x.tab_id === tabId)) break;
    if (now() - t > 30_000) throw new Error(`tab ${tabId} never listed`);
    await sleep(100);
  }
  // The page has loaded when its fixture button exists (harness session; the
  // Page domain is never enabled on it).
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  for (let i = 0; i < 100; i++) {
    const v = await browser
      .evaluate(`!!document.querySelector('#alert-btn')`, sessionId)
      .catch(() => false);
    if (v) break;
    await sleep(50);
  }
  return { targetId, tabId, sessionId };
}

/** A connection dialed as transport.ts `dial` does, recording every event. */
async function dialRaw(targetId, name) {
  const wsUrl = `ws://127.0.0.1:${String(cdpPort)}/devtools/page/${targetId}`;
  const c = new CdpClient(wsUrl);
  const events = [];
  c.onAny((method, params) => {
    if (method.startsWith('Page.javascriptDialog')) {
      events.push({ method, params });
      log(`  [${name}] EVENT ${method} ${JSON.stringify(params)}`);
    }
  });
  await c.connect();
  const info = await c.send('Target.getTargetInfo');
  log(`  [${name}] connected, type=${info.targetInfo.type}`);
  const t = now();
  try {
    await c.send('Page.enable');
    log(`  [${name}] Page.enable answered after ${Math.round(now() - t)}ms`);
  } catch (e) {
    log(`  [${name}] Page.enable FAILED after ${Math.round(now() - t)}ms: ${e.message}`);
  }
  return { c, events };
}

async function handle(raw, name, accept, promptText) {
  const t = now();
  const params = { accept, ...(promptText === undefined ? {} : { promptText }) };
  try {
    const r = await raw.c.send('Page.handleJavaScriptDialog', params, 5000);
    log(
      `  [${name}] Page.handleJavaScriptDialog ${JSON.stringify(params)} -> ${JSON.stringify(r)} after ${Math.round(now() - t)}ms; connection open after: ${raw.c.isOpen}`,
    );
  } catch (e) {
    log(
      `  [${name}] Page.handleJavaScriptDialog ${JSON.stringify(params)} FAILED after ${Math.round(now() - t)}ms: ${e.message}; connection open after: ${raw.c.isOpen}`,
    );
  }
}

/** A connection that never enables Page, answering a dialog that is open. */
async function handleWithoutEnable(targetId, name, accept = true) {
  const c = new CdpClient(`ws://127.0.0.1:${String(cdpPort)}/devtools/page/${targetId}`);
  await c.connect();
  const t = now();
  try {
    const r = await c.send('Page.handleJavaScriptDialog', { accept }, 5000);
    log(`  [${name}] (no Page.enable) Page.handleJavaScriptDialog -> ${JSON.stringify(r)} after ${Math.round(now() - t)}ms`);
  } catch (e) {
    log(`  [${name}] (no Page.enable) Page.handleJavaScriptDialog FAILED after ${Math.round(now() - t)}ms: ${e.message}`);
  }
  c.close();
}

async function safeClose(tab) {
  // Cleanup only: dismiss a dialog still open, then close the target.
  const guard = new Promise((r) => setTimeout(r, 3000));
  await Promise.race([
    browser.send('Page.handleJavaScriptDialog', { accept: true }, tab.sessionId).catch(() => {}),
    guard,
  ]);
  await browser.send('Target.closeTarget', { targetId: tab.targetId }).catch(() => {});
}

const kinds = [
  ['alert', '#alert-btn'],
  ['confirm', '#confirm-btn'],
  ['prompt', '#prompt-btn'],
];

// ---- Part 1: a click opens a dialog, nobody else is connected. Items 1, 2, and 3/4 for a late connection. ----
for (const [kind, sel] of kinds) {
  log(`===== CASE click-${kind}: server dialed before the click; the click opens ${kind}() =====`);
  const tab = await newTab(pageUrl);
  await tool('browser.snapshot', { tab_id: tab.tabId }, '(first call: dials)');
  await tool('browser.click', { tab_id: tab.tabId, selector: sel }, `(opens ${kind})`);
  await tool('browser.evaluate', { tab_id: tab.tabId, expression: '1+1' }, '(dialog still open)');
  await tool('browser.snapshot', { tab_id: tab.tabId }, '(dialog still open)');
  log('  -- a connection dialed now, with the dialog already open (lazy-dial shape) --');
  const late = await dialRaw(tab.targetId, 'late');
  await sleep(500);
  log(`  [late] dialog events seen after dial+500ms: ${late.events.length}`);
  await handle(late, 'late', true, kind === 'prompt' ? 'typed' : undefined);
  await handleWithoutEnable(tab.targetId, 'bare');
  await sleep(500);
  await tool(
    'browser.evaluate',
    { tab_id: tab.tabId, expression: "document.querySelector('#out').textContent" },
    '(after the attempts to accept)',
  );
  await tool('browser.snapshot', { tab_id: tab.tabId }, '(after the attempts to accept)');
  late.c.close();
  await safeClose(tab);
}

// ---- Part 2: a connection present before the dialog opens. Items 3 and 4, dialed before. ----
for (const [kind, sel] of kinds) {
  log(
    `===== CASE observer-${kind}: an observer connection (server's CdpClient, Page.enable) exists before the click =====`,
  );
  const tab = await newTab(pageUrl);
  await tool('browser.snapshot', { tab_id: tab.tabId }, '(first call: dials)');
  const obs = await dialRaw(tab.targetId, 'obs');
  const t = now();
  const clickP = tool('browser.click', { tab_id: tab.tabId, selector: sel }, `(opens ${kind})`);
  await sleep(1500);
  log(`  [obs] events 1.5s after click start: ${JSON.stringify(obs.events.map((e) => e.method))}`);
  await handle(obs, 'obs', true, kind === 'prompt' ? 'typed' : undefined);
  const res = await clickP;
  log(
    `  click call settled ${Math.round(now() - t)}ms after it started: ${JSON.stringify(res).slice(0, 300)}`,
  );
  await sleep(300);
  log(`  [obs] events total: ${JSON.stringify(obs.events.map((e) => e.method))}`);
  await tool(
    'browser.evaluate',
    { tab_id: tab.tabId, expression: "document.querySelector('#out').textContent" },
    '(after accept)',
  );
  obs.c.close();
  await safeClose(tab);
}

// ---- Part 3: an alert opened by a timer, not by the click. ----
log('===== CASE timer-alert: the click only arms a 1.5 s timer; the alert opens by itself =====');
{
  const tab = await newTab(pageUrl);
  await tool('browser.snapshot', { tab_id: tab.tabId }, '(first call: dials)');
  const obs = await dialRaw(tab.targetId, 'obs');
  await tool('browser.click', { tab_id: tab.tabId, selector: '#timer-btn' }, '(arms the timer)');
  await sleep(2500);
  log(`  [obs] events 2.5s after the click returned: ${JSON.stringify(obs.events.map((e) => e.method))}`);
  await tool('browser.evaluate', { tab_id: tab.tabId, expression: '1+1' }, '(timer alert open)');
  await tool('browser.snapshot', { tab_id: tab.tabId }, '(timer alert open)');
  await handle(obs, 'obs', true);
  await sleep(300);
  await tool(
    'browser.evaluate',
    { tab_id: tab.tabId, expression: "document.querySelector('#out').textContent" },
    '(after accept)',
  );
  log(`  [obs] events total: ${JSON.stringify(obs.events.map((e) => e.method))}`);
  obs.c.close();
  await safeClose(tab);
}

// ---- Part 4: dialog already open before the server's first call (lazy dial). Items 3 and 4. ----
for (const kind of ['alert', 'confirm']) {
  log(`===== CASE preopen-${kind}: ${kind}() is open before the server's first call on the tab =====`);
  const tab = await newTab(pageUrl);
  // A timer, so that Runtime.evaluate answers; the harness session has no Page domain.
  await browser.send(
    'Runtime.evaluate',
    { expression: `setTimeout(function () { window.__r = ${kind}('pre'); }, 0)` },
    tab.sessionId,
  );
  await sleep(700);
  await tool(
    'browser.snapshot',
    { tab_id: tab.tabId },
    `(first call on the tab, ${kind} already open: lazy dial)`,
  );
  const late = await dialRaw(tab.targetId, 'late');
  await sleep(500);
  log(`  [late] dialog events replayed on Page.enable: ${JSON.stringify(late.events.map((e) => e.method))}`);
  await handle(late, 'late', true);
  await handleWithoutEnable(tab.targetId, 'bare');
  await sleep(500);
  await tool(
    'browser.evaluate',
    { tab_id: tab.tabId, expression: 'String(window.__r)' },
    '(after the attempts to accept)',
  );
  await tool('browser.snapshot', { tab_id: tab.tabId }, '(after the attempts to accept)');
  late.c.close();
  await safeClose(tab);
}

// ---- teardown ----
log('===== teardown =====');
await mcp.close().catch(() => {});
await stopChrome(chrome, browser);
browser.close();
http.close();
await lib.removeDir(dataDir);
await lib.removeDir(homeDir);
await lib.removeDir(chrome.profile);
const dead = primaryBefore.filter((pid) => !lib.isAlive(pid));
log(
  dead.length
    ? `FAIL owner primary pid ${dead.join(',')} no longer alive`
    : `owner primary: ${primaryBefore.length ? `pid ${primaryBefore.join(',')} still alive` : 'none was running'}`,
);
log(`server stderr tail: ${JSON.stringify(serverStderr.slice(-600))}`);
process.exit(dead.length ? 1 : 0);
