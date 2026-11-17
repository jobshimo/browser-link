# Service worker architecture: one core, two transports

Status: draft for arch audit and owner approval. No code moves before both.
Source of the requirement: `.eng/answers/20261116-2108-claude-9a69c2cf.ask-1.md`
(verdict "accept with conditions", guarantees a-f).
Measured on branch `docs/service-worker-design` at `5ce3055` (1.3.2).

All line references are to that commit. "Moved lines" in the slice plan means
lines of `background.ts` (or `cdp/transport.ts`) relocated without change, as
`git diff --color-moved` shows them; it is the planning unit, not authored code.

---

## 1. Context and goals

### What is wrong today

`packages/extension/src/background.ts` is 4922 lines and holds, in one module
that calls `chrome.*` at load time, every responsibility of the service worker:

| Responsibility | Where |
|---|---|
| Settings caches (idle TTL, flow recording) | `background.ts:210-300` |
| Per-tab state (`TabState`) and the tab map | `background.ts:340-400`, `:621` |
| Activity / Admin windows and their round trips | `background.ts:633-900` |
| Flow registry, deadlines, recording nav listeners | `background.ts:916-965` |
| CDP plumbing (`cdp()`, content settings, settle, observer, key events, event waits) | `background.ts:975-1446` |
| Console / network / dialog intake from `chrome.debugger.onEvent` | `background.ts:1447-1639` |
| Canvas screenshot builder, `evaluateInTab`, `waitForLoad` | `background.ts:1640-1842` |
| Action handlers `performFind/Click/Type/Press/WaitFor/Drag` | `background.ts:1843-2628` |
| Tool handlers (`handlePing` ... `handleSetPermission`) | `background.ts:2629-3488` |
| Flow storage, history, detached records, recovery | `background.ts:3025-3287` |
| Tool dispatch `handleTool` (22 `case` branches) | `background.ts:3489-3670` |
| Tab cleanup | `background.ts:3671-3721` |
| Connection lifecycle, reconnect scheduler, WebSocket message switch | `background.ts:3736-4175` |
| Bridge repair | `background.ts:4234-4327` |
| Flow recording by demonstration | `background.ts:4328-4658` |
| Popup message router | `background.ts:4674-4769` |
| Tab removed / created (`wait_for_tab`) / debugger detach | `background.ts:4770-4876` |
| Idle sweep | `background.ts:4877-4922` |

Ten permanent `chrome.*.addListener` registrations sit at module top level
(`background.ts:224, 277, 857, 894, 3722, 3884, 4674, 4770, 4808, 4865`) plus a
`setInterval` (`background.ts:4895`) and three load-time side effects
(`:222, :3880, :3890`). Because of them no test can import the module: no test
in `packages/extension/src` imports `background.ts`.

Consequences, measured:

- **Untested code paths.** The real-Chrome e2e (`packages/e2e/src/run.mjs`,
  1447 lines) calls 14 of the 34 declared tools (activity, click,
  dialog_respond, download, evaluate, find, flow, list_tabs, press, read,
  snapshot, type, wait_for, wrap_up). The glue that only runs inside the
  worker is reached by nothing else: for example the 1.3.0 running-call idle
  hold, a `try/finally` inside the WebSocket listener
  (`background.ts:4068-4085`), and the sweep that reads it
  (`background.ts:4895-4922`). The pure rules it calls
  (`idle-policy.ts:119-169`) are tested; the wiring is not.
- **Two hand-written bodies per action.** `cdp/transport.ts` (1598 lines)
  mirrors `performFind/Click/Type/Press/WaitFor`
  (`transport.ts:728-1222` vs `background.ts:1843-2334`), nine helpers with the
  same name (`evaluateInTab`, `runSettle`, `settleWithChanges`,
  `takeObserverMark`, `installObserver`, `handleObserverMessage`,
  `evaluateObserverJs`, `dispatchKeyEvent`, `waitForLoad`;
  `transport.ts:276-680`) and a 14-case dispatch (`transport.ts:1305-1598`).
  Only the five `perform*` bodies are guarded, by an AST comparison
  (`cdp/transport-parity.test.ts:33-39`). The per-tool argument coercion and
  failure mapping differ by construction: the extension spreads
  `sensitive_field` into the response (`background.ts:3561-3608`), the server
  throws `failureError` (`transport.ts:1299-1303`).
- **Copies by packaging constraint.** The server publishes to npm standalone
  and cannot depend on the private extension or shared packages
  (`config.ts:253`, `bridge/protocol.ts:13`), so `cdp/flow.ts` (1348),
  `cdp/inpage/*`, `cdp/expect.ts` (270), `cdp/keymap.ts` (258),
  `cdp/screenshot.ts` (257), `cdp/settle.ts` (95), `cdp/observer-host.ts` (372)
  and the protocol section of `messages.ts` are copies of extension or shared
  originals, guarded by four different techniques: byte identity
  (`cdp/drift.test.ts:71-230`), output identity (`cdp/builders-parity.test.ts`),
  AST print (`cdp/transport-parity.test.ts`) and regex extraction
  (`config.drift.test.ts:233-250`). The extension itself copies `BRIDGE_PORT`
  (`background.ts:178-181`) because plain `tsc` cannot resolve a runtime
  import of a workspace package in Chrome.
- **No bundler.** The extension builds with `tsc && node copy-assets.mjs`
  (`packages/extension/package.json`, script `build`), which emits one
  `.js`, `.js.map` and `.d.ts` per module into `dist/` (99 files in the
  current local `dist/`, 30 of them `.d.ts`). `prepare-publish.mjs:63-65`
  copies all of it into the server's `dist/extension/`, so the npm package
  ships the extension's declaration files.

