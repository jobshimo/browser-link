// Lab 5: run the agent in an ISOLATED world (Page.addScriptToEvaluateOnNewDocument
// worldName + Runtime.addBinding executionContextName). What is lost vs main
// world? Expected: shared DOM so observers work and open roots are reachable
// via el.shadowRoot, but the attachShadow patch cannot see page calls, so
// roots created later (and closed roots) are missed unless rescanned.
// Also measures agent self-cost under the storm, in both worlds.
// usage: node lab5-isolated-world.mjs <storm webSocketDebuggerUrl>
const [, , wsUrl] = process.argv;
const ws = new WebSocket(wsUrl);
await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
let id = 0; const pending = new Map(); const handlers = [];
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data.toString()); if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); return; } for (const h of handlers) h(m.method, m.params); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const AGENT = (tag) => `
(() => {
  const blm = (globalThis.__blm_${tag} = { roots: 0, closedRoots: 0, patched: false, records: 0, flushes: 0, selfMs: 0, pending: new Map() });
  const opts = { subtree: true, childList: true, attributes: true, characterData: true };
  const onRecords = (recs) => {
    const t0 = performance.now();
    blm.records += recs.length;
    for (const r of recs) { const t = r.type === 'characterData' ? r.target.parentNode : r.target; if (!t) continue; let e = blm.pending.get(t); if (!e) { e = { c: 0 }; blm.pending.set(t, e); } e.c++; }
    if (!blm.scheduled) { blm.scheduled = true; setTimeout(flush, 16); }
    blm.selfMs += performance.now() - t0;
  };
  function flush() { const t0 = performance.now(); blm.scheduled = false; blm.flushes++; const s = { world: '${tag}', targets: blm.pending.size }; blm.pending.clear(); if (typeof globalThis.__push_${tag} === 'function') globalThis.__push_${tag}(JSON.stringify(s)); blm.selfMs += performance.now() - t0; }
  const observe = (root, closed) => { new MutationObserver(onRecords).observe(root, opts); blm.roots++; if (closed) blm.closedRoots++; };
  observe(document, false);
  try { const orig = Element.prototype.attachShadow; Element.prototype.attachShadow = function (init) { const root = orig.call(this, init); observe(root, init && init.mode === 'closed'); return root; }; blm.patched = true; } catch (_) {}
  const walk = (root) => { for (const el of root.querySelectorAll('*')) if (el.shadowRoot) { observe(el.shadowRoot, false); walk(el.shadowRoot); } };
  walk(document);
})()`;

await send('Page.enable'); await send('Runtime.enable'); await send('Page.bringToFront');
const wire = { main: 0, iso: 0 };
handlers.push((m, p) => { if (m === 'Runtime.bindingCalled') { if (p.name === '__push_main') wire.main++; if (p.name === '__push_iso') wire.iso++; } });

await send('Runtime.addBinding', { name: '__push_main' });
await send('Runtime.addBinding', { name: '__push_iso', executionContextName: 'bl-iso' });
const sMain = await send('Page.addScriptToEvaluateOnNewDocument', { source: AGENT('main') });
const sIso = await send('Page.addScriptToEvaluateOnNewDocument', { source: AGENT('iso'), worldName: 'bl-iso' });

// Find the isolated world's execution context id after reload.
let isoCtx = null;
handlers.push((m, p) => { if (m === 'Runtime.executionContextCreated' && p.context.name === 'bl-iso') isoCtx = p.context.id; });
const loaded = new Promise((res) => handlers.push((m) => m === 'Page.loadEventFired' && res()));
await send('Page.reload');
await Promise.race([loaded, sleep(10000)]);
await sleep(5000);

const read = async (tag, contextId) => {
  const r = await send('Runtime.evaluate', { expression: `globalThis.__blm_${tag} ? JSON.stringify({roots: __blm_${tag}.roots, closedRoots: __blm_${tag}.closedRoots, patched: __blm_${tag}.patched, records: __blm_${tag}.records, flushes: __blm_${tag}.flushes, selfMs: Math.round(__blm_${tag}.selfMs)}) : null`, returnByValue: true, ...(contextId ? { contextId } : {}) });
  return r.result.value ? JSON.parse(r.result.value) : null;
};
const main = await read('main');
const iso = await read('iso', isoCtx);
// Can the isolated world see the page's prototype patch? (should be false)
const isoSeesPatch = isoCtx ? (await send('Runtime.evaluate', { expression: `Element.prototype.attachShadow.toString().includes('observe')`, returnByValue: true, contextId: isoCtx })).result.value : null;
// A closed root created by page code now: who sees it?
await send('Runtime.evaluate', { expression: `(() => { const h = document.createElement('div'); h.id = 'lab5-closed'; document.body.appendChild(h); const r = h.attachShadow({ mode: 'closed' }); const b = document.createElement('b'); b.textContent = 'x'; r.appendChild(b); b.setAttribute('data-lab', '1'); return 'ok'; })()`, returnByValue: true });
await sleep(500);
const main2 = await read('main');
const iso2 = await read('iso', isoCtx);
await send('Runtime.evaluate', { expression: `document.getElementById('lab5-closed')?.remove(); 'ok'`, returnByValue: true });
await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: sMain.identifier });
await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: sIso.identifier });

console.log(JSON.stringify({
  window_s: 5,
  main_world: { ...main, pushes_received: wire.main, self_ms_per_s: main ? Math.round(main.selfMs / 5) : null },
  isolated_world: { ctx: isoCtx, ...iso, pushes_received: wire.iso, sees_main_patch: isoSeesPatch, self_ms_per_s: iso ? Math.round(iso.selfMs / 5) : null },
  after_closed_root_created_by_page: { main_closedRoots: main2?.closedRoots, main_roots: main2?.roots, iso_closedRoots: iso2?.closedRoots, iso_roots: iso2?.roots },
}, null, 2));
ws.close();
