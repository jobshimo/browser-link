# Spec v4 — browser-link 1.0 foundation: the page observer, in measured slices

> ## ✅ CURRENT
>
> **Supersedes [`v3-bl-1.0-live-model-and-resolver.md`](./v3-bl-1.0-live-model-and-resolver.md).**
> Written 2026-11-06, after a diagnosis of the current perception code and a six-experiment lab session (`../lab/2026-11-06-live-page-model/`). v3's 1.0 claim (§2) and its critique of v2 are **kept**; v4 settles *where* the live page model runs and *how it is fed*, with numbers instead of a lean, removes the ML resolver from the 1.0 scope, and replaces the single 1.0 bundle with three slices that each ship on their own. §1 records what changed and why.

**Status:** CURRENT, shipped in 0.35.0–0.37.0 (S1–S3) · **Written:** 2026-11-06 · **Origin:** design conversation (owner decision: foundation first, in shippable slices), code diagnosis against `main` at `25082a0`, lab evidence in `../lab/2026-11-06-live-page-model/`.

---

## 1. What changed from v3, and why

| v3 said | v4 says | Why it changed |
|---|---|---|
| The live page model "belongs to the bridge" and is kept up to date "from `MutationObserver`" (§3) | It is a **page observer**: code that runs inside every document of a connected tab, owns one observer per root, and pushes **coalesced summaries** to the host. The host (extension worker, or the server on cdp-direct) keeps a mirror; it does not observe | `MutationObserver` only exists in the page. browser-link has **no content script**: every page-side helper is a string evaluated through CDP (§3.1). The lab ruled out the one host-side alternative, CDP `DOM.*` events (§4.1) |
| 1.0 = live model + plans with signals + resolver port, together (§5) | Three slices, each a release that improves tools that already exist: **S1 exact `settle`**, **S2 `snapshot` as a diff**, **S3 stable element identity**. Plans and signals come after, in their own spec, on top of the observer | Owner decision. A signal is only as good as its evidence, and today's evidence is a mutation count that is `0` for a click that visibly changed the page (§4.4). A foundation that ships in slices cannot become the major that never lands |
| A resolver port with a rules adapter and an optional ML adapter, with its download command, checksum, Ollama detection and candidate model (§4, §4.1) | **Removed from the 1.0 scope.** Nothing in this document depends on it | Designing the plug before measuring the socket. The agent on the other side of the channel already *is* the model; structural decisions resolve once and cache as schema. If "could not decide" ever gets recorded (plans spec), that record decides whether this returns |
| cdp-direct left implicit | **First-class.** The observer is the same code on both transports: `chrome.debugger` in the extension, raw CDP on cdp-direct. Lab 3 ran the observer over raw CDP; the lab extension ran it through `chrome.debugger` | The server already carries byte-identical copies of the in-page builders with drift tests (§3.1). The observer follows the same rule |
| MV3 worker termination "drops the model" and needs a cheap rebuild (v2 §5.3, v3 §3) | The model lives in the page, not in the worker. An active `chrome.debugger` session keeps the MV3 worker alive (Chrome 118+). The host mirror is a cache that any `summary` request can rebuild | Documented by Chrome and consistent with the lab. The remaining real death is the **document**: navigation, reload. The observer re-installs itself on every new document |
| "Identity across re-renders is the hard problem" and must be semantic (role + name + position) | Primary identity is **the DOM node** (a ref held in a `WeakMap`, Playwright-style). Semantic identity is the **fallback** for nodes that were recreated, and it must include structural position | In a Lit app, 88 of 88 interactive nodes were the same nodes after an SPA round trip; role + accessible text alone produced 37 keys for 88 elements (§4.6) |

**Unchanged and load-bearing:** v3 §2 (the 1.0 claim and the market framing), v3 §2.1 (what 0.29–0.34 contributed), v2 §2–§4 and §6–§7 (thesis, signals and restarts, latitude, lifecycle, learning aimed at execution), and everything v2 inherited from v1. Those sections describe the layer that will be built **on** this one; this document does not touch them.

---

## 2. Scope of this document

