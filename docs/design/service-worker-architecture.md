# Service worker architecture: one core, two transports

Status: revision 2, for arch re-audit. Revision 1 (`5486e34`) was audited as
"approve with changes" (`.eng/reviews/20261117-0522-plan-audit-service-worker-architecture-d.md`).
Slices 0-4 may start; nothing from slice 5 on moves before the re-audit passes.
Source of the requirement: `.eng/answers/20261116-2108-claude-9a69c2cf.ask-1.md`
(verdict "accept with conditions", guarantees a-f).
Measured on branch `docs/service-worker-design` at `5ce3055` (1.3.2).

Code is cited by symbol: `file.ts` `symbol`. Where a range has no symbol of its
own, the line range is given at `5ce3055`. "Moved lines" in the slice plan
means lines of `background.ts` (or `cdp/transport.ts`) relocated without
change, as `git diff --color-moved` shows them; it is the planning unit, not
authored code.

### Revision 2 (2026-11-17)

Each required change of the audit, and where this revision meets it:

| # | Required change | Now met in |
|---|---|---|
| 1 | Core purity before slice 6 (slice 5b) | 5.1 "Purity"; slice 5b in section 6 |
| 2 | Layering inside core, enforced, policies→flow edge removed | 5.2 "Layers" and 5.3 fitness test 2; slice 5b removes the edge |
| 3 | Aggregates cut by invariants | section 4 (`TabSession`/`TabConnection`, `TabRegistry`, `FlowRun`/`FlowRegistry`/`FlowHistory`, `PendingReplies<T>`) |
| 4 | Ports really segregated | section 3 (typed repositories, settings without `flowRecordingEnabled`, data-returning `Downloads`, per-handler requirements, extension adapters for `windows`, `alarms`, `runtime`, tab events); budget re-measured in 5.4 |
| 5 | `PageDriver` + `ToolRegistry`, `CDP_TOOL_SUPPORT` derived | 3.2 and 3.3 |
| 6 | Failure contract and error-path e2e before slice 10 | 3.4; slice 3b |
| 7 | Mirror: production files only, explicit sync, `--check` | 2.3 |
| 8 | `packages/core` private, `0.0.0`, outside the Version Gate | 2.4 |
| 9 | Differential: normalisation, cache, self-diff policy, timeout, merge-base | 7(b) |
| 10 | Release gate: 118 blocks, stable reports and opens an issue | 7(a) |
| 11 | Server `messages.ts` copy replaced before slice 22 | slice 5c |
| 12 | R6 decided before slice 9 | section 8, R6 (decided, with arch's three conditions as slice 9 proof) |

Also in this revision: arch's answers Q1-Q3 and the owner's decisions on Q4,
Q5 and the release gate are recorded as decided (section 8); the omissions of
audit section 5 are filled (Version Gate 2.4, mirror scope 2.3, CI time 6.3,
stable gating 7(a), release notes 7(c), error paths 3.4 and slice 3b, extension
adapters 3.1); the audit's suggestions are adopted (symbol anchors, value
checkpoints after slices 9 and 18 and a minimum viable end state in 6.2, CI
minutes per PR in 6.3, slice 4 assertions in 7(c)). One ordering defect found
while verifying this revision is fixed: `settle.ts` and `expect.ts` import
`inpage/builders.ts`, so the in-page code now moves before them (slices 6 and 7
swapped).

Slice 0 is being implemented now on branch `ci/e2e-chrome-118-and-stable`.

---

## 1. Context and goals

### What is wrong today

`packages/extension/src/background.ts` is 4922 lines and holds, in one module
that calls `chrome.*` at load time, every responsibility of the service worker:

| Responsibility | Anchors in `background.ts` |
|---|---|
| Settings caches (idle TTL, flow recording) | `idleTtlMinutesCache`, `flowRecordingEnabledCache` and their `chrome.storage.onChanged` listeners (lines 210-300) |
| Per-tab state and the tab map | `interface TabState`, `tabStates` |
| Activity / Admin windows and their round trips | `pendingActivityQueries`, `pendingAdminRequests`, `chrome.windows.*` (lines 633-900) |
| Flow registry, deadlines, recording nav listeners | `foregroundFlowDeadlines`, `recordingNavListeners` |
| CDP plumbing | `cdp`, `evaluateObserverJs`, `takeObserverMark`, `settleWithChanges`, `handleObserverMessage`, `installObserver`, `dispatchKeyEvent` |
| Console / network / dialog intake | `attachDebuggerListener` (`chrome.debugger.onEvent`) |
| Canvas screenshot builder, `evaluateInTab`, `waitForLoad` | same names |
| Action handlers | `performFind`, `performClick`, `performType`, `performPress`, `performWaitFor`, `performDrag` |
| Tool handlers | `handlePing` ... `handleSetPermission` |
| Flow storage, history, detached records, recovery | `flowHistoryDroppedAt`, `flushingFlowEvents`, `recoverDetachedFlows` (lines 3025-3287) |
| Tool dispatch | `handleTool` (22 `case` branches) |
| Tab cleanup | `cleanup` |
| Connection lifecycle, reconnect scheduler, WebSocket message switch | `connectsInFlight`, `reconnectScheduler`, `chrome.alarms.onAlarm` (lines 3736-4175) |
| Bridge repair | `pendingRepairs` (lines 4234-4327) |
| Flow recording by demonstration | lines 4328-4658 |
| Popup message router | `chrome.runtime.onMessage` |
| Tab removed / created (`wait_for_tab`) / debugger detach | `chrome.tabs.onRemoved`, `chrome.tabs.onCreated`, `chrome.debugger.onDetach` |
| Idle sweep | the `setInterval` at the end of the file |

Ten permanent `chrome.*.addListener` registrations sit at module top level
(`storage.onChanged` twice, `windows.onRemoved` twice, `debugger.onEvent`,
`alarms.onAlarm`, `runtime.onMessage`, `tabs.onRemoved`, `tabs.onCreated`,
`debugger.onDetach`) plus a `setInterval` and three load-time side effects.
Because of them no test can import the module: no test in
`packages/extension/src` imports `background.ts`.

The `chrome` namespaces the worker uses, counted at `5ce3055`:
`storage.session` (23 uses), `tabs` (`get`, `onUpdated`, `onRemoved`,
`onCreated`), `debugger` (`attach`, `detach`, `sendCommand`, `onEvent`,
`onDetach`), `storage.local` and `storage.onChanged`, `windows` (`create`,
`get`, `update`, `onRemoved`), `runtime` (`getManifest`, `getURL`,
`onMessage`), `contentSettings`, `alarms` (`create`, `clear`, `onAlarm`), and
`downloads` through `download-capture.ts` `createDownloadCapture`.

Consequences, measured:

- **Untested code paths.** The real-Chrome e2e (`packages/e2e/src/run.mjs`,
  1447 lines) calls 14 of the 34 declared tools (activity, click,
  dialog_respond, download, evaluate, find, flow, list_tabs, press, read,
  snapshot, type, wait_for, wrap_up). The glue that only runs inside the
  worker is reached by nothing else: for example the 1.3.0 running-call idle
  hold, a `try/finally` inside the WebSocket listener, and the sweep that reads
  it. The pure rules it calls (`idle-policy.ts` `idleHoldUntil`,
  `tabsToDisconnectForIdle`) are tested; the wiring is not.
- **Two hand-written bodies per action.** `cdp/transport.ts` (1598 lines)
  mirrors `performFind/Click/Type/Press/WaitFor`, nine helpers with the
  same name (`evaluateInTab`, `runSettle`, `settleWithChanges`,
  `takeObserverMark`, `installObserver`, `handleObserverMessage`,
  `evaluateObserverJs`, `dispatchKeyEvent`, `waitForLoad`) and a 14-case
  dispatch (`transport.ts` `callCdpTool`). Only the five `perform*` bodies are
  guarded, by an AST comparison (`cdp/transport-parity.test.ts` `HANDLERS`).
  The per-tool argument coercion and failure mapping differ by construction:
  the extension spreads `sensitive_field` into the response (`handleTool`,
  cases `type` and `press`), the server throws (`transport.ts`
  `failureError`); the extension coerces a missing string with `String(p[key])`
  (`handleTool` `str`), cdp-direct's `navigate` with `''`.