### Findings this design closes

| Finding | How |
|---|---|
| `testing:untested-extension-service-worker` | every tool path gets a real-Chrome case before it moves (slices 1-2), then lives in chrome-free modules unit-tested through ports |
| `architecture:duplication-by-packaging-constraint` | the copies under `server/src/cdp/` become a generated mirror of `packages/core` (section 2), guarded by one generic test |
| `architecture:transport-handlers-mirrored-unguarded` | dispatch, argument coercion and failure mapping live once in core; each transport only maps a `ToolOutcome` to its wire, checked by the contract suite |
| `code-quality:hand-copied-transport-actions` | one body per action in core; `transport-parity.test.ts` deleted last |

Slice 0 also closes the partial `testing:real-chrome-gaps-for-1-1-rules`
(Chrome 118 exists only as README prose; CI runs the runner's own Chrome,
`.github/workflows/ci.yml:77-79, 108`, and records no version).

### Goals

1. Every tool path that runs in the service worker is reached by a test.
2. One authored body per behavior shared by the two transports.
3. `background.ts` becomes a composition root: adapters, listener
   registrations, wiring. No tool logic.
4. No behavior change while doing it (guarantee e). Behavior changes found on
   the way are logged and done in their own commits or PRs.

Non-goals: making cdp-direct support the tools it refuses today
(`cdp/support.ts:8-33`); unifying the two transports' idle or flow persistence
models (section 8, Q4).

---

## 2. Package and folder map

### Where the core lives: a new `packages/core`

Evaluated options:

| Option | Verdict |
|---|---|
| Put it in `packages/shared` | Rejected. `shared` is the wire protocol: types and constants (`shared/src/index.ts`, 519 lines), imported type-only by the extension (`background.ts:1-11`). The core is behavior (about 6-7k lines once moved) with a different reason to change. Mixing them makes every protocol consumer depend on handler code. |
| New `packages/extension/src/actions.ts`, keep parity tests | Rejected by arch's direction: it keeps two bodies. |
| New private package `packages/core`, source-only like `shared` (`"main": "./src/index.ts"`) | **Chosen.** Depends on `@browser-link/shared` only. Zero runtime npm dependencies. |

### How each side consumes it

- **Extension: bundled with esbuild.** Chrome cannot resolve a bare workspace
  specifier, so the extension needs a bundler before it can import core at
  runtime. esbuild because: one small dev dependency, a stable programmatic
  API in a ~30-line `build.mjs`, an explicit `target: 'chrome118'`, readable
  unminified ESM output, deterministic output for the same input. Vite is
  already a dev dependency (`^8.3.6`, for vitest), and Vite 8 bundles with
  Rolldown, which would avoid a new dependency; it is the alternative in
  section 8, Q1. `tsc --noEmit` stays as the type check.
- **Server: a generated mirror compiled by its existing `tsc`.** The server's
  build is `tsc` (`server/package.json:46`), its `dist/` is 182 files, and five
  modules locate files relative to their own path with `import.meta.url`
  (`cli.ts`, `commands/extension.ts`, `entry-info.ts`,
  `lifecycle/version-endpoint.ts`, `version.ts`), and `cli.ts:521-707` lazy
  loads ten modules with `import()`. Bundling the server would change all of
  that on the publish path. Instead `scripts/sync-core.mjs` writes
  `packages/core/src/**` and `packages/shared/src/**` verbatim into
  `packages/server/src/generated/{core,shared}/` with a
  `// GENERATED from packages/core/src/<path>. Do not edit.` header. The mirror
  is committed (so `tsx`, vitest and a fresh clone work without a build step),
  regenerated by the server's `prebuild` and `pretest`, and checked by one
  test, `server/src/generated/mirror.test.ts`: every generated file equals its
  source plus the header, and no extra file exists. This is the fix the
  duplication finding itself recommends; it keeps one authored body and
  replaces the four bespoke guard techniques with one. Full server bundling
  stays open as section 8, Q2.

### Target folders

```
packages/core/src/
  ports/            cdp-session.ts page.ts clock.ts store.ts settings.ts
                    events-out.ts downloads.ts content-settings.ts index.ts
  tools/            dispatch.ts (one switch, argument coercion, ToolOutcome)
                    families: interaction.ts (find click type press)
                    wait-for.ts drag.ts page-read.ts (navigate snapshot state
                    screenshot canvas_screenshot evaluate ping)
                    capture.ts (console network network_body)
                    dialog-permission.ts download.ts flow.ts
  actions/          perform-find.ts perform-click.ts perform-type.ts
                    perform-press.ts perform-wait-for.ts perform-drag.ts
                    click-landing.ts frame-watch.ts
  session/          tab-session.ts (aggregate) tab-registry.ts
                    cdp-glue.ts (evaluateInTab, runSettle, settleWithChanges,
                    observer install/mark/message, dispatchKeyEvent,
                    waitForCdpEvent)
  flow/             flow-run.ts (aggregate) flow-engine.ts (today flow.ts)
                    flow-registry.ts flow-store.ts
  inpage/           builders.ts observer.ts deep-query.ts dom-helpers.ts
  support/          settle.ts expect.ts keymap.ts screenshot.ts observer-host.ts
  policies/         idle-policy.ts
  fitness/          architecture.test.ts

packages/extension/src/
  background.ts     composition root (budget in section 5)
  adapters/         chrome-cdp-session.ts chrome-page.ts chrome-store.ts
                    chrome-settings.ts ws-events-out.ts chrome-downloads.ts
                    chrome-content-settings.ts
  app/              connection.ts (connect, WebSocket switch, reconnect wiring)
                    recording.ts repair.ts popup-router.ts windows.ts
                    activity-admin.ts tab-events.ts (removed, created, detach)
  (unchanged)       popup.ts activity.ts admin.ts admin-view.ts i18n.ts
                    ui-language.ts notice-policy.ts reconnect-policy.ts
                    repair-policy.ts connect-failure-policy.ts
                    flow-recording-policy.ts handshake-diagnosis.ts
                    version-status.ts worker-messages.ts recording.ts
                    download-capture.ts inpage/recorder.ts

packages/server/src/cdp/
  transport.ts      cdp-direct adapter: connections, gate, outcome -> wire
  adapters/         cdp-client-session.ts cdp-page.ts memory-store.ts
                    config-settings.ts bridge-events-out.ts
  (unchanged)       client.ts targets.ts gate.ts grant.ts support.ts
                    detached-flows.ts (see section 8, Q4)
packages/server/src/generated/{core,shared}/   mirror, never edited by hand
```

