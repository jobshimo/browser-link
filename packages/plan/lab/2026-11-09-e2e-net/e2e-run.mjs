// A2 + A3 + A4: one full end-to-end run with no human action.
//   isolated headless Chrome + the BUILT extension (loaded over CDP)
//   + the BUILT server (stdio MCP, ports moved by port-preload.mjs, temp data dir)
//   + a tab connected by sending the popup's own message from an extension page
//   + every tool call made through an MCP stdio client.
// Usage: node e2e-run.mjs <label>   -> writes results/e2e-<label>.json
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  LAB_DIR, REPO, SERVER_CLI, Cdp, extensionCopy, launchChrome, waitHttp, waitServiceWorker,
  stopChrome, removeDir, now, sleep,
} from './lib.mjs';

const label = process.argv[2] ?? 'run';
const WS_PORT = Number(process.env.LAB_WS_PORT ?? 27529);
const IPC_PORT = Number(process.env.LAB_IPC_PORT ?? 27530);
const CDP_PORT = Number(process.env.LAB_CDP_PORT ?? 29230);

const req = createRequire(join(REPO, 'packages/server/package.json'));
const { Client } = await import(pathToFileURL(req.resolve('@modelcontextprotocol/sdk/client/index.js')));
const { StdioClientTransport } = await import(pathToFileURL(req.resolve('@modelcontextprotocol/sdk/client/stdio.js')));

const out = { label, ports: { ws: WS_PORT, ipc: IPC_PORT, cdp: CDP_PORT }, phases: {}, calls: [], errors: [] };
const T0 = now();
const mark = (k) => (out.phases[k] = Math.round(now() - T0));

// Lab page over http (an http origin, like a real app; file:// is not used).
const html = readFileSync(join(LAB_DIR, 'page/index.html'));
const http = createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(html); });
await new Promise((r) => http.listen(0, '127.0.0.1', r));
const PAGE = `http://127.0.0.1:${http.address().port}/`;

const dataDir = mkdtempSync(join(tmpdir(), 'bl-e2e-data-'));
// On boot the server refreshes outdated agent-instruction blocks in the HOME
// of the user (~/.claude/CLAUDE.md, OpenCode AGENTS.md, Copilot). The first
// lab run did exactly that on the owner's machine. Two guards: the refresh is
// switched off in the lab's config.json, and HOME/USERPROFILE point at a temp dir.
writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ instructionsAutoRefresh: false }));
const homeDir = mkdtempSync(join(tmpdir(), 'bl-e2e-home-'));
const extDir = extensionCopy(WS_PORT);
let chrome, cdp, client, serverStderr = '';

