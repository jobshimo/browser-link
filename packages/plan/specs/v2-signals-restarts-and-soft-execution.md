# Spec v2 — `@jobshimo/browser-plan`: signals, restarts, and soft execution

> ## ⛔ SUPERSEDED — do not build from this document alone
>
> **Superseded by [`v3-bl-1.0-live-model-and-resolver.md`](./v3-bl-1.0-live-model-and-resolver.md) on 2026-11-06.**
> Kept verbatim. v3 keeps this document's core (§2–§4, §6–§7) and resolves §5.4; see §1 of v3 for what changed and why.
>
> *Original banner:* Supersedes [`v1-plan-format-and-durability.md`](./v1-plan-format-and-durability.md). Written 2026-08-15, same day as v1, after a design conversation that moved the thesis. §1 records what changed and why — read it before anything else.

**Status:** draft, in discussion · **Written:** 2026-08-15 · **Cost:** L · **Origin:** design conversation following the Anthropic Academy session (evidence in v1 Appendix A and `INFORME-SESION-CURSOS.md`).

---

## 1. What changed from v1, and why

v1 was written after one long session and got the *substrate* right and the *thesis* wrong. The conversation that followed cut more than it added. That is the useful part of the record.

| v1 said | v2 says | Why it changed |
|---|---|---|
| The language resolves **meaning**, including content ("which answer is correct") | **Content never enters the language.** It leaves to the agent, which reasons over it from its prompt | Judgment is the agent's job when it reasons. Modelling it inside the language builds a cathedral over what is, mechanically, a yield. |
| `choice` = a judgment point with a chain of resolvers (`model`, `human`, `policy`, `program`) | `choice` as a judgment primitive is **removed**. What survives is a **signal**: the plan parks, hands out a value, and resumes | Same reason. The seam is trivial; the machinery around it was solving the wrong layer. |
| Memoise decisions so repeated judgments get cheap | **Removed.** Content is never cached | The memo key would have to be semantic *and* re-resolved against the live page. Aimed at content it is a confident liar — direct evidence in v1 Appendix A.3. Aimed at **execution** it returns in §7. |
| A **local model** ranks candidate answers | A local model makes **execution** decisions: which candidate is the advance button, has the view settled, is this failure retryable, is this the view I already know | The local model is not there to make judgment calls on the agent's behalf. It is there to make execution decisions cheap enough to happen inline. |
| The node declares **who** may handle a failure (`model` / `human` / …) | **Removed.** The language never declares who is on the other side | Unenforceable — every answer arrives over the same channel, and a plan cannot verify a human typed it. It also contradicted v1's own rule that the language must never name a model. Routing is deployment config, not plan content. |
| `expect` failure aborts the node | `expect` failure **signals**, and the plan parks with its state intact | This is the whole of v2. See §3. |

**Unchanged and still load-bearing:** three layers (§2), no expression language, the `FlowDeps` seam, deadline execution with partial results, durability and security, and the session evidence.

---

## 2. Thesis

> ### The language covers the **mechanical** and the **structural**. Content never enters it.

Three kinds of decision appear in browser work. Only two of them belong to a language:

| Kind | Example | Cost | Lives where |
|---|---|---|---|
| **Mechanical** | does it exist, is it visible, how many are there | µs | code / oracle |
| **Structural** | "the control that advances this view", "the option list" | resolve once → **cacheable as app schema** | code, local model |
| **Judgment** | which of these four answers is correct | expensive, every time | **the agent, outside the language** |

The proof that this split is real came from the session itself: one hand-written page helper answered **39 quizzes across 22 courses without a single change**. The structure of a quiz was constant; only the content varied. What was re-derived 39 times was not *how a quiz works* — that was known after the first one. It was re-derived because there was nowhere to put it.

**So: the language's intelligence is about how execution proceeds, not about what the answer is.**

The vocabulary follows from the execution decisions actually made during the session, none of which are content:

- **Strategy** — hard `navigate` or route inside the SPA; walk the UI or `fetch` in parallel; batch size; one course per call or four.
- **Fallback** — the click had no effect, switch approach; the flow timed out, find where it got to and resume; the helper died on navigation, reinstall it.
- **Budget** — guard at 44s and return partial; how many items before yielding.
- **Perception** — full snapshot or targeted read; re-scan or trust what is already known.
- **Structural reuse** — this view has the same shape as the previous 38, use the known interaction; is enrolment needed, check for a checkout link.

Those five families are the language.

---

## 3. The core: signals and restarts

The mechanism is **Common Lisp's condition system**, not `try`/`catch`. That lineage is deliberate: the semantics are forty years proven and we do not have to invent them.