Policies that only the extension uses stay where they are and stay pure
functions: `reconnect-policy.ts`, `notice-policy.ts`, `repair-policy.ts`,
`connect-failure-policy.ts`, `flow-recording-policy.ts`,
`handshake-diagnosis.ts`, `version-status.ts`. `idle-policy.ts` moves to core
because `TabSession` uses it. `download-capture.ts` stays in the extension: it
is already port-shaped (`DownloadsApi`, `download-capture.ts:69`) and only the
extension has downloads (`cdp/support.ts:52-55`); core's `download` tool takes
the `DownloadCapture` interface (`download-capture.ts:144`) through the
`Downloads` port.

### What stays in `background.ts`

Construction of the adapters and the core services, the ten listener
registrations and the sweep interval (each a one-line delegation into `app/`
or core), the three startup calls, and the `BRIDGE_PORT` constant (section 8,
Q3). Nothing else.

---

## 3. Ports

All ports live in `packages/core/src/ports/`. Each is small and named after a
capability. Core receives them by constructor or function argument; it never
reaches for a global.

```ts
// cdp-session.ts: one debugger session on one page.
export interface CdpSession {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  /** Every CDP event of this session. Returns the unsubscribe function. */
  onEvent(listener: (method: string, params: unknown) => void): () => void;
}

// page.ts: what the transport knows about the page outside CDP.
export interface PageInfo {
  info(): Promise<{ url: string; title: string }>;
  /** Resolves when the page reports load complete, rejects on timeout. */
  waitForLoad(timeoutMs: number): Promise<void>;
}

// clock.ts
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
  every(ms: number, tick: () => void): () => void;
}

// store.ts: async key-value storage (flow history, detached records).
export interface KeyValueStore {
  get(keys: readonly string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: readonly string[]): Promise<void>;
}

// settings.ts: synchronous reads; the adapter keeps the cache current.
export interface SettingsSource {
  idleTtlMinutes(): number;
  flowRecordingEnabled(): boolean;
}

// events-out.ts: events the core emits toward the server's event log.
export interface EventsOut {
  emit(tabId: number, event: BridgeEventPayload): boolean; // false: not delivered
}

// downloads.ts: only the extension implements it.
export interface Downloads {
  capture: DownloadCapture; // download-capture.ts:144, unchanged
  tabSignals(session: CdpSession): TabDownloadSignals;
}

// content-settings.ts: only the extension implements it.
export interface ContentSettings {
  set(setting: string, primaryPattern: string, value: string): Promise<void>;
}
```

The tool contract every transport calls:

```ts
// tools/dispatch.ts
export type ToolOutcome =
  | { ok: true; result: unknown }
  | { ok: false; error: string; sensitive_field?: true };

export interface ToolContext {
  session: CdpSession;
  page: PageInfo;
  clock: Clock;
  tab: TabSession;
  flows: FlowRuns;
  downloads?: Downloads;          // absent: tool reports unsupported
  contentSettings?: ContentSettings;
}

export function dispatchTool(
  ctx: ToolContext,
  tool: string,
  params: Record<string, unknown>,
): Promise<ToolOutcome>;
```

The extension maps `ToolOutcome` to a `tool.response` frame (today
`background.ts:3545-3608`); the server resolves on `ok: true` and throws
`failureError`/`SensitiveFieldError` on `ok: false` (today
`transport.ts:1299-1303`). Those two mappings are the only per-transport code
left in the tool path, and a table-driven contract test feeds both the same
outcomes, including `sensitive_field` (the short-term fix of
`architecture:transport-handlers-mirrored-unguarded`).

| Port | Extension adapter (today's code) | cdp-direct adapter (today's code) |
|---|---|---|
| `CdpSession` | `chrome.debugger.sendCommand` + `onEvent` filtered by `source.tabId` (`background.ts:978-985, 1418-1440, 3722`) | `CdpClient.send` / event emitter (`cdp/client.ts`) |
| `PageInfo` | `chrome.tabs.get`, `chrome.tabs.onUpdated` status complete (`background.ts:1800-1842`) | `Target.getTargetInfo`, `Page.loadEventFired` (`transport.ts:483-501, 1265-1298`) |
| `Clock` | `Date.now`, `setTimeout`, `setInterval` (`background.ts:1045, 4895`) | same Node globals |
| `KeyValueStore` | `chrome.storage.session` (flow records, `background.ts:3141-3242`) | in-memory map (section 8, Q4) |
| `SettingsSource` | storage caches kept by `onChanged` (`background.ts:211-300`) | `loadConfig()` (`config.ts`) |
| `EventsOut` | `send(state.ws, ...)` (`background.ts:966, 3113-3140`) | the `BridgeEventLog` sink of `detached-flows.ts` |
| `Downloads` | `createDownloadCapture(chrome.downloads)` (`background.ts:3343-3377`) | none: `download` unsupported (`support.ts:55`) |
| `ContentSettings` | `chrome.contentSettings` (`background.ts:993-1041`) | none: `set_permission` unsupported (`support.ts:50`) |

