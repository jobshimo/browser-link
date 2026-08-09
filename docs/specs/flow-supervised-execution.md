# Spec — `flow` as the unit of durable, supervised work

**Status:** accepted, not started · **Program cost:** L (six slices, six PRs) · **Origin:** `.notes/field-report-bulk-actions.md` (2026-08-08, v0.23.12)

This document specifies one coherent program, sliced into six independently shippable PRs. Each slice states its own contract, acceptance criteria, files, README impact and cdp-direct parity, so it can be lifted into `ROADMAP.md` and worked on alone.

---

## The root pain

Every guarantee browser-link provides is scoped to a **single tool call**.

Trusted CDP input, the occlusion guard, pointer-events awareness, shadow-DOM piercing, visibility + ARIA checks, stable selectors, settle detection, recovery snapshots on failure — all of it ends at one act. `browser.flow` extended the guaranteed zone to `MAX_FLOW_STEPS = 20` steps and `MAX_FLOW_TIMEOUT_MS = 60_000`. Past that ceiling the only available path is raw `browser.evaluate`, which has **none** of them: `el.click()` is `isTrusted:false`, there is no occlusion check, no recovery snapshot, and no record of what happened.

The value curve is therefore inverted — **the bigger and more irreversible the task, the fewer safety guarantees it runs under.** The field report's 956 irreversible deletions executed with strictly less protection than a single `browser.click` would have had.

There is a circularity holding this in place:

```
no execution lifecycle (no cancel, no status)
  → flow must be capped at 60s        (rationale documented at browser-dispatch.ts:265-271)
    → long work is pushed into browser.evaluate
      → long work loses every guarantee the bridge exists to provide
```

`MAX_FLOW_TIMEOUT_MS` is not a performance decision. It is a _consequence_ of the missing lifecycle. This program breaks the loop.

### Why a page-side jobs API does not solve it

The field report's headline proposal was `browser.job_cancel` / `browser.job_status` over a worker living in page JS (`window.__job`). That does not reach the root:

- Cancelling a running promise loop **in the page** is inherently cooperative. It can only set a flag the worker chooses to check; it cannot interrupt a stuck `await`. That is already one `browser.evaluate` away and fails the repo's pattern-vs-tool test (`ROADMAP.md` items 2, 3, 5).
- `job_status` is likewise an `evaluate` reading a global.
- Most importantly, a page-side worker can only produce **synthetic** events. The moment the repeated action needs trusted input, the whole pattern collapses.

Cancelling a loop the **bridge** owns is different in kind: the runner controls dispatch, so cancellation means _not dispatching step N+1_, with a worst-case latency of one step. That is a real primitive, and it is the one this spec builds.

### The seam that makes it affordable

`runFlow` is already a pure orchestrator over an injected `FlowDeps` — a plain `for` loop awaiting `deps.performX`. It is duplicated near-verbatim in `packages/extension/src/flow.ts:324` and `packages/server/src/cdp/flow.ts:335`, kept in lockstep by `packages/server/src/cdp/drift.test.ts`. Neither copy has an `AbortController` or a `signal`.

Consequence: the cancellation check itself is a few lines at the top of each loop body, and the drift test already guards the duplication. The cost of this program is **plumbing** — flow identity, an in-flight registry, a wire message, a UI — not loop surgery.

Two transports already carry everything else needed:

- `ToolRequestMessage { kind, id, tool, params }` gives every request a correlation id (`packages/shared/src/index.ts:38`).
- `BridgeEventMessage` (`:92`) is already an out-of-band extension → server channel into `BridgeEventLog`. The audit trail asked for in field-report observation 3 needs **no new transport**.

---

## Slice order and dependency graph

```
1. agent-instructions safety     (S)  independent — ship first, alone
2. sleep step                    (S)  independent
3. repeat construct + dry_run    (M)  safe under the existing 60s cap
4. flow identity + cancellation  (M)  needs nothing; enables 5 and 6
6. popup: flows panel + stop     (M)  needs 4
5. detach + status + manifest    (L)  needs 4; best shipped after 6
```

