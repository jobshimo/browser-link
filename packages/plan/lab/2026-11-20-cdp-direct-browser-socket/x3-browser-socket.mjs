// Experiment X3 (docs/design/cdp-direct-parity.md, section 6): the browser-level
// CDP socket, for P7 (G11 wait_for_tab, G10 set_permission).
// Run: CHROME_PATH=<chrome> node x3-browser-socket.mjs <label>   (stdout is the record)
// Pure CDP, no MCP server. Sockets are the server's own CdpClient (built dist):
// the browser-level one dials the `webSocketDebuggerUrl` of /json/version, page
// ones dial /devtools/page/<id> as transport.ts `dial` does. Headless, own profile.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_DIST = resolve(HERE, '../../../server/dist');
const lib = await import(pathToFileURL(join(HERE, '../../../e2e/src/lib.mjs')).href);
const { CdpClient } = await import(pathToFileURL(join(SERVER_DIST, 'cdp/client.js')).href);
const { sleep, now, freePort, launchChrome, waitHttp, stopChrome } = lib;

const label = process.argv[2] ?? 'run';
const T0 = now();
const log = (...a) => console.log(`+${String(Math.round(now() - T0)).padStart(6)}ms`, ...a);
const clip = (s, n = 900) => (s.length > n ? `${s.slice(0, n)} [clipped ${s.length - n} chars]` : s);

const chromePath = lib.resolveChrome();
const primaryBefore = [...new Set(lib.DEFAULT_PORTS.flatMap((p) => lib.portOwners(p)))];
log(`label=${label} chrome=${chromePath}`);
log(`owner primary pids on 17529/17530 before: ${JSON.stringify(primaryBefore)}`);

const html = readFileSync(join(HERE, 'fixture.html'));
const http = createServer((q, r) => {
  const path = q.url.split('?')[0];
  if (path === '/child') return r.writeHead(200, { 'content-type': 'text/html' }).end('<title>child</title><p>child</p>');
  if (path === '/') return r.writeHead(200, { 'content-type': 'text/html' }).end(html);
  r.writeHead(404).end();
});
await new Promise((r) => http.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${String(http.address().port)}`;
const pageUrl = `${origin}/`;
const cdpPort = await freePort();
const chrome = launchChrome({ chromePath, port: cdpPort });
const base = `http://127.0.0.1:${String(cdpPort)}`;
const version = await waitHttp(`${base}/json/version`, 20_000);
log(`browser=${version.Browser} protocol=${version['Protocol-Version']} cdp=${cdpPort} origin=${origin}`);
log(`/json/version keys: ${JSON.stringify(Object.keys(version))}`);
log(`/json/version webSocketDebuggerUrl shape: ${version.webSocketDebuggerUrl.replace(/[0-9a-f-]{36}/, '<uuid>')}`);

const jsonList = async () => (await fetch(`${base}/json/list`)).json();
/** One send, printing exact error text instead of throwing. */
async function tryCall(conn, method, params = {}, note = '') {
  const t = now();
  try {
    const r = await conn.c.send(method, params, 5000);
    log(`  [${conn.name}] ${method} ${JSON.stringify(params)} ${note}-> ${clip(JSON.stringify(r))} (${Math.round(now() - t)}ms)`);
    return { ok: true, r };
  } catch (e) {
    log(`  [${conn.name}] ${method} ${JSON.stringify(params)} ${note}FAILED: ${e.message} (${Math.round(now() - t)}ms)`);
    return { ok: false, error: e.message };
  }
}
async function dialBrowser(name) {
  const c = new CdpClient(version.webSocketDebuggerUrl);
  const events = [];
  c.onAny((method, params) => events.push({ method, params, at: now() }));
  await c.connect();
  return { c, events, name };
}
async function dialPage(targetId, name) {
  const c = new CdpClient(`ws://127.0.0.1:${String(cdpPort)}/devtools/page/${targetId}`);
  await c.connect();
  const info = await c.send('Target.getTargetInfo');
  await c.send('Page.enable');
  return { c, name, info: info.targetInfo, events: [] };
}
const evalIn = async (conn, expression, userGesture = false) => {
  const r = await conn.c.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture });
  return r.exceptionDetails ? `EXC:${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}` : r.result.value;
};
async function openTab(bconn, url, browserContextId) {
  const { targetId } = await bconn.c.send('Target.createTarget', { url, ...(browserContextId ? { browserContextId } : {}) });
  const p = await dialPage(targetId, `page-${targetId.slice(0, 4)}`);
  for (let i = 0; i < 100; i++) {
    if ((await evalIn(p, 'document.readyState')) === 'complete') break;
    await sleep(50);
  }
  return p;
}

