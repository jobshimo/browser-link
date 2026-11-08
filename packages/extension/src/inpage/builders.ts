/**
 * Builders that assemble the CDP `Runtime.evaluate` expression strings for
 * `snapshot`, `find`, `click`, `type`, `press` and the shared post-action
 * `settle` wait. Extracted out of background.ts so the produced JS source
 * can be unit-tested by evaluating it directly in a DOM environment (see
 * the `*.test.ts` files next to this module) — the exact same string
 * background.ts sends over CDP.
 */
import { DEEP_QUERY_JS } from './deep-query.js';
import { DOM_HELPERS_JS } from './dom-helpers.js';
import { OBSERVER_GLOBAL } from './observer.js';

/**
 * In-page access to the page observer's element identity (spec v4 §5.6),
 * injected verbatim into `buildSnapshotJs`, `buildFindJs` and `buildStateJs`.
 * The observer global is looked up ONCE per evaluation and used only when it
 * is present, not torn down, and exposes `refFor`:
 *   - `refOf(el)` returns the observer's `<doc_tag>:e<N>` ref for `el`, or `null`;
 *   - `withDocId(result)` adds `doc_id` to `result` and returns it;
 *   - `snapshotStore()` returns the observer when it keeps snapshot records
 *     (`recordSnapshot` / `getSnapshot`, used by `snapshot({ since })`), else
 *     `null`.
 * Without the observer (injection failed, pre-observer document) all are
 * no-ops, so every result is byte-identical to the pre-ref output.
 */
export const PAGE_OBSERVER_JS = `
  const pageObserver = (() => {
    try {
      const g = window[${JSON.stringify(OBSERVER_GLOBAL)}];
      if (g && !g.dead && typeof g.refFor === 'function') return g;
    } catch (e) {}
    return null;
  })();
  function refOf(el) {
    if (!pageObserver) return null;
    try {
      const ref = pageObserver.refFor(el);
      return typeof ref === 'string' ? ref : null;
    } catch (e) {
      return null;
    }
  }
  function withDocId(result) {
    if (pageObserver && typeof pageObserver.doc_id === 'string') result.doc_id = pageObserver.doc_id;
    return result;
  }
  function snapshotStore() {
    if (
      pageObserver &&
      typeof pageObserver.recordSnapshot === 'function' &&
      typeof pageObserver.getSnapshot === 'function'
    ) {
      return pageObserver;
    }
    return null;
  }
`;

/**
 * In-page action-target resolution (spec v4 §6.3), injected after
 * `DEEP_QUERY_JS` and `PAGE_OBSERVER_JS` into the builders that take a
 * `selector` or a `ref` (click, type, focus, element rect, `wait_for` by
 * ref, `find` by ref):
 * `resolveTarget(opts)` with a non-empty `opts.ref` asks the observer
 * (`resolveRefDetailed`, which re-resolves a replaced node by its semantic
 * key) and answers `{ ok: true, el, reresolved }`, `{ ok: false, reason:
 * 'ref-stale', ref, doc_id }` or `{ ok: false, reason: 'observer-unavailable'
 * }`; otherwise it resolves `opts.selector` exactly as the selector builders
 * always did (`invalid-selector` checked against `document` first, then
 * `deepQueryFirst`, `not-found`). Kept out of `PAGE_OBSERVER_JS` so the
 * snapshot and state sources do not carry code they never call.
 */
export const RESOLVE_TARGET_JS = `
  function resolveTarget(opts) {
    if (typeof opts.ref === 'string' && opts.ref.length > 0) {
      if (!pageObserver || typeof pageObserver.resolveRefDetailed !== 'function') {
        return { ok: false, reason: 'observer-unavailable' };
      }
      let found = null;
      try {
        found = pageObserver.resolveRefDetailed(opts.ref);
      } catch (e) {
        found = null;
      }
      if (!found || !found.el) return withDocId({ ok: false, reason: 'ref-stale', ref: opts.ref });
      return { ok: true, el: found.el, reresolved: found.reresolved === true };
    }
    try {
      document.querySelector(opts.selector);
    } catch (e) {
      return { ok: false, reason: 'invalid-selector', error: e && e.message ? e.message : String(e) };
    }
    const el = deepQueryFirst(opts.selector);
    if (!el) return { ok: false, reason: 'not-found' };
    return { ok: true, el: el, reresolved: false };
  }
`;

/** The target of an action builder: exactly one of a CSS `selector` or an
 * observer `ref` (`<doc_tag>:e<N>`, from `snapshot` / `find` / `state`). */
export interface TargetOpts {
  selector?: string;
  ref?: string;
}

/** JSON for the `selector` / `ref` pair, embedded as data in the built
 * source; `ref` is included only when given so a selector build keeps the
 * same options object as before. */
function targetJson(opts: TargetOpts): Record<string, string | undefined> {
  return typeof opts.ref === 'string' && opts.ref.length > 0
    ? { selector: opts.selector, ref: opts.ref }
    : { selector: opts.selector };
}

/**
 * Build the snapshot expression. Filters are applied INSIDE the page so the
 * server never receives the dropped material at all — that's where the token
 * win for `within_selector` / `only_interactive` / `exclude` actually lives.
 * The serializer omits empty-string fields per entry (token win that applies
 * unconditionally on every snapshot).
 *
 * The scan pierces open Shadow DOM roots and same-origin iframes via
 * `deepQueryAll` (see `deep-query.ts`). `within_selector` itself is resolved
 * with `deepQueryFirst`, so a subtree inside a shadow root or iframe can be
 * targeted too. Matched entries that live inside an iframe carry an
 * optional `frame` field with the innermost hosting iframe's selector, and
 * entries whose generated selector could not be made unique across the deep
 * search scope carry `ambiguous: true` (see `genSelectorInfo`).
 *
 * Interactive entries are gated by `isClickTarget`, not bare `isVisible`:
 * a computed `pointer-events: none` element can never receive a real click
 * (see the helper's comment in `dom-helpers.ts`). Headings and the text
 * dump keep plain `isVisible`, so such elements still contribute text.
 *
 * With the page observer installed (see `PAGE_OBSERVER_JS`), each
 * interactive entry carries `ref` right after `selector`, and the result
 * carries `doc_id` and `snapshot_id` (`<doc_id>:s<N>`, one per call). Without
 * it the output is unchanged.
 *
 * Every snapshot taken with the observer is recorded by it (the last 4 per
 * document; the first 500 entries keyed by ref, each with a hash = the entry
 * serialised without `ref`). `since: <snapshot_id>` then answers with a diff
 * against that record instead of the full list:
 *   { title, url, doc_id, snapshot_id, since, added, removed, changed,
 *     overflow?, headings?, text? }
 * `added` are entries whose ref is new, `removed` are `{ ref, tag, text? }`
 * of refs gone (capped at 500), `changed` are current entries whose hash
 * differs. `max_interactive` applies AFTER diffing to `added` then `changed`;
 * `overflow` counts what it dropped. `headings` / `text` appear only when
 * `only_interactive` is false and they differ from the recorded ones.
 * When the diff cannot be made the result is the full snapshot plus `since`
 * and `since_status`:
 *   - `observer-unavailable`: no observer (no `doc_id` / `snapshot_id`);
 *   - `doc-changed`: `snapshot_id` is `<doc_id>:s<N>`, and the part of
 *     `since` before its LAST `:` is not the current `doc_id` (or `since` has
 *     no `:`), so it came from another document; the store is not consulted;
 *   - `evicted`: the prefix is the current `doc_id` but the id is not among
 *     the last 4 records (evicted, or never issued).
 * A `within_selector` miss ignores `since` and keeps the miss shape (plus
 * `doc_id`).
 */
