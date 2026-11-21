// Experiments E1-E5 for G9 (docs/design/cdp-direct-parity.md, section 6):
// download behavior on cdp-direct, for owner decision D17.
// Run: CHROME_PATH=<chrome> node g9-downloads.mjs <label> [--headed]   (stdout is the record)
// Pure CDP, no MCP server. Sockets are the server's own CdpClient (built dist):
// page ones dial /devtools/page/<id> and do Target.getTargetInfo + Page.enable as
// transport.ts `dial` does; browser ones dial the `webSocketDebuggerUrl` of
// /json/version. Chrome gets its own profile whose Preferences ASK where to save
// each file (download.prompt_for_download: true). All scratch (profile, staging
// dirs) stays under one mkdtemp dir in the OS temp dir, printed at the start and
// never deleted by this script.
//
// `--headed` runs only the E1 part that needs a window (and the Save-as check)
// plus the revert-on-close check; the full E1-E5 run is headless.
//
// Internal mode: `node g9-downloads.mjs --child <ws> <method> <dir>` dials a page
// socket, sets the download behavior, prints SET, and waits to be killed (E2,
// "the server process crashed").
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_DIST = resolve(HERE, '../../../server/dist');
const { CdpClient } = await import(pathToFileURL(join(SERVER_DIST, 'cdp/client.js')).href);

if (process.argv[2] === '--child') {
  const [, , , ws, method, dir] = process.argv;
  const c = new CdpClient(ws);
  await c.connect();
  await c.send('Target.getTargetInfo');
  await c.send('Page.enable');
  const r = await c.send(method, { behavior: 'allow', downloadPath: dir, eventsEnabled: true });
  console.log(`SET ${JSON.stringify(r)}`);
  setInterval(() => {}, 1 << 30);
} else {
  await main();
}

