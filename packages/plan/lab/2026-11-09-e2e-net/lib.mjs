// Shared helpers for the e2e-net lab: launch an isolated Chrome, talk raw CDP,
// patch the lab copies of the extension/server ports, clean up.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LAB_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(LAB_DIR, '../../../..');
export const EXT_DIST = join(REPO, 'packages/extension/dist');
export const SERVER_CLI = join(REPO, 'packages/server/dist/cli.js');
export const CHROME =
  process.env.LAB_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const now = () => performance.now();

/** Copy the built extension to a temp dir, rewriting the WS bridge port. */
export function extensionCopy(wsPort) {
  const dir = mkdtempSync(join(tmpdir(), 'bl-e2e-ext-'));
  cpSync(EXT_DIST, dir, { recursive: true });
  if (wsPort !== 17529) {
    const bg = join(dir, 'background.js');
    const src = readFileSync(bg, 'utf8');
    const out = src.replaceAll("'ws://127.0.0.1:17529'", `'ws://127.0.0.1:${wsPort}'`);
    if (out === src) throw new Error('WS_URL literal not found in background.js');
    writeFileSync(bg, out);
  }
  return dir;
}

export function launchChrome({ port, extDir, mode }) {
  const profile = mkdtempSync(join(tmpdir(), 'bl-e2e-profile-'));
  const args = [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];
  if (mode === 'flag') args.push(`--load-extension=${extDir}`, `--disable-extensions-except=${extDir}`);
  if (mode === 'cdp') args.push('--enable-unsafe-extension-debugging');
  args.push('about:blank');
  const proc = spawn(CHROME, args, { stdio: 'ignore' });
  return { proc, profile, args };
}

export async function waitHttp(url, timeoutMs = 15000) {
  const t0 = now();
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch {}
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
    c.listeners = [];
    await new Promise((r, j) => {
      c.ws.addEventListener('open', r);
      c.ws.addEventListener('error', j);
    });
    c.ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data.toString());
      if (m.id !== undefined) {
        const p = c.pending.get(m.id);
        if (!p) return;
        c.pending.delete(m.id);
        m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
      } else for (const l of c.listeners) l(m);
    });
    return c;
  }
  send(method, params = {}, sessionId) {
    return new Promise((res, rej) => {
      const i = ++this.id;
      this.pending.set(i, { res, rej });
      this.ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  async evaluate(expression, sessionId) {
    const r = await this.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      sessionId,
    );
    if (r.exceptionDetails)
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }
  close() {
    try { this.ws.close(); } catch {}
  }
}

/** Poll Target.getTargets until the browser-link worker (background.js) shows up.
 * Chrome also runs built-in component extension workers; those are ignored. */
export async function waitServiceWorker(cdp, timeoutMs = 15000, extId) {
  const t0 = now();
  const match = extId
    ? (u) => u === `chrome-extension://${extId}/background.js`
    : (u) => /^chrome-extension:\/\/[a-p]{32}\/background\.js$/.test(u);
  for (;;) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    const sw = targetInfos.find((t) => t.type === 'service_worker' && match(t.url));
    if (sw) return { sw, ms: now() - t0 };
    if (now() - t0 > timeoutMs) return { sw: null, ms: now() - t0, targets: targetInfos };
    await sleep(50);
  }
}

export async function stopChrome(chrome, browserCdp) {
  try { if (browserCdp) await Promise.race([browserCdp.send('Browser.close'), sleep(3000)]); } catch {}
  const exited = await Promise.race([
    new Promise((r) => (chrome.proc.exitCode !== null ? r(true) : chrome.proc.once('exit', () => r(true)))),
    sleep(5000).then(() => false),
  ]);
  if (!exited) {
    try { execFileSync('taskkill', ['/T', '/F', '/PID', String(chrome.proc.pid)], { stdio: 'ignore' }); } catch {}
    await sleep(500);
  }
  return exited;
}

/** Remove a temp dir, retrying while Chrome releases its file handles. */
export async function removeDir(dir) {
  for (let i = 0; i < 20; i++) {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
    if (!existsSync(dir)) return true;
    await sleep(250);
  }
  return false;
}