export interface SnapshotOpts {
  within_selector?: string;
  only_interactive?: boolean;
  exclude?: string[];
  max_interactive?: number;
  /** `snapshot_id` of an earlier snapshot of this document to diff against. */
  since?: string;
}

export function buildSnapshotJs(opts: SnapshotOpts = {}): string {
  const optsJson = JSON.stringify({
    withinSelector: typeof opts.within_selector === 'string' ? opts.within_selector : null,
    onlyInteractive: opts.only_interactive === true,
    exclude: Array.isArray(opts.exclude) ? opts.exclude : [],
    maxInteractive:
      typeof opts.max_interactive === 'number' && opts.max_interactive > 0
        ? Math.min(opts.max_interactive, 500)
        : 120,
    since: typeof opts.since === 'string' ? opts.since : null,
  });
  return `
(() => {
  ${DEEP_QUERY_JS}
  ${DOM_HELPERS_JS}
  ${PAGE_OBSERVER_JS}
  const opts = ${optsJson};
  let root = document;
  let notice = '';
  if (opts.withinSelector) {
    const sub = deepQueryFirst(opts.withinSelector);
    if (!sub) {
      return withDocId({
        title: document.title,
        url: location.href,
        interactive: [],
        notice: 'within_selector did not match any element',
      });
    }
    root = sub;
  }
  const excludeSet = new Set((opts.exclude || []).map(s => String(s).toLowerCase()));
  function inExcludedLandmark(el) {
    // Composed-tree climb (same pattern as composedContains): walking via
    // parentElement alone would stop dead at a shadow boundary — a button
    // inside a web component slotted into <nav> would escape exclusion.
    // parentNode reaches the ShadowRoot; jumping to .host continues the
    // climb in the host document.
    if (excludeSet.size === 0) return false;
    let cur = el.parentNode;
    let guard = 0;
    while (cur && guard < 1000) {
      guard++;
      if (cur === root) return false;
      if (cur.nodeType === 1) {
        const tag = cur.tagName ? cur.tagName.toLowerCase() : '';
        if (excludeSet.has(tag)) return true;
        if (cur === document.body) return false;
        cur = cur.parentNode;
        continue;
      }
      if (cur.host) {
        cur = cur.host;
        continue;
      }
      break;
    }
    return false;
  }
  const sel = 'a[href], button, input, select, textarea, [role=button], [role=link], [role=checkbox], [role=tab], [role=menuitem], [contenteditable=true]';
  const interactive = [];
  deepQueryAll(sel, root).forEach((el) => {
    // isClickTarget, not isVisible: a pointer-events:none element can
    // never receive a real click. Headings/text keep plain isVisible.
    if (!isClickTarget(el)) return;
    if (inExcludedLandmark(el)) return;
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || tag;
    const selInfo = genSelectorInfo(el);
    const entry = { tag, role, selector: selInfo.selector };
    const ref = refOf(el);
    if (ref) entry.ref = ref;
    if (selInfo.ambiguous) entry.ambiguous = true;
    const txt = shortText(el);
    if (txt) entry.text = txt;
    if ('value' in el && el.value) entry.value = String(el.value);
    const placeholder = el.getAttribute('placeholder');
    if (placeholder) entry.placeholder = placeholder;
    const aria_label = el.getAttribute('aria-label');
    if (aria_label) entry.aria_label = aria_label;
    const name = el.getAttribute('name');
    if (name) entry.name = name;
    const type = el.getAttribute('type');
    if (type) entry.type = type;
    const href = el.getAttribute('href');
    if (href) entry.href = href;
    if ('disabled' in el && el.disabled) entry.disabled = true;
    const frame = frameSelectorFor(el);
    if (frame) entry.frame = frame;
    interactive.push(entry);
  });
  let headings = null;
  let visibleText = '';
  if (!opts.onlyInteractive) {
    const found = [];
    deepQueryAll('h1, h2, h3', root).forEach((h) => {
      if (!isVisible(h)) return;
      if (inExcludedLandmark(h)) return;
      const t = shortText(h);
      if (t) found.push({ level: h.tagName, text: t });
    });
    headings = found.slice(0, 30);
    const textRoot = (root === document) ? (document.body || document) : root;
    visibleText = (textRoot && textRoot.innerText) ? textRoot.innerText.slice(0, 4000) : '';
  }
  let snapshotId = null;
  if (withDocId({}).doc_id && typeof pageObserver.nextSnapshotId === 'function') {
    const issued = pageObserver.nextSnapshotId();
    if (typeof issued === 'string') snapshotId = issued;
  }
  function fullResult() {
    const result = {
      title: document.title,
      url: location.href,
      interactive: interactive.slice(0, opts.maxInteractive),
    };
    if (headings) result.headings = headings;
    if (visibleText) result.text = visibleText;
    if (notice) result.notice = notice;
    withDocId(result);
    if (snapshotId) result.snapshot_id = snapshotId;
    return result;
  }
  // Record every snapshot (with or without since) so a later call can diff
  // against it. Entries are keyed by ref; the hash is the entry serialised
  // without its ref, in emission order. Capped at the first 500 entries.
  const store = snapshotId ? snapshotStore() : null;
  // A snapshot_id is \`<doc_id>:s<N>\`: a since whose prefix (before the LAST
  // ':') is not this document's doc_id, or that has no ':', came from another
  // document and is never looked up.
  const sinceCut = opts.since === null ? -1 : opts.since.lastIndexOf(':');
  const sinceSameDoc =
    sinceCut >= 0 && withDocId({}).doc_id === opts.since.slice(0, sinceCut);
  const previous = store && sinceSameDoc ? store.getSnapshot(opts.since) : null;
  const current = new Map();
  const headingsHash = headings ? JSON.stringify(headings) : null;
  const textHash = opts.onlyInteractive ? null : visibleText;
  if (store) {
    for (const entry of interactive) {
      if (current.size >= 500) break;
      if (typeof entry.ref !== 'string') continue;
      const copy = {};
      for (const key of Object.keys(entry)) if (key !== 'ref') copy[key] = entry[key];
      current.set(entry.ref, { hash: JSON.stringify(copy), entry });
    }
    store.recordSnapshot(snapshotId, { entries: current, headings_hash: headingsHash, text_hash: textHash });
  }
  if (opts.since === null) return fullResult();
  if (!store) {
    const result = fullResult();
    result.since = opts.since;
    result.since_status = 'observer-unavailable';
    return result;
  }
  if (!previous || !previous.entries || typeof previous.entries.get !== 'function') {
    const result = fullResult();
    result.since = opts.since;
    result.since_status = sinceSameDoc ? 'evicted' : 'doc-changed';
    return result;
  }
  const added = [];
  const changed = [];
  const removed = [];
  current.forEach((item, ref) => {
    const old = previous.entries.get(ref);
    if (!old) added.push(item.entry);
    else if (old.hash !== item.hash) changed.push(item.entry);
  });
  previous.entries.forEach((item, ref) => {
    if (current.has(ref) || removed.length >= 500) return;
    const gone = { ref, tag: item.entry.tag };
    if (item.entry.text) gone.text = item.entry.text;
    removed.push(gone);
  });
  // max_interactive applies after diffing (added first, then changed), so
  // a window shift never masquerades as change.
  const listed = added.concat(changed);
  const kept = listed.slice(0, opts.maxInteractive);
  const diff = withDocId({ title: document.title, url: location.href });
  diff.snapshot_id = snapshotId;
  diff.since = opts.since;
  diff.added = kept.slice(0, Math.min(added.length, kept.length));
  diff.removed = removed;
  diff.changed = kept.slice(diff.added.length);
  if (listed.length > kept.length) diff.overflow = listed.length - kept.length;
  if (!opts.onlyInteractive) {
    if (headingsHash !== previous.headings_hash) diff.headings = headings;
    if (textHash !== previous.text_hash) diff.text = visibleText;
  }
  return diff;
})()
`;
}