Not ports, on purpose:

- **Dialogs.** A dialog is CDP: `Page.javascriptDialogOpening/Closed` arrive
  on `CdpSession.onEvent` and the answer is `Page.handleJavaScriptDialog`
  through `send` (`background.ts:3332`). The pending dialog is `TabSession`
  state, not a capability.
- **Tab registry.** Both sides keep sessions in memory (`tabStates`,
  `background.ts:621`; `connections`, `transport.ts:134`). It is a core class,
  not an adapter.
- **Alarms, windows, runtime messages, WebSocket.** Extension-only and not
  used by core. They stay in `app/` behind local interfaces of that module, so
  `app/` code is unit-testable with fakes, but they are not core ports.

---

## 4. Aggregates and invariants

Two aggregates, because only these two own state that several entry points
mutate and that has rules which can be broken by a wrong order of calls.

### `TabSession` (core/session/tab-session.ts)

Replaces `TabState` (`background.ts:340-400`) minus the recording fields,
which stay in the extension's `app/recording.ts` (cdp-direct has no
recording). Invariants, each with its current source:

1. **One session per tab.** Connecting a tab that has one fails with
   `tab-already-connected` (`background.ts:3918-3920`).
2. **Activity never goes backwards.** `lastActivityAt` only increases; the end
   of a call sets it to `max(lastActivityAt, now)` (`background.ts:4082`).
3. **A running call holds the idle clock.** `beginCall()` returns a handle;
   the hold is released by `endCall(handle)` on every exit path, throw
   included (`background.ts:4073-4083`), and never counts past
   `MAX_CALL_HOLD_MS` (`idle-policy.ts:45`). The aggregate exposes this as
   `runCall(fn)` so a caller cannot forget the `finally`.
4. **What counts as activity.** A tool request and a `tool.cancel` touch the
   clock (`background.ts:4071, 4097`); activity-panel and admin replies do not
   (`background.ts:4101-4110`).
5. **A running flow holds the tab** until `idleHoldUntil(entry, deadline)`
   (`background.ts:4898-4908`, `idle-policy.ts:119`). The aggregate answers
   `idleCandidate(now, ttl, flowHolds)`; the sweep becomes
   `registry.idleTabs(now)` + `cleanup`.
6. **Bounded buffers.** Console entries at most `CONSOLE_BUFFER_MAX = 200`,
   network entries at most `NETWORK_BUFFER_MAX = 200`, oldest dropped first,
   `networkOrder` and `networkBuffer` always hold the same ids
   (`background.ts:185-186, 1458-1478`).
7. **At most one pending dialog**, set on `Page.javascriptDialogOpening`,
   cleared on `Page.javascriptDialogClosed` (`background.ts:362-364`, intake in
   `attachDebuggerListener`, `background.ts:1479-1639`).
8. **Observer state.** `observer.installed === false` means every action
   reports `settle.changes: null` (`background.ts:386-391`); the script id is
   removed on cleanup (`background.ts:3671-3721`).

Claims are not here: tab claims belong to the server
(`server/src/bridge/dispatch.ts`); the extension has no claim state.
Held downloads are not here either: they are worker-global and per download id
inside `DownloadCapture` (a held download is released untouched once
`holdMs` passes unless settled; `download-capture.ts:131-157`,
`background.ts:3343-3352`). That module already owns that invariant and its
tests (`download-capture.test.ts`).

### `FlowRun` (core/flow/flow-run.ts)

Wraps the registry (`flow-registry.ts:176-223`), the foreground deadlines
(`background.ts:923`), and the storage chain (`background.ts:3025-3287`).
Invariants:

1. **One detached flow per tab** (`background.ts:2826-2843`).
2. **Detached ceiling.** `expiresAt = start + MAX_DETACHED_FLOW_MS` (30 min,
   `flow-registry.ts:77`, `background.ts:2851`); `shouldStop` turns true at
   the ceiling or on cancel.
3. **Cancel is idempotent**; an unknown or finished id is a no-op
   (`background.ts:4087-4100`).
4. **Finished exactly once.** `finish` removes the entry from the running set
   and returns it once; history gets one entry, a detached flow one terminal
   record and one `flow-finished` event (`background.ts:3066-3140`,
   double-publish guard `flushingFlowEvents`, `background.ts:3260-3287`).
5. **Bounded storage.** History at most `MAX_FLOW_HISTORY_PER_TAB = 20`
   (`flow-registry.ts:47`), detached records at most
   `MAX_DETACHED_FLOW_RECORDS = 10` (`:611`), manifest at most
   `MAX_DETACHED_MANIFEST_BYTES = 128_000` (`:621`).
6. **Writes are serialized** and a failed write never breaks the chain
   (`background.ts:3030-3057`).
7. **No resurrection.** A flow that started before its tab closed never
   writes history back (`flowHistoryDroppedAt`, `background.ts:3059`).
