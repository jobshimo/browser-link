/**
 * In-page JS source injected into CDP `Runtime.evaluate` expressions built
 * by background.ts. This is the "deep search" layer that lets `snapshot`,
 * `find`, `click` and `type` see past two boundaries plain
 * `document.querySelector` / `document.querySelectorAll` cannot cross:
 *
 *   - OPEN Shadow DOM roots (`element.attachShadow({ mode: 'open' })`),
 *     walked recursively (shadow roots nested inside shadow roots).
 *   - Same-origin `<iframe>` documents, walked recursively (iframes nested
 *     inside iframes, shadow roots nested inside iframes and vice versa).
 *
 * Exported as a raw string, not real TypeScript — it runs inside the
 * TARGET PAGE's JS context via CDP `Runtime.evaluate`, not inside the
 * extension's own service worker. Keep the syntax plain (`var`/`function`,
 * no optional chaining assumptions) since it must run unmodified in
 * whatever JS engine the connected tab uses, and keep it dependency-free so
 * it can be unit-tested by evaluating this exact string in a DOM
 * environment (see `deep-query.test.ts`).
 *
 * Known limitations (also documented on the MCP tool descriptions):
 *   - CLOSED shadow roots (`{ mode: 'closed' }`) are unreachable from page
 *     world JS — `element.shadowRoot` is `null` for them by design. There
 *     is no CDP-level workaround from `Runtime.evaluate`.
 *   - CROSS-ORIGIN iframes are unreachable — `contentDocument` throws or
 *     returns null under the same-origin policy. Access is wrapped in
 *     try/catch so a cross-origin frame is silently skipped rather than
 *     failing the whole query.
 *   - A plain CSS selector cannot distinguish between two elements that
 *     produce byte-identical generated selectors in two different roots
 *     (e.g. two structurally-identical Shadow DOM component instances).
 *     `deepQueryFirst` returns the first match in traversal order
 *     (the start root itself, then nested shadow roots, then nested
 *     same-origin iframe documents, depth-first). Extremely rare in
 *     practice — real content differs — but worth knowing when a page
 *     repeats the exact same component markup in multiple places. When
 *     selector generation cannot avoid this (see `genSelectorInfo` in
 *     `dom-helpers.ts`), snapshot/find mark the affected entry with
 *     `ambiguous: true` so agents know not to cache that selector.
 */
