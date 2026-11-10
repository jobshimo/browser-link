# Roadmap

Improvements for upcoming releases. Each queued item lists:

- **The pain** — concrete friction the author or an agent has hit using browser-link in real flows. No hypothetical features.
- **The idea** — what the surface should look like once shipped. Contracts first, implementation second.
- **Cost** — rough effort sizing: **S** (≤ 1 day, single file or two), **M** (1–3 days, multiple files, light protocol bump), **L** (> 3 days, design tradeoffs, breaking surface).
- **Files** — non-binding starting point of where the work probably lands.

Check items off as they ship; when an item is done, leave it ticked here and link the PR.

---

## Queued (in priority order)

- [ ] **Windows e2e CI job** — **The pain:** the real-Chrome net only runs on ubuntu, so Windows-only regressions in the bridge, IPC or election surface late. **The idea:** add a `windows-latest` leg to the `e2e` job once the Ubuntu job has a few green runs. **Cost:** S. **Files:** `.github/workflows/ci.yml`.
- [ ] **Chrome 118 in CI** — **The pain:** the extension declares Chrome 118 as its minimum and the 1.0.0 end-to-end suite passed against Chrome for Testing 118.0.5993.70, but that run was outside CI; CI uses the runner's own Chrome, so a regression for 118 would ship unseen. **The idea:** a CI job that runs the e2e against Chrome for Testing 118 (the harness already falls back to `--load-extension` by capability). **Cost:** S. **Files:** `.github/workflows/ci.yml`, `packages/e2e`.
- [ ] **Windows real-socket peer test in CI** — **The pain:** the same-user check on Windows is covered by fixtures of real output and by a real-socket test, but that test has not been confirmed to run on the Windows CI runner (an earlier audit recorded it skipping there). **The idea:** confirm it runs on `windows-latest`, or make the runner able to run it. **Cost:** S. **Files:** `packages/server/src/auth/process-identity.integration.test.ts`, `.github/workflows/ci.yml`.
- [ ] **POSIX peer lookup and 0600 on a real system** — **The pain:** the `lsof` same-user path and the owner-only mode of `activity.db` were written and tested with fixtures and by reading; they were not run on a real macOS or Linux machine before 1.0.0. **The idea:** run both on macOS and Linux and pin what they show (including `Google Chrome Helper` on macOS). **Cost:** S. **Files:** `packages/server/src/auth/process-identity.ts`, `packages/server/src/activity/db.ts`.
- [ ] **Kernel-accurate peer lookup on Windows** — **The pain:** the Windows peer lookup reads `netstat` output, which is a snapshot: it can lag a fresh connection (1.0.0 retries up to six snapshots) or list a socket only as bound. **The idea:** consider a kernel-accurate source for the connection's owning process. **Cost:** M. **Files:** `packages/server/src/auth/process-identity.ts`.
- [ ] **`downloadsDir` hint placeholder** — **The pain:** the Admin readout for the downloads folder shows `browser-link config set downloads.dir <absolute-path|default>`, which does not paste into a shell. **The idea:** show a pasteable example, as the grant-lifetime and port hints do. **Cost:** S. **Files:** `packages/server/src/admin/descriptor.ts`.
- [ ] **Neutral Spanish in the console-only texts** — **The pain:** the Admin texts use neutral Spanish since 0.51.0, but console-only texts still use regional forms (for example "podés", "querés", "tenés"). **The idea:** bring them to the same neutral register. **Cost:** S. **Files:** `packages/server/src/cli.ts`, `packages/server/src/commands/about.ts`, `welcome.ts`, `self-update.ts`, `packages/server/src/ui/screens/multi-agent.tsx`.
- [ ] **`autoReelect` persistence (unconfirmed)** — **The pain:** a probe saw `autoReelect=true` reported as applied but no key in `config.json` after turning `multiAgent` off and on again on an empty config. It predates 1.0.0 and was not reproduced further. **The idea:** reproduce it; if real, fix the write path. **Cost:** S. **Files:** `packages/server/src/commands/multi-agent.ts`, `packages/server/src/config.ts`.