Slice 6 deliberately ships **before** slice 5. Detached execution is the dangerous capability; the human kill switch should exist before the thing that needs it, not after.

---

## Slice 1 — Agent-instructions safety additions

**Cost:** S · **Depends on:** nothing · **Ship immediately, independent of the rest of this program.**

### Pain

A `browser.evaluate` that exceeds its 15s budget has its response dropped while **the expression keeps running in the page** (documented at `browser-definitions.ts:1004`, `browser-dispatch.ts:266-271`; the extension awaits `handleTool` with no per-request timeout at `background.ts:2277-2284`). A timeout reads as failure, so the natural reaction is to relaunch — which on irreversible actions starts a second concurrent loop over the same work. In the field report the deletion loop timed out and carried on deleting; it was caught only by watching a server-side counter fall.

`browser.evaluate` remains the escape hatch after this whole program ships, so this guidance is permanent, not a stopgap.

### Contract

Four additions to the `TOKEN-EFFICIENT PATTERNS` block in `packages/server/src/agent-instructions/content.ts`:

1. **Never put long work inside `browser.evaluate`.** Launch a self-guarding worker that reports progress to a global, and poll that global with short calls. A guard on `running` is mandatory, not decorative — without it, a retried call after a timeout starts a second concurrent worker over the same irreversible actions. **If an `evaluate` times out, check whether it is still working before relaunching.**
2. **To wait on a background worker, use `browser.wait_for` with an expression**, not a chain of `evaluate` + `setTimeout`. Each hand-rolled poll costs a full inference; `wait_for` parks server-side for up to 30s in one call.
3. **Never regex over a `DOMParser` document's text.** `innerText` is `undefined` on a detached document and the `textContent` fallback sweeps up scripts, styles and hidden nodes. Select per field and read that leaf's `textContent`. Sanity-check extracted figures against `snapshot` before acting on them. _(Field evidence: a real maximum of 8,00 € was reported as 28,00 € — confident, plausible, wrong.)_
4. **Never treat a paginated list's own counter as ground truth.** Find the authoritative count elsewhere, and confirm completion by an explicit empty-state string rather than a counter reaching zero — counters routinely vanish at zero and leave a stale value behind.

### Acceptance

- All four additions present in `content.ts`.
- Existing agent-instructions tests still pass; add an assertion that the safety sentence about relaunching after a timeout is present.

### Files

`packages/server/src/agent-instructions/content.ts`

### README impact

Check whether `## Customising → ### Agent instructions` (README.md:617) mirrors this text. If it does, update it in the same PR.

### cdp-direct parity

N/A — documentation only.

---

## Slice 2 — `sleep` step in `browser.flow`

**Cost:** S · **Depends on:** nothing

### Pain

`flow` has six step kinds (`find`, `click`, `type`, `press`, `wait_for`, `drag`) and **no fixed pause**. `settle_ms` is a quiet-period wait, not a delay, so throttling between actions is not expressible. Any flow that must not hammer a backend has to drop to `evaluate` — and lose trusted input to get a `sleep`.

### Contract

New step kind: `{ sleep: { ms: number } }`.

- `ms` required, integer, `1..30_000`. Out-of-range is a validation error, not a clamp.
- Contributes `ms` to the statically computed flow budget, so the existing `MAX_FLOW_TIMEOUT_MS` rejection continues to work unchanged.
- Does **not** participate in the implicit-target chain: a pending implicit target from a preceding `find` survives a `sleep` untouched, exactly as it survives `wait_for` and `drag`.
- Result entry: `{ slept_ms: <ms> }`.

### Acceptance

- `FLOW_STEP_KINDS` (`browser-dispatch.ts:308`) and both `STEP_KINDS` lists include `sleep`.
- `cdp/drift.test.ts` still passes — both `runFlow` copies stay in lockstep.
- A flow whose budget exceeds `MAX_FLOW_TIMEOUT_MS` _because of_ its sleeps is rejected up front with the existing error.
- Test: implicit target from `find` survives an interposed `sleep` and is consumed by the following `click`.

