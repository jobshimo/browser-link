# Changelog

## [0.16.0](https://github.com/jobshimo/browser-link/compare/v0.15.0...v0.16.0) (2026-07-11)


### Features

* **bridge:** new `browser.press` tool — dispatches a single trusted key press (optionally with modifiers) via CDP `Input.dispatchKeyEvent`, producing real `isTrusted: true` keyboard events. Until now, the only way to send Enter/Escape/Tab/arrow keys was a synthetic `KeyboardEvent` through `browser.evaluate` — this repo's own v0.14.0 CHANGELOG already documents, empirically, that Qt-WASM discards synthetic input, and the same is true of many rich text editors and autocomplete widgets that check `event.isTrusted` before acting. `key` accepts a human name (`Enter`, `Escape`, `Tab`, `Backspace`, `Delete`, `ArrowUp`/`ArrowDown`/`ArrowLeft`/`ArrowRight`, `Home`, `End`, `PageUp`, `PageDown`, `Space` — case-insensitive) or a single printable character (case-sensitive, `"a"` vs `"A"`, plus common punctuation and shifted digit-row symbols). `modifiers` is an array of `Alt`/`Control`/`Meta`/`Shift`, encoded as the CDP bitmask, for shortcuts like Ctrl+A or Cmd+S. An optional `selector` focuses an element first through the same deep Shadow DOM / iframe search `click`/`type`/`find` already use; omitted, the key goes to whatever currently has focus. Implementation dispatches a `keyDown`-or-`rawKeyDown` / `char` / `keyUp` sequence — `rawKeyDown` only when the key produces no text (control/navigation keys), keeping the `char` event as the single source of actual text insertion so nothing double-types. `Enter` carries text `\r` (matching Puppeteer's `USKeyboardLayout`), so its `char` event produces the KEYPRESS whose default action drives the WHATWG implicit form submission — pressing Enter in a form field actually submits the form. Shift is auto-added for characters that require it on a US layout (uppercase letters, shifted punctuation like `@`), so `key:"A"` types an uppercase A without an explicit modifier. Action tool: participates in the tab-claim layer exactly like `browser.click`/`browser.type`.
* **bridge:** `browser.click`, `browser.type` and `browser.press` accept an optional `settle_ms` (default 150, max 2000; `0` disables) and `settle_timeout_ms` (default 2000, max 10000). After dispatching, the extension installs one `MutationObserver` on `document` (subtree, childList, attributes, characterData) and waits until no mutation lands for `settle_ms` consecutive milliseconds, capped at `settle_timeout_ms`. The result gains a compact `settle` object — `{ settled, duration_ms, mutation_count, url_changed?, focus_moved? }` — with `url_changed`/`focus_moved` present only when they actually changed during the wait. This folds the wait_for + snapshot round trip most flows need after an action directly into the action call: a click that triggers an async re-render no longer needs a separate `browser.wait_for` just to know the page settled. Purely additive — existing result fields are unchanged, and `settle_ms:0` reproduces the pre-v0.16.0 behavior exactly (no extra round trip, no `settle` key in the result). The occlusion guard on `browser.click` is untouched — settle only runs after a successful dispatch. The settle wait is failure-isolated from the action: when the action itself triggers a full-document navigation, the execution context the settle expression runs in is destroyed mid-wait — the action result stays `ok:true` (it DID land) and `settle` degrades to `{ settled: false, reason: "context-destroyed" }` instead of the whole call flipping to an error that would bait a duplicate retry. Honest limitation, documented on the tools: settle proves QUIET, not EFFECT — mutations completing before the observer installs (right after dispatch) and async reactions starting after the quiet window are both invisible, so `mutation_count: 0` with `settled: true` does not prove the action had no effect; `browser.wait_for` remains the tool for a specific expected condition.

### Internal

