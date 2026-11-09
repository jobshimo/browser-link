// Lab 3: a page-side observer that (a) is re-injected automatically on every
// new document via Page.addScriptToEvaluateOnNewDocument, (b) catches every
// shadow root — open AND closed — by patching Element.prototype.attachShadow
// before page scripts run, and (c) pushes COALESCED per-frame summaries to the
// client through Runtime.addBinding instead of one message per mutation.
//
// Measures: bytes/s over the wire vs raw CDP DOM events (lab 1), survival of a
// hard reload, and closed-root coverage.
//
// usage: node lab3-persistent-observer.mjs <webSocketDebuggerUrl> [windowMs]

const [, , wsUrl, winArg] = process.argv;
if (!wsUrl) { console.error('missing webSocketDebuggerUrl'); process.exit(2); }
const WINDOW_MS = Number(winArg) || 10_000;

const ws = new WebSocket(wsUrl);
let nextId = 1;
const pending = new Map();
const handlers = [];
function send(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, method });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
ws.addEventListener('message', (ev) => {
  const raw = typeof ev.data === 'string' ? ev.data : ev.data.toString();
  const msg = JSON.parse(raw);
  if (msg.id !== undefined) {
    const p = pending.get(msg.id); pending.delete(msg.id);
    if (!p) return;
    msg.error ? p.reject(new Error(`${p.method}: ${msg.error.message}`)) : p.resolve(msg.result);
    return;
  }
  for (const h of handlers) h(msg.method, msg.params, raw.length);
});
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The page-side agent. Runs before any page script on every new document.
const AGENT = `
(() => {
  if (window.__blm) return;
  const blm = (window.__blm = { roots: 0, closedRoots: 0, pending: new Map(), flushes: 0, records: 0, installedAt: performance.now(), doc: location.href });
  const opts = { subtree: true, childList: true, attributes: true, characterData: true };
  // Coalesce: one entry per target element per flush, counting kinds.
  const onRecords = (recs) => {
    blm.records += recs.length;
    for (const r of recs) {
      const t = r.type === 'characterData' ? r.target.parentNode : r.target;
      if (!t) continue;
      let e = blm.pending.get(t);
      if (!e) { e = { childList: 0, attributes: 0, characterData: 0 }; blm.pending.set(t, e); }
      e[r.type]++;
    }
    if (!blm.scheduled) { blm.scheduled = true; setTimeout(flush, 16); }
  };
  function flush() {
    blm.scheduled = false;
    blm.flushes++;
    const summary = { doc: blm.doc, targets: blm.pending.size, records: 0, kinds: { childList: 0, attributes: 0, characterData: 0 } };
    for (const e of blm.pending.values()) for (const k in e) { summary.kinds[k] += e[k]; summary.records += e[k]; }
    blm.pending.clear();
    if (typeof window.__blmPush === 'function') window.__blmPush(JSON.stringify(summary));
  }
  const observe = (root, closed) => {
    new MutationObserver(onRecords).observe(root, opts);
    blm.roots++;
    if (closed) blm.closedRoots++;
  };
  observe(document, false);
  // Catch every shadow root created from now on, open or closed.
  const orig = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init) {
    const root = orig.call(this, init);
    observe(root, init && init.mode === 'closed');
    return root;
  };
  // Roots that already exist (only possible when injected into a live page).
  const walk = (root) => { for (const el of root.querySelectorAll('*')) if (el.shadowRoot) { observe(el.shadowRoot, false); walk(el.shadowRoot); } };
  walk(document);
})()`;

await send('Page.enable');
await send('Runtime.enable');
await send('Runtime.addBinding', { name: '__blmPush' });
const added = await send('Page.addScriptToEvaluateOnNewDocument', { source: AGENT, runImmediately: true });

// Collect pushed summaries.
const wire = { messages: 0, bytes: 0, records: 0, targets: 0, byDoc: {}, perSecond: [] };
handlers.push((method, params, len) => {
  if (method !== 'Runtime.bindingCalled' || params.name !== '__blmPush') return;
  const s = JSON.parse(params.payload);
  wire.messages++;
  wire.bytes += len;
  wire.records += s.records;
  wire.targets += s.targets;
  wire.byDoc[s.doc] = (wire.byDoc[s.doc] || 0) + 1;
  const sec = Math.floor(performance.now() / 1000);
  wire.perSecond[sec] = (wire.perSecond[sec] || 0) + 1;
});

const state = async () => {
  const r = await send('Runtime.evaluate', { expression: 'window.__blm ? JSON.stringify({roots: __blm.roots, closedRoots: __blm.closedRoots, flushes: __blm.flushes, records: __blm.records, doc: __blm.doc}) : null', returnByValue: true });
  return r.result.value ? JSON.parse(r.result.value) : null;
};

const report = { target: null, script_id: added.identifier, window_ms: WINDOW_MS };
report.target = (await send('Runtime.evaluate', { expression: 'location.href', returnByValue: true })).result.value;

// Phase A: live-injected into the current document (runImmediately).
report.phase_a_live_inject = { agent: await state() };
await sleep(WINDOW_MS);
report.phase_a_live_inject.wire = { messages: wire.messages, bytes: wire.bytes, records: wire.records, bytes_per_s: Math.round(wire.bytes / (WINDOW_MS / 1000)), msgs_per_s: Math.round(wire.messages / (WINDOW_MS / 1000)) };
report.phase_a_live_inject.agent_after = await state();

// Phase B: hard reload — the script must come back by itself and see the
// page's own shadow roots from their creation (attachShadow patch).
const w0 = { messages: wire.messages, bytes: wire.bytes, records: wire.records };
const loaded = new Promise((res) => handlers.push((m) => m === 'Page.loadEventFired' && res()));
await send('Page.reload');
await Promise.race([loaded, sleep(15000)]);
await sleep(WINDOW_MS);
report.phase_b_after_reload = {
  agent: await state(),
  wire: { messages: wire.messages - w0.messages, bytes: wire.bytes - w0.bytes, records: wire.records - w0.records, bytes_per_s: Math.round((wire.bytes - w0.bytes) / (WINDOW_MS / 1000)) },
};

// Phase C: closed shadow root created by "page code" after load — is it observed?
const w1 = { records: wire.records, messages: wire.messages };
const r = await send('Runtime.evaluate', { expression: `(() => {
  const h = document.createElement('div'); h.id = 'lab3-closed'; document.body.appendChild(h);
  const root = h.attachShadow({ mode: 'closed' });
  const b = document.createElement('b'); b.textContent = 'x'; root.appendChild(b);
  b.setAttribute('data-lab', '1'); b.textContent = 'y';
  return window.__blm.closedRoots;
})()`, returnByValue: true, awaitPromise: true });
await sleep(1000);
report.docs_seen = wire.byDoc;
report.phase_c_closed_root = { closed_roots_seen_by_agent: r.result.value, records_pushed: wire.records - w1.records, messages: wire.messages - w1.messages };
await send('Runtime.evaluate', { expression: `document.getElementById('lab3-closed')?.remove(); 'ok'`, returnByValue: true });

await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: added.identifier });
console.log(JSON.stringify(report, null, 2));
ws.close();