The next planned work is the plans layer (signals and restarts over the page observer); `packages/plan/SPEC.md` is its index, and v5, the document that specifies it, is not yet written.

---

## Done

_Items move up here when the PR that ships them merges. Format: `- [x] <title> — PR #<n> (<release tag>)`._

- [x] 1.0.0 hardening — exact extension Origin and same-OS-user peer check (optional strict mode by executable path), sensitive fields not stored in the activity trail, tools / cdp-direct / client registration moved from the Admin window to the console — (v1.0.0)
- [x] Hardened release pipeline — SHA-pinned actions, tarball smoke test before tag and publish — PR #42 (v0.46.0)
- [x] Map knowledge loop — identity keys, confidence, start pack, `browser.wrap_up`, shortcuts, rules just in time — PR #41 (v0.45.0)
- [x] Admin in its own extension window, version in the header — PR #40 (v0.44.1)
- [x] Fast `doctor`, `browser.network` without headers, configurable download cap, iframe re-resolution — PR #39 (v0.44.0)
- [x] Automatic map learning and a per-session friction report — PR #38 (v0.43.0)
- [x] Shared admin panel for the console and the popup, from one server-side source — PR #37 (v0.42.0)
- [x] Version-aware primary election, `stop` ends every process, repair from the popup — PR #36 (v0.41.0)
- [x] One legal notice at first run, in `about`, in the popup and in both readmes — PR #35 (v0.40.0)
- [x] Installed instructions block refreshed at server start; extension version reported to the agent — PR #34 (v0.39.0)
- [x] One-source agent manual and `browser.manual`, outdated notice — PR #33 (v0.38.0)
- [x] `ref` as an action target with semantic re-resolution; `find` by key — PR #32 (v0.37.0)
- [x] `browser.snapshot` diff with `since`, element refs and document ids — PR #31 (v0.36.0)
- [x] Persistent page observer with exact settle changes — PR #30 (v0.35.0)
- [x] Patched `zod`, `vite` and `vitest` (security) — PR #29 (v0.34.1)
- [x] Map stores app mechanisms and pitfalls; small maps inline in `browser.list_tabs` — PR #28 (v0.34.0)
- [x] Dropped tabs keep reconnecting for 10 minutes; an empty `browser.list_tabs` explains itself — PR #27 (v0.33.0)
- [x] `browser.flow` returns partial state on timeout and budgets the real worst case — PR #26 (v0.32.0)
- [x] `expect` on `click`, `type` and `press` asserts the effect of the action — PR #25 (v0.31.0)
- [x] `browser.screenshot` — viewport, full page and element capture — PR #22 (v0.30.0)
- [x] `browser.download` — saves files without the native Save-as dialog — PR #21 (v0.29.0)
- [x] Persistent activity trail and Activity window — PR #6 (v0.28.0)
- [x] Review advisories of the detached-execution slices closed; drift test for the detached-flow constants (no PR number: it predates the repository history) — (v0.27.1)
- [x] Detached execution + `flow_status` / `flow_cancel` + action manifest (roadmap item 11) — (v0.27.0)
- [x] Extension popup: running flows, history, one-click stop (item 10) — (v0.26.0)
- [x] Flow identity + cancellation (item 9) — (v0.26.0)
- [x] Bounded `repeat` construct + `dry_run` (item 8) — (v0.25.0)
- [x] `sleep` step in `browser.flow` (item 7) — (v0.24.0)
- [x] Agent-instructions safety additions (item 6) — (v0.23.14)
- [x] cdp-direct mode — extension-free transport driving Chrome tabs directly over `--remote-debugging-port`, gated behind `cdp-direct.enabled` + a separate time-boxed `browser-link cdp allow` grant (a CLI command, so an agent with a shell on the machine can run it too; see the README security model); v1 covers list_tabs/ping/snapshot/find/state/click/type/press/evaluate/wait_for/navigate/flow, with drag/console/network/network_body/canvas_screenshot/dialog_respond/set_permission/wait_for_tab deferred to a future v2 — (v0.23.0)
- [x] Idle-disconnect TTL — extension popup control (`Auto-disconnect idle tabs`) + `browser-link config get/set idle-ttl <minutes|never>`, synced live between the two with last-write-wins precedence — (v0.19.0)
- [x] `browser.state` orientation read + `browser.find` near-miss suggestions on no-match + named, replayable map flow recipes (`browser.map.save`/`recall` `flows[]`, validated against the `browser.flow` grammar) — v0.18.0
- [x] `browser.flow` — declarative `find`/`click`/`type`/`press`/`wait_for` sequence in one round trip, implicit-target threading, fail-fast with a recovery snapshot — v0.17.0
- [x] `browser.press` — trusted CDP keyboard input (+ modifiers) — plus `settle_ms` post-action quiet-wait on `click`/`type`/`press` — v0.16.0
- [x] Deep DOM visibility — `browser.snapshot`/`find`/`click`/`type` pierce open Shadow DOM + same-origin iframes; `browser.click` gains an occlusion guard (`force:true` escape hatch) — v0.15.0
- [x] `browser.canvas_screenshot` — screenshot a `<canvas>` as PNG/JPEG for Qt-WASM / WebGL / other DOMless UIs — v0.14.0
- [x] `browser.find` + filtered `browser.snapshot` + lean serializer + agent-instructions protocol update — v0.13.0
- [x] `browser.dialog_respond`, `browser.wait_for_tab`, `browser.set_permission` — v0.12.0
- [x] `browser.wait_for` — v0.11.0
- [x] `browser.drag` — v0.10.0

