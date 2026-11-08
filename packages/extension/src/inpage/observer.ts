/**
 * The page observer: a persistent, coalescing MutationObserver that runs in
 * the page's MAIN world (spec v4 §5.1–§5.3). The host installs it once per
 * tab with `Runtime.addBinding` + `Page.addScriptToEvaluateOnNewDocument`
 * (`runImmediately: true`), so Chrome re-runs it in every new document and
 * in every same-process frame before page scripts. It pushes one summary
 * per flush through the binding and keeps a bounded ring of summaries so an
 * action window (mark → changes) can be read back exactly.
 *
 * Lab findings this source honours (`packages/plan/lab/2026-11-06-live-page-model/`):
 *   - flushes are scheduled with `setTimeout`, never `requestAnimationFrame`
 *     (rAF never fires in a hidden tab);
 *   - the instance is versioned: an older instance is torn down and replaced,
 *     an equal or newer one is left alone — never "if present, return";
 *   - one observer per root (an observer on `document` alone misses shadow
 *     roots), with `Element.prototype.attachShadow` patched to catch every
 *     root created later, open or closed.
 *
 * Verbatim sibling: `packages/server/src/cdp/inpage/observer.ts` (the server
 * publishes standalone and cannot import this package). Everything below this
 * header must stay byte-identical — `cdp/drift.test.ts` enforces it and
 * `cdp/builders-parity.test.ts` checks the built output.
 */

/** Bump whenever the in-page protocol (global shape, messages, methods) changes. */
export const OBSERVER_VERSION = 2;

/** Name of the `Runtime.addBinding` function the observer pushes messages through. */
export const OBSERVER_BINDING = '__blPageObserverPush';

/** Well-known global that holds the installed observer instance. */
export const OBSERVER_GLOBAL = '__blPageObserver';

const DEFAULT_DESCRIPTOR_CAP = 20;
const MAX_DESCRIPTOR_CAP = 100;
const DEFAULT_RING_SIZE = 64;
const MAX_RING_SIZE = 1024;