/** Build the find-by-text expression. Returns one of:
 *   { matched: true, selector, ref?, coords:{x,y}, tag, text, frame?, ambiguous?, doc_id? }
 *   { matched: false, reason: 'not-found', error?, near_misses?: [{text,selector,ref?,role?}], doc_id? }
 *   { matched: false, reason: 'multiple-matches', candidates: [{selector,ref?,text,tag}], doc_id? }
 *
 * `ref`, `semantic_key` and `doc_id` are present only when the page observer
 * is installed (see `PAGE_OBSERVER_JS`). `semantic_key` is the observer's
 * `semanticKeyFor(el)` (`{ role, name, path }`) and is carried by single
 * matches only — candidates and near-misses stay small.
 *
 * With `ref` (spec v4 §6.3) the text scan is skipped: `text`, `role` and
 * `exact` are ignored and the result describes the element the ref resolves
 * to, in the single-match shape plus `reresolved: true` when the node was
 * just re-resolved by its semantic key —
 *   { matched: true, selector, ref, coords, tag, text, ambiguous?, frame?, reresolved?, semantic_key, doc_id }
 *   { matched: false, reason: 'ref-stale', ref, doc_id }
 *   { matched: false, reason: 'observer-unavailable', ref }
 * The element is reported as is (no click-target gate): the caller named it.
 *
 * With `key` (`{ role, name, path? }`, the shape `semantic_key` and the map's
 * stored key carry) the text scan is skipped too: candidates are the
 * elements whose semantic key has the same `role` AND `name`. With `path`,
 * only candidates with the identical tag sequence count and exactly one must
 * exist (the observer's re-resolution rule; sibling indices select nothing);
 * without it, exactly one role + name candidate must exist. A unique match
 * answers in the single-match shape; otherwise
 *   { matched: false, reason: 'not-found', error?, doc_id }
 * where `error` is `key: <N> candidates share role, name and tag path` when
 * several share the tag path, else starts with `key: <N> candidates share
 * role and name` when N > 0, and `{ matched: false, reason:
 * 'observer-unavailable' }` without the observer. No click-target gate, as
 * for `ref`.
 *
 * Role-aware: when `role` is provided, only elements whose explicit ARIA
 * role or implicit role match are considered. When omitted, the search
 * scans a broad set of interactive + clickable elements. Candidates are
 * gated by `isClickTarget` — a pointer-events:none element is never a
 * match; it can still surface as a near-miss hint (plain `isVisible`).
 *
 * The scan pierces open Shadow DOM roots and same-origin iframes via
 * `deepQueryAll`. `coords` are mapped to TOP-LEVEL viewport coordinates
 * (accounting for ancestor iframe offsets) so they are directly usable by
 * `browser.drag` and other coordinate-based tools.
 *
 * `not-found` carries up to 3 `near_misses` — VISIBLE interactive-ish
 * elements ranked by (1) case-insensitive substring containment of the
 * query in the candidate's accessible text/name, then (2) token overlap —
 * so the agent gets a "did you mean" instead of a bare miss. Omitted
 * entirely when nothing scores (no junk suggestions). When `role` narrowed
 * the scan and the text DOES exist outside that role, `error` names the
 * exclusion explicitly (e.g. `text matched 2 elements but none with role
 * "button" — closest: <div onclick> "GIF picker"`) and `near_misses` is
 * populated from that broader, role-agnostic match set instead.
 *
 * Near-miss entries use `genSelector` (not `genSelectorInfo`), so the
 * `ambiguous` flag is intentionally NOT carried — a near-miss selector
 * that collides with structurally-identical twins in other roots resolves
 * first-match-wins silently. Documented on the tool as: hints for the
 * next `find`, never click targets.
 */
/** A semantic key to find by: the observer's `semanticKeyFor` shape, with
 * `path` optional (see `buildFindJs`). */
export interface FindKey {
  role: string;
  name: string;
  path?: Array<{ tag: string; index: number }>;
}

export interface FindOpts {
  /** Required unless `ref` or `key` is given. */
  text?: string;
  role?: string;
  exact?: boolean;
  ref?: string;
  key?: FindKey;
}

/** Only the documented key fields reach the built source, as JSON data. */
function findKeyJson(key: FindKey): FindKey {
  return Array.isArray(key.path)
    ? {
        role: key.role,
        name: key.name,
        path: key.path.map((step) => ({ tag: step.tag, index: step.index })),
      }
    : { role: key.role, name: key.name };
}