---

## Shipped programs (detail kept for the rationale)

_Everything below shipped; the one-line records are in Done above. Kept because closing an item leaves its bullet detail in place. The full flow spec, `docs/specs/flow-supervised-execution.md`, still carries its original "accepted, not started" status line even though all six slices shipped by v0.27.0._

### Program: `flow` as the unit of durable, supervised work

_Full spec: **`docs/specs/flow-supervised-execution.md`**. Architecture decision: **`DECISIONS.md` §13**. Origin: the bulk-actions field report (2026-08-08, v0.23.12 — 956 irreversible deletions, ~25 round trips, ~15 of them pure polling)._

**The shared pain.** Every guarantee browser-link provides is scoped to a single tool call. `flow` extended the guaranteed zone to 20 steps / 60s; past that the only path is raw `browser.evaluate`, which has none of them — `el.click()` is `isTrusted:false`, no occlusion check, no recovery snapshot, no record. The value curve is inverted: the bigger and more irreversible the task, the fewer protections it runs under. `MAX_FLOW_TIMEOUT_MS` is not a performance decision — it exists _because_ there is no cancel/status path, and that cap is what pushes long work into `evaluate` in the first place.

Six slices, one PR each. Each PR updates the README in the same PR — never deferred.

- [x] **6. Agent-instructions safety additions** — v0.23.14 — cost **S**, no deps, ship first and alone. A timed-out `evaluate` keeps running; relaunching it duplicates irreversible work. Adds the `running`-guard pattern, "check before relaunching", `wait_for`-over-polling, the `DOMParser`/`innerText` trap, and "paginated counters lie". _Files:_ `packages/server/src/agent-instructions/content.ts`.
- [x] **7. `sleep` step in `browser.flow`** — v0.24.0 — cost **S**, no deps. `settle_ms` is a quiet-period wait, not a fixed pause, so throttling between actions is not expressible today. _Files:_ `browser-definitions.ts`, `browser-dispatch.ts`, both `flow.ts` copies, `cdp/drift.test.ts`.
- [x] **8. Bounded `repeat` construct + `dry_run`** — v0.25.0 — cost **M**, needs 7. `{ repeat: { steps, max_iterations, while_found?, delay_ms? } }`. No nesting; `max_iterations` mandatory so the worst-case budget stays statically computable and the existing 60s rejection keeps working — safe to ship before cancellation exists. `while_found` retires the "lying counters" observation at the root. Under today's 60s cap a throttled drain loop fits ~46 iterations per call (measured), so the win is SAFETY — trusted input, occlusion guard, per-iteration record, bounded up front — not raw throughput. Slice 11 lifts the ceiling. `dry_run` ships in the same PR, not later. _Files:_ as above, plus `flow.test.ts` (both copies).
- [x] **9. Flow identity + cancellation** — v0.26.0 — cost **M**, needs nothing technically. `flow_id` on every flow, `deps.shouldCancel()` checked per step and per repeat iteration, new `tool.cancel` wire message. A cancelled flow returns `ok: true` with `stopped_by: 'cancelled'` and partial results — never discards what already happened. Worst-case latency one step, so `wait_for`'s poll loop must honour the flag too. Shipped together with 10: cancellation with nothing able to invoke it would have been dead code, since a synchronous flow blocks the very agent that would cancel it. On cdp-direct the same seam makes `browser-link cdp revoke` stop a running flow within one step instead of being grandfathered until it finished. _Files:_ `packages/shared/src/index.ts`, `ws-bridge.ts`, `browser-dispatch.ts`, `background.ts`, both `flow.ts` copies.
- [x] **10. Extension popup: running flows, history, one-click stop** — v0.26.0 — cost **M**, needs 9. Running flows with live progress and a Stop button; last 20 completed per tab in `chrome.storage.session`. UI structure and outcomes only, never page content — same rule as the persistent map. Ships **before** slice 11 on purpose: the kill switch exists before the capability that needs it. No cdp-direct equivalent (no popup); there the kill switch is `browser-link cdp revoke`. _Files:_ `popup.html`, `popup.ts`, `background.ts`.
- [x] **11. Detached execution + `flow_status` / `flow_cancel` + action manifest** — v0.27.0 — cost **L**, needs 9 and 10. `flow({detach:true})` escapes `MAX_FLOW_TIMEOUT_MS` under its own budget plus a 30-minute absolute ceiling (`stopped_by: 'expired'`); one detached flow per tab, a second rejected naming the running id. The manifest fell out free — `runFlow` already accumulates `results[]`, and `BridgeEventMessage` was already the out-of-band channel into `BridgeEventLog`. Exactly one `flow-finished` summary event per flow, never one per iteration (`MAX_EVENTS = 200` would evict everything else). **Open question, settled:** a launch record in `chrome.storage.session` makes MV3 service-worker termination detectable; on worker start any still-`running` record is rewritten `failed` / `worker-terminated` and NEVER resumed — a resume would double-act on irreversible work whose real progress died with the worker. `runFlow` itself was not touched, so the drift guard held trivially. Also lifted the dry-run ceiling to the detached one, so an oversized flow can finally be projected (`budget_ms`, `requires_detach`) instead of rejected before it is answered. _Files:_ `permissions.ts`, `browser-definitions.ts`, `browser-dispatch.ts`, `bridge/events.ts`, `bridge/ws-bridge.ts`, `cdp/detached-flows.ts`, `cdp/transport.ts`, `flow-registry.ts`, `background.ts`, `popup.ts`.