### 3.1 Why `catch` is the wrong shape

A `catch` **unwinds the stack**. By the time the handler runs, the context where the failure happened is gone — its variables, its position, its state. That is why a catch block can only log, rethrow, or fall back to something written in advance.

A **signal does not unwind**. The handler runs *at the point of the failure*, with state intact, and what it chooses is not an error to throw but a **restart** — one of a menu of resumptions the failing code itself declared:

```lisp
(restart-case (do-the-thing)
  (retry ()        ...)
  (use-value (v)   ...)
  (skip ()         ...)
  (abort ()        ...))
```

And the detail that makes it exactly what this project needs: **Lisp's interactive debugger is just another handler.** When no automatic handler knows what to do, the last one in the chain stops and asks a human which restart to invoke. The human looks, changes a value, picks `retry`, and **the program continues from where it was**.

### 3.2 Why it never caught on, and why it does now

It is not that nobody proposed this — it shipped, it worked, and the industry dropped it. The reason is concrete: in a compile-and-deploy world **there is nobody to ask at runtime**. Handlers must be code written in advance, so the expressive half of the mechanism (stop and consult) had no interlocutor and atrophied. What survived is `catch`, the dumb half.

Agents break that premise. For the first time there *is* someone to ask at runtime, and asking is cheap enough to be ordinary rather than exceptional. The mechanism was waiting for the interlocutor to exist.

### 3.3 One mechanism, five things

Everything this project had been designing separately collapses into it:

| Previously called | Actually |
|---|---|
| `expect` fails | a signal with restarts `retry / use_value / skip / abort` |
| confirm before 956 irreversible deletions | a signal with **no default** — it parks and does not proceed |
| "the click did nothing" | a signal, state intact, DOM diff as context |
| handing content out to the agent | a signal whose restart is `use_value` |
| validating a result that was *not* an error | a signal that is not a failure — a checkpoint |

When five separately designed things turn out to be one, that is the core.

---

## 4. Softness is declared by the author

Hardness is not a property of the language. The language offers a range; **whoever writes the plan chooses where each signal point sits on it.**

### 4.1 Latitude — how much a handler may do

| # | The handler may | Replay consequence |
|---|---|---|
| 0 | nothing — the failure is terminal | trivial |
| 1 | **choose** a declared restart (`retry`, `skip`, `abort`) | trace is a list of choices from a known menu |
| 2 | **supply** a value where the node declared its shape (`use_value(selector)`) | replayable if values are recorded (lockfile) |
| 3 | **extend** — insert nodes here, from an allowlist, under a cap | executed program ≠ authored program, but the delta is bounded and typed |
| 4 | **rewrite** the remaining plan | the executed program **is a different artifact** |

The real cost of latitude is not risk — it is that from rung 3 onward **the program that ran is not the program that was written**. That is not disqualifying; it is something that must be visible.

### 4.2 Default — what happens when nobody answers

Independent of latitude, and it is what replaces the rejected "who may handle" dial:

- **has a default** (restart + timeout) → if nobody answers within T, it resolves itself and continues.
- **has no default** → it parks indefinitely until someone answers.

The protection for an irreversible action is *"no default"*, not *"a human must answer"*. The first is enforceable by the runtime; the second is not, because every answer arrives over the same channel and a plan cannot verify who typed it. Who is reachable is decided by deployment (which channels a run publishes signals on), never by the plan.

### 4.3 The caller cap

**A node declares its maximum latitude; an invocation may lower it, never raise it.**

Enforceable, because it is the same runtime. A plan may say "rung 4 acceptable here", while a detached run with nobody watching says "nothing above rung 2 in this execution". Without this, a third-party plan ships its own authorisation, which is exactly wrong once plans are public.

### 4.4 Rung 4 must be loud

Rewrite is also how an agent could quietly do something else and report success. Not forbidden — but impossible to hide: a run that used `rewrite` is marked, the plan diff is part of the result, and it cannot be promoted to a stored plan without review.

### 4.5 Open — granularity

**[open]** Is latitude declared per node, per plan, or both (plan-level default with per-node override)? Per node is precise and verbose; per plan is one legible line but cannot distinguish a trivial click from an irreversible delete. Current lean: both.

---

## 5. Substrate: a live model of the page

Execution decisions can only be cheap if perception is cheap. Today every call is a fresh photograph: `snapshot` walks the DOM, `find` walks the DOM, and between calls the bridge knows nothing.

The substrate this language needs:

- **A live page model**, fed by `MutationObserver`, updated incrementally. `snapshot` becomes a **diff** — "since you last looked, these three nodes appeared, this one's text changed" — instead of a dump that was 95% identical to the previous one.
- **The unit of change becomes the mutation, not the navigation.** In an SPA, changing a tab invalidates a region, not the world.
- **Stable identity across re-renders**, so a handle to "the question container" survives a React remount.
- **`settle` becomes exact.** It stops being "nothing moved for 150ms" and becomes "here is what the click caused". This fixes at the root the failure v1 Appendix A.2 patched with `expect`: `mutation_count: 0` stops being a category that proves nothing.

### 5.1 Navigation is an intent, not an instruction

The session issued ~40 hard `navigate` calls. Each discards the whole world. On an SPA that is self-harm: the app was going to change one region and was forced to rebuild itself.

A plan should express the destination; the executor picks the means and prefers the one that preserves the model — routing inside the app when it is an SPA, a hard navigation when it is an old MPA.

### 5.2 App schema

What the persistent map always wanted to be, and stopped halfway: it stores individual selectors, not the **shape of an interaction**.

```
app: skilljar
  view: quiz
    question  → #sj-quiz-question-text
    options   → input[name=answer], label = label text
    progress  → .question-number
    advance   → button matching /next question|submit/
    transition: advance → next question | results
```

With that, "answer a quiz" is a plan written against the **schema**, portable to any course, and the only per-instance thing left is the value handed out to the agent.

**Authorship:** derived from a successful run, proposed by the agent, and **validated by re-execution** before being trusted. Never from a single observation.

### 5.3 Costs, honestly

1. **Identity across re-renders is the hard problem.** React unmounts and remounts; the "same" logical element is a different DOM node. Identity must be semantic (role + accessible name + position in the meaning tree), not node identity. This is where the effort goes and where the project is won or lost.
2. **`MutationObserver` on a page with ads or tickers** fires thousands of times per second. Needs coalescing, subtree filtering and a budget.
3. **MV3 service worker termination** drops the model. Needs a cheap rebuild path.

### 5.4 Open — ownership

**[open]** Does the live page model belong to **browser-link** (every existing tool improves at once: `snapshot` returns diffs, `find` queries the model, `settle` becomes exact) or to **this library** (perception designed end-to-end for the schema, but two perception models coexist)? Current lean: the bridge, because the model is what makes the schema useful and the schema already lives in the map, which is the bridge's.

---

## 6. Plan lifecycle: soft is how a plan is born, hard is what it matures into

The same language serves two authorship modes, and latitude is what distinguishes them:

- **Ad-hoc** — the agent composes a plan now, for this. Soft is right. Replay barely matters; speed does.
- **Durable** — stored, versioned, public, replayed by others. Every soft point is a liability.

The bridge between them is mechanical:

> **The agent improvises soft → the restarts it needed are recorded → those restarts are exactly the backlog for hardening.**

A plan that took `use_value` three times at the same node is telling you which node is badly written. A plan that ran five times without raising a signal is ready to drop to rung 0.

Softness is not sloppiness; it is an early stage with a measured exit.

---

## 7. Where learning returns, correctly aimed

v1's memoisation was aimed at content and was wrong. Aimed at **execution** it is exactly right:

> *"The last N times this signal fired, the chosen restart was `use_value` with the same correction — make it the default handler?"*

That learns about execution, which is this language's layer. It is proposed, never silent; recorded in the manifest as *resolved from policy, not from judgment*; and always revocable.

---

## 8. Open questions

- **[open]** Latitude granularity: per node, per plan, or both. (§4.5)
- **[open]** Ownership of the live page model: bridge or library. (§5.4)
- **[open]** Does rung 3 (`extend`) earn its complexity, or is the useful set {0, 1, 2, 4}?
- **[open]** Node budget and nesting depth once control flow exists. (v1 §5.5)
- **[open]** Compatibility strategy across `plan_version`. (v1 §7)
- **[open]** Trust tier for imported third-party plans. (v1 §8)
- **[open]** Relationship between stored plans and the map's existing `flows` recipes.

---

## 9. Inherited from v1, unchanged

Read these sections in v1; they were not revised:

- §3 three layers · §3.1 the no-expression-language rule · §3.2 closed verb set · §3.3 consistency with `DECISIONS.md` §13
- §4 the `FlowDeps` seam and the transport capability matrix
- §5.1–5.3 envelope, nodes, bindings and path interpolation
- §5.4 `expect` (now a signal source rather than an abort)
- §6.1 deadline execution with partial results
- §7 durability · §8 security · §9 the deferred TypeScript authoring DSL
- Appendix A — session evidence
