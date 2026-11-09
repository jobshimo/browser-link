# Spec v3 — browser-link 1.0: live page model, plans with signals, pluggable resolver

> ## ⛔ SUPERSEDED — do not build from this document alone
>
> **Superseded by [`v4-page-observer-and-slices.md`](./v4-page-observer-and-slices.md) on 2026-11-06.**
> Kept verbatim. v4 keeps the 1.0 claim (§2) and the critique of v2 (§1), moves the live page model into the page as a measured **page observer**, removes the ML resolver from the 1.0 scope, and replaces the single 1.0 bundle with shippable slices; see §1 of v4 for what changed and why.
>
> *Original banner:*
>
> **Supersedes [`v2-signals-restarts-and-soft-execution.md`](./v2-signals-restarts-and-soft-execution.md).**
> Written 2026-11-06, after the 0.29–0.34 releases and a design conversation about what makes browser-link 1.0 different. v2's core (signals, restarts, latitude, content never enters the language) is **kept**; v3 settles where it lives, separates two things v2 called "model", and decides how machine learning enters, if at all. §1 records what changed and why.

**Status:** draft, in discussion · **Written:** 2026-11-06 · **Origin:** design conversation on 2026-11-06 (product framing for 1.0), building on v2 and on the features shipped in 0.29.0–0.34.1.

---

## 1. What changed from v2, and why

| v2 said | v3 says | Why it changed |
|---|---|---|
| A separate library, `@jobshimo/browser-plan`, with an **open** question on who owns the live page model (§5.4) | It is **browser-link 1.0** itself. The live page model belongs to the **bridge**; plans run inside browser-link | The owner wants it to be part of BL and plug and play. It also resolves §5.4: the model improves every existing tool at once, and the schema already lives in the map, which is the bridge's |
| "Live page model" (§5) and "local model" (§1) were both called *model* | They are two different things and are named apart: the **live page model** is a data structure (no ML); the **local model** is an optional ML component behind a port | The shared word caused real confusion in conversation ("activate the live model and download it"). One is always-on code; the other is an optional download |
| A local model makes execution decisions | Execution decisions go through a **resolver port**. The default adapter is **rules**; an ML adapter is **optional** and arrives in 1.x only if measured to beat rules | It is not yet known whether a model is needed. Most decisions in the evidence session were structural (resolved once, cached as schema), and an agent is already in the loop. A model only pays off if it avoids asking the agent in cases rules cannot resolve — that must be measured, not assumed |
| — | **No training for 1.0.** If an ML adapter ships, it starts from a small off-the-shelf model | Training needs data. The only meaningful data is the hardening loop's record of signals and restarts, which is per-user and private. Any training would be local or explicitly opt-in |

**Unchanged and load-bearing:** everything in v2 §2–§4 and §6–§7 (thesis, signals and restarts, latitude, defaults, caller cap, loud rung 4, soft-to-hard lifecycle, learning aimed at execution), and everything v2 inherited from v1.

---

## 2. The 1.0 claim

> **Browser automation where a failure is a question, not an exception — and that gets cheaper every time it runs.**

Today browser-link is a remote control: every decision, however small, is a round trip through the agent, and the cost is the inference behind each one. The market offers two shapes, and both fail in a known way:

| Shape | Strength | Failure |
|---|---|---|
| Scripts (Playwright-style) | cheap, fast | rigid; on the unexpected they crash and lose context |
| Browsing agents | flexible | every step is an inference; slow, expensive, nothing learned between runs |

1.0 occupies the middle: a plan runs on its own and, where judgment is needed, **parks with its state intact and asks** (v2 §3). Three pieces reinforce each other:

1. **Live page model** (§3) — cheap, exact perception.
2. **Plans with signals** (v2 §3–§4) — autonomy with declared latitude.
3. **Hardening loop** (v2 §6–§7) — recorded signals become schema and defaults; a plan that never asks has become a script.

### 2.1 What 0.29–0.34 already contributed

These shipped as tools and become 1.0 primitives rather than being replaced:

| Shipped | Becomes |
|---|---|
| `expect` on click/type/press (0.31.0), with transition semantics | a **signal source**: an unmet expectation raises a signal instead of failing |
| partial state on flow timeout, deadline, registry recovery (0.32.0) | the basis for **parking and resuming** a plan |
| map `mechanisms` and `pitfalls` (0.34.0) | the seed of the **app schema** (v2 §5.2) |
| 10-minute reconnect, `list_tabs` hint (0.33.0) | the bridge resilience a long-running plan needs |

---

## 3. Live page model — always on, no ML

A data structure the bridge keeps up to date from `MutationObserver` (v2 §5): `snapshot` returns diffs, `settle` reports what an action caused, elements keep a stable identity across re-renders.

- **Not optional, not downloaded.** It is code, shipped with the extension and the bridge, on by default. It is what makes every other piece cheap.
- **Identity across re-renders** stays the hard problem (v2 §5.3): semantic identity from role + accessible name + position in the meaning tree, not DOM node identity.
- Costs from v2 §5.3 still apply: mutation storms need coalescing and a budget; MV3 worker termination needs a cheap rebuild.

---

## 4. Resolver port — rules by default, ML optional

Every **execution** decision (never content) goes through one port. Examples: which candidate is the "advance" control; is this the view I already know; is this failure retryable; has the view settled.

```
            ┌──────────── ExecutionResolver (port) ────────────┐
 plans ───▶ │ resolve(question, live-model context) → answer   │
            │            + confidence, + "could not decide"    │
            └──────────────┬───────────────────────┬───────────┘
                           │                       │
                 RulesResolver (default)   ModelResolver (optional, 1.x)
                 heuristics, schema,       small local model, loaded
                 always available          lazily, falls back to rules
```

- **"Could not decide" is a first-class answer.** It raises a signal to the agent. Every such case is **recorded**: that record is the evidence that decides whether the ML adapter is worth shipping.
- **Fallback is mandatory.** If the model is missing, broken or slow, the port answers with rules. ML is an accelerator, never a dependency.

### 4.1 Plug and play (when the ML adapter ships)

- One command, e.g. `browser-link model enable`: downloads into the browser-link data dir, verifies a checksum, records the version.
- Loaded lazily on first need, in-process on CPU inside Node (no Python, no GPU required). Unloaded when idle if memory matters.
- If a local runtime the user already has (e.g. Ollama) is detected, it may be offered as an alternative backend.
- `browser-link model disable` / `status` mirror the existing `config` and `cdp` command style.
- Candidate shape to evaluate first: a small embedding model that compares element descriptions with intents. Size and runtime to be confirmed by measurement, not assumed.

---

## 5. Release order (proposed, pending owner decision)

1. **1.0:** live page model + plans with signals + resolver port with the rules adapter + recording of "could not decide".
2. **1.x:** ML adapter, only if the recorded "could not decide" rate shows rules are not enough on real apps.
3. **Later:** local fine-tuning from the hardening loop, opt-in only.

---

## 6. Open questions

- **[open — awaiting owner]** Does the ML adapter ship in 1.0, or in 1.x after measurement? (Recommendation in §5: 1.x.)
- **[open]** The metric and threshold that justify the ML adapter (e.g. "could not decide" rate per 100 resolutions, and the agent round trips it would save).
- **[open]** Package shape: plans as a module inside `@jobshimo/browser-link`, or a workspace package published together with it.
- **[open]** Everything still open in v2 §8, except §5.4 (ownership), which v3 resolves in favour of the bridge.
