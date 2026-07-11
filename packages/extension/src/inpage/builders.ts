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
 */
export interface SnapshotOpts {
  within_selector?: string;
  only_interactive?: boolean;
  exclude?: string[];
  max_interactive?: number;
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
  });
  return `
(() => {
  ${DEEP_QUERY_JS}
  ${DOM_HELPERS_JS}
  const opts = ${optsJson};
  let root = document;
  let notice = '';
  if (opts.withinSelector) {
    const sub = deepQueryFirst(opts.withinSelector);
    if (!sub) {
      return {
        title: document.title,
        url: location.href,
        interactive: [],
        notice: 'within_selector did not match any element',
      };
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
    if (!isVisible(el)) return;
    if (inExcludedLandmark(el)) return;
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || tag;
    const selInfo = genSelectorInfo(el);
    const entry = { tag, role, selector: selInfo.selector };
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
  const result = {
    title: document.title,
    url: location.href,
    interactive: interactive.slice(0, opts.maxInteractive),
  };
  if (!opts.onlyInteractive) {
    const headings = [];
    deepQueryAll('h1, h2, h3', root).forEach((h) => {
      if (!isVisible(h)) return;
      if (inExcludedLandmark(h)) return;
      const t = shortText(h);
      if (t) headings.push({ level: h.tagName, text: t });
    });
    result.headings = headings.slice(0, 30);
    const textRoot = (root === document) ? (document.body || document) : root;
    const visibleText = (textRoot && textRoot.innerText) ? textRoot.innerText.slice(0, 4000) : '';
    if (visibleText) result.text = visibleText;
  }
  if (notice) result.notice = notice;
  return result;
})()
`;
}

/** Build the find-by-text expression. Returns one of:
 *   { matched: true, selector, coords:{x,y}, tag, text, frame?, ambiguous? }
 *   { matched: false, reason: 'not-found', error?, near_misses?: [{text,selector,role?}] }
 *   { matched: false, reason: 'multiple-matches', candidates: [{selector,text,tag}] }
 *
 * Role-aware: when `role` is provided, only elements whose explicit ARIA
 * role or implicit role match are considered. When omitted, the search
 * scans a broad set of interactive + clickable elements.
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
export interface FindOpts {
  text: string;
  role?: string;
  exact?: boolean;
}

export function buildFindJs(opts: FindOpts): string {
  const optsJson = JSON.stringify({
    text: opts.text,
    role: typeof opts.role === 'string' && opts.role.length > 0 ? opts.role : null,
    exact: opts.exact === true,
    candidateLimit: 5,
    nearMissLimit: 3,
  });
  return `
(() => {
  ${DEEP_QUERY_JS}
  ${DOM_HELPERS_JS}
  const opts = ${optsJson};
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
    if (!isVisible(el)) continue;
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
        return result;
      }
      const ranked = rankCandidates(broadAll);
      if (ranked.length > 0) result.near_misses = ranked.map(toNearMiss);
      return result;
    }
    const ranked = rankCandidates(all);
    if (ranked.length > 0) result.near_misses = ranked.map(toNearMiss);
    return result;
  }
  if (matches.length > 1) {
    return {
      matched: false,
      reason: 'multiple-matches',
      candidates: matches.slice(0, opts.candidateLimit).map((el) => ({
        selector: genSelector(el),
        text: shortText(el),
        tag: el.tagName.toLowerCase(),
      })),
    };
  }
  const el = matches[0];
  const center = viewportCenterOf(el);
  const selInfo = genSelectorInfo(el);
  const result = {
    matched: true,
    selector: selInfo.selector,
    coords: {
      x: Math.round(center.x),
      y: Math.round(center.y),
    },
    tag: el.tagName.toLowerCase(),
    text: shortText(el),
  };
  if (selInfo.ambiguous) result.ambiguous = true;
  const frame = frameSelectorFor(el);
  if (frame) result.frame = frame;
  return result;
})()
`;
}

/**
 * Build the click-resolution expression: resolves the selector across the
 * deep search scope, scrolls the element (and every ancestor iframe) into
 * view, computes the TOP-LEVEL viewport click point, and — unless `force`
 * is set — hit-tests that point before returning it, so a covering overlay
 * is caught before background.ts dispatches CDP mouse events. Returns:
 *   { ok: true, x, y, tag }
 *   { ok: false, reason: 'invalid-selector', error }
 *   { ok: false, reason: 'not-found' }
 *   { ok: false, reason: 'occluded', blocker }
 *
 * The `invalid-selector` check runs BEFORE `deepQueryFirst` — a malformed
 * CSS selector throws the identical `SyntaxError` from every root's own
 * `querySelector`, which `deepQueryFirst`'s per-root try/catch otherwise
 * swallows into an indistinguishable "not-found". Checking once against
 * `document` up front separates "the selector text is broken" from "the
 * selector is valid but nothing on the page matches it".
 */