**Terminology.** The **page observer** is an *injected script* in the sense Playwright and Puppeteer use the term: JavaScript that browser-link runs inside the page. In this document the word **agent** always means the AI agent that drives browser-link, never the injected script.

v4 specifies the **foundation**: perception that is continuous, exact, cheap, and has identity. It is the part of 1.0 that every later piece (signals, plans, schema) stands on, and it ships as improvements to `settle`, `snapshot`, `find`, `click`, `type` and `list_tabs` while the current agent-facing API keeps working. Release numbering is the owner's call; the proposal is in §8.

Out of scope here, deliberately: the plan language, signals and restarts (v2 §3–§4), the app schema (v2 §5.2), any ML component, and cross-origin iframes (§7).

---

## 3. Diagnosis: how browser-link perceives the page today

Verified against `main` at `25082a0`. Paths are repository-relative; the server copies under `packages/server/src/cdp/` are byte-identical to the extension originals and guarded by `drift.test.ts` and `builders-parity.test.ts`.

### 3.1 Where page code runs

- There is **no content script** and no `chrome.scripting` permission (`packages/extension/manifest.json`). Every page-side helper is a JS string sent through `chrome.debugger` → `Runtime.evaluate` with `returnByValue`, `awaitPromise`, `userGesture` (`packages/extension/src/background.ts` `evaluateInTab`, ~1196). cdp-direct evaluates the same strings over its own CDP client (`packages/server/src/cdp/transport.ts`).
- The debugger is attached **per connected tab for the whole connection**, not per action, and enables `Page`, `Runtime`, `Log`, `Network` and `DOM` on connect (`background.ts` ~3067–3071). One `chrome.debugger.onEvent` listener consumes console, network, dialog and `Runtime.bindingCalled` events. **`DOM.enable` is called and no `DOM.*` event is consumed.** No `Page.frameNavigated` subscription exists.
- The server's `TabSession` stores `url` and `title` **at registration only** (`packages/server/src/bridge/ws-bridge.ts` 193/211/218); `list_tabs` reports them unchanged for the life of the connection.

### 3.2 What `settle` sees

- One `MutationObserver` **per call**, on `document` only (`subtree`, `childList`, `attributes`, `characterData`), installed **after** the three `Input.dispatchMouseEvent` calls (`background.ts` ~1306–1325), with URL and focus baselines taken at install time (`packages/extension/src/inpage/builders.ts` `buildSettleJs`). Returns `{settled, duration_ms, mutation_count, url_changed?, focus_moved?}` and nothing about *what* changed. Default quiet window 150 ms (cap 2000), timeout 2000 ms (cap 10000). The install gap is acknowledged in the builder's own doc comment.
- `expect` is polling only (100 ms), with a baseline taken **before** dispatch; it compares end state with baseline and cannot see a condition that appeared and went (`packages/extension/src/expect.ts`).
- `wait_for` by selector uses plain `document.querySelector`, so it ignores shadow roots and iframes that `find` and `click` do traverse (`background.ts` `performWaitFor`). A parity bug, independent of this design.

### 3.3 What identity is

- An element's only identity is its generated CSS selector: `#id` → `[data-testid]` → `tag[aria-label]` → `tag[name]` → short `nth-of-type` path (6 levels) → fully qualified path (32 levels), each verified unique across roots with `deepQueryAll`; `ambiguous: true` when twins exist in other roots (`packages/extension/src/inpage/dom-helpers.ts` `genSelectorInfo`). Without attributes, identity is structure, and a reorder breaks it.
- **Nothing persists between calls**: no `WeakMap`, no stamped ids, no module state in `inpage/`. `snapshot`, `find`, `state` re-walk the DOM on every call. The map's `entries` table is keyed by `(app, url_pattern, kind, purpose)` with a free-form JSON payload; nothing semantic.

### 3.4 Diagnosis in one sentence

Perception is **stateless by design**, not by neglect; what is missing is not a better observer but **a place for the model to live between calls** that survives what actually kills page state, which is the document, not the worker.

---

## 4. Lab evidence

