// Helpers for the e2e harness: resolve and launch an isolated headless Chrome,
// talk raw CDP over Node's global WebSocket (no flag needed since Node 22.0.0,
// stable since 22.4.0: https://nodejs.org/docs/latest-v22.x/api/globals.html),
// pick free ports, find the owner's running primary, clean up.
// Derived from packages/plan/lab/2026-11-09-e2e-net/lib.mjs.
import { spawn, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const E2E_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO = resolve(E2E_DIR, '../..');
export const EXT_DIST = join(REPO, 'packages/extension/dist');
export const SERVER_CLI = join(REPO, 'packages/server/dist/cli.js');
const SERVER_EXTENSION_ID = join(REPO, 'packages/server/dist/auth/extension-id.js');
export const PAGE_FILE = join(E2E_DIR, 'pages/index.html');
/** The ports the owner's own browser-link uses; the harness never binds them. */
export const DEFAULT_PORTS = [17529, 17530];

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const now = () => performance.now();

/** CHROME_PATH, else the first platform default that exists, else a clear error. */
export function resolveChrome(env = process.env, platform = process.platform) {
  if (env.CHROME_PATH) {
    if (!existsSync(env.CHROME_PATH)) {
      throw new Error(`CHROME_PATH does not exist: ${env.CHROME_PATH}`);
    }
    return env.CHROME_PATH;
  }
  let candidates;
  if (platform === 'win32') {
    candidates = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA]
      .filter(Boolean)
      .map((base) => join(base, 'Google/Chrome/Application/chrome.exe'));
  } else if (platform === 'darwin') {
    candidates = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
  } else {
    candidates = [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
    ];
  }
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      `Chrome not found. Set CHROME_PATH to a Chrome/Chromium >= 118 binary (looked in: ${candidates.join(', ')})`,
    );
  }
  return found;
}

/** A free loopback port, never one of the defaults. */
export async function freePort() {
  for (;;) {
    const port = await new Promise((res, rej) => {
      const srv = createServer();
      srv.once('error', rej);
      srv.listen(0, '127.0.0.1', () => {
        const { port: p } = srv.address();
        srv.close(() => res(p));
      });
    });
    if (!DEFAULT_PORTS.includes(port)) return port;
  }
}

/** The id the server pins (one constant, read from the built server). */
export async function pinnedExtensionId() {
  const { PINNED_EXTENSION_ID } = await import(pathToFileURL(SERVER_EXTENSION_ID).href);
  return PINNED_EXTENSION_ID;
}

/** A loopback listener that records the `Origin` header a WebSocket upgrade
 * and a plain fetch carry, then closes them: what the extension's worker
 * announces, observed without touching the bridge. */
export async function originProbe() {
  const seen = { websocket: undefined, fetch: undefined };
  const server = createHttpServer((req, res) => {
    seen.fetch = req.headers.origin ?? '(none)';
    res.writeHead(204);
    res.end();
  });
  server.on('upgrade', (req, socket) => {
    seen.websocket = req.headers.origin ?? '(none)';
    socket.destroy();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, seen, close: () => server.close() };
}

/** Copy the built extension to a temp dir and point its WS bridge at `wsPort`. */
export function extensionCopy(wsPort) {
  if (!existsSync(join(EXT_DIST, 'manifest.json'))) {
    throw new Error(`${EXT_DIST} is not built; run pnpm build first`);
  }
  const dir = mkdtempSync(join(tmpdir(), 'bl-e2e-ext-'));
  cpSync(EXT_DIST, dir, { recursive: true });
  const bg = join(dir, 'background.js');
  const src = readFileSync(bg, 'utf8');
  const out = src.replace(
    /^const BRIDGE_PORT = 17529;$/m,
    `const BRIDGE_PORT = ${String(wsPort)};`,
  );
  if (out === src) throw new Error('"const BRIDGE_PORT = 17529;" not found in background.js');
  writeFileSync(bg, out);
  return dir;
}

export function launchChrome({ chromePath, port }) {
  const profile = mkdtempSync(join(tmpdir(), 'bl-e2e-profile-'));
  const args = [
    '--headless=new',
    `--remote-debugging-port=${String(port)}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--enable-unsafe-extension-debugging',
  ];
  if (process.env.E2E_NO_SANDBOX === '1' || (process.platform === 'linux' && process.env.CI)) {
    args.push('--no-sandbox');
  }
  if (process.platform === 'linux') args.push('--disable-dev-shm-usage');
  args.push('about:blank');
  // POSIX: own process group, so teardown can kill Chrome's helpers too.
  const proc = spawn(chromePath, args, {
    stdio: 'ignore',
    detached: process.platform !== 'win32',
  });
  return { proc, profile };
}

export async function waitHttp(url, timeoutMs) {
  const t0 = now();
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch {
      // not up yet
    }
    if (now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${url}`);
    await sleep(50);
  }
}