export function buildFindJs(opts: FindOpts): string {
  const optsJson = JSON.stringify({
    text: opts.text,
    role: typeof opts.role === 'string' && opts.role.length > 0 ? opts.role : null,
    exact: opts.exact === true,
    candidateLimit: 5,
    nearMissLimit: 3,
    ...(typeof opts.ref === 'string' && opts.ref.length > 0 ? { ref: opts.ref } : {}),
    ...(opts.key ? { key: findKeyJson(opts.key) } : {}),
  });
  return `
(() => {
  ${DEEP_QUERY_JS}
  ${DOM_HELPERS_JS}
  ${PAGE_OBSERVER_JS}
  ${typeof opts.ref === 'string' && opts.ref.length > 0 ? RESOLVE_TARGET_JS : ''}
  const opts = ${optsJson};
  function semanticKeyOf(el) {
    if (!pageObserver || typeof pageObserver.semanticKeyFor !== 'function') return null;
    try {
      const key = pageObserver.semanticKeyFor(el);
      return key && typeof key === 'object' ? key : null;
    } catch (e) {
      return null;
    }
  }
  function singleMatch(el, ref, reresolved) {
    const center = viewportCenterOf(el);
    const selInfo = genSelectorInfo(el);
    const result = { matched: true, selector: selInfo.selector };
    if (ref) result.ref = ref;
    result.coords = {
      x: Math.round(center.x),
      y: Math.round(center.y),
    };
    result.tag = el.tagName.toLowerCase();
    result.text = shortText(el);
    if (selInfo.ambiguous) result.ambiguous = true;
    const frame = frameSelectorFor(el);
    if (frame) result.frame = frame;
    if (reresolved) result.reresolved = true;
    const key = semanticKeyOf(el);
    if (key) result.semantic_key = key;
    return withDocId(result);
  }
  if (typeof opts.ref === 'string') {
    const target = resolveTarget(opts);
    if (!target.ok) {
      const failure = { matched: false, reason: target.reason, ref: opts.ref };
      return withDocId(failure);
    }
    return singleMatch(target.el, opts.ref, target.reresolved);
  }
  if (opts.key) {
    if (!pageObserver || typeof pageObserver.semanticKeyFor !== 'function') {
      return { matched: false, reason: 'observer-unavailable' };
    }
    const wanted = opts.key;
    const candidates = [];
    for (const el of deepQueryAll('*')) {
      const key = semanticKeyOf(el);
      if (key && key.role === wanted.role && key.name === wanted.name) {
        candidates.push({ el: el, path: Array.isArray(key.path) ? key.path : [] });
      }
    }
    const count = candidates.length;
    const shared = 'key: ' + count + ' candidates share role and name; ';
    let picked = null;
    let error = count > 1 ? shared + 'pass path to disambiguate' : null;
    if (!Array.isArray(wanted.path)) {
      if (count === 1) picked = candidates[0].el;
    } else {
      // Same rule as the observer's re-resolution: identical tag path and
      // exactly one such candidate; identical rows are refused, never guessed.
      let sameTags = 0;
      let only = null;
      for (const c of candidates) {
        if (c.path.length !== wanted.path.length) continue;
        let same = true;
        for (let i = 0; i < c.path.length && same; i++) {
          if (c.path[i].tag !== wanted.path[i].tag) same = false;
        }
        if (!same) continue;
        sameTags++;
        only = c.el;
      }
      if (sameTags === 1) {
        picked = only;
      } else if (sameTags > 1) {
        error = 'key: ' + sameTags + ' candidates share role, name and tag path';
      } else if (count > 0) {
        error = shared + 'none has the same tag path';
      }
    }
    if (picked) return singleMatch(picked, refOf(picked), false);
    const failure = { matched: false, reason: 'not-found' };
    if (error) failure.error = error;
    return withDocId(failure);
  }
  const needle = opts.text.toLowerCase();
  const needleTokens = needle.split(/[^a-z0-9]+/).filter(Boolean);
  const ROLE_SELECTORS = {
    button: 'button, [role="button"], input[type="button"], input[type="submit"], input[type="reset"]',
    link: 'a[href], [role="link"]',
    textbox: 'input[type="text"], input[type="email"], input[type="password"], input[type="search"], input[type="url"], input[type="tel"], input:not([type]), textarea, [role="textbox"], [contenteditable="true"]',
    checkbox: 'input[type="checkbox"], [role="checkbox"]',
    tab: '[role="tab"]',
    menuitem: '[role="menuitem"]',
  };
  const BROAD_SELECTOR = 'button, a, input, textarea, select, [role], [onclick], [contenteditable="true"], [tabindex]';
  const selectorSet = opts.role && ROLE_SELECTORS[opts.role]
    ? ROLE_SELECTORS[opts.role]
    : BROAD_SELECTOR;
  const all = deepQueryAll(selectorSet);
  const matches = [];
  for (const el of all) {
    // isClickTarget, not isVisible: find returns CLICK TARGETS. Near-miss
    // ranking below keeps plain isVisible — hints, never click targets.
    if (!isClickTarget(el)) continue;
    const text = accessibleText(el).trim();
    if (text.length === 0) continue;
    const lower = text.toLowerCase();
    const ok = opts.exact ? lower === needle : lower.includes(needle);
    if (ok) matches.push(el);
  }
  if (matches.length === 0) {
    // Near-miss ranking: containment beats token overlap; anything scoring
    // 0 is dropped so the suggestion list never pads itself with noise.
    function snippetOf(el) {
      const t = accessibleText(el).trim();
      return t.length > 60 ? t.slice(0, 60) + '...' : t;
    }
    function scoreText(text) {
      const lower = text.toLowerCase();
      const contains = lower.includes(needle);
      const candTokens = lower.split(/[^a-z0-9]+/).filter(Boolean);
      let overlap = 0;
      for (let i = 0; i < needleTokens.length; i++) {
        if (candTokens.indexOf(needleTokens[i]) !== -1) overlap++;
      }
      if (!contains && overlap === 0) return -1;
      return (contains ? 1000 : 0) + overlap * 10;
    }
    function rankCandidates(elements) {
      const scored = [];
      for (const el of elements) {
        if (!isVisible(el)) continue;
        const text = accessibleText(el).trim();
        if (text.length === 0) continue;
        const score = scoreText(text);
        if (score < 0) continue;
        scored.push({ el: el, score: score });
      }
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, opts.nearMissLimit).map((s) => s.el);
    }
    function toNearMiss(el) {
      const entry = { text: snippetOf(el), selector: genSelector(el) };
      const ref = refOf(el);
      if (ref) entry.ref = ref;
      const roleAttr = el.getAttribute('role');
      if (roleAttr) entry.role = roleAttr;
      return entry;
    }
    function describeForError(el) {
      const tag = el.tagName.toLowerCase();
      if (el.hasAttribute('onclick')) return '<' + tag + ' onclick>';
      const role = el.getAttribute('role');
      if (role) return '<' + tag + ' role="' + role + '">';
      return '<' + tag + '>';
    }
    const result = { matched: false, reason: 'not-found' };
    if (opts.role) {
      // Role narrowed the scan — check whether the text exists OUTSIDE the
      // role filter so the error can name the exclusion explicitly instead
      // of reporting a bare not-found.
      const broadAll = deepQueryAll(BROAD_SELECTOR);
      const broadTextMatches = [];
      for (const el of broadAll) {
        if (!isVisible(el)) continue;
        const text = accessibleText(el).trim();
        if (text.length === 0) continue;
        if (text.toLowerCase().includes(needle)) broadTextMatches.push(el);
      }
      if (broadTextMatches.length > 0) {
        const ranked = rankCandidates(broadTextMatches);
        const closest = ranked[0];
        result.error = 'text matched ' + broadTextMatches.length + ' element' +
          (broadTextMatches.length === 1 ? '' : 's') +
          ' but none with role "' + opts.role + '"' +
          (closest ? ' — closest: ' + describeForError(closest) + ' "' + snippetOf(closest) + '"' : '');
        result.near_misses = ranked.map(toNearMiss);
        return withDocId(result);
      }
      const ranked = rankCandidates(broadAll);
      if (ranked.length > 0) result.near_misses = ranked.map(toNearMiss);
      return withDocId(result);
    }
    const ranked = rankCandidates(all);
    if (ranked.length > 0) result.near_misses = ranked.map(toNearMiss);
    return withDocId(result);
  }
  if (matches.length > 1) {
    return withDocId({
      matched: false,
      reason: 'multiple-matches',
      candidates: matches.slice(0, opts.candidateLimit).map((el) => {
        const candidate = { selector: genSelector(el) };
        const ref = refOf(el);
        if (ref) candidate.ref = ref;
        candidate.text = shortText(el);
        candidate.tag = el.tagName.toLowerCase();
        return candidate;
      }),
    });
  }
  const el = matches[0];
  return singleMatch(el, refOf(el), false);
})()
`;
}