Six experiments, raw CDP from Node against a throwaway Chrome 156 profile, plus one MV3 lab extension. Scripts, pages and unedited results are in `../lab/2026-11-06-live-page-model/` (README there maps each number to its file). Targets: **Home Assistant** (Lit; 3,723 nodes, 403 open shadow roots), **timeanddate.com world clock** (two same-origin iframes), and a controlled **storm page** (200 text nodes and 20 attributes mutating every animation frame inside 20 open shadow roots, ~144 fps on this machine).

### 4.1 CDP `DOM.*` events are not a viable feed

| Measurement | Result |
|---|---|
| Full tree, `DOM.getDocument({depth:-1, pierce:true})` on Home Assistant | 27 ms, 746 KB, 3,723 nodes, 403 shadow roots. Cheap enough for a **resync** |
| Events inside an existing shadow root (depth 11) | `attributeModified`, `childNodeInserted/Removed`, `characterDataModified` all arrive |
| New shadow root, open or closed | `DOM.shadowRootPushed` fires for both, with `shadowRootType` |
| Mutations inside a **newly pushed** root | **Zero events**, only `childNodeCountUpdated` on the parent. The protocol only reports nodes the client has already requested; every insertion needs a follow-up `requestChildNodes`, with a blind window per round trip |
| Storm, 10 s | **261,209 events, 22.2 MB** (2.2 MB/s, ~23,700 msgs/s, bursts of 3,105 per 100 ms), one message per mutation, no coalescing except `inlineStyleInvalidated`; ~18% behind the in-page count at the end |
| Hard reload | `documentUpdated` fires; events stop until a new `getDocument` |
| SPA navigation (`pushState`) | no `documentUpdated` |

Conclusion: the DOM domain is kept for **resync** (`getDocument`, `DOMSnapshot.captureSnapshot`) and **node handles** (`resolveNode`, `requestNode`) if ever needed, never as the event feed.

### 4.2 An observer on `document` is not enough

Storm page: an observer on `document` alone saw **28,820 of 317,020** records (9%), all host attributes. One `observe()` per shadow root saw 100%. Mutation records are delivered to observers on the root's own tree; shadow roots and iframe documents each need their own observer.

### 4.3 The persistent, coalescing observer works, on both transports

Observer installed with `Page.addScriptToEvaluateOnNewDocument({source, runImmediately: true})`, patching `Element.prototype.attachShadow` to observe every root at creation, pushing one summary per flush through `Runtime.addBinding`:

| Measurement | Result |
|---|---|
| Storm, 10 s, wire cost | **720 messages, 243 KB** (24 KB/s, 72 msgs/s) for the same load that cost CDP events 2.2 MB/s and 23,700 msgs/s; **317,240 records counted, none lost** |
| Hard reload | observer back by itself on the new document, 21 roots (document + 20 shadow roots caught by the patch), summaries flowing |
| Closed shadow root created by page code | observed (`closedRoots: 1`), its mutations pushed |
| Same-origin iframes (world clock) | the observer ran in each frame; `about:blank` frame documents pushed their own summaries through the same binding |
| Through `chrome.debugger` in an MV3 extension | `attach` → `Runtime.addBinding` → `Page.addScriptToEvaluateOnNewDocument` → reload → `Runtime.bindingCalled` received in `chrome.debugger.onEvent`; closed root observed |
| Observer self-cost under the storm (main world, 5 s, ~32k records/s) | **~5 ms per second** of main-thread time (~0.5%) |

Gotchas paid in the lab, not in production:

- Coalescing with `requestAnimationFrame` **never flushes in a hidden tab** (1,929 records, 0 flushes). The observer uses `setTimeout`; hidden tabs throttle it to ~1 s, which is acceptable.
- A guard of the form "if the observer exists, return" keeps a **stale observer** alive in the same document. The observer must carry a version and replace an older instance.
- A tab has **one debugger**: a raw CDP session and the extension cannot share it ("Another debugger is already attached"). DevTools opening on the tab detaches the extension, as today.
- `chrome.debugger` refuses `chrome://` tabs, as today.

### 4.4 The current `settle` is wrong in the way v1 documented