8. **Worker restart.** A record still `running` at startup becomes
   `worker-terminated` (`recoverDetachedFlows`, `background.ts:3243-3258`).

### Pure policies stay functions

`idle-policy` (moves to core), `reconnect-policy`, `notice-policy`,
`repair-policy`, `connect-failure-policy`, `flow-recording-policy`,
`download-capture`'s `attributedSignal`, `settle`, `expect`, `keymap`,
`screenshot`'s planning, `observer-host`'s mirror functions, and the flow
engine's `runFlow` (it already takes `FlowDeps`, `flow.ts:492-545`). They get
no object wrapper.

---

## 5. Dependency rule and fitness tests

```
packages/shared   <- packages/core <- packages/extension/src/{adapters,app}
                                    <- packages/extension/src/background.ts
packages/server/src/generated/{shared,core}  <- packages/server/src/cdp/**
```

| Module | May import | Must not import |
|---|---|---|
| `packages/core/src/**` | `@browser-link/shared`, its own files | `chrome`, `node:*`, any npm package, extension, server |
| `packages/extension/src/adapters/**` | core, shared, `chrome` | other adapters' internals |
| `packages/extension/src/app/**` | core, shared, extension policies | `chrome` (only through local interfaces) |
| `packages/extension/src/background.ts` | anything in the extension | tool logic (no tool `case` labels) |
| `packages/server/src/cdp/**` | `generated/core`, `generated/shared` | `packages/core` by relative path |

Enforcement, all run by `pnpm test` in CI:

1. **Compile-time:** `packages/core/tsconfig.json` sets `"lib": ["ES2022"]`
   and `"types": []`, so `chrome`, `process`, `Buffer` and DOM globals do not
   type-check in core. The in-page builders are strings and need no DOM types.
2. **`core/src/fitness/architecture.test.ts`:** parses every core file with
   the TypeScript API and fails on an import specifier that is not relative and
   not `@browser-link/shared`, on any `node:` specifier, and on any identifier
   `chrome`.
3. **`extension/src/fitness.test.ts`:**
   - `chrome` identifiers appear only in `adapters/**` and `background.ts`;
   - `background.ts` line budget: a constant `BACKGROUND_LINE_BUDGET` that
     starts at **4922** in slice 5 and is lowered to the new count by every
     slice that moves code out (it may never be raised without arch sign-off);
     the final value is **400**;
   - `background.ts` contains no `case '<tool>'` for any name in
     `CDP_TOOL_SUPPORT` or the extension-only tools.
4. **`server/src/generated/mirror.test.ts`:** the mirror equals its sources
   (section 2).
5. **Port contract suite** (`core/src/ports/contract/*.ts`): plain functions
   `defineCdpSessionContract(make)`, `definePageInfoContract(make)`,
   `defineKeyValueStoreContract(make)`, `defineToolOutcomeMappingContract(map)`
   that use only a tiny assertion helper, no vitest globals, so they can run
   anywhere. They are run:
   - against the cdp-direct adapters under vitest, with a headless Chrome target
     (in the e2e job, which already launches Chrome) for `CdpSession` and
     `PageInfo`, and in plain vitest for the store and outcome mapping;
   - against the extension adapters inside the real service worker: a
     test-only build (`pnpm --filter @browser-link/extension build:contract`,
     output in a temp dir, never in `dist/`) adds a `contract.js` entry; the
     e2e loads that build and runs the suite in the worker through CDP
     `Runtime.evaluate` on the service-worker target, failing on any assertion.
   What the suite pins: `send` resolves with the CDP result and rejects with
   the CDP error message unchanged; events of the session arrive in order and
   stop after unsubscribe; `waitForLoad` resolves on load and rejects on
   timeout; the store round-trips JSON values and `remove` is idempotent;
   `ToolOutcome` maps to the same wire result on both transports, with
   `sensitive_field` carried on failure. Once it runs green on both adapters
   and every action has one body, `transport-parity.test.ts`,
   `builders-parity.test.ts` and the copy sections of `drift.test.ts` and
   `config.drift.test.ts` are deleted (slice 22).

---

## 6. Slice plan

Each slice is one PR, releasable on its own (all suites green, e2e and
differential green from slice 3 on) and revertible with `git revert` of its
merge commit alone, because no later slice is merged until it is green.
Planning size: about 400 moved or authored lines; the deletion of a mirror
copy proven byte-identical by the existing guard is listed but not counted.
Every slice that moves code: e2e green on Chrome 118 and stable, differential
equal, budget constant lowered, the old code deleted in the same PR only after
the new path is green in CI (guarantee d). Refactor commits and any behavior
fix never share a commit (guarantee e).