---

_Items 1–5 below were evaluated against the live playground before being committed to. Items 2, 3, and 5 turned out to be single-line `browser.evaluate` patterns the agent didn't know — not real bridge gaps. They are resolved in v0.13.0 by teaching the patterns in the agent-instructions block instead of adding tools. Kept here for context in case future evidence flips the decision._

### [x] 1. `browser.find({ text, role? })` — find an element by visible text — v0.13.0

Shipped as designed. `genSelector` lifted into a shared `DOM_HELPERS_JS` template so `snapshot` and `find` share the heuristic. Returns `{matched, selector, coords, tag, text}` on unique hit; `{matched:false, reason:'multiple-matches', candidates}` (up to 5) on ambiguity. Covers the "peruvian markup" case (`<div onclick>`) that a naive `querySelectorAll('button')` misses silently.

### [—] 2. `browser.read_dom({ getters })` — RESOLVED AS PROTOCOL (v0.13.0)

Not shipped as a tool. The "4 round-trips for 4 reads" framing was wrong — a competent agent already batches with `(() => ({ a: ..., b: ..., c: ... }))()` in one `browser.evaluate`, ~70 tokens including helpers. A dedicated tool would save ~30 tokens of boilerplate at the cost of a new schema, validation, permissions entry, and tests. The agent-instructions block now teaches the pattern explicitly (see `TOKEN-EFFICIENT PATTERNS`).

