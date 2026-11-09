// Lab 11: S3 acceptance (spec v4 §6.3) in a REAL page with the BUILT in-page
// code (`packages/extension/dist/inpage/{observer,builders}.js`) over raw CDP
// against the lab Chrome on port 9222, on Home Assistant (Lit).
//
//   A. "A Lit list re-rendered with the same items keeps refs valid": take a
//      ref for a row element, switch tab away and back (lab 8 showed nodes
//      kept), resolve the ref → same node, reresolved false.
//   B. "A re-render that replaces nodes re-resolves by key": take refs for row
//      elements, type a filter that keeps some rows but rebuilds them, resolve
//      a kept row's ref → reresolved true (and the resolved node's text equals
//      the old one); resolve a filtered-out row's ref → ref-stale.
//   C. "A changed name invalidates the ref": a synthetic <button> appended to
//      <body>, ref taken via find, then replaced by a new <button> with another
//      text at the same place → ref-stale; same text → reresolved.
//   D. find({ key }) with the semantic_key returned by a find, after a
//      replacing re-render → the same logical element.
// (The fourth §6.3 clause, "ambiguous entries never get a stored key", is a
// server-side map rule covered by packages/server/src/map/semantic-key.test.ts.)
//
// Read-only on the house: a text filter and tab switches; synthetic nodes only.
// usage: node lab11-ref-target.mjs
// Writes results/lab11-ref-target-ha.json (machine paths scrubbed).

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { OBSERVER_BINDING, OBSERVER_GLOBAL, buildObserverInstallJs, buildObserverRefResolveJs, buildObserverSemanticKeyJs } from '../../../extension/dist/inpage/observer.js';
import { buildFindJs, buildElementRectJs } from '../../../extension/dist/inpage/builders.js';

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

const DEEP = `const deepAll = (sel, root = document, out = []) => { out.push(...root.querySelectorAll(sel)); for (const el of root.querySelectorAll('*')) if (el.shadowRoot) deepAll(sel, el.shadowRoot, out); return out; };`;
const clickHref = (href) => evaluate(`(() => { ${DEEP} const a = deepAll('a[href="${href}"]').find((x) => x.getClientRects().length); if (!a) return 'not-found'; a.click(); return 'clicked'; })()`);
const typeInto = (selector, text) =>
  evaluate(`(() => { ${DEEP} const el = deepAll(${JSON.stringify(selector)}).find((x) => x.getClientRects().length); if (!el) return 'not-found'; el.focus(); const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(el, ${JSON.stringify(text)}); el.dispatchEvent(new Event('input', { bubbles: true, composed: true })); return 'typed'; })()`);
// Element rect resolves the target without the click hit-test (a synthetic
// node appended to <body> is covered by the app shell and would read as occluded).
const resolve = (ref) => evaluate(buildElementRectJs({ ref }));
const textOfRef = (ref) => evaluate(`(() => { const g = window[${JSON.stringify(OBSERVER_GLOBAL)}]; const el = g && g.resolveRef(${JSON.stringify(ref)}); return el ? (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 60) : null; })()`);

const out = { page: PAGE, observer: await evaluate(`(() => { const g = window[${JSON.stringify(OBSERVER_GLOBAL)}]; return g ? { version: g.version, doc_id: g.doc_id } : null; })()`) };

// Row elements: the HA entities table rows are div[role=row] inside shadow
// roots (not in the interactive selector), so take refs for them directly
// through the observer, as snapshot would for interactive elements.
const picked = await evaluate(`(() => { ${DEEP} const g = window[${JSON.stringify(OBSERVER_GLOBAL)}]; const rows = deepAll('div[role=row].mdc-data-table__row').filter((r) => r.getClientRects().length && (r.textContent || '').trim()); return rows.slice(0, 30).map((r) => ({ ref: g.refFor(r), text: (r.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 60) })); })()`);
// The filter term is the first word of the second row: that row survives the
// filter (rebuilt), rows whose text lacks the term disappear.
const term = (picked[1]?.text || '').split(' ')[0];
const rows = picked.filter((r) => r.text.includes(term)).slice(0, 3);
const others = picked.filter((r) => !r.text.includes(term)).slice(0, 2);
out.picked = { term, kept_candidates: rows, dropped_candidates: others, rows_seen: picked.length };