### Files

`packages/server/src/tools/browser-definitions.ts` (schema) · `packages/server/src/tools/browser-dispatch.ts` (`FLOW_STEP_KINDS`, `validateFlowSteps`, budget maths) · `packages/extension/src/flow.ts` · `packages/server/src/cdp/flow.ts` · `packages/server/src/cdp/drift.test.ts`

### README impact

`## What the agent can do` — add `sleep` to the documented `flow` grammar.

### cdp-direct parity

Full. Pure grammar; the drift test enforces both transports.

---

## Slice 3 — Bounded `repeat` construct + `dry_run`

**Cost:** M · **Depends on:** slice 2 (`sleep` is what makes a throttled repeat expressible)

### Pain

`flow` cannot express repetition at all — no loop, no repeat. So the sanctioned path for _"click every element matching a selector, with a delay, until the list drains"_ is raw `evaluate`, which is exactly what happened in the field report and exactly where every guarantee is lost.

### Why this is safe to ship before cancellation

`max_iterations` is **mandatory**, so the worst-case duration stays statically computable and the existing `MAX_FLOW_TIMEOUT_MS = 60_000` rejection still bounds every flow. A repeat cannot outrun the current ceiling. Cancellation (slice 4) is what later _raises_ that ceiling; it is not a prerequisite for this slice.

The payoff at the current ceiling is real but bounded, and it is worth stating precisely rather than optimistically. The budget is `2000 + max_iterations x (inner steps + delay_ms + a 500ms while_found probe) <= 60000`, and a click step costs 2500ms with default settle or 500ms with `settle_ms: 0`. So a throttled drain loop — one click, `settle_ms: 0`, `while_found`, `delay_ms: 250` — fits **46 iterations per call** (measured: 46 accepted, 47 rejected at 61s). Unthrottled with settle off it is ~116; with default settle it is ~23.

That means `repeat` is **not** primarily a throughput win over an `evaluate` loop — the field report's 956 deletions would take ~21 calls, not ~5. It is a SAFETY win: every click is trusted CDP input, occlusion-guarded, recorded per iteration, and the whole thing is bounded and rejectable up front. The throughput ceiling is exactly what slice 6 lifts by removing `MAX_FLOW_TIMEOUT_MS`.

### Contract

New step kind:

```
{ repeat: {
    steps: FlowStep[],          // required, non-empty
    max_iterations: number,     // required, integer, 1..500
    while_found?: string,       // optional CSS selector — stop when it stops matching
    delay_ms?: number           // optional, 0..30_000, applied AFTER each iteration
} }
```

- **No nesting.** A `repeat` may not contain a `repeat`. Rejected at validation. This keeps the budget maths trivial and the grammar honest.
- **Step accounting:** outer steps + all inner steps count against `MAX_FLOW_STEPS = 20`.
- **Budget:** `max_iterations × (Σ budget(inner steps) + delay_ms)`, added to the enclosing flow budget, then subject to the existing `MAX_FLOW_TIMEOUT_MS` rejection.
- **Termination:** `while_found` is evaluated against the live DOM _before_ each iteration. Stop on first non-match, or on `max_iterations`, whichever comes first.
- **Failure:** a failing inner step fails the whole flow with the existing fail-fast + recovery-snapshot behaviour, reporting the iteration index it died on.
- **Implicit target:** does not leak across the `repeat` boundary in either direction. Each iteration starts with no implicit target.
- **Result entry:**
  ```
  { iterations_completed: N,
    stopped_by: 'condition' | 'max_iterations' | 'error',
    iterations: [ <per-iteration inner results> ] }
  ```

`while_found` is what retires field-report observation 6 at the root: the stop condition becomes declarative and evaluated against the live DOM, so no counter parsing, no hand-rolled stall detector, and no phantom last item when the counter vanishes at zero.

**`dry_run`** — new optional top-level arg on `browser.flow`:

- `flow({ steps, dry_run: true })` dispatches **no** `Input.*` events and performs no navigation.
- Returns, for each `repeat` step, `{ would_iterate: N, matched_now: M }`, where `M` is the current match count for `while_found` and `N` is `min(M, max_iterations)` when `while_found` is present, else `max_iterations`.
- Scope is deliberately narrow: it answers _"I am about to do this N times — is N what I think it is?"_. A general per-step dry run (resolve + occlusion-check every action without dispatching) is **out of scope**; note it as a possible follow-up.

Given `repeat` makes irreversible bulk work a first-class capability, `dry_run` ships in the same PR, not later.

### Acceptance

- Nested `repeat` rejected at validation with a clear error.
- A `repeat` whose computed budget exceeds `MAX_FLOW_TIMEOUT_MS` is rejected **before** any action is dispatched.
- `while_found` stops the loop on first non-match; `stopped_by` reports `'condition'`.
- Absent `while_found`, exactly `max_iterations` iterations run; `stopped_by` reports `'max_iterations'`.
- Inner-step failure fails the flow with a recovery snapshot and the failing iteration index.
- Implicit target does not leak into or out of the repeat body.
- `dry_run: true` dispatches zero `Input.*` events (assert at the CDP mock) and returns the projected counts.
- `cdp/drift.test.ts` passes.

### Files

`packages/server/src/tools/browser-definitions.ts` · `packages/server/src/tools/browser-dispatch.ts` · `packages/extension/src/flow.ts` · `packages/server/src/cdp/flow.ts` · `packages/server/src/cdp/drift.test.ts` · tests in `flow.test.ts` (both copies)

### README impact

`## What the agent can do` — document `repeat` and `dry_run`, with the "bounded by design, no nesting" rationale. Add a worked bulk-action example.

### cdp-direct parity

Full.

---

## Slice 4 — Flow identity + cancellation

**Cost:** M · **Depends on:** nothing technically; lands after slice 3 so there is something worth cancelling

### Pain

A running flow cannot be observed or stopped by anyone — not the agent, not the human. This is the missing primitive that forces `MAX_FLOW_TIMEOUT_MS` to exist.

Note this slice delivers value for **synchronous** flows alone: a human can stop a 60s flow that is misbehaving. Async execution is slice 5.

### Contract

- Every `browser.flow` call is assigned a `flow_id` (opaque string), returned in the result and included in the fail-fast error payload.
- The extension keeps an in-flight registry: `Map<flow_id, { tabId, startedAt, steps, cancelled, progress }>`.
- `runFlow` gains an optional `deps.shouldCancel(): boolean`, checked:
  - at the top of each step iteration, and
  - at the top of each `repeat` iteration.
- On cancellation the flow returns cleanly — **not** as an error — with:
  ```
  { ok: true, stopped_by: 'cancelled', steps_completed: N, results: [...] }
  ```
  so whatever _did_ happen is still reported. Partial work must never be silently discarded.
- **Wire:** new `ToolCancelMessage { kind: 'tool.cancel', flow_id: string }` added to `ServerToExtension` in `packages/shared/src/index.ts`.
- **Popup:** cancels via the existing `chrome.runtime.onMessage` listener (`background.ts:2755`) with `{ kind: 'flow.cancel', flowId }`.
- **Latency:** worst case is one step. A `wait_for` step can be 30s, so its poll loop must check the cancel flag too — otherwise the advertised bound is a lie.

### Acceptance

- Cancelling mid-flow stops dispatch and returns `stopped_by: 'cancelled'` with results-so-far.
- Cancelling during a `repeat` stops at an iteration boundary and reports `iterations_completed`.
- Cancelling during a long `wait_for` returns within one poll interval, not at the 30s timeout.
- Cancelling an unknown or already-finished `flow_id` is a clean no-op, not an error.
- No `Input.*` event is dispatched after the cancel flag is observed.
- `cdp/drift.test.ts` passes.

### Files

