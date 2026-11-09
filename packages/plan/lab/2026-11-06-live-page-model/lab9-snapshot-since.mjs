// Lab 9: S2 acceptance and token measurement with the PRODUCTION in-page code
// (built `packages/extension/dist/inpage/{observer,builders}.js`) over raw CDP
// against the lab Chrome on port 9222, on Home Assistant (Lit).
//
//   1. Spec §6.2 acceptance in a real page: two snapshots of an idle page
//      diff to empty; a synthetic insertion reports exactly the inserted
//      entry; after a full reload `since` is rejected with `doc-changed`
//      and a full snapshot is returned.
//   2. Token measurement (spec v4 §1 / handoff §3): a 10-look sequence over
//      one view with read-only interactions between looks, taking at each
//      look BOTH a full snapshot and a `since` snapshot, and comparing result
//      bytes like for like.
//
// Read-only on the house: navigation inside /config, a text filter, and one
// synthetic <button> appended to <body> and removed again.
//
// usage: node lab9-snapshot-since.mjs
// Writes results/lab9-snapshot-since-ha.json (machine paths scrubbed).

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { OBSERVER_BINDING, OBSERVER_GLOBAL, buildObserverInstallJs } from '../../../extension/dist/inpage/observer.js';
import { buildSnapshotJs } from '../../../extension/dist/inpage/builders.js';

