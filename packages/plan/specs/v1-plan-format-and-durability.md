# Spec v1 — `@jobshimo/browser-plan`: a portable, durable plan format for browser automation

> ## ⛔ SUPERSEDED — do not build from this document
>
> **Superseded by [`v2-signals-restarts-and-soft-execution.md`](./v2-signals-restarts-and-soft-execution.md) on 2026-08-15.**
> Kept verbatim as the record of the first iteration. See §1 of v2 for what changed and why.
>
> **Still valid here:** the three-layer principle (§3), the "no expression language" rule (§3.1), the `FlowDeps` seam analysis (§4), `expect` (§5.4), deadline execution (§6.1), durability and security (§7–8), and the session evidence (Appendix A).
>
> **Wrong here:** the `choice` primitive as a judgment resolver with a resolver chain, decision memoisation, and the framing that content judgment belongs inside the language. v2 removes all three.

**Status:** superseded · **Written:** 2026-08-15 · **Cost:** L (multi-slice program) · **Origin:** the Anthropic Academy session of 2026-08-15 (22 courses, ~460 lessons, 325 quiz questions, 39 graded quizzes; see `INFORME-SESION-CURSOS.md` and the Appendix below).

**Relationship to prior work.** This program **continues** `docs/specs/flow-supervised-execution.md` (all six slices shipped, v0.23.14 → v0.27.0) and is **consistent with `DECISIONS.md` §13**: the loop still runs in the bridge, never in the page. Nothing here revives the rejected `window.__job` design. See §3.3 for why.

> This document is under active discussion and will keep growing. Sections marked **[open]** are unsettled.

---

## 1. Does this pass the repo's own test?

This repo rejects tools that turn out to be patterns an agent did not know (ROADMAP items 2, 3a, 3b, 5 — "resolved as protocol"). Before anything else, this program must survive that test.

**It does, and the evidence is a measured six-hour session.**

### 1.1 The agent abandoned `flow` and never came back

Every `browser.flow` call in a six-hour, 39-quiz session happened in the **first hour**. The remaining ~35 quizzes used none. Not because flow was broken — because the work was shaped `perceive → decide → act`, and flow is explicitly "strictly sequential, fail-fast, **no branching**". The moment a decision depends on a value just read, flow cannot express it and the agent falls back to `browser.evaluate`.

That is the same inverted value curve `DECISIONS.md` §13 identified, one level up: **flow protects action sequences you already know; it cannot protect the loop you actually run.**

### 1.2 The workaround was structurally unsafe, and it worked by luck

Lacking expressible decisions, the agent injected a helper into the page:

```js
window.__q = async (pick) => { /* answer, advance, return the next question */ };
```

This collapsed ~700 tokens per question to ~30 and was the single biggest efficiency win of the session. It is also **exactly the pattern this repo already rejected**, and it only worked because Skilljar's quiz is plain DOM that happens to honour a synthetic `.click()` on a radio.

The boundary is not a matter of taste — it is in the source:

| Verb | Dispatch | File |
|---|---|---|
| `click` | `Input.dispatchMouseEvent` | `packages/extension/src/background.ts:1134` |
| `press` | `Input.dispatchKeyEvent` | `packages/extension/src/background.ts:669` |
| `type` | `Input.insertText` | `packages/extension/src/background.ts:1191` |
| `drag` | `Input.dispatchMouseEvent` | `packages/extension/src/background.ts:1457+` |

All four are **trusted** (`isTrusted: true`). Page-side JS can never produce them. On a rich editor, a canvas app, or a Qt-WASM runtime, `window.__q` would have failed **silently** — the precise failure mode the agent-instructions block warns about.

So the pattern is not a cheaper substitute for a tool. It is an unsafe one that happens to work on easy pages, and the agent will keep reaching for it as long as decisions are inexpressible.

### 1.3 The repetition is measurable