/**
 * Build the click-resolution expression: resolves the selector across the
 * deep search scope, scrolls the element (and every ancestor iframe) into
 * view, computes the TOP-LEVEL viewport click point, and — unless `force`
 * is set — hit-tests that point before returning it, so a covering overlay
 * is caught before background.ts dispatches CDP mouse events. Returns:
 *   { ok: true, x, y, tag, hit_element?, reresolved? }
 *   { ok: false, reason: 'invalid-selector', error }
 *   { ok: false, reason: 'not-found' }
 *   { ok: false, reason: 'occluded', blocker }
 *   { ok: false, reason: 'ref-stale', ref, doc_id }
 *   { ok: false, reason: 'observer-unavailable' }
 *
 * The target is `selector` or `ref` (see `resolveTarget` in
 * `PAGE_OBSERVER_JS`); `reresolved: true` is present only when a `ref`'s
 * node was gone and was just re-resolved by its semantic key.
 *
 * `hit_element` is present ONLY when the dispatched click will land on a
 * DIFFERENT element than the resolved target (neither the target nor a
 * descendant): a pointer-events:none target whose real hit-target sibling
 * takes the click (allowed, not 'occluded' — see checkOcclusion), an
 * ancestor wrapper, or a `force` click landing on whatever covers the
 * point — the hit-test runs under `force` too, which skips the BLOCK,
 * not the truth-telling.
 *
 * The `invalid-selector` check runs BEFORE `deepQueryFirst` — a malformed
 * CSS selector throws the identical `SyntaxError` from every root's own
 * `querySelector`, which `deepQueryFirst`'s per-root try/catch otherwise
 * swallows into an indistinguishable "not-found". Checking once against
 * `document` up front separates "the selector text is broken" from "the
 * selector is valid but nothing on the page matches it".
 */
export interface ClickResolveOpts extends TargetOpts {
  force: boolean;
}

export function buildClickResolveJs(opts: ClickResolveOpts): string {
  const optsJson = JSON.stringify({ ...targetJson(opts), force: opts.force });
  return `
(() => {
  ${DEEP_QUERY_JS}
  ${PAGE_OBSERVER_JS}
  ${RESOLVE_TARGET_JS}
  const opts = ${optsJson};
  const target = resolveTarget(opts);
  if (!target.ok) return target;
  const el = target.el;
  const chain = frameElementChain(el);
  for (const fe of chain) {
    if (fe.scrollIntoView) fe.scrollIntoView({ block: 'center', inline: 'center' });
  }
  if (el.scrollIntoView) el.scrollIntoView({ block: 'center', inline: 'center' });
  const center = viewportCenterOf(el);
  const tag = el.tagName.toLowerCase();
  const occlusion = checkOcclusion(el, center.localX, center.localY);
  if (!occlusion.allowed && !opts.force) {
    return { ok: false, reason: 'occluded', blocker: occlusion.blocker };
  }
  const result = { ok: true, x: center.x, y: center.y, tag };
  const hit = occlusion.allowed ? occlusion.hit : occlusion.blocker;
  if (hit) result.hit_element = hit;
  if (target.reresolved) result.reresolved = true;
  return result;
})()
`;
}

/**
 * Build the type-resolution expression: resolves the selector across the
 * deep search scope, focuses it, optionally clears its value, and reports
 * success so background.ts can follow up with CDP `Input.insertText`
 * (which types into whatever currently has focus at the browser level —
 * works the same whether that focus target lives in the top document, a
 * shadow root, or a same-origin iframe). Returns:
 *   { ok: true, reresolved? }
 *   { ok: false, reason: 'invalid-selector', error }
 *   { ok: false, reason: 'not-found' }
 *   { ok: false, reason: 'ref-stale', ref, doc_id }
 *   { ok: false, reason: 'observer-unavailable' }
 *
 * Same invalid-selector pre-check and `selector` / `ref` target as
 * `buildClickResolveJs` — see its doc comment.
 */
export interface TypeResolveOpts extends TargetOpts {
  clear: boolean;
}

export function buildTypeResolveJs(opts: TypeResolveOpts): string {
  const optsJson = JSON.stringify(targetJson(opts));
  return `
(() => {
  ${DEEP_QUERY_JS}
  ${PAGE_OBSERVER_JS}
  ${RESOLVE_TARGET_JS}
  const opts = ${optsJson};
  const target = resolveTarget(opts);
  if (!target.ok) return target;
  const el = target.el;
  el.focus();
  ${opts.clear ? "if ('value' in el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }" : ''}
  return target.reresolved ? { ok: true, reresolved: true } : { ok: true };
})()`;
}

/**
 * Build the focus-resolution expression for `browser.press`'s optional
 * `selector`: resolves the selector across the deep search scope and
 * focuses it, reporting success so background.ts can follow up with the
 * CDP key event sequence (which — like `Input.insertText` — targets
 * whatever currently has focus at the browser level). Intentionally
 * separate from `buildTypeResolveJs`: press never clears a value, and
 * naming it distinctly keeps the press code path readable on its own.
 *
 * The return shape depends on the target. With `selector` it stays a
 * boolean (`true` focused, `false` not found — a malformed selector is
 * also `false`, as before). With `ref` it is an object, so the caller can
 * tell a stale ref from a missing selector without a second evaluation:
 * `{ ok: true, reresolved? }`, `{ ok: false, reason: 'ref-stale', ref,
 * doc_id }` or `{ ok: false, reason: 'observer-unavailable' }`.
 */
export type FocusResolveOpts = TargetOpts;

