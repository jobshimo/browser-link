// Lab 7: two open questions from spec v4 §7, measured with the REAL observer
// source (`packages/extension/src/inpage/observer.ts`, loaded with Node 24
// type stripping), over raw CDP against the lab Chrome on port 9222.
//
//   csp  — does `Page.addScriptToEvaluateOnNewDocument` run the observer on a
//          page with a strict Content-Security-Policy? Records the CSP header
//          of the main document, the `doc_start` push, the installed version,
//          a mark → mutate → changes round trip, and every CSP-related console
//          or exception entry.
//   soak — run the observer on `storm.html` (≈13k mutations/s when visible)
//          for N minutes and sample the page's JS heap and DOM node count every
//          10 s, exercising mark/changes each time so the ring is read as in
//          production. Reports first/last/max heap after a warm-up.
//
// usage: node lab7-csp-soak.mjs csp <url>
//        node lab7-csp-soak.mjs soak [minutes=5]
//
// Writes an unedited JSON under results/ with machine paths scrubbed to
// <lab-dir>. Opens its own tab and closes it; never touches a tab the
// extension holds (one debugger per tab).

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import {
  OBSERVER_BINDING,
  OBSERVER_GLOBAL,
  OBSERVER_VERSION,
  buildObserverInstallJs,
  buildObserverMarkJs,
  buildObserverChangesJs,
  buildObserverTeardownJs,
} from '../../../extension/src/inpage/observer.ts';

const LAB_DIR = dirname(fileURLToPath(import.meta.url));
const HTTP = 'http://127.0.0.1:9222';
const [, , mode, arg] = process.argv;
if (mode !== 'csp' && mode !== 'soak') {
  console.error('usage: lab7-csp-soak.mjs csp <url> | soak [minutes]');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const scrub = (s) =>
  String(s)
    .replaceAll(pathToFileURL(LAB_DIR).href, '<lab-dir>')
    .replaceAll(LAB_DIR.replaceAll('\\', '/'), '<lab-dir>')
    .replaceAll(LAB_DIR, '<lab-dir>');

async function openTarget(url) {
  const res = await fetch(`${HTTP}/json/new?${url}`, { method: 'PUT' });
  if (!res.ok) throw new Error(`json/new ${res.status}`);
  return res.json();
}
async function closeTarget(id) {
  await fetch(`${HTTP}/json/close/${id}`).catch(() => {});
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  const listeners = [];
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject, method });
      ws.send(JSON.stringify({ id, method, params }));
    });
  ws.addEventListener('message', (ev) => {
    const raw = typeof ev.data === 'string' ? ev.data : ev.data.toString();
    const msg = JSON.parse(raw);
    if (msg.id !== undefined) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (!p) return;
      msg.error ? p.reject(new Error(`${p.method}: ${msg.error.message}`)) : p.resolve(msg.result);
      return;
    }
    for (const l of listeners) l(msg.method, msg.params, raw.length);
  });
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { __exception: r.exceptionDetails.text, details: r.exceptionDetails.exception?.description };
    return r.result.value;
  };
  return { ws, send, listeners, ready, evaluate, close: () => ws.close() };
}

async function installObserver(c, pushes) {
  c.listeners.push((method, params) => {
    if (method === 'Runtime.bindingCalled' && params.name === OBSERVER_BINDING) {
      let payload;
      try {
        payload = JSON.parse(params.payload);
      } catch {
        payload = { unparsed: params.payload.slice(0, 200) };
      }
      pushes.push({ at: Date.now(), bytes: params.payload.length, ...payload });
    }
  });
  await c.send('Runtime.enable');
  await c.send('Page.enable');
  await c.send('Runtime.addBinding', { name: OBSERVER_BINDING });
  const added = await c.send('Page.addScriptToEvaluateOnNewDocument', {
    source: buildObserverInstallJs(),
    runImmediately: true,
  });
  return added;
}

function writeResult(name, data) {
  mkdirSync(join(LAB_DIR, 'results'), { recursive: true });
  const file = join(LAB_DIR, 'results', name);
  writeFileSync(file, scrub(JSON.stringify(data, null, 2)) + '\n');
  console.log(`wrote results/${name}`);
}

