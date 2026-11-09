// A1: does headless Chrome load the built extension and start its MV3 service
// worker? Tries --load-extension, then CDP Extensions.loadUnpacked without and
// with --enable-unsafe-extension-debugging.
// Usage: node a1-headless-sw.mjs  -> writes results/a1-headless-sw.json
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  LAB_DIR, CHROME, Cdp, extensionCopy, launchChrome, waitHttp, waitServiceWorker,
  stopChrome, removeDir, now,
} from './lib.mjs';

const results = { chrome_binary: CHROME, runs: [] };
const PORT = 29222;
const extDir = extensionCopy(17529); // unpatched copy: A1 does not connect anything

for (const [i, mode] of ['flag', 'cdp-noflag', 'cdp'].entries()) {
  const t0 = now();
  const chrome = launchChrome({ port: PORT + i, extDir, mode });
  const run = { mode, args: chrome.args.map((a) => a.replace(chrome.profile, '<profile>').replace(extDir, '<ext>')) };
  let cdp;
  try {
    const ver = await waitHttp(`http://127.0.0.1:${PORT + i}/json/version`);
    run.browser = ver.Browser;
    run.user_agent = ver['User-Agent'];
    run.devtools_ready_ms = Math.round(now() - t0);
    cdp = await Cdp.open(ver.webSocketDebuggerUrl);
    if (mode.startsWith('cdp')) {
      const tl = now();
      try {
        const r = await cdp.send('Extensions.loadUnpacked', { path: extDir });
        run.load_unpacked = { ok: true, id: r.id, ms: Math.round(now() - tl) };
      } catch (e) {
        run.load_unpacked = { ok: false, error: e.message };
      }
    }
    const { sw, ms, targets } = await waitServiceWorker(cdp, 8000, run.load_unpacked?.id);
    run.service_worker = sw ? { url: sw.url, type: sw.type } : null;
    run.sw_wait_ms = Math.round(ms);
    run.sw_ready_since_launch_ms = Math.round(now() - t0);
    if (!sw) run.targets_seen = targets.map((t) => `${t.type} ${t.url}`);
    if (sw) {
      // Attach to the worker and evaluate something to prove it runs.
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
      // Right after attach the worker's script may not have run yet ("chrome is
      // not defined"); retry until the extension globals are there.
      const te = now();
      for (let k = 0; ; k++) {
        try {
          run.sw_eval = await cdp.evaluate(
            `({ id: chrome.runtime.id, version: chrome.runtime.getManifest().version, min: chrome.runtime.getManifest().minimum_chrome_version ?? null })`,
            sessionId,
          );
          run.sw_eval_attempts = k + 1;
          run.sw_eval_ms = Math.round(now() - te);
          break;
        } catch (e) {
          if (now() - te > 5000) { run.sw_eval_error = e.message; break; }
          await new Promise((r) => setTimeout(r, 100));
        }
      }
    }
  } catch (e) {
    run.error = e.message;
  }
  run.clean_exit = await stopChrome(chrome, cdp);
  cdp?.close();
  run.profile_removed = await removeDir(chrome.profile);
  results.runs.push(run);
}
results.ext_copy_removed = await removeDir(extDir);
writeFileSync(join(LAB_DIR, 'results/a1-headless-sw.json'), JSON.stringify(results, null, 2) + '\n');
console.log(JSON.stringify(results, null, 2));