export function buildFocusJs(opts: FocusResolveOpts): string {
  const optsJson = JSON.stringify(targetJson(opts));
  return `
(() => {
  ${DEEP_QUERY_JS}
  ${PAGE_OBSERVER_JS}
  ${RESOLVE_TARGET_JS}
  const opts = ${optsJson};
  const target = resolveTarget(opts);
  const byRef = typeof opts.ref === 'string';
  if (!target.ok) return byRef ? target : false;
  target.el.focus();
  if (!byRef) return true;
  return target.reresolved ? { ok: true, reresolved: true } : { ok: true };
})()`;
}

/**
 * Build the `wait_for` selector probe: one poll tick of `browser.wait_for`
 * in selector mode, evaluating to a boolean. The element is resolved with
 * `deepQueryFirst` — the same deep search scope `find` / `click` / `type`
 * use (open Shadow DOM roots and same-origin iframes) — so an element `find`
 * reports can also be waited for.
 *
 * Visibility keeps the probe `wait_for` always used — computed `display` /
 * `visibility` / `opacity` plus a non-empty box — rather than `isVisible`,
 * whose `offsetParent` test reports `<body>` as hidden and accepts
 * zero-size elements; light-DOM results stay what they were. A missing
 * element is `hidden` and `detached`. A malformed selector throws (checked
 * once against `document`, before the deep search swallows the error per
 * root), so the caller's poll counts it as "not matched" for every
 * condition, as before.
 *
 * `target` is a selector string (the source built for it is unchanged) or
 * `{ ref }` (spec v4 §6.3). A ref resolves through the page observer on
 * every tick, re-resolving a replaced node by its semantic key; a stale ref
 * counts as a MISSING element (`attached` false, `detached` true, `hidden`
 * true, `visible` false), so waiting for a row to disappear by its ref
 * works. Without the observer a ref can never resolve, so the probe answers
 * `{ ok: false, reason: 'observer-unavailable' }` instead of a boolean and
 * the caller fails the wait rather than reporting a misleading match.
 */
export type WaitForSelectorCondition = 'visible' | 'hidden' | 'attached' | 'detached';

export function buildWaitForSelectorJs(
  target: string | { ref: string },
  condition: WaitForSelectorCondition,
): string {
  if (typeof target !== 'string') {
    const refOptsJson = JSON.stringify({ ref: target.ref, condition });
    return `
(() => {
  ${DEEP_QUERY_JS}
  ${PAGE_OBSERVER_JS}
  ${RESOLVE_TARGET_JS}
  const opts = ${refOptsJson};
  const target = resolveTarget(opts);
  if (!target.ok && target.reason === 'observer-unavailable') return target;
  const el = target.ok ? target.el : null;
  ${WAIT_FOR_CONDITION_JS}
})()`;
  }
  const selector = target;
  const optsJson = JSON.stringify({ selector, condition });
  return `
(() => {
  ${DEEP_QUERY_JS}
  const opts = ${optsJson};
  document.querySelector(opts.selector);
  const el = deepQueryFirst(opts.selector);
  ${WAIT_FOR_CONDITION_JS}
})()`;
}

/** The condition check shared by both `wait_for` probe targets; `el` is
 * the resolved element or `null`. */
const WAIT_FOR_CONDITION_JS = `if (opts.condition === 'attached') return Boolean(el);
  if (opts.condition === 'detached') return !el;
  const wantHidden = opts.condition === 'hidden';
  if (!el) return wantHidden;
  const view = (el.ownerDocument && el.ownerDocument.defaultView) || window;
  const s = view.getComputedStyle(el);
  if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return wantHidden;
  const r = el.getBoundingClientRect();
  const shown = r.width > 0 && r.height > 0;
  return wantHidden ? !shown : shown;`;

/**
 * Build the element-rect probe for `browser.screenshot`'s element mode.
 * Resolves the selector with the same deep search scope as click/find,
 * scrolls it into view (frames first), and returns its border-box rect in
 * TOP-document page coordinates (viewport rect + accumulated iframe content
 * origins + top-window scroll) — the space `Page.captureScreenshot`'s
 * `clip` expects. Returns:
 *   { ok: true, x, y, width, height, reresolved? }
 *   { ok: false, reason: 'invalid-selector', error }
 *   { ok: false, reason: 'not-found' }
 *   { ok: false, reason: 'ref-stale', ref, doc_id }
 *   { ok: false, reason: 'observer-unavailable' }
 *
 * The target is `selector` or `ref`, as for `buildClickResolveJs`.
 */
export type ElementRectOpts = TargetOpts;

export function buildElementRectJs(opts: ElementRectOpts): string {
  const optsJson = JSON.stringify(targetJson(opts));
  return `
(() => {
  ${DEEP_QUERY_JS}
  ${PAGE_OBSERVER_JS}
  ${RESOLVE_TARGET_JS}
  const opts = ${optsJson};
  const target = resolveTarget(opts);
  if (!target.ok) return target;
  const el = target.el;
  const chain = frameElementChain(el);
  // behavior 'instant' overrides CSS scroll-behavior: smooth, which would
  // leave the rect below stale while the scroll is still animating.
  const jump = { block: 'center', inline: 'center', behavior: 'instant' };
  for (const fe of chain) {
    if (fe.scrollIntoView) fe.scrollIntoView(jump);
  }
  if (el.scrollIntoView) el.scrollIntoView(jump);
  const rect = el.getBoundingClientRect();
  let offsetX = 0;
  let offsetY = 0;
  for (const fe of chain) {
    const fr = fe.getBoundingClientRect();
    const origin = frameViewportOriginOffset(fe);
    offsetX += fr.left + origin.x;
    offsetY += fr.top + origin.y;
  }
  let scrollX = 0;
  let scrollY = 0;
  try {
    const top = window.top || window;
    scrollX = top.scrollX || 0;
    scrollY = top.scrollY || 0;
  } catch (_) {}
  const result = {
    ok: true,
    x: offsetX + rect.left + scrollX,
    y: offsetY + rect.top + scrollY,
    width: rect.width,
    height: rect.height,
  };
  if (target.reresolved) result.reresolved = true;
  return result;
})()`;
}