`window.__q` dies on every navigation, and each quiz lives at its own URL. The agent re-pasted the same ~1,300-token helper **roughly 30 times** — on the order of **40,000 tokens of pure repetition**, and ~40 additional round trips spent on `navigate` followed immediately by `evaluate`.

**Verdict: a real gap.** A pattern cannot close it, because the pattern is the thing that is unsafe.

---

## 2. The root pain

An agent's unit of work is `perceive → decide → act`, repeated. Today **every arrow crosses an MCP boundary**, and each crossing is a full LLM inference — the real cost, far above the round trip itself.

`flow` moves `act → act → act` across once. It cannot move `perceive → decide` across at all, because it has no way to hold a value or branch on it. So the agent must choose between:

- **Safety without expressiveness** — `flow`, which cannot decide; or
- **Expressiveness without safety** — `evaluate`, which cannot actuate.

Every non-trivial task takes the second, and loses trusted input, the occlusion guard, the recovery snapshot and the action manifest along with it.

**This program removes the choice.**

---

## 3. Core principle

> ### The plan orchestrates. JavaScript computes. CDP actuates.

Three layers, each doing only what it is uniquely able to do:

| Layer | Responsibility | Why it must be there |
|---|---|---|
| **CDP** (bridge) | Actuation: click, type, press, drag, navigate, dialogs, screenshots | Sole source of `isTrusted` input. Non-negotiable browser security boundary. |
| **JavaScript** (page) | Perception and computation: read the DOM, derive values, decide | Native language of the environment; already has a debugger, real types, and the whole web platform. |
| **The plan** (bridge) | Orchestration only: sequence, iterate, branch, and **move values between the two layers above** | Serializable, inspectable, versionable, replayable, transport-agnostic. |

### 3.1 The rule that prevents an inner platform

Every JSON DSL that grows conditionals eventually grows an expression language, then arithmetic, then a type system, then a debugger — and ends up a worse JavaScript. GitHub Actions, Ansible/Jinja and JSONLogic all took that road.

**The plan format has no expression language. Ever.**

Interpolation is **path lookup only** on already-computed bindings: `{{ q.selector }}`, `{{ rows[0].id }}`. There is no `+`, no comparison, no function call, no ternary.

> **When someone asks for `{{ count + 1 }}`, the answer is: that is an `evaluate` step.**

This single rule is what keeps the format small forever. It must be defended in review; it is the difference between a durable format and a bad language.

### 3.2 Corollary: the verb set is closed

Every verb costs an implementation in **each transport** (today: extension and cdp-direct, kept in lockstep by `packages/server/src/cdp/drift.test.ts`; `drag` is already a deliberate stub on cdp-direct). That is a permanent tax.

`evaluate` is the escape hatch that stops verb proliferation: anything that is pure DOM work is a computation, not a new verb.

### 3.3 Why this does not revive the rejected page-side worker

`DECISIONS.md` §13 rejected `window.__job` because **cancelling a promise loop that lives in the page is inherently cooperative** — it can only raise a flag the worker chooses to read, and cannot interrupt a hung `await`.

That objection is untouched here. **The loop still runs in the bridge.** `runFlow` still owns dispatch, so cancellation still means *not dispatching node N+1*, with a worst-case latency of one node. An `evaluate` node is a single awaited value — the same shape as `performFind` today — not a loop that owns the schedule.

The distinction is exact: §13 rejected *the page owning control flow*. This spec gives the page *computation*, and keeps control flow in the bridge.

---

## 4. Architecture

### 4.1 The seam already exists

`FlowDeps` (`packages/extension/src/flow.ts:319`) is a clean injection port: the executor is a pure orchestrator over `performFind` / `performClick` / `performType` / `performPress` / `performWaitFor` / `performDrag`, plus `shouldCancel`, `onProgress` and `buildRecoverySnapshot`. It already knows nothing about transports, which is why the same runner serves the extension and cdp-direct.

This program adds `performEvaluate` to that port and leaves the shape intact.

**Constraint carried forward:** any `FlowDeps` change touches both copies (`packages/extension/src/flow.ts`, `packages/server/src/cdp/flow.ts`) and must keep `cdp/drift.test.ts` green.

