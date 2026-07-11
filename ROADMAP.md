# Roadmap

Improvements queued for upcoming releases. Each item lists:

- **The pain** — concrete friction the author or an agent has hit using browser-link in real flows. No hypothetical features.
- **The idea** — what the surface should look like once shipped. Contracts first, implementation second.
- **Cost** — rough effort sizing: **S** (≤ 1 day, single file or two), **M** (1–3 days, multiple files, light protocol bump), **L** (> 3 days, design tradeoffs, breaking surface).
- **Files** — non-binding starting point of where the work probably lands.

Check items off as they ship; when an item is done, leave it ticked here and link the PR.

---

## Queued (in priority order)

_All five items below were evaluated against the live playground before being committed to. Items 2, 3, and 5 turned out to be single-line `browser.evaluate` patterns the agent didn't know — not real bridge gaps. They are resolved in v0.13.0 by teaching the patterns in the agent-instructions block instead of adding tools. Kept here for context in case future evidence flips the decision._

### [x] 1. `browser.find({ text, role? })` — find an element by visible text — PR #72 (v0.13.0)

Shipped as designed. `genSelector` lifted into a shared `DOM_HELPERS_JS` template so `snapshot` and `find` share the heuristic. Returns `{matched, selector, coords, tag, text}` on unique hit; `{matched:false, reason:'multiple-matches', candidates}` (up to 5) on ambiguity. Covers the "peruvian markup" case (`<div onclick>`) that a naive `querySelectorAll('button')` misses silently.

### [—] 2. `browser.read_dom({ getters })` — RESOLVED AS PROTOCOL (v0.13.0)

Not shipped as a tool. The "4 round-trips for 4 reads" framing was wrong — a competent agent already batches with `(() => ({ a: ..., b: ..., c: ... }))()` in one `browser.evaluate`, ~70 tokens including helpers. A dedicated tool would save ~30 tokens of boilerplate at the cost of a new schema, validation, permissions entry, and tests. The agent-instructions block now teaches the pattern explicitly (see `TOKEN-EFFICIENT PATTERNS`).

**Not a precedent against `browser.flow` (v0.17.0).** This decision was about batching READS — `(() => ({ a: ..., b: ... }))()` already batches N reads into one `browser.evaluate`, client-side, for free. `browser.flow` batches ACTIONS (click/type/press/wait_for), a different problem: actions need real, trusted CDP input events (`Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`) that `browser.evaluate` cannot produce, plus inter-step waits (`settle_ms`, `wait_for`) between them — there was never a client-side batching escape hatch for actions the way there was for reads. A denied action round trip is a full LLM inference, same as a denied read round trip; the fix here had to be a real tool.

### [—] 3a. `browser.press_key` — RESOLVED AS PROTOCOL (v0.13.0)

Not shipped as a tool. `dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))` via `browser.evaluate` IS recognised by vanilla DOM listeners AND by React's delegated root listeners (React 17+ delegates to the root, not to the element). For typing into controlled inputs, `browser.type` already uses the native setter — that was the only correctness gap. Verified against React inputs in the playground.

### [—] 3b. `browser.scroll` — RESOLVED AS PROTOCOL (v0.13.0)

Not shipped as a tool. `pane.scrollTop = N` and `el.scrollIntoView({block:'center'})` via `browser.evaluate` work in every case the playground threw at them. No CDP `Input.synthesizeScrollGesture` needed.

### [x] 4. `browser.snapshot` with filters — pay only for what you need — PR #72 (v0.13.0)

Shipped as designed PLUS a bonus: the per-entry serializer now omits empty-string fields. Together they cut typical snapshot size by 30–60%. The new args are `within_selector`, `only_interactive`, `exclude` (landmarks: nav/footer/header/aside), `max_interactive` (hard ceiling 500).

### [—] 5. Per-agent cursor on `browser.events` — RESOLVED AS PROTOCOL (v0.13.0)

Not shipped as a tool. The "bookkeeping" framing was overstated — `lastId = result.latest_id; pass lastId as since_id next call` is one variable and one assignment. The cost of going stateful server-side (Map<agent_id, lastReadId>, LRU eviction, `caller` plumbed through the dispatcher, cross-process consistency in multi-agent mode) is wildly disproportionate. Pattern is now taught in the agent-instructions block.

---

## Done

_Items move up here when the PR that ships them merges. Format: `- [x] <title> — PR #<n> (<release tag>)`._

- [x] cdp-direct mode — extension-free transport driving Chrome tabs directly over `--remote-debugging-port`, gated behind `cdp-direct.enabled` + a separate time-boxed `browser-link cdp allow` grant an agent can never issue itself; v1 covers list_tabs/ping/snapshot/find/state/click/type/press/evaluate/wait_for/navigate/flow, with drag/console/network/network_body/canvas_screenshot/dialog_respond/set_permission/wait_for_tab deferred to a future v2 — (v0.23.0)
- [x] Idle-disconnect TTL — extension popup control (`Auto-disconnect idle tabs`) + `browser-link config get/set idle-ttl <minutes|never>`, synced live between the two with last-write-wins precedence — (v0.19.0)
- [x] `browser.state` orientation read + `browser.find` near-miss suggestions on no-match + named, replayable map flow recipes (`browser.map.save`/`recall` `flows[]`, validated against the `browser.flow` grammar) — PR #90 (v0.18.0)
- [x] `browser.flow` — declarative `find`/`click`/`type`/`press`/`wait_for` sequence in one round trip, implicit-target threading, fail-fast with a recovery snapshot — PR #89 (v0.17.0)
- [x] `browser.press` — trusted CDP keyboard input (+ modifiers) — plus `settle_ms` post-action quiet-wait on `click`/`type`/`press` — PR #88 (v0.16.0)
- [x] Deep DOM visibility — `browser.snapshot`/`find`/`click`/`type` pierce open Shadow DOM + same-origin iframes; `browser.click` gains an occlusion guard (`force:true` escape hatch) — PR #87 (v0.15.0)
- [x] `browser.canvas_screenshot` — screenshot a `<canvas>` as PNG/JPEG for Qt-WASM / WebGL / other DOMless UIs — PR #77 (v0.14.0)
- [x] `browser.find` + filtered `browser.snapshot` + lean serializer + agent-instructions protocol update — PR #72 (v0.13.0)
- [x] `browser.dialog_respond`, `browser.wait_for_tab`, `browser.set_permission` — PR #71 (v0.12.0)
- [x] `browser.wait_for` — PR #70 (v0.11.0)
- [x] `browser.drag` — PR #68 (v0.10.0)

---

## How to use this doc

- **Adding an item**: append under _Queued_, slot it in the priority order with a short rationale. No items without "the pain" — features without a real friction story belong in an issue, not here.
- **Working on an item**: open a focused PR per item where reasonable. The shape of the schema in this doc is the contract — change it here too if it has to flex in implementation.
- **Closing an item**: tick the box, move the line to _Done_ with the PR number and release tag. Leave the surrounding bullet detail so the rationale stays discoverable.
- **Pruning**: if an item ages and no longer matches a real pain, delete it. Stale roadmap items are worse than no roadmap.