// ===== Part A: what the browser-level socket is =====
log('===== PART A: browser-level socket basics =====');
const b = await dialBrowser('browser');
await tryCall(b, 'Browser.getVersion');
const tabD = await openTab(b, pageUrl);
log(`  default-context tab: targetId=${tabD.info.targetId} browserContextId=${tabD.info.browserContextId} type=${tabD.info.type} openerId=${tabD.info.openerId}`);
await tryCall(b, 'Target.getBrowserContexts');
log(`  /json/list entry keys of the tab: ${JSON.stringify(Object.keys((await jsonList()).find((t) => t.id === tabD.info.targetId)))}`);
log(`  /json/list entry: ${JSON.stringify((await jsonList()).find((t) => t.id === tabD.info.targetId))}`);

// ===== Part B: Browser.setPermission on a page socket vs the browser socket =====
// Every probe uses its OWN permission name on the same origin, so no probe can be
// confounded by an earlier one (an earlier draft of this part reused
// "notifications" and could not tell which socket had granted it). State is read
// with navigator.permissions.query, in a default-context tab and a tab of a second
// browser context, both on the same origin.
log('===== PART B: Browser.setPermission =====');
const perm = (name, setting) => ({ permission: { name }, setting, origin });
const q = (conn, name) => evalIn(conn, `navigator.permissions.query({ name: '${name}' }).then((s) => s.state).catch((e) => 'EXC:' + e.message)`);
const ctx = (await b.c.send('Target.createBrowserContext')).browserContextId;
log(`  Target.createBrowserContext -> ${ctx}`);
const tabX = await openTab(b, pageUrl, ctx);
log(`  default-context tab browserContextId=${tabD.info.browserContextId}; second-context tab browserContextId=${tabX.info.browserContextId}`);
const NAMES = ['notifications', 'geolocation', 'midi', 'clipboard-read', 'persistent-storage', 'idle-detection', 'camera'];
const state = async (tag) => {
  const row = {};
  for (const n of NAMES) row[n] = `${await q(tabD, n)}/${await q(tabX, n)}`;
  log(`  states (default-tab/second-ctx-tab) ${tag}: ${JSON.stringify(row)}`);
};
await state('baseline');

log('  -- (1) the PAGE socket of the default-context tab --');
await tryCall(tabD, 'Browser.setPermission', perm('notifications', 'granted'), '(page socket, context omitted) ');
await state('after (1)');
log('  -- (2) the PAGE socket of the SECOND-context tab, context omitted --');
await tryCall(tabX, 'Browser.setPermission', perm('geolocation', 'granted'), '(page socket of the second-context tab, context omitted) ');
await state('after (2)');
await tryCall(tabD, 'Browser.getVersion', {}, '(page socket) ');
await tryCall(tabD, 'Browser.grantPermissions', { permissions: ['midi'], origin }, '(page socket) ');
await state('after Browser.grantPermissions midi on the page socket');
log('  -- (3) the BROWSER socket --');
await tryCall(b, 'Browser.setPermission', perm('clipboard-read', 'granted'), '(browser socket, context omitted) ');
await state('after (3)');
await tryCall(b, 'Browser.setPermission', { ...perm('persistent-storage', 'granted'), browserContextId: ctx }, '(browser socket, explicit second context) ');
await state('after (4: persistent-storage, explicit second context)');
await tryCall(b, 'Browser.setPermission', { ...perm('camera', 'granted'), browserContextId: tabD.info.browserContextId }, '(browser socket, the default tab\'s own browserContextId) ');
await tryCall(b, 'Target.getBrowserContexts', {}, '(is the default context listed?) ');
await tryCall(b, 'Browser.setPermission', { ...perm('camera', 'granted'), browserContextId: 'NOSUCHCONTEXT' }, '(unknown context id) ');
await tryCall(b, 'Browser.setPermission', perm('no-such-permission', 'granted'), '(unknown permission name) ');
await tryCall(b, 'Browser.setPermission', { permission: { name: 'camera' }, setting: 'maybe', origin }, '(invalid setting) ');
await tryCall(b, 'Browser.setPermission', { permission: { name: 'idle-detection' }, setting: 'granted' }, '(origin omitted) ');
await state('after origin omitted (idle-detection)');