`packages/shared/src/index.ts` · `packages/server/src/bridge/ws-bridge.ts` · `packages/server/src/tools/browser-dispatch.ts` · `packages/extension/src/background.ts` (registry + `tool.cancel` + `runtime.onMessage`) · `packages/extension/src/flow.ts` · `packages/server/src/cdp/flow.ts`

### README impact

`### Behavior worth knowing before you rely on it` — document that a cancelled flow returns `ok: true` with partial results, and the one-step cancellation latency bound.

### cdp-direct parity

Full, and simpler: the cdp-direct runner is in-process, so no wire message is needed on that path.

---

## Slice 6 — Extension popup: running flows, history, one-click stop

**Cost:** M · **Depends on:** slice 4

_(Numbered out of order deliberately — this ships before slice 5.)_

### Pain

The human is the only actor guaranteed to be present while a flow runs. Today they have no visibility into what the bridge is doing on their behalf and no way to stop it. Once flows can repeat hundreds of times (slice 3) and later run detached (slice 5), that is not acceptable.

### Contract

A new **Flows** panel in the extension popup:

- **Running** — for each in-flight flow: tab title, elapsed time, progress (`step i/N`, or `iteration i/N` inside a repeat), and a **Stop** button. One click, no confirmation dialog, no second step.
- **History** — the last 20 completed flows per tab: outcome (`completed` / `cancelled` / `failed`), duration, steps or iterations completed, and the failing step when applicable.
- Live updates while the popup is open, via the existing `chrome.runtime` messaging already used by the popup.
- History is held in `chrome.storage.session` — it dies with the browser session by design. This is an operator view, not an audit log; the durable record is slice 5's manifest.
- History entries store **UI structure and outcomes only** — never page content, field values, or domain data. Same rule as the persistent map.

### Acceptance

- Stop halts the flow within one step and the entry moves to History as `cancelled`.
- The panel is correct with zero flows, with several concurrent flows across different tabs, and while the popup is opened _after_ a flow has already started.
- Closing and reopening the popup mid-flow shows accurate current progress.
- Nothing in a history entry contains page text or input values.

### Files

`packages/extension/popup.html` · `packages/extension/src/popup.ts` · `packages/extension/src/background.ts` (registry query + progress push)

### README impact

Document the Flows panel wherever the popup UI is described (`## Quick start` and/or `## What it is`), with a screenshot placeholder. Call out the Stop button explicitly in `## Security model` — it is a user-control guarantee, not just a convenience.

### cdp-direct parity

**None, by design.** cdp-direct has no extension and therefore no popup. Note the asymmetry in the cdp-direct section of the README: in cdp-direct mode the only kill switch is `browser-link cdp revoke`. Consider a follow-up to surface running flows in the server TUI (`packages/server/src/ui/app.tsx`) — out of scope here.

---

## Slice 5 — Detached execution, status, and the action manifest

**Cost:** L · **Depends on:** slice 4 (identity + cancel) and slice 6 (kill switch must already exist)

### Pain

With slices 2–4, work is still bounded by `MAX_FLOW_TIMEOUT_MS = 60_000` and still occupies the agent's turn while it runs. The remaining gaps: work longer than the ceiling, and _"which 956 things did you just delete?"_ — a question the system currently cannot answer at all.

### Contract

**Detach:**

- `browser.flow({ steps, detach: true })` returns immediately with `{ flow_id, detached: true }`.
- A detached flow is **not** subject to `MAX_FLOW_TIMEOUT_MS`. It is subject to its own statically computed budget (still mandatory, still derived from `max_iterations`), plus an absolute ceiling — proposed **30 minutes** — beyond which it self-cancels and records `stopped_by: 'expired'`.
- At most one detached flow per tab. A second attempt returns an error naming the running `flow_id`. Concurrent detached flows on one tab are a footgun with no use case.

**New tools** (both added to `TOOL_CATALOGUE` in `packages/server/src/permissions.ts`):

| Tool                  | Family   | Category | Summary                                               |
| --------------------- | -------- | -------- | ----------------------------------------------------- |
| `browser.flow_status` | `bridge` | `read`   | Progress, outcome and action manifest of a flow by id |
| `browser.flow_cancel` | `bridge` | `action` | Stop a running flow by id                             |

