/**
 * Shared in-page DOM helpers, injected verbatim into any JS template that
 * needs them (`buildSnapshotJs`, `buildFindJs`). Defining them once here
 * keeps the heuristics (visibility, selector generation, accessible text)
 * identical across tools so a selector returned by `snapshot` and a selector
 * returned by `find` follow the same rules.
 *
 * `genSelectorInfo` calls `deepQueryAll` to verify a candidate selector is
 * unique across the FULL deep search scope (top document + every open
 * shadow root + every same-origin iframe), not just `document`. That is a
 * runtime dependency, not an import-time one — these are plain string
 * templates concatenated at the CDP-expression build site, not real ES
 * modules. Always interpolate `DEEP_QUERY_JS` (from `./deep-query.js`)
 * BEFORE this constant in any expression that calls `genSelectorInfo`.
 *
 * When even a fully-qualified structural path stays ambiguous (two
 * structurally-identical twins in different roots — no CSS syntax can
 * scope to one root), `genSelectorInfo` returns `ambiguous: true` and the
 * snapshot/find builders surface it on the affected entry so agents know
 * that selector resolves first-match-wins and must not be cached.
 */
export const DOM_HELPERS_JS = `
  function isVisible(el) {
    if (!(el instanceof HTMLElement)) return true;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    if (el.offsetParent === null && style.position !== 'fixed') return false;
    return true;
  }
  function shortText(el) {
    const t = (el.innerText || el.textContent || '').trim();
    return t.length > 120 ? t.slice(0, 120) + '...' : t;
  }
  function safeCss(s) {
    return s.replace(/"/g, '\\\\"');
  }
  function genSelectorInfo(el) {
    // Uniqueness is verified with deepQueryAll — an id/testid/aria-label/
    // name that is unique in the top document can still collide with an
    // identically-attributed element inside a shadow root or same-origin
    // iframe, since each root has its own independent attribute namespace.
    if (el.id && !/^[\\d]/.test(el.id) && !/\\s/.test(el.id)) {
      try {
        const candidate = '#' + CSS.escape(el.id);
        if (deepQueryAll(candidate).length === 1) return { selector: candidate, ambiguous: false };
      } catch (_) {}
    }
    const tid = el.getAttribute('data-testid');
    if (tid) {
      const candidate = '[data-testid="' + safeCss(tid) + '"]';
      if (deepQueryAll(candidate).length === 1) return { selector: candidate, ambiguous: false };
    }
    const al = el.getAttribute('aria-label');
    if (al && al.length < 60) {
      const candidate = el.tagName.toLowerCase() + '[aria-label="' + safeCss(al) + '"]';
      if (deepQueryAll(candidate).length === 1) return { selector: candidate, ambiguous: false };
    }
    const name = el.getAttribute('name');
    if (name && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA')) {
      const candidate = el.tagName.toLowerCase() + '[name="' + safeCss(name) + '"]';
      if (deepQueryAll(candidate).length === 1) return { selector: candidate, ambiguous: false };
    }
    // Structural fallback, verified like every shortcut above. The short
    // form (6 parts, indexed only where siblings force it) is preferred
    // for stability; when it matches more than one element across roots,
    // retry with a fully-qualified path (every level :nth-of-type-indexed,
    // climbed all the way to the root boundary).
    const structural = buildStructuralSelector(el, 6, false);
    try {
      if (deepQueryAll(structural).length === 1) return { selector: structural, ambiguous: false };
    } catch (_) {}
    const qualified = buildStructuralSelector(el, 32, true);
    try {
      if (deepQueryAll(qualified).length === 1) return { selector: qualified, ambiguous: false };
    } catch (_) {}
    // Still ambiguous: structurally-identical twins in different roots.
    // No CSS syntax can scope a selector to one shadow root / iframe, so
    // return the most qualified path and flag it — deepQueryFirst will
    // resolve it first-match-wins (deterministic traversal order), and
    // the flag tells agents not to cache it.
    return { selector: qualified, ambiguous: true };
  }
  function genSelector(el) {
    return genSelectorInfo(el).selector;
  }
  function buildStructuralSelector(el, maxParts, alwaysIndex) {
    // Local-root-scoped structural path: CLIMBING stops at a shadow root or
    // document boundary (parentElement is null for a shadow root's direct
    // children) — matches how deepQueryAll scopes each root's own
    // querySelectorAll call, so the path resolves back to the same element
    // when re-queried through deepQueryFirst. Sibling lookup for the
    // :nth-of-type qualifier uses parentNode rather than parentElement so a
    // shadow root's own top-level children (parentNode = the ShadowRoot,
    // which still exposes .children) get disambiguated too, even though we
    // do not climb past that boundary. With alwaysIndex, every level gets
    // an explicit :nth-of-type — maximum qualification for the retry pass.
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.body && parts.length < maxParts) {
      let part = cur.tagName.toLowerCase();
      const parentNode = cur.parentNode;
      if (parentNode && parentNode.children) {
        const sib = Array.from(parentNode.children).filter(s => s.tagName === cur.tagName);
        if (sib.length > 1 || alwaysIndex) {
          part += ':nth-of-type(' + (sib.indexOf(cur) + 1) + ')';
        }
      }
      parts.unshift(part);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }
  function accessibleText(el) {
    const aria = el.getAttribute && el.getAttribute('aria-label');
    if (aria) return aria;
    const txt = (el.innerText || el.textContent || '').trim();
    if (txt) return txt;
    if ('value' in el && el.value) return String(el.value);
    const ph = el.getAttribute && el.getAttribute('placeholder');
    if (ph) return ph;
    const title = el.getAttribute && el.getAttribute('title');
    if (title) return title;
    return '';
  }
  function frameSelectorFor(el) {
    // Lightweight context field for snapshot/find entries: the selector of
    // the innermost same-origin <iframe> hosting el, or null when el lives
    // in the top document. Computed via genSelector so it benefits from the
    // same deep-uniqueness verification.
    if (el.ownerDocument === document) return null;
    const win = el.ownerDocument && el.ownerDocument.defaultView;
    let fe = null;
    try {
      fe = win && win.frameElement;
    } catch (_) {
      fe = null;
    }
    if (!fe) return null;
    return genSelector(fe);
  }
`;