`settle.html`: a button whose click changes a text node **synchronously**, appends a list item at **+300 ms**, and sets an attribute at **+900 ms**.

| | `settled` | `mutation_count` | saw sync effect | saw +300 | saw +900 |
|---|---|---|---|---|---|
| Current semantics (observer after dispatch, quiet 150 ms) | `true` after 164 ms | **0** | no | no | no |
| Observer with an action mark | — | — | `childList div#out` at +2.2 ms | `childList ul#list` at +307 ms | `attributes data-done` at +909 ms |

The current result is a confident statement that nothing happened, about a click that did three things. A quiet window cannot see late effects by definition; what it *can* do is report exactly what happened inside it and leave waiting for specific conditions to `expect` and `wait_for`.

### 4.5 Main world, not an isolated world

The same observer in an isolated world (`worldName` + `Runtime.addBinding({executionContextName})`, both work) saw **1 root and 9% of the records**: its `attachShadow` patch cannot see the page's calls, and at document start there are no roots to walk yet. It did not see a closed root the page created later. The observer must run in the **main world**. The cost is that the patch is visible to page code (§7).

### 4.6 Identity in a Lit app

Home Assistant, 88 interactive elements tagged with a `WeakMap` id on the overview; navigate to the configuration dashboard (71 elements: 39 the same nodes, 32 new); `history.back()`: **88 of 88 the same DOM nodes**. A semantic key of role + accessible text produced **37 distinct keys for 88 elements**.

Conclusion: node identity is strong and cheap and should be primary; semantic identity is a fallback and must include structural position to be unique.

---

## 5. Design: the page observer

### 5.1 Placement and lifecycle

- **Install on connect**, both transports: `Runtime.addBinding({name: <push binding>})`, then `Page.addScriptToEvaluateOnNewDocument({source: <observer>, runImmediately: true})`. The script runs in every document the tab creates from then on, in every same-process frame, before page scripts. On cdp-direct the server does exactly the same over its CDP client.
- **Main world** (§4.5). The observer is a single IIFE string, built like the existing builders and shared byte-for-byte between extension and server under the existing drift tests.
- **Versioned instance.** The observer publishes `{version}` on a single well-known global. A newer observer replaces an older one (disconnecting its observers); an equal or newer one is left alone. Never "if present, return" (§4.3).
- **Uninstall on disconnect**: `Page.removeScriptToEvaluateOnNewDocument` and an in-page teardown message. Documents already carrying the observer keep it until they go away; it is inert without a binding to call.
- **Deaths and rebirths.** A full navigation or reload creates a new document; the observer is re-run by Chrome and announces `doc_start` with a fresh `doc_id`. SPA navigation keeps the document; the observer reports `nav` (see §5.4). MV3 worker termination does not touch the page; the worker's mirror is a cache (§5.5).

### 5.2 Observation

- One `MutationObserver` per root, `subtree + childList + attributes + characterData`, `attributeOldValue` and `characterDataOldValue` off (summaries do not carry values).
- Roots: the document; every shadow root that exists at install (walk via `el.shadowRoot`); every shadow root created afterwards, open or closed, via the `attachShadow` patch; same-origin iframe documents through their own observer instance (Chrome runs the script there). Cross-origin iframes are separate targets and out of scope (§7).
- Where the patch is impossible (frozen prototypes, a page that replaced `attachShadow` first), the observer falls back to a periodic rescan for open roots and reports `coverage: partial`. The host may additionally use `DOM.shadowRootPushed` to learn about closed roots and hand them to the observer via `DOM.resolveNode` + `Runtime.callFunctionOn`; this is an optimisation to measure, not a 1.0 requirement.

### 5.3 Coalescing and budget