### 4.2 Capability matrix by transport

A plan declares what it needs; a transport declares what it has. Mismatch fails **before** the first dispatch, not halfway through.

| Node | extension | cdp-direct | playwright (future) |
|---|---|---|---|
| `find` / `click` / `type` / `press` / `wait_for` | ✅ | ✅ | ✅ |
| `drag` | ✅ | ❌ (stub, by design) | ✅ |
| `evaluate` | ✅ | ✅ | ✅ |
| `sleep` / `repeat` / `for_each` / `if` | ✅ | ✅ | ✅ |
| `console` / `network` / `dialog` / `screenshot` | ✅ | ❌ | partial |

### 4.3 Package layout **[open]**

```
packages/plan/
  SPEC.md                 ← this document
  src/
    schema/               ← the plan format: types, JSON Schema, validator
    runtime/              ← transport-agnostic executor (lifted from flow.ts)
    authoring/            ← TypeScript DSL (deferred; see §9)
    transports/           ← adapters implementing the deps port
```

Open: whether the executor is **lifted out of** `packages/extension` and `packages/server/src/cdp` into this package (removing the duplication and retiring the drift test), or whether this package initially only owns the schema. Lifting is the honest end state; doing it in slice 1 risks a large, hard-to-review diff on shipped, working code.

---

## 5. The plan format

### 5.1 Envelope

```jsonc
{
  "plan_version": 1,          // format version — REQUIRED from day one
  "name": "answer-quiz",      // stable identity for storage and replay
  "params": { "answer": "string" },  // typed inputs
  "requires": ["evaluate"],   // capabilities; checked against the transport up front
  "nodes": [ /* ... */ ]
}
```

`plan_version` exists before the first plan is ever stored. Retrofitting a version field onto durable artifacts is one of the classic expensive mistakes.

### 5.2 Nodes

Carried over unchanged: `find`, `click`, `type`, `press`, `wait_for`, `drag`, `sleep`, `repeat`.

**New:**

#### `evaluate` — perception and computation

```jsonc
{ "evaluate": { "expression": "(() => ({ n: document.querySelectorAll('li').length }))()",
                "as": "list",
                "timeout_ms": 15000 } }
```

Runs in the page, returns JSON, binds it under `as`. This is the only node that computes. Its result is a **value**, never control flow.

#### `for_each` — iteration over a runtime value

```jsonc
{ "for_each": { "in": "list.items", "as": "item", "max": 200, "steps": [ /* ... */ ] } }
```

`max` is **mandatory**, deliberately mirroring `repeat.max_iterations` (DECISIONS §13) so the worst case stays statically computable.

#### `if` — branching on an already-computed value

```jsonc
{ "if": { "cond": "list.isEmpty", "then": [ /* ... */ ], "else": [ /* ... */ ] } }
```

`cond` is a **binding path**, evaluated for truthiness. Not an expression. If you need a comparison, compute the boolean in an `evaluate`.

### 5.3 Bindings and interpolation

- Bindings are created by `evaluate` (`as`), by `find` (its resolved selector), and by `for_each` (per-iteration item).
- Any string param may interpolate: `{{ path.to.value }}`.
- Grammar is **path lookup only**: identifiers, dots, integer indices. Nothing else parses.
- Unresolved path ⇒ hard error naming the path and the node. Never silent empty-string substitution — that class of bug produced the session's only wrong answer (Appendix A.3).

### 5.4 `expect` — postconditions on actuation

```jsonc
{ "click": { "selector": "a.next", "expect": { "url_changed": true } } }
```

Closed predicate vocabulary (no expressions): `url_changed`, `selector_appears`, `selector_gone`, `focus_moved`, `binding_truthy`.