log('  -- (5) lifetime: does an override outlive the socket that set it? --');
await tryCall(b, 'Browser.setPermission', perm('midi', 'granted'), '(browser socket) ');
const pS = await dialPage(tabD.info.targetId, 'page-socket-2');
await tryCall(pS, 'Browser.setPermission', perm('idle-detection', 'granted'), '(a second page socket of the same tab) ');
await state('before closing any socket');
pS.c.close();
await sleep(400);
await state('after closing the second PAGE socket (set idle-detection)');
b.c.close();
await sleep(500);
await state('after closing the BROWSER socket (set clipboard-read, persistent-storage, midi)');
const b2 = await dialBrowser('browser-2');
const tabAgain = await openTab(b2, pageUrl);
log(`  a NEW tab on the same origin, new browser socket: clipboard-read=${await q(tabAgain, 'clipboard-read')} midi=${await q(tabAgain, 'midi')}`);
await tryCall(b2, 'Browser.setPermission', perm('midi', 'granted'), '(browser-2) ');
log('  -- (6) who resets an override: the socket that set it, or any socket closing? --');
const quiet = await dialPage(tabAgain.info.targetId, 'page-socket-quiet');
await sleep(200);
quiet.c.close();
await sleep(400);
log(`  after a page socket that only did getTargetInfo+Page.enable closed: midi=${await q(tabAgain, 'midi')}`);
const bQuiet = await dialBrowser('browser-quiet');
await tryCall(bQuiet, 'Browser.getVersion', {}, '(a second browser socket, no permission command) ');
bQuiet.c.close();
await sleep(400);
log(`  after a second browser socket that never set a permission closed: midi=${await q(tabAgain, 'midi')}`);
const pGetter = await dialPage(tabAgain.info.targetId, 'page-socket-getversion');
await tryCall(pGetter, 'Browser.getVersion', {}, '(page socket, a Browser.* command that sets nothing) ');
pGetter.c.close();
await sleep(400);
log(`  after a page socket that sent Browser.getVersion closed: midi=${await q(tabAgain, 'midi')}`);
const pSetter = await dialPage(tabAgain.info.targetId, 'page-socket-setter');
await tryCall(pSetter, 'Browser.setPermission', perm('geolocation', 'granted'), '(page socket that sets another permission) ');
pSetter.c.close();
await sleep(400);
log(`  after a page socket that SET geolocation closed: midi=${await q(tabAgain, 'midi')} geolocation=${await q(tabAgain, 'geolocation')}`);
await tryCall(b2, 'Browser.setPermission', perm('midi', 'granted'), '(browser-2, again) ');
await tryCall(b2, 'Browser.resetPermissions', {}, '(Browser.resetPermissions, same socket) ');
log(`  after Browser.resetPermissions on the same socket: midi=${await q(tabAgain, 'midi')}`);
await tryCall(b2, 'Target.disposeBrowserContext', { browserContextId: ctx }, '(cleanup) ');
tabX.c.close();
tabAgain.c.close();
b2.c.close();

// ===== Part C: openerId on Target.targetCreated =====
log('===== PART C: openers =====');
const bd = await dialBrowser('discover');
const targetsAttached = async () => (await bd.c.send('Target.getTargets')).targetInfos.map((t) => ({ id: t.targetId.slice(0, 6), type: t.type, attached: t.attached, openerId: t.openerId }));
log(`  Target.getTargets BEFORE setDiscoverTargets (no discovery): ${JSON.stringify(await targetsAttached())}`);
await tryCall(bd, 'Target.setDiscoverTargets', { discover: true });
await sleep(400);
log(`  events from the initial discovery: ${JSON.stringify(bd.events.map((e) => `${e.method}:${e.params.targetInfo?.type}:${e.params.targetInfo?.url?.slice(0, 40)}`))}`);
log(`  Target.getTargets AFTER setDiscoverTargets: ${JSON.stringify(await targetsAttached())}`);
const opener = await openTab(bd, pageUrl);
log(`  opener tab ${opener.info.targetId} (browserContextId=${opener.info.browserContextId})`);
bd.events.length = 0;