export class Cdp {
  static async open(wsUrl) {
    const c = new Cdp();
    c.ws = new WebSocket(wsUrl);
    c.id = 0;
    c.pending = new Map();
    await new Promise((res, rej) => {
      c.ws.addEventListener('open', res);
      c.ws.addEventListener('error', () => rej(new Error(`CDP connect failed: ${wsUrl}`)));
    });
    c.ws.addEventListener('message', (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.id === undefined) return;
      const p = c.pending.get(m.id);
      if (!p) return;
      c.pending.delete(m.id);
      if (m.error) p.rej(new Error(m.error.message));
      else p.res(m.result);
    });
    return c;
  }

  send(method, params = {}, sessionId) {
    return new Promise((res, rej) => {
      const id = ++this.id;
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  async evaluate(expression, sessionId) {
    const r = await this.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      sessionId,
    );
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    }
    return r.result.value;
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // already closed
    }
  }
}

/** Poll until this extension's MV3 worker (background.js) is a CDP target. */
export async function waitServiceWorker(cdp, extId, timeoutMs) {
  const url = `chrome-extension://${extId}/background.js`;
  const t0 = now();
  for (;;) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    const sw = targetInfos.find((t) => t.type === 'service_worker' && t.url === url);
    if (sw) return sw;
    if (now() - t0 > timeoutMs) throw new Error('the extension service worker did not start');
    await sleep(50);
  }
}

/** Evaluate in a target until it returns a truthy value, retrying the
 * transient `chrome is not defined` right after attach, until `timeoutMs`. */
export async function evaluateUntil(cdp, expression, sessionId, timeoutMs) {
  const t0 = now();
  let lastError;
  for (;;) {
    try {
      const v = await cdp.evaluate(expression, sessionId);
      if (v) return v;
    } catch (e) {
      lastError = e;
    }
    if (now() - t0 > timeoutMs) {
      const why = lastError ? `: ${lastError.message}` : '';
      throw new Error(`timeout evaluating ${expression.slice(0, 60)}${why}`);
    }
    await sleep(100);
  }
}

function killTree(pid) {
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    // already gone
  }
}

export async function stopChrome(chrome, cdp) {
  try {
    if (cdp) await Promise.race([cdp.send('Browser.close'), sleep(3000)]);
  } catch {
    // connection already gone
  }
  const exited = await Promise.race([
    new Promise((r) => {
      if (chrome.proc.exitCode !== null || chrome.proc.signalCode !== null) r(true);
      else chrome.proc.once('exit', () => r(true));
    }),
    sleep(5000).then(() => false),
  ]);
  // POSIX: always sweep the process group (zygote/helpers can outlive the main pid).
  if (!exited || process.platform !== 'win32') killTree(chrome.proc.pid);
  return exited;
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

export function killPid(pid) {
  if (pid && isAlive(pid)) killTree(pid);
}

/** PIDs owning a local socket on 127.0.0.1:<port> (the owner's primary, if any). */
export function portOwners(port) {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' });
      const pids = new Set();
      for (const line of out.split(/\r?\n/)) {
        const cols = line.trim().split(/\s+/);
        if (cols[0] === 'TCP' && cols[1] === `127.0.0.1:${String(port)}` && cols[4] !== '0') {
          pids.add(Number(cols[4]));
        }
      }
      return [...pids];
    }
    const out = execFileSync('lsof', ['-nP', `-iTCP:${String(port)}`, '-sTCP:LISTEN', '-t'], {
      encoding: 'utf8',
    });
    return [...new Set(out.split(/\s+/).filter(Boolean).map(Number))];
  } catch (e) {
    // lsof exits 1 when nothing matches; a missing tool is a real error.
    if (e.code === 'ENOENT') throw new Error(`cannot inspect port ${String(port)}: ${e.message}`);
    return [];
  }
}

/** Remove a temp dir, retrying while Chrome releases its file handles. */
export async function removeDir(dir) {
  for (let i = 0; i < 20; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // still locked
    }
    if (!existsSync(dir)) return true;
    await sleep(250);
  }
  return false;
}