const LAB_DIR = dirname(fileURLToPath(import.meta.url));
const HTTP = 'http://127.0.0.1:9222';
const PAGE = 'http://homeassistant.local:8123/config/entities';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const target = await (await fetch(`${HTTP}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res);
  ws.addEventListener('error', rej);
});
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
  const m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
  if (m.id !== undefined) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (!p) return;
    m.error ? p.reject(new Error(`${p.method}: ${m.error.message}`)) : p.resolve(m.result);
    return;
  }
  for (const l of listeners) l(m.method, m.params);
});
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __exception: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text };
  return r.result.value;
};
const waitLoad = () => new Promise((r) => listeners.push((m) => m === 'Page.loadEventFired' && r()));

await send('Page.enable');
await send('Runtime.enable');
await send('Runtime.addBinding', { name: OBSERVER_BINDING });
await send('Page.addScriptToEvaluateOnNewDocument', { source: buildObserverInstallJs(), runImmediately: true });
const loaded = waitLoad();
await send('Page.navigate', { url: PAGE });
await Promise.race([loaded, sleep(20000)]);
await sleep(3000);
await send('Page.bringToFront');

const snap = (opts) => evaluate(buildSnapshotJs(opts));
const bytes = (v) => JSON.stringify(v).length;
const DEEP = `const deepAll = (sel, root = document, out = []) => { out.push(...root.querySelectorAll(sel)); for (const el of root.querySelectorAll('*')) if (el.shadowRoot) deepAll(sel, el.shadowRoot, out); return out; };`;
const clickHref = (href) => evaluate(`(() => { ${DEEP} const a = deepAll('a[href="${href}"]').find((x) => x.getClientRects().length); if (!a) return 'not-found'; a.click(); return 'clicked'; })()`);
const typeInto = (selector, text) =>
  evaluate(`(() => { ${DEEP} const el = deepAll(${JSON.stringify(selector)}).find((x) => x.getClientRects().length); if (!el) return 'not-found'; el.focus(); const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(el, ${JSON.stringify(text)}); el.dispatchEvent(new Event('input', { bubbles: true, composed: true })); return 'typed'; })()`);

const out = { page: PAGE, observer: await evaluate(`(() => { const g = window[${JSON.stringify(OBSERVER_GLOBAL)}]; return g ? { version: g.version, doc_id: g.doc_id } : null; })()`) };

// --- 1. Acceptance ---------------------------------------------------------
const full1 = await snap({});
const idle = await snap({ since: full1.snapshot_id });
out.acceptance_idle = {
  first_snapshot_id: full1.snapshot_id,
  first_interactive: full1.interactive.length,
  diff_keys: Object.keys(idle),
  added: idle.added?.length,
  removed: idle.removed?.length,
  changed: idle.changed?.length,
  since_status: idle.since_status ?? null,
};
await evaluate(`(() => { const b = document.createElement('button'); b.id = '__bl_lab9_probe'; b.textContent = 'lab9 probe'; document.body.appendChild(b); return 'added'; })()`);
await sleep(300);
const afterInsert = await snap({ since: idle.snapshot_id });
out.acceptance_insertion = {
  added: afterInsert.added,
  removed_count: afterInsert.removed?.length,
  changed_count: afterInsert.changed?.length,
  since_status: afterInsert.since_status ?? null,
};
await evaluate(`(() => { document.getElementById('__bl_lab9_probe').remove(); return 'removed'; })()`);
await sleep(300);
const afterRemove = await snap({ since: afterInsert.snapshot_id });
out.acceptance_removal = { added_count: afterRemove.added?.length, removed: afterRemove.removed, changed_count: afterRemove.changed?.length };
const staleId = afterRemove.snapshot_id;
const reloaded = waitLoad();
await send('Page.reload');
await Promise.race([reloaded, sleep(20000)]);
await sleep(3000);
const afterReload = await snap({ since: staleId });
out.acceptance_reload = {
  stale_since: staleId,
  new_doc_id: afterReload.doc_id,
  new_snapshot_id: afterReload.snapshot_id,
  since_status: afterReload.since_status ?? null,
  has_full_interactive: Array.isArray(afterReload.interactive),
  interactive_count: afterReload.interactive?.length,
  has_diff_keys: 'added' in afterReload,
};

// --- 2. Token measurement ---------------------------------------------------
const steps = [
  ['look 1: baseline', null],
  ['look 2: idle', null],
  ['look 3: type "sensor" in the filter', () => typeInto('input[type="search"], input', 'sensor')],
  ['look 4: idle', null],
  ['look 5: clear the filter', () => typeInto('input[type="search"], input', '')],
  ['look 6: tab Devices', () => clickHref('/config/devices/dashboard')],
  ['look 7: idle', null],
  ['look 8: tab Entities', () => clickHref('/config/entities')],
  ['look 9: type "light"', () => typeInto('input[type="search"], input', 'light')],
  ['look 10: idle', null],
];
const looks = [];
let prevId = null;
for (const [label, act] of steps) {
  if (act) await act();
  await sleep(1500);
  const full = await snap({});
  const row = { step: label, full_bytes: bytes(full), full_interactive: full.interactive.length };
  if (prevId) {
    const diff = await snap({ since: prevId });
    row.since_bytes = bytes(diff);
    row.added = diff.added?.length;
    row.removed = diff.removed?.length;
    row.changed = diff.changed?.length;
    row.since_status = diff.since_status ?? null;
    prevId = diff.snapshot_id;
  } else {
    prevId = full.snapshot_id;
  }
  looks.push(row);
  console.log(JSON.stringify(row));
}
const fullTotal = looks.reduce((a, r) => a + r.full_bytes, 0);
const sinceTotal = looks[0].full_bytes + looks.slice(1).reduce((a, r) => a + r.since_bytes, 0);
out.token_measurement = {
  looks,
  ten_looks_full_bytes: fullTotal,
  ten_looks_one_full_then_since_bytes: sinceTotal,
  saving_ratio: Number((1 - sinceTotal / fullTotal).toFixed(3)),
  note: 'bytes of the JSON result as evaluated in-page; the MCP envelope adds a constant per call',
};

ws.close();
await fetch(`${HTTP}/json/close/${target.id}`).catch(() => {});
mkdirSync(join(LAB_DIR, 'results'), { recursive: true });
const scrub = (s) => s.replaceAll(LAB_DIR.replaceAll('\\', '/'), '<lab-dir>').replaceAll(LAB_DIR, '<lab-dir>');
writeFileSync(join(LAB_DIR, 'results', 'lab9-snapshot-since-ha.json'), scrub(JSON.stringify(out, null, 2)) + '\n');
console.log('wrote results/lab9-snapshot-since-ha.json');