function text(res) {
  return (res?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
}
function json(res) {
  try { return JSON.parse((res?.content ?? [])[0]?.text ?? ''); } catch { return null; }
}
async function call(name, args, check) {
  const t = now();
  let res, err;
  try { res = await client.callTool({ name, arguments: args }, undefined, { timeout: 45000 }); }
  catch (e) { err = e.message; }
  const ms = Math.round(now() - t);
  const body = res ? json(res) : null;
  let ok = !!res && !res.isError;
  let checkNote;
  if (ok && check) {
    try { const c = check(body, res); if (c !== true) { ok = false; checkNote = String(c); } else checkNote = 'passed'; }
    catch (e) { ok = false; checkNote = e.message; }
  }
  const entry = {
    tool: name, ok, ms,
    ...(err ? { error: err } : {}),
    ...(res?.isError ? { error: text(res).slice(0, 400) } : {}),
    ...(checkNote ? { check: checkNote } : {}),
  };
  out.calls.push(entry);
  console.error(`[${label}] ${name} ok=${ok} ${ms}ms${entry.error ? ' ' + entry.error : ''}${checkNote && checkNote !== 'passed' ? ' check: ' + checkNote : ''}`);
  return { res, body, ok };
}

try {
  // 1. Chrome + extension
  chrome = launchChrome({ port: CDP_PORT, extDir, mode: 'cdp' });
  const ver = await waitHttp(`http://127.0.0.1:${CDP_PORT}/json/version`);
  out.browser = ver.Browser;
  cdp = await Cdp.open(ver.webSocketDebuggerUrl);
  const { id: extId } = await cdp.send('Extensions.loadUnpacked', { path: extDir });
  const { sw } = await waitServiceWorker(cdp, 10000, extId);
  if (!sw) throw new Error('service worker did not start');
  mark('sw_ready');

  // 2. Server (stdio MCP) with isolated ports and data dir
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', pathToFileURL(join(LAB_DIR, 'port-preload.mjs')).href, SERVER_CLI],
    env: {
      ...process.env,
      BROWSER_LINK_DATA_DIR: dataDir,
      HOME: homeDir,
      USERPROFILE: homeDir,
      COPILOT_HOME: join(homeDir, '.copilot'),
      LAB_WS_PORT: String(WS_PORT),
      LAB_IPC_PORT: String(IPC_PORT),
    },
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (d) => (serverStderr += d.toString()));
  client = new Client({ name: 'e2e-net-lab', version: '0.0.0' });
  await client.connect(transport);
  out.server_version = client.getServerVersion();
  mark('mcp_initialized');
  // The WS bridge must be listening before the extension connects.
  out.bridge_version = await waitHttp(`http://127.0.0.1:${WS_PORT}/version`, 10000).catch((e) => ({ error: e.message }));
  mark('bridge_listening');

  // 3. Open the lab page as a tab, find its chrome tab id from the worker.
  await cdp.send('Target.createTarget', { url: PAGE });
  const { sessionId: swSession } = await cdp.send('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
  let tabId;
  for (let i = 0; i < 50 && !tabId; i++) {
    try {
      tabId = await cdp.evaluate(
        `chrome.tabs.query({}).then(ts => (ts.find(t => t.url === ${JSON.stringify(PAGE)} && t.status === 'complete') || {}).id ?? null)`,
        swSession,
      );
    } catch {}
    if (!tabId) await sleep(100);
  }
  if (!tabId) throw new Error('lab tab not found from the worker');

  // 4. Connect: the popup's own message, sent from an extension page target
  //    (a worker's runtime.sendMessage does not reach its own onMessage).
  const { targetId: popupTarget } = await cdp.send('Target.createTarget', { url: `chrome-extension://${extId}/popup.html` });
  const { sessionId: popupSession } = await cdp.send('Target.attachToTarget', { targetId: popupTarget, flatten: true });
  const connectMessage = { action: 'connect', tabId };
  out.connect_message = { action: 'connect', tabId: '<chrome tab id (number)>' };
  let connectResponse;
  const tc = now();
  for (let i = 0; i < 50 && connectResponse === undefined; i++) {
    try { connectResponse = await cdp.evaluate(`chrome.runtime.sendMessage(${JSON.stringify(connectMessage)})`, popupSession); }
    catch { await sleep(100); }
  }
  out.connect_ms = Math.round(now() - tc);
  out.connect_response = connectResponse;
  mark('connect_answered');
  if (!connectResponse?.ok) throw new Error('connect failed: ' + JSON.stringify(connectResponse));
  await cdp.send('Target.closeTarget', { targetId: popupTarget });

  // 5. Tool calls through MCP.
  let tab;
  const tl = now();
  for (let i = 0; i < 50; i++) {
    const r = await client.callTool({ name: 'browser.list_tabs', arguments: {} });
    const tabs = json(r) ?? [];
    tab = Array.isArray(tabs) ? tabs.find((t) => t.url === PAGE) : undefined;
    if (tab) break;
    await sleep(100);
  }
  out.calls.push({ tool: 'browser.list_tabs', ok: !!tab, ms: Math.round(now() - tl), check: tab ? 'lab tab listed' : 'tab never listed' });
  console.error(`[${label}] browser.list_tabs ok=${!!tab}`);
  if (!tab) throw new Error('tab not listed');
  out.listed_tab_shape = Object.keys(tab);
  mark('tab_listed');
  const T = tab.tab_id;

  await call('browser.snapshot', { tab_id: T }, (b, r) => /Add item/.test(text(r)) || 'snapshot lacks the button');
  const found = await call('browser.find', { tab_id: T, text: 'Add item', role: 'button' }, (b, r) => /:e\d+/.test(text(r)) || 'no ref');
  const ref = text(found.res).match(/[a-z0-9]{1,16}:e\d+/)?.[0];
  await call('browser.type', { tab_id: T, selector: '#name', text: 'alpha' });
  await call('browser.click', { tab_id: T, ref, expect: { text_appears: 'Added: alpha' } }, (b, r) => /"met":\s*true/.test(text(r)) || 'expect not met');
  await call('browser.wait_for', { tab_id: T, selector: '#done', condition: 'visible', timeout_ms: 5000 }, (b) => b?.matched === true || 'not matched');
  await call('browser.press', { tab_id: T, key: 'Enter', selector: '#name', expect: { text_appears: 'Items: 2' } }, (b, r) => /"met":\s*true/.test(text(r)) || 'expect not met');
  // browser.read needs a KEPT reader: evaluate names it, wrap_up keeps it (setup calls).
  await call('browser.evaluate', { tab_id: T, expression: "document.querySelector('#count').textContent", as: 'item-count-text' });
  const w1 = await call('browser.wrap_up', {});
  out.wrap_up_step1 = w1.body ?? text(w1.res).slice(0, 1500);
  const rid = findReaderId(w1.body, 'item-count-text');
  await call('browser.wrap_up', { readers: { keep: [{ id: rid, name: 'item-count-text' }] } });
  await call('browser.read', { tab_id: T, name: 'item-count-text' }, (b, r) => /Items: 2/.test(text(r)) || `unexpected: ${text(r).slice(0, 100)}`);
  await call('browser.flow', {
    tab_id: T,
    steps: [
      { type: { selector: '#name', text: 'gamma', clear: true } },
      { find: { text: 'Add item', role: 'button' } },
      { click: { expect: { text_appears: 'Items: 3' } } },
      { wait_for: { selector: '#done', condition: 'visible' } },
    ],
  }, (b, r) => !/"ok":\s*false/.test(text(r)) || 'a step failed');
  mark('calls_done');
} catch (e) {
  out.errors.push(e.message);
} finally {
  const td = now();
  try { await client?.close(); } catch {}
  if (chrome) out.chrome_clean_exit = await stopChrome(chrome, cdp);
  cdp?.close();
  http.close();
  out.teardown_ms = Math.round(now() - td);
  out.total_ms = Math.round(now() - T0);
  out.cleanup = {
    profile_removed: chrome ? await removeDir(chrome.profile) : true,
    ext_copy_removed: await removeDir(extDir),
    data_dir_removed: await removeDir(dataDir),
    home_dir_removed: await removeDir(homeDir),
  };
  out.instruction_refresh_logged = /Agent instructions refreshed/.test(serverStderr);
  out.server_stderr_tail = serverStderr.split('\n').filter(Boolean).slice(-15);
  out.all_ok = out.errors.length === 0 && out.calls.every((c) => c.ok);
  writeFileSync(join(LAB_DIR, `results/e2e-${label}.json`), JSON.stringify(out, null, 2) + '\n');
  console.log(JSON.stringify({ label, all_ok: out.all_ok, total_ms: out.total_ms, phases: out.phases, errors: out.errors }, null, 2));
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