**Not a precedent against `browser.flow` (v0.17.0).** This decision was about batching READS — `(() => ({ a: ..., b: ... }))()` already batches N reads into one `browser.evaluate`, client-side, for free. `browser.flow` batches ACTIONS (click/type/press/wait_for), a different problem: actions need real, trusted CDP input events (`Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`) that `browser.evaluate` cannot produce, plus inter-step waits (`settle_ms`, `wait_for`) between them — there was never a client-side batching escape hatch for actions the way there was for reads. A denied action round trip is a full LLM inference, same as a denied read round trip; the fix here had to be a real tool.

### [—] 3a. `browser.press_key` — RESOLVED AS PROTOCOL (v0.13.0)

Not shipped as a tool. `dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))` via `browser.evaluate` IS recognised by vanilla DOM listeners AND by React's delegated root listeners (React 17+ delegates to the root, not to the element). For typing into controlled inputs, `browser.type` already uses the native setter — that was the only correctness gap. Verified against React inputs in the playground.

### [—] 3b. `browser.scroll` — RESOLVED AS PROTOCOL (v0.13.0)

Not shipped as a tool. `pane.scrollTop = N` and `el.scrollIntoView({block:'center'})` via `browser.evaluate` work in every case the playground threw at them. No CDP `Input.synthesizeScrollGesture` needed.

### [x] 4. `browser.snapshot` with filters — pay only for what you need — v0.13.0

Shipped as designed PLUS a bonus: the per-entry serializer now omits empty-string fields. Together they cut typical snapshot size by 30–60%. The new args are `within_selector`, `only_interactive`, `exclude` (landmarks: nav/footer/header/aside), `max_interactive` (hard ceiling 500).

### [—] 5. Per-agent cursor on `browser.events` — RESOLVED AS PROTOCOL (v0.13.0)

Not shipped as a tool. The "bookkeeping" framing was overstated — `lastId = result.latest_id; pass lastId as since_id next call` is one variable and one assignment. The cost of going stateful server-side (Map<agent_id, lastReadId>, LRU eviction, `caller` plumbed through the dispatcher, cross-process consistency in multi-agent mode) is wildly disproportionate. Pattern is now taught in the agent-instructions block.

---

## How to use this doc

- **Adding an item**: append under _Queued_, slot it in the priority order with a short rationale. No items without "the pain" — features without a real friction story belong in an issue, not here.
- **Working on an item**: open a focused PR per item where reasonable. The shape of the schema in this doc is the contract — change it here too if it has to flex in implementation.
- **Closing an item**: tick the box, move the line to _Done_ with the PR number and release tag. Leave the surrounding bullet detail so the rationale stays discoverable.
- **Pruning**: if an item ages and no longer matches a real pain, delete it. Stale roadmap items are worse than no roadmap.