- **Copies by packaging constraint.** The server publishes to npm standalone
  and cannot depend on the private extension or shared packages, so
  `cdp/flow.ts` (1348), `cdp/inpage/*`, `cdp/expect.ts` (270), `cdp/keymap.ts`
  (258), `cdp/screenshot.ts` (257), `cdp/settle.ts` (95),
  `cdp/observer-host.ts` (372) and `messages.ts` (416, the `<wire-protocol>`
  section of `shared/src/index.ts`) are copies of extension or shared
  originals, guarded by four different techniques: byte identity
  (`cdp/drift.test.ts`), output identity (`cdp/builders-parity.test.ts`), AST
  print (`cdp/transport-parity.test.ts`) and marker extraction
  (`config.drift.test.ts`, "wire protocol drift guard"). The extension itself
  copies `BRIDGE_PORT` because plain `tsc` cannot resolve a runtime import of
  a workspace package in Chrome.
- **No bundler.** The extension builds with `tsc && node copy-assets.mjs`
  (`packages/extension/package.json`, script `build`), which emits one
  `.js`, `.js.map` and `.d.ts` per module into `dist/` (99 files in the
  local `dist/` at measurement, 30 of them `.d.ts`). `prepare-publish.mjs`
  copies all of it into the server's `dist/extension/`, so the npm package
  ships the extension's declaration files.

### Findings this design closes

| Finding | How |
|---|---|
| `testing:untested-extension-service-worker` | every tool path gets a real-Chrome case before it moves (slices 1, 2, 3b), then lives in chrome-free modules unit-tested through ports |
| `architecture:duplication-by-packaging-constraint` | the copies under `server/src/cdp/` and `messages.ts` become a generated mirror of `packages/core` and `packages/shared` (2.3), guarded by one check |
| `architecture:transport-handlers-mirrored-unguarded` | registry, argument coercion and the failure taxonomy live once in core; each transport only maps a `ToolOutcome` to its wire (3.4), checked by the contract suite |
| `code-quality:hand-copied-transport-actions` | one body per action in core; `transport-parity.test.ts` deleted last |

Slice 0 also closes the partial `testing:real-chrome-gaps-for-1-1-rules`
(Chrome 118 exists only as README prose; CI runs the runner's own Chrome,
`ci.yml` job `e2e`, `CHROME_PATH: /usr/bin/google-chrome`, and records no
version).

### Goals

1. Every tool path that runs in the service worker is reached by a test.
2. One authored body per behavior shared by the two transports.
3. `background.ts` becomes a composition root: adapters, listener
   registrations, wiring. No tool logic.
4. No behavior change while doing it (guarantee e). Behavior changes found on
   the way are logged and done in their own commits or PRs.

Non-goals: making cdp-direct support the tools it refuses today
(`cdp/support.ts` `CDP_TOOL_SUPPORT`); changing cdp-direct's idle or flow
models (decided, section 8, Q4).

---

## 2. Package and folder map

### 2.1 Where the core lives: a new `packages/core`

| Option | Verdict |
|---|---|
| Put it in `packages/shared` | Rejected. `shared` is the wire protocol: types and constants (`shared/src/index.ts`, 519 lines), imported type-only by the extension. The core is behavior (about 6-7k lines once moved) with a different reason to change. Mixing them makes every protocol consumer depend on handler code. |
| New `packages/extension/src/actions.ts`, keep parity tests | Rejected by arch's direction: it keeps two bodies. |
| New private package `packages/core`, source-only like `shared` (`"main": "./src/index.ts"`) | **Chosen.** Depends on `@browser-link/shared` only. Zero runtime npm dependencies. |

### 2.2 How each side consumes it

- **Extension: bundled with esbuild** (decided, section 8, Q1). Chrome cannot
  resolve a bare workspace specifier, so the extension needs a bundler before
  it can import core at runtime. esbuild because: a stable programmatic API in
  a ~30-line `build.mjs`, an explicit `target: 'chrome118'`, unsplit readable
  ESM output that fits the module worker and the three HTML entries,
  deterministic output for the same input. It is not a new package in the
  install: `esbuild@0.28.2` is already in `pnpm-lock.yaml` (pulled by `vite`
  and `tsx`) and its postinstall is already allowed (`pnpm-workspace.yaml`
  `allowBuilds: esbuild: true`). Slice 4 makes it an exact direct
  devDependency of the extension (`"esbuild": "0.28.2"`), so the version the
  extension builds with no longer depends on what vite or tsx resolve.
  `tsc --noEmit` stays as the type check.
- **Server: a generated mirror compiled by its existing `tsc`** (decided,
  section 8, Q2). The server's build is `tsc`, its `dist/` is 182 files, five
  modules locate files relative to their own path with `import.meta.url`
  (`cli.ts`, `commands/extension.ts`, `entry-info.ts`,
  `lifecycle/version-endpoint.ts`, `version.ts`), and `cli.ts` lazy loads ten
  modules with `import()`. Bundling the server would change all of that on the
  publish path. Instead the server compiles a committed mirror (2.3).

Whether `tsc` accepts a runtime import of core under the extension's
`rootDir: "src"` is not yet proven (audit blind spot). The same resolution
already works type-only for `@browser-link/shared` (source `main`, same
`rootDir`); slice 5 proves it for a runtime import with
`tsc --noEmit` (which slice 4 introduces), and if it fails, the extension's
type check drops `rootDir` (it emits nothing after slice 4, so `rootDir` has no
output to shape).

### 2.3 The mirror

- **What is copied.** `scripts/sync-core.mjs` writes the production files of
  `packages/core/src/**` and `packages/shared/src/**` into
  `packages/server/src/generated/{core,shared}/` with a
  `// GENERATED from packages/<pkg>/src/<path>. Do not edit.` header.
  Production means: `*.ts` that is not `*.test.ts`, not under `fitness/`, not
  under `ports/contract/` fixtures, not `*.fixture.json`. Core's tests run once,
  in `packages/core`; the server never runs them twice.
- **Server vitest.** `packages/server/vitest.config.ts` adds
  `exclude: ['src/generated/**', ...defaults]` to `test` and
  `src/generated/**` to `coverage.exclude`, so a copied file can never be
  picked up as a test or counted as server coverage.
- **When it runs.** Explicit in the scripts, no `pre*` hooks (pnpm's pre/post
  script defaults are not relied on):
  - `packages/server` `build`: `node ../../scripts/sync-core.mjs && tsc`;
  - `packages/server` `test`: `node ../../scripts/sync-core.mjs --check && vitest run`.
- **`--check` mode** writes nothing: it compares what it would write with what
  is committed and exits 1 listing every missing, extra or different file. It
  replaces the planned `mirror.test.ts` (which would sit inside the excluded
  `src/generated/`). Its own unit test (`scripts/sync-core.test.mjs`, run by
  the root `node --test "scripts/**/*.test.mjs"`) RED-probes the three
  failures: a changed byte, an extra file, a missing file.
- **Committed**, so `tsx`, vitest and a fresh clone work without a build step.

### 2.4 Version policy for `packages/core`

`packages/core/package.json`: `"name": "@browser-link/core"`,
`"private": true`, `"version": "0.0.0"`, like `packages/e2e`. It is not added
to `scripts/lib/versions.mjs` `VERSIONED_FILES`, so the Version Gate
(`version-gate.yml`) and `scripts/release.mjs` ignore it; it never publishes.
What ships is the server's mirror and the extension bundle, both versioned by
the files already in the gate.

### 2.5 Target folders

```
packages/core/src/
  support/          settle.ts expect.ts keymap.ts screenshot.ts observer-host.ts
                    utf8.ts (utf8ByteLength) flow-limits.ts
  inpage/           builders.ts observer.ts deep-query.ts dom-helpers.ts
  policies/         idle-rules.ts
  ports/            clock.ts cdp-session.ts page-driver.ts page-info.ts
                    settings.ts flow-history-store.ts detached-flow-store.ts
                    events-out.ts downloads.ts content-settings.ts index.ts
  session/          tab-session.ts tab-registry.ts pending-replies.ts
                    page-driver.ts (CDP implementation of the PageDriver port)
  flow/             flow-engine.ts (today flow.ts) flow-run.ts
                    flow-registry.ts flow-history.ts detached-flows.ts
  actions/          perform-find.ts perform-click.ts perform-type.ts
                    perform-press.ts perform-wait-for.ts perform-drag.ts
                    click-landing.ts frame-watch.ts
  tools/            registry.ts (ToolRegistry, cdpToolSupport())
                    failure.ts (ToolFailure, ToolOutcome)
                    interaction.ts wait-for.ts drag.ts page-read.ts
                    capture.ts dialog-permission.ts download.ts flow.ts
  fitness/          architecture.test.ts layers.ts
  ports/contract/   contract functions (5.3, item 5)

packages/extension/src/
  background.ts     composition root (budget in 5.4)
  adapters/         chrome-cdp-session.ts chrome-page-info.ts
                    chrome-flow-history-store.ts chrome-detached-flow-store.ts
                    chrome-settings.ts ws-events-out.ts chrome-downloads.ts
                    chrome-content-settings.ts chrome-windows.ts
                    chrome-alarms.ts chrome-runtime.ts chrome-tab-events.ts
                    web-socket.ts
  app/              tab-connection.ts connection.ts recording.ts repair.ts
                    popup-router.ts windows.ts activity-admin.ts tab-events.ts
  (stays)           popup.ts activity.ts admin.ts admin-view.ts i18n.ts
                    ui-language.ts notice-policy.ts reconnect-policy.ts
                    repair-policy.ts connect-failure-policy.ts
                    flow-recording-policy.ts handshake-diagnosis.ts
                    version-status.ts worker-messages.ts recording.ts
                    download-capture.ts inpage/recorder.ts
                    idle-settings.ts flow-labels.ts (both from slice 5b)

packages/server/src/cdp/
  transport.ts      cdp-direct adapter: connections, gate, outcome -> wire
  adapters/         cdp-client-session.ts cdp-page-info.ts
                    config-settings.ts bridge-events-out.ts
  (unchanged)       client.ts targets.ts gate.ts grant.ts
                    detached-flows.ts (section 8, Q4)
  support.ts        re-exports CDP_TOOL_SUPPORT derived from the registry (3.3)
packages/server/src/messages.ts   re-export of generated/shared (slice 5c)
packages/server/src/generated/{core,shared}/   mirror, never edited by hand
```