// ---------------------------------------------------------------------------
if (mode === 'csp') {
  const url = arg;
  if (!url) {
    console.error('csp needs a url');
    process.exit(2);
  }
  const target = await openTarget('about:blank');
  const c = connect(target.webSocketDebuggerUrl);
  await c.ready;
  const pushes = [];
  const consoleEntries = [];
  const exceptions = [];
  const mainResponses = [];
  c.listeners.push((method, params) => {
    if (method === 'Log.entryAdded') {
      const e = params.entry;
      consoleEntries.push({ level: e.level, source: e.source, text: String(e.text).slice(0, 300) });
    } else if (method === 'Runtime.exceptionThrown') {
      exceptions.push(String(params.exceptionDetails.text + ' ' + (params.exceptionDetails.exception?.description ?? '')).slice(0, 300));
    } else if (method === 'Network.responseReceived' && params.type === 'Document') {
      const h = params.response.headers;
      const pick = (name) => Object.entries(h).find(([k]) => k.toLowerCase() === name)?.[1] ?? null;
      mainResponses.push({
        url: params.response.url,
        status: params.response.status,
        csp: pick('content-security-policy'),
        csp_report_only: pick('content-security-policy-report-only'),
      });
    }
  });
  await c.send('Network.enable');
  await c.send('Log.enable');
  const added = await installObserver(c, pushes);
  const navStart = Date.now();
  const loaded = new Promise((r) => c.listeners.push((m) => m === 'Page.loadEventFired' && r()));
  await c.send('Page.navigate', { url });
  await Promise.race([loaded, sleep(20_000)]);
  await sleep(2000);
  const docStart = pushes.filter((p) => p.type === 'doc_start');
  const probe = await c.evaluate(
    `(() => { const g = window[${JSON.stringify(OBSERVER_GLOBAL)}]; return g ? { present: true, version: g.version, has_mark: typeof g.mark, has_changes: typeof g.changes } : { present: false }; })()`,
  );
  const metaCsp = await c.evaluate(
    `(() => { const m = document.querySelector('meta[http-equiv="Content-Security-Policy" i]'); return m ? m.getAttribute('content') : null; })()`,
  );
  const mark = await c.evaluate(buildObserverMarkJs());
  const mutate = await c.evaluate(
    `(() => { const d = document.createElement('div'); d.id = '__bl_lab7_probe'; d.textContent = 'lab7'; document.body.appendChild(d); return { appended: !!d.parentNode }; })()`,
  );
  await sleep(300);
  const changes = await c.evaluate(buildObserverChangesJs(typeof mark === 'object' && mark ? mark.mark ?? mark.seq ?? 0 : Number(mark) || 0, undefined));
  const teardown = await c.evaluate(buildObserverTeardownJs());
  c.close();
  await closeTarget(target.id);
  const cspEntries = consoleEntries.filter((e) => /content.security.policy|csp|refused to execute/i.test(e.text));
  writeResult(`lab7-csp-${new URL(url).hostname.replace(/[^a-z0-9.-]/gi, '_')}.json`, {
    question: 'Does Page.addScriptToEvaluateOnNewDocument run the production observer on a page with a strict CSP?',
    url,
    observer_version_built: OBSERVER_VERSION,
    add_script_result: added,
    main_document_responses: mainResponses,
    meta_csp: metaCsp,
    load_ms: Date.now() - navStart,
    doc_start_pushes: docStart,
    pushes_total: pushes.length,
    observer_probe: probe,
    mark,
    mutate,
    changes,
    teardown,
    csp_related_console_entries: cspEntries,
    exceptions,
    all_console_entries_count: consoleEntries.length,
    verdict:
      docStart.length > 0 && probe && probe.present && changes && changes.ok && changes.records >= 1
        ? 'observer ran and reported on a CSP page'
        : 'observer did NOT run or did not report — read the fields',
  });
}

// ---------------------------------------------------------------------------
if (mode === 'soak') {
  const minutes = Number(arg) || 5;
  const stormUrl = pathToFileURL(join(LAB_DIR, 'storm.html')).href;
  const target = await openTarget(stormUrl);
  const c = connect(target.webSocketDebuggerUrl);
  await c.ready;
  const pushes = [];
  const added = await installObserver(c, pushes);
  await c.send('Page.reload'); // the observer must be present before page scripts run
  await sleep(1500);
  await c.send('Page.bringToFront'); // rAF-driven storm pauses when hidden
  await c.send('Performance.enable');
  const metrics = async () => {
    const r = await c.send('Performance.getMetrics');
    const m = Object.fromEntries(r.metrics.map((x) => [x.name, x.value]));
    return { heap_used: m.JSHeapUsedSize, heap_total: m.JSHeapTotalSize, nodes: m.Nodes, listeners: m.JSEventListeners };
  };
  const samples = [];
  const t0 = Date.now();
  const end = t0 + minutes * 60_000;
  let lastPushCount = 0;
  while (Date.now() < end) {
    const mark = await c.evaluate(buildObserverMarkJs());
    await sleep(10_000);
    const markSeq = typeof mark === 'object' && mark ? mark.mark ?? mark.seq ?? 0 : Number(mark) || 0;
    const changes = await c.evaluate(buildObserverChangesJs(markSeq, undefined));
    const m = await metrics();
    const visibility = await c.evaluate('document.visibilityState');
    samples.push({
      t_s: Math.round((Date.now() - t0) / 1000),
      ...m,
      visibility,
      pushes_in_window: pushes.length - lastPushCount,
      changes_records: changes && changes.records,
      changes_targets: changes && changes.targets,
      changes_truncated: changes && changes.truncated === true,
      changes_ok: changes && changes.ok,
    });
    lastPushCount = pushes.length;
    console.log(JSON.stringify(samples.at(-1)));
  }
  // Force a GC-ish settle before the final reading: a second metrics call after a pause.
  await sleep(3000);
  const final = await metrics();
  const teardown = await c.evaluate(buildObserverTeardownJs());
  await sleep(3000);
  const afterTeardown = await metrics();
  c.close();
  await closeTarget(target.id);
  const warm = samples.slice(Math.min(3, samples.length - 1));
  const heaps = warm.map((s) => s.heap_used);
  writeResult(`lab7-soak-storm-${minutes}min.json`, {
    question: 'Does the observer leak under a sustained mutation storm?',
    page: stormUrl,
    minutes,
    observer_version_built: OBSERVER_VERSION,
    add_script_result: added,
    sample_every_s: 10,
    samples,
    pushes_total: pushes.length,
    push_bytes_total: pushes.reduce((a, p) => a + p.bytes, 0),
    summary: {
      warm_first_heap_used: heaps[0],
      warm_last_heap_used: heaps.at(-1),
      warm_max_heap_used: Math.max(...heaps),
      warm_min_heap_used: Math.min(...heaps),
      growth_first_to_last_bytes: heaps.at(-1) - heaps[0],
      final_after_pause: final,
      after_teardown: afterTeardown,
      teardown,
    },
  });
}