/**
 * Build the drag endpoint-resolution probe for `browser.drag`. Resolves
 * `from_selector`/`to_selector` across the SAME deep search scope
 * `snapshot`/`find`/`click`/`type` use (`deepQueryFirst` — open Shadow DOM
 * roots and same-origin iframes, nested arbitrarily), so an endpoint that
 * lives inside a web component or an iframe no longer fails with
 * `not_found` the way a plain `document.querySelector` did before v0.20.0.
 *
 * Coordinates for a selector-based endpoint use `viewportCenterOf` — the
 * exact same first-client-rect + accumulated-iframe-offset mapping
 * `buildClickResolveJs` uses — so a drag endpoint inside a styled iframe
 * lands on the correct TOP-LEVEL point CDP `Input.dispatchMouseEvent`
 * expects, not the endpoint's own local-document coordinates.
 *
 * `in_viewport` is derived from the same mapped center point plus the
 * element's own (unscaled) width/height from `clickRectOf`, reproducing
 * the pre-v0.20.0 "does any part of the rect intersect the viewport"
 * check — now evaluated in top-level space so it stays correct for
 * iframe-hosted endpoints too.
 *
 * A coordinate-based endpoint (`from_x`/`from_y` or `to_x`/`to_y`) is
 * untouched by any of this — those are already top-level viewport
 * coordinates supplied by the caller, exactly as before.
 *
 * Deliberately scoped to ENDPOINT RESOLUTION only. The interpolated drag
 * gesture itself (wiggle distance, HTML5 intercept handshake, per-step
 * timing) lives entirely in background.ts, downstream of this probe's
 * `{ from, to, draggable }` result, and is untouched here.
 */
export interface DragProbeOpts {
  from_selector?: string;
  to_selector?: string;
  from_x?: number;
  from_y?: number;
  to_x?: number;
  to_y?: number;
}

export function buildDragProbeJs(opts: DragProbeOpts): string {
  const optsJson = JSON.stringify({
    from_selector: opts.from_selector,
    to_selector: opts.to_selector,
    from_x: opts.from_x,
    from_y: opts.from_y,
    to_x: opts.to_x,
    to_y: opts.to_y,
  });
  return `
(() => {
  ${DEEP_QUERY_JS}
  const P = ${optsJson};
  function scrollAndProbe(sel) {
    const el = deepQueryFirst(sel);
    if (!el) return { err: 'not_found' };
    const chain = frameElementChain(el);
    for (let i = 0; i < chain.length; i++) {
      if (chain[i].scrollIntoView) {
        chain[i].scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      }
    }
    if (el.scrollIntoView) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    return {
      draggable:
        el.tagName === 'IMG' ||
        (el.tagName === 'A' && !!el.href) ||
        el.draggable === true,
    };
  }
  function readCenter(sel) {
    const el = deepQueryFirst(sel);
    if (!el) return null;
    const center = viewportCenterOf(el);
    const rect = clickRectOf(el);
    const halfW = rect.width / 2;
    const halfH = rect.height / 2;
    const top = center.y - halfH;
    const left = center.x - halfW;
    const bottom = center.y + halfH;
    const right = center.x + halfW;
    return {
      x: center.x,
      y: center.y,
      in_viewport: bottom > 0 && right > 0 && top < innerHeight && left < innerWidth,
    };
  }
  let fromHint = null;
  if (P.from_selector) {
    fromHint = scrollAndProbe(P.from_selector);
    if (fromHint.err) return { err: 'from_selector not found: ' + P.from_selector };
  }
  if (P.to_selector) {
    const t = scrollAndProbe(P.to_selector);
    if (t.err) return { err: 'to_selector not found: ' + P.to_selector };
  }
  const from = P.from_selector
    ? readCenter(P.from_selector)
    : { x: P.from_x, y: P.from_y, in_viewport: true };
  const to = P.to_selector
    ? readCenter(P.to_selector)
    : { x: P.to_x, y: P.to_y, in_viewport: true };
  if (!from) return { err: 'from element disappeared between probes' };
  if (!to) return { err: 'to element disappeared between probes' };
  return { from: from, to: to, draggable: fromHint ? fromHint.draggable : false };
})()
`;
}

/**
 * Build the settle-await expression shared by `browser.click`, `.type` and
 * `.press`. Called AFTER the action's CDP input events have been
 * dispatched: installs one `MutationObserver` on `document` (subtree,
 * childList, attributes, characterData) and resolves once no mutation has
 * landed for `settle_ms` consecutive milliseconds, or once `settle_timeout_ms`
 * total has elapsed — whichever comes first. Returned as a Promise so
 * background.ts's `evaluateInTab` (CDP `Runtime.evaluate` with
 * `awaitPromise: true`) waits for it naturally.
 *
 * Baseline `url`/`activeElement` are captured at the TOP of this
 * expression — i.e. right after the action's own focus/navigation side
 * effects have already landed (dispatch already happened by the time this
 * runs), so `focus_moved`/`url_changed` report drift that happened DURING
 * the settle window, not the action's own expected effect.
 *
 * The result omits `url_changed` / `focus_moved` when they did not change
 * — token-lean by construction, no post-filtering needed.
 */
export interface SettleOpts {
  /** Quiet-period length in ms. Caller is expected to have already
   * clamped this to (0, 2000] — 0 means "don't call this builder at all". */
  settle_ms: number;
  /** Overall cap in ms. Caller is expected to have already clamped this
   * to [0, 10000]. */
  settle_timeout_ms: number;
}

export function buildSettleJs(opts: SettleOpts): string {
  const optsJson = JSON.stringify({
    settleMs: Math.max(0, opts.settle_ms),
    timeoutMs: Math.max(0, opts.settle_timeout_ms),
  });
  return `
(() => {
  const opts = ${optsJson};
  const startUrl = location.href;
  const startActiveEl = document.activeElement;
  const state = { mutationCount: 0, lastMutationAt: Date.now() };
  const observer = new MutationObserver((mutations) => {
    state.mutationCount += mutations.length;
    state.lastMutationAt = Date.now();
  });
  observer.observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });
  const start = Date.now();
  return new Promise((resolve) => {
    function finish(settled) {
      observer.disconnect();
      const result = {
        settled: settled,
        duration_ms: Date.now() - start,
        mutation_count: state.mutationCount,
      };
      if (location.href !== startUrl) result.url_changed = location.href;
      if (document.activeElement !== startActiveEl) result.focus_moved = true;
      resolve(result);
    }
    if (opts.settleMs <= 0) {
      finish(true);
      return;
    }
    (function check() {
      const now = Date.now();
      const quietFor = now - state.lastMutationAt;
      if (quietFor >= opts.settleMs) {
        finish(true);
        return;
      }
      if (now - start >= opts.timeoutMs) {
        finish(false);
        return;
      }
      setTimeout(check, Math.min(opts.settleMs - quietFor, 50));
    })();
  });
})()`;
}

export interface ExpectProbeOpts {
  selector_appears?: string;
  selector_disappears?: string;
  text_appears?: string;
}

/**
 * Build the `expect` probe: ONE cheap in-page sample of everything an
 * action's `expect` may ask about, polled by `verifyExpect` (expect.ts)
 * until its conditions hold or its window closes. Returns
 * `{ url, selector_appears?, selector_disappears?, text_appears?,
 * invalid_selector? }` — only the keys that were requested are present.
 *
 * - `selector_appears` / `selector_disappears` resolve through
 *   `deepQueryAll` (open Shadow DOM + same-origin iframes, like click and
 *   find) and count only VISIBLE matches (`isVisible`, the same notion
 *   find/snapshot use). "Disappears" holds when no visible match remains.
 * - `text_appears` is a case-insensitive, whitespace-collapsed substring
 *   test over the rendered text of the document, every open shadow root
 *   and every same-origin iframe.
 * - A selector the parser rejects is reported as `invalid_selector`
 *   (naming the condition) instead of silently reading as "absent" —
 *   which would make `selector_disappears` trivially, wrongly true.
 */