Policies that only the extension uses stay where they are and stay pure
functions: `reconnect-policy.ts`, `notice-policy.ts`, `repair-policy.ts`,
`connect-failure-policy.ts`, `flow-recording-policy.ts`,
`handshake-diagnosis.ts`, `version-status.ts`. The idle rules move to core
because `TabSession` uses them; the idle settings (storage keys, console
command text) stay in the extension (slice 5b). `download-capture.ts` stays in
the extension: it owns the held-download state and only the extension has
downloads (`CDP_TOOL_SUPPORT` `download: false`).

### 2.6 What stays in `background.ts`

Construction of the adapters and the core services, the ten listener
registrations and the sweep interval (each a one-line delegation into `app/`
or core), the three startup calls, and the `BRIDGE_PORT` constant (decided,
section 8, Q3). Nothing else.

---

## 3. Ports, page driver, tool registry, failure contract

All core ports live in `packages/core/src/ports/`. Each is small, named after a
capability, and typed in core's own vocabulary: no port mirrors a `chrome.*`
API shape. Core receives them by constructor or function argument; it never
reaches for a global.

### 3.1 Ports

```ts
// clock.ts: all time in core goes through this (slice 5b).
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Run `fn` once after `ms`; returns cancel. Replaces setTimeout/clearTimeout. */
  after(ms: number, fn: () => void): () => void;
  /** Run `tick` every `ms`; returns stop. Replaces setInterval. */
  every(ms: number, tick: () => void): () => void;
}

// cdp-session.ts: one debugger session on one page.
export interface CdpSession {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  /** Every CDP event of this session. Returns the unsubscribe function. */
  onEvent(listener: (method: string, params: unknown) => void): () => void;
}

// page-info.ts: what the transport knows about the page outside CDP.
export interface PageInfo {
  info(): Promise<{ url: string; title: string }>;
  /** Resolves when the page reports load complete, rejects on timeout. */
  waitForLoad(timeoutMs: number): Promise<void>;
}

// settings.ts: synchronous reads; the adapter keeps the cache current.
// Only what core decides on. Flow recording is extension-only (app/recording.ts).
export interface IdleSettings {
  idleTtlMinutes(): number;
}

// flow-history-store.ts and detached-flow-store.ts: typed repositories.
export interface FlowHistoryStore {
  load(tabId: number): Promise<FlowHistoryEntry[]>;
  save(tabId: number, entries: readonly FlowHistoryEntry[]): Promise<void>;
  drop(tabId: number): Promise<void>;
}
export interface DetachedFlowStore {
  list(): Promise<DetachedFlowRecord[]>;
  put(record: DetachedFlowRecord): Promise<void>;
  remove(flowIds: readonly string[]): Promise<void>;
}

// events-out.ts: events the core emits toward the server's event log.
export interface EventsOut {
  emit(tabId: number, event: BridgeEventPayload): boolean; // false: not delivered
}

// downloads.ts: returns data; the stateful capture stays behind the adapter.
export interface Downloads {
  /** Arm a capture for the tab, run `act`, report what Chrome downloaded. */
  captureAround(tab: TabDownloadSignals, holdMs: number, act: () => Promise<void>): Promise<CaptureOutcome>;
  settle(downloadId: number, saved: boolean): Promise<ChromeDownloadOutcome>;
}

// content-settings.ts
export interface ContentSettings {
  set(setting: string, primaryPattern: string, value: string): Promise<void>;
}
```

The two repositories replace revision 1's `chrome.storage`-shaped
`KeyValueStore`. Key naming (`flow-registry.ts` `flowHistoryKey`,
`detachedFlowKey`), parsing (`parseFlowHistory`, `parseDetachedFlowRecord`)
and the quota rule (`MAX_DETACHED_MANIFEST_BYTES`) decide what a valid record
is, so the parsing and bounds stay in core (`FlowHistory`, section 4) and the
adapter only serialises: the extension's adapters wrap `chrome.storage.session`
with today's keys, so stored data keeps its format across the refactor
(item 1 of the high-risk list is not touched); cdp-direct does not use them
(Q4).

`Downloads` returns `CaptureOutcome` and `ChromeDownloadOutcome`, the types
`download-capture.ts` already exports; the extension adapter wraps
`createDownloadCapture(chrome.downloads)` and its `captureAround`. Core never
holds the `DownloadCapture` object.

Extension-only capabilities get adapters too, so "`chrome` only in
`adapters/**` and `background.ts`" (5.3) is true. They are not core ports:
their interfaces live next to the `app/` module that uses them.

| Extension interface (in `app/`) | Adapter | Wraps today's |
|---|---|---|
| `Windows` (`open`, `focus`, `exists`, `onClosed`) | `chrome-windows.ts` | Activity/Admin `chrome.windows.create/get/update/onRemoved` |
| `Alarms` (`set`, `clear`, `onFire`) | `chrome-alarms.ts` | reconnect safety net `chrome.alarms.create/clear/onAlarm` |
| `Runtime` (`manifestVersion`, `pageUrl`, `onMessage`) | `chrome-runtime.ts` | `chrome.runtime.getManifest/getURL/onMessage` |
| `TabEvents` (`get`, `onUpdated`, `onRemoved`, `onCreated`, `onDebuggerDetach`) | `chrome-tab-events.ts` | `chrome.tabs.*`, `chrome.debugger.onDetach` |
| `SocketFactory` | `web-socket.ts` | `new WebSocket(...)` in the connection code |
| `SettingsCache` (adds `flowRecordingEnabled`) | `chrome-settings.ts` | `storage.local` + `storage.onChanged` caches |

| Core port | Extension adapter | cdp-direct adapter |
|---|---|---|
| `Clock` | `Date.now`, `setTimeout`, `setInterval` | same Node globals |
| `CdpSession` | `chrome.debugger.sendCommand` + `onEvent` filtered by `source.tabId` (`background.ts` `cdp`, `attachDebuggerListener`) | `cdp/client.ts` `CdpClient` |
| `PageInfo` | `chrome.tabs.get`, `onUpdated` status complete (`background.ts` `waitForLoad`) | `Target.getTargetInfo`, `Page.loadEventFired` (`transport.ts` `getTargetInfo`, `waitForLoad`) |
| `IdleSettings` | `chrome-settings.ts` | not used by cdp-direct (Q4) |
| `FlowHistoryStore`, `DetachedFlowStore` | `chrome.storage.session` | not used by cdp-direct (Q4) |
| `EventsOut` | `send(connection.ws, ...)` | the `BridgeEventLog` sink of `detached-flows.ts` |
| `Downloads` | `createDownloadCapture(chrome.downloads)` | none |
| `ContentSettings` | `chrome.contentSettings` | none |

Not ports, on purpose: dialogs (CDP events on `CdpSession` plus
`Page.handleJavaScriptDialog`; the pending dialog is `TabSession` state) and
the tab registry (a core class, section 4).

### 3.2 `PageDriver`: narrow page capabilities

Revision 1's `cdp-glue.ts` was a bag of nine functions. It becomes a
`PageDriver` built once per `CdpSession` in `core/session/page-driver.ts`, and
exposing narrow capabilities that handlers require one by one:

```ts
// ports/page-driver.ts
export interface Evaluator {          // evaluateInTab, evaluateObserverJs
  evaluate<T = unknown>(expression: string, opts?: { awaitPromise?: boolean }): Promise<T>;
}
export interface Keyboard {           // dispatchKeyEvent, Input.insertText
  key(event: KeyEventInit): Promise<void>;
  insertText(text: string): Promise<void>;
}
export interface Pointer {            // Input.dispatchMouseEvent
  mouse(event: MouseEventInit): Promise<void>;
}
export interface Settler {            // runSettle, settleWithChanges,
  mark(): Promise<ObserverMark | null>;   // takeObserverMark, installObserver,
  settle(params: SettleParams, mark: ObserverMark | null): Promise<SettleReport>;
}                                     // handleObserverMessage
export interface CdpEvents {          // waitForCdpEvent
  waitFor(method: string, predicate: (params: unknown) => boolean, timeoutMs: number): Promise<unknown>;
}
export interface PageDriver {
  evaluator: Evaluator; keyboard: Keyboard; pointer: Pointer;
  settler: Settler; events: CdpEvents; page: PageInfo;
}
```

One implementation serves both transports, because both have a `CdpSession`;
the nine twin helpers in `transport.ts` are deleted with slice 9.

### 3.3 `ToolRegistry`: handlers declare what they require

The 22-case `handleTool` switch and the 14-case `callCdpTool` switch become one
registry:

```ts
// tools/registry.ts
export type Requirement =
  | 'evaluator' | 'keyboard' | 'pointer' | 'settler' | 'cdp-events'
  | 'capture-buffers' | 'dialogs' | 'drag' | 'canvas' | 'tab-events'
  | 'downloads' | 'content-settings' | 'flows' | 'idle';

export interface ToolEntry<P> {
  name: string;                       // wire name: 'click', not 'browser.click'
  requires: readonly Requirement[];
  listed: boolean;                    // false for internal wire tools (download_settle)
  coerce(params: Record<string, unknown>): P;   // today's argument coercion, once
  handler(deps: Pick<ToolDeps, ...>, params: P): Promise<ToolOutcome>;
}
export function dispatchTool(registry, provided: ReadonlySet<Requirement>, deps, tool, params): Promise<ToolOutcome>;
export function cdpToolSupport(registry, provided: ReadonlySet<Requirement>): ReadonlyMap<string, boolean>;
```

- Each handler's `deps` type is the `Pick` of exactly what it `requires`;
  there is no `ToolContext` bag. A handler for `state` gets an `Evaluator`
  and nothing else; `download` gets `Evaluator`, `Settler` and `Downloads`.
- `cdp/support.ts` `CDP_TOOL_SUPPORT` becomes
  `cdpToolSupport(REGISTRY, CDP_DIRECT_PROVIDES)`; `isCdpToolSupported` and the
  dispatcher gate in `tools/browser-dispatch.ts` are unchanged. A test pins the
  derived map equal to today's 23 entries, in today's order, with today's
  values (14 `true`, 9 `false`), so the derivation is a refactor. Some of
  today's `false` entries are v1 scope decisions rather than missing
  capabilities (`drag`, `console`, `network`); `CDP_DIRECT_PROVIDES` encodes
  that scope (no `drag`, no `capture-buffers`), and changing it is a
  behavior-change PR (7(e)).
- `background.ts` has no tool `case` labels after slice 18 (fitness test 3).

### 3.4 Failure contract

Today the wire carries `{ ok: false, error: string, sensitive_field?: true }`
and the error strings are behavior: agents read them. Core names the failure
kinds explicitly and each transport maps them, byte-identical to today:

```ts
// tools/failure.ts
export type ToolFailure =
  | { kind: 'action'; message: string }        // a perform* returned ok:false
  | { kind: 'sensitive'; message: string }     // type/press failed after acting on a sensitive field
  | { kind: 'thrown'; message: string }        // an exception in the handler (CDP error, bad input)
  | { kind: 'unknown-tool'; tool: string }     // not in the registry
  | { kind: 'unsupported'; tool: string; missing: Requirement[] };
export type ToolOutcome = { ok: true; result: unknown } | { ok: false; failure: ToolFailure };
```

| Kind | Extension wire (`tool.response`) | cdp-direct (`callCdpTool`) | Source today |
|---|---|---|---|
| `action` | `ok: false, error: message` | `throw new Error(message)` | `handleTool` per-case `!outcome.ok`; `failureError` |
| `sensitive` | `ok: false, error: message, sensitive_field: true` | `throw new SensitiveFieldError(message)` | `handleTool` cases `type`, `press`; `failureError` |
| `thrown` | `ok: false, error: err.message` (or `String(err)`) | rethrown unchanged | `handleTool` `catch` |
| `unknown-tool` | `ok: false, error: "Unknown tool: <tool>"` | today's defense-in-depth `default` text, unchanged | `handleTool` `default`; `callCdpTool` `default` |
| `unsupported` | not reachable (the extension provides every requirement) | not reachable (the dispatcher gate refuses first); kept as a typed defense | `browser-dispatch.ts` gate |

The server side of the extension transport already turns
`sensitive_field: true` into `SensitiveFieldError` (`bridge/ws-bridge.ts`), so
both transports reach `activity/extract.ts` with the same class. Transport
failures that are not tool failures (cdp-direct gate, malformed `cdp:` id,
connection loss; extension socket closed) stay in each transport and are not
part of `ToolFailure`.

`defineToolOutcomeMappingContract` (5.3, item 5) feeds both mappings one
outcome per kind and asserts the table above. Error-path e2e cases (slice 3b)
pin the real strings in Chrome before slice 10 moves the first handler, and
the differential records `ok: false` results with their `error` text
unmasked.

---

## 4. Aggregates and invariants

Revision 1 cut the aggregates along today's data structures. Here each class
owns one set of invariants and nothing else.

### `TabSession` (core/session/tab-session.ts)

The per-tab page state both transports need; no socket, no server metadata.
Invariants:

1. **Activity never goes backwards.** `lastActivityAt` only increases; the end
   of a call sets it to `max(lastActivityAt, now)`.
2. **A running call holds the idle clock.** `runCall(fn)` takes the hold and
   releases it on every exit path, throw included, so a caller cannot forget
   the `finally`; the hold never counts past `MAX_CALL_HOLD_MS`
   (`idle-policy.ts`, moving to `idle-rules.ts`).
3. **What counts as activity.** A tool request and a `tool.cancel` touch the
   clock; activity-panel and admin replies do not (today the WebSocket
   `message` listener).
4. **A running flow holds the tab** until `idleHoldUntil(entry, deadline)`;
   the session answers `idleCandidate(now, ttl, flowHolds)`.
5. **Bounded buffers.** Console at most `CONSOLE_BUFFER_MAX = 200`, network at
   most `NETWORK_BUFFER_MAX = 200`, oldest dropped first, `networkOrder` and
   `networkBuffer` always hold the same ids.
6. **At most one pending dialog**, set on `Page.javascriptDialogOpening`,
   cleared on `Page.javascriptDialogClosed` (`attachDebuggerListener`).
7. **Observer state.** `observer.installed === false` means every action
   reports `settle.changes: null`; the script id is removed on cleanup.

### `TabConnection` (extension/app/tab-connection.ts)

The extension's link for one tab: the `WebSocket`, the server metadata learnt
at handshake, the reconnect bookkeeping and the recording fields (cdp-direct
has neither socket nor recording). It holds a `TabSession` and never the
other way round. Its invariants (one socket per tab, socket closed on
cleanup, recording state cleared on disconnect) are unit-tested with a fake
`SocketFactory`.

### `TabRegistry<S>` (core/session/tab-registry.ts)

Owns the two invariants today split between `tabStates` and
`connectsInFlight`:

1. **Create once.** `connect(tabId)` on a tab that has a session fails with
   `tab-already-connected` (today's handshake check).
2. **In-flight reservation.** `reserve(tabId)` returns a token or `null` when a
   connect is already in flight; the token is released by `commit(token,
   session)` or `abort(token)`, never both, and `isReservedOrLive(tabId)` is
   what the reconnect scheduler reads today through
   `connectsInFlight.has(tabId)`.

The extension instantiates it with `TabConnection`, cdp-direct with its
connection record (`transport.ts` `connections`), so cdp-direct keeps its own
idle model (Q4) while sharing the create-once rule it already has.

### `FlowRun`, `FlowRegistry`, `FlowHistory` (core/flow/)

- **`FlowRun`**: one flow's state machine. Invariants: `shouldStop` turns
  true at `expiresAt = start + MAX_DETACHED_FLOW_MS` (30 min) or on cancel;
  **cancel is idempotent**; **finished exactly once** (`finish` returns the
  result once; a second call is a no-op).
- **`FlowRegistry`** (one per tab, today `flow-registry.ts`
  `createFlowRegistry`): **one detached flow per tab**; cancel of an unknown or
  finished id is a no-op; the foreground deadlines (today
  `foregroundFlowDeadlines`) live here.
- **`FlowHistory`** (persistence, over `FlowHistoryStore` and
  `DetachedFlowStore`): **bounded storage** (`MAX_FLOW_HISTORY_PER_TAB = 20`,
  `MAX_DETACHED_FLOW_RECORDS = 10`, `MAX_DETACHED_MANIFEST_BYTES = 128_000`);
  **writes are serialized** and a failed write never breaks the chain;
  **no resurrection** (today `flowHistoryDroppedAt`); **one terminal record
  and one `flow-finished` event** per detached flow (today
  `flushingFlowEvents`); **worker restart** turns a record still `running`
  into `worker-terminated` (today `recoverDetachedFlows`).

### `PendingReplies<T>` (core/session/pending-replies.ts)

Replaces the three request/reply Maps of `background.ts`:
`pendingActivityQueries`, `pendingAdminRequests`, `pendingRepairs`.
Invariants: an id resolves at most once; a reply for an unknown id is
ignored; `expire(id)` and `rejectAll(reason)` (on disconnect) settle every
waiter so none leaks. It needs nothing from Chrome, so it sits in core's
session layer and is unit-tested there; only the extension uses it today.

Claims stay with the server (`server/src/bridge/dispatch.ts`); held downloads
stay in `DownloadCapture` (`download-capture.ts`, already tested).

### Pure policies stay functions

`idle-rules`, `reconnect-policy`, `notice-policy`, `repair-policy`,
`connect-failure-policy`, `flow-recording-policy`, `download-capture`'s
`attributedSignal`, `settle`, `expect`, `keymap`, `screenshot`'s planning,
`observer-host`'s mirror functions, and the flow engine's `runFlow` (it takes
`FlowDeps`). They get no object wrapper.

---

## 5. Dependency rule, layers and fitness tests

### 5.1 Purity

Core compiles with `"lib": ["ES2022"]` and `"types": []`: no `chrome`, no
`process`, no `Buffer`, no DOM, no `TextEncoder`, no `setTimeout`. Verified
against the code to be moved, three modules fail that today and are fixed in
place by slice 5b, before anything moves:

| Module | Impurity at `5ce3055` | Fix in slice 5b |
|---|---|---|
| `flow-registry.ts` | `import type { Messages } from './i18n.js'` (UI copy) for `flowTabLabel`, `describeFlowProgress`, `stopReasonLabel`, `describeFlowHistoryEntry` | those four move to a new extension module `flow-labels.ts`; callers re-pointed |
| `flow-registry.ts` | `measureJsonBytes` uses `new TextEncoder()` | `support/utf8.ts` `utf8ByteLength(s)`, a pure UTF-8 byte count; a test asserts it equals `new TextEncoder().encode(s).length` for ASCII, CJK, emoji and lone surrogates (encoded as U+FFFD, 3 bytes) |
| `idle-policy.ts` | storage keys (`CONSOLE_IDLE_TTL_STORAGE_KEY`, legacy keys), storage parsing (`effectiveIdleTtlMinutes`, `legacyIdleChoice`, `parseIncomingSettings`, `shouldAcceptIncomingSettings`) and CLI copy (`idleTtlCommand`) mixed with the rules; imports `MAX_DETACHED_FLOW_MS` from `flow-registry` | rules (`clampIdleTtlMinutes`, `shouldDisconnectForIdle`, `idleHoldUntil`, `activityAfterFlowEnded`, `tabsToDisconnectForIdle`, `shouldScheduleIdleSweep` and the limits) become `idle-rules.ts`; the rest becomes extension `idle-settings.ts`; `MAX_DETACHED_FLOW_MS` moves to `flow-limits.ts`, which `flow-registry` re-exports |
| `flow.ts` | the wait step calls `setTimeout`; `deps.now ?? Date.now` | `FlowDeps` takes a `clock: Clock` |
| `expect.ts` | default deps `now: () => Date.now()` and `setTimeout`; `withProbeTimeout` uses `setTimeout`/`clearTimeout` | take a `Clock`; `withProbeTimeout` uses `clock.after` |

Proof that the set is complete: slice 5b adds
`packages/core/tsconfig.purity.json` with core's compiler options and
`"files"` set to the extension modules slated to move (the closure of their
imports is checked with them). `tsc -p packages/core/tsconfig.purity.json`
fails at the start of 5b (RED, recorded in the PR) and passes at its end; CI
runs it until slice 8, after which every listed module is in core and core's
own `tsc -p packages/core` covers it, and the file is deleted.

### 5.2 Layers inside core

```
tools         -> actions, flow, session, ports, support, policies, inpage
actions       -> session, ports, support, inpage
session, flow -> ports, support, policies, inpage     (session and flow do not import each other)
ports         -> support (types only), shared
support       -> inpage
policies      -> support (flow-limits only)
inpage        -> (nothing in core)
```

The layers file `core/src/fitness/layers.ts` states this table as data:
folder name to allowed folders. Within a folder, imports are free but
acyclic. `@browser-link/shared` is allowed everywhere.

The existing `idle-policy.ts` → `flow-registry.ts` edge (policies → flow)
would break the rule; slice 5b removes it by moving `MAX_DETACHED_FLOW_MS` to
`support/flow-limits.ts`.

| Module | May import | Must not import |
|---|---|---|
| `packages/core/src/**` | `@browser-link/shared`, core files per 5.2 | `chrome`, `node:*`, any npm package, extension, server |
| `packages/extension/src/adapters/**` | core, shared, `chrome` | other adapters |
| `packages/extension/src/app/**` | core, shared, extension policies, interfaces of its own module | `chrome` |
| `packages/extension/src/background.ts` | anything in the extension | tool logic (no tool `case` labels) |
| `packages/server/src/cdp/**` | `generated/core`, `generated/shared` | `packages/core` by relative path |

### 5.3 Enforcement, all run by `pnpm test` in CI

1. **Compile-time:** `packages/core/tsconfig.json` sets `"lib": ["ES2022"]`
   and `"types": []` (5.1). The in-page builders are strings and need no DOM
   types.
2. **`core/src/fitness/architecture.test.ts`:** parses every core file with
   the TypeScript API and fails on
   - an import specifier that is not relative and not `@browser-link/shared`,
     any `node:` specifier, any identifier `chrome`, any `import(` call;
   - an import that goes against `layers.ts` (5.2);
   - any import cycle (Tarjan over the import graph, type-only imports
     included).
   RED probes, each a fixture directory under `fitness/fixtures/` parsed by
   the same function and expected to fail with a named rule: a `chrome`
   identifier; a `node:fs` import; an npm import; a dynamic `import(`; a
   `policies` file importing `flow`; an `actions` file importing `tools`; a
   two-file cycle. Fixtures are excluded from the mirror (2.3).
3. **`extension/src/fitness.test.ts`:**
   - `chrome` identifiers appear only in `adapters/**` and `background.ts`;
   - adapters stay free of logic: no `if`/`switch`/loop in an adapter beyond
     argument mapping, checked as "every exported function body has
     cyclomatic complexity 1 or is listed with a reason" (condition 2 of R6);
   - `background.ts` line budget, constant `BACKGROUND_LINE_BUDGET` (5.4);
   - `background.ts` contains no `case '<tool>'` for any registry name;
   - every `addListener` call in `background.ts` is a top-level statement
     (R1);
   - no bundled module other than `background.ts` declares a top-level
     `BRIDGE_PORT` (Q3).
4. **Mirror:** `sync-core.mjs --check` in the server's `test` script (2.3).
5. **Port contract suite** (`core/src/ports/contract/*.ts`): plain functions
   `defineCdpSessionContract(make)`, `definePageInfoContract(make)`,
   `defineFlowHistoryStoreContract(make)`, `defineDetachedFlowStoreContract(make)`,
   `defineToolOutcomeMappingContract(map)` that use only a tiny assertion
   helper, no vitest globals, so they run anywhere. They run against:
   - an in-memory fake of every port, under vitest in `packages/core`
     (condition 3 of R6);
   - the cdp-direct adapters under vitest, with a headless Chrome target in the
     e2e job for `CdpSession` and `PageInfo`;
   - the extension adapters inside the real service worker (R6).
   What the suite pins: `send` resolves with the CDP result and rejects with
   the CDP error message unchanged; events arrive in order and stop after
   unsubscribe; `waitForLoad` resolves on load and rejects on timeout; the
   stores round-trip records and `remove`/`drop` are idempotent; the outcome
   mapping follows the table in 3.4.

### 5.4 The `background.ts` budget, re-measured

`BACKGROUND_LINE_BUDGET` starts at **4922** in slice 5 and every slice that
moves code out lowers it to the new count; it is never raised without arch
sign-off. With adapters for `windows`, `alarms`, `runtime`, tab events and the
socket, the composition root holds: imports (~45 lines), construction of 13
extension adapters and the core services (~70), ten listener registrations as
one-line delegations plus the interval (~25), three startup calls and
`BRIDGE_PORT` with its comment (~15), and file comments. Estimate: **about
200 lines**. The ceiling stays **400**; slice 22 sets the constant to the
measured count, so the slack is not left as room to grow.

---

## 6. Slice plan

Each slice is one PR, releasable on its own (all suites green, e2e and
differential green from slice 3 on) and revertible with `git revert` of its
merge commit alone, because no later slice is merged until it is green.
Planning size: about 400 moved or authored lines; the deletion of a mirror
copy proven byte-identical by the existing guard is listed but not counted.
Every slice that moves code: e2e green on Chrome 118 (blocking) and stable
(reported, 7(a)), differential equal, budget constant lowered, the old code
deleted in the same PR only after the new path is green in CI (guarantee d).
Refactor commits and any behavior fix never share a commit (guarantee e).

### 6.1 Slices

| # | Slice | What moves or changes | Size (est.) | Proof | Revert |
|---|---|---|---|---|---|
| 0 | Chrome 118 + stable in CI (in progress, `ci/e2e-chrome-118-and-stable`) | e2e job becomes a 118 leg and a stable leg (7(a)); Chrome for Testing 118.0.5993.70 installed with `npx @puppeteer/browsers install chrome@118.0.5993.70` (cached); `run.mjs` writes `{browser, product, revision}` to `$GITHUB_STEP_SUMMARY` and `e2e-result-<leg>.json` from the version it already reads | ~80 authored | both legs run; summary shows the two versions | revert the PR; CI falls back to one leg |
| 1 | e2e: page read and capture | cases for `navigate`, `state`, `ping`, `screenshot`, `canvas_screenshot`, `console`, `network`, `network_body`; fixtures in `packages/e2e/pages/` | ~350 authored | each case fails under `E2E_EXPECT_FAIL=<tool>` and passes otherwise | revert; no product code touched |
| 2 | e2e: drag, permission, tabs, flow control | cases for `drag`, `set_permission`, `wait_for_tab`, `flow_status`, `flow_cancel` | ~350 authored | same as 1 | revert |
| 3 | Differential harness | `E2E_EXT_DIST`, `E2E_SERVER_CLI`, `E2E_SERVER_EXTENSION_ID` overrides in `lib.mjs`; `E2E_RECORD=<file>`; per-run `HOME`; `scripts/e2e-diff.mjs` (7(b)); CI job `e2e-diff` | ~350 authored | self-diff of two runs of the same build is empty; a one-token change in a result string and in an error string are both reported | revert |
| 3b | e2e: error paths | one case per `ToolFailure` kind reachable in Chrome (3.4): `action` (click on a missing selector), `sensitive` (type/press failure on a password field carries `sensitive_field`), `thrown` (evaluate throws), `unknown-tool` asserted through the contract suite only (no MCP path sends one), plus timeouts (`wait_for` expiry); the exact error text is asserted | ~250 authored | `E2E_EXPECT_FAIL` RED probe per case; the differential records them | revert |
| 4 | Bundler alone | `packages/extension/build.mjs` (esbuild `0.28.2` exact, entries `background`, `popup`, `activity`, `admin`, `format: 'esm'`, `target: 'chrome118'`, `bundle: true`, no minify, `sourcemap: 'linked'`); `build` becomes `tsc --noEmit && node build.mjs && node copy-assets.mjs`; `smoke-tarball.mjs` assertions (7(c)). No source file changes. | ~120 authored | 7(c) | revert restores tsc output |
| 5 | Core skeleton | `packages/core` (private, `0.0.0`, 2.4) with `ports/` (types only), `fitness/` with layers and cycle test and their RED fixtures, contract functions with in-memory fakes, `scripts/sync-core.mjs` with `--check` and its test, server `vitest.config.ts` exclusion, explicit `build`/`test` scripts, empty mirror, budget = 4922; the extension's `tsc --noEmit` proven with one runtime import from core (2.2) | ~400 authored | fitness and mirror checks green and RED-probed | revert |
| 5b | Core purity | slice 5.1 fixes in the extension, in place: `flow-labels.ts`, `utf8ByteLength`, `idle-rules.ts` / `idle-settings.ts` split, `flow-limits.ts`, `Clock` through `flow.ts` and `expect.ts`; `tsconfig.purity.json` in CI | ~300 authored / moved | `tsc -p packages/core/tsconfig.purity.json` RED then GREEN; unit tests of moved functions unchanged and green; e2e; differential equal | revert |
| 5c | Server `messages.ts` from the mirror | `generated/shared/` populated; `server/src/messages.ts` becomes a re-export of `./generated/shared/index.js`; the "wire protocol drift guard" block of `config.drift.test.ts` deleted (the mirror check covers it) | ~20 authored, copy deleted ~400 | server `tsc` green; a test lists the names `messages.ts` exported before and asserts each is still exported; e2e; differential | revert |
| 6 | In-page code | `inpage/{builders,observer,deep-query,dom-helpers}` to core; server copies replaced by the mirror; `builders-parity.test.ts` deleted | moved ~4k (renames), copies deleted | e2e, differential, unit tests re-homed | revert |
| 7 | Support modules | `settle`, `expect`, `keymap`, `screenshot`, `observer-host` to `core/support/` (after 6: `settle` and `expect` import `inpage/builders`, `observer-host` imports `inpage/observer`); their `drift.test.ts` sections deleted | moved ~1.15k, copies deleted ~1.25k | same | revert |
| 8 | Flow engine | `flow.ts` to `core/flow/flow-engine.ts`; `cdp/flow.ts` copy deleted; `tsconfig.purity.json` deleted | moved 1352 (rename), copy deleted 1348 | same | revert |
| 9 | Sessions and page driver | `CdpSession`/`PageInfo` adapters both sides; `PageDriver` (3.2) from `background.ts` `cdp`, `evaluateObserverJs`, `takeObserverMark`, `settleWithChanges`, `handleObserverMessage`, `installObserver`, `dispatchKeyEvent`, `evaluateInTab`, `waitForLoad`, and the nine twins in `transport.ts` | ~330 from background, ~250 deleted from server | contract suite green on fakes, cdp-direct and in the worker; R6 conditions 1-3 green (section 8); e2e; differential | revert |
| — | **Checkpoint A** (6.2) | | | | |
| 10 | Registry + interaction: find, click | `ToolRegistry`, `ToolFailure` and both outcome mappings; `performFind`, `performClick`, click landing, frame watch; their entries | ~380 | outcome-mapping contract; error-path cases from 3b; the two handlers leave `transport-parity` `HANDLERS` | revert |
| 11 | Interaction: type, press | `performType`, `performPress` and their entries (`sensitive` kind) | ~250 | RED probe: mapping `sensitive` like `action` fails the contract and the 3b case | revert |
| 12 | `TabSession`, `TabRegistry`, `TabConnection` | aggregates from `TabState`, `tabStates`, `connectsInFlight`, debugger intake (`attachDebuggerListener`), call hold, sweep, `cleanup` | ~400 (may split in two: core aggregates, then extension `TabConnection`) | unit tests of each invariant with a fake `Clock`, including a call that throws, one longer than the TTL, and a reserve/abort race | revert |
| 13 | wait_for | `performWaitFor` and its entry; the `network-url-mode` divergence becomes a `capture-buffers` requirement check, same behavior | ~200 | e2e; differential | revert |
| 14 | drag | `performDrag`, `handleDrag`; requires `drag`, which cdp-direct does not provide | ~330 | e2e case from slice 2 | revert |
| 15 | Page read and capture | `handlePing` ... `handleNetworkBody`, canvas builder; server cases `navigate`, `snapshot`, `state`, `screenshot`, `ping`, `evaluate` | ~300 | e2e from slice 1 | revert |
| 16 | Dialogs, permission, downloads | `handleDialogRespond`, `handleSetPermission`, `handleDownloadCapture`, `handleDownloadSettle`; `ContentSettings` and `Downloads` adapters | ~220 | e2e `dialog_respond`, `set_permission`, `download` | revert |
| 17 | `FlowRun`, `FlowRegistry`, `FlowHistory` | aggregates and the two store adapters (lines 3025-3287, `foregroundFlowDeadlines`) | ~330 | unit tests of each invariant with in-memory stores; store contract on fakes and in the worker | revert |
| 18 | Flow tools | `handleFlow`, `handleFlowStatus`, `buildFlowDeps`, server flow cases | ~250 + ~190 server | e2e `flow`, `flow_status`, `flow_cancel`; `CDP_TOOL_SUPPORT` now derived (3.3) with its snapshot test | revert |
| — | **Checkpoint B** (6.2) | | | | |
| 19 | Connection lifecycle | `app/connection.ts` (tab ids, reconnect wiring, WebSocket switch); `PendingReplies<T>`; `chrome-alarms`, `web-socket` adapters | ~450 | unit tests with a fake socket and alarms; e2e handshake and Origin cases | revert |
| 20 | Recording | `app/recording.ts` (lines 4328-4658) | ~330 | existing `recording.test.ts` plus new unit tests; manual popup check noted in PR | revert |
| 21 | Popup router, windows, repair, tab events | lines 633-900 (`chrome-windows`), 4234-4327, `chrome.runtime.onMessage` and tab events (`chrome-runtime`, `chrome-tab-events`) to `app/` | ~460 (may split in two) | unit tests of the router; e2e i18n and Admin cases; `wait_for_tab` case | revert |
| 22 | Retire parity guards | delete `transport-parity.test.ts` and the remaining copy sections of `drift.test.ts` and `config.drift.test.ts`; budget set to the measured count (5.4) | deletions only | contract suite green on fakes and both adapters in the same CI run | revert |

Order rationale: the safety net first (0-3b), then the build change alone
(4), then the empty core and its rules (5), core purity and the protocol copy
(5b, 5c), then modules whose move is a rename, bottom layer first (6-8), then
the page driver every handler needs (9), then handler families from the most
covered and most mirrored (10-11) to extension-only ones (14-16), aggregates
before the code that uses them (12 before 13, 17 before 18), and
extension-only application code last (19-21) because it is not mirrored and
only needs testability.

### 6.2 Value checkpoints and minimum viable end state

- **Checkpoint A, after slice 9.** Delivered: real-Chrome cases for every
  worker tool and error kind, the bundler, core with enforced layers, and
  every byte-copied module (in-page, support, flow engine, protocol) generated
  instead of hand-copied. Measured and reported to the owner: lines moved,
  mirror copies deleted, CI minutes per PR against 6.3, number of normalise
  table entries added because of flakiness. Go/no-go for slices 10-18.
- **Checkpoint B, after slice 18.** Delivered: one body per tool for both
  transports, one failure contract, `CDP_TOOL_SUPPORT` derived, aggregates
  with tested invariants. Go/no-go for slices 19-21.
- **Minimum viable end state:** slices 0-18 plus 22 (22 depends only on 18:
  contract suite green and one body per action). It closes all four findings.
  Slices 19-21 make the extension-only application code unit-testable and
  bring `background.ts` to its final budget; if the program stops at
  checkpoint B, slice 22 runs next and the budget stays at its slice 18 value.

### 6.3 CI cost per PR

Wall times are not measured yet (audit: no Chrome was run); slice 0 records
the e2e legs and slice 3 the differential, and checkpoint A compares them
with these budgets.

| Job | When | Timeout | Runs per PR |
|---|---|---|---|
| `ci` (unit, fitness, mirror check, build, smoke) | every PR | unchanged | 1 |
| `e2e` 118 leg | every PR | 10 min (today's) | 1 |
| `e2e` stable leg | every PR | 10 min | 1 |
| `e2e-diff` | PRs touching the paths in 7(b) | 20 min, its own | 1 HEAD run, plus 1 base run on a cache miss, plus 1 self-diff run when the normalise table or fixtures change |
| `e2e-diff` nightly self-diff | schedule, on `main` | 20 min | 2 runs |

---

## 7. How each guarantee is met

### (a) e2e case before a tool moves; Chrome 118 and stable in CI, version recorded

- Slices 1-2 add cases for the 13 tools whose code is in `background.ts` and
  that have none: `navigate`, `drag`, `screenshot`, `canvas_screenshot`,
  `console`, `network`, `network_body`, `set_permission`, `wait_for_tab`,
  `state`, `flow_cancel`, `flow_status`, `ping`. The other 14 are covered
  today. The 7 uncovered tools with no worker code (`claim_tab`,
  `release_tab`, `my_tabs`, `events`, `feedback`, `manual`, `reset`) are server
  only and outside this plan. Slice 3b adds the error paths.
- A table in `packages/e2e/src/run.mjs` maps each wire tool to its case; a
  unit test fails if a registry entry with `listed: true` has no case.
- **Release gate (owner decision, 2026-11-17).** The Chrome 118 leg blocks the
  publish: `release` `needs` the `ci` job and the 118 leg. The stable leg
  (the runner's auto-updating `/usr/bin/google-chrome`) runs on every PR and
  push, reports in the step summary and the PR checks, but is not in
  `release.needs` and does not block. When the stable leg fails on `main` (or
  on the nightly run), a step opens an issue with `gh issue create`, labelled
  `chrome-stable`, titled with the Chrome version, and skips creation when an
  open issue with that label and version exists. Each leg writes the browser
  version it ran on to the step summary and its `e2e-result-<leg>.json`
  artifact. Chrome for Testing 118 still honours `--load-extension`
  (`lib.mjs` `launchChrome`); this is P4 of the audit, not yet observed, and
  slice 0 observes it.

### (b) Differential check: old build and new build, equal outputs

`scripts/e2e-diff.mjs --base <ref>`:

1. **Base.** `base = git merge-base <PR target branch> HEAD`; in CI the target
   is `origin/${{ github.base_ref }}`, so a stacked PR compares against the
   PR below it, not `main`. `git worktree add <mktemp -d>/base <base>`,
   `pnpm install --frozen-lockfile`, `pnpm build` there.
2. **Runs.** HEAD's harness always drives, against HEAD's build and against
   the base build (`E2E_EXT_DIST`, `E2E_SERVER_CLI`, `E2E_SERVER_EXTENSION_ID`
   point at each build; `E2E_SERVER_EXTENSION_ID` replaces `lib.mjs`
   `SERVER_EXTENSION_ID`, which today is hard-wired to
   `packages/server/dist/auth/extension-id.js`, so the base run reads the base
   build's pinned id). Every run gets fresh `HOME`, `USERPROFILE`,
   `XDG_CONFIG_HOME` and `XDG_DATA_HOME` under its own `mktemp -d`, so the
   server's map, knowledge and config state starts empty.
3. **Normalise** each record with the committed table
   `packages/e2e/src/normalise.mjs`:
   - identifiers renamed by first appearance, keeping identity: tab ids,
     refs, `doc_id`, `flow_id`, `request_id`, download ids, observer marks,
     and Chrome's own ids (`requestId`, `loaderId`, `frameId`, `targetId`,
     `backendNodeId`, `executionContextId`, `scriptId`);
   - timing: keys ending in `_ms`, `elapsedMs`, `durationMs`, `started_at`,
     `finished_at`, `timestamp`, and any number above `1e12` under a key
     matching `/at$|time/i` become `<ms>`; ISO timestamps become `<iso>`;
   - ordering: entries of `console`, `network` and `events` results, whose
     interleaving across sources depends on timing, are compared as sorted by
     their canonical JSON; order within one source (for example one
     request's events) is kept;
   - paths: backslashes to `/`, drive letters dropped, the run's temp dir and
     `HOME` become `<tmp>` and `<home>`; ports become `<port>`; the Chrome
     version string becomes `<chrome>`;
   - image payloads become `{ format, width, height, sha256 }`;
   - error strings are never normalised beyond the rules above.
4. **Self-diff (table completeness).** Two HEAD runs must be equal after
   normalisation. It runs only when `normalise.mjs`, the harness or
   `packages/e2e/pages/` change in the PR, and nightly on `main`; otherwise
   one HEAD run is compared with the base record.
5. **Base record cache.** The normalised base record is cached with
   `actions/cache` under
   `e2e-record-<base sha>-<hash of run.mjs, lib.mjs, normalise.mjs, pages/>-<chrome version>`,
   so it is reused only when the same harness ran on the same base and
   browser.
6. **Gate.** Base vs HEAD must be equal; the script prints the first differing
   call with both values and exits 1.
7. **CI job `e2e-diff`**, Chrome 118 (the blocking browser), own
   `timeout-minutes: 20`, on every PR that touches `packages/extension/src`,
   `packages/core`, `packages/server/src/cdp`, `packages/server/src/generated`,
   `packages/server/src/messages.ts` or `packages/extension/build.mjs`. A PR
   whose purpose is a behavior change cannot pass it, which is intended: such
   a change goes in its own PR, labelled `behavior-change`, where the job
   reports the expected difference and the PR description names it.

### (c) The bundler lands alone

Slice 4 changes only build files: `packages/extension/build.mjs`,
`packages/extension/package.json` (script and the exact `esbuild` dev
dependency), `pnpm-lock.yaml`, `scripts/smoke-tarball.mjs`. Proof, all in the
PR:

- `git diff --stat main -- packages/extension/src` is empty.
- e2e green on 118 (stable reported); `e2e-diff` equal against `main`.
- `dist/extension/manifest.json` byte-identical before and after
  (`sha256sum` of both builds printed in the PR) and
  `packages/extension/manifest.json` untouched.
- `smoke-tarball.mjs` asserts, on the packed tarball:
  - the entry file names are unchanged: `background.js` (the manifest's
    `background.service_worker`), `popup.js`, `activity.js`, `admin.js`
    (the `src` of the three HTML files), each with its `.js.map`;
  - no `.d.ts` file under `dist/extension/`;
  - no top-level `await` in any bundled entry (a module service worker
    refuses one); checked by parsing the output, not by regex;
  - HTML, icons and manifest unchanged; everything outside `dist/extension/`
    unchanged against `npm pack --dry-run --json` of `main`, with the
    expected difference listed in the PR.
- The e2e's port patch (`lib.mjs` `extensionCopy`, a regex on
  `const BRIDGE_PORT = 17529;`) still matches the bundled `background.js`; it
  throws if it does not, so a green e2e proves it.
- **Release notes.** The changelog entry of the release that first ships the
  bundled extension says, in its user-facing part: "The extension's files
  changed layout. After updating, open `chrome://extensions` and press the
  reload button on browser-link (or remove and load it again)." The
  release's PR checklist carries the same line.

### (d) One handler family per PR; old code deleted only when the new path is green

The families are slices 10-18, one per PR. Within a slice, the first commit
adds the core version and switches both transports' dispatch to it; CI must be
green (unit, contract, e2e, differential); only then the next commit deletes
the old `background.ts` and `transport.ts` bodies and lowers the budget, and
CI runs again. The PR is not merged with the old body still present, and the
deletion commit is not pushed before the first commit's CI is green.

### (e) Refactor and behavior changes never share a commit

- Refactor commits are typed `refactor(core): ...`; behavior fixes are `fix:` or
  `feat:` commits in a separate PR.
- The differential job (b) is the mechanical check: a refactor PR with any
  difference fails.
- Known places where the move invites a behavior change, which this plan does
  not take: unifying the network buffer for cdp-direct (`network-url-mode`,
  `transport-parity.test.ts`), enabling drag, console, network or downloads
  on cdp-direct (`CDP_DIRECT_PROVIDES`, 3.3), unifying argument coercion
  (extension `String(p[key])` vs cdp-direct `''` for a missing `navigate`
  url: the registry entry keeps each transport's coercion behind a
  per-transport `coerce` override until a behavior PR unifies it), adopting
  `TabSession` idle rules or `FlowRun` on cdp-direct (Q4), and the two server
  notes in arch's answer (non-GET download refusal comment, Windows
  `table-changed` fallback). Each is its own PR if the owner wants it.

### (f) Fitness tests

Section 5: compile-time lib restriction, the purity check of slice 5b, and
`architecture.test.ts` (imports, layers, cycles) for core; `fitness.test.ts`
for `chrome` confinement, logic-free adapters, no tool `case` in
`background.ts`, top-level listeners, `BRIDGE_PORT` uniqueness and the line
budget; `sync-core.mjs --check` for the generated server copy; the port
contract suite run against fakes and both adapters, after which the parity
tests are deleted.

---

## 8. Decisions, risks and open questions

### Decided

**Q1 (arch). Bundler: esbuild**, pinned as an exact direct devDependency
(`0.28.2`). It is already installed (lockfile, through `tsx` and `vite`), has a
stable `chrome118` target, and its unsplit ESM output fits the module worker
and the HTML entries. Revision 1's "esbuild adds one dev dependency" was
imprecise: it adds a direct declaration, not a new package.

**Q2 (arch). Server: the generated mirror now.** Bundling the server, if it
ever happens, goes in its own PR with its own differential, after slice 22.

**Q3 (arch). `BRIDGE_PORT` stays in `background.ts`**, one copy guarded by
`config.drift.test.ts` as today. A fitness test (5.3, item 3) fails if any
other bundled module declares a top-level `BRIDGE_PORT`: esbuild renames a
colliding top-level name, which would break the e2e's literal-line patch.

**Q4 (owner, 2026-11-17). cdp-direct keeps its idle and flow models**
(`detached-flows.ts`; idle cleanup in `transport.ts`). This plan moves
`TabSession` and `FlowRun` for the extension only; adopting them on
cdp-direct is a separate behavior change.

**Q5 (owner, 2026-11-17). Source maps stay in the npm package.** The bundled
maps embed `packages/core` sources with workspace-relative paths; slice 4
reports their size.

**Release gate (owner, 2026-11-17).** Chrome 118 blocks the publish; stable
reports without blocking and a failure opens an issue (7(a)).

**R6 (arch). Contract suite inside the worker; the fallback.** The plan is to
run the extension adapters' contract suite in the real service worker: a
test-only build (`pnpm --filter @browser-link/extension build:contract`,
output in a temp dir, never in `dist/`) adds a `contract.js` entry, and the
e2e runs it through CDP `Runtime.evaluate` on the service-worker target. If
that proves fragile, the fallback (cdp-direct adapter suite against real
Chrome, plus the e2e as the extension adapters' proof) is acceptable only if
all three hold, and slice 9 does not merge until they do, whichever path is
taken:

1. a mechanical check shows every method of every extension adapter is reached
   by an e2e case (V8 coverage of the worker collected through CDP
   `Profiler.startPreciseCoverage` on the service-worker target during the
   e2e, intersected with the adapter files' exported functions; a method with
   zero calls fails the job);
2. adapters stay free of logic (fitness test, 5.3 item 3);
3. the contract suite also runs against an in-memory fake of every port
   (5.3 item 5).

### Risks

**R1. MV3 service-worker lifetime.** The worker can be stopped while idle;
today's design already survives it (flow records in `chrome.storage.session`,
reconnect state, `recoverDetachedFlows`). Moving code must not move any
startup work behind an `await` that delays listener registration: Chrome only
delivers wake-up events to listeners registered synchronously in the first
turn. The composition root registers all listeners synchronously at top level,
and `fitness.test.ts` checks that every `addListener` call in `background.ts`
is a top-level statement.

**R2. Module service worker constraints.** `manifest.json` declares
`"type": "module"`. A module service worker cannot use dynamic `import()` or
top-level `await`; `architecture.test.ts` rejects `import(` in core and slice
4's smoke check rejects top-level `await` in the bundle.

**R3. Chrome 118.** The minimum stays 118 (`manifest.json`
`minimum_chrome_version`). esbuild `target: 'chrome118'` lowers any newer
syntax. Download attribution relies on `Page.downloadWillBegin`; slice 0 is
the first CI run of the download cases on 118, and if they fail there the fix
(raise the minimum or degrade) is a behavior decision for the owner, not part
of the refactor.

**R4. Bundle size.** Measured in slice 4: the bundle should be close to the
sum of today's `.js` files. The PR reports the sizes; no budget is proposed
until measured.

**R5. Differential flakiness.** Results that depend on timing
(`settle.mutation_count`, `settled`, network entries arriving late) can differ
between two runs of the same build. The self-diff (7(b), step 4) exposes them
before they block a PR; each one must be either normalised in a reviewed
commit or made deterministic in the fixture. Screenshot hashes may differ by
anti-aliasing; if the self-diff shows that, images fall back to
`{format, width, height}` only, with the owner's agreement.

**R7. Line budget.** Re-measured in 5.4 (about 200 estimated, 400 ceiling).
If the composition root needs more than 400, the number is revised with arch,
not raised silently.

**R8. Purity check reach.** `tsconfig.purity.json` checks the modules on the
move list and their imports; a module added to the move list later must be
added to its `files`. Slice 8 deletes the file once every listed module lives
in core, where core's own `tsc` takes over.

### Open questions

None blocking. Wall times (6.3) and P3/P4 (Chrome 118 behavior) are measured
by slices 0 and 3 and reported at checkpoint A.