export const DEEP_QUERY_JS = `
  function collectSearchRoots(start) {
    // start: a Document, Element or ShadowRoot to scope the search to.
    // Returns [start, ...every open shadow root and same-origin iframe
    // document reachable inside start's subtree, recursively]. The caller
    // runs .querySelectorAll()/.querySelector() on each entry directly —
    // each entry's own querySelectorAll does NOT pierce into nested shadow
    // roots or iframes on its own, which is why we enumerate them here.
    var roots = [start];
    function walk(scope, depth) {
      // Depth guard, same pattern as the other recursive helpers here:
      // pathological nesting (or a cycle introduced by a broken mock)
      // must degrade to a truncated result, never a stack overflow.
      if (depth > 20) return;
      var all;
      try {
        all = scope.querySelectorAll('*');
      } catch (_) {
        return;
      }
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (el.shadowRoot) {
          roots.push(el.shadowRoot);
          walk(el.shadowRoot, depth + 1);
        }
        if (el.tagName === 'IFRAME') {
          var doc = null;
          try {
            doc = el.contentDocument;
          } catch (_) {
            doc = null;
          }
          if (doc) {
            roots.push(doc);
            walk(doc, depth + 1);
          }
        }
      }
    }
    walk(start, 0);
    return roots;
  }

  function deepWalkAll(callback, start) {
    // Tree-walk primitive: invoke callback(el) for every element reachable
    // from start (default: document) across the top document, every open
    // shadow root, and every same-origin iframe document.
    var root = start || document;
    var roots = collectSearchRoots(root);
    for (var r = 0; r < roots.length; r++) {
      var all;
      try {
        all = roots[r].querySelectorAll('*');
      } catch (_) {
        continue;
      }
      for (var i = 0; i < all.length; i++) callback(all[i]);
    }
  }

  function deepQueryAll(selector, start) {
    var root = start || document;
    var roots = collectSearchRoots(root);
    var out = [];
    for (var r = 0; r < roots.length; r++) {
      var found;
      try {
        found = roots[r].querySelectorAll(selector);
      } catch (_) {
        continue;
      }
      for (var i = 0; i < found.length; i++) out.push(found[i]);
    }
    return out;
  }

  function deepQueryFirst(selector, start) {
    var root = start || document;
    var roots = collectSearchRoots(root);
    for (var r = 0; r < roots.length; r++) {
      var el = null;
      try {
        el = roots[r].querySelector(selector);
      } catch (_) {
        el = null;
      }
      if (el) return el;
    }
    return null;
  }

  function frameElementChain(el) {
    // Walk up from el's own window to the top window, collecting the
    // <iframe> element that hosts each intermediate document. Outermost
    // frame first. Same-origin only — frameElement throws/returns null
    // across an origin boundary, at which point the chain simply stops
    // (the coordinate math below degrades gracefully rather than throwing).
    var chain = [];
    var doc = el.ownerDocument;
    var win = doc && doc.defaultView;
    if (!win) return chain;
    var topWin;
    try {
      topWin = win.top;
    } catch (_) {
      topWin = win;
    }
    var guard = 0;
    while (win && win !== topWin && guard < 20) {
      guard++;
      var fe = null;
      try {
        fe = win.frameElement;
      } catch (_) {
        fe = null;
      }
      if (!fe) break;
      chain.unshift(fe);
      win = fe.ownerDocument && fe.ownerDocument.defaultView;
    }
    return chain;
  }

  function frameViewportOriginOffset(fe) {
    // The embedded document's viewport origin sits at the frame element's
    // CONTENT box, but getBoundingClientRect() returns the BORDER box —
    // border and padding must be added on top of rect.left/rect.top or
    // every coordinate inside a styled iframe lands short. clientLeft/
    // clientTop are the border widths; padding comes from computed style
    // (read through the frame's own view — same-origin, so reachable).
    var borderX = fe.clientLeft || 0;
    var borderY = fe.clientTop || 0;
    var padX = 0;
    var padY = 0;
    try {
      var view = (fe.ownerDocument && fe.ownerDocument.defaultView) || window;
      var style = view.getComputedStyle(fe);
      padX = parseFloat(style.paddingLeft) || 0;
      padY = parseFloat(style.paddingTop) || 0;
    } catch (_) {}
    return { x: borderX + padX, y: borderY + padY };
  }

  function clickRectOf(el) {
    // For a line-wrapped INLINE element (a link spanning two lines), the
    // center of getBoundingClientRect() can land in the unpainted gap
    // between the line boxes — elementFromPoint would report whatever sits
    // behind, and a dispatched click would miss. The first client rect is
    // always a painted fragment, so its center is a safe click point.
    // Block-level elements have exactly one client rect, identical to the
    // bounding rect — no behavior change for them.
    var rects = null;
    try {
      rects = el.getClientRects ? el.getClientRects() : null;
    } catch (_) {
      rects = null;
    }
    if (rects && rects.length > 0) return rects[0];
    return el.getBoundingClientRect();
  }

  function viewportCenterOf(el) {
    // Returns the element's click point in two coordinate spaces:
    //  - localX/localY: relative to el's OWN document viewport (what
    //    that document's elementFromPoint expects).
    //  - x/y: relative to the TOP-LEVEL viewport (what CDP
    //    Input.dispatchMouseEvent expects) — localX/localY plus the
    //    accumulated content-box origin of every ancestor <iframe>
    //    element (border-box rect + border + padding). Shadow DOM
    //    boundaries need no offset: they do not introduce a new
    //    coordinate space.
    // Both spaces derive from the SAME point (first-client-rect center),
    // so the occlusion hit-test and the CDP dispatch always agree.
    var rect = clickRectOf(el);
    var localX = rect.left + rect.width / 2;
    var localY = rect.top + rect.height / 2;
    var chain = frameElementChain(el);
    var offsetX = 0;
    var offsetY = 0;
    for (var i = 0; i < chain.length; i++) {
      var frameRect = chain[i].getBoundingClientRect();
      var origin = frameViewportOriginOffset(chain[i]);
      offsetX += frameRect.left + origin.x;
      offsetY += frameRect.top + origin.y;
    }
    return { x: offsetX + localX, y: offsetY + localY, localX: localX, localY: localY };
  }

  function composedContains(ancestor, node) {
    // Node.contains() does not cross shadow boundaries. This walks the
    // COMPOSED tree: when climbing hits a ShadowRoot (no parentNode), jump
    // to its host and keep climbing.
    var cur = node;
    var guard = 0;
    while (cur && guard < 1000) {
      guard++;
      if (cur === ancestor) return true;
      if (cur.parentNode) {
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

  function describeElement(el) {
    if (!el || !el.tagName) return 'an unknown element';
    var desc = el.tagName.toLowerCase();
    if (el.id) desc += '#' + el.id;
    if (el.classList && el.classList.length) {
      var classes = [];
      for (var i = 0; i < el.classList.length && i < 2; i++) classes.push(el.classList[i]);
      if (classes.length) desc += '.' + classes.join('.');
    }
    return desc;
  }

  function hitTestDeep(root, x, y) {
    var node = null;
    try {
      node = root && root.elementFromPoint ? root.elementFromPoint(x, y) : null;
    } catch (_) {
      node = null;
    }
    // The hit element may itself host a nested open shadow root whose
    // content visually covers the point — descend until elementFromPoint
    // stops finding a deeper shadow tree.
    var guard = 0;
    while (node && node.shadowRoot && guard < 20) {
      guard++;
      var inner = null;
      try {
        inner = node.shadowRoot.elementFromPoint ? node.shadowRoot.elementFromPoint(x, y) : null;
      } catch (_) {
        inner = null;
      }
      if (!inner || inner === node) break;
      node = inner;
    }
    return node;
  }

  function checkOcclusion(target, localX, localY) {
    // Hit-test starting from the element's OWN root (its closest shadow
    // root, or the document that owns it when not in shadow DOM) using
    // LOCAL coordinates — the same coordinate space that root's own
    // elementFromPoint expects (an iframe document's viewport starts at
    // its own top-left, not the top-level page's).
    var root = target.getRootNode ? target.getRootNode() : document;
    var hit = hitTestDeep(root, localX, localY);
    if (!hit) {
      // Nothing hit-tested at all (e.g. elementFromPoint unsupported in
      // this environment, or the point is outside the rendered area).
      // Fail open rather than block a click we cannot actually verify.
      return { allowed: true };
    }
    if (hit === target || composedContains(target, hit) || composedContains(hit, target)) {
      return { allowed: true };
    }
    return { allowed: false, blocker: describeElement(hit) };
  }
`;