export function buildExpectProbeJs(opts: ExpectProbeOpts): string {
  const optsJson = JSON.stringify({
    selectorAppears: opts.selector_appears,
    selectorDisappears: opts.selector_disappears,
    textAppears: opts.text_appears,
  });
  return `
(() => {
  ${DEEP_QUERY_JS}
  ${DOM_HELPERS_JS}
  const opts = ${optsJson};
  const out = { url: location.href };
  function selectorIsValid(sel) {
    try {
      document.querySelector(sel);
      return true;
    } catch (_) {
      return false;
    }
  }
  function hasVisibleMatch(sel) {
    return deepQueryAll(sel).some(isVisible);
  }
  function normalized(s) {
    return String(s).replace(/\\s+/g, ' ').trim().toLowerCase();
  }
  function ownText(node) {
    const t = node.innerText;
    return typeof t === 'string' ? t : node.textContent || '';
  }
  function elementText(el) {
    const tag = el.tagName;
    if (tag === 'STYLE' || tag === 'SCRIPT' || tag === 'TEMPLATE' || tag === 'NOSCRIPT') return '';
    if (!isVisible(el)) return '';
    return ownText(el);
  }
  function rootText(root) {
    if (root.nodeType === 9) {
      let frame = null;
      try {
        frame = root.defaultView && root.defaultView.frameElement;
      } catch (_) {}
      if (frame && !isVisible(frame)) return '';
      return root.body ? ownText(root.body) : '';
    }
    if (root.host && !isVisible(root.host)) return '';
    const kids = root.children || [];
    const parts = [];
    for (let j = 0; j < kids.length; j++) parts.push(elementText(kids[j]));
    return parts.join(' ');
  }
  function renderedText() {
    const roots = collectSearchRoots(document);
    const parts = [];
    for (let i = 0; i < roots.length; i++) parts.push(rootText(roots[i]));
    return normalized(parts.join(' '));
  }
  if (opts.selectorAppears !== undefined) {
    if (selectorIsValid(opts.selectorAppears)) out.selector_appears = hasVisibleMatch(opts.selectorAppears);
    else out.invalid_selector = 'selector_appears';
  }
  if (opts.selectorDisappears !== undefined) {
    if (selectorIsValid(opts.selectorDisappears)) out.selector_disappears = !hasVisibleMatch(opts.selectorDisappears);
    else out.invalid_selector = 'selector_disappears';
  }
  if (opts.textAppears !== undefined) {
    out.text_appears = renderedText().indexOf(normalized(opts.textAppears)) !== -1;
  }
  return out;
})()
`;
}

/**
 * Build the `browser.state` expression: a compact orientation snapshot —
 * current url/title, the deep-resolved focused element, visible dialog-role
 * elements, scroll position, and viewport size. Cheaper than a full
 * `browser.snapshot` when the agent only needs "where am I right now".
 *
 * `focused` descends through `document.activeElement` past shadow-root and
 * same-origin-iframe boundaries to the real innermost focused element (a
 * shadow host or an <iframe> being "active" at one level is not the actual
 * focus target the agent cares about). Its `selector` goes through the same
 * `genSelectorInfo` uniqueness check `snapshot`/`find` use, so it carries
 * `ambiguous: true` under the same structurally-identical-twins condition.
 *
 * `dialogs` matches visible `[role=dialog]`, `[role=alertdialog]` and open
 * `<dialog>` elements found via the same deep walk, with a best-effort
 * `label` resolved from aria-label / aria-labelledby / the first heading
 * inside the dialog.
 *
 * Every optional field is omitted when there is nothing to report: no
 * `focused` beyond `<body>`, no `dialogs` when none are open, and no
 * `scroll` when the page is at its default (0,0) position — token-lean by
 * construction, matching the omit-falsy convention the other builders use.
 *
 * With the page observer installed (see `PAGE_OBSERVER_JS`), `focused`
 * carries `ref` right after `selector` and the result carries `doc_id`.
 */
export function buildStateJs(): string {
  return `
(() => {
  ${DEEP_QUERY_JS}
  ${DOM_HELPERS_JS}
  ${PAGE_OBSERVER_JS}
  function deepActiveElement() {
    let el = document.activeElement;
    let guard = 0;
    while (el && guard < 20) {
      guard++;
      if (el.shadowRoot && el.shadowRoot.activeElement) {
        el = el.shadowRoot.activeElement;
        continue;
      }
      if (el.tagName === 'IFRAME') {
        let innerDoc = null;
        try {
          innerDoc = el.contentDocument;
        } catch (_) {
          innerDoc = null;
        }
        if (innerDoc && innerDoc.activeElement && innerDoc.activeElement !== innerDoc.body) {
          el = innerDoc.activeElement;
          continue;
        }
      }
      break;
    }
    return el;
  }
  function dialogLabel(el) {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria;
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      const ids = labelledby.split(/\\s+/);
      const parts = [];
      for (let i = 0; i < ids.length; i++) {
        if (!ids[i]) continue;
        const target = deepQueryFirst('#' + CSS.escape(ids[i]));
        if (target) {
          const t = shortText(target);
          if (t) parts.push(t);
        }
      }
      const joined = parts.join(' ').trim();
      if (joined) return joined;
    }
    const heading = deepQueryFirst('h1, h2, h3', el);
    if (heading) {
      const t = shortText(heading);
      if (t) return t;
    }
    return '';
  }

  const result = {
    url: location.href,
    title: document.title,
    viewport: { w: window.innerWidth, h: window.innerHeight },
  };

  const active = deepActiveElement();
  if (active && active !== document.body && active.tagName) {
    const selInfo = genSelectorInfo(active);
    const focused = { selector: selInfo.selector };
    const ref = refOf(active);
    if (ref) focused.ref = ref;
    focused.tag = active.tagName.toLowerCase();
    if (selInfo.ambiguous) focused.ambiguous = true;
    result.focused = focused;
  }

  const dialogs = [];
  deepQueryAll('[role="dialog"], [role="alertdialog"], dialog[open]').forEach((el) => {
    if (!isVisible(el)) return;
    const role = el.getAttribute('role') || 'dialog';
    const entry = { selector: genSelector(el), role: role };
    const label = dialogLabel(el);
    if (label) entry.label = label;
    dialogs.push(entry);
  });
  if (dialogs.length > 0) result.dialogs = dialogs;

  const scrollX = Math.round(window.scrollX);
  const scrollY = Math.round(window.scrollY);
  if (scrollX !== 0 || scrollY !== 0) result.scroll = { x: scrollX, y: scrollY };

  return withDocId(result);
})()
`;
}
