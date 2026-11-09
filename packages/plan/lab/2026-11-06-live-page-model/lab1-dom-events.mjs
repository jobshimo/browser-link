// Lab 1: can Chrome's own CDP DOM events feed a live page model, and how do
// they compare with an injected MutationObserver on a shadow-DOM-heavy SPA?
//
// usage: node lab1-dom-events.mjs <webSocketDebuggerUrl> [idleMs] [--nav]
//
// Phases:
//   1. DOM.getDocument({depth:-1, pierce:true}) — size, time, shadow roots, frames.
//   2. Inject MutationObserver(s): one on document, one per open shadow root
//      and same-origin iframe document (counters kept in window.__lab).
//   3. Listen to DOM.* events for idleMs; classify each by whether its node is
//      inside a shadow tree (using the tree from phase 1, updated on inserts).
//   4. Read the injected counters and print a comparison report.
//   5. (--nav) SPA navigation via in-page click, then hard reload: does
//      documentUpdated fire, do events keep flowing without a new getDocument?

const [, , wsUrl, idleArg, ...flags] = process.argv;
if (!wsUrl) {
  console.error('missing webSocketDebuggerUrl');
  process.exit(2);
}
const IDLE_MS = Number(idleArg) || 30_000;
const PROBE_NAV = flags.includes('--nav');