const clickAt = async (selector) => {
  const rect = await evalIn(opener, `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await opener.c.send('Input.dispatchMouseEvent', { type, x: rect[0], y: rect[1], button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: type === 'mouseMoved' ? 0 : 1 });
  }
};
const cases = [
  ['script-window-open-with-userGesture', () => evalIn(opener, 'window.openFromScript() && 1', true)],
  ['script-window-open-NO-userGesture', () => evalIn(opener, 'String(window.openFromScript())', false)],
  ['click-window-open-button', () => clickAt('#open-btn')],
  ['click-target-blank-link', () => clickAt('#blank-link')],
  ['click-target-blank-noopener-link', () => clickAt('#noopener-link')],
  ['click-window-open-noopener-button', () => clickAt('#noopener-btn')],
  ['script-window-open-noopener-with-userGesture', () => evalIn(opener, 'window.openNoopenerFromScript() && 1', true)],
];
for (const [name, trigger] of cases) {
  log(`===== CASE ${name} =====`);
  const from = bd.events.length;
  const t0 = now();
  const result = await trigger();
  log(`  trigger returned ${JSON.stringify(result)} after ${Math.round(now() - t0)}ms`);
  await sleep(1200);
  const ev = bd.events.slice(from).filter((e) => e.method.startsWith('Target.'));
  if (ev.length === 0) log('  no Target.* event arrived within 1200ms');
  for (const e of ev) {
    const ti = e.params.targetInfo ?? {};
    log(`  +${String(Math.round(e.at - t0)).padStart(4)}ms after the trigger started: ${e.method} ${JSON.stringify(e.params)}`);
    void ti;
  }
  const created = ev.filter((e) => e.method === 'Target.targetCreated' && e.params.targetInfo.type === 'page');
  for (const e of created) {
    const id = e.params.targetInfo.targetId;
    const gt = (await bd.c.send('Target.getTargets')).targetInfos.find((t) => t.targetId === id);
    log(`  Target.getTargets entry now: ${JSON.stringify(gt)}`);
    const jl = (await jsonList()).find((t) => t.id === id);
    log(`  /json/list entry now: ${JSON.stringify(jl)} (keys: ${JSON.stringify(jl ? Object.keys(jl) : null)})`);
    log(`  openerId equals opener targetId: ${e.params.targetInfo.openerId === opener.info.targetId}`);
    await bd.c.send('Target.closeTarget', { targetId: id }).catch((er) => log(`  closeTarget failed: ${er.message}`));
  }
  await sleep(300);
}

// ===== Part D: footprint of holding the browser-level socket open =====
log('===== PART D: footprint of the browser socket on other tabs =====');
const other = await openTab(bd, pageUrl);
const samples = async (conn, n) => {
  const ms = [];
  for (let i = 0; i < n; i++) {
    const t = now();
    await evalIn(conn, '1+1');
    ms.push(+(now() - t).toFixed(1));
  }
  return ms;
};
log(`  Runtime.evaluate latency on another tab, browser socket OPEN with discovery on: ${JSON.stringify(await samples(other, 20))}`);
log(`  Target.getTargets with the socket open and discovery on: ${JSON.stringify(await targetsAttached())}`);
await bd.c.send('Target.setDiscoverTargets', { discover: false });
await sleep(300);
log(`  discovery off: events arriving afterwards when a tab is created: ${await (async () => {
    const n = bd.events.length;
    const { targetId } = await bd.c.send('Target.createTarget', { url: 'about:blank' });
    await sleep(500);
    const got = bd.events.slice(n).map((e) => e.method);
    await bd.c.send('Target.closeTarget', { targetId });
    return JSON.stringify(got);
  })()}`);
bd.c.close();
await sleep(500);
log(`  Runtime.evaluate latency on another tab, browser socket CLOSED: ${JSON.stringify(await samples(other, 20))}`);
log(`  existing page socket still open after the browser socket closed: ${other.c.isOpen}`);
const idle = await dialBrowser('idle');
await sleep(6000);
log(`  browser socket idle for 6 s (no commands, no heartbeat): still open=${idle.c.isOpen}`);
const idleTargets = (await idle.c.send('Target.getTargets')).targetInfos.map((t) => ({ type: t.type, attached: t.attached }));
log(`  Target.getTargets over the idle socket after 6 s: ${JSON.stringify(idleTargets)}`);
idle.c.close();
other.c.close();
opener.c.close();
tabD.c.close();

// ---- teardown ----
log('===== teardown =====');
const bye = await dialBrowser('bye');
await stopChrome(chrome, { send: (m) => bye.c.send(m, {}, 3000) });
http.close();
await lib.removeDir(chrome.profile);
const dead = primaryBefore.filter((pid) => !lib.isAlive(pid));
log(
  dead.length
    ? `FAIL owner primary pid ${dead.join(',')} no longer alive`
    : `owner primary: ${primaryBefore.length ? `pid ${primaryBefore.join(',')} still alive` : 'none was running'}`,
);
process.exit(dead.length ? 1 : 0);
