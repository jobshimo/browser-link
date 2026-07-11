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
 *   { matched: false, reason: 'not-found' }
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
  });
  return `
(() => {
  ${DEEP_QUERY_JS}
  ${DOM_HELPERS_JS}
  const opts = ${optsJson};
  const needle = opts.text.toLowerCase();
  const ROLE_SELECTORS = {
    button: 'button, [role="button"], input[type="button"], input[type="submit"], input[type="reset"]',
    link: 'a[href], [role="link"]',
    textbox: 'input[type="text"], input[type="email"], input[type="password"], input[type="search"], input[type="url"], input[type="tel"], input:not([type]), textarea, [role="textbox"], [contenteditable="true"]',
    checkbox: 'input[type="checkbox"], [role="checkbox"]',
    tab: '[role="tab"]',
    menuitem: '[role="menuitem"]',
  };
  const selectorSet = opts.role && ROLE_SELECTORS[opts.role]
    ? ROLE_SELECTORS[opts.role]
    : 'button, a, input, textarea, select, [role], [onclick], [contenteditable="true"], [tabindex]';
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
    return { matched: false, reason: 'not-found' };
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
 *   { ok: false, reason: 'not-found' }
 *   { ok: false, reason: 'occluded', blocker }
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
 * shadow root, or a same-origin iframe).
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
  const el = deepQueryFirst(opts.selector);
  if (!el) return false;
  el.focus();
  ${opts.clear ? "if ('value' in el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }" : ''}
  return true;
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