| # | Slice | What moves or changes | Size (est.) | Proof | Revert |
|---|---|---|---|---|---|
| 0 | Chrome 118 + stable in CI | `ci.yml` e2e job becomes a matrix `chrome: [118, stable]`; Chrome for Testing 118.0.5993.70 installed with `npx @puppeteer/browsers install chrome@118.0.5993.70` (cached); `run.mjs` writes `{browser, product, revision}` to `$GITHUB_STEP_SUMMARY` and `e2e-result.json` (uploaded artifact) from the version it already reads (`run.mjs:248-260`) | ~80 authored | both legs green; summary shows the two versions | revert the PR; CI falls back to one leg |
| 1 | e2e: page read and capture | cases for `navigate`, `state`, `ping`, `screenshot`, `canvas_screenshot`, `console`, `network`, `network_body`; fixtures in `packages/e2e/pages/` (a canvas, a `console.log`, a `fetch`) | ~350 authored | each case fails under `E2E_EXPECT_FAIL=<tool>` (RED probe, `run.mjs:17`) and passes otherwise, both Chromes | revert; no product code touched |
| 2 | e2e: drag, permission, tabs, flow control | cases for `drag` (draggable fixture), `set_permission`, `wait_for_tab`, `flow_status`, `flow_cancel` (detached flow cancelled, status reads `cancelled`) | ~350 authored | same as 1 | revert |
| 3 | Differential harness | `E2E_EXT_DIST` / `E2E_SERVER_CLI` overrides for `lib.mjs:24-25`; `E2E_RECORD=<file>` writes every tool call's request and result; `scripts/e2e-diff.mjs` (section 7b); new CI job `e2e-diff` | ~300 authored | self-diff of two runs of the same build is empty; a deliberate one-token change in a result string is reported | revert |
| 4 | Bundler alone | `packages/extension/build.mjs` (esbuild, entries `background`, `popup`, `activity`, `admin`, `format: 'esm'`, `target: 'chrome118'`, `bundle: true`, no minify, `sourcemap: 'linked'`); `build` becomes `tsc --noEmit && node build.mjs && node copy-assets.mjs`; `smoke-tarball.mjs` asserts the new extension file set. No source file changes. | ~120 authored | section 7c | revert restores tsc output |
| 5 | Core skeleton | `packages/core` with `ports/` (types only), contract functions, fitness tests, `scripts/sync-core.mjs`, empty mirror, budget = 4922 | ~350 authored | fitness and mirror tests green and RED-probed (an injected `chrome` import fails) | revert |
| 6 | Leaf modules | `settle`, `expect`, `keymap`, `screenshot` move to `core/support/`; server copies replaced by the mirror; their `drift.test.ts` sections deleted | moved ~880, copies deleted ~880 | e2e, differential, unit tests of each module re-homed | revert |
| 7 | In-page code | `inpage/{builders,observer,deep-query,dom-helpers}`, `observer-host` to core; `builders-parity.test.ts` deleted | moved ~2.6k (renames), copies deleted | same | revert |
| 8 | Flow engine | `flow.ts` to `core/flow/flow-engine.ts`; `cdp/flow.ts` copy deleted | moved 1348 (rename), copy deleted 1348 | same | revert |
| 9 | Sessions and glue | `CdpSession`/`PageInfo` adapters both sides; `cdp-glue.ts` from `background.ts:1045-1110, 1240-1446, 1786-1842` and the nine twins in `transport.ts:276-680` | ~330 from background, ~250 deleted from server | contract suite green on both adapters; e2e; differential | revert |
| 10 | Interaction: find, click | `performFind`, `performClick`, click landing, frame watch (`background.ts:1113-1239, 1843-2012`), their `dispatchTool` cases | ~320 | as above; the two handlers leave `transport-parity` `HANDLERS` | revert |
| 11 | Interaction: type, press | `performType`, `performPress` (`background.ts:2013-2155`) and the outcome mapping with `sensitive_field` | ~250 | outcome-mapping contract; RED probe: removing the spread at today's `background.ts:3578` fails it | revert |
| 12 | `TabSession` | aggregate from `TabState`, debugger intake (`background.ts:1447-1639`), call hold (`:4068-4085`), sweep (`:4895-4922`), cleanup (`:3671-3721`) | ~350 | unit tests of invariants 1-8 with a fake `Clock`, including a call that throws and one longer than the TTL | revert |
| 13 | wait_for | `performWaitFor` (`background.ts:2156-2334`); the `network-url-mode` divergence becomes `tab.network === undefined` on cdp-direct, same behavior | ~200 | e2e; differential | revert |
| 14 | drag | `performDrag`, `handleDrag` (`background.ts:2335-2628, 3288-3318`); stays unsupported on cdp-direct | ~330 | e2e case from slice 2 | revert |
| 15 | Page read and capture | `handlePing` ... `handleNetworkBody`, canvas builder (`background.ts:1640-1785, 2629-2776`), server cases `navigate/snapshot/state/screenshot/ping/evaluate` | ~300 | e2e from slice 1 | revert |
| 16 | Dialogs, permission, downloads | `background.ts:993-1041, 3319-3488`; `ContentSettings` and `Downloads` adapters | ~220 | e2e `dialog_respond`, `set_permission`, `download` | revert |
| 17 | `FlowRun` | aggregate and store (`background.ts:916-965, 3025-3287`) | ~310 | unit tests of invariants 1-8 with an in-memory store | revert |
| 18 | Flow tools | `handleFlow`, `handleFlowStatus`, `buildFlowDeps` (`background.ts:2777-3024`), server flow cases (`transport.ts:1223-1260, 1450-1598`) | ~250 + ~190 server | e2e `flow`, `flow_status`, `flow_cancel` | revert |
| 19 | Connection lifecycle | `app/connection.ts` from `background.ts:3736-4175` (tab ids, reconnect wiring, WebSocket switch) | ~440 | unit tests with a fake socket and alarms; e2e handshake and Origin cases | revert |
| 20 | Recording | `app/recording.ts` from `background.ts:4328-4658` | ~330 | existing `recording.test.ts` plus new unit tests; manual popup check noted in PR | revert |
| 21 | Popup router, windows, repair, tab events | `background.ts:633-900, 4234-4327, 4674-4876` to `app/` | ~460 (may split in two) | unit tests of the router; e2e i18n and Admin cases; `wait_for_tab` case | revert |
| 22 | Retire parity guards | delete `transport-parity.test.ts`, remaining copy sections of `drift.test.ts` and `config.drift.test.ts`; budget at 400 | deletions only | contract suite green on both adapters in the same CI run | revert |