`flow_status(flow_id)` returns:

```
{ flow_id, tab_id, state: 'running' | 'completed' | 'cancelled' | 'failed' | 'expired',
  started_at, ended_at?, steps_completed, iterations_completed?,
  stopped_by?, error?, manifest: [...] }
```

**Manifest.** `runFlow` already accumulates `results[]` via `compactActionResult`. A detached flow simply retains them, addressable by `flow_id`. Observation 3 needs **no new design** — it was never an audit problem, it was a consequence of the loop living in the page where the bridge could not see it.

**Audit event.** On completion, push **one** summary `bridge.event` (the channel at `packages/shared/src/index.ts:92` already exists) into `BridgeEventLog`. Exactly one per flow, never one per iteration — `MAX_EVENTS = 200` (`bridge/events.ts:55`) would otherwise be blown by a single 200-iteration run, silently evicting every other event. This is the constraint the field report flagged as needing thought before committing; a per-flow summary resolves it without raising the cap.

### Open design question — MV3 service worker termination

The extension is an MV3 service worker and can be terminated by Chrome. A detached flow must either survive termination or **fail loudly** — it must never appear to be running while dead, and must never silently resume and double-act. This is unresolved and must be settled _before_ implementation starts. Sketch of the options:

- Keep-alive while a detached flow is in flight, accepting the cost.
- Persist flow state to `chrome.storage.session` and, on service-worker restart, mark any in-flight flow `failed` with `stopped_by: 'worker-terminated'` and refuse to resume. Safest default: never auto-resume an irreversible-action loop.

The second is the conservative choice and the recommended starting point.

### Acceptance

- `detach: true` returns a `flow_id` without waiting for completion.
- `flow_status` reports accurate live progress mid-run and the full manifest after completion.
- `flow_cancel` on a detached flow stops it within one step; state becomes `cancelled` with partial manifest retained.
- A second detached flow on the same tab is rejected, naming the running id.
- Exactly one `bridge.event` per detached flow, regardless of iteration count.
- A 200-iteration detached flow does not evict unrelated entries from `BridgeEventLog`.
- Service-worker termination mid-flow produces `failed` / `worker-terminated`, never a phantom running state and never a resume.
- Both new tools appear in `TOOL_CATALOGUE` and honour `disabledTools`.

### Files

`packages/shared/src/index.ts` · `packages/server/src/permissions.ts` · `packages/server/src/tools/browser-definitions.ts` · `packages/server/src/tools/browser-dispatch.ts` · `packages/server/src/bridge/events.ts` · `packages/extension/src/background.ts` · `packages/extension/src/popup.ts` (surface detached flows in the slice-6 panel)

### README impact

Substantial, and the largest doc change in the program:

- `## What the agent can do` — the two new tools.
- `### Behavior worth knowing before you rely on it` — detached flows keep acting between agent turns; the popup Stop button is the kill switch; no auto-resume after a worker restart.
- `### Per-tool permissions` — two new catalogue rows.
- `## Security model` — a detached flow is the only thing in browser-link that keeps acting with no agent attached. State this plainly.
- `### v1 tool support` (cdp-direct) — parity status for both new tools.

### cdp-direct parity

`flow_status` / `flow_cancel`: yes — the in-process runner makes this easier than the extension path. The popup kill switch: no. Document the asymmetry.

---

## Program-level acceptance

- `MAX_FLOW_TIMEOUT_MS`'s justification is revisited in `DECISIONS.md` once slice 5 lands — the constraint it encodes no longer holds.
- The agent-instructions block teaches `repeat` + `sleep` as the default for bulk work, with raw `evaluate` explicitly demoted to the escape hatch it is.
- README is updated **within each slice's PR**, never deferred to a catch-up pass.
- Field-report observations 1b, 2, 3, 4 and 6 are retired by this program. Observations 1a and 5 are retired by slice 1 as documentation, and stay documentation permanently — `browser.evaluate` remains available and its traps remain real.