const ws = new WebSocket(wsUrl);
let nextId = 1;
const pending = new Map();
const eventHandlers = [];

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
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (!p) return;
    if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
    else p.resolve(msg.result);
    return;
  }
  for (const h of eventHandlers) h(msg.method, msg.params, raw.length);
});
await new Promise((res, rej) => {
  ws.addEventListener('open', res);
  ws.addEventListener('error', (e) => rej(new Error('ws error ' + (e.message ?? ''))));
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- node map (nodeId -> {parent, inShadow, inFrame}) ----------
const nodes = new Map();
let shadowRootCount = 0;
let frameDocCount = 0;
let nodeCount = 0;
function indexNode(n, parentId, inShadow, inFrame) {
  nodeCount++;
  nodes.set(n.nodeId, { parent: parentId, inShadow, inFrame, backend: n.backendNodeId, name: n.nodeName });
  for (const c of n.children ?? []) indexNode(c, n.nodeId, inShadow, inFrame);
  for (const sr of n.shadowRoots ?? []) {
    shadowRootCount++;
    indexNode(sr, n.nodeId, true, inFrame);
  }
  if (n.contentDocument) {
    frameDocCount++;
    indexNode(n.contentDocument, n.nodeId, inShadow, true);
  }
  if (n.templateContent) indexNode(n.templateContent, n.nodeId, inShadow, inFrame);
  for (const pe of n.pseudoElements ?? []) indexNode(pe, n.nodeId, inShadow, inFrame);
}

await send('Page.enable');
await send('Runtime.enable');
await send('DOM.enable');

const { result: urlRes } = await send('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
console.error(`[lab] target: ${urlRes.value}`);

// ---------- phase 1: full tree ----------
const t0 = performance.now();
const doc = await send('DOM.getDocument', { depth: -1, pierce: true });
const t1 = performance.now();
const docBytes = JSON.stringify(doc).length;
indexNode(doc.root, null, false, false);
const phase1 = {
  getDocument_ms: Math.round(t1 - t0),
  getDocument_bytes: docBytes,
  nodes: nodeCount,
  shadow_roots: shadowRootCount,
  frame_documents: frameDocCount,
};

// ---------- phase 2: injected observers ----------
const INJECT = `
(() => {
  const lab = (window.__lab = { docOnly: 0, deep: 0, roots: 0, byType: {}, inShadow: 0, inFrame: 0, batches: 0, maxBatch: 0, firstAt: 0, lastAt: 0 });
  const opts = { subtree: true, childList: true, attributes: true, characterData: true };
  const mark = (recs, where) => {
    const now = performance.now();
    lab.batches++;
    if (recs.length > lab.maxBatch) lab.maxBatch = recs.length;
    if (!lab.firstAt) lab.firstAt = now;
    lab.lastAt = now;
    for (const r of recs) {
      lab.deep++;
      lab.byType[r.type] = (lab.byType[r.type] || 0) + 1;
      if (where === 'shadow') lab.inShadow++;
      if (where === 'frame') lab.inFrame++;
    }
  };
  new MutationObserver((recs) => { lab.docOnly += recs.length; mark(recs, 'doc'); }).observe(document, opts);
  lab.roots++;
  const walk = (root, where) => {
    const all = root.querySelectorAll('*');
    for (const el of all) {
      if (el.shadowRoot) {
        new MutationObserver((recs) => mark(recs, 'shadow')).observe(el.shadowRoot, opts);
        lab.roots++;
        walk(el.shadowRoot, 'shadow');
      }
      if (el.tagName === 'IFRAME') {
        try {
          const d = el.contentDocument;
          if (d) { new MutationObserver((recs) => mark(recs, 'frame')).observe(d, opts); lab.roots++; walk(d, 'frame'); }
        } catch (_) {}
      }
    }
  };
  walk(document, 'doc');
  return lab.roots;
})()`;
const injected = await send('Runtime.evaluate', { expression: INJECT, returnByValue: true });
const observerRoots = injected.result.value;

// ---------- phase 3: CDP events ----------
const cdp = {
  byMethod: {},
  bytes: 0,
  total: 0,
  inShadow: 0,
  inFrame: 0,
  unknownNode: 0,
  documentUpdated: 0,
  shadowRootPushed: 0,
  perSecond: [],
  maxBurst100ms: 0,
  firstAt: 0,
  lastAt: 0,
};
let burstWindowStart = 0;
let burstCount = 0;
let listening = true;
function classify(nodeId) {
  const n = nodes.get(nodeId);
  if (!n) {
    cdp.unknownNode++;
    return null;
  }
  if (n.inShadow) cdp.inShadow++;
  if (n.inFrame) cdp.inFrame++;
  return n;
}
eventHandlers.push((method, params, len) => {
  if (!listening || !method.startsWith('DOM.')) return;
  const now = performance.now();
  cdp.total++;
  cdp.bytes += len;
  cdp.byMethod[method] = (cdp.byMethod[method] || 0) + 1;
  if (!cdp.firstAt) cdp.firstAt = now;
  cdp.lastAt = now;
  if (now - burstWindowStart > 100) {
    burstWindowStart = now;
    burstCount = 0;
  }
  burstCount++;
  if (burstCount > cdp.maxBurst100ms) cdp.maxBurst100ms = burstCount;
  const sec = Math.floor(now / 1000);
  cdp.perSecond[sec] = (cdp.perSecond[sec] || 0) + 1;

  switch (method) {
    case 'DOM.childNodeInserted': {
      const parent = classify(params.parentNodeId);
      if (parent) indexNode(params.node, params.parentNodeId, parent.inShadow, parent.inFrame);
      break;
    }
    case 'DOM.childNodeRemoved':
      classify(params.parentNodeId);
      nodes.delete(params.nodeId);
      break;
    case 'DOM.attributeModified':
    case 'DOM.attributeRemoved':
    case 'DOM.characterDataModified':
    case 'DOM.childNodeCountUpdated':
    case 'DOM.inlineStyleInvalidated':
      if (params.nodeId !== undefined) classify(params.nodeId);
      for (const id of params.nodeIds ?? []) classify(id);
      break;
    case 'DOM.setChildNodes': {
      const parent = classify(params.parentId);
      for (const n of params.nodes ?? []) indexNode(n, params.parentId, parent?.inShadow ?? false, parent?.inFrame ?? false);
      break;
    }
    case 'DOM.shadowRootPushed': {
      cdp.shadowRootPushed++;
      const host = classify(params.hostId);
      indexNode(params.root, params.hostId, true, host?.inFrame ?? false);
      break;
    }
    case 'DOM.documentUpdated':
      cdp.documentUpdated++;
      break;
  }
});

console.error(`[lab] listening ${IDLE_MS} ms (leave the page alone)…`);
await sleep(IDLE_MS);
listening = false;

// ---------- phase 4: read injected counters ----------
const labRes = await send('Runtime.evaluate', { expression: 'JSON.stringify(window.__lab)', returnByValue: true });
const mo = JSON.parse(labRes.result.value);
const perSec = cdp.perSecond.filter((x) => x !== undefined);
const report = {
  target: urlRes.value,
  idle_ms: IDLE_MS,
  phase1_full_tree: phase1,
  cdp_events: {
    total: cdp.total,
    bytes: cdp.bytes,
    by_method: cdp.byMethod,
    in_shadow: cdp.inShadow,
    in_frame: cdp.inFrame,
    unknown_node_refs: cdp.unknownNode,
    shadow_root_pushed: cdp.shadowRootPushed,
    document_updated: cdp.documentUpdated,
    per_second: { min: Math.min(...perSec, 0), max: Math.max(...perSec, 0), avg: perSec.length ? Math.round(cdp.total / perSec.length) : 0 },
    max_burst_per_100ms: cdp.maxBurst100ms,
  },
  mutation_observer: {
    observer_roots: observerRoots,
    records_doc_only: mo.docOnly,
    records_all_roots: mo.deep,
    in_shadow: mo.inShadow,
    in_frame: mo.inFrame,
    by_type: mo.byType,
    microtask_batches: mo.batches,
    max_records_per_batch: mo.maxBatch,
  },
};

// ---------- phase 5: navigation probes ----------
if (PROBE_NAV) {
  const nav = {};
  // SPA navigation: click the first in-app link found through shadow roots.
  const CLICK_SPA = `
  (() => {
    const seen = new Set();
    const walk = (root) => {
      for (const el of root.querySelectorAll('a[href^="/"]')) {
        const href = el.getAttribute('href');
        if (href && href !== location.pathname && !seen.has(href) && el.getClientRects().length) { el.click(); return href; }
      }
      for (const el of root.querySelectorAll('*')) { if (el.shadowRoot) { const r = walk(el.shadowRoot); if (r) return r; } }
      return null;
    };
    return walk(document);
  })()`;
  listening = true;
  const before = { total: cdp.total, documentUpdated: cdp.documentUpdated };
  const clicked = await send('Runtime.evaluate', { expression: CLICK_SPA, returnByValue: true });
  await sleep(3000);
  const afterUrl = await send('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
  nav.spa = {
    clicked_href: clicked.result.value,
    url_after: afterUrl.result.value,
    events_during: cdp.total - before.total,
    document_updated_during: cdp.documentUpdated - before.documentUpdated,
  };

  // Hard reload: does documentUpdated fire, do events flow without a new getDocument?
  const before2 = { total: cdp.total, documentUpdated: cdp.documentUpdated };
  const loaded = new Promise((res) => eventHandlers.push((m) => m === 'Page.loadEventFired' && res()));
  await send('Page.reload');
  await Promise.race([loaded, sleep(15000)]);
  await sleep(3000);
  const afterReloadNoGet = cdp.total - before2.total;
  const docUpdatedOnReload = cdp.documentUpdated - before2.documentUpdated;
  // Now re-request the document and see whether events resume.
  const before3 = cdp.total;
  nodes.clear();
  nodeCount = 0; shadowRootCount = 0; frameDocCount = 0;
  const doc2 = await send('DOM.getDocument', { depth: -1, pierce: true });
  indexNode(doc2.root, null, false, false);
  await sleep(5000);
  nav.reload = {
    document_updated: docUpdatedOnReload,
    events_after_reload_before_getDocument: afterReloadNoGet,
    events_5s_after_new_getDocument: cdp.total - before3,
    nodes_after_reload: nodeCount,
  };
  listening = false;
  report.navigation = nav;
}

console.log(JSON.stringify(report, null, 2));
ws.close();