Order rationale: the safety net first (0-3), then the build change alone (4),
then leaf modules whose move is a rename (6-8), then the session seam every
handler needs (9), then handler families from the most covered and most
mirrored (10-11) to extension-only ones (14-16), aggregates before the code
that uses them (12 before 13, 17 before 18), and extension-only application
code last (19-21) because it is not mirrored and only needs testability.

---

## 7. How each guarantee is met

### (a) e2e case before a tool moves; Chrome 118 and stable in CI, version recorded

- Slices 1-2 add cases for the 13 tools whose code is in `background.ts` and
  that have none: `navigate`, `drag`, `screenshot`, `canvas_screenshot`,
  `console`, `network`, `network_body`, `set_permission`, `wait_for_tab`,
  `state`, `flow_cancel`, `flow_status`, `ping`. The other 14 are covered
  today. The 7 uncovered tools with no worker code (`claim_tab`,
  `release_tab`, `my_tabs`, `events`, `feedback`, `manual`, `reset`) are server
  only and outside this plan.
- A table in `packages/e2e/src/run.mjs` maps each wire tool to its case; a
  unit test in `packages/e2e` fails if a tool in core's `dispatchTool` has no
  case (it reads the case names from the table and the tool names from
  `CDP_TOOL_SUPPORT` plus the extension-only list).
- CI: job `e2e` with `strategy.matrix.chrome: ['118.0.5993.70', 'stable']`;
  `stable` uses the runner's `/usr/bin/google-chrome` (`ci.yml:108`), 118 uses
  Chrome for Testing, which still honours `--load-extension`
  (`lib.mjs:135-138`). The `release` job keeps `needs: [ci, e2e]`
  (`ci.yml:124`), so both legs gate the publish. Each leg writes the browser
  version it ran on to the step summary and the `e2e-result-<leg>.json`
  artifact.

### (b) Differential check: old build and new build, equal outputs

`scripts/e2e-diff.mjs <base-ref>`:

1. `git worktree add <mktemp -d>/base <merge-base of base-ref and HEAD>`,
   `pnpm install --frozen-lockfile` and `pnpm build` there.
2. Run HEAD's harness twice against HEAD's build and once against the base
   build (`E2E_EXT_DIST`, `E2E_SERVER_CLI` point at each build;
   `E2E_RECORD=<file>`). The harness is always HEAD's, so only the build
   differs.
3. Normalise each record with the committed table
   `packages/e2e/src/normalise.mjs`:
   - identifiers renamed by first appearance, keeping identity: tab ids
     (`<tab#1>`), refs, `doc_id`, `flow_id`, `request_id`, download ids,
     observer marks (`<flow#2>` etc.), so "same id twice" stays visible;
   - timing fields replaced by their type: keys ending in `_ms`, `elapsedMs`,
     `durationMs`, `started_at`, `finished_at`, `timestamp`, and any number
     above `1e12` under a key matching `/at$|time/i` become `<ms>`;
   - ISO timestamps become `<iso>`; temp paths and ports become `<tmp>` and
     `<port>`; the Chrome version string becomes `<chrome>`;
   - image payloads become `{ format, width, height, sha256 }`.
4. Gate: the two HEAD runs must be equal after normalisation (proves the table
   is complete; a new noisy field fails here and must be added to the table in
   a reviewed commit). Then base vs HEAD must be equal. The script prints the
   first differing call with both values and exits 1.
5. CI job `e2e-diff`, Chrome stable, on every PR that touches
   `packages/extension/src`, `packages/core`, `packages/server/src/cdp`,
   `packages/server/src/generated` or `packages/extension/build.mjs`. A PR
   whose purpose is a behavior change cannot pass it, which is intended: such a
   change goes in its own PR, labelled `behavior-change`, where the job
   reports the expected difference and the PR description names it.

### (c) The bundler lands alone

Slice 4 changes only build files: `packages/extension/build.mjs`,
`packages/extension/package.json` (script and the `esbuild` dev dependency),
`pnpm-lock.yaml`, `scripts/smoke-tarball.mjs`. Proof, all in the PR:

- `git diff --stat main -- packages/extension/src` is empty.
- e2e green on both Chromes; `e2e-diff` equal against `main`.
- `dist/extension/manifest.json` byte-identical before and after
  (`sha256sum` of both builds printed in the PR) and
  `packages/extension/manifest.json` untouched.
- npm-pack contents: `npm pack --dry-run --json` of the server before and after;
  the PR lists the expected difference: per-module `.js`/`.js.map`/`.d.ts`
  under `dist/extension/` (and `dist/extension/inpage/`) replaced by
  `background.js`, `popup.js`, `activity.js`, `admin.js` and their maps;
  HTML, icons and manifest unchanged; everything outside `dist/extension/`
  unchanged. `smoke-tarball.mjs` asserts exactly that set and that no `.d.ts`
  ships under `dist/extension/`.
- The e2e's port patch (`lib.mjs:118-124`, a regex on
  `const BRIDGE_PORT = 17529;`) still matches the bundled `background.js`; it
  throws if it does not, so a green e2e proves it.

### (d) One handler family per PR; old code deleted only when the new path is green