- Records are folded per flush into **one entry per target element** (`characterData` attributed to the text node's parent) with counts per kind. A flush is scheduled with `setTimeout(16)` on the first record after a quiet state; never `requestAnimationFrame` (§4.3).
- Each summary carries: `doc_id`, `seq`, `t0`/`t1` (performance clock), `records`, `targets`, per-kind counts, the **roots touched**, and up to `N` target descriptors (tag, id, role, ref if one exists, root path) ordered by record count, with an `overflow` count beyond `N`. `N` is small (tens) and configurable by the host.
- The observer keeps a bounded **ring of recent summaries** so the host can ask for "everything since `seq`" after a reconnect or worker restart (§5.5), and so an action window can be read back exactly (§6.1).
- Measured ceiling under the storm: 24 KB/s, 72 msgs/s, ~5 ms/s of main thread. A real app idle is zero. The hard budget is the per-summary descriptor cap, not a rate limiter.

### 5.4 Navigation and document identity

- The observer reports `doc_start {doc_id, url}` when it runs, and `nav {url}` on `pushState`/`replaceState`/`popstate`/`hashchange` (patched or listened). The host updates `TabSession.url` and `title`, which fixes `list_tabs` reporting registration-time values (§3.1).
- `doc_id` is the boundary of every ref (§5.6), as in Playwright: refs do not cross a document swap; results that carry refs also carry the `doc_id` they belong to.

### 5.5 Host mirror

- Per tab: current `doc_id`, last `seq`, the recent summaries, the current URL. On the extension this lives in the worker's `TabState`; on cdp-direct in the transport's connection cache.
- Rebuild: on worker start, or on reconnect, the host requests `summary_since(seq)` or simply `snapshot_state`; it never reconstructs the DOM itself. The mirror is a cache; the page is the truth.

### 5.6 Element identity

- **Primary — node identity.** The observer holds a `WeakMap<Element, ref>`; a ref (`e<N>`, monotonic per document) is issued the first time an element is emitted (snapshot, find, state) and reused while the node lives (§4.6: 100% hit rate on an SPA round trip in Lit). A ref resolves in O(1) to the live node, with no selector at all. Refs are **valid for the `doc_id` that issued them**.
- **Secondary — semantic identity.** For an element whose node is gone, a key of role + accessible name + **path of ancestor roles/tags with sibling index** (role + name alone collides, §4.6). The exact algorithm and weights are decided in S3 with data from S1/S2 recordings; candidates are the Playwright role/name reuse rule and a Similo-style weighted match. The persistent map stores this key alongside the selector it stores today, so a stored entry survives attribute churn that breaks `nth-of-type`.
- Selectors stay. They remain the portable, human-readable form and the only thing a stored flow can hold today. A ref is the fast handle for *this* document; a selector or semantic key is how you find the element again tomorrow.

### 5.7 What the CDP DOM domain is still for

`DOM.getDocument(pierce)` or `DOMSnapshot.captureSnapshot` for a full resync when the host suspects drift (both flatten shadow DOM and cover iframes, with `backendNodeId`); `DOM.resolveNode`/`DOM.requestNode` only if a feature needs to bridge a ref to a CDP node id. **Not** the event feed (§4.1).

---

## 6. Slices

Each slice is a release that improves tools agents already call, keeps every existing field and default, and is useful without the slices after it. Tests follow the project's rule: one RED test per rule, one test per touched existing behaviour proving it still holds, through the public interface, with the builder-parity and drift tests extended to the observer source.

### 6.1 S1 — exact `settle` (and the observer itself)

**Behaviour.** The observer is installed on connect (§5.1). `click`/`type`/`press` take an **action mark** before dispatch; `settle` then waits for its quiet window as today and returns, in addition to today's fields, `changes`: records and targets **since the mark**, roots touched, and the top target descriptors. `url_changed` and `focus_moved` are baselined **at the mark**, before the action, not at observer install. `mutation_count` keeps its meaning but is now computed from the observer's records in the window, so a click that mutates synchronously no longer reports `0` (§4.4).

**Also in S1:** `doc_start`/`nav` reporting and the `TabSession.url`/`title` update (§5.4); `wait_for` by selector moves to the deep query like `find` and `click` (§3.2, a parity fix that rides along because the same code is touched).

**Not in S1:** refs in results, diffs, any new tool. `expect` is unchanged; a follow-up may let it consume observer records to see transient conditions.

**Acceptance.** `settle.html` from the lab, driven through `browser.click`: `changes.records ≥ 1` and the sync target reported; current fields unchanged for a page with no effect; a page with a `requestAnimationFrame` ticker in a hidden tab still reports; reload re-installs the observer (a `settle` after reload reports changes); same result shape on cdp-direct.

**Risk line.** Item 3 (shared code: `settle` result consumed by every action tool and by `flow`; additive fields only). Item 4 (ordering between mark, dispatch and flush; covered by the `settle.html` test).

### 6.2 S2 — `snapshot` as a diff

**Behaviour.** Interactive entries in `snapshot`, `find` and `state` carry `ref` (§5.6) and the result carries `doc_id` and `snapshot_id`. `snapshot({since: <snapshot_id>})` returns `added`, `removed`, `changed` refs with their entries, plus the same `headings`/`text` handling as today only if requested. Without `since`, output is unchanged except for the new fields. `max_interactive` truncation is applied **after** diffing so a window shift does not masquerade as change.

**Acceptance.** Two snapshots of an idle page diff to empty; a snapshot after a list insertion reports exactly the inserted entries; after a full navigation `since` is rejected with a clear `doc_id` mismatch and a full snapshot is returned.

**Risk line.** Item 3 (new fields on a result every agent reads; names chosen to be ignorable). None of items 1, 2, 4, 5.

### 6.3 S3 — stable identity as a target

**Behaviour.** `click`, `type`, `press`, `find`, `wait_for` accept `ref` as an alternative to `selector`. A ref resolves through the `WeakMap`; if the node is gone, the observer re-resolves by semantic key within the same document and reports `reresolved: true`; if that fails, a clear `ref-stale` error names the `doc_id`. The persistent map stores the semantic key next to the selector and prefers it when the selector is a structural fallback.

**Acceptance.** A Lit list re-rendered with the same items keeps refs valid; a re-render that replaces nodes re-resolves by key; a changed name invalidates the ref; `ambiguous: true` entries never get a stored key.

**Risk line.** Item 1 (the map's `entries.payload` gains a field; additive, no migration of existing rows). Item 3 (new optional parameter on action tools).

---

## 7. Costs and risks, honestly

- **Main-world patching is visible to page code.** A page can detect `attachShadow` being wrapped. browser-link already runs its helpers in the main world and is a local, single-user tool; this is accepted, and §5.2 gives the degraded path when patching is impossible.
- **CSP.** Scripts injected through CDP are expected to bypass page CSP; **not measured in this lab** and must be checked in S1 on a strict-CSP page.
- **Two documents in flight.** During navigation the old document's observer may still flush; summaries carry `doc_id`, the host attributes by it.
- **Cross-origin iframes** are out-of-process targets without the observer; `find`/`click` cannot reach them today either. A later slice may use `Target.setAutoAttach`.
- **Memory under storms** is bounded by the per-flush map (cleared every 16 ms) and the summary ring; the lab saw no growth, but S1 adds a soak test.
- **One debugger per tab** remains the rule; nothing here changes the detach behaviour when DevTools opens.

---

## 8. Release order (proposed, pending owner decision)

1. **S1** exact `settle` + observer + navigation reporting + `wait_for` parity — one release.
2. **S2** `snapshot` diff and refs in results — one release.
3. **S3** refs as targets, semantic re-resolution, map key — one release.
4. Then the signals and plans spec (v5), built on an observer that can say exactly what an action caused.

Whether the version that lands S3 is called 1.0, or 1.0 waits for plans, is the owner's decision; this document does not need it answered.

---

## 9. Open questions

- **[open]** Summary descriptor cap `N` and whether the host can raise it per call.
- **[open]** Semantic key algorithm and weights (decide in S3 with S1/S2 recordings).
- **[open]** Should `expect` consume observer records to detect transient conditions (a follow-up to S1)?
- **[open]** CSP behaviour of `Page.addScriptToEvaluateOnNewDocument` on strict pages (verify in S1).
- **[open]** Whether `DOM.shadowRootPushed` + `callFunctionOn` is worth adding as the closed-root fallback when the patch is unavailable.
- **[open]** Everything in v2 §8 that concerns plans, unchanged and deferred to v5.