// A. same items re-rendered (tab away and back)
const aRef = rows[0]?.ref;
const aText = aRef ? await textOfRef(aRef) : null;
await clickHref('/config/devices/dashboard');
await sleep(2000);
await clickHref('/config/entities');
await sleep(2500);
const aRes = aRef ? await resolve(aRef) : null;
out.A_same_items_rerender = { ref: aRef, old_text: aText, resolve: aRes && { ok: aRes.ok, reason: aRes.reason, reresolved: aRes.reresolved ?? false, tag: aRes.tag }, new_text: aRef ? await textOfRef(aRef) : null };

// B. replacing re-render: filter "sensor" keeps sensor rows (rebuilt), drops light rows
await typeInto('input[type="search"], input', term);
await sleep(2500);
out.B_replacing_rerender = {
  kept_rows: [],
  dropped_rows: [],
};
for (const r of rows) {
  const res = await resolve(r.ref);
  out.B_replacing_rerender.kept_rows.push({ ref: r.ref, old_text: r.text, ok: res.ok, reason: res.reason, reresolved: res.reresolved ?? false, new_text: await textOfRef(r.ref) });
}
for (const r of others) {
  const res = await resolve(r.ref);
  out.B_replacing_rerender.dropped_rows.push({ ref: r.ref, old_text: r.text, ok: res.ok, reason: res.reason, doc_id: res.doc_id });
}
await typeInto('input[type="search"], input', '');
await sleep(2000);

// C. changed name invalidates; same name re-resolves (synthetic nodes)
await evaluate(`(() => { const b = document.createElement('button'); b.id = '__bl_lab11'; b.textContent = 'lab11 alpha'; document.body.appendChild(b); return 'added'; })()`);
await sleep(200);
const cFind = await evaluate(buildFindJs({ text: 'lab11 alpha' }));
const cRef = cFind.ref;
await evaluate(`(() => { document.getElementById('__bl_lab11').remove(); const b = document.createElement('button'); b.id = '__bl_lab11'; b.textContent = 'lab11 BETA'; document.body.appendChild(b); return 'replaced-renamed'; })()`);
await sleep(200);
const cRenamed = await resolve(cRef);
await evaluate(`(() => { document.getElementById('__bl_lab11').remove(); const b = document.createElement('button'); b.id = '__bl_lab11'; b.textContent = 'lab11 alpha'; document.body.appendChild(b); return 'replaced-same'; })()`);
await sleep(200);
const cSame = await resolve(cRef);
const cBuilder = await evaluate(buildObserverRefResolveJs(cRef));
out.C_changed_name = { find: { matched: cFind.matched, ref: cRef, semantic_key: cFind.semantic_key }, renamed: { ok: cRenamed.ok, reason: cRenamed.reason, doc_id: cRenamed.doc_id }, same_name: { ok: cSame.ok, reason: cSame.reason, reresolved: cSame.reresolved ?? false }, builder_after: cBuilder };

// D. find by key (the key of a kept row) after a replacing re-render
const dKey = rows[0] ? await evaluate(buildObserverSemanticKeyJs(rows[0].ref)) : null;
await typeInto('input[type="search"], input', term);
await sleep(2500);
const dByKey = dKey?.key ? await evaluate(buildFindJs({ key: dKey.key })) : null;
const dByKeyNoPath = dKey?.key ? await evaluate(buildFindJs({ key: { role: dKey.key.role, name: dKey.key.name } })) : null;
out.D_find_by_key = { row: rows[0], key: dKey?.key, by_key_with_path: dByKey && { matched: dByKey.matched, text: dByKey.text, ref: dByKey.ref, reresolved: dByKey.reresolved, reason: dByKey.reason, error: dByKey.error }, by_key_without_path: dByKeyNoPath && { matched: dByKeyNoPath.matched, reason: dByKeyNoPath.reason, error: dByKeyNoPath.error } };
await typeInto('input[type="search"], input', '');
await evaluate(`(() => { const b = document.getElementById('__bl_lab11'); if (b) b.remove(); return 'cleaned'; })()`);

ws.close();
await fetch(`${HTTP}/json/close/${target.id}`).catch(() => {});
mkdirSync(join(LAB_DIR, 'results'), { recursive: true });
const scrub = (s) => s.replaceAll(LAB_DIR.replaceAll('\\', '/'), '<lab-dir>').replaceAll(LAB_DIR, '<lab-dir>');
writeFileSync(join(LAB_DIR, 'results', 'lab11-ref-target-ha.json'), scrub(JSON.stringify(out, null, 2)) + '\n');
console.log(JSON.stringify(out, null, 1));