The families are slices 10-18, one per PR. Within a slice, the first commit
adds the core version and switches both transports' dispatch to it; CI must be
green (unit, contract, e2e both Chromes, differential); only then the next
commit deletes the old `background.ts` and `transport.ts` bodies and lowers
the budget, and CI runs again. The PR is not merged with the old body still
present, and the deletion commit is not pushed before the first commit's CI is
green.

### (e) Refactor and behavior changes never share a commit

- Refactor commits are typed `refactor(core): ...`; behavior fixes are `fix:` or
  `feat:` commits in a separate PR.
- The differential job (b) is the mechanical check: a refactor PR with any
  difference fails.
- Known places where the move invites a behavior change, which this plan does
  not take: unifying the network buffer for cdp-direct (`network-url-mode`,
  `transport-parity.test.ts:58-72`), enabling drag, console, network or
  downloads on cdp-direct, and the two server notes in arch's answer (non-GET
  download refusal comment, Windows `table-changed` fallback). Each is its own
  PR if the owner wants it.

### (f) Fitness tests

Section 5: compile-time lib restriction and `architecture.test.ts` for core;
`fitness.test.ts` for `chrome` confinement, no tool `case` in `background.ts`
and the line budget (4922 at slice 5, lowered each slice, 400 at slice 22);
`mirror.test.ts` for the generated server copy; the port contract suite run
against both adapters, after which the parity tests are deleted.

---

## 8. Risks and open questions

**Q1 (arch). Bundler: esbuild or Rolldown through Vite 8?** esbuild adds one
dev dependency; Vite 8 is already installed for vitest and bundles with
Rolldown, so no new dependency, but a library-mode config for four entries
plus a module service worker is more configuration and less common. I chose
esbuild; arch may prefer no new dependency.

**Q2 (arch, owner). Server: generated mirror or full bundle?** The mirror keeps
the publish path as it is and is what the duplication finding recommends, but
it leaves two copies in git (one authored, one generated). Bundling the server
removes the mirror and `server/src/generated/`, but changes 182 dist files to a
few bundles, and must keep the `import.meta.url` path lookups in five modules
and the lazy `import()` calls in `cli.ts` working. I propose the mirror now
and bundling, if ever, as its own later PR.

**Q3 (arch). `BRIDGE_PORT`.** The e2e patches the literal line
`const BRIDGE_PORT = 17529;` in the built `background.js` (`lib.mjs:118-124`).
If background imported it from `shared`, the bundled line would come from
another module and could be emitted differently. Proposal: keep the constant
in `background.ts` (one copy, guarded by `config.drift.test.ts` as today) until
the e2e gets a port override that does not patch the build.

**Q4 (owner). cdp-direct persistence and idle model.** `detached-flows.ts`
says the two flow registries are deliberately different (`detached-flows.ts:1-22`):
the server has nothing to survive. `FlowRun` with an in-memory store would give
cdp-direct the same rules for free, and cdp-direct's own idle cleanup
(5 minutes, `transport.ts:153-222`) differs from the extension's TTL. Adopting
`TabSession` idle rules or `FlowRun` on cdp-direct is a behavior change. This
plan moves them for the extension only and leaves cdp-direct's models as they
are; adopting them there is a separate decision.

**Q5 (owner). Source maps in the npm package.** Today's build ships a map per
module (`tsconfig.base.json` `sourceMap: true`). Bundled maps are a few larger
files that embed `packages/core` sources with workspace-relative paths. Keep
them (useful for user bug reports) or drop them from the tarball?

**R1. MV3 service-worker lifetime.** The worker can be stopped while idle;
today's design already survives it (flow records in `chrome.storage.session`,
reconnect state, `recoverDetachedFlows`). Moving code must not move any
startup work behind an `await` that delays listener registration: Chrome only
delivers wake-up events to listeners registered synchronously in the first
turn. The composition root registers all listeners synchronously at top level,
and `fitness.test.ts` checks that every `addListener` call in `background.ts`
is a top-level statement.

**R2. Module service worker constraints.** `manifest.json` declares
`"type": "module"`. A module service worker cannot use dynamic `import()`, so
the core must use static imports only (the bundle output has none anyway);
`architecture.test.ts` rejects `import(` in core.

**R3. Chrome 118.** The minimum stays 118 (`manifest.json`
`minimum_chrome_version`). esbuild `target: 'chrome118'` lowers any newer
syntax. Download attribution relies on `Page.downloadWillBegin`; slice 0 is
the first CI run of the download cases on 118, and if they fail there the fix
(raise the minimum or degrade) is a behavior decision for the owner, not part
of the refactor.

**R4. Bundle size.** Measure in slice 4: `background.js` today is one module
importing about 25 others; the bundle should be close to the sum of today's
`.js` files. The PR reports the sizes; no budget is proposed until measured.

**R5. Differential flakiness.** Results that depend on timing
(`settle.mutation_count`, `settled`, network entries arriving late) can differ
between two runs of the same build. The two-run self-diff (7b, step 4) exposes
them before they block a PR; each one must be either normalised in a reviewed
commit or made deterministic in the fixture. Screenshot hashes may differ by
anti-aliasing; if the self-diff shows that, images fall back to
`{format, width, height}` only, with the owner's agreement.

**R6. Contract suite inside the worker.** Running it in the real service
worker needs a test-only build entry and a CDP evaluate on the worker target.
If that proves fragile, the fallback is the cdp-direct adapter suite against
real Chrome plus the e2e as the extension adapter's proof; arch should say
whether that fallback still satisfies guarantee (f).

**R7. Line budget of 400.** It assumes the ten listeners and the interval stay
one-line delegations. If the composition root needs more, the number is
revised in slice 22 with arch, not raised silently.