async function main() {
  const lib = await import(pathToFileURL(join(HERE, '../../../e2e/src/lib.mjs')).href);
  const { startFixtures, REPORT_BYTES, GZIP_BYTES, REVERSED_BYTES } = await import(pathToFileURL(join(HERE, 'fixture-server.mjs')).href);
  const { sleep, now, freePort, waitHttp, stopChrome } = lib;

  const label = process.argv[2] ?? 'run';
  const HEADED = process.argv.includes('--headed');
  const T0 = now();
  const log = (...a) => console.log(`+${String(Math.round(now() - T0)).padStart(6)}ms`, ...a);
  const clip = (s, n = 1200) => (s.length > n ? `${s.slice(0, n)} [clipped ${s.length - n} chars]` : s);

  const chromePath = lib.resolveChrome();
  const primaryBefore = [...new Set(lib.DEFAULT_PORTS.flatMap((p) => lib.portOwners(p)))];
  const SCRATCH = mkdtempSync(join(tmpdir(), `g9-lab-${label}-`));
  const hide = (s) => String(s).split(SCRATCH).join('<scratch>');
  log(`label=${label} headed=${HEADED} chrome=${chromePath}`);
  log(`scratch=${SCRATCH} (shown below as <scratch>; never deleted by this script)`);
  log(`owner primary pids on 17529/17530 before: ${JSON.stringify(primaryBefore)}`);

  // ---- watched directories ----
  const DIRS = new Map(); // short name -> absolute path
  const dir = (name, create = true) => {
    const p = join(SCRATCH, name);
    if (create) mkdirSync(p, { recursive: true });
    DIRS.set(name, p);
    return p;
  };
  const listing = () => {
    const out = new Map();
    for (const [name, p] of DIRS) {
      if (!existsSync(p)) continue;
      for (const f of readdirSync(p)) {
        const full = join(p, f);
        let size = -1;
        try {
          size = statSync(full).size;
        } catch {
          // vanished
        }
        out.set(`${name}/${f}`, { name: `${name}/${f}`, full, size });
      }
    }
    return out;
  };
  const isPartial = (n) => /\.(crdownload|tmp|part)$/i.test(n) || /Unconfirmed/i.test(n);
  const bytesKind = (full) => {
    try {
      const b = readFileSync(full);
      if (b.equals(REPORT_BYTES)) return 'report-bytes';
      if (b.equals(REVERSED_BYTES)) return 'reversed-bytes(2nd request)';
      if (b.equals(GZIP_BYTES)) return 'gzip-bytes(still-encoded)';
      return `other(${String(b.length)}B:${clip(JSON.stringify(b.subarray(0, 60).toString('latin1')), 80)})`;
    } catch (e) {
      return `unreadable(${e.code})`;
    }
  };

  // ---- Chrome with its own profile that ASKS where to save ----
  const profile = join(SCRATCH, 'profile');
  mkdirSync(join(profile, 'Default'), { recursive: true });
  const defaultDir = dir('chrome-default-dir');
  const prefsFile = join(profile, 'Default', 'Preferences');
  writeFileSync(
    prefsFile,
    JSON.stringify({
      download: { default_directory: defaultDir, prompt_for_download: true, directory_upgrade: true },
      savefile: { default_directory: defaultDir },
    }),
  );
  const cdpPort = await freePort();
  const args = [
    ...(HEADED ? [] : ['--headless=new']),
    `--remote-debugging-port=${String(cdpPort)}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ];
  log(`chrome args: ${hide(JSON.stringify(args))}`);
  const proc = spawn(chromePath, args, { stdio: ['ignore', 'ignore', 'ignore'], detached: process.platform !== 'win32' });
  const chrome = { proc, profile };
  const base = `http://127.0.0.1:${String(cdpPort)}`;
  const version = await waitHttp(`${base}/json/version`, 20_000);
  const fx = await startFixtures();
  const { origin, xOrigin, served } = fx;
  log(`browser=${version.Browser} protocol=${version['Protocol-Version']} cdp=${cdpPort} origin=${origin} xOrigin=${xOrigin}`);
  log(`profile Preferences on disk after start: download=${hide(JSON.stringify(JSON.parse(readFileSync(prefsFile, 'utf8')).download))}`);

  // ---- sockets ----
  const conns = [];
  async function tryCall(conn, method, params = {}, note = '') {
    const t = now();
    try {
      const r = await conn.c.send(method, params, 5000);
      log(`  [${conn.name}] ${method} ${hide(JSON.stringify(params))} ${note}-> ${clip(JSON.stringify(r))} (${Math.round(now() - t)}ms)`);
      return { ok: true, r };
    } catch (e) {
      log(`  [${conn.name}] ${method} ${hide(JSON.stringify(params))} ${note}FAILED: ${e.message} (${Math.round(now() - t)}ms)`);
      return { ok: false, error: e.message };
    }
  }
  const track = (c, name) => {
    const conn = { c, name, events: [] };
    c.onAny((method, params) => conn.events.push({ method, params, at: now() }));
    conns.push(conn);
    return conn;
  };
  async function dialBrowser(name) {
    const c = new CdpClient(version.webSocketDebuggerUrl);
    await c.connect();
    return track(c, name);
  }
  async function dialPage(targetId, name) {
    const c = new CdpClient(`ws://127.0.0.1:${String(cdpPort)}/devtools/page/${targetId}`);
    await c.connect();
    const conn = track(c, name);
    conn.info = (await c.send('Target.getTargetInfo')).targetInfo;
    await c.send('Page.enable');
    return conn;
  }
  const closeConn = async (conn, how = 'close') => {
    if (how === 'terminate') conn.c.ws.terminate();
    else conn.c.close();
    await sleep(400);
    log(`  [${conn.name}] socket ${how === 'terminate' ? 'TERMINATED (ws.terminate(): TCP destroyed, no close frame)' : 'closed normally (close frame)'}`);
  };
  const evalIn = async (conn, expression, userGesture = false) => {
    const r = await conn.c.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture }, 10_000);
    return r.exceptionDetails ? `EXC:${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}` : r.result.value;
  };
  const bMain = await dialBrowser('browser-main');
  async function openTab(name, browserContextId) {
    const { targetId } = await bMain.c.send('Target.createTarget', { url: `${origin}/`, ...(browserContextId ? { browserContextId } : {}) });
    const p = await dialPage(targetId, name);
    // Wait for the fixture itself: the initial about:blank document also
    // reports readyState "complete" (a draft run clicked into it).
    for (let i = 0; i < 100; i++) {
      if ((await evalIn(p, 'document.readyState + " " + location.href')) === `complete ${origin}/`) break;
      await sleep(50);
    }
    return p;
  }
  // A tab that is not in front does not act on Input.dispatchMouseEvent until a
  // later click elsewhere (seen in a draft run of this script), so every click
  // brings its tab to front first.
  const clickAt = async (conn, selector) => {
    await conn.c.send('Page.bringToFront');
    const rect = await evalIn(conn, `(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.scrollIntoView({block:'center'}); const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await conn.c.send('Input.dispatchMouseEvent', { type, x: rect[0], y: rect[1], button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: type === 'mouseMoved' ? 0 : 1 });
    }
    return `clicked ${selector}`;
  };
  /** Point #dl (or another anchor) at `path` and click it like a user. */
  const dl = async (conn, path, selector = '#dl') => {
    await evalIn(conn, `document.querySelector(${JSON.stringify(selector)}).href = ${JSON.stringify(path.startsWith('http') ? path : origin + path)}`);
    return clickAt(conn, selector);
  };
  /** Navigate back to the fixture page when a trial left it (or always, with force). */
  const home = async (conn, force = false) => {
    const at = await evalIn(conn, 'location.href');
    if (!force && at === `${origin}/`) return;
    await conn.c.send('Page.navigate', { url: `${origin}/` });
    for (let i = 0; i < 100; i++) {
      await sleep(50);
      if ((await evalIn(conn, 'document.readyState + location.href').catch(() => '')) === `complete${origin}/`) break;
    }
    log(`  [${conn.name}] back on the fixture page (was ${at})`);
  };
  /** Visible top-level windows of every process in Chrome's process tree
   * (Windows only): the file dialog may belong to a child process. */
  const windowTitles = () => {
    if (process.platform !== 'win32') return 'n/a (not Windows)';
    const ps = `
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public class W { public delegate bool P(IntPtr h, IntPtr l);
[DllImport("user32.dll")] public static extern bool EnumWindows(P p, IntPtr l);
[DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
[DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p); }
"@
$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
$tree = @{ ${String(proc.pid)} = 'browser' }
do { $n = $tree.Count; foreach ($x in $all) { if ($tree.ContainsKey([int]$x.ParentProcessId) -and -not $tree.ContainsKey([int]$x.ProcessId)) { $tree[[int]$x.ProcessId] = 'child' } } } while ($tree.Count -ne $n)
$script:out = @()
[void][W]::EnumWindows({ param($h, $l) $p = 0; [void][W]::GetWindowThreadProcessId($h, [ref]$p)
  if ($tree.ContainsKey([int]$p) -and [W]::IsWindowVisible($h)) { $t = New-Object System.Text.StringBuilder 512; $k = New-Object System.Text.StringBuilder 256
    [void][W]::GetWindowText($h, $t, 512); [void][W]::GetClassName($h, $k, 256); $script:out += ($t.ToString() + ' [class ' + $k.ToString() + ', ' + $tree[[int]$p] + ' process]') }; $true }, [IntPtr]::Zero)
$script:out -join ' | '`;
    try {
      return execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim() || '(none)';
    } catch (e) {
      return `failed: ${e.message.split('\n')[0]}`;
    }
  };

  /** One download trial: run `trigger`, wait until a finished file lands in a
   * watched dir (or `maxMs`), then print what landed and every download /
   * target event each open socket received since the trigger. */
  async function trial(name, trigger, { maxMs = 3000, settleMs = 400, waitFull = false, full = false } = {}) {
    log(`--- trial ${name}`);
    const before = listing();
    const marks = new Map(conns.map((c) => [c, c.events.length]));
    const t0 = now();
    let r;
    try {
      r = await trigger();
    } catch (e) {
      r = `THREW ${e.message}`;
    }
    log(`  trigger: ${JSON.stringify(r)}`);
    const fresh = () => [...listing().values()].filter((f) => !before.has(f.name) || before.get(f.name).size !== f.size);
    let landedAt = null;
    while (now() - t0 < maxMs) {
      if (!waitFull && fresh().some((f) => !isPartial(f.name))) {
        landedAt = Math.round(now() - t0);
        await sleep(settleMs);
        break;
      }
      await sleep(100);
    }
    const files = fresh();
    const done = files.filter((f) => !isPartial(f.name));
    log(
      `  landed: ${files.length ? files.map((f) => `${f.name} (${String(f.size)} B${isPartial(f.name) ? ', partial' : `, ${bytesKind(f.full)}`})`).join(', ') : 'NOTHING in any watched dir'}${landedAt !== null ? ` (first finished file seen ${String(landedAt)}ms after the trigger started)` : ` (waited ${String(Math.round(now() - t0))}ms)`}`,
    );
    for (const c of conns) {
      const ev = c.events.slice(marks.get(c) ?? 0).filter((e) => /download|Target\.(targetCreated|targetDestroyed|attachedToTarget)/i.test(e.method));
      if (full) {
        for (const e of ev) log(`  [${c.name}] +${String(Math.round(e.at - t0)).padStart(4)}ms ${e.method} ${clip(hide(JSON.stringify(e.params)))}`);
        continue;
      }
      // Compact: every non-progress event in full; progress events per method
      // and guid as a count, the distinct states in order, and the last one.
      const prog = new Map();
      for (const e of ev) {
        if (!/downloadProgress$/.test(e.method)) {
          log(`  [${c.name}] +${String(Math.round(e.at - t0)).padStart(4)}ms ${e.method} ${clip(hide(JSON.stringify(e.params)))}`);
          continue;
        }
        const key = `${e.method} guid=${e.params.guid}`;
        const p = prog.get(key) ?? { n: 0, states: [], last: null, at: 0 };
        p.n++;
        if (p.states.at(-1) !== e.params.state) p.states.push(e.params.state);
        p.last = e.params;
        p.at = e.at;
        prog.set(key, p);
      }
      for (const [key, p] of prog) {
        log(`  [${c.name}] ${key}: ${String(p.n)} events, states ${p.states.join('>')}, last at +${String(Math.round(p.at - t0))}ms ${clip(hide(JSON.stringify(p.last)))}`);
      }
    }
    if (HEADED) log(`  visible windows of Chrome's process tree: ${windowTitles()}`);
    return { files: done, all: files };
  }
  const servedFor = (needle) =>
    JSON.stringify(Object.fromEntries(Object.entries(served).filter(([k]) => k.includes(needle))));
  const stage = (tag) => dir(`stage-${tag}`);

  const t1 = await openTab('page-T1');
  log(`  T1 targetId=${t1.info.targetId} browserContextId=${t1.info.browserContextId}`);
  const frameTree = await t1.c.send('Page.getFrameTree');
  log(`  T1 main frame id=${frameTree.frameTree.frame.id}`);

  if (HEADED) {
    await headedPart();
  } else {
    await headlessPart();
  }

  // ---- teardown ----
  log('===== teardown =====');
  const ownerDownloads = join(homedir(), 'Downloads');
  const leaked = existsSync(ownerDownloads) ? readdirSync(ownerDownloads).filter((f) => f.startsWith('g9-')) : [];
  log(`owner's real Downloads folder holds g9-* files: ${leaked.length ? JSON.stringify(leaked) : 'none'}`);
  log(`final listing of every watched dir: ${JSON.stringify([...listing().keys()])}`);
  const bye = await dialBrowser('bye');
  const exited = await stopChrome(chrome, { send: (m) => bye.c.send(m, {}, 3000) });
  log(`chrome exited after Browser.close: ${exited}`);
  await sleep(500);
  try {
    log(`profile Preferences on disk after exit: download=${hide(JSON.stringify(JSON.parse(readFileSync(prefsFile, 'utf8')).download))}`);
  } catch (e) {
    log(`profile Preferences unreadable after exit: ${e.message}`);
  }
  fx.close();
  const dead = primaryBefore.filter((pid) => !lib.isAlive(pid));
  log(
    dead.length
      ? `FAIL owner primary pid ${dead.join(',')} no longer alive`
      : `owner primary: ${primaryBefore.length ? `pid ${primaryBefore.join(',')} still alive` : 'none was running'}`,
  );
  process.exit(dead.length ? 1 : 0);

  // =====================================================================
  async function headedPart() {
    log('===== E1 (headed): allow + path on each socket kind, profile asks where to save =====');
    log(`  visible windows before any download: ${windowTitles()}`);
    const kinds = [
      ['page-socket Page.setDownloadBehavior', () => dialPage(t1.info.targetId, 'setter-page-Page'), 'Page.setDownloadBehavior'],
      ['page-socket Browser.setDownloadBehavior', () => dialPage(t1.info.targetId, 'setter-page-Browser'), 'Browser.setDownloadBehavior'],
      ['browser-socket Browser.setDownloadBehavior', () => dialBrowser('setter-browser'), 'Browser.setDownloadBehavior'],
    ];
    const setters = [];
    for (const [i, [what, dial, method]] of kinds.entries()) {
      log(`  -- ${what} --`);
      const s = await dial();
      setters.push(s);
      const d = stage(`e1h-${String(i + 1)}`);
      await tryCall(s, method, { behavior: 'allow', downloadPath: d, ...(method.startsWith('Browser') ? { eventsEnabled: true } : {}) });
      await trial(`E1h-${String(i + 1)} ${what}: click #dl in T1`, () => dl(t1, `/f/g9-e1h-${String(i + 1)}.bin`));
      await tryCall(s, method, { behavior: 'default' }, '(reset) ');
      await closeConn(s);
    }
    log('===== E2 (headed): after every setting socket closed, the same click =====');
    await trial('E2h baseline after the setting sockets closed: click #dl in T1', () => dl(t1, '/f/g9-e2h-after-close.bin'), { maxMs: 4000, waitFull: true });
    log('===== E2 (headed): socket TERMINATED while allow is set =====');
    const s = await dialPage(t1.info.targetId, 'setter-terminate');
    await tryCall(s, 'Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: stage('e2h-term'), eventsEnabled: true });
    await closeConn(s, 'terminate');
    await trial('E2h after terminate: click #dl in T1', () => dl(t1, '/f/g9-e2h-after-terminate.bin'), { maxMs: 4000, waitFull: true });
  }

  // =====================================================================
  async function headlessPart() {
    // ---------- BASELINE ----------
    log('===== BASELINE: nothing set, profile asks where to save =====');
    await trial('BASE click #dl in T1 (no setDownloadBehavior anywhere)', () => dl(t1, '/f/g9-base.bin'), { maxMs: 3000, waitFull: true });

    // ---------- E1 ----------
    log('===== E1: which socket accepts which command; behavior values =====');
    const kinds = [
      ['page-socket Page.setDownloadBehavior', () => dialPage(t1.info.targetId, 'setter-page-Page'), 'Page.setDownloadBehavior'],
      ['page-socket Browser.setDownloadBehavior', () => dialPage(t1.info.targetId, 'setter-page-Browser'), 'Browser.setDownloadBehavior'],
      ['browser-socket Browser.setDownloadBehavior', () => dialBrowser('setter-browser'), 'Browser.setDownloadBehavior'],
      ['browser-socket Page.setDownloadBehavior', () => dialBrowser('setter-browser-Page'), 'Page.setDownloadBehavior'],
    ];
    for (const [i, [what, dial, method]] of kinds.entries()) {
      log(`  -- E1.${String(i + 1)} ${what} --`);
      const s = await dial();
      const d = stage(`e1-${String(i + 1)}`);
      const set = await tryCall(s, method, { behavior: 'allow', downloadPath: d, ...(method.startsWith('Browser') ? { eventsEnabled: true } : {}) });
      if (set.ok) {
        await trial(`E1.${String(i + 1)} ${what}: click #dl in T1`, () => dl(t1, `/f/g9-e1-${String(i + 1)}.bin`));
        await tryCall(s, method, { behavior: 'default' }, '(reset) ');
      }
      await closeConn(s);
    }
    log('  -- E1.5 behavior values and argument errors --');
    const sp = await dialPage(t1.info.targetId, 'setter-values-page');
    const sb = await dialBrowser('setter-values-browser');
    for (const conn of [sp, sb]) {
      for (const method of ['Page.setDownloadBehavior', 'Browser.setDownloadBehavior']) {
        for (const behavior of ['deny', 'allow', 'allowAndName', 'default', 'hold', 'pending']) {
          await tryCall(conn, method, { behavior }, '(no downloadPath) ');
        }
        await tryCall(conn, method, { behavior: 'allow', downloadPath: 'relative/dir' }, '(relative path) ');
        await tryCall(conn, method, { behavior: 'default' }, '(reset) ');
      }
    }
    await tryCall(sp, 'Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: stage('e1-ctx'), browserContextId: t1.info.browserContextId }, '(page socket, T1 own browserContextId) ');
    await tryCall(sp, 'Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: stage('e1-ctx'), browserContextId: 'NOSUCHCONTEXT' }, '(page socket, unknown context) ');
    await tryCall(sb, 'Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: stage('e1-ctx'), browserContextId: t1.info.browserContextId }, '(browser socket, T1 own browserContextId) ');
    await tryCall(sb, 'Browser.setDownloadBehavior', { behavior: 'default' }, '(reset) ');
    await tryCall(sb, 'Browser.setDownloadBehavior', { behavior: 'default', browserContextId: t1.info.browserContextId }, '(reset, by id) ');
    log('  -- E1.6 allow with a directory that does not exist yet --');
    const missing = dir('stage-e1-missing/deeper', false);
    await tryCall(sb, 'Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: missing, eventsEnabled: true });
    await trial('E1.6 missing dir: click #dl in T1', () => dl(t1, '/f/g9-e1-missing.bin'));
    log(`  the missing dir exists now: ${existsSync(missing)}`);
    log('  -- E1.7 deny --');
    await tryCall(sb, 'Browser.setDownloadBehavior', { behavior: 'deny', eventsEnabled: true });
    await trial('E1.7 deny: click #dl in T1', () => dl(t1, '/f/g9-e1-deny.bin'), { maxMs: 2000, waitFull: true });
    log('  -- E1.8 allowAndName --');
    await tryCall(sb, 'Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: stage('e1-name'), eventsEnabled: true });
    await trial('E1.8 allowAndName: click #dl in T1', () => dl(t1, '/f/g9-e1-name.bin'));
    log('  -- E1.8b a behavior value outside the documented set ("hold") --');
    await tryCall(sb, 'Browser.setDownloadBehavior', { behavior: 'hold', eventsEnabled: true });
    await trial('E1.8b "hold": click #dl in T1', () => dl(t1, '/f/g9-e1-hold.bin'), { maxMs: 3000, waitFull: true });
    await tryCall(sp, 'Page.setDownloadBehavior', { behavior: 'hold' }, '(page socket) ');
    await trial('E1.8c Page "hold": click #dl in T1', () => dl(t1, '/f/g9-e1-page-hold.bin'), { maxMs: 3000, waitFull: true });
    await tryCall(sp, 'Page.setDownloadBehavior', { behavior: 'default' }, '(reset) ');
    log('  -- E1.9 allow WITHOUT eventsEnabled on the browser socket --');
    await tryCall(sb, 'Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: stage('e1-noevents') });
    await trial('E1.9 allow, eventsEnabled omitted: click #dl in T1', () => dl(t1, '/f/g9-e1-noevents.bin'));
    await tryCall(sb, 'Browser.setDownloadBehavior', { behavior: 'default' }, '(reset) ');
    await closeConn(sp);
    await closeConn(sb);
    await trial('E1 control after reset+close: click #dl in T1', () => dl(t1, '/f/g9-e1-control.bin'), { maxMs: 3000, waitFull: true });

    // ---------- E2 ----------
    log('===== E2: scope and revert =====');
    const t2 = await openTab('page-T2');
    const ctxC = (await bMain.c.send('Target.createBrowserContext')).browserContextId;
    const t3 = await openTab('page-T3(ctxC)', ctxC);
    log(`  T2 (default ctx) targetId=${t2.info.targetId} ctx=${t2.info.browserContextId}; T3 (new ctx) targetId=${t3.info.targetId} ctx=${t3.info.browserContextId}`);
    const threeTabs = async (tag) => {
      await trial(`${tag}: click in T1 (the setter's tab)`, () => dl(t1, `/f/g9-${tag}-T1.bin`));
      await trial(`${tag}: click in T2 (same context, other tab)`, () => dl(t2, `/f/g9-${tag}-T2.bin`));
      await trial(`${tag}: click in T3 (other browser context)`, () => dl(t3, `/f/g9-${tag}-T3.bin`), { maxMs: 3000 });
    };
    log('  -- E2.a Page.setDownloadBehavior on a page socket of T1, then closed normally --');
    let s = await dialPage(t1.info.targetId, 'setter-E2a-page-Page');
    await tryCall(s, 'Page.setDownloadBehavior', { behavior: 'allow', downloadPath: stage('e2a') });
    await threeTabs('e2a');
    await closeConn(s);
    await trial('e2a after close: click in T1', () => dl(t1, '/f/g9-e2a-after-close.bin'), { maxMs: 3000, waitFull: true });

    log('  -- E2.b Browser.setDownloadBehavior on a page socket of T1, then closed normally --');
    s = await dialPage(t1.info.targetId, 'setter-E2b-page-Browser');
    await tryCall(s, 'Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: stage('e2b'), eventsEnabled: true });
    await threeTabs('e2b');
    await closeConn(s);
    await trial('e2b after close: click in T1', () => dl(t1, '/f/g9-e2b-after-close.bin'), { maxMs: 3000, waitFull: true });

    log('  -- E2.c Browser.setDownloadBehavior on a browser socket (no context, then ctxC), then closed normally --');
    s = await dialBrowser('setter-E2c-browser');
    await tryCall(s, 'Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: stage('e2c'), eventsEnabled: true });
    await threeTabs('e2c');
    await tryCall(s, 'Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: stage('e2c-ctxC'), browserContextId: ctxC, eventsEnabled: true }, '(explicit ctxC) ');
    await trial('e2c with ctxC set too: click in T3', () => dl(t3, '/f/g9-e2c-ctxC-T3.bin'));
    await trial('e2c with ctxC set too: click in T1', () => dl(t1, '/f/g9-e2c-ctxC-T1.bin'));
    await closeConn(s);
    await trial('e2c after close: click in T1', () => dl(t1, '/f/g9-e2c-after-close-T1.bin'), { maxMs: 3000, waitFull: true });
    await trial('e2c after close: click in T3', () => dl(t3, '/f/g9-e2c-after-close-T3.bin'), { maxMs: 3000, waitFull: true });

    log('  -- E2.d page socket TERMINATED (no close frame) while allow is set --');
    s = await dialPage(t1.info.targetId, 'setter-E2d-terminate');
    await tryCall(s, 'Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: stage('e2d'), eventsEnabled: true });
    await trial('e2d before terminate: click in T1', () => dl(t1, '/f/g9-e2d-before.bin'));
    await closeConn(s, 'terminate');
    await trial('e2d after terminate: click in T1', () => dl(t1, '/f/g9-e2d-after-terminate.bin'), { maxMs: 3000, waitFull: true });

    log('  -- E2.e the PROCESS holding the setting socket is killed --');
    const child = async (tag) => {
      const d = stage(tag);
      const cp = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child', `ws://127.0.0.1:${String(cdpPort)}/devtools/page/${t1.info.targetId}`, 'Browser.setDownloadBehavior', d], { stdio: ['ignore', 'pipe', 'pipe'] });
      const line = await new Promise((res) => {
        let buf = '';
        cp.stdout.on('data', (c) => {
          buf += c;
          if (buf.includes('\n')) res(buf.trim());
        });
        cp.on('exit', (code) => res(`child exited ${String(code)}`));
      });
      log(`  child pid ${String(cp.pid)} says: ${line}`);
      return cp;
    };
    const kill = async (cp) => {
      cp.kill('SIGKILL');
      await new Promise((r) => (cp.exitCode !== null || cp.signalCode !== null ? r() : cp.once('exit', r)));
      await sleep(400);
      log(`  child pid ${String(cp.pid)} killed (SIGKILL; on Windows TerminateProcess): exitCode=${String(cp.exitCode)} signal=${String(cp.signalCode)}`);
    };
    let cp = await child('e2e-kill');
    await trial('e2e child holds allow: click in T1', () => dl(t1, '/f/g9-e2e-before-kill.bin'));
    await kill(cp);
    await trial('e2e after the child was killed: click in T1', () => dl(t1, '/f/g9-e2e-after-kill.bin'), { maxMs: 3000, waitFull: true });
    log('  -- E2.f a download IN FLIGHT when the setting process is killed (2048 B over 3 s) --');
    cp = await child('e2f-inflight');
    await trial(
      'e2f slow download started, child killed ~800ms later',
      async () => {
        await dl(t1, '/f/g9-e2f-inflight.bin?slow=3000');
        await sleep(800);
        log(`  during the download, before the kill: ${JSON.stringify([...listing().keys()].filter((k) => k.includes('e2f')))}`);
        await kill(cp);
        return 'clicked, then killed the child';
      },
      { maxMs: 6000, waitFull: true },
    );
    log(`  served for e2f: ${servedFor('e2f')}`);

    log('  -- E2.g who resets: a quiet socket closing; another socket that set another context closing --');
    const sA = await dialPage(t1.info.targetId, 'setter-E2g-A');
    await tryCall(sA, 'Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: stage('e2g-A'), eventsEnabled: true });
    const quiet = await dialPage(t2.info.targetId, 'quiet-E2g');
    await closeConn(quiet);
    await trial('e2g after a quiet page socket (getTargetInfo+Page.enable only) closed: click in T1', () => dl(t1, '/f/g9-e2g-after-quiet.bin'));
    const sX = await dialBrowser('setter-E2g-X-ctxC');
    await tryCall(sX, 'Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: stage('e2g-X'), browserContextId: ctxC, eventsEnabled: true });
    await trial('e2g ctxC set by X: click in T3', () => dl(t3, '/f/g9-e2g-X-T3.bin'));
    await closeConn(sX);
    await trial('e2g after X (set ctxC) closed: click in T1 (default ctx, set by A)', () => dl(t1, '/f/g9-e2g-after-X-T1.bin'), { maxMs: 3000 });
    await trial('e2g after X closed: click in T3 (ctxC, set by X)', () => dl(t3, '/f/g9-e2g-after-X-T3.bin'), { maxMs: 3000, waitFull: true });
    log('  -- E2.h two sockets set the SAME context: last wins? closing the later one --');
    const sB = await dialPage(t2.info.targetId, 'setter-E2h-B');
    await tryCall(sB, 'Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: stage('e2h-B'), eventsEnabled: true });
    await trial('e2h A then B set the default ctx: click in T1', () => dl(t1, '/f/g9-e2h-both.bin'));
    await closeConn(sB);
    await trial('e2h after B closed (A still open): click in T1', () => dl(t1, '/f/g9-e2h-after-B.bin'), { maxMs: 3000, waitFull: true });
    await closeConn(sA);
    await trial('e2h after A closed too: click in T1', () => dl(t1, '/f/g9-e2h-after-A.bin'), { maxMs: 3000, waitFull: true });

    // ---------- E3 ----------
    log('===== E3: event fields and download classes =====');
    const bE3 = await dialBrowser('browser-E3');
    await tryCall(bE3, 'Target.setDiscoverTargets', { discover: true });
    await sleep(300);
    await tryCall(bE3, 'Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: stage('e3'), eventsEnabled: true });
    await trial('E3.1 plain click in T1 (both sockets listening)', () => dl(t1, '/f/g9-e3-plain.bin'), { full: true });
    await trial('E3.2 slow download in T1 (progress events)', () => dl(t1, '/f/g9-e3-slow.bin?slow=1200'), { maxMs: 4000, full: true });
    await trial('E3.3 new window: click a target=_blank link to an attachment', () => dl(t1, '/f/g9-e3-newwin-link.bin', '#blank-dl'), { maxMs: 4000, full: true });
    await trial('E3.4 new window: window.open(attachment) from a script with userGesture', () => evalIn(t1, `String(!!window.open(${JSON.stringify(`${origin}/f/g9-e3-newwin-open.bin`)}))`, true), { maxMs: 4000, full: true });
    log(`  load cross-site iframe: ${await evalIn(t1, `window.loadXo(${JSON.stringify(`${xOrigin}/iframe-child?target=${encodeURIComponent(`${xOrigin}/f/g9-e3-xo-iframe.bin`)}`)})`)}`);
    log(`  iframe targets now: ${JSON.stringify((await bE3.c.send('Target.getTargets')).targetInfos.filter((t) => t.type === 'iframe'))}`);
    log(`  T1 frame tree: ${JSON.stringify((await t1.c.send('Page.getFrameTree')).frameTree.childFrames?.map((f) => ({ id: f.frame.id, url: f.frame.url })))}`);
    await trial('E3.5 cross-site iframe: user click inside it', () => clickAt(t1, '#xo'), { maxMs: 4000, full: true });
    log(`  served for the iframe download: ${servedFor('xo-iframe')}`);
    log(`  register service worker in T1: ${await evalIn(t1, 'window.registerSw()')}`);
    await trial('E3.6 service-worker-made response: click #dl to /sw-dl/g9-e3-sw.bin', () => dl(t1, '/sw-dl/g9-e3-sw.bin'), { maxMs: 4000, full: true });
    log(`  served for /sw-dl (0 = the service worker answered): ${servedFor('sw-dl')}`);
    log(`  unregister the service worker: ${await evalIn(t1, "navigator.serviceWorker.getRegistrations().then((rs) => Promise.all(rs.map((r) => r.unregister()))).then((x) => 'unregistered ' + x.length)")}`);
    await home(t1, true);
    await trial('E3.7 programmatic a.click() of a download="name" anchor on a blob: URL', () => evalIn(t1, `(() => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([new Uint8Array(16)])); a.download = 'g9-e3-blob.bin'; document.body.append(a); a.click(); return a.href; })()`, true), { maxMs: 4000, full: true });
    await tryCall(bE3, 'Browser.setDownloadBehavior', { behavior: 'default' }, '(reset) ');

    // ---------- E4 ----------
    log('===== E4: post, one-time, chunked, gzip under allow and deny =====');
    for (const behavior of ['allow', 'deny']) {
      await tryCall(bE3, 'Browser.setDownloadBehavior', { behavior, ...(behavior === 'allow' ? { downloadPath: stage('e4') } : {}), eventsEnabled: true });
      const k = behavior;
      const opt = { maxMs: behavior === 'deny' ? 2000 : 3000, waitFull: behavior === 'deny' };
      await trial(`E4 ${behavior} post`, async () => {
        await evalIn(t1, `document.getElementById('postform').action = '/post.pdf?k=${k}'`);
        return clickAt(t1, '#dl-post');
      }, opt);
      log(`  served: ${servedFor(`post.pdf?k=${k}`)}; T1 url now: ${await evalIn(t1, 'location.href')}`);
      await home(t1);
      for (const p of ['token', 'chunked', 'gzip']) {
        await trial(`E4 ${behavior} ${p}`, () => dl(t1, `/${p}.bin?k=${k}`), opt);
        log(`  served: ${servedFor(`/${p}.bin?k=${k}`)}; T1 url now: ${await evalIn(t1, 'location.href')}`);
        await home(t1);
      }
    }
    await tryCall(bE3, 'Browser.setDownloadBehavior', { behavior: 'default' }, '(reset) ');

    // ---------- E5 ----------
    log('===== E5: two concurrent downloads with the same URL =====');
    await tryCall(bE3, 'Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: stage('e5a'), eventsEnabled: true });
    await trial('E5.a same URL clicked twice in T1 (allow)', async () => {
      await dl(t1, '/f/g9-e5-same.bin?slow=1500&vary=1');
      await clickAt(t1, '#dl');
      return 'two clicks';
    }, { maxMs: 4000, waitFull: true, full: true });
    log(`  served: ${servedFor('g9-e5-same.bin')}`);
    await tryCall(bE3, 'Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: stage('e5b'), eventsEnabled: true });
    await trial('E5.b same URL in T1 and T2 at once (allow)', async () => {
      await evalIn(t2, `document.querySelector('#dl').href = '${origin}/f/g9-e5-two-tabs.bin?slow=1500&vary=1'`);
      await dl(t1, '/f/g9-e5-two-tabs.bin?slow=1500&vary=1');
      await clickAt(t2, '#dl');
      return 'T1 then T2';
    }, { maxMs: 4000, waitFull: true, full: true });
    log(`  served: ${servedFor('g9-e5-two-tabs.bin')}`);
    await tryCall(bE3, 'Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: stage('e5c'), eventsEnabled: true });
    await trial('E5.c same URL clicked twice in T1 (allowAndName)', async () => {
      await dl(t1, '/f/g9-e5-named.bin?slow=1500&vary=1');
      await clickAt(t1, '#dl');
      return 'two clicks';
    }, { maxMs: 4000, waitFull: true, full: true });
    log(`  served: ${servedFor('g9-e5-named.bin')}`);
    await tryCall(bE3, 'Browser.setDownloadBehavior', { behavior: 'default' }, '(reset) ');
    await closeConn(bE3);
    await tryCall(bMain, 'Target.disposeBrowserContext', { browserContextId: ctxC }, '(cleanup) ');
  }
}