**This is structural, not cosmetic.** A durable plan replayed against a changed UI must fail loudly rather than do something else quietly. The session lost ~3 minutes and 8 calls to a `click` that returned `ok: true`, `mutation_count: 0` and did nothing, because the anchor used `onmouseup` (Appendix A.2). `settle` proves *quiet*, not *effect* — a replayable format needs a way to assert effect.

### 5.5 Cost model **[open]**

`MAX_FLOW_STEPS = 20` becomes ambiguous once `for_each` and `if` nest. Proposal: count **nodes** in the flattened tree against `MAX_PLAN_NODES`, and keep a separate nesting-depth cap. Exact numbers unsettled.

---

## 6. Execution model

### 6.1 From static budget to deadline + partial results

Today the up-front 60s rejection depends on the worst case being statically computable — which is exactly why `repeat` forbids nesting and mandates `max_iterations`.

`for_each` over a runtime-sized array preserves a static bound only through its mandatory `max`, which is a blunt instrument. The format therefore moves to **deadline-based execution**:

- A plan runs under a wall-clock `deadline_ms`.
- On expiry it stops cleanly and returns `{ ok: true, stopped_by: "deadline", nodes_completed, results, bindings }`.
- The static projection (`dry_run`) still reports the worst case, now as guidance rather than as an admission gate.

**Note the convergence:** this is precisely the fix the session asked for independently. A `repeat` of 14 iterations declared ~15s of budget, actually ran >50s (each `settle` may burn its full `settle_timeout_ms`, plus page load), hit the tool timeout and returned **nothing at all** about 14 iterations of work (Appendix A.1). Under a deadline model that same run returns what it completed. The feature the durability goal requires and the bug the session hit have the same fix.

This also honours the shipped cancellation contract: a cancelled flow is `ok: true` with partial results, precisely because "the one thing the caller must not be told is that the partial work did not happen" (`flow.ts:385`).

### 6.2 Observability

- `onProgress` extends to node paths (`3.for_each[7].2`) rather than flat indices.
- Nodes may carry an optional `label`; errors quote the label, never a bare index.
- `dry_run` extends to project **binding shapes**, so a plan can be checked before it touches anything.
- The action manifest (v0.27.0) gains binding snapshots per node — bounded, and subject to §8.

---

## 7. Durability

Plans are **durable, public artifacts**. That decision (2026-08-15) drives everything in this section, and it is why `expect`, versioning and hashing are in slice order rather than deferred.

- **Identity:** `name` + content hash. A stored plan is immutable; editing produces a new hash.
- **Storage:** first-class rows in the map DB, versioned, separate from the current free-form `flows` recipes.
- **Replay policy:** replaying a stored plan re-validates `plan_version`, `requires` against the transport, and every `expect`. A plan whose postconditions fail is a **failure**, never a partial success.
- **Compatibility:** additive changes bump minor; any change to node semantics bumps `plan_version` and ships a documented migration. **[open]** — whether old versions are executed by a compatibility shim or refused with an explicit upgrade path.

---

## 8. Security model

A stored, replayable plan containing `evaluate` is **executable code living in a database**. `browser.evaluate` already exists, so the capability is not new — but *durable, replayable, shareable* code is.

Non-negotiables:

1. A plan containing `evaluate` is **never** auto-replayed from the map without its source being surfaced to the agent and to the human.
2. Plans are content-hashed; the popup shows the full plan before a detached run starts.
3. `map.save` refuses to store a plan containing `evaluate` without an explicit flag.
4. Plans never capture page content or domain data into bindings that get persisted — the existing map rule ("UI structure only, never domain data") extends to binding snapshots.
5. The cdp-direct kill switch (`browser-link cdp revoke`) must stop a running plan within one node, exactly as it does for flows today.

**[open]** — whether an imported third-party plan (a real possibility once this is public) needs a distinct trust tier, e.g. `evaluate` disabled unless locally signed.

---

## 9. TypeScript authoring DSL (deferred, but constrains the format now)

Deferred to a later program, **not dropped**. It ships after the JSON format has been validated by real use.

Rationale — and this corrects an earlier position taken in discussion, which assumed single-session usage:

- These artifacts are **public and durable**, so humans will read and review them in PRs.
- Typing serves agents too: a typed builder makes an invalid plan **unrepresentable** at author time instead of caught at runtime.

What that means for the JSON format **today**, so the DSL is not painted into a corner later:

- Every node is a single-key object (`{ evaluate: {...} }`) — trivially mapped to a builder method.
- Binding names are declared (`as`), never implicit, so the builder can thread a growing binding type through the chain.
- `params` are typed in the envelope, so a plan becomes a callable typed function.
- Interpolation paths must be expressible as typed accessors — which is another reason the grammar stays at path lookup.

---

## 10. Slices **[open — order under discussion]**

Each slice is independently shippable and updates the README in the same PR.

1. **`evaluate` node + bindings + path interpolation.** Covers ~80% of the session's pain with no control flow at all. Absorbs the `define`/`invoke` idea as a degenerate case: a named helper is a one-node plan.
2. **`expect` postconditions + deadline execution with partial results.** Makes plans safe to replay; fixes the two silent-failure classes the session hit.
3. **`for_each` + `if`.** Control flow, with mandatory `max`.
4. **Plans as first-class map artifacts.** Identity, hashing, versioning, `plan.run(name, args)`.
5. **Executor lifted into `packages/plan`**, both existing copies retired, drift test replaced by a shared implementation.
6. **Playwright transport.** The point at which this stops being a browser-link feature and becomes a library.
7. **TypeScript authoring DSL.**

---

## 11. Open questions

- **[open]** Does slice 1 lift the executor, or only add the node in place? (§4.3)
- **[open]** Node budget: exact `MAX_PLAN_NODES` and nesting depth. (§5.5)
- **[open]** Compatibility strategy for old `plan_version`s. (§7)
- **[open]** Trust tier for imported third-party plans. (§8)
- **[open]** Does `evaluate` get a page-side standard library (`bl.find`, `bl.visible`) so common perception is not hand-rolled per plan — and if so, is that a third artifact to version?
- **[open]** Relationship between stored plans and the existing map `flows` recipes: migration, or coexistence?

---

## Appendix A — Session evidence

Measured during the Anthropic Academy run (2026-08-15). Each item motivates a specific section above.

**A.1 — `flow` budget underestimates by 3–4× and loses everything on timeout.** A `repeat` of 14 iterations declaring `settle_ms: 650` + `delay_ms: 450` (~15s projected) ran past **50s** and returned nothing. Cause: the budget uses `settle_ms`, but the worst case is `settle_timeout_ms` plus page-load time. Three further calls were spent discovering it had completed **zero** iterations. → §5.4, §6.1

**A.2 — `click` reports success on an inert element.** `a.next-lesson-link` (an `onmouseup` handler) returned `{ ok: true, settle: { mutation_count: 0, settled: true } }` and did not navigate. → §5.4

**A.3 — Classifying by prose instead of by structure produced the session's only wrong answer.** A helper decided "survey vs knowledge question" with a regex over the *question text* (`/satisfi|recommend|happy|likely/`). A knowledge question reading "What problems will you **likely** face?" tripped it, was auto-answered, and scored 7/8. The fix was to classify by the **shape of the answer space** (are all options a scale?), not by wording. Generalises to §5.3: never silently substitute; fail on unresolved paths.

**A.4 — The mechanism that mattered was not discoverable through any tool.** A plain `fetch()` GET of a lesson URL marks it complete server-side, turning a ~15-call course into **one**. Found by hypothesis, not by tooling — and the map had no category to record it in, since it is neither UI structure nor domain data. → motivates the `mechanism` map category (tracked separately, not in this spec).

**A.5 — Volume.** ~460 lessons, 325 questions, 39 graded quizzes at 100%. Cost per course fell from ~20 calls to ~4 once the mechanism in A.4 was found; per-question cost fell from ~700 tokens to ~30 once the helper was injected. Both wins came from outside the sanctioned tool surface — which is the point of this program.
