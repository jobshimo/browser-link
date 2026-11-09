# `@jobshimo/browser-plan` — spec index

This package is designed in versioned specs. **This file is an index only — it contains no design.** Each version is kept verbatim so the evolution of the idea is auditable; nothing is ever rewritten in place.

## Current

| Version | Document | Thesis |
|---|---|---|
| **v4** | [`specs/v4-page-observer-and-slices.md`](./specs/v4-page-observer-and-slices.md) | The 1.0 **foundation** is a **page observer**: code re-injected into every document of a connected tab, one observer per root (shadow roots open and closed, same-origin frames), coalesced summaries pushed to the host, identical on both transports. Ships in three slices that each improve existing tools: exact `settle`, `snapshot` as a diff, stable element identity. Decided with lab measurements (`lab/2026-11-06-live-page-model/`), not leans. ML resolver removed from the 1.0 scope; plans and signals follow in v5 on top of the observer. |

**Build from v4**, reading v3 §2 for the 1.0 claim and v2 §2–§4 and §6–§7 for the plans layer it leads to. v4's §1 is a diff against v3; §3 is the diagnosis of the current code; §4 is the evidence.

## History

| Version | Date | Document | Status | What it got right | What it got wrong |
|---|---|---|---|---|---|
| v1 | 2026-08-15 | [`specs/v1-plan-format-and-durability.md`](./specs/v1-plan-format-and-durability.md) | superseded | Three layers (plan orchestrates / JS computes / CDP actuates); the no-expression-language rule; the `FlowDeps` seam; `expect`; deadline execution; durability and security; the session evidence | Put **content judgment inside the language** (`choice` with a resolver chain, decision memoisation), and declared **who** may handle a failure — unenforceable, and inconsistent with its own rule that the language must never name a model |
| v2 | 2026-08-15 | [`specs/v2-signals-restarts-and-soft-execution.md`](./specs/v2-signals-restarts-and-soft-execution.md) | superseded | Signals and restarts as the core; latitude declared by the author; content never enters the language; soft-to-hard lifecycle; learning aimed at execution | Left ownership of the live page model open, and used "model" for both a data structure and an ML component, which conflated them |
| v3 | 2026-11-06 | [`specs/v3-bl-1.0-live-model-and-resolver.md`](./specs/v3-bl-1.0-live-model-and-resolver.md) | superseded | The 1.0 claim ("a failure is a question, not an exception"); separating the live page model from any ML; the shipped 0.29–0.34 tools as 1.0 primitives | Said the model "belongs to the bridge, fed by `MutationObserver`" when the observer only exists in the page and browser-link has no content script; bundled three majors into one 1.0; specified an ML adapter's download and runtime before measuring whether one is needed; decided the architecture by lean where a lab could decide it by measurement |
| v4 | 2026-11-06 | [`specs/v4-page-observer-and-slices.md`](./specs/v4-page-observer-and-slices.md) | **current** | — | — |

## Lab

`lab/` holds the experiments a spec cites: scripts, pages, and unedited results, with a README per session mapping each number to its file. A spec may be built from a lab result; a lab result is never edited after the fact.

## Conventions

- A new version is a **new file**, never an edit of an older one.
- Every version carries a status banner at the top (`CURRENT` / `SUPERSEDED by …`), so a document opened directly — without passing through this index — still announces whether it should be built from.
- A superseded document is never deleted or corrected. Its errors are part of the record.
- Each new version opens with a diff against its predecessor: what changed, and **why** the previous position was abandoned. The reasoning matters more than the conclusion.

## Origin

The whole program comes from a measured session on 2026-08-15: 22 courses, ~460 lessons, 325 quiz questions, 39 graded quizzes, driven end-to-end through browser-link. The friction report is `INFORME-SESION-CURSOS.md` at the repo root; the quantified evidence is Appendix A of v1. The 1.0 foundation was decided on 2026-11-06 from a code diagnosis and the lab in `lab/2026-11-06-live-page-model/`.