export interface ClickResolveOpts {
  selector: string;
  force: boolean;
}

export function buildClickResolveJs(opts: ClickResolveOpts): string {
  const optsJson = JSON.stringify({ selector: opts.selector, force: opts.force });
  return `
(() => {
  ${DEEP_QUERY_JS}
  const opts = ${optsJson};
  try {
    document.querySelector(opts.selector);
  } catch (e) {
    return { ok: false, reason: 'invalid-selector', error: e && e.message ? e.message : String(e) };
  }
  const el = deepQueryFirst(opts.selector);
  if (!el) return { ok: false, reason: 'not-found' };
  const chain = frameElementChain(el);
  for (const fe of chain) {
    if (fe.scrollIntoView) fe.scrollIntoView({ block: 'center', inline: 'center' });
  }
  if (el.scrollIntoView) el.scrollIntoView({ block: 'center', inline: 'center' });
  const center = viewportCenterOf(el);
  const tag = el.tagName.toLowerCase();
  if (!opts.force) {
    const occlusion = checkOcclusion(el, center.localX, center.localY);
    if (!occlusion.allowed) {
      return { ok: false, reason: 'occluded', blocker: occlusion.blocker };
    }
  }
  return { ok: true, x: center.x, y: center.y, tag };
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
 *   { ok: true }
 *   { ok: false, reason: 'invalid-selector', error }
 *   { ok: false, reason: 'not-found' }
 *
 * Same invalid-selector pre-check as `buildClickResolveJs` — see its doc
 * comment for why the check has to run before `deepQueryFirst`.
 */
export interface TypeResolveOpts {
  selector: string;
  clear: boolean;
}

export function buildTypeResolveJs(opts: TypeResolveOpts): string {
  const optsJson = JSON.stringify({ selector: opts.selector });
  return `
(() => {
  ${DEEP_QUERY_JS}
  const opts = ${optsJson};
  try {
    document.querySelector(opts.selector);
  } catch (e) {
    return { ok: false, reason: 'invalid-selector', error: e && e.message ? e.message : String(e) };
  }
  const el = deepQueryFirst(opts.selector);
  if (!el) return { ok: false, reason: 'not-found' };
  el.focus();
  ${opts.clear ? "if ('value' in el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }" : ''}
  return { ok: true };
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
 */
export interface FocusResolveOpts {
  selector: string;
}

export function buildFocusJs(opts: FocusResolveOpts): string {
  const optsJson = JSON.stringify({ selector: opts.selector });
  return `
(() => {
  ${DEEP_QUERY_JS}
  const opts = ${optsJson};
  const el = deepQueryFirst(opts.selector);
  if (!el) return false;
  el.focus();
  return true;
})()`;
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
 */
export function buildStateJs(): string {
  return `
(() => {
  ${DEEP_QUERY_JS}
  ${DOM_HELPERS_JS}
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
    const focused = { selector: selInfo.selector, tag: active.tagName.toLowerCase() };
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

  return result;
})()
`;
}
