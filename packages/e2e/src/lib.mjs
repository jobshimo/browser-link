// Helpers for the e2e harness: resolve and launch an isolated headless Chrome,
// talk raw CDP over Node's global WebSocket (no flag needed since Node 22.0.0,
// stable since 22.4.0: https://nodejs.org/docs/latest-v22.x/api/globals.html),
// pick free ports, find the owner's running primary, clean up.
// Derived from packages/plan/lab/2026-11-09-e2e-net/lib.mjs.
import { spawn, execFileSync } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { inflateSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const E2E_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO = resolve(E2E_DIR, '../..');
/** The builds under test. The differential (scripts/e2e-diff.mjs) points
 * HEAD's harness at another build with E2E_EXT_DIST (the extension's dist/),
 * E2E_SERVER_CLI (the server's dist/cli.js) and E2E_SERVER_EXTENSION_ID (that
 * build's dist/auth/extension-id.js; defaults to the one next to
 * E2E_SERVER_CLI, so the pinned id always comes from the server that runs). */
export function buildPaths(env = process.env, repo = REPO) {
  const serverCli = env.E2E_SERVER_CLI
    ? resolve(env.E2E_SERVER_CLI)
    : join(repo, 'packages/server/dist/cli.js');
  return {
    extDist: env.E2E_EXT_DIST ? resolve(env.E2E_EXT_DIST) : join(repo, 'packages/extension/dist'),
    serverCli,
    serverExtensionId: env.E2E_SERVER_EXTENSION_ID
      ? resolve(env.E2E_SERVER_EXTENSION_ID)
      : join(dirname(serverCli), 'auth/extension-id.js'),
  };
}
const BUILD = buildPaths();
export const EXT_DIST = BUILD.extDist;
export const SERVER_CLI = BUILD.serverCli;
const SERVER_EXTENSION_ID = BUILD.serverExtensionId;
export const PAGE_FILE = join(E2E_DIR, 'pages/index.html');
export const CAPTURE_FILE = join(E2E_DIR, 'pages/capture.html');
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
  const seen = { websocket: undefined, fetch: undefined, fetchSite: undefined };
  const server = createHttpServer((req, res) => {
    seen.fetch = req.headers.origin ?? '(none)';
    seen.fetchSite = req.headers['sec-fetch-site'] ?? '(none)';
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

/** Point the bridge port in a built `background.js` source at `wsPort`. esbuild
 * emits `var` where tsc keeps `const`, so the keyword is accepted and kept. */
export function patchBridgePort(src, wsPort) {
  const re = /^(const|var) BRIDGE_PORT = 17529;$/m;
  if (!re.test(src)) throw new Error('"const|var BRIDGE_PORT = 17529;" not found in background.js');
  return src.replace(re, (_, keyword) => `${keyword} BRIDGE_PORT = ${String(wsPort)};`);
}

/** Copy the built extension to a temp dir and point its WS bridge at `wsPort`.
 * `withoutKey` drops the manifest `key`, so Chrome gives the copy another id
 * (derived from its path): an extension the bridge must refuse. */
export function extensionCopy(wsPort, { withoutKey = false } = {}) {
  if (!existsSync(join(EXT_DIST, 'manifest.json'))) {
    throw new Error(`${EXT_DIST} is not built; run pnpm build first`);
  }
  const dir = mkdtempSync(join(tmpdir(), 'bl-e2e-ext-'));
  cpSync(EXT_DIST, dir, { recursive: true });
  const bg = join(dir, 'background.js');
  writeFileSync(bg, patchBridgePort(readFileSync(bg, 'utf8'), wsPort));
  if (withoutKey) {
    const manifestFile = join(dir, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    if (typeof manifest.key !== 'string') throw new Error('the built manifest has no key');
    delete manifest.key;
    writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
  }
  return dir;
}

/** `loadExtensions`: unpacked dirs passed with `--load-extension`, for a
 * Chrome without the CDP method `Extensions.loadUnpacked` (it needs a build
 * that still honours the flag, such as Chrome for Testing). */
export function launchChrome({ chromePath, port, loadExtensions = [] }) {
  const profile = mkdtempSync(join(tmpdir(), 'bl-e2e-profile-'));
  // Downloads Chrome itself keeps (the ones browser-link must leave alone) go
  // inside the temp profile, without a prompt, never into the owner's real
  // Downloads folder. Chrome reads this file when it starts.
  const downloadDir = join(profile, 'chrome-downloads');
  mkdirSync(downloadDir);
  mkdirSync(join(profile, 'Default'));
  writeFileSync(
    join(profile, 'Default', 'Preferences'),
    JSON.stringify({
      download: {
        default_directory: downloadDir,
        prompt_for_download: false,
        directory_upgrade: true,
      },
      savefile: { default_directory: downloadDir },
    }),
  );
  const args = [
    '--headless=new',
    `--remote-debugging-port=${String(port)}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--enable-unsafe-extension-debugging',
    // No "is debugging this browser" infobar: when a second extension attaches
    // its debugger (bridge.refused), Chrome would detach it as canceled_by_user.
    '--silent-debugger-extension-api',
  ];
  if (loadExtensions.length > 0) args.push(`--load-extension=${loadExtensions.join(',')}`);
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
  return { proc, profile, downloadDir };
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

/** A value as a JavaScript literal that is safe to splice into evaluated source:
 * JSON.stringify leaves U+2028/U+2029 and `<`, `>`, `/` unescaped. */
export function jsLiteral(value) {
  return JSON.stringify(value).replace(
    /[<>\/\u2028\u2029]/g,
    (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
  );
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

/** Poll until `count` extension service workers (background.js) are CDP
 * targets; returns their extension ids. */
export async function waitExtensionIds(cdp, count, timeoutMs) {
  const t0 = now();
  for (;;) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    const ids = targetInfos
      .filter((t) => t.type === 'service_worker')
      .map((t) => /^chrome-extension:\/\/([a-p]{32})\/background\.js$/.exec(t.url)?.[1])
      .filter(Boolean);
    if (ids.length >= count) return [...new Set(ids)];
    if (now() - t0 > timeoutMs) {
      throw new Error(`only ${String(ids.length)} of ${String(count)} extension workers started`);
    }
    await sleep(100);
  }
}

/** Where the run's browser record goes unless E2E_RESULT_FILE says otherwise:
 * the package's build/ folder, which the root .gitignore excludes. */
export const RESULT_FILE = join(E2E_DIR, 'build/e2e-result.json');

/** The browser a run used, from `/json/version` (`Browser`) and the CDP
 * `Browser.getVersion` result (`product`, `revision`, `protocolVersion`).
 * A field the run never reached (Chrome did not start) is null. */
export function resultRecord({ jsonVersion, cdpVersion, ok }) {
  return {
    browser: jsonVersion?.Browser ?? null,
    product: cdpVersion?.product ?? null,
    revision: cdpVersion?.revision ?? null,
    protocolVersion: cdpVersion?.protocolVersion ?? jsonVersion?.['Protocol-Version'] ?? null,
    ok,
  };
}

/** The record as a Markdown table for the GitHub step summary. */
export function summaryMarkdown(record, leg) {
  const cell = (v) => (v === null || v === undefined ? '(unknown)' : String(v));
  const verdict = record.ok ? 'ok' : 'FAIL';
  return [
    '',
    `### e2e${leg ? ` (${leg})` : ''}: ${verdict}`,
    '',
    '| browser | product | revision | protocol |',
    '| --- | --- | --- | --- |',
    `| ${cell(record.browser)} | ${cell(record.product)} | ${cell(record.revision)} | ${cell(record.protocolVersion)} |`,
    '',
  ].join('\n');
}

/** Write the record to E2E_RESULT_FILE (default RESULT_FILE) and, when
 * GITHUB_STEP_SUMMARY is set, append it there titled with E2E_LEG.
 * Returns the JSON file path. */
export function writeResult(record, env = process.env) {
  const file = resolve(env.E2E_RESULT_FILE || RESULT_FILE);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, summaryMarkdown(record, env.E2E_LEG));
  }
  return file;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Decode an 8-bit, non-interlaced RGB or RGBA PNG (what Chrome's canvas
 * `toDataURL` and `Page.captureScreenshot` produce) into
 * `{ width, height, pixel(x, y) -> [r, g, b, a] }`. Throws on anything else,
 * so a capture in another shape fails loudly instead of reading garbage. */
export function decodePng(buf) {
  if (!Buffer.isBuffer(buf) || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('not a PNG (bad signature)');
  }
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat = [];
  for (let at = 8; at + 8 <= buf.length;) {
    const len = buf.readUInt32BE(at);
    const type = buf.toString('latin1', at + 4, at + 8);
    const data = buf.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const [depth, colorType, , , interlace] = data.subarray(8, 13);
      channels = { 2: 3, 6: 4 }[colorType] ?? 0;
      if (depth !== 8 || !channels || interlace !== 0) {
        throw new Error(
          `unsupported PNG: depth ${depth}, color type ${colorType}, interlace ${interlace}`,
        );
      }
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    at += 12 + len;
  }
  if (!width || !height) throw new Error('PNG without IHDR');
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? px[y * stride + i - channels] : 0;
      const b = y > 0 ? px[(y - 1) * stride + i] : 0;
      const c = y > 0 && i >= channels ? px[(y - 1) * stride + i - channels] : 0;
      let p;
      if (filter === 0) p = 0;
      else if (filter === 1) p = a;
      else if (filter === 2) p = b;
      else if (filter === 3) p = (a + b) >> 1;
      else if (filter === 4) {
        const e = a + b - c;
        const [da, db, dc] = [Math.abs(e - a), Math.abs(e - b), Math.abs(e - c)];
        p = da <= db && da <= dc ? a : db <= dc ? b : c;
      } else throw new Error(`bad PNG filter ${filter} on row ${y}`);
      px[y * stride + i] = (line[i] + p) & 0xff;
    }
  }
  return {
    width,
    height,
    pixel(x, y) {
      const o = y * stride + x * channels;
      return [px[o], px[o + 1], px[o + 2], channels === 4 ? px[o + 3] : 255];
    },
  };
}

/** Each channel of `got` within `tolerance` of `want` ([r, g, b]). */
export function colorNear(got, want, tolerance = 8) {
  return want.every((v, i) => Math.abs(got[i] - v) <= tolerance);
}