export interface ObserverInstallOpts {
  /** Binding name to push through; defaults to `OBSERVER_BINDING`. */
  binding?: string;
  /** Instance version; defaults to `OBSERVER_VERSION`. */
  version?: number;
  /** Max target descriptors per summary (default 20, clamped to 1..100). */
  descriptor_cap?: number;
  /** Summaries kept for mark/changes read-back (default 64, clamped to 1..1024). */
  ring_size?: number;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/**
 * Build the observer install source. Valid both as a
 * `Page.addScriptToEvaluateOnNewDocument` source and as a one-off
 * `Runtime.evaluate` expression, which evaluates to
 * `{ ok: true, installed, version, doc_id, coverage }`.
 *
 * The instance also owns element identity (spec v4 §5.6): `refFor(el)` issues
 * `e<N>` (monotonic per document instance, from `e1`) the first time an
 * element is seen and reuses it while the node lives; `resolveRef(ref)`
 * returns the element while it is connected, else `null`. Refs are only valid
 * for the `doc_id` that issued them. Neither method throws. `nextSnapshotId()`
 * issues `<doc_id>:s<N>` (N monotonic per document instance, from 1) for each
 * `snapshot` result and returns `null` once the instance is torn down; the
 * `doc_id` prefix lets a stale id from another document be rejected.
 * `recordSnapshot(id, record)` keeps the last 4 snapshot records per document
 * instance (oldest evicted first) for `snapshot({ since })`; `getSnapshot(id)`
 * returns the record or `null` when unknown or evicted. The record is opaque
 * here. Both are inert after teardown, which clears the store.
 */
export function buildObserverInstallJs(opts: ObserverInstallOpts = {}): string {
  const optsJson = JSON.stringify({
    key: OBSERVER_GLOBAL,
    binding:
      typeof opts.binding === 'string' && opts.binding.length > 0 ? opts.binding : OBSERVER_BINDING,
    version: clampInt(opts.version, OBSERVER_VERSION, 0, Number.MAX_SAFE_INTEGER),
    cap: clampInt(opts.descriptor_cap, DEFAULT_DESCRIPTOR_CAP, 1, MAX_DESCRIPTOR_CAP),
    ringSize: clampInt(opts.ring_size, DEFAULT_RING_SIZE, 1, MAX_RING_SIZE),
  });
  return `
(() => {
  const opts = ${optsJson};
  const existing = window[opts.key];
  if (existing && typeof existing.version === 'number' && existing.version >= opts.version) {
    return { ok: true, installed: false, version: existing.version, doc_id: existing.doc_id, coverage: existing.coverage };
  }
  if (existing && typeof existing.teardown === 'function') {
    try { existing.teardown(); } catch (e) {}
  }
  let isFrame = true;
  try { isFrame = window !== window.top; } catch (e) {}
  const zeroKinds = () => ({ childList: 0, attributes: 0, characterData: 0 });
  const g = {
    version: opts.version,
    doc_id: Math.random().toString(36).slice(2, 10) + Date.now().toString(36),
    seq: 0,
    ring: [],
    pending: new Map(),
    pendingRecords: 0,
    pendingKinds: zeroKinds(),
    pendingRoots: { document: false, shadow: false },
    t0: 0,
    timer: null,
    rescan: null,
    roots: 0,
    coverage: 'full',
    baselines: new Map(),
    dead: false,
  };
  const observers = [];
  const observed = new WeakSet();
  let refs = new WeakMap();
  const refNodes = new Map();
  let refSeq = 0;
  let snapshotSeq = 0;
  // Last SNAPSHOT_KEEP snapshot records (opaque to the observer; the snapshot
  // builder owns their shape), keyed by snapshot_id in insertion order.
  const SNAPSHOT_KEEP = 4;
  const snapshots = new Map();
  // WeakRef keeps the registry from pinning removed nodes; the fallback only
  // matters on engines without it (Chrome has it since 84).
  const holdWeakly =
    typeof WeakRef === 'function' ? (el) => new WeakRef(el) : (el) => ({ deref: () => el });
  const round = (n) => Math.round(n * 10) / 10;

  function push(message) {
    const fn = window[opts.binding];
    if (typeof fn !== 'function') return;
    try { fn(JSON.stringify(message)); } catch (e) {}
  }

  function fold(records, kind) {
    for (const rec of records) {
      if (g.pendingRecords === 0) g.t0 = performance.now();
      g.pendingRecords++;
      g.pendingKinds[rec.type]++;
      g.pendingRoots[kind] = true;
      const target = rec.type === 'characterData' ? rec.target.parentNode : rec.target;
      if (!target) continue;
      g.pending.set(target, (g.pending.get(target) || 0) + 1);
    }
  }

  function drain() {
    for (const o of observers) {
      const recs = o.mo.takeRecords();
      if (recs.length) fold(recs, o.kind);
    }
  }

  function segment(el) {
    const tag = el.localName || String(el.nodeName).toLowerCase();
    return el.id ? tag + '#' + el.id : tag;
  }

  function pathOf(node) {
    const parts = [];
    let n = node;
    let segments = 0;
    while (n && segments < 6) {
      if (n.nodeType === 1) {
        if (n === document.documentElement) break;
        parts.unshift(segment(n));
        segments++;
        n = n.parentNode;
      } else if (n.nodeType === 11 && n.host) {
        parts.unshift('#shadow');
        n = n.host;
      } else {
        break;
      }
    }
    return parts.join('>');
  }

  function describe(node) {
    if (node.nodeType === 11) {
      return { tag: '#shadow-root', path: node.host ? pathOf(node.host) + '>#shadow' : '#shadow' };
    }
    if (node.nodeType === 9) return { tag: '#document', path: '#document' };
    const d = { tag: node.localName || String(node.nodeName).toLowerCase() };
    if (typeof node.id === 'string' && node.id) d.id = node.id;
    const role = typeof node.getAttribute === 'function' ? node.getAttribute('role') : null;
    if (role) d.role = role;
    d.path = pathOf(node);
    return d;
  }

  function flush() {
    if (g.timer !== null) {
      clearTimeout(g.timer);
      g.timer = null;
    }
    drain();
    if (g.pendingRecords === 0) return null;
    const entries = Array.from(g.pending.entries()).sort((a, b) => b[1] - a[1]);
    const top = entries.slice(0, opts.cap);
    const summary = {
      type: 'summary',
      doc_id: g.doc_id,
      seq: ++g.seq,
      t0: round(g.t0),
      t1: round(performance.now()),
      records: g.pendingRecords,
      targets: entries.length,
      kinds: g.pendingKinds,
      roots: { document: g.pendingRoots.document, shadow: g.pendingRoots.shadow, frame: isFrame },
      descriptors: top.map((e) => describe(e[0])),
      overflow: entries.length - top.length,
    };
    g.ring.push({ summary: summary, counts: top.map((e) => e[1]) });
    while (g.ring.length > opts.ringSize) g.ring.shift();
    g.pending = new Map();
    g.pendingRecords = 0;
    g.pendingKinds = zeroKinds();
    g.pendingRoots = { document: false, shadow: false };
    push(summary);
    return summary;
  }

  function onTimer() {
    g.timer = null;
    try { flush(); } catch (e) {}
  }

  function onRecords(kind) {
    return (records) => {
      if (g.dead) return;
      try {
        fold(records, kind);
        if (g.pendingRecords > 0 && g.timer === null) g.timer = setTimeout(onTimer, 16);
      } catch (e) {}
    };
  }

  function observe(root, kind) {
    if (!root || observed.has(root)) return;
    observed.add(root);
    try {
      const mo = new MutationObserver(onRecords(kind));
      mo.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
      observers.push({ mo: mo, kind: kind });
      g.roots++;
    } catch (e) {}
  }

  function walk(root) {
    let all;
    try { all = root.querySelectorAll('*'); } catch (e) { return; }
    for (const el of all) {
      const sr = el.shadowRoot;
      if (sr) {
        observe(sr, 'shadow');
        walk(sr);
      }
    }
  }

  observe(document, 'document');
  walk(document);

  const proto = Element.prototype;
  const originalAttach = proto.attachShadow;
  let patchedAttach = null;
  if (typeof originalAttach === 'function') {
    try {
      const candidate = function attachShadow() {
        const root = originalAttach.apply(this, arguments);
        if (!g.dead) {
          try { observe(root, 'shadow'); } catch (e) {}
        }
        return root;
      };
      proto.attachShadow = candidate;
      if (proto.attachShadow !== candidate) throw new Error('attachShadow not patchable');
      patchedAttach = candidate;
    } catch (e) {
      g.coverage = 'partial';
      g.rescan = setInterval(() => {
        try { walk(document); } catch (err) {}
      }, 2000);
    }
  }

  function onNav() {
    if (g.dead) return;
    push({ type: 'nav', doc_id: g.doc_id, url: location.href });
  }
  const hist = window.history;
  const historyPatches = [];
  for (const name of ['pushState', 'replaceState']) {
    const original = hist[name];
    if (typeof original !== 'function') continue;
    const hadOwn = Object.prototype.hasOwnProperty.call(hist, name);
    const wrapped = function () {
      const result = original.apply(this, arguments);
      try { onNav(); } catch (e) {}
      return result;
    };
    try {
      hist[name] = wrapped;
      historyPatches.push({ name: name, original: original, wrapped: wrapped, hadOwn: hadOwn });
    } catch (e) {}
  }
  window.addEventListener('popstate', onNav);
  window.addEventListener('hashchange', onNav);

  g.flush = flush;

  g.refFor = function (el) {
    try {
      if (g.dead || !el || el.nodeType !== 1) return null;
      let ref = refs.get(el);
      if (!ref) {
        ref = 'e' + ++refSeq;
        refs.set(el, ref);
      }
      // Same node, same ref: re-register one pruned while it was detached.
      if (!refNodes.has(ref)) refNodes.set(ref, holdWeakly(el));
      return ref;
    } catch (e) {
      return null;
    }
  };

  g.resolveRef = function (ref) {
    try {
      if (typeof ref !== 'string') return null;
      const held = refNodes.get(ref);
      if (!held) return null;
      const el = held.deref();
      if (el && el.isConnected) return el;
      refNodes.delete(ref);
      return null;
    } catch (e) {
      return null;
    }
  };

  g.nextSnapshotId = function () {
    if (g.dead) return null;
    return g.doc_id + ':s' + ++snapshotSeq;
  };
  g.recordSnapshot = function (id, record) {
    if (g.dead || typeof id !== 'string') return;
    snapshots.delete(id);
    snapshots.set(id, record);
    while (snapshots.size > SNAPSHOT_KEEP) snapshots.delete(snapshots.keys().next().value);
  };

  g.getSnapshot = function (id) {
    if (g.dead || typeof id !== 'string') return null;
    const record = snapshots.get(id);
    return record === undefined ? null : record;
  };

  g.mark = function () {
    flush();
    const mark = g.seq;
    g.baselines.delete(mark);
    g.baselines.set(mark, { url: location.href, active: document.activeElement });
    while (g.baselines.size > 16) g.baselines.delete(g.baselines.keys().next().value);
    return { ok: true, doc_id: g.doc_id, mark: mark, url: location.href, has_focus_baseline: true };
  };

  g.changes = function (mark, docId) {
    if (docId && docId !== g.doc_id) return { ok: false, reason: 'doc-changed' };
    const base = g.baselines.get(mark);
    if (!base) return { ok: false, reason: 'doc-changed' };
    flush();
    const items = g.ring.filter((it) => it.summary.seq > mark);
    const kinds = zeroKinds();
    const roots = { document: false, shadow: false, frame: isFrame };
    const merged = new Map();
    let records = 0;
    let targets = 0;
    let overflow = 0;
    for (const it of items) {
      const s = it.summary;
      records += s.records;
      targets += s.targets;
      overflow += s.overflow;
      kinds.childList += s.kinds.childList;
      kinds.attributes += s.kinds.attributes;
      kinds.characterData += s.kinds.characterData;
      roots.document = roots.document || s.roots.document;
      roots.shadow = roots.shadow || s.roots.shadow;
      s.descriptors.forEach((d, i) => {
        const key = d.tag + '\\u0000' + (d.id || '') + '\\u0000' + d.path;
        const m = merged.get(key);
        if (m) m.n += it.counts[i];
        else merged.set(key, { d: d, n: it.counts[i] });
      });
    }
    const sorted = Array.from(merged.values()).sort((a, b) => b.n - a.n);
    const descriptors = sorted.slice(0, opts.cap).map((m) => m.d);
    overflow += sorted.length - descriptors.length;
    const out = {
      ok: true,
      doc_id: g.doc_id,
      since: mark,
      records: records,
      targets: targets,
      kinds: kinds,
      roots: roots,
      descriptors: descriptors,
      overflow: overflow,
    };
    if (g.seq > mark && (items.length === 0 || items[0].summary.seq !== mark + 1)) out.truncated = true;
    if (location.href !== base.url) out.url_changed = location.href;
    if (document.activeElement !== base.active) out.focus_moved = true;
    return out;
  };

  g.teardown = function () {
    if (g.dead) return;
    g.dead = true;
    if (g.timer !== null) clearTimeout(g.timer);
    if (g.rescan !== null) clearInterval(g.rescan);
    for (const o of observers) {
      try { o.mo.disconnect(); } catch (e) {}
    }
    observers.length = 0;
    if (patchedAttach && proto.attachShadow === patchedAttach) {
      try { proto.attachShadow = originalAttach; } catch (e) {}
    }
    for (const p of historyPatches) {
      if (hist[p.name] !== p.wrapped) continue;
      try {
        if (p.hadOwn) hist[p.name] = p.original;
        else delete hist[p.name];
      } catch (e) {}
    }
    window.removeEventListener('popstate', onNav);
    window.removeEventListener('hashchange', onNav);
    g.baselines.clear();
    refs = new WeakMap();
    refNodes.clear();
    snapshotSeq = 0;
    snapshots.clear();
    if (window[opts.key] === g) {
      try { delete window[opts.key]; } catch (e) {}
    }
  };

  Object.defineProperty(window, opts.key, { value: g, configurable: true, writable: true, enumerable: false });
  push({ type: 'doc_start', doc_id: g.doc_id, url: location.href, version: g.version, coverage: g.coverage });
  return { ok: true, installed: true, version: g.version, doc_id: g.doc_id, coverage: g.coverage };
})()`;
}

const UNAVAILABLE = "{ ok: false, reason: 'observer-unavailable' }";

function callInstance(call: string): string {
  return `
(() => {
  const g = window[${JSON.stringify(OBSERVER_GLOBAL)}];
  if (!g || g.dead || typeof g.doc_id !== 'string') return ${UNAVAILABLE};
  try {
    return ${call};
  } catch (e) {
    return ${UNAVAILABLE};
  }
})()`;
}

/**
 * Build the action-mark expression. Forces a flush (including records still
 * queued in the observers) so the mark is exact, then baselines URL and focus.
 * Evaluates to `{ ok: true, doc_id, mark, url, has_focus_baseline: true }` or
 * `{ ok: false, reason: 'observer-unavailable' }`.
 */
export function buildObserverMarkJs(): string {
  return callInstance('g.mark()');
}

/**
 * Build the "changes since mark" expression. Forces a flush, then aggregates
 * the ring summaries with `seq > mark`. `docId`, when given, must match the
 * current document. Evaluates to the aggregated changes (see
 * `SettleChanges` in `@browser-link/shared`) plus `ok`, `doc_id`, `since`,
 * and `url_changed` / `focus_moved` only when they differ from the mark's
 * baseline; or `{ ok: false, reason: 'observer-unavailable' | 'doc-changed' }`.
 */
export function buildObserverChangesJs(mark: number, docId?: string): string {
  const markJson = JSON.stringify(clampInt(mark, 0, 0, Number.MAX_SAFE_INTEGER));
  const docJson = typeof docId === 'string' && docId.length > 0 ? jsStringLiteral(docId) : 'null';
  return callInstance(`g.changes(${markJson}, ${docJson})`);
}

/**
 * A string literal safe to embed in JS source. `JSON.stringify` alone leaves
 * U+2028 / U+2029 (line terminators in older JS grammars) and `<` (which can
 * close a surrounding `<script>`) unescaped; this escapes them as `\uXXXX`,
 * which parses back to the same string.
 */
function jsStringLiteral(value: string): string {
  // The two separators are written as char codes so this source file never
  // carries them raw; the replacement is the six-character escape sequence.
  const lineSeparator = String.fromCharCode(0x2028);
  const paragraphSeparator = String.fromCharCode(0x2029);
  return JSON.stringify(value)
    .split(lineSeparator)
    .join('\\u2028')
    .split(paragraphSeparator)
    .join('\\u2029')
    .replace(/</g, '\\u003c');
}

/**
 * Build the ref-resolve expression, for tests and debugging. Evaluates to
 * `{ ok: true, found: true, tag }` when `ref` names an element of the current
 * document that is still connected, `{ ok: true, found: false }` when it is
 * unknown or stale, or `{ ok: false, reason: 'observer-unavailable' }`.
 */
export function buildObserverRefResolveJs(ref: string): string {
  const refJson = jsStringLiteral(typeof ref === 'string' ? ref : '');
  return callInstance(
    `((el) => el ? { ok: true, found: true, tag: el.localName || String(el.nodeName).toLowerCase() } : { ok: true, found: false })(g.resolveRef(${refJson}))`,
  );
}

/**
 * Build the teardown expression: disconnects every observer, restores the
 * `attachShadow` and `history` patches when they are still the observer's,
 * and removes the global. Idempotent; evaluates to `{ ok: true, removed }`.
 */
export function buildObserverTeardownJs(): string {
  return `
(() => {
  const key = ${JSON.stringify(OBSERVER_GLOBAL)};
  const g = window[key];
  if (!g) return { ok: true, removed: false };
  if (typeof g.teardown === 'function') {
    try { g.teardown(); } catch (e) {}
  }
  if (window[key] === g) {
    try { delete window[key]; } catch (e) {}
  }
  return { ok: true, removed: true };
})()`;
}
