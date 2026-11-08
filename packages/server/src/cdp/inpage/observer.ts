/**
 * Independent copy of `packages/extension/src/inpage/observer.ts` — see
 * `./deep-query.ts`'s header comment for why this is a verbatim duplicate
 * rather than a cross-package import.
 *
 * The page observer: a persistent, coalescing MutationObserver that runs in
 * the page's MAIN world (spec v4 §5.1–§5.3). cdp-direct installs it with the
 * same `Runtime.addBinding` + `Page.addScriptToEvaluateOnNewDocument` pair as
 * the extension. Everything below this header must stay byte-identical to the
 * extension original — `cdp/drift.test.ts` enforces it and
 * `cdp/builders-parity.test.ts` checks the built output.
 */

/** Bump whenever the in-page protocol (global shape, messages, methods) changes. */
export const OBSERVER_VERSION = 3;

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
 * `<doc_tag>:e<N>` (`doc_tag` = the first 6 characters of `doc_id`, N
 * monotonic per document instance, from 1) the first time an element is seen
 * and reuses it while the node lives; `resolveRef(ref)` returns the element
 * while it is connected, else `null`. Refs are only valid for the document
 * instance that issued them: a ref whose tag is not this instance's tag, or a
 * bare `e<N>` with no tag, is `null` everywhere (resolve, re-resolve, key)
 * without consulting the registries. Neither method throws.
 *
 * Secondary identity (spec v4 §5.6, decided by lab 10): `semanticKeyFor(el)`
 * returns `{ role, name, path }` — role from the `role` attribute or a small
 * implicit table, accessible-ish name (aria-label, aria-labelledby, associated
 * label, text ≤ 80 chars, placeholder, title, button-like input value) and up
 * to 8 `{ tag, index }` ancestor steps (1-based same-tag sibling index, a
 * shadow boundary as `{ tag: '#shadow', index: 0 }`). `refFor` stores the key
 * when it issues a ref. `resolveRefDetailed(ref)` returns `{ el, reresolved }`:
 * the live node with `reresolved: false`, else the element with the same role,
 * name and tag-only path when exactly one exists, rebinding the ref to it
 * (`reresolved: true`); zero or several candidates give `null` (sibling
 * indices are kept in the key as data but never pick among candidates). Candidates come from the document, every open shadow root reachable
 * from it, and every root the `attachShadow` patch observed (closed ones
 * included); closed roots attached before install are not reachable.
 * `resolveRef(ref)` is `resolveRefDetailed(ref)?.el ?? null`. `keyForRef(ref)`
 * returns a copy of the stored key or `null`. None of these throws.
 * `nextSnapshotId()`
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
  // Semantic key captured when each ref is issued; kept while the ref lives so
  // a replaced node can be found again (spec v4 §5.6 secondary identity).
  const refKeys = new Map();
  let refSeq = 0;
  // Every ref carries the issuing document's tag, so a ref from another
  // document instance (or a bare e<N>) never reaches the registries.
  const refPrefix = g.doc_id.slice(0, 6) + ':e';
  const ownsRef = (ref) => typeof ref === 'string' && ref.startsWith(refPrefix);
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
      observers.push({ mo: mo, kind: kind, root: root });
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

  const KEY_PATH_STEPS = 8;
  const KEY_TEXT_CAP = 80;
  // Elements an HTML <label> can be associated with.
  const LABELABLE = ['button', 'input', 'meter', 'output', 'progress', 'select', 'textarea'];
  const BUTTON_INPUT_TYPES = ['button', 'submit', 'reset'];

  function tagOf(el) {
    return el.localName || String(el.nodeName).toLowerCase();
  }

  function collapse(text) {
    return String(text || '').replace(/\\s+/g, ' ').trim();
  }

  function inputType(el) {
    return (el.getAttribute('type') || 'text').toLowerCase();
  }

  function roleOf(el) {
    const explicit = (el.getAttribute('role') || '').trim();
    if (explicit) return explicit;
    const tag = tagOf(el);
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'input') {
      const type = inputType(el);
      if (type === 'checkbox' || type === 'radio') return type;
      if (BUTTON_INPUT_TYPES.indexOf(type) >= 0) return 'button';
      return 'textbox';
    }
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (el.hasAttribute('contenteditable') && el.getAttribute('contenteditable') !== 'false') return 'textbox';
    return tag;
  }

  function labelTextOf(el, root) {
    if (LABELABLE.indexOf(tagOf(el)) < 0) return '';
    const id = el.getAttribute('id');
    if (id && root && typeof root.querySelectorAll === 'function') {
      for (const label of root.querySelectorAll('label')) {
        if (label.getAttribute('for') !== id) continue;
        const text = collapse(label.textContent);
        if (text) return text;
      }
    }
    const wrapping = typeof el.closest === 'function' ? el.closest('label') : null;
    return wrapping ? collapse(wrapping.textContent) : '';
  }

  function nameOf(el) {
    const ariaLabel = collapse(el.getAttribute('aria-label'));
    if (ariaLabel) return ariaLabel;
    const root = typeof el.getRootNode === 'function' ? el.getRootNode() : document;
    const labelledBy = collapse(el.getAttribute('aria-labelledby'));
    if (labelledBy && root && typeof root.getElementById === 'function') {
      const parts = [];
      for (const id of labelledBy.split(' ')) {
        const target = root.getElementById(id);
        const text = target ? collapse(target.textContent) : '';
        if (text) parts.push(text);
      }
      if (parts.length > 0) return parts.join(' ');
    }
    const label = labelTextOf(el, root);
    if (label) return label;
    const text = collapse(el.textContent).slice(0, KEY_TEXT_CAP);
    if (text) return text;
    const placeholder = collapse(el.getAttribute('placeholder'));
    if (placeholder) return placeholder;
    const title = collapse(el.getAttribute('title'));
    if (title) return title;
    if (tagOf(el) === 'input' && BUTTON_INPUT_TYPES.indexOf(inputType(el)) >= 0) return collapse(el.value);
    return '';
  }

  function sameTagIndex(el) {
    const tag = el.localName;
    let index = 1;
    for (let s = el.previousElementSibling; s; s = s.previousElementSibling) {
      if (s.localName === tag) index++;
    }
    return index;
  }

  // Unlike pathOf (descriptors, pinned settle output), this path carries the
  // same-tag sibling index: role + name alone collides (spec v4 §4.6).
  function keyPathOf(el) {
    const steps = [];
    let n = el;
    while (n && steps.length < KEY_PATH_STEPS) {
      if (n.nodeType === 1) {
        if (n === document.documentElement) break;
        steps.unshift({ tag: tagOf(n), index: sameTagIndex(n) });
        n = n.parentNode;
      } else if (n.nodeType === 11 && n.host) {
        steps.unshift({ tag: '#shadow', index: 0 });
        n = n.host;
      } else {
        break;
      }
    }
    return steps;
  }

  function semanticKeyFor(el) {
    try {
      if (!el || el.nodeType !== 1) return null;
      return { role: roleOf(el), name: nameOf(el), path: keyPathOf(el) };
    } catch (e) {
      return null;
    }
  }

  // The document, every open shadow root reachable from it, and every root the
  // attachShadow patch observed (closed ones included) whose host is connected.
  function searchRoots() {
    const roots = [document];
    const seen = new Set(roots);
    const add = (root) => {
      if (!root || seen.has(root)) return;
      if (root.nodeType === 11 && !(root.host && root.host.isConnected)) return;
      seen.add(root);
      roots.push(root);
    };
    for (const o of observers) add(o.root);
    for (let i = 0; i < roots.length; i++) {
      let all;
      try { all = roots[i].querySelectorAll('*'); } catch (e) { continue; }
      for (const el of all) {
        if (el.shadowRoot) add(el.shadowRoot);
      }
    }
    return roots;
  }

  // Same role and name and an identical tag-only path, and exactly one such
  // element: identical rows are refused, never guessed, so a ref never jumps
  // across rows. Sibling indices stay in the key but select nothing.
  function findByKey(key) {
    const last = key.path[key.path.length - 1];
    if (!last) return null;
    let found = null;
    for (const root of searchRoots()) {
      let all;
      try { all = root.querySelectorAll('*'); } catch (e) { continue; }
      for (const el of all) {
        if (tagOf(el) !== last.tag || roleOf(el) !== key.role || nameOf(el) !== key.name) continue;
        const path = keyPathOf(el);
        if (path.length !== key.path.length) continue;
        let same = true;
        for (let i = 0; i < path.length && same; i++) {
          if (path[i].tag !== key.path[i].tag) same = false;
        }
        if (!same) continue;
        if (found) return null;
        found = el;
      }
    }
    return found;
  }

  g.semanticKeyFor = semanticKeyFor;

  g.refFor = function (el) {
    try {
      if (g.dead || !el || el.nodeType !== 1) return null;
      let ref = refs.get(el);
      if (!ref) {
        ref = refPrefix + ++refSeq;
        refs.set(el, ref);
        const key = semanticKeyFor(el);
        if (key) refKeys.set(ref, key);
      }
      // Same node, same ref: re-register one pruned while it was detached.
      if (!refNodes.has(ref)) refNodes.set(ref, holdWeakly(el));
      return ref;
    } catch (e) {
      return null;
    }
  };

  g.resolveRefDetailed = function (ref) {
    try {
      if (g.dead || !ownsRef(ref)) return null;
      const held = refNodes.get(ref);
      const old = held ? held.deref() : null;
      if (old && old.isConnected) return { el: old, reresolved: false };
      refNodes.delete(ref);
      const key = refKeys.get(ref);
      if (!key) return null;
      const el = findByKey(key);
      if (!el) return null;
      if (old && refs.get(old) === ref) refs.delete(old);
      // A node that already has its own ref keeps it for refFor; this ref
      // still resolves to it through refNodes.
      if (!refs.has(el)) refs.set(el, ref);
      refNodes.set(ref, holdWeakly(el));
      return { el: el, reresolved: true };
    } catch (e) {
      return null;
    }
  };

  g.resolveRef = function (ref) {
    const result = g.resolveRefDetailed(ref);
    return result ? result.el : null;
  };

  g.keyForRef = function (ref) {
    if (g.dead || !ownsRef(ref)) return null;
    const key = refKeys.get(ref);
    if (!key) return null;
    return { role: key.role, name: key.name, path: key.path.map((s) => ({ tag: s.tag, index: s.index })) };
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
    refKeys.clear();
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
 * document that is still connected — plus `reresolved: true` when the node was
 * gone and the ref was just rebound by its semantic key —
 * `{ ok: true, found: false }` when it is unknown or stale, or
 * `{ ok: false, reason: 'observer-unavailable' }`.
 */
export function buildObserverRefResolveJs(ref: string): string {
  const refJson = jsStringLiteral(typeof ref === 'string' ? ref : '');
  return callInstance(
    `((r) => { if (!r) return { ok: true, found: false }; const tag = r.el.localName || String(r.el.nodeName).toLowerCase(); return r.reresolved ? { ok: true, found: true, tag: tag, reresolved: true } : { ok: true, found: true, tag: tag }; })(g.resolveRefDetailed(${refJson}))`,
  );
}

/**
 * Build the semantic-key read expression. Evaluates to `{ ok: true, key }`
 * with the `{ role, name, path }` stored when `ref` was issued, `{ ok: true,
 * key: null }` for a ref this document instance does not know, or
 * `{ ok: false, reason: 'observer-unavailable' }`.
 */
export function buildObserverSemanticKeyJs(ref: string): string {
  const refJson = jsStringLiteral(typeof ref === 'string' ? ref : '');
  return callInstance(`({ ok: true, key: g.keyForRef(${refJson}) })`);
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