* `BROWSER_TOOL_NAMES` closed union grew from 22 to 23 entries (`browser.press`). `TOOL_CATALOGUE` grew from 28 to 29 entries (action tool — excluded from the `readonly` preset, same bucket as `browser.click`/`browser.type`). The hardcoded count assertion in `permissions.test.ts` was bumped 28 → 29 as the canary.
* `packages/extension/src/keymap.ts` — a new, `inpage/`-independent module (runs in the extension's own service-worker context, not injected into the page) mapping a human key name to CDP `Input.dispatchKeyEvent` parameters. Modeled after Puppeteer's `USKeyboardLayout`, trimmed to the keys `browser.press` exposes plus a generic printable-character resolver (letters, digits, common punctuation, and their Shift-produced variants). Unit-tested on its own.
* `packages/extension/src/inpage/builders.ts` gains `buildSettleJs` (the shared post-action quiet-period wait, evaluated as a Promise via the existing `awaitPromise: true` on `evaluateInTab` — no changes needed there, it already awaits promises) and `buildFocusJs` (a minimal deep-query-based focus resolver for `browser.press`'s optional `selector`, kept distinct from `buildTypeResolveJs` since press never clears a value). Both are unit-tested by evaluating the exact shipped JS strings under jsdom, following the pattern `buildClickResolveJs`/`buildTypeResolveJs` already established.
* `packages/extension/src/settle.ts` — settle param resolution (`resolveSettleParams`) and the never-throwing `settleSafely` wrapper, taking the evaluate function as a parameter so the context-destroyed degradation path is unit-tested without chrome.\*.
* `browser-dispatch.ts` computes the bridge timeout for `click`/`type`/`press` from `settle_timeout_ms` via the same `Math.max(floor, requested + overhead)` shape `browser.drag` and `browser.wait_for` already use, instead of relying on the server's implicit 15s default.
* `agent-instructions/content.ts` (the CLAUDE.md/AGENTS.md block) and `server-instructions.ts` (the MCP `initialize.instructions` preamble) both replace the old "special keys → synthetic KeyboardEvent via browser.evaluate" guidance with "special keys → browser.press", and add a new pattern teaching `settle_ms` as a replacement for a follow-up `browser.wait_for` on most action calls.
* `commands/about.ts` quick-reference list (EN + ES) gets a `browser.press` line next to `browser.click`/`browser.type`.

## [0.15.0](https://github.com/jobshimo/browser-link/compare/v0.14.1...v0.15.0) (2026-07-11)


### Features

* **bridge:** `browser.snapshot`, `browser.find`, `browser.click` and `browser.type` now pierce OPEN Shadow DOM roots and same-origin iframes, nested arbitrarily (shadow roots inside iframes and vice versa). Previously all four walked the DOM with plain `document.querySelector` / `querySelectorAll`, so anything behind an `attachShadow({ mode: "open" })` boundary or inside an in-page iframe was invisible to agents. The scan enumerates every reachable root and queries each independently; selectors returned by `snapshot`/`find` are verified unique across the FULL deep search scope before being handed out, so the find → click round trip keeps working when the target lives inside a web component or iframe. Entries for iframe-hosted elements carry an optional `frame` field (the CSS selector of the innermost hosting iframe) — the result shape stays backward compatible.
* **bridge:** `browser.click` gains an occlusion guard. Before dispatching CDP mouse events, the click point is hit-tested starting from the target's own root (shadow root or iframe document, descending nested open shadow roots). If a different element covers the point — modal backdrop, loading overlay, dropdown — the call returns `ok:false` with `Element covered by <tag#id.class> — click the covering element or dismiss it first` instead of silently clicking the wrong thing. Clicks on the target itself, its own descendants, or a wrapper containing it (composed-tree containment) pass. A new optional `force: true` parameter skips the guard as a documented escape hatch. `pointer-events: none` overlays never block (elementFromPoint skips them natively).
* **bridge:** correct coordinate mapping for iframe-hosted elements. CDP `Input.dispatchMouseEvent` takes TOP-LEVEL viewport coordinates; clicks and `find` coords now accumulate each ancestor iframe's bounding rect PLUS its border and padding (the embedded document's viewport origin sits at the frame's content box, not its border box). Every ancestor iframe is scrolled into view alongside the target before measuring.
* **bridge:** click point accuracy for line-wrapped inline elements. The center of `getBoundingClientRect()` for a link wrapped across two lines can land in the unpainted gap between line boxes — hit-testing there reported a false blocker and dispatching there missed. Both the occlusion hit-test and the dispatched CDP coordinates now use the center of the FIRST client rect (`getClientRects()[0]`), which is always a painted fragment; they are guaranteed to be the same point.

### Known limitations

* CLOSED shadow roots (`attachShadow({ mode: "closed" })`) are unreachable from page-world JS — `element.shadowRoot` is `null` by design and there is no CDP-level workaround via `Runtime.evaluate`.
* Cross-origin iframes are unreachable under the same-origin policy; their content is invisible to the scan (access is caught, never thrown).
* Two structurally-identical component twins in different roots (byte-identical shadow internals, no id/testid/label) cannot be told apart by any CSS selector — no syntax scopes a selector to one root. Affected `snapshot`/`find` entries carry `ambiguous: true`: the selector resolves first-match-wins in a deterministic traversal order, must be used immediately, and must never be saved to the persistent map.
* `browser.drag` does NOT yet resolve its endpoint selectors through the deep search — deferred to a later release.

### Internal

* `packages/extension` gains its first test infrastructure: Vitest + jsdom (`environment: "jsdom"` for real shadow-root and iframe `contentDocument` support), mirroring the server package's setup, wired into the root `pnpm -r run test` so CI runs it. 49 tests cover the deep-query primitives, selector round-trip invariants, iframe coordinate accumulation (including styled frames with border/padding), the occlusion guard's shadow/iframe hit-test paths, and the `ambiguous` selector flag.
* The in-page JS shipped through CDP `Runtime.evaluate` moved out of `background.ts` into `packages/extension/src/inpage/` (`deep-query.ts`, `dom-helpers.ts`, `builders.ts`), so the exact strings the extension injects are unit-tested by evaluating them in the DOM environment — no test-only rewriting.
* ESLint test-file block switched from core `no-unused-vars` to `@typescript-eslint/no-unused-vars` (the core rule false-positives on parameter names in TS type positions) and extension test files get browser globals, scoped to that package only.

## [0.14.0](https://github.com/jobshimo/browser-link/compare/v0.13.4...v0.14.0) (2026-05-20)


### Features

* **bridge:** new `browser.canvas_screenshot` tool. Captures a `<canvas>` element from the connected tab as PNG/JPEG and returns it base64-encoded. Designed for pages whose visible UI is rendered to a canvas — Qt for WebAssembly (Victron VRM Remote Console, Venus OS, Felgo apps), WebGL games, custom rendering engines — where `browser.snapshot` and `browser.find` return nothing useful because there is no DOM inside the canvas to inspect. The finder traverses nested Shadow DOM roots, so a canvas hidden behind one or more `attachShadow` boundaries (very common in Qt-WASM apps) is reachable without passing an explicit selector. Accepts an optional `selector` to disambiguate when several canvases coexist, an optional `region: {x,y,w,h}` (in canvas pixels) to crop and save tokens, and an optional `format: "png"|"jpeg"`. Returns `{ ok: true, canvas_size, canvas_pixels, region, format, image_b64, taken_at_ms }` on success or `{ ok: false, reason: "no-canvas"|"tainted"|"crop-failed", message }` on failure. Read-only tool: multiple agents can capture the same tab in parallel; no claim required.

### Rationale

Acting on a canvas page is intentionally NOT exposed yet. Qt-WASM (and other Emscripten-based runtimes) checks `event.isTrusted` and discards synthetic input — verified empirically against the Victron VRM Remote Console: synthetic `MouseEvent` / `PointerEvent` / `TouchEvent` dispatch propagates to the canvas listener but Qt's `QWasmEventDispatcher` bails before any action runs. The only path to real input is `chrome.debugger.sendCommand('Input.dispatchMouseEvent', ...)`, which generates events with `isTrusted: true` from Chromium's input pipeline. Implementing that needs careful design around per-tool permissions and the existing claim layer; it will land in a future release. The screenshot tool delivers the immediate value (the LLM can SEE the page) without dragging the security review of the input path along with it.

### Internal

* `BROWSER_TOOL_NAMES` closed union grew from 20 to 21 entries (`browser.canvas_screenshot`).
* `TOOL_CATALOGUE` grew from 27 to 28 entries (read tool; survives the `readonly` preset). The hardcoded count assertion in `permissions.test.ts` was bumped 27 → 28 as the canary.
* `commands/about.ts` quick-reference list (EN + ES) gets a `browser.canvas_screenshot` line so `browser-link about` does not undersell the new tool.
* `server-instructions.ts` PREAMBLE adds a "Pages rendered to a canvas" section so the MCP client receives the canvas-page playbook on `initialize` — including the limitation that interaction on those pages is not exposed.
* Extension `background.ts` adds `buildCanvasScreenshotJs` (alongside the existing `buildSnapshotJs` / `buildFindJs`) and a `canvas_screenshot` case in `handleTool`. The expression walks nested Shadow DOM roots, optionally crops via a temp 2D canvas, and emits base64 with the comma-prefix stripped so callers receive a plain body.

## [0.13.2](https://github.com/jobshimo/browser-link/compare/v0.13.1...v0.13.2) (2026-05-20)


### Internal

* **deps:** Dependabot PRs now self-heal against the lockstep Version Gate. New `.github/workflows/dependabot-version-bump.yml` runs only when the PR actor is `dependabot[bot]` and pushes a single commit to the bot's branch bumping the 5 lockstep-versioned files to `origin/main + 1 patch`. Backed by `scripts/dependabot-bump-version.mjs`, which reuses `scripts/lib/versions.mjs` so `release.mjs`, `version-gate.mjs` and this bumper all agree on what "aligned" means. Idempotent — re-runs after a Dependabot rebase exit 0 without spurious commits. Requires a fine-grained PAT scoped to this repo (Contents: read+write) stored under the **Dependabot** secrets scope as `DEPENDABOT_BUMP_PAT`.
* **deps:** `.github/dependabot.yml` — production deps minor+patch now grouped (matching how dev + `@types/*` already were), so the typical week becomes 1–3 grouped PRs instead of one per dep. Major bumps drop out of every group so they always arrive solo for review. Block `@types/node` major bumps (must match the Node 22 runtime in CI). github-actions PRs also grouped. Closes #64.

## [0.13.1](https://github.com/jobshimo/browser-link/compare/v0.13.0...v0.13.1) (2026-05-20)


### Internal

* **deps:** bump `env-paths` from 3.0.0 to 4.0.0. Major bump, only breaking change is the new Node.js >=20 floor — already required by the repo's `engines.node >=22.13`, so transparent for us.
* **deps:** bump `ink` from 7.0.2 to 7.0.3. Fixes stale `<Static>` output on identity change and a `<Static>` remount drop bug. No API surface change.
* **deps:** bump `better-sqlite3` from 12.9.0 to 12.10.0. SQLite engine bumped to 3.53.1 and percentile aggregate functions enabled. No call-site change.
* **deps-dev:** bump `eslint` from 10.3.0 to 10.4.0 and `tsx` from 4.21.0 to 4.22.1.

Bundled into a single PR so the lockstep Version Gate only fires once. Replaces Dependabot PRs #63, #65, #66, #67.

## [0.13.0](https://github.com/jobshimo/browser-link/compare/v0.12.0...v0.13.0) (2026-05-18)


### Features

* **bridge:** `browser.find({ tab_id, text, role?, exact? })` — locate one interactive element by visible text and return a stable selector + viewport coordinates. Encapsulates the visibility / ARIA / multi-match patterns that agents otherwise hand-roll inside `browser.evaluate`, and crucially covers the "peruvian markup" case where the clickable thing is a `<div onclick>` instead of a `<button>` (the naive `querySelectorAll('button').find(b => b.textContent.includes(...))` MISSES it silently — no error, no match, a `?.click()` that does nothing). Returns `{ matched: true, selector, coords, tag, text }` on a unique hit, `{ matched: false, reason: 'not-found' }` when nothing matches, or `{ matched: false, reason: 'multiple-matches', candidates: [...] }` with up to 5 candidates (selector + snippet) for disambiguation. Selector heuristic is the SAME one `browser.snapshot` uses (extracted into a shared `DOM_HELPERS_JS` so both tools stay consistent).

* **bridge:** `browser.snapshot` accepts optional filters — `within_selector` restricts the scan to a subtree, `only_interactive` skips headings + the visible-text dump, `exclude: ['nav', 'footer', 'header', 'aside']` drops repeated landmarks, `max_interactive` overrides the cap of 120 (hard ceiling 500). Filters are applied IN-page inside the snapshot JS so the dropped material never traverses CDP → bridge → MCP at all. Additive, no breaking change for calls that omit them.

* **bridge:** snapshot serializer omits empty-string fields per entry — `placeholder`, `aria_label`, `name`, `type`, `href`, `value`, `text`, plus `disabled: false`. Roughly 30–40% smaller payloads on every snapshot, even without filter args. Read by key with optional-chaining; consumers depending on `entry.placeholder === ''` need to fall back to `?? ''`.

* **server boot:** logs a one-line warning when any agent-instructions block on disk is older than the running server's VERSION. The mechanism was already there for the CLI / UI surfaces — boot-time log makes it surface without the user having to remember to run `browser-link instructions`. Format: `Agent instructions OUTDATED for N client(s) — <names>. Run \`browser-link instructions install\` to refresh the global .md blocks.` Best-effort: a per-installer filesystem failure is logged and skipped, never aborts server start.

* **agent-instructions:** new `TOKEN-EFFICIENT PATTERNS` section in the CLAUDE.md / AGENTS.md block. Names the two new dedicated tools (`browser.find`, `browser.snapshot` with filters) and writes down the evaluate-recipe patterns that stayed as recipes — batched DOM reads, scrolling, special keys, events cursor. The reason these did NOT become tools is now in writing: every one of them is a single-line `browser.evaluate` away, plus `browser.type` already covers typing through the native setter. Version stamp bumps to v0.13.0; older installs will show `installed-outdated` on the next `browser-link instructions` / startup check.

* **server-instructions:** same `Token-efficient patterns` block added to the MCP `initialize.instructions` PREAMBLE so agents see the patterns at every session start, not only after `browser-link instructions install` ran. Calls out `browser.evaluate` as the escape hatch and pushes agents toward the dedicated tool for each pattern.

### Internal

* `SNAPSHOT_JS` was replaced by `buildSnapshotJs(opts)`. Shared DOM helpers (`isVisible`, `shortText`, `safeCss`, `genSelector`, `accessibleText`) are now in a single `DOM_HELPERS_JS` template injected into both `buildSnapshotJs` and the new `buildFindJs`. Removes the long-standing risk of `snapshot`'s selector heuristic and a hand-rolled `find` heuristic drifting apart.
* `accessibleText(el)` helper added: prefers `aria-label`, falls back to `innerText`/`textContent`, then `value`, then `placeholder`, then `title`. Same precedence used by ARIA accessible-name calculation, simplified for our use case. Both `find` and (future) selector heuristics share it.
* `BROWSER_TOOL_NAMES` closed union grew from 20 to 21 entries (`browser.find`). The exhaustive switch in `handleBrowserTool` adds a new arm; `default:` stays as the `never`-cast compile-time guard.
* `TOOL_CATALOGUE` grew to 27 entries. `browser.find` is `family: 'bridge'`, `category: 'read'` — does not require a tab claim and survives the `readonly` preset. The hardcoded count assertion in `permissions.test.ts` was bumped 26 → 27 (kept as a tripwire — if a future tool gets added without registering in the catalogue, this test fails BEFORE the UI / CLI silently miss it).
* `commands/about.ts` quick-reference list (EN + ES) gets a `browser.find` line so `browser-link about` doesn't undersell the new tool.

### Rationale

Five items in `ROADMAP.md` got re-evaluated against the live playground before any code was written. Two shipped as tools (`browser.find`, snapshot filters), three were resolved as protocol updates instead (`read_dom`, `press_key`/`scroll`, per-agent `events` cursor) because they were single-line `browser.evaluate` patterns the agent didn't know — not actual surface gaps in the bridge. Better to teach the existing primitive than grow the API for ignorance.

## [0.12.0](https://github.com/jobshimo/browser-link/compare/v0.11.0...v0.12.0) (2026-05-18)


### Features

* **bridge:** popup-aware bridge — three new MCP tools so agents can survive (and use) the things that block tabs.
  * `browser.dialog_respond({ tab_id, accept, prompt_text? })` — respond to a native `alert` / `confirm` / `prompt` / `beforeunload` dialog. browser-link does NOT auto-dismiss anymore: when CDP reports `Page.javascriptDialogOpening`, the extension emits a `dialog-opening` event in `browser.events` (`{ tab_id, type, message, default_prompt }`) and leaves the dialog open. The agent reads it, decides, and answers. Bypasses the claim guard so any agent observing can unfreeze a tab. The popup also exposes Accept / Cancel buttons as a manual escape hatch for when no agent has this tool in its preset.
  * `browser.wait_for_tab({ opened_from, url_substring?, timeout_ms? })` — block until a new tab spawned by a previous action on a connected tab appears in the bridge stream. The extension auto-connects any tab whose `openerTabId` is already connected (via the same `Connect` flow the popup uses), then emits `tab-created` with `opened_from = the opener's server tab id`. `wait_for_tab` polls the stream and, on match, **auto-claims** the new tab under the calling agent — the wait IS the explicit intent. Returns `{ matched, tab_id?, url?, elapsed_ms, checks, claimed?, claim_conflict?, reason? }`.
  * `browser.set_permission({ tab_id, origin, name, state })` — pre-set a browser permission (geolocation, notifications, camera, microphone, clipboardReadWrite, clipboardSanitizedWrite, sensors) so the page API responds silently and no native prompt surfaces. Backed by `chrome.contentSettings` (not CDP `Browser.setPermission`, which would need a browser-level target unreachable from `chrome.debugger` in MV3 — see Internal notes). Scoped per-ORIGIN as a `<origin>/*` URL pattern. States map as granted→allow, denied→block, prompt→ask.

* **extension popup:** version-mismatch banner. The MCP server now stamps its `VERSION` into the `tab.registered` payload; the extension stores it on `TabState` and the popup compares it against `chrome.runtime.getManifest().version` (re-checked every 800 ms while the popup is open). When they drift the popup surfaces a red banner — _Extension X · Server Y — Reload the extension so both halves run the same code_ — plus a one-click `Open chrome://extensions` button that lands the user on the extension's own card, ready to hit the circular refresh icon. Hidden when aligned, or when no tab has registered yet. **Why it matters at this version**: 0.12.0 widens the wire protocol (new `bridge.event` message), so an extension that lags behind misses dialogs / tab-created events silently. The banner makes that visible the moment the user opens the popup.
* **catalogue:** five tools that were already wired up (`browser.claim_tab`, `browser.release_tab`, `browser.my_tabs`, `browser.events`, `browser.reset`) are now in `TOOL_CATALOGUE` so `browser-link tools disable <name>` / `enable <name>` / the Permissions menu can toggle them like the others. Previously these were always-on even when a user wanted to lock the agent out — particularly relevant for `browser.reset`, which is destructive. Catalogue is now exactly 26 tools.

### Internal

* New `bridge.event` message in the wire protocol (`ExtensionToServer` union) so the extension can push out-of-band events to the server's `BridgeEventLog`. Closed allowlist on the server side — only `dialog-opening`, `dialog-closed`, `tab-created` are accepted from the renderer; lifecycle events (`primary-elected`, `tab-registered`, etc.) stay server-owned and cannot be spoofed.
* `BridgeEventLog` is now push-based as well as pull-based. New `subscribe(fn, { replayWithinMs })` registers a listener that fires synchronously inside `add()`. Optional `replayWithinMs` replays recent events to the listener before subscribe returns — solves the race where the agent fires the action and `wait_for_tab` in the same tool batch and the source event lands in the buffer milliseconds before `wait_for_tab` registers.
* `browser.wait_for_tab` is push-based now. No polling loop, no `sinceId` snapshot. Registers a listener via `subscribeEvents` with `replayWithinMs: 1500`, resolves immediately when a matching `tab-created` lands (or comes through the replay) — `elapsed_ms: 0` is the common case.
* Auto-connect for spawned tabs: `chrome.tabs.onCreated` watches for tabs whose `openerTabId` belongs to an already-connected tab. Polls `chrome.tabs.get` up to 5 s for the new tab's `url` to surface (Chrome reports an empty `url` at the moment of `onCreated`; `connectTab` short-circuits on empty url, hence the poll), then runs the same `connectTab` flow as the popup button — debugger attach, `Page` + `Runtime` + `Log` + `Network` + `DOM` enable, WS register. Then the `tab-created` event lands on the bridge stream.
* `Page.javascriptDialogOpening` / `Page.javascriptDialogClosed` listeners in the extension's debugger handler — both emit `bridge.event` and keep a `pendingDialog` field on `TabState` for the popup to surface.
* `browser.set_permission` is backed by `chrome.contentSettings`, NOT CDP `Browser.setPermission`. Reason: `Browser.*` is a browser-level CDP domain and `chrome.debugger.attach({ tabId })` only exposes the tab-level target — the MV3 chrome.debugger API does not expose the flat-protocol `sessionId` mechanism that would let us escalate to the browser target. `chrome.contentSettings` is the surface that IS reachable, at the cost of supporting fewer permission names (the ones in the tool's enum: geolocation, notifications, camera, microphone, clipboardReadWrite, clipboardSanitizedWrite, sensors). The manifest now declares `"contentSettings"` permission.
* Popup adds a "pending dialog" UI surface with Accept / Cancel buttons (and a prompt input for `prompt` type), polling background every 800 ms while open.
* New dispatcher + event-log tests covering the three tools: forwarding, validation, claim bypass for `dialog_respond`, push-based match + replay window for `wait_for_tab`, subscriber lifecycle (in-flight, replay, no-double-fire, error isolation).

### Agent-facing gotcha

* `window.open()` triggered from a button's `onClick` handler does NOT count as a user gesture when the click was dispatched via `browser.click` (CDP `Input.dispatchMouseEvent`). Chrome's popup blocker silently swallows it (the window handle is non-null but no tab is actually created and `chrome.tabs.onCreated` never fires). The reliable way to trigger a popup-spawning click from an agent is `browser.evaluate({ expression: 'document.querySelector("...").click()' })` — `Runtime.evaluate` with `userGesture: true` (what evaluate uses internally) IS recognised as user activation. Documented in `wait_for_tab`'s `gotchas` array.

## [0.11.0](https://github.com/jobshimo/browser-link/compare/v0.10.0...v0.11.0) (2026-05-18)


### Features

* **bridge:** add `browser.wait_for` MCP tool. Blocks until a condition becomes true on the page before continuing the agent flow. Three mutually-exclusive target modes:
  * `selector` + `condition` (`visible` | `hidden` | `attached` | `detached`, default `visible`) — `visible` means the element exists in the DOM, has a non-zero bounding rect, opacity > 0, and `display !== 'none' / visibility !== 'hidden'`.
  * `expression` — any JS string evaluated each poll; `wait_for` stops as soon as `Boolean(expression)` is truthy. Runs through `Runtime.evaluate` so it is subject to the same disabled-list as `browser.evaluate`.
  * `network_url` — case-insensitive substring matched against the URL of completed network requests in the rolling buffer (last 200). Stops when at least one matching request has finished.
  Returns `{ matched, elapsed_ms, checks, reason? }`. **`matched: false` is NOT an error** — the caller decides whether to proceed or take a plan-B path. Polls every `poll_interval_ms` (default 100, clamped to `[50, 1000]`) until `timeout_ms` (default 5000, capped at 30000 — the bridge does not park requests longer than that). Like the other read tools (`browser.snapshot`, `browser.console`, `browser.network`), `wait_for` does NOT require a tab claim — multiple agents can wait on the same tab in parallel.

### Validation

End-to-end validated on the `browser-link-playground` (`/wait-for` route) with all three modes. Page-observed flip-time correlates with `wait_for`'s reported `elapsed_ms` minus the bridge dispatch latency (the parallel-call delay between `click` and `wait_for` arriving at the extension). `checks` always reflects real polling iterations, never a short-circuit.

## [0.7.8](https://github.com/jobshimo/browser-link/compare/v0.7.7...v0.7.8) (2026-05-13)


### Refactor

* **bridge/client:** route the `stopped` / `reconnecting` flags through `isStopped()` / `isReconnecting()` helper functions. TS narrows bare `let` booleans (and even literal object properties) to `false` after the first `if (flag) return`, and that narrowing persists across the `await reconnectLoop(...)` boundary even though `stop()` can flip the value concurrently. TS does NOT narrow function-call return types — so reading through the helpers keeps the post-await re-check honest and drops the previous `eslint-disable-next-line @typescript-eslint/no-unnecessary-condition`.
* **cli:** swap `const [cmd, ...rest] = argv` for `const cmd = argv.at(0)` so `cmd` is `string | undefined` instead of `string`. Removes the `eslint-disable` on the `case undefined` branch — the type now genuinely admits the runtime case where the CLI is invoked with no args.
* **server:** migrate `new Server(...)` (deprecated) to `new McpServer(...).server` (the high-level wrapper exposes the underlying low-level Server for `setRequestHandler`-based dispatch, which is exactly what we use). Removes the `eslint-disable-next-line @typescript-eslint/no-deprecated`. All three `setRequestHandler` call sites work as before — same `ListToolsRequestSchema` / `CallToolRequestSchema` handlers, same dispatch deps. The published MCP surface is byte-identical.

### Miscellaneous

* `pnpm lint` is now 0 errors / 0 warnings with **zero `eslint-disable-next-line` directives** anywhere in the source. Every prior suppression has been replaced by a structural change to the code, not a comment.

## [0.7.7](https://github.com/jobshimo/browser-link/compare/v0.7.6...v0.7.7) (2026-05-13)


### Refactor

* **lint:** clean the entire 205-warning lint backlog inherited from the ESLint introduction in v0.7.6. **All 18 previously-warned rules are now `error`**; every `strictTypeChecked` rule is enforced from this version onward, so any regression fails CI instead of accumulating silently. Highlights of the cleanup:
  * **`extension/src/background.ts` (53 warnings → 0):** introduced CDP response/event types (`CdpRuntimeEvaluateResponse`, `CdpRuntimeConsoleAPICalled`, `CdpLogEntryAdded`, `CdpNetworkRequestWillBeSent/ResponseReceived/LoadingFinished/LoadingFailed`, `CdpNetworkGetResponseBody`) covering only the fields we actually read. The debugger event listener now narrows `params: unknown` to the right shape per CDP method; `cdp<T>(...)` is used with explicit generics at every call site. Added an `isRuntimeMessage` type guard so `chrome.runtime.onMessage` narrows safely instead of with the previous ad-hoc `msg?.action` chain. New `stringifyConsoleArg` helper replaces `String(unknown)` to avoid `[object Object]` leakage. Empty catches got descriptive comments, fire-and-forget promises wrapped in `void`, non-null assertions on `tab.url!`/`tab.title!` replaced by locals captured after the prior null-check.
  * **`extension/src/popup.ts` (13 → 0):** typed `send<T>(payload)` wrapper around `chrome.runtime.sendMessage` (rebinds the inbound `any` to `unknown`, returns `Promise<T>`). Each call site declares the expected response type. Catch callbacks now take `(err: unknown)`.
  * **`server/src/ui/screens.tsx` (19 → 0):** dropped 6× `items[idx]!.value` non-null assertions that TS already considered redundant. Wrapped two floating promises in `void`. Removed `row?.kind` optional chains on values TS knew were non-nullish. Reordered the null guards inside `startUpdate` so TS narrows `info.latest` to `string` before `runSelfUpdate(target, …)`.
  * **`server/src/bridge/client.ts` (16 → 0):** wrapped 5 socket-event arrow callbacks in braces, switched two catch callbacks to `(err: unknown)`, captured `this.socket` into a local `const socket` after the null/closed guard so TS sees the narrowing through the closure (drops both `this.socket!` assertions). The `wireCloseHandler` async-into-sync-onClose mismatch (`no-misused-promises`) fixed by an inner IIFE. Made `disconnect()` sync since the body never awaited anything. Cleaned redundant optional chains on `input.off?.` (NodeJS `Readable` always has `off`).
  * **`server/src/installers/{claude,copilot,opencode}.ts` (7 → 0):** swapped `cfg.mcpServers[NAME]` "existing" probes for the safer `NAME in cfg.mcpServers` boolean. Replaced `delete cfg.mcpServers[NAME]` (the `no-dynamic-delete` cluster) with object-rest destructuring (`const { [NAME]: _removed, ...rest } = cfg.mcpServers; cfg.mcpServers = rest`).
  * **`server/src/bridge/server.ts` (3 → 0):** `(err: unknown)` on the connection-handler catch; the `this.server!.close(...)` non-null assertion replaced by a local `const server = this.server` captured after the null check; the `void this.handleFrame(frame, sessionId!, ...)` cleared by a real `if (sessionId === null) return` defensive check.
  * **`server/src/tools/browser-dispatch.ts` (3 → 0):** moved the `?? {}` to BEFORE the cast in three argument-parsing sites — `(args ?? {}) as { ... }` is type-safe and drops `no-unnecessary-condition`.
  * **`server/src/server.ts` (4 → 0):** the WS `message` handler now normalises `Buffer | ArrayBuffer | Buffer[]` to utf-8 string before `safeParse` (no more `[object Object]` risk), the EADDRINUSE throw carries `{ cause: err }`, the deprecated `Server` SDK import documented with a follow-up note + targeted eslint-disable (migration to `McpServer` is its own PR), and the redundant `async` on the `ListToolsRequestSchema` handler replaced by `() => Promise.resolve(...)`.
  * **`server/src/cli.ts` (3 → 0):** `(err: unknown)` on the top-level dispatch catch; dropped a stray `val ?? ''` argument fallback since TS already knows `val` is `string`; documented the runtime-meaningful `case undefined` on the dispatch switch via a targeted eslint-disable.
  * **`server/src/commands/install.ts`, `commands/self-update.ts`, `bridge/events.ts`, `auth/process-identity.ts`, `tools/server-instructions.ts`:** smaller cleanups (replaced an `override.split(' ')[0]!` with destructuring + a real `if (command)` guard, dropped redundant `?.` on `child.stderr`/`stdout`, copied `opts.sinceId` into a local so TS doesn't need `sinceId!` in the filter, typed an `lsof` replace callback arg, removed `\$` escapes that prettier/ESLint flagged as useless).

Also: configuration tweak from earlier in the cycle stays — `@typescript-eslint/restrict-template-expressions` runs with `{ allowNumber: true, allowBoolean: true }` (the rule's other strict defaults — `allowAny: false`, `allowNullish: false` — remain). Object/unknown stringification still errors.

## [0.7.6](https://github.com/jobshimo/browser-link/compare/v0.7.5...v0.7.6) (2026-05-13)


### Features

* **ci:** add ESLint 10 + typescript-eslint 8 with the `strictTypeChecked` ruleset. New `pnpm run lint` script and a `Lint` step in CI between Format check and Typecheck. Source TypeScript is type-aware-linted (full strict suite: no-explicit-any, no-unsafe-*, no-floating-promises, etc); test files get syntax-only lint with relaxed rules because `tsconfig.json` excludes them from the TS project. The flat config lives at `eslint.config.mjs`.

### Bug Fixes

* **extension:** remove dead duplicate interface declarations from `popup.ts` (`StatusResult`, `ConnectResult` were declared but never used; the real, used copies live in `background.ts`).

### Refactor

* **ci:** initial ESLint introduction. 18 rules with pre-existing violations are temporarily set to `warn` (205 warnings total — counts per-rule documented at the top of `eslint.config.mjs`). Every other strict-type-checked rule stays at `error`, so the config protects against NEW violations of rules we already comply with. Follow-up PRs will promote each warned rule back to `error` after fixing its violation cluster.

## [0.7.5](https://github.com/jobshimo/browser-link/compare/v0.7.4...v0.7.5) (2026-05-12)


### Bug Fixes

* **ci:** v0.7.4 verified the OIDC handshake was already correct (the dumped claims show `workflow_ref: …/ci.yml@refs/heads/main`, `event_name: push`, `repository_owner: jobshimo`, `environment: null` — exactly what the Trusted Publisher expects). The publish step never ran because the diagnostic step right before it returned `exit 1`: GNU `base64 -d` on a JWT base64url segment (which has no padding) exits non-zero even when it prints the decoded output correctly, and the step's `set -euo pipefail` propagated that. By default GitHub Actions skips downstream steps when the previous one fails — that's why "Publish to npm" showed 0s and never executed. Fix: triple-belt the diagnostic step — drop `-e` from `set`, wrap the brittle pipe in `(...) || true`, add `continue-on-error: true` at the step level, and end the script with `exit 0`. The diagnostic step CAN NEVER block the publish anymore.

## [0.7.4](https://github.com/jobshimo/browser-link/compare/v0.7.3...v0.7.4) (2026-05-12)


### Bug Fixes

* **ci:** v0.7.3 failed on a different step: `npm install -g npm@latest` broke the global npm install mid-upgrade with `Cannot find module 'promise-retry'`. Classic "npm mutates its own install dir while running" failure mode. Fix: stop mutating the runner's global npm. Drive the publish with `npx --package=npm@latest -- npm publish --provenance --access public`, so a fresh npm 11+ is pulled into npx's cache for this single invocation and the bundled npm stays untouched.
* **ci:** added a diagnostic step before the publish that prints the bundled tool versions and the OIDC token claims (payload only, no signature). If a future Trusted Publishing handshake fails, the logs already carry the exact `workflow_ref`, `event_name`, `repository_owner`, `sub` etc. claims that npm validates against — no more guessing.

## [0.7.3](https://github.com/jobshimo/browser-link/compare/v0.7.2...v0.7.3) (2026-05-12)


### Bug Fixes

* **ci:** publish still failed on v0.7.2 with the same misleading `404 Not Found - PUT https://registry.npmjs.org/...` after the workflow refactor. Root cause turned out to be unrelated to the chained-workflow hypothesis: the npm CLI bundled with Node 22 LTS today is **10.8.2**, and npm Trusted Publishing requires **npm >= 11.5.1** to perform the OIDC handshake correctly. Older npm silently fails the auth exchange and surfaces it as either a 404 or an ENEEDAUTH against the registry. Confirmed against [npm/cli#9088](https://github.com/npm/cli/issues/9088) ("Trusted publishing failures report misleading 404 / ENEEDAUTH errors instead of trusted-publishing diagnostics") and [npm/cli#8976](https://github.com/npm/cli/issues/8976) ("OIDC trusted publishing E404 when publishing scoped packages"). Fix: `npm install -g npm@latest` immediately before the publish step. When Node 22 LTS catches up with a bundled npm >= 11.5.1, the upgrade step can be removed.

## [0.7.2](https://github.com/jobshimo/browser-link/compare/v0.7.1...v0.7.2) (2026-05-12)


### Bug Fixes

* **ci:** publish step on v0.7.1 failed with a misleading `404 Not Found` from npm. The `--provenance` attestation was signed and accepted by Sigstore, but the subsequent `PUT` to the registry was rejected. Diagnosis: npm Trusted Publishers validates the OIDC token's `workflow_ref` and `event_name` claims, and chained-workflow events (`workflow_run`, similar to `workflow_call`) ship claims that the direct-trigger contract on npmjs.com does not accept. Fix: collapse the release pipeline into `ci.yml` as a `release` job downstream of the test matrix (`needs: ci`, `if: event_name == 'push' && ref == refs/heads/main`). The OIDC token now carries `event_name: push` and `workflow_ref: …/ci.yml@…`, matching the Trusted Publisher contract.

### Refactor

* **ci:** delete `.github/workflows/release-finalize.yml`. Its three concerns (tag, GitHub Release, npm publish) live in the new `release` job inside `ci.yml`. One fewer workflow file, zero `workflow_run` chains, simpler OIDC story.

## [0.7.1](https://github.com/jobshimo/browser-link/compare/v0.7.0...v0.7.1) (2026-05-12)


### Features

* **ci:** automate `npm publish` from the release-finalize workflow. After CI on `main` is green and the tag + GitHub Release are created, the same workflow now publishes the package to npm via [Trusted Publisher](https://docs.npmjs.com/trusted-publishers) (OIDC). No `NPM_TOKEN` is stored in GitHub secrets — the npm package is configured to trust this specific workflow file, and the OIDC handshake mints a short-lived credential per publish. The publish includes `--provenance`, so npm attaches a verifiable [provenance attestation](https://docs.npmjs.com/generating-provenance-statements) that ties each tarball to the workflow run + commit that produced it.

### Miscellaneous

* idempotent publish: the workflow runs `npm view @jobshimo/browser-link@$VERSION` first and skips the publish step if the version is already on the registry. A partial-failure re-run (tag created, publish failed) can therefore retry publish without re-creating the tag.

## [0.7.0](https://github.com/jobshimo/browser-link/compare/v0.6.0...v0.7.0) (2026-05-12)


### ⚠ BREAKING CHANGES

* **node:** `engines.node` is now `>=22.13`. Users running Node 20 or earlier will get a hard refusal from `npm install -g @jobshimo/browser-link`. Upgrade to Node 22.13+ (current LTS). The README already documented Node 22+ as a requirement; this release makes it formal at the package level.

### Features

* **build:** migrate the monorepo to **pnpm 11.1.1**. The published tarball is identical — consumers keep installing with `npm i -g @jobshimo/browser-link` exactly as before. Maintainer-side, `npm install` becomes `pnpm install`, the lockfile is now `pnpm-lock.yaml`, and the pinned version lives in `packageManager` (so Corepack picks it up automatically — devs only need `corepack enable` once).
* **security:** explicit `allowBuilds` allowlist in `pnpm-workspace.yaml`. Only `better-sqlite3` and `esbuild` are allowed to run postinstall scripts; anything else in the dependency tree is silently blocked. This closes a supply-chain class of attacks that npm leaves wide open by default.

### Bug Fixes

* **ci:** drop Node 20 from the matrix. The README already required Node 22+, so the Node 20 jobs were testing a configuration we don't officially support — and they were the source of intermittent `actions/setup-node@v6` cache flakes on `windows-latest`. The matrix is now `[ubuntu-latest, windows-latest] × [22]`.

### Refactor

* **release:** `scripts/release.mjs` now invokes `pnpm install --lockfile-only` and stages `pnpm-lock.yaml`; `scripts/version-gate.mjs` error messages now suggest `pnpm run release`. `packages/server/scripts/prepare-publish.mjs` spawns `pnpm run build` instead of `npm run build` when rebuilding the extension during `pnpm publish`.

### Miscellaneous

* added `.npmrc` (`engine-strict=true`, `auto-install-peers=true`) and `pnpm-workspace.yaml`. Removed `package-lock.json`. README "Development setup" section updated to reflect the new toolchain (`corepack enable && pnpm install`).

## [0.6.0](https://github.com/jobshimo/browser-link/compare/v0.5.4...v0.6.0) (2026-05-12)


### Features

* **ci:** hard `Version Gate` workflow — every PR to `main` is required to bump all five versioned files (root `package.json`, `packages/server/package.json`, `packages/extension/package.json`, `packages/extension/manifest.json`, `packages/shared/package.json`) in lockstep, with the new version strictly greater than `origin/main`. Mark it as a required check on `main` after this PR merges so the rule becomes truly hard.
* **ci:** `release-finalize` is now driven by the version field in `packages/server/package.json` instead of the merge commit subject. Runs as a `workflow_run` listener on the CI workflow, only when CI on `main` is green. Creates the tag and the GitHub Release through the REST API (no `git push` anywhere). Idempotent — if the release for the current version already exists, the job is a no-op.

### Refactor

* **release:** version utilities extracted to `scripts/lib/versions.mjs`, shared by `scripts/release.mjs` and the new `scripts/version-gate.mjs`. Single source of truth for the list of versioned files.

### Miscellaneous

* removed `.githooks/pre-push` and its README section. The optional interactive release reminder is gone — the strict CI gate replaces it.

## [0.5.4](https://github.com/jobshimo/browser-link/compare/v0.5.3...v0.5.4) (2026-05-12)


### Bug Fixes

* **publish:** rebuild the Chrome extension before bundling it into the npm package, and refuse to publish when the extension manifest version disagrees with `packages/server/package.json`. v0.5.3 shipped with the extension manifest stuck at `0.4.0` because `prepare-publish.mjs` only ran an `npm run build` for the extension when its `dist/manifest.json` was missing — stale builds were copied as-is. The script now always cleans the extension `dist/` and rebuilds before copying, and aborts with a clear error on any version mismatch.

## [0.5.3](https://github.com/jobshimo/browser-link/compare/v0.5.2...v0.5.3) (2026-05-12)


### Features

* **claims:** cooperative tab ownership across agents — `browser.claim_tab`, `browser.release_tab`, `browser.my_tabs`, plus `claimed_by` / `claimed_by_me` on `browser.list_tabs`. Action tools auto-claim free tabs and reject when another agent holds the tab. TTL by inactivity, auto-release on IPC disconnect, full audit trail via `browser.events` ([#32](https://github.com/jobshimo/browser-link/pull/32)).
* **extension:** redesigned popup with English copy, brand-aligned visual, pulsing status dot, gradient action button ([#30](https://github.com/jobshimo/browser-link/pull/30)).
* **updates:** in-place self-update from the setup UI — press `u` in the Updates screen to stop the running primary and run `npm install -g` automatically ([#32](https://github.com/jobshimo/browser-link/pull/32)).
* **release:** self-serve PR-based release tooling — `npm run release -- <bump>` creates a release branch + PR, finalize workflow tags and creates the GitHub Release on merge ([#32](https://github.com/jobshimo/browser-link/pull/32)).

### Security

* Cleared all open CodeQL alerts: switch-dispatch over closed tool-name union (`unvalidated-dynamic-method-call`), `assertSafeNpmName` validates the registry URL parameter (`file-access-to-http`), `sanitizeLogValue` strips control characters from IPC bridge logs (`log-injection`), removed unused imports ([#32](https://github.com/jobshimo/browser-link/pull/32)).

### Configuration

* **multi-agent + auto-reelect default ON** for fresh installs; on-disk config only carries explicit overrides ([#32](https://github.com/jobshimo/browser-link/pull/32)).

## [0.5.2](https://github.com/jobshimo/browser-link/compare/v0.5.1...v0.5.2) (2026-05-12)


### Bug Fixes

* **auth:** identify WS peer by local endpoint, not socket presence ([#23](https://github.com/jobshimo/browser-link/pull/23)) — Chrome handshakes were rejected with HTTP 403 on macOS/Linux because `lookupPeerProcess` returned the server's own identity for any loopback connection. The lsof lookup now filters by local endpoint and refuses to identify the server as its own peer.

## [0.5.1](https://github.com/jobshimo/browser-link/compare/v0.5.0...v0.5.1) (2026-05-12)


### Bug Fixes

* **deps:** bump react to ^19.2.0 to satisfy ink 7 peer dependency ([#20](https://github.com/jobshimo/browser-link/issues/20)) ([71c3919](https://github.com/jobshimo/browser-link/commit/71c3919c177b62d1afc76baf37677c77d5cbc2ac))

## [0.5.0](https://github.com/jobshimo/browser-link/compare/v0.4.1...v0.5.0) (2026-05-12)


### Features

* cut 0.5.0 — CI/CD setup + peerLookup DI + major dep bumps ([#18](https://github.com/jobshimo/browser-link/issues/18)) ([547af10](https://github.com/jobshimo/browser-link/commit/547af10cff851d0074dc00c415df1405dee98a52))
