# Service worker architecture: one core, two transports

Status: revision 13. Revision 1 (`5486e34`) was audited as
"approve with changes" (`.eng/reviews/20261117-0522-plan-audit-service-worker-architecture-d.md`).
Revision 2 (`f8187c7`) was audited by arch on 2026-11-17, again "approve with
changes": slices 0-4 may start; problem N4 is fixed before slice 5b, N2 and N3
before slice 5, N1 before slice 6, and arch verifies those fixes at the slice
reviews unless they change the layering or the slice plan. Revision 3 changes
both (ports become the bottom layer, as arch suggested; slice 5b becomes two
PRs; the purity check lives until slice 17), so it goes back to arch before
slice 5.
Source of the requirement: `.eng/answers/20261116-2108-claude-9a69c2cf.ask-1.md`
(verdict "accept with conditions", guarantees a-f).
Measured on branch `docs/service-worker-design` at `5ce3055` (1.3.2); slice 0's
CI jobs are read at `9bc84a7` (1.3.3, `main`).

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

### Revision 13 (2026-11-18)

Arch's answer on the composition-root budget after slice 21 (5.4, 3.1 "As
built in slice 21b" and "As built in slice 21c", the 3.1 ports and tables,
section 4, slice table rows 21b-21d, entry comment of
`packages/extension/contract/`), and the shapes slices 21b and 21c built:

| # | Decision | Why |
|---|---|---|
| 1 | The 5.4 estimate of about 200 lines never counted the settings caches: the idle-TTL and flow-recording caches, their two `storage.onChanged` listeners and their `settings.update` apply functions (about 120 lines at 1.4.30) were in no line of it. Three extra slices follow slice 21, each one PR with the usual guarantees, then slice 22 as written: 21b settings, 21c events out, 21d connect. The ceiling stays 400 | after slice 21 `background.ts` held 725 lines, over the ceiling, and slice 22 only deletes |
| 2 | 21b: the `chrome-settings` adapter and `SettingsCache` in `app/`; the two `storage.onChanged` registrations stay top-level statements of `background.ts` (R1), proven by the in-worker contract (revision 12, decision 1) and by the in-memory fake | the wake-listener rule maps `storage.onChanged` to the adapter's method like the other wake events |
| 3 | Each of 21b-21d lowers `BACKGROUND_LINE_BUDGET` to its measured count; imports count, and are never folded or reformatted to reach a number | the budget measures the file as written |
| 4 | The in-worker contract harness (`contract/entry.ts`) calls `chrome.windows.remove`, `chrome.tabs.create` and `chrome.tabs.remove`, `chrome.debugger.attach` and `chrome.storage.local.remove` to produce the events the wake-listener adapters observe and to clean up; these test-only calls are within the mechanism of revision 12. Every window, tab and storage key a case creates is removed in a `finally`, on failure too: `openTab` answers the tab with its `close`, and the e2e first runs every creating case failing on purpose right after it created what it must remove (`browserLinkContract({ probe: true })`), then checks through the browser that the tabs, windows and contract keys are the ones it held before, and checks the same after the real run | a failing contract case must not leave a tab or window that changes later e2e cases |
| 5 | As built in slice 21b: the adapter is `LocalSettingsStorage` (`get(key)`, `set(items)`, `onChanged(listener)`, whose listener gets the changes and the area), declared in `app/settings-cache.ts`; `SettingsCache` there extends core `IdleSettings` (`idleTtlMinutes()`) with `flowRecordingEnabled()`, holds both caches and is not an adapter. The 3.1 table rows read so | the caches hold state and decide (the `local` area, the keys, the newer `updatedAt`), which an adapter may not (5.3 item 3) |
| 6 | Slice 21c reverses revision 12 decision 5 ("`EventsOut` stays a function of `background.ts` (`publishFlowFinished`), not a port") and the slice 19 and section 4 sentences that `EventsOut` is not a port yet: `EventsOut` (`emit(tabId, event: BridgeEventPayload): boolean`, false when the event did not go out) is a core port in `ports/events-out.ts`, `BridgeEventPayload` (`Pick<BridgeEventMessage, 'eventKind' | 'data'>` of `@browser-link/shared`) lives in `ports/values.ts`, and `createFlowHistory` takes `events: EventsOut` instead of the `publish` callback; core builds the `flow-finished` event (`flowFinishedEvent`). It comes with its contract (`ports/contract/events-out.contract.ts`, on the in-memory fake in core and on the adapter in the worker) and R6 coverage, per checkpoint B condition 5 ("if EventsOut becomes a port there, it comes with its contract and R6 coverage like the others") | arch: it is the last piece that keeps transport behaviour in the composition root, and checkpoint B condition 5 already set its terms |

### Revision 12 (2026-11-18)

Arch's decisions on slice 19 (3.1 tables and "As built in slice 19", 4
`TabConnection` and `PendingReplies<T>`, 8 R6, slice table row 19):

| # | Decision | Why |
|---|---|---|
| 1 | R6 takes its primary path for the adapter methods no e2e call reaches: a test-only contract entry (`packages/extension/contract/entry.ts`, outside `src/`), bundled as an IIFE by `contract/build.mjs` with the options of `build.mjs` (`BUNDLE_OPTIONS`), is evaluated in the real worker through `Runtime.evaluate` and runs the `Alarms` contract on `adapters/chrome-alarms.ts`: an alarm set with a name `tabIdFromReconnectKey` rejects fires through `onFire`, and a cleared one never fires. The bundle holds the adapters and the contracts only, never `background.ts`, so its `onFire` is a second listener in a test script | `Alarms.onFire` is called at module load, before coverage starts, and V8 reports a function that ran only then as absent; `Alarms.set` runs only after an involuntary close, which no e2e case causes |
| 2 | The coverage check maps the contract script's own adapter regions and counts a shipped function reached when it or its counterpart in the contract bundle was called; the e2e first checks that every adapter source the contract bundle compiled is the one `background.js.map` embeds. This proves the same source compiled the same way ran, not the shipped bytes. The contract run never ships (`scripts/smoke-tarball.mjs` `contractFailures`), runs in the required `e2e` job on Chrome 118 under its own 120 s budget, and its contract also runs against the in-memory fake | conditions (a)-(f) of arch's answer |
| 3 | Options 1 (restarting the worker under coverage) and 4 (`onAlarm` left in `background.ts`) are rejected; if the in-worker run is not stable, option 2 (wake-listener exemptions) is proposed in a PR, never taken silently | arch |
| 4 | `PendingReplies<T>` has no `rejectAll`, and nothing settles a waiter on disconnect: a waiter ends at its reply or its timeout, as before | settling on disconnect would be a behavior change (7(e)) |
| 5 | `Alarms` is `set(name, when)`, `clear(name)`, `onFire(listener: (name) => void)`; `SocketFactory` is `(url) => BridgeSocket`, where `BridgeSocket` (`app/tab-connection.ts`) holds the members of the WebSocket API the extension uses. `EventsOut` stays a function of `background.ts` (`publishFlowFinished`), not a port | ports describe what is used; nothing in core emits events yet |

### Revision 11 (2026-11-18)

Arch's decisions on slice 18 (3.3 "As built in slice 18a" and "As built in
slice 18b", 3.4, 2.5, slice
table rows 18a and 18b):

| # | Decision | Why |
|---|---|---|
| 1 | `CDP_TOOL_SUPPORT` is pinned by Map equality with the 23 entries of 1.4.23 plus the relative order of the rows the registry derives; this supersedes "in today's order" in 3.3. A comment on `CDP_TOOL_SUPPORT` says its order is not a contract | production only calls `.get` (`isCdpToolSupported`, read by the dispatcher gate in `tools/browser-dispatch.ts`) and nothing iterates the map, so its order is not behavior |
| 2 | `cdp/support.ts` declares the rows no registry entry derives, each with its reason: `wait_for_tab` (dispatcher-only, in no registry) and, until slice 18b, `flow`, `flow_status` and `flow_cancel` (transport-owned); the snapshot test names them | `browser-dispatch.ts` answers `wait_for_tab` itself; the flow tools join the registry only in 18b |
| 3 | Slice 18 splits into two PRs: 18a derives `CDP_TOOL_SUPPORT` with its snapshot test; 18b adds `FlowControl` and `FlowCancel`, removes the five transitional tool cases and the three declared flow rows, adds `flows` and `flow-cancel` to `CDP_DIRECT_PROVIDES`, and lands the no-tool-`case` fitness rule | the flow tools need an interface both transports implement, and cdp-direct keeps its own detached-flow model (Q4); deriving the table does not wait for it |
| 4 | `FlowControl` (`detachedOnTab()`, `steps({ hidePasswordValues, stopWaiting? })`, `start(launch)`, `status(flowId)`) lives in core `flow/flow-control.ts`, outside `ports/`, as the `flows` entry of `RequirementDeps`. It is a per-transport service (each transport's own flow model, Q4), in the family of `DialogWatch` and `CaptureWatch`, not a port. `steps` returns each transport's step bindings, so cdp-direct's flow drag step keeps its refusal. Each optional member names in its doc which transport uses it (`stopWaiting` absent only for a dry run; the launch's `onProgress` given by the extension and by cdp-direct's detached launch) | the flow tools need one body over two flow models, and cdp-direct's page driver has a `drag` port that `ToolDeps` alone would let a flow use |
| 5 | `FlowControl` has no `cancel`. `flow_cancel` requires `flows` (for the status read that answers it) and `flow-cancel`, a one-member `FlowCancel { cancel(flowId) }` that only cdp-direct provides. The extension lacks `flow-cancel`; the request never reaches it. Its answer to a `flow_cancel` request sent straight to it changes from `Unknown tool: flow_cancel` to `Unsupported tool: flow_cancel needs flow-cancel`, which no wire path reaches: the server routes a `flow_cancel` request only to a `cdp:` tab and cancels an extension flow with the `tool.cancel` frame (`tools/browser-dispatch.test.ts`, the `flow_cancel` cases) | the extension's cancel is the `tool.cancel` frame and the popup, which go straight to the `FlowRegistry` |
| 6 | 3.4's `unsupported` row and the requirements text of 3.3 read "the extension lacks `flow-cancel`; the request never reaches it" instead of "the extension provides every requirement" | decision 5 |

### Revision 10 (2026-11-17)

Decisions while building slice 16 (3.1 and 3.2 code blocks and text, 3.3
"As built in slice 16"):

| # | Decision | Why |
|---|---|---|
| 1 | `DialogInput` (`respond(accept, promptText?)`) is an input-only capability of the `PageDriver` (`dialog`), the registry requirement `dialog-input`; both page drivers have it, `CDP_DIRECT_PROVIDES` lacks it (v1 scope). The pending dialog stays `TabSession` state behind `DialogWatch` | `dialog_respond` sends `Page.handleJavaScriptDialog`, which no existing port sends; it is the page's reply to the core's own command (revision 9, decision 3). `dialogs` is already the `DialogWatch` key of the handler deps |
| 2 | `Downloads` is built per tab: `captureAround(wait: { timeoutMs, holdMs }, act)`, `settle(downloadId, saved)`; the adapter binds the tab's download reports, so `TabDownloadSignals` stays an extension type. A failed `act` answers its error and a throwing `act` rejects, each leaving the capture disarmed (contract) | core has no subscription to a tab's CDP events beyond the one-shot `CdpEvents.waitFor`; passing the signals in would need one. The 3.1 sketch also lacked the wait's timeout. It fits the revision 8/9 rule even though `captureAround` returns what the transport observed (timeout, unattributed, captured): that observation is the answer to a command the core issues (arm, act, wait), not ambient state read on the side |
| 3 | `downloads` and `content-settings` are optional in `ToolDeps` (`AdapterRequirement`) and read through `providedPort` | cdp-direct has no adapter for either (3.1 table), as it gives no capture watch |
| 4 | The `ContentSettings` adapter passes `chrome.contentSettings` to `app/content-settings.ts`, which looks the setting up and fails with today's texts; the `Downloads` adapter's event filter is `app/download-signals.ts` | adapters stay free of logic (5.3 item 3) and both texts reach the wire |
| 5 | The `ContentSettings` and `Downloads` adapters are built per tool call (`background.ts` `actionDeps`). Invariant: adapters built per call hold no state; state lives in what they receive (the worker-wide download capture, the tab's page driver). A stateful adapter is built once and handed in, never built per call by imitation | the e2e coverage starts after the worker's module code ran, so a factory called only at module load hides an uncalled function from the R6 check; building per call is safe only for a stateless adapter |
| 6 | The settle answer's type is `DownloadSettleOutcome`, and the port values speak of "the browser", not a vendor; the published `download_settle` result field `chrome_download` and its values (`left_in_chrome` included) are unchanged | ports are typed in core's own vocabulary (section 3); the wire is behavior |

### Revision 9 (2026-11-17)

Arch's decisions on slices 14 and 15 (3.2 code block and text, 3.3 "As
built in slice 14" and "As built in slice 15"), and the wording of the
revision 8 rule:

| # | Decision | Why |
|---|---|---|
| 1 | `DragInput` (`interceptDrags(enabled)`, `dragEvent(event)`) is a separate input-only capability of the `PageDriver`, the registry requirement `drag`; cdp-direct's page driver has it, but `CDP_DIRECT_PROVIDES` lacks `drag`, so `browser.drag` stays refused there | drag sends `Input.setInterceptDrags` and `Input.dispatchDragEvent`, which no existing port sends; folding them into `Pointer` would change the meaning of a mouse-only port (revision 8) |
| 2 | `CdpEvents.waitFor(method, timeoutMs)` has no `predicate` until a real caller needs one | its only caller (drag's wait for `Input.dragIntercepted`) accepts every event; same rule as `Clock.every` (revision 7): ports describe what is used |
| 3 | The revision 8 rule reads: a port must not report state the transport observes on its own; a command whose answer is the page's reply to the core's own request is allowed (`Evaluator`, `PageInfo.info()`) | so the rule cannot be misread as forbidding every port method that returns data |
| 4 | `Navigator` (`navigate(url)`) is a separate input-only capability of the `PageDriver`, the requirement `navigator`; both transports provide it (slice 15) | `navigate` sends `Page.navigate`, which no existing port sends; `PageInfo` stays what the transport knows about the page |
| 5 | `ScreenCapture` (`layoutMetrics()`, `capture(params)`) is a capability of the `PageDriver`, the requirement `screen-capture`; both transports provide it. `LayoutMetrics` and `CaptureParams` live in `ports/values.ts` with only the fields core uses | its answers are the page's replies to the core's own commands (decision 3); no raw CDP type in a port |
| 6 | `ResponseBodies` (`body(requestId)`, answering `ResponseBody` from `ports/values.ts`) is a capability of the `PageDriver`, the requirement `response-bodies`, provided by the extension only; cdp-direct refuses `network_body` with its unchanged text | same terms as decision 5; cdp-direct never enables the Network domain (v1 scope) |
| 7 | cdp-direct sends no raw `Runtime.evaluate` (`cdp/raw-evaluate.fitness.test.ts` allows none). The per-call command timeout is declared on the registry entry (`commandTimeout: 'call-budget'` on `evaluate`) and read by the transport; no transport compares a tool name (`cdp/tool-name.fitness.test.ts`, extension `fitness.test.ts`) | a transport that knew tool names would grow one branch per tool that needs it |

### Revision 8 (2026-11-17)

Arch's decisions on slice 10 (3.2 code block and text, 3.4 "As built"
paragraph):

| # | Decision | Why |
|---|---|---|
| 1 | `DialogWatch` (`isOpen()`) lives in core `session/page-driver.ts`, outside `ports/`: optional and read-only, given by the extension only (its tab's pending dialog), transitional until slice 12 hands it `TabSession` state | the extension tracks JavaScript dialogs and cdp-direct does not; the click path needs to read that state, not own it |
| 2 | `Pointer` is input only: `mouse(event: MouseEventParams): Promise<void>`, a failed dispatch rejects. The race of each mouse event against `dialogs?.isOpen()` (polled on `Clock`) and the time-bounded watched move are core page-driver operations (`dispatchMouseEvents`, `dispatchWatchedMove`, `dialogOpen`), not port members. cdp-direct passes no `DialogWatch`, so its behavior stays as it was | a `Pointer` reporting `{ dialog }` and `dialogOpen()` put dialog observation into an input port and duplicated `DialogWatch` |
| 3 | The outcome-mapping contract lives in `core/src/tools/outcome-mapping.contract.ts`, not `ports/contract/`; the find and click results and error texts live in `core/src/support/action-results.ts` (the flow engine re-exports them) | the contract speaks `ToolOutcome` and `ports` imports nothing in core; `actions` may not import `flow` (5.2) |
| 4 | Unifying the two click paths (cdp-direct tracking dialogs) stays out of this program | it is a behavior change (7(e)) |

Also required before slice 10 merges: the differential must not need a
rerun. Its one flaky field (`pending_wrap_up` at the first `flow_status`)
came from a polled `browser.evaluate` wait in the harness, each call counted
as pending work; the wait is now one in-page evaluate (`run.mjs`).

### Revision 7 (2026-11-17)

Arch's decisions while building slice 9, where the ports of 3.1 and 3.2 did
not match the code at 1.4.11 (3.1 and 3.2 code blocks, the 3.1 adapter table
and 5.3 items 3 and 5 updated):

| # | Decision | Why |
|---|---|---|
| 1 | `PageInfo.waitForLoad(timeoutMs): Promise<void>` becomes `armLoadWait(timeoutMs): LoadWait` (`{ done: Promise<void>; cancel(): void }`); the contract gains "a cancelled load wait never settles" | both transports arm the wait before `Page.navigate` and cancel it when the navigation fails (the 1.3.4 fix); the old shape could not express it without a behavior change |
| 2 | `Settler.mark(settle)` returns `ObserverMarkResult` (`none`, `unavailable` with its reason, or `marked` with the `ObserverMark`); `settle(settle, mark)` returns a `SettleReport` or `undefined`; `ObserverMarkResult`, `ObserverFailure`, `SettleReport`, `KeyEvent` and `LoadWait` live in `ports/values.ts` | the settler follows today's behavior, typed: ports own their value types and no port speaks `Record<string, unknown>`; the wire output is unchanged (the differential proves it) |
| 3 | `Clock.every` is removed from the port, both `system-clock.ts` adapters, the fake and the tests | nothing calls it; ports describe what is used, so R6 condition 1 needs no exemption |
| 4 | `PageDriver` holds `evaluator`, `keyboard` (`key` only), `settler` and `page`; `Pointer`, `Keyboard.insertText` and `CdpEvents` join with the slices that move their first callers (10, 11, 14) | the rule of 3: no capability without a caller |

Also decided for slice 9: cdp-direct keeps one raw `Runtime.evaluate` (the
`evaluate` case of `callCdpTool`, whose `timeout_ms` is the client's own
per-command timeout) until slice 15, listed as the only exception by
`cdp/raw-evaluate.fitness.test.ts`; the load-wait logic (status check,
timer) lives in core `session/load-wait.ts` on `Clock`; the extension
`CdpSession` takes the tab-filtered subscribe function `background.ts` owns,
so slice 9 adds no `app/` folder; R6 takes the fallback path (section 8):
V8 coverage of the worker during the e2e (`packages/e2e/src/adapter-coverage.mjs`),
the contract suite on in-memory fakes, and the contract suite against the
cdp-direct adapters on a real Chrome target in the `e2e` CI job
(`cdp/adapters/contract.chrome.test.ts`).

### Revision 6 (2026-11-17)

Found while building slice 5b-1 (5.1 `expect.ts` row updated):

| # | Decision | Why |
|---|---|---|
| 1 | `beginExpect` also takes a required `clock: Clock`, passed `systemClock` at the same three `perform*` call sites on each side | it calls `withProbeTimeout` too, which now runs on `clock.after` |

### Revision 5 (2026-11-17)

Decisions taken while building slice 5, where the plan was wrong against the
code at 1.4.1 or left the scope open (slice 5 row and 5.4 updated):

| # | Decision | Why |
|---|---|---|
| 1 | `BACKGROUND_LINE_BUDGET` starts at **5039** | `background.ts` grew from 4922 lines (`5ce3055`) to 5039 with the 1.3.6 fix; the budget starts at the current count (5.4) |
| 2 | The "no tool `case` in `background.ts`" rule lands with slice 18 | `handleTool` keeps its `case` labels until slice 18 (3.3), so the rule cannot be green earlier |
| 3 | The slice 5 mirror holds `core/src` production files only (the ports and the contract suite); `sync-core.mjs` `MIRRORED_ROOTS` adds `shared` in slice 5c | 2.3 lists both packages, but 5c is the slice that populates `generated/shared/` |
| 4 | Slice 5 ports: `clock`, `values`, `cdp-session`, `page-info`, `settings`, `content-settings` and `index` | the store, downloads and events-out ports speak types that still live in the extension (`flow-registry.ts`, `download-capture.ts`); they land when those types move |
| 5 | Slice 5 contracts: `CdpSession` and `PageInfo`, each with its in-memory fake | the outcome-mapping contract needs `ToolOutcome` (slice 10), the store contracts need the store ports (slice 17) |
| 6 | The runtime-import proof is `packages/extension/src/core-link.check.ts`, which `tsc --noEmit` checks and no bundle entry reaches; `fitness-core-link.test.ts` bundles it with esbuild in memory | ports are types only, so `background.ts` has no core value to import before slice 9; it stays untouched |

### Revision 4 (2026-11-17)

Correction found by the real-Chrome e2e of slice 3b (released as 1.3.9), in
3.4 and every place that repeated it (slice 3b, 10 and 11 rows):

1. A `browser.wait_for` that expires is not a `ToolFailure`. The tool returns
   an ordinary result `{ matched: false, reason: "timeout" }` with no
   `isError`; the case `error.timeout` in `packages/e2e/src/run.mjs` asserts it.
2. `sensitive_field` is not visible in the MCP result. The extension sends it
   on the wire; the server turns it into `SensitiveFieldError`; the agent sees
   only the ordinary error text; the marker `[sensitive field]` exists only in
   the activity trail row.

### Revision 3 (2026-11-17)

The second audit (arch, 2026-11-17, on revision 2) found eight new problems.
Each, and where this revision fixes it:

| ID | Problem | Now fixed in |
|---|---|---|
| N1 | The mirror cannot resolve `@browser-link/shared` on the server | 2.3 "Specifiers" (sync-core rewrites it to a relative path); 5.2 module table |
| N2 | The layer table forbids `expect.ts` (support) taking a `Clock` (ports) | 5.2: `ports` is the bottom layer; 3.1 `ports/values.ts`; 5.3 item 2 fixture; slices 5 and 7 |
| N3 | Two fitness rules are RED or vacuous | 5.3 item 3 (worker zone vs UI zone; wake-listener rule); 3.1; R1 |
| N4 | Slice 5b also changes the server copies of `flow.ts` and `expect.ts` | 5.1; slice 5b, now two PRs (5b-1 Clock, 5b-2 the rest), re-estimated; 2.5 |
| N5 | Purity unguarded between slice 8 and the slices that move the last modules | 5.1 "Proof"; 5b-2 creates `utf8.ts`, `flow-limits.ts`, `idle-rules.ts` in core; slices 8 and 17; R8 |
| N6 | R6 condition 1 not stated as cumulative; unreachable adapter methods | section 8, R6 |
| N7 | Slice 0's job layout and issue permission | slice 0 (done, 1.3.3); 6.3; 7(a) |
| N8 | The "complexity 1" rule leaves open what counts | 5.3 item 3 |

Slice 0 is merged (release 1.3.3); 7(a) describes what it built.

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
  `tabsToDisconnectForIdle`) are tested; the wiring is not. (Slice 12,
  1.4.18, moved the call hold, the activity clock, the console, network and
  dialog state and the sweep's per-tab decision into core
  `session/tab-session.ts` `TabSession`, unit-tested on a fake `Clock`; the
  WebSocket listener now calls `TabSession.runCall`.)
- **Two hand-written bodies per action.** `cdp/transport.ts` (1598 lines)
  mirrors `performFind/Click/Type/Press/WaitFor`, nine helpers with the
  same name (`evaluateInTab`, `runSettle`, `settleWithChanges`,
  `takeObserverMark`, `installObserver`, `handleObserverMessage`,
  `evaluateObserverJs`, `dispatchKeyEvent`, `waitForLoad`) and a 14-case
  dispatch (`transport.ts` `callCdpTool`). Only the five `perform*` bodies are
  guarded, by an AST comparison (`cdp/transport-parity.test.ts` `HANDLERS`).
  (Slice 10, 1.4.16, moved `performFind` and `performClick` into core
  `actions/`, run by both transports through the tool registry; slice 11,
  1.4.17, moved `performType` and `performPress` the same way, and the
  sensitive-field mapping is the `sensitive` kind of 3.4; slice 13, 1.4.19,
  moved `performWaitFor`, so `HANDLERS` is empty and the file keeps only its
  comparison machinery and a guard that no `perform*` is declared on a
  transport again, until slice 22 deletes it; slice 14, 1.4.20, moved the
  extension-only `performDrag` into core `actions/`, so that guard allows
  none; slice 15, 1.4.21, moved the `ping`, `navigate`, `snapshot`,
  `state`, `screenshot` and `evaluate` cases of both transports and the
  extension's `canvas_screenshot`, `console`, `network` and `network_body`
  into core `tools/page-read.ts`.)
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
  a workspace package in Chrome. (Measured at `5ce3055`. Slice 6, 1.4.9,
  replaced `cdp/inpage/*` with the mirror and deleted `cdp/builders-parity.test.ts`
  and the in-page sections of `cdp/drift.test.ts`. Slice 7, 1.4.10, did the
  same for `cdp/{settle,expect,keymap,screenshot,observer-host}.ts`, which
  now compile from `generated/core/support/`, and their `drift.test.ts`
  sections. Slice 8, 1.4.11, did the same for `cdp/flow.ts`, which now
  compiles from `generated/core/flow/`, and deleted both sibling `clock.ts`
  files.)
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

Slice 0 (merged, 1.3.3) closed the partial
`testing:real-chrome-gaps-for-1-1-rules`: before it, Chrome 118 existed only as
README prose, and CI ran only the runner's own Chrome (`ci.yml` job `e2e`,
`CHROME_PATH: /usr/bin/google-chrome`) and recorded no version.

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
- **Specifiers (decided, N1).** Core files import `@browser-link/shared`
  (5.2), and the server can resolve neither form today:
  `packages/server/package.json` has no `@browser-link/shared` dependency and
  `packages/server/tsconfig.json` has no `paths`. `sync-core.mjs` therefore
  rewrites, in the copied text of every mirrored core file, each
  `@browser-link/shared` specifier (static `import`, `import type` and
  `export ... from`; dynamic `import(` is already forbidden in core) to the
  relative path of the mirrored `generated/shared/index.js` from that file,
  for example `../shared/index.js` from `generated/core/x.ts` and
  `../../shared/index.js` from `generated/core/tools/x.ts`. The header says
  so (`// GENERATED from ... Specifiers rewritten.`); `--check` compares the
  rewritten text, and fails if any file under `src/generated/` still contains
  the bare specifier. Its unit test adds two RED probes: an un-rewritten
  specifier, and a wrong relative depth. Why not the alternatives:
  - *Server gains `"@browser-link/shared": "workspace:*"`.* `tsc` keeps a bare
    specifier as written in the emitted `.js`, so the published `dist/` would
    import a package that is `"private": true`, never on npm, and whose
    `main` is `./src/index.ts`: the installed CLI would fail at load. The
    npm package stops being self-contained.
  - *A `paths` entry.* `paths` changes only how `tsc` resolves types, not the
    emitted specifier (same failure at runtime), and pointing it at
    `packages/shared/src` puts a file outside the server's `rootDir: "src"`,
    which `tsc` rejects.
  Rewriting keeps `dist/` self-contained, the server's `package.json`
  unchanged, and `tsx` and vitest resolving the mirror like any other
  relative import.
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
  ports/            clock.ts values.ts cdp-session.ts page-driver.ts page-info.ts
                    settings.ts flow-history-store.ts detached-flow-store.ts
                    events-out.ts downloads.ts content-settings.ts index.ts
                    (bottom layer, 5.2)
  session/          tab-session.ts tab-registry.ts pending-replies.ts
                    page-driver.ts (CDP implementation of the PageDriver port)
  flow/             flow-engine.ts (today flow.ts) flow-run.ts
                    flow-registry.ts flow-history.ts detached-flows.ts
                    flow-control.ts (FlowControl, FlowCancel; slice 18b)
  actions/          perform-find.ts perform-click.ts perform-type.ts
                    perform-press.ts perform-wait-for.ts perform-drag.ts
                    click-landing.ts (the frame watch already lives in
                    session/page-driver.ts, since slice 9)
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
                    web-socket.ts system-clock.ts (from slice 5b-1)
                    chrome-tab-title.ts (slice 18b)
  app/              tab-connection.ts connection.ts recording.ts repair.ts
                    popup-router.ts windows.ts activity-admin.ts tab-events.ts
                    flow-control.ts (slice 18b)
  (UI zone, 5.3)    popup.ts activity.ts admin.ts ui-language.ts
  (stays)           admin-view.ts i18n.ts notice-policy.ts reconnect-policy.ts
                    repair-policy.ts connect-failure-policy.ts
                    flow-recording-policy.ts handshake-diagnosis.ts
                    version-status.ts worker-messages.ts recording.ts
                    download-capture.ts inpage/recorder.ts
                    idle-settings.ts flow-labels.ts (both from slice 5b-2)
                    clock.ts (slices 5b-1 to 8 only, see 5.1)

packages/extension/contract/   entry.ts build.mjs and the adapters' contracts:
                    the test-only in-worker contract run (R6, slice 19)

packages/server/src/cdp/
  transport.ts      cdp-direct adapter: connections, gate, outcome -> wire
  adapters/         cdp-client-session.ts cdp-page-info.ts
                    config-settings.ts bridge-events-out.ts
  flow-control.ts   cdp-direct FlowControl and FlowCancel (slice 18b)
                    system-clock.ts (from slice 5b-1)
  clock.ts          slices 5b-1 to 8 only, byte-identical sibling (5.1)
  (unchanged)       client.ts targets.ts gate.ts grant.ts
                    detached-flows.ts (section 8, Q4)
  support.ts        CDP_DIRECT_PROVIDES and CDP_TOOL_SUPPORT derived from the registry (3.3)
packages/server/src/messages.ts   re-export of generated/shared (slice 5c)
packages/server/src/generated/{core,shared}/   mirror, never edited by hand
```

Policies that only the extension uses stay where they are and stay pure
functions: `reconnect-policy.ts`, `notice-policy.ts`, `repair-policy.ts`,
`connect-failure-policy.ts`, `flow-recording-policy.ts`,
`handshake-diagnosis.ts`, `version-status.ts`. The idle rules move to core
because `TabSession` uses them; the idle settings (storage keys, console
command text) stay in the extension (slice 5b-2). `download-capture.ts` stays in
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
// clock.ts: all time in core goes through this (declared in slice 5; flow
// and expect adopt it in slice 5b-1, 5.1).
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Run `fn` once after `ms`; returns cancel. Replaces setTimeout/clearTimeout. */
  after(ms: number, fn: () => void): () => void;
}   // no `every`: nothing calls it (revision 7)

// values.ts: the value types the ports speak, declared here so `ports`
// imports nothing in core (5.2). Moved verbatim in slice 7 from
// settle.ts (`SettleParams`, `EvaluateFn`) and observer-host.ts
// (`ObserverMark`); slice 5 declares them, slice 7 deletes the originals
// and re-points `support/` at these.
export interface SettleParams { settleMs: number; settleTimeoutMs: number; /* ... */ }
export type EvaluateFn = (expression: string) => Promise<unknown>;
export interface ObserverMark { /* as observer-host.ts today */ }
// Slice 9 (revision 7) adds the values the page driver and PageInfo speak:
export type ObserverFailure = 'observer-unavailable' | 'doc-changed' | 'changes-error';
export type ObserverMarkResult =
  | { kind: 'none' }                                     // settle off for the call
  | { kind: 'unavailable'; reason: ObserverFailure }
  | { kind: 'marked'; mark: ObserverMark };
export type SettleReport = { settled?: boolean; mutation_count?: number; /* ... */
  changes?: SettleChanges | null; observer?: ObserverFailure };
export type KeyEvent = { type: 'keyDown' | 'rawKeyDown' | 'char' | 'keyUp'; /* ... */ };
export interface LoadWait { done: Promise<void>; cancel(): void }
// Slice 15 (revision 9) adds the values of the screen capture and the
// response bodies, with only the fields core uses:
export interface LayoutMetrics { cssContentSize?: { width: number; height: number }; /* ... */ }
export type CaptureParams = { format: 'png' | 'jpeg'; captureBeyondViewport: boolean;
  clip: { x: number; y: number; width: number; height: number; scale: number }; quality?: number };
export type ResponseBody = { body: string; base64Encoded: boolean };
// Slice 16 (revision 10) adds the values of the download capture:
export interface CapturedDownload { download_id: number; url: string; /* ... */ }
export type CaptureOutcome = { state: 'captured'; download: CapturedDownload }
  | { state: 'unattributed' } | { state: 'timeout' };
export type DownloadSettleOutcome = 'removed' | 'cancelled' | 'left_in_chrome' | 'not_held';
export type CaptureActOutcome = { ok: true } | { ok: false; error: string };
export type CaptureAroundResult = { ok: true; outcome: CaptureOutcome } | { ok: false; error: string };

// cdp-session.ts: one debugger session on one page.
export interface CdpSession {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  /** Every CDP event of this session. Returns the unsubscribe function. */
  onEvent(listener: (method: string, params: unknown) => void): () => void;
}

// page-info.ts: what the transport knows about the page outside CDP.
export interface PageInfo {
  info(): Promise<{ url: string; title: string }>;
  /** Armed before Page.navigate; `done` resolves on load complete, rejects on
   * timeout; after `cancel` it never settles (revision 7). */
  armLoadWait(timeoutMs: number): LoadWait;
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
// As built in slice 21c (revision 13): BridgeEventPayload is
// Pick<BridgeEventMessage, 'eventKind' | 'data'> of @browser-link/shared.

// downloads.ts: returns data; the stateful capture stays behind the adapter.
// As built in slice 16 (revision 10): one per tab, the tab bound by the adapter.
export interface Downloads {
  /** Arm a capture for the tab, run `act`, report what Chrome downloaded. */
  captureAround(wait: { timeoutMs: number; holdMs: number },
    act: () => Promise<CaptureActOutcome>): Promise<CaptureAroundResult>;
  settle(downloadId: number, saved: boolean): Promise<DownloadSettleOutcome>;
}

// content-settings.ts (slice 5; its contract and adapter land in slice 16)
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

As built in slice 17: the keys and parsing live in core `flow/flow-history.ts`
(`flowHistoryKey`, `parseFlowHistory`) and `flow/detached-flows.ts`
(`detachedFlowKey`, `parseDetachedFlowRecord`, `detachedFlowRecordsIn`);
`FlowHistoryEntry` and `DetachedFlowRecord` live in `ports/values.ts`. The
extension adapters (`adapters/chrome-flow-history-store.ts`,
`adapters/chrome-detached-flow-store.ts`) are stateless objects over
`chrome.storage.session` that call those functions, built once for the
worker. `DetachedFlowStore` has no single-record
read: `FlowHistory.record(flowId)` finds the record in `list()`. A test
reads a history and a record written in the 1.4.22 format and checks the
values written now (`chrome-adapters.test.ts`).

`Downloads` returns `CaptureOutcome` and `DownloadSettleOutcome`, which with
`CapturedDownload`, `CaptureActOutcome` and `CaptureAroundResult` live in
`ports/values.ts` (slice 16; `download-capture.ts` re-exports the first three).
The extension adapter (`adapters/chrome-downloads.ts`) wraps the worker-wide
`createDownloadCapture(chrome.downloads)` and its `captureAround`, with the
tab's `Page.downloadWillBegin` reports on `chrome.debugger.onEvent` filtered
by `app/download-signals.ts`. Core never holds the `DownloadCapture` object.
The `ContentSettings` adapter (`adapters/chrome-content-settings.ts`) passes
`chrome.contentSettings` to `app/content-settings.ts`, which looks the
setting up by key and fails with a text naming a missing one. Both adapters
are built per tool call (`background.ts` `actionDeps`): the e2e coverage
starts after the worker's module code ran, so a factory called only at module
load would hide an uncalled function from the R6 check.

Extension-only capabilities get adapters too, so "in the worker zone,
`chrome` only in `adapters/**` and `background.ts`" (5.3 item 3) stays true as
code leaves `background.ts`. They are not core ports: their interfaces live
next to the `app/` module that uses them. The UI pages (popup, Activity,
Admin) are a separate zone and keep calling `chrome` directly (5.3 item 3
says why).

| Extension interface (in `app/`) | Adapter | Wraps today's |
|---|---|---|
| `Windows` (`open`, `focus`, `exists`, `onClosed`) | `chrome-windows.ts` | Activity/Admin `chrome.windows.create/get/update/onRemoved` |
| `Alarms` (`set`, `clear`, `onFire`) | `chrome-alarms.ts` | reconnect safety net `chrome.alarms.create/clear/onAlarm` |
| `Runtime` (`manifestVersion`, `pageUrl`, `onMessage`) | `chrome-runtime.ts` | `chrome.runtime.getManifest/getURL/onMessage` |
| `TabEvents` (`get`, `onUpdated`, `onRemoved`, `onCreated`, `onDebuggerDetach`) | `chrome-tab-events.ts` | `chrome.tabs.*`, `chrome.debugger.onDetach` |
| `SocketFactory` | `web-socket.ts` | `new WebSocket(...)` in the connection code |
| `LocalSettingsStorage` (`get`, `set`, `onChanged`), under `SettingsCache` (core `IdleSettings` plus `flowRecordingEnabled`) | `chrome-settings.ts` | `storage.local` + `storage.onChanged` caches |

| Core port | Extension adapter | cdp-direct adapter |
|---|---|---|
| `Clock` | `adapters/system-clock.ts` over `Date.now`, `setTimeout` | `cdp/adapters/system-clock.ts`, same globals |
| `CdpSession` | `adapters/chrome-cdp-session.ts`: `chrome.debugger.sendCommand`; `onEvent` is the tab-filtered subscribe function of `background.ts` (since slice 9) | `cdp/adapters/cdp-client-session.ts` over `cdp/client.ts` `CdpClient` (`send`, `onAny`) |
| `PageInfo` | `adapters/chrome-page-info.ts`: `chrome.tabs.get`, `onUpdated` status complete through core `session/load-wait.ts` `armLoadWait` and `tabLoadSignal` | `cdp/adapters/cdp-page-info.ts`: `Target.getTargetInfo`, `Page.loadEventFired` through the same `armLoadWait` |
| `IdleSettings` | `app/settings-cache.ts` `SettingsCache`, over `chrome-settings.ts` | not used by cdp-direct (Q4) |
| `FlowHistoryStore`, `DetachedFlowStore` | `chrome.storage.session` | not used by cdp-direct (Q4) |
| `EventsOut` | `adapters/ws-events-out.ts`: the frame on the tab's socket through `app/events.ts` `emitBridgeEvent` (slice 21c) | the `BridgeEventLog` sink of `detached-flows.ts` |
| `Downloads` | `createDownloadCapture(chrome.downloads)` | none |
| `ContentSettings` | `chrome.contentSettings` | none |

Not ports, on purpose: dialog observation (CDP events on `CdpSession`; the
pending dialog is `TabSession` state, read through the `DialogWatch` outside
`ports/`) and the tab registry (a core class, section 4). Answering a dialog
is the page driver's input-only `DialogInput` (3.2, revision 10).

As built in slice 19 (revision 12): `Alarms` (`set(name, when)`,
`clear(name)`, `onFire(listener)`), `SocketFactory` (`(url) =>
BridgeSocket`) and `SessionStorage` live in `app/connection.ts`, with the
tab ids (`createTabIds`), the reconnect wiring (`createReconnect`: the
scheduler, the persisted state, the alarm listener, the resume after a worker
restart), the tab's socket and its server-message switch (`openBridge`), the
popup's disconnect and status, and the round trips over any open socket
(`anyOpenSocket`, `roundTrip` on core `PendingReplies`).
`adapters/chrome-alarms.ts` and `adapters/web-socket.ts` are stateless
objects built once; `background.ts` passes `chrome.storage.session` as the
`SessionStorage`, as it passes `chrome.downloads` to the download capture,
and subscribes `chromeAlarms.onFire` at top level (the wake-listener rule maps
`alarms.onAlarm` to `Alarms.onFire`). `EventsOut` became a port in slice 21c
(revision 13).

As built in slice 20: `createRecording` (`app/recording.ts`) holds the
recording operations (`start`, `stop`, `finish`, `discard`,
`forceStopAndDiscard`, `save`, `status`, `removeNavListener`,
`teardownRecorder`) over the worker's `TabRegistry`. It is stateful (each
recording tab's navigation subscription), so `background.ts` builds it once and
hands it the CDP send, the page evaluate, the clock, a getter for the
setting's cache and `chromeTabEvents`. Recording uses two members of
`TabEvents`, `get(tabId)` and `onUpdated(listener)`; the listener gets a
`TabUpdate` (`tabId`, `status`, `url`) and `onUpdated` returns the function
that stops the reports. `adapters/chrome-tab-events.ts` is a stateless object
built once, and the filter on the tab and on `complete` is the recording's.
The flow-recording setting's
cache and its `storage.onChanged` listener (a wake listener, R1) stay in
`background.ts`; the listener calls `recording.forceStopAndDiscard`. The e2e
reaches every adapter function with a recording on a tab of its own
(`recordingChecks`).

As built in slice 21: the popup's runtime messages, the Activity and Admin
windows, the repair and the tab-event listeners live in `app/`.
`app/popup-router.ts` holds `RuntimeMessage`, `isRuntimeMessage` and
`createPopupRouter`, which answers each message from its handler, at once
(the listener returns false) or later (it returns true), and declares
`Runtime` (`manifestVersion()`, `pageUrl(path)`, `onMessage(listener)`,
whose listener gets the message and a `reply` and returns whether it answers
later). `app/windows.ts` declares `Windows` (`open(url, size)` answering the
window id or `undefined`, `focus(windowId)`, `exists(windowId)`, which
rejects for a window the browser no longer has, `onClosed(listener)`) and
`createAppWindow`, the focus-if-open window that remembers its id; it is
stateful, so `background.ts` builds the Activity and the Admin window once
each and subscribes `Windows.onClosed` for each. `app/activity-admin.ts`
holds the trail and console round trips, `app/repair.ts` the version summary
(`currentVersionCheck`) and `repairConnection`, and `app/tab-events.ts`
declares `TabEvents` with all five members (`get` answers `url` and
`pendingUrl`; `onCreated` reports `{ tabId, openerTabId }`;
`onDebuggerDetach` reports the tab id or `undefined`) and
`createTabEventHandlers`: a closed tab, the auto-connect of a tab a connected
tab opened (on `Clock`), and a debugger the browser detached. The adapters
`chrome-windows.ts`, `chrome-runtime.ts` and `chrome-tab-events.ts` are
stateless objects built once; `Windows.onClosed`, `Runtime.onMessage`,
`TabEvents.onRemoved`, `onCreated` and `onDebuggerDetach` are wake
listeners, mapped in `WAKE_SUBSCRIPTIONS` and subscribed at the top level of
`background.ts`. The in-worker contract run holds a contract for each:
a window opened exists and takes focus and its close reaches `onClosed`; the
manifest version, a page URL, and a message the popup page sends on load
reaching `onMessage`; a tab opened reaching `onCreated`, and its close with
a debugger attached reaching `onDebuggerDetach` and `onRemoved` (a tab
`chrome.tabs.create` opens with an `openerTabId` is reported without it, so
the opener is proven by the e2e's `browser.wait_for_tab` case). Each
contract also runs against an in-memory fake (`contract/memory-*.ts`). The
e2e's window case opens the Activity and the Admin window through the
popup's messages, asks again for the same focused window, and gets a fresh
one after closing it (`windowChecks`).

As built in slice 21b (revision 13): `app/settings-cache.ts` holds
`createSettingsCache`: the idle-TTL and flow-recording caches, their load at
worker start, the change handlers `idleTtlChanged` and
`flowRecordingChanged` (the toggle going off discards the recording of every
connected tab), and `applyPushed`, which validates a `settings.update` push
and writes it. It is stateful, so `background.ts` builds it once, calls
`load()` once and subscribes `chromeSettings.onChanged` twice at top level,
one statement per cache, as before. `adapters/chrome-settings.ts` is a
stateless object; the wake-listener rule maps `storage.onChanged` to
`LocalSettingsStorage.onChanged`. The in-worker contract: a value set reads
back through `get`, and its change reaches `onChanged` as a `local` change
carrying the new value; the key is removed in a `finally`.

As built in slice 21c (revision 13, decision 6): core `ports/events-out.ts`
holds `EventsOut`, and `createFlowHistory` emits `flowFinishedEvent(record)`
through it, deferring the event onto the record when `emit` answers false.
`app/events.ts` holds `emitBridgeEvent` (the `bridge.event` frame on the
tab's open socket, with the server tab id once registered; false without an
open socket) and `reportTopDocument` (the page observer's `tab-doc-info` and
`tab-navigated` events, which are the extension's, not the core's, so they
do not go through `EventsOut`). `adapters/ws-events-out.ts`
(`createWsEventsOut(tabs)`) is logic-free and stateless: the sockets live in
the registry it is given. `createFlowHistory` takes it once, so
`background.ts` builds it once at module load; the e2e's coverage cannot see
that factory run, so the in-worker contract run builds one of its own over a
registry with stand-in sockets (nothing is created in the browser) and runs
the `EventsOut` contract on it, and the run's detached flow reaches `emit`.

### 3.2 `PageDriver`: narrow page capabilities

Revision 1's `cdp-glue.ts` was a bag of nine functions. It becomes a
`PageDriver` built once per `CdpSession` in `core/session/page-driver.ts`, and
exposing narrow capabilities that handlers require one by one:

```ts
// ports/page-driver.ts (as built in slice 9, revision 7)
export interface Evaluator {          // evaluateInTab (observer reads stay inside the driver)
  evaluate<T = unknown>(expression: string): Promise<T>;
}
export interface Keyboard {           // dispatchKeyEvent (core `pressKey` sends the sequence)
  key(event: KeyEvent): Promise<void>;
  /** One Input.insertText into whatever has focus; a failed dispatch rejects (slice 11). */
  insertText(text: string): Promise<void>;
}
export interface Settler {            // takeObserverMark, settleWithChanges, runSettle
  mark(settle: SettleParams | null): Promise<ObserverMarkResult>;
  settle(settle: SettleParams | null, mark: ObserverMarkResult): Promise<SettleReport | undefined>;
}
export interface Pointer {             // input only (slice 10, revision 8)
  /** One Input.dispatchMouseEvent; a failed dispatch rejects. */
  mouse(event: MouseEventParams): Promise<void>;
}
export interface DragInput {           // input only (slice 14)
  /** One Input.setInterceptDrags; a failed dispatch rejects. */
  interceptDrags(enabled: boolean): Promise<void>;
  /** One Input.dispatchDragEvent; a failed dispatch rejects. */
  dragEvent(event: DragEventParams): Promise<void>;
}
export interface CdpEvents {           // the drag's wait for Input.dragIntercepted (slice 14)
  /** The params of the first event named `method` after the call; null when
   * none arrives within `timeoutMs`. Never rejects. No predicate (revision 9). */
  waitFor(method: string, timeoutMs: number): Promise<unknown>;
}
export interface Navigator {           // input only (slice 15)
  /** One Page.navigate; a failed command rejects. The load wait is PageInfo.armLoadWait. */
  navigate(url: string): Promise<void>;
}
export interface ScreenCapture {       // the page's answers to the core's own commands (slice 15)
  layoutMetrics(): Promise<LayoutMetrics>;            // one Page.getLayoutMetrics
  capture(params: CaptureParams): Promise<string>;    // one Page.captureScreenshot, base64
}
export interface ResponseBodies {      // extension only (slice 15)
  body(requestId: string): Promise<ResponseBody>;     // one Network.getResponseBody
}
export interface DialogInput {         // input only (slice 16, revision 10)
  /** One Page.handleJavaScriptDialog, promptText only when given; rejects
   * with the page's error when no dialog is showing. */
  respond(accept: boolean, promptText?: string): Promise<void>;
}
export interface PageDriver {
  evaluator: Evaluator; keyboard: Keyboard; pointer: Pointer; drag: DragInput;
  events: CdpEvents; navigator: Navigator; dialog: DialogInput; screen: ScreenCapture;
  responses: ResponseBodies; settler: Settler; page: PageInfo;
}
```

The pointer port is the same for both transports. What differed between
their click paths before slice 10 is decided in the core page driver
(`session/page-driver.ts`), which holds `Clock` and the optional, read-only
`DialogWatch` (`createPageDriver({ ..., dialogs? })`, outside `ports/`):
`dispatchMouseEvents` races each event against `dialogs.isOpen()`, polled
on `Clock`, when a watch is given (the extension: a failed dispatch fails
the click), and awaits the events in turn without one (cdp-direct);
`dispatchWatchedMove` bounds the watched move of a click by the budget left
only without a watch (a failed or late dispatch counts as unanswered).
`dialogOpen(deps)` reads the watch, false without one. Click uses these
operations; they are not port members.

`core/session/page-driver.ts` `createPageDriver({ session, page, clock, dialogs? })`
returns the driver plus the observer lifecycle its transport drives:
`observer` (the host mirror), `install({ enableRuntime, onTopDocument })`
(`installObserver` and the binding subscription; each top-document
message goes to `onTopDocument`, where the extension sends its bridge
events) and `uninstall(tearDownPage)`.

One implementation serves both transports, because both have a `CdpSession`;
the nine twin helpers in `transport.ts` are deleted with slice 9.

`CdpEvents` is a wait the core asks for, as `PageInfo.armLoadWait`: the page
driver subscribes through `CdpSession.onEvent` for the call and unsubscribes
when it settles, so no state a transport keeps reaches core through it
(revisions 8 and 9). `DragInput` is input only, as `Pointer`.

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
  derived map equal to today's 23 entries (revision 11: by Map equality; the
  order is not a contract), with today's
  values (14 `true`, 9 `false`), so the derivation is a refactor. Some of
  today's `false` entries are v1 scope decisions rather than missing
  capabilities (`drag`, `console`, `network`); `CDP_DIRECT_PROVIDES` encodes
  that scope (no `drag`, no `capture-buffers`), and changing it is a
  behavior-change PR (7(e)).
- `background.ts` has no tool `case` labels after slice 18b (fitness test 3).
- As built in slice 13 (1.4.19): `wait_for` is registered with
  `requires: ['evaluator']` and a call-dependent requirement, `needs(params)`:
  a `network_url` wait needs `capture-buffers` and carries the text the agent
  reads without it. `dispatchTool` returns that text as an `action` failure
  when the transport's provides set lacks the requirement, so cdp-direct (which
  provides no `capture-buffers`) answers exactly what its `performWaitFor`
  answered. `capture-buffers` is a provides-set entry, not a port: the
  extension gives `CommonDeps.captureBuffers`, a read-only `CaptureWatch`
  (`session/page-driver.ts`, `finishedUrls()`) over its `TabSession` console
  and network buffers (`sessionCaptureWatch`), outside `ports/` as the dialog
  watch is. A
  flow's wait step reaches `performWaitFor` without the registry, so the action
  makes the same check on the absence of the watch. `CDP_DIRECT_PROVIDES` is
  pinned by `cdp/provides.test.ts`.
- As built in slice 14 (1.4.20): `drag` is registered with
  `requires: ['evaluator', 'pointer', 'drag', 'cdp-events']`. The requirement
  `drag` is the `DragInput` port and `cdp-events` the `CdpEvents` port; both
  page drivers have them, and `CDP_DIRECT_PROVIDES` holds `cdp-events` but not
  `drag` (v1 scope), so `dispatchTool` refuses `drag` on cdp-direct as
  `unsupported`, which `cdp/tool-outcome.ts` maps to the text
  `callCdpTool`'s `default` threw before. A flow's drag step reaches
  `performDrag` without the registry; cdp-direct's flow deps keep a
  `performDrag` that fails with that text.
- As built in slice 15 (1.4.21): `ping`, `snapshot`, `state`, `evaluate`,
  `canvas_screenshot`, `console` and `network` are registered in
  `tools/page-read.ts`. `ping` requires `page` (the `PageInfo` port, now a
  requirement both transports provide) and answers `{ title, url }` in that
  key order. `snapshot`, `state` and `evaluate` require `evaluator`;
  `evaluate` keeps each transport's coercion of a missing expression.
  `canvas_screenshot` requires `evaluator` and `canvas`, a provides-set entry
  like `capture-buffers` that only the extension provides (v1 scope); its
  in-page builder is `inpage/canvas.ts`. `console` and `network` require
  `capture-buffers` and read the `CaptureWatch`, which also gives
  `consoleEntries()` and `networkEntries()` over the `TabSession` buffers
  (`ConsoleEntry` and `NetworkEntry` live next to it in
  `session/page-driver.ts`). `navigate` requires `navigator` and `page`: it
  arms the load wait, sends the navigation, cancels the wait when it fails,
  and answers `PageInfo.info()` as each transport gives it. `screenshot`
  requires `screen-capture` and `evaluator`; core `support/screenshot.ts`
  `runScreenshot` takes the `ScreenCapture` port instead of a raw `send`.
  `network_body` requires `response-bodies`, which only the extension
  provides (v1 scope), so cdp-direct refuses it with its unchanged text.
  `LayoutMetrics`, `CaptureParams` and `ResponseBody` live in
  `ports/values.ts` with only the fields core uses. The `evaluate` entry
  declares `commandTimeout: 'call-budget'`; cdp-direct reads that declaration
  and gives the entry an evaluator whose session sends with the call's budget
  as the client's per-command timeout (`cdp/adapters/cdp-client-session.ts`
  `commandTimeoutMs`), so its timeout text is unchanged and no raw
  `Runtime.evaluate` is left under `cdp/` (`cdp/raw-evaluate.fitness.test.ts`
  allows none). Neither transport compares a tool name
  (`cdp/tool-name.fitness.test.ts`, extension `fitness.test.ts`); the
  remaining `switch` cases are the transitional dispatch of the tools not
  yet in the registry.
- As built in slice 16 (1.4.22): `dialog_respond` and `set_permission` are
  registered in `tools/dialog-permission.ts`, `download` and the unlisted
  `download_settle` in `tools/download.ts`. `dialog_respond` requires
  `dialog-input` (the `DialogInput` port; not `dialogs`, which is the
  `DialogWatch` key of `CommonDeps`) and reads no pending dialog: with none
  showing, the page's error is the answer. `set_permission` requires
  `content-settings`; `download` requires `evaluator`, `pointer`, `settler`
  and `downloads` (its click is `performClick`), and `download_settle`
  requires `downloads`. `downloads` and `content-settings` are
  `AdapterRequirement`s: optional in `ToolDeps`, since cdp-direct has no
  adapter for them, and read by a handler through `providedPort`. Only the
  extension provides the three requirements; on a `cdp:` tab the dispatcher
  gate refuses the four tools first, as before, and `dispatchTool` would
  refuse them as `unsupported` with the same text (`cdp/provides.test.ts`).
- As built in slice 18a (1.4.24): `CDP_TOOL_SUPPORT` is
  `cdpToolSupport(TOOL_REGISTRY, CDP_DIRECT_PROVIDES)` followed by the rows
  `cdp/support.ts` declares (`CDP_DECLARED_SUPPORT`): `flow`, `flow_status`
  and `flow_cancel` (`true`, transport-owned until slice 18b) and
  `wait_for_tab` (`false`, dispatcher-only, in no registry).
  `cdpToolSupport` keeps the listed entries (not `download_settle`), each
  `true` when the provides set holds every requirement it `requires`; a
  call-dependent `needs` does not count. `CDP_DIRECT_PROVIDES` lives in
  `cdp/support.ts` (`transport.ts` re-exports it), and core's catalog lists
  its entries in the table's order. `cdp/support.test.ts` pins the derived map
  equal to the 23 entries of 1.4.23 (Map equality), names the four declared
  rows, pins the relative order of the 19 derived rows, and shows that
  declaring `drag` on cdp-direct changes the map. The map's order is not a
  contract (revision 11).
- As built in slice 18b (1.4.25): `flow`, `flow_status` and `flow_cancel`
  are registered in `tools/flow.ts`, and every wire tool of both transports
  is in the registry: `background.ts` `handleTool` and `cdp/transport.ts`
  `callCdpTool` are one `dispatchTool` call each, with no `switch`. `flow`
  and `flow_status` require `flows`, the transport's `FlowControl`
  (`flow/flow-control.ts`, revision 11); `flow_cancel` requires `flows` and
  `flow-cancel` (`FlowCancel`). Both are `ServiceRequirement`s, optional in
  `ToolDeps` like the `AdapterRequirement`s (the deps an action builds for
  one step carry neither) and read through `providedPort`. The handler holds
  the parameter reading, the dry run, the one-detached-flow-per-tab refusal,
  the foreground deadline, the detached launch answer and the
  hidden-password-values note; `start` returns the launch (`shouldCancel`,
  `onProgress`, `startedAt`, `expiresAt`, `finish`) or the transport's
  refusal. The extension's `FlowControl` (`app/flow-control.ts`) runs over
  `FlowRegistry` and `FlowHistory`, mints a `flow_` id when the server sent
  none, refuses an unpersisted detached launch, and reads the tab title
  through `adapters/chrome-tab-title.ts`; it is built per tool call and holds
  no state. cdp-direct's (`cdp/flow-control.ts`) runs over
  `cdp/detached-flows.ts`, its gate (checked before each step; a detached
  flow stops as `grant-revoked`) and its connection hold (Q4); it and
  `cdpFlowCancel` are what `CDP_DIRECT_PROVIDES` adds as `flows` and
  `flow-cancel`. The extension provides `flows` but not `flow-cancel`
  (revision 11). The requirement `idle` of the sketch above has no caller:
  each transport's flow control holds its own idle model. `cdp/support.ts`
  declares only `wait_for_tab` now, and `CDP_TOOL_SUPPORT` still equals the
  1.4.23 table. The extension `fitness.test.ts` fails on a `case` label of
  `background.ts` naming a registered tool.

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
| `sensitive` | `ok: false, error: message, sensitive_field: true` (the server rejects with `SensitiveFieldError`; the agent sees only `message`; the trail row stores `[sensitive field]`) | `throw new SensitiveFieldError(message)` | `handleTool` cases `type`, `press`; `ws-bridge.ts`; `failureError`; `activity/extract.ts` `buildRow` |
| `thrown` | `ok: false, error: err.message` (or `String(err)`) | rethrown unchanged | `handleTool` `catch` |
| `unknown-tool` | `ok: false, error: "Unknown tool: <tool>"` | today's defense-in-depth `default` text, unchanged | `handleTool` `default`; `callCdpTool` `default` |
| `unsupported` | `ok: false, error: "Unsupported tool: <tool> needs <requirements>"`; not reachable over the wire (the extension lacks `flow-cancel`; the request never reaches it, revision 11) | not reachable (the dispatcher gate refuses first); kept as a typed defense | `browser-dispatch.ts` gate |

The `sensitive` kind shows on three different surfaces. On the extension
wire the response carries `sensitive_field: true` (core `tools/failure.ts`
`toolResponse`, since slice 11 the only place that adds it; before, the
`type` and `press` cases of `background.ts` `handleTool`). The server side of
that transport turns it into `SensitiveFieldError` (`bridge/ws-bridge.ts`),
and cdp-direct throws the same class (`cdp/tool-outcome.ts` `cdpToolResult`;
before slice 11, `cdp/transport.ts` `failureError`), so both transports reach
`activity/extract.ts` (`buildRow`, the `SensitiveFieldError` check) with the
same class. The agent does not see the marker: the MCP result is the ordinary
error text of `action`, with no `sensitive_field`. The only place the marker
shows is the activity trail, whose row stores `SENSITIVE_PAYLOAD_MARKER`
(`[sensitive field]`) instead of the typed text.

A `browser.wait_for` that expires is not in this taxonomy: the tool returns an
ordinary result `{ matched: false, reason: "timeout" }` with no `isError`, so
there is no failure to map. The e2e case `error.timeout`
(`packages/e2e/src/run.mjs`) asserts exactly that. Transport
failures that are not tool failures (cdp-direct gate, malformed `cdp:` id,
connection loss; extension socket closed) stay in each transport and are not
part of `ToolFailure`.

`defineToolOutcomeMappingContract` (5.3, item 5) feeds both mappings one
outcome per kind and asserts the table above. As built in slice 10 (revision 8): the
contract lives in `core/src/tools/outcome-mapping.contract.ts` (it speaks
`ToolOutcome`, and `ports` imports nothing in core); the extension's mapping
is core `tools/failure.ts` `toolResponse` (its wire is the shared protocol),
cdp-direct's is `cdp/tool-outcome.ts` `cdpToolResult`; `thrown` carries the
thrown value as `cause`, which cdp-direct rethrows unchanged. Error-path e2e cases (slice 3b)
pin the real strings in Chrome (and the trail row for `sensitive`) before slice 10 moves the first handler, and
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

As built in slice 12 (1.4.18), for the extension only:

- `TabSession` holds the tab's page driver, the activity clock, the call
  hold (`runCall`), the bounded buffers and the pending dialog; the
  extension's `DialogWatch` is `sessionDialogWatch`, which reads the pending
  dialog of the tab's live `TabSession`. `touch` sets the activity to the
  clock's time and the end of a call takes the `max`, as before: invariant 1
  holds with a clock that does not go backwards. The sweep's per-tab decision
  is `TabSession.idleCandidate` (core `idleTabs` over every session); the
  sweep interval stays a `setInterval` in `background.ts` (2.6), so `Clock`
  has no `every`.
- `TabRegistry` keeps today's lifetime of the in-flight guard: the
  reservation is held for the whole connect attempt, until its registration
  settles, while the session it commits is live from the debugger attach on
  (the debugger events, the close handler and the reconnect scheduler read
  it). So `commit(reservation, session)` makes the session live without
  ending the reservation; `release(reservation)` in the connect's `finally`
  ends it, and releasing one never committed is its abort. A reservation is
  committed at most once and never after its release.
- `TabConnection` (`app/tab-connection.ts`) also holds the tab's debugger
  intake (`debuggerIntake`: console, network and dialog events into the
  session, the dialog bridge events, the recorder's binding calls), the
  fan-out of the permanent `debugger.onEvent` listener (`deliverCdpEvent`)
  and the teardown (`closeTabConnection`, which `background.ts` `cleanup`
  calls with the Chrome calls as functions). Its socket is a
  `BridgeSocket`, opened by the `SocketFactory` (slice 19), so its tests
  and those of `app/connection.ts` use a fake socket.
- cdp-direct does not use `TabRegistry`: its cache is keyed by target id, a
  concurrent call joins the dial in flight instead of being refused, and a
  closed entry is replaced, so adopting the registry would change its
  behavior (Q4).

### `FlowRun`, `FlowRegistry`, `FlowHistory` (core/flow/)

- **`FlowRun`**: one flow's state machine. Invariants: `shouldStop` turns
  true at `expiresAt = start + MAX_DETACHED_FLOW_MS` (30 min) or on cancel;
  **cancel is idempotent**; **finished exactly once** (`finish` returns the
  result once; a second call is a no-op).
- **`FlowRegistry`** (one per worker, across tabs, `createFlowRegistry`): **one detached flow per tab**; cancel of an unknown or
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

As built in slice 17 (1.4.23), for the extension only: `FlowRun` is the
run's data (`flow-run.ts`, the former `FlowRegistryEntry`) with
`stopFlowRun` and `flowRunShouldStop`, and `summarizeFlow`, the one
reading of a result; `createFlowRegistry(clock)` holds the runs and the
foreground deadlines (`register({ foregroundDeadlineAt })`, dropped at
`finish`) and answers the idle sweep's `idleHolds()`; `createFlowHistory`
takes both stores, the `Clock`, the `EventsOut` port for the
`flow-finished` event (since slice 21c, revision 13 decision 6; until then a
`publish` function of `background.ts`) and `onRecordLost` (the warning when
even the minimal terminal record is refused). Each invariant above is unit-tested on the
in-memory stores (`flow/flow-registry.test.ts`, `flow/flow-history.test.ts`).

### `PendingReplies<T>` (core/session/pending-replies.ts)

Replaced the three request/reply Maps of `background.ts`
(`pendingActivityQueries`, `pendingAdminRequests`, `pendingRepairs`) in
slice 19: `wait(id, timeoutMs, onTimeout)` and `settle(id, reply)`, on a
`Clock`. Invariants: an id settles at most once, by its reply or by its
timeout; a reply for an unknown id is ignored; the timeout settles the waiter
with `onTimeout()` and forgets the id, so none outlives its timeout. A
disconnect settles nothing: the waiter still ends at its timeout (revision
12). It needs nothing from Chrome, so it sits in core's session layer and is
unit-tested there; only the extension uses it today, one per round trip
(`app/connection.ts` `BridgeReplies`).

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
against the code to be moved, four modules fail that today and are fixed by
slice 5b, before anything moves. Two of them, `flow.ts` and `expect.ts`, have
server copies compared full-body by `cdp/drift.test.ts` (everything below the
file-header comment, imports included), so their fix lands in both copies and
in both copies' callers in the same PR (N4):

| Module | Impurity at `5ce3055` | Fix in slice 5b |
|---|---|---|
| `flow-registry.ts` | `import type { Messages } from './i18n.js'` (UI copy) for `flowTabLabel`, `describeFlowProgress`, `stopReasonLabel`, `describeFlowHistoryEntry` | 5b-2: those four move to a new extension module `flow-labels.ts`; callers re-pointed |
| `flow-registry.ts` | `measureJsonBytes` uses `new TextEncoder()` | 5b-2: `utf8ByteLength(s)`, a pure UTF-8 byte count, created directly in core as `support/utf8.ts`; a test asserts it equals `new TextEncoder().encode(s).length` for ASCII, CJK, emoji and lone surrogates (encoded as U+FFFD, 3 bytes) |
| `idle-policy.ts` | storage keys (`CONSOLE_IDLE_TTL_STORAGE_KEY`, legacy keys), storage parsing (`effectiveIdleTtlMinutes`, `legacyIdleChoice`, `parseIncomingSettings`, `shouldAcceptIncomingSettings`) and CLI copy (`idleTtlCommand`) mixed with the rules; imports `MAX_DETACHED_FLOW_MS` from `flow-registry` | 5b-2: rules (`clampIdleTtlMinutes`, `shouldDisconnectForIdle`, `idleHoldUntil`, `activityAfterFlowEnded`, `tabsToDisconnectForIdle`, `shouldScheduleIdleSweep` and the limits) are created directly in core as `policies/idle-rules.ts`; the rest becomes extension `idle-settings.ts`; `MAX_DETACHED_FLOW_MS` moves to core `support/flow-limits.ts`, which `flow-registry` re-exports |
| `flow.ts` (and server `cdp/flow.ts`) | `pause` calls `setTimeout`; `haltReason` and `pause` read `deps.now ?? Date.now` | 5b-1: `FlowDeps` takes a required `clock: Clock` instead of `now?`; `pause` uses `clock.sleep`. Callers: extension `buildFlowDeps`, server `transport.ts` `buildCdpFlowDeps` and the `deadlineAt` spread around it |
| `expect.ts` (and server `cdp/expect.ts`) | `realClock` default (`Date.now`, `setTimeout`); `withProbeTimeout` uses `setTimeout`/`clearTimeout` | 5b-1: `ExpectClock` becomes `Clock`, `verifyExpect`'s `clock` parameter becomes required and `realClock` is deleted; `withProbeTimeout` uses `clock.after`, so `beginExpect` takes a required `clock` too (revision 6). Callers: `performClick`, `performType`, `performPress` in both `background.ts` and `transport.ts` |

**How the `Clock` type reaches both copies in 5b-1.** The import lines of
`flow.ts` and `expect.ts` are inside the full-body comparison, so both copies
must import `Clock` with the same specifier, and the server cannot import
core before the mirror exists. 5b-1 adds a sibling `clock.ts` on each side
(`packages/extension/src/clock.ts`, `packages/server/src/cdp/clock.ts`), both
declaring the `Clock` interface of 3.1, byte-identical below the header, with
a new `drift.test.ts` section; a type test in the extension asserts it is
mutually assignable with core's `ports/clock.ts` `Clock`. The real clocks are
`adapters/system-clock.ts` (extension) and `cdp/adapters/system-clock.ts`
(server), each exporting `systemClock` under the same name, so the three
`perform*` call sites stay identical and `transport-parity.test.ts` `HANDLERS`
stays green. Both sibling `clock.ts` files are deleted in slice 8, when the
last module that imports them (`flow.ts`) moves to core and imports
`ports/clock.ts`. The tests that inject time (`flow-deadline.test.ts` and
`expect.test.ts`, both sides) switch from `now` and `ExpectClock` fakes to a
fake `Clock`; the server's `transport.test.ts` fakes `Date` with
`vi.useFakeTimers` and runs unchanged, which checks that `systemClock` reads
the same `Date.now`.

**Proof that the set is complete, and that it stays pure (N5).** Slice 5b-2
adds `packages/core/tsconfig.purity.json` with core's compiler options and
`"files"` set to the extension modules slated to move (the closure of their
imports is checked with them). `tsc -p packages/core/tsconfig.purity.json`
fails at the start of 5b-2 (RED, recorded in the PR) and passes at its end.
CI runs it until the last listed module lives in core: each slice that moves
a listed module removes it from `"files"` in the same PR (6: `inpage/*`; 7:
`settle`, `expect`, `keymap`, `screenshot`, `observer-host`; 8: `flow.ts`,
`clock.ts`), and slice 17, which moves `flow-registry.ts`, deletes the file.
Since slice 17 (1.4.23) the file and its CI step are gone; core's own
`tsc -p packages/core` checks every moved module.
`utf8.ts`, `flow-limits.ts` and `idle-rules.ts` never need a move: 5b-2
creates them in core, where core's own `tsc -p packages/core` checks them from
the start; they reach the server through the mirror, unused there and
harmless.

### 5.2 Layers inside core

```
tools         -> actions, flow, session, policies, support, inpage, ports
actions       -> session, support, inpage, ports
session, flow -> policies, support, inpage, ports    (session and flow do not import each other)
policies      -> support (flow-limits only), ports
support       -> inpage, ports
inpage        -> (nothing in core)
ports         -> (nothing in core)
```

`ports` is the bottom layer (revision 3, N2, as arch suggested): the port
interfaces, `Clock`, and the value types they speak (`ports/values.ts`,
3.1) import nothing in core, so every layer above may depend on them and no
port can pull behavior in. That is the hexagon read literally: the core's
vocabulary at the bottom, the code that uses it above. Revision 2 had
`ports -> support` (for the settle types) and `support -> inpage` only, which
forbade `expect.ts` (support) taking a `Clock` (ports) and would have needed a
cycle to allow it. `support` modules that declare those types today
(`settle.ts`, `observer-host.ts`) import them from `ports/values.ts` once they
move (slice 7).

The layers file `core/src/fitness/layers.ts` states this table as data:
folder name to allowed folders. Within a folder, imports are free but
acyclic. `@browser-link/shared` is allowed everywhere.

The existing `idle-policy.ts` → `flow-registry.ts` edge (policies → flow)
would break the rule; slice 5b-2 removes it by moving `MAX_DETACHED_FLOW_MS`
to `support/flow-limits.ts`.

| Module | May import | Must not import |
|---|---|---|
| `packages/core/src/**` | `@browser-link/shared`, core files per 5.2 | `chrome`, `node:*`, any npm package, extension, server |
| `packages/extension/src/adapters/**` | core, shared, `chrome` | other adapters |
| `packages/extension/src/app/**` | core, shared, extension policies, interfaces of its own module | `chrome` |
| `packages/extension/src/background.ts` | anything in the extension | tool logic (no tool `case` labels) |
| `packages/extension/src/{popup,activity,admin,ui-language}.ts` (UI zone) | `chrome`, shared, core, the pure extension modules they import today (`i18n`, `admin-view`, the policies, `recording`, `flow-registry`, ...) | `background.ts`, `adapters/**`, `app/**`; and no worker-zone module imports a UI-zone module |
| `packages/server/src/cdp/**` | `generated/core`, `generated/shared` | `packages/core` by relative path |
| `packages/server/src/generated/**` | relative paths inside `generated/` only (2.3 "Specifiers") | `@browser-link/shared`, `@browser-link/core` |

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
   `ports` file importing `support`; a two-file cycle. Fixtures are excluded
   from the mirror (2.3).
3. **`extension/src/fitness.test.ts`** (lands in slice 5; every rule below is
   green at `5ce3055` as written, and each has a RED fixture):
   - **Two zones, `chrome` confined in the worker zone (N3).** The *worker
     zone* is `background.ts` plus its transitive import closure inside
     `packages/extension/src` (computed from the import graph, type-only
     imports included). The *UI zone* is a closed list in the test:
     `popup.ts`, `activity.ts`, `admin.ts` (the scripts of the three HTML
     pages) and `ui-language.ts` (imported only by those three). Rules:
     in the worker zone, `chrome` identifiers (AST identifiers, so comments
     do not count) appear only in `adapters/**` and `background.ts`; no
     worker-zone module imports a UI-zone module; UI-zone modules import
     neither `background.ts`, `adapters/**` nor `app/**`. At `5ce3055` the
     only modules with `chrome` identifiers outside comments are
     `background.ts`, `popup.ts`, `activity.ts`, `admin.ts` and
     `ui-language.ts`; `recording.ts`, `admin-view.ts` and `i18n.ts` name
     `chrome` in comments only, and `download-capture.ts` receives the
     `chrome.downloads` API as a parameter, so the rule is green on day one
     without an exemption.
     Why the UI pages get no adapters: each page is its own small composition
     root running in a document whose lifetime is the window's, not the MV3
     worker's, so the wake-up rule (R1) does not apply; cdp-direct has no UI,
     so no port would have a second implementation; and their testable logic
     already sits in pure modules with seams (`admin-view.ts`, `i18n.ts`,
     `ui-language.ts` `LanguageStore` with an in-memory fake). A UI file that
     grows logic moves it into a pure module, as `admin-view.ts` did; a new
     file joins the UI zone only by being added to the list with a reason, in
     a reviewed PR.
   - **`app/**` stays chrome-free (5.2, since slice 12).** Every `app/**`
     module, in the worker zone or not, names no `chrome` identifier and
     imports neither `background.ts` nor `adapters/**`; a RED fixture
     breaks each rule.
   - **Adapters stay free of logic (N8).** For every function-like node in
     an `adapters/**` file (function declarations, arrow functions, function
     expressions, methods, and the methods of object literals a factory
     returns: the walk visits every function body, not only exported ones),
     the decision count is 0. One decision each: `if`, `?:`, each `case`
     clause, `for`/`for...of`/`for...in`/`while`/`do`, `catch`, `&&`, `||`.
     Not counted: `??` and `?.`, because in an adapter they only default or
     guard an argument while mapping it, and every alternative they select is
     a value, not a path. A filter that needs a decision (for example the
     extension `CdpSession` keeping only events whose `source.tabId` matches)
     is written once as a pure, unit-tested combinator in `app/`
     (`filtered(predicate, listener)` with `isForTab(tabId)`) and passed as
     the listener, so the adapter body stays a single call. An exemption names
     the function, the reason and the test that covers its branch; the list
     is capped at three entries and each addition needs arch's sign-off in
     the PR (condition 2 of R6).
   - `background.ts` line budget, constant `BACKGROUND_LINE_BUDGET` (5.4);
   - `background.ts` contains no `case '<tool>'` for any registry name (since
     slice 18b; its RED fixture is the transitional `case 'flow'`);
   - **Wake listeners are registered synchronously by the composition root
     (R1, N3).** The test holds `WAKE_SUBSCRIPTIONS`, the events of the ten
     permanent registrations of section 1 (eight distinct events:
     `storage.onChanged` and `windows.onRemoved` are subscribed twice;
     `debugger.onEvent`, `alarms.onAlarm`, `runtime.onMessage`,
     `tabs.onRemoved`, `tabs.onCreated`, `debugger.onDetach`), each mapped to
     the calls that subscribe to it: `chrome.<ns>.<event>.addListener` today,
     plus the adapter method that wraps it from the slice that introduces
     that adapter (for example `alarms.onAlarm` to `Alarms.onFire` in slice
     19), resolved with the type checker. The slice that adds an adapter
     updates the map in the same PR. Rules: for each entry, `background.ts`
     holds at least one subscription as a top-level expression statement (not
     inside a function, callback or block); a mapped adapter method is called
     only from those top-level statements; and its body in the adapter is the
     single `addListener` call (plus returning the unsubscribe), with no
     `await`. Moving a wake listener into a function, behind an `await`, or
     into `app/` fails the test, before and after slices 19-21. Transient
     subscriptions scoped to one operation and paired with a
     `removeListener` (the load wait of core `session/load-wait.ts` on
     `tabs.onUpdated`, the per-call `debugger.onEvent` handlers, and the
     recording navigation listener) are not wake listeners and are not
     constrained by this rule; after slices 9-21 they go through
     `CdpSession.onEvent`, `PageInfo.armLoadWait` and `TabEvents.onUpdated`.
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
   unsubscribe; an armed load wait resolves on load, rejects on timeout and,
   once cancelled, never settles; the
   stores round-trip records and `remove`/`drop` are idempotent; the outcome
   mapping follows the table in 3.4.

### 5.4 The `background.ts` budget, re-measured

`BACKGROUND_LINE_BUDGET` starts at **5039** in slice 5 (revision 5: 4922 was
the count at `5ce3055`) and every slice that
moves code out lowers it to the new count; it is never raised without arch
sign-off. With adapters for `windows`, `alarms`, `runtime`, tab events and the
socket, the composition root holds: imports (~45 lines), construction of 14
extension adapters (with `system-clock.ts`) and the core services (~70), ten listener registrations as
one-line delegations plus the interval (~25), three startup calls and
`BRIDGE_PORT` with its comment (~15), and file comments. Estimate: **about
200 lines**. The ceiling stays **400**; slice 22 sets the constant to the
measured count, so the slack is not left as room to grow.

That estimate never counted the settings caches (revision 13): after slice 21
`background.ts` held 725 lines. Slices 21b (settings, 598 lines after it),
21c (events out, 536 after it) and 21d (connect) move what is left before slice 22.

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
| 0 | Chrome 118 + stable in CI (**done**, merged as release 1.3.3, `9bc84a7`) | three jobs in `ci.yml` (7(a)): `e2e` on Chrome for Testing 118.0.5993.70 (installed with `@puppeteer/browsers`, cached), the only e2e job in `release.needs`; `e2e-stable` on the runner's `/usr/bin/google-chrome`, reporting; `e2e-stable-issue`, the only job with `issues: write`. `run.mjs` writes the browser record to `packages/e2e/build/e2e-result.json` and to `$GITHUB_STEP_SUMMARY` titled with `E2E_LEG`; each job uploads it as `e2e-result-chrome-118` or `e2e-result-chrome-stable` | ~80 authored | both jobs run; summary shows the two versions | revert the PR; CI falls back to one job |
| 1 | e2e: page read and capture | cases for `navigate`, `state`, `ping`, `screenshot`, `canvas_screenshot`, `console`, `network`, `network_body`; fixtures in `packages/e2e/pages/` | ~350 authored | each case fails under `E2E_EXPECT_FAIL=<tool>` and passes otherwise | revert; no product code touched |
| 2 | e2e: drag, permission, tabs, flow control | cases for `drag`, `set_permission`, `wait_for_tab`, `flow_status`, `flow_cancel` | ~350 authored | same as 1 | revert |
| 3 | Differential harness | `E2E_EXT_DIST`, `E2E_SERVER_CLI`, `E2E_SERVER_EXTENSION_ID` overrides in `lib.mjs`; `E2E_RECORD=<file>`; per-run `HOME`; `scripts/e2e-diff.mjs` (7(b)); CI job `e2e-diff` | ~350 authored | self-diff of two runs of the same build is empty; a one-token change in a result string and in an error string are both reported | revert |
| 3b | e2e: error paths (**done**, release 1.3.9) | four cases in `packages/e2e/src/run.mjs`: `error.action` (click on a missing selector), `error.thrown` (evaluate throws), `error.timeout` (`wait_for` expiry, asserted as an ordinary result `{ matched: false, reason: "timeout" }` with no `isError`, not a failure), `error.sensitive` (type on a password field fails; the exact error text is asserted and the activity trail row stores `[sensitive field]`; the MCP result carries no `sensitive_field`); `unknown-tool` is asserted through the contract suite only (no MCP path sends one); the exact error text is asserted | ~250 authored | `E2E_EXPECT_FAIL` RED probe per case; the differential records them | revert |
| 4 | Bundler alone | `packages/extension/build.mjs` (esbuild `0.28.2` exact, entries `background`, `popup`, `activity`, `admin`, `format: 'esm'`, `target: 'chrome118'`, `bundle: true`, no minify, `sourcemap: 'linked'`); `build` becomes `tsc --noEmit && node build.mjs && node copy-assets.mjs`; `smoke-tarball.mjs` assertions (7(c)). No source file changes. | ~120 authored | 7(c) | revert restores tsc output |
| 5 | Core skeleton | `packages/core` (private, `0.0.0`, 2.4) with `ports/` (types only, the bottom layer: `clock`, `values`, `cdp-session`, `page-info`, `settings`, `content-settings`, `index`, 5.2; revision 5), `fitness/` with layers and cycle test and their RED fixtures, extension `fitness.test.ts` with its zones, logic-free adapter, budget and wake-listener rules and their RED fixtures (5.3 item 3; the no-tool-`case` rule waits for slice 18), the `CdpSession` and `PageInfo` contract functions with in-memory fakes, `scripts/sync-core.mjs` with `--check`, the specifier rewrite (2.3) and its test, server `vitest.config.ts` exclusion, explicit `build`/`test` scripts, mirror of `core/src` only (`shared` joins in 5c), budget = 5039; the extension's `tsc --noEmit` proven with one runtime import from core in `core-link.check.ts`, which no bundle entry reaches, and esbuild's resolution of it by `fitness-core-link.test.ts` (2.2) | ~450 authored | fitness and mirror checks green and RED-probed | revert |
| 5b-1 | Core purity: `Clock` | 5.1 rows `flow.ts` and `expect.ts`, in both copies and their callers in one PR (N4): sibling `clock.ts` on each side with a `drift.test.ts` section, `systemClock` adapters on each side, `FlowDeps.clock`, required `verifyExpect` `clock`, `withProbeTimeout` on `clock.after`; extension `buildFlowDeps`, server `buildCdpFlowDeps`, the three `perform*` call sites on each side; `flow-deadline.test.ts` and `expect.test.ts` on both sides moved to a fake `Clock` | ~260 authored (about 110 per side plus ~40 tests of the new files) | `drift.test.ts` and `transport-parity.test.ts` green (both copies changed identically); the timer-driven tests green on a fake `Clock`; e2e; differential equal | revert |
| 5b-2 | Core purity: the rest | 5.1 rows `flow-registry.ts` and `idle-policy.ts`: `flow-labels.ts`; `utf8.ts`, `flow-limits.ts`, `idle-rules.ts` created in core; `idle-settings.ts`; `tsconfig.purity.json` in CI | ~280 authored / moved | `tsc -p packages/core/tsconfig.purity.json` RED at the start (recorded) then GREEN; unit tests of moved functions unchanged and green; e2e; differential equal | revert |
| 5c | Server `messages.ts` from the mirror | `generated/shared/` populated; `server/src/messages.ts` becomes a re-export of `./generated/shared/index.js`; the "wire protocol drift guard" block of `config.drift.test.ts` deleted (the mirror check covers it) | ~20 authored, copy deleted ~400 | server `tsc` green; a test lists the names `messages.ts` exported before and asserts each is still exported; e2e; differential | revert |
| 6 | In-page code | `inpage/{builders,observer,deep-query,dom-helpers}` to core; server copies replaced by the mirror; `builders-parity.test.ts` deleted | moved ~4k (renames), copies deleted | e2e, differential, unit tests re-homed | revert |
| 7 | Support modules | `settle`, `expect`, `keymap`, `screenshot`, `observer-host` to `core/support/` (after 6: `settle` and `expect` import `inpage/builders`, `observer-host` imports `inpage/observer`); their `drift.test.ts` sections deleted; `SettleParams`, `EvaluateFn` and `ObserverMark` declarations replaced by imports from `ports/values.ts` (type-only, 5.2); their entries removed from `tsconfig.purity.json` | moved ~1.15k, copies deleted ~1.25k | same | revert |
| 8 | Flow engine | `flow.ts` to `core/flow/flow-engine.ts`, importing `ports/clock.ts`; `cdp/flow.ts` copy and both sibling `clock.ts` files deleted with their `drift.test.ts` sections; `flow.ts` and `clock.ts` removed from `tsconfig.purity.json` (the file stays, 5.1) | moved 1352 (rename), copy deleted 1348 | same | revert |
| 9 | Sessions and page driver | `CdpSession`/`PageInfo` adapters both sides; `PageDriver` (3.2) from `background.ts` `cdp`, `evaluateObserverJs`, `takeObserverMark`, `settleWithChanges`, `handleObserverMessage`, `installObserver`, `dispatchKeyEvent`, `evaluateInTab`, `waitForLoad`, and the nine twins in `transport.ts` | ~330 from background, ~250 deleted from server | contract suite green on fakes, cdp-direct and in the worker; R6 conditions 1-3 green (section 8); e2e; differential | revert |
| — | **Checkpoint A** (6.2) | | | | |
| 10 | Registry + interaction: find, click | `ToolRegistry`, `ToolFailure` and both outcome mappings; `performFind`, `performClick`, click landing, frame watch; their entries | ~380 | outcome-mapping contract; error-path cases from 3b (`error.action`, `error.thrown`); the two handlers leave `transport-parity` `HANDLERS` | revert |
| 11 | Interaction: type, press | `performType`, `performPress` and their entries (`sensitive` kind) | ~250 | RED probe: mapping `sensitive` like `action` fails the contract (wire flag and `SensitiveFieldError`) and the trail assertion of the 3b case `error.sensitive` | revert |
| 12 | `TabSession`, `TabRegistry`, `TabConnection` | aggregates from `TabState`, `tabStates`, `connectsInFlight`, debugger intake (`attachDebuggerListener`), call hold, sweep, `cleanup` | ~400 (may split in two: core aggregates, then extension `TabConnection`) | unit tests of each invariant with a fake `Clock`, including a call that throws, one longer than the TTL, and a reserve/abort race | revert |
| 13 | wait_for | `performWaitFor` and its entry; the `network-url-mode` divergence becomes a `capture-buffers` requirement check, same behavior | ~200 | e2e; differential | revert |
| 14 | drag | `performDrag`, `handleDrag`; requires `drag`, which cdp-direct does not provide | ~330 | e2e case from slice 2 | revert |
| 15 | Page read and capture | `handlePing` ... `handleNetworkBody`, canvas builder; server cases `navigate`, `snapshot`, `state`, `screenshot`, `ping`, `evaluate` | ~300 | e2e from slice 1 | revert |
| 16 | Dialogs, permission, downloads | `handleDialogRespond`, `handleSetPermission`, `handleDownloadCapture`, `handleDownloadSettle`; `ContentSettings` and `Downloads` adapters | ~220 | e2e `dialog_respond`, `set_permission`, `download` | revert |
| 17 | `FlowRun`, `FlowRegistry`, `FlowHistory` | aggregates and the two store adapters (lines 3025-3287, `foregroundFlowDeadlines`); `flow-registry.ts` moves to core and `tsconfig.purity.json` is deleted (5.1) | ~330 | unit tests of each invariant with in-memory stores; store contract on fakes and in the worker | revert |
| 18a | Derived support table (**done**, release 1.4.24) | `CDP_TOOL_SUPPORT` derived from the registry (`cdpToolSupport`) plus four declared rows, `CDP_DIRECT_PROVIDES` moved to `cdp/support.ts` (3.3, revision 11) | ~100 authored | snapshot test against the 1.4.23 table, RED-probed by declaring `drag`; e2e; differential | revert |
| 18b | Flow tools (**done**, release 1.4.25) | `handleFlow`, `handleFlowStatus`, `buildFlowDeps`, server flow cases behind `FlowControl` and `FlowCancel`; the five transitional tool cases and the three declared flow rows removed; `CDP_DIRECT_PROVIDES` gains `flows` and `flow-cancel`; the no-tool-`case` fitness rule (revision 11) | ~250 + ~190 server | e2e `flow`, `flow_status`, `flow_cancel`; the support snapshot still equals the 1.4.23 table; the no-tool-`case` rule RED-probed | revert |
| — | **Checkpoint B** (6.2) | | | | |
| 19 | Connection lifecycle (**done**, release 1.4.28) | `app/connection.ts` (tab ids, reconnect wiring, WebSocket switch); `PendingReplies<T>`; `chrome-alarms`, `web-socket` adapters | ~450 | unit tests with a fake socket and alarms; e2e handshake and Origin cases | revert |
| 20 | Recording (**done**, release 1.4.29) | `app/recording.ts` (lines 4328-4658 at `5ce3055`): start, navigation steps, the cap, stop, discard, save, status; the `chrome-tab-events` adapter | ~330 | existing `recording.test.ts` plus `app/recording.test.ts` on fakes; an e2e recording case on a tab of its own; manual popup check noted in PR | revert |
| 21 | Popup router, windows, repair, tab events (**done**, release 1.4.30) | lines 633-900 (`chrome-windows`), 4234-4327, `chrome.runtime.onMessage` and tab events (`chrome-runtime`, `chrome-tab-events`) to `app/` | ~460 (may split in two) | unit tests of the router; e2e i18n and Admin cases; `wait_for_tab` case | revert |
| 21b | Settings (**done**, release 1.4.31) | the idle-TTL and flow-recording caches, their storage listeners and the `settings.update` apply functions to `app/settings-cache.ts`; the `chrome-settings` adapter; the contract harness's teardown on failure (revision 13) | ~250 | unit tests of the caches; the `LocalSettingsStorage` contract on the fake and in the worker; the teardown probe through the browser; e2e recording case | revert |
| 21c | Events out (**done**, release 1.4.32) | the `EventsOut` port (`ports/events-out.ts`, `BridgeEventPayload`) with its contract and fake; `createFlowHistory` on `EventsOut`; `flowFinishedEvent` in core; `publishFlowFinished` and `reportTopDocument` to `app/events.ts`; the `ws-events-out` adapter (revision 13, decision 6) | ~300 | the `EventsOut` contract on the fake, on the adapter over fake sockets and in the worker; unit tests of `app/events.ts` and `flowFinishedEvent`; e2e detached flow; differential | revert |
| 21d | Connect (pending) | the connect path (`connectTab`, `doConnectTab`) out of `background.ts` | specifics added by the slice | specifics added by the slice | revert |
| 22 | Retire parity guards | delete `transport-parity.test.ts` and the remaining copy sections of `drift.test.ts` and `config.drift.test.ts`; budget set to the measured count (5.4) | deletions only | contract suite green on fakes and both adapters in the same CI run | revert |

Order rationale: the safety net first (0-3b), then the build change alone
(4), then the empty core and its rules (5), core purity and the protocol copy
(5b-1, 5b-2, 5c; `Clock` first because it is the change that touches both
copies of `flow.ts` and has the least proof, so it lands alone and the purity
check that 5b-2 adds can go GREEN in one PR), then modules whose move is a
rename, bottom layer first (6-8), then
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
- **Checkpoint B, after slice 18b.** Delivered: one body per tool for both
  transports, one failure contract, `CDP_TOOL_SUPPORT` derived, aggregates
  with tested invariants. Go/no-go for slices 19-21.
- **Minimum viable end state:** slices 0-18 plus 22 (22 depends only on 18:
  contract suite green and one body per action). It closes all four findings.
  Slices 19-21 make the extension-only application code unit-testable and
  bring `background.ts` to its final budget; if the program stops at
  checkpoint B, slice 22 runs next and the budget stays at its slice 18b value.

### 6.3 CI cost per PR

Wall times are not in this document yet: slice 0's two e2e jobs now run on
every PR and record them, slice 3 adds the differential, and checkpoint A
compares them with these budgets.

| Job | When | Timeout | Runs per PR |
|---|---|---|---|
| `ci` (unit, fitness, mirror check, build, smoke) | every PR | unchanged | 1 |
| `e2e` (Chrome 118, blocks `release`) | every PR | 10 min | 1 |
| `e2e-stable` (reports) | every PR | 10 min | 1 |
| `e2e-stable-issue` | only after an `e2e-stable` failure on a push to `main` | default | 0 |
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
- **Release gate (owner decision, 2026-11-17; built by slice 0, merged as
  release 1.3.3).** `ci.yml` (triggers: pushes to `main` and PRs against
  `main`) has two separate e2e jobs, not a matrix, so "leg" below means a
  job and the stable one cannot block through a matrix:
  - `e2e` ("e2e (Chrome 118, ubuntu)"): Chrome for Testing `118.0.5993.70`
    installed by `@puppeteer/browsers` into a cached directory, 10 min
    timeout. `release` has `needs: [ci, e2e]`, so this job blocks the
    publish. Since slice 9 its e2e run also fails when an extension adapter
    function was never called (R6 condition 1, V8 coverage of the worker;
    `E2E_ADAPTER_COVERAGE=0` turns it off, as `scripts/e2e-diff.mjs` does),
    and a step after it runs the port contract suite against the cdp-direct
    adapters on the same Chrome (`cdp/adapters/contract.chrome.test.ts`,
    enabled by `CDP_CONTRACT_CHROME`).
  - `e2e-stable` ("e2e (stable Chrome, ubuntu)"): the runner's
    auto-updating `/usr/bin/google-chrome`, 10 min timeout, on every PR and
    push; not in `release.needs`, so it reports in the step summary and the
    PR checks and never blocks. It exposes the browser version as a job
    output.
  - `e2e-stable-issue`: `needs: e2e-stable`, runs only when it failed on a
    push to `main`. It is the only job with `permissions: issues: write`
    (the workflow default stays `contents: read`), so none of the code under
    test runs with that token. It looks for an open issue titled
    "e2e: stable Chrome leg failing on main" and comments on it, or creates
    it, with the run URL, the Chrome version and the commit.
  Each e2e job sets `E2E_LEG`; `run.mjs` writes the browser record to
  `packages/e2e/build/e2e-result.json` and appends it to the step summary
  under that title, and the job uploads it as the `e2e-result-chrome-118` or
  `e2e-result-chrome-stable` artifact. Whether Chrome for Testing 118 honours
  `--load-extension` (`lib.mjs` `launchChrome`; P4 of the first audit) is now
  observed by every run of the `e2e` job.

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

Section 5: compile-time lib restriction, the purity check of slices 5b-2 to
17, and `architecture.test.ts` (imports, layers with `ports` at the bottom,
cycles) for core; `fitness.test.ts` for `chrome` confinement in the worker
zone (the UI zone listed apart), logic-free adapters with a defined decision
count, no tool `case` in `background.ts`, wake listeners registered at top
level by the composition root, `BRIDGE_PORT` uniqueness and the line budget; `sync-core.mjs --check` for the generated server copy; the port
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
reports without blocking, and a failure on a push to `main` opens or updates
one tracking issue (7(a)). Built by slice 0, in place since 1.3.3.

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
   zero calls fails the job). Since 1.4.23 the check
   (`packages/e2e/src/adapter-coverage.mjs`) parses each adapter's part of
   the bundle and lists its functions statically, so a method that V8 never
   compiled (an object built at module load, before coverage starts) fails
   it too;
2. adapters stay free of logic (fitness test, 5.3 item 3);
3. the contract suite also runs against an in-memory fake of every port
   (5.3 item 5).

The three conditions are **cumulative** (N6): slice 9 is the first gate, for
the adapters that exist then (`CdpSession`, `PageInfo`, `system-clock`), and
from slice 9 on the coverage check runs in every PR, so each later slice that
adds an adapter (16: `ContentSettings`, `Downloads`; 17: the two stores; 19:
`chrome-alarms`, `web-socket`; 21: `chrome-windows`, `chrome-runtime`,
`chrome-tab-events`) merges only with all its methods reached. Some of them
no e2e call reaches, for example `Alarms.onFire` (called at module load,
before coverage starts) and `Alarms.set` (only after an involuntary close),
both reached by the in-worker contract run since slice 19 (revision 12), and
`Windows.focus` (needs an already open Activity or Admin window), reached by
the e2e window case and the in-worker contract run since slice 21. Each such
method gets either a new e2e case in the slice that adds the adapter, or the
in-worker contract entry of the primary path above
(`packages/extension/contract/`: `entry.ts` and the contracts, built by
`contract/build.mjs`, run by the e2e before the coverage check, which
credits a shipped function whose contract-bundle counterpart was called);
it is never exempted
silently: if neither is possible, the PR lists the method with its reason
and arch decides, as with the logic-free exemptions (5.3 item 3).

### Risks

**R1. MV3 service-worker lifetime.** The worker can be stopped while idle;
today's design already survives it (flow records in `chrome.storage.session`,
reconnect state, `recoverDetachedFlows`). Moving code must not move any
startup work behind an `await` that delays listener registration: Chrome only
delivers wake-up events to listeners registered synchronously in the first
turn. The composition root registers all wake listeners synchronously at top
level, and `fitness.test.ts` checks it for each wake event, whether it is
subscribed with `chrome.*.addListener` or, after slices 19-21, through an
adapter's `on*` method (5.3 item 3); transient per-operation listeners are
outside that rule. ("Every `addListener` in `background.ts` is top-level",
revision 2's wording, was RED at `5ce3055`, where four transient
`addListener` calls sit inside functions, and would have become vacuous once
the adapters own the calls.)

**R2. Module service worker constraints.** `manifest.json` declares
`"type": "module"`. A module service worker cannot use dynamic `import()` or
top-level `await`; `architecture.test.ts` rejects `import(` in core and slice
4's smoke check rejects top-level `await` in the bundle.

**R3. Chrome 118.** The minimum stays 118 (`manifest.json`
`minimum_chrome_version`). esbuild `target: 'chrome118'` lowers any newer
syntax. Download attribution relies on `Page.downloadWillBegin`; slice 0 made
the `e2e` job run the download cases on 118, and if they fail there the fix
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
added to its `files`. Each moving slice removes its modules from `files`, and
slice 17 deletes the file once the last one (`flow-registry.ts`) lives in
core, where core's own `tsc` takes over; the modules 5b-2 creates
(`utf8.ts`, `flow-limits.ts`, `idle-rules.ts`) are born in core and never on
the list (5.1).

### Open questions

None blocking. Wall times (6.3) and P3/P4 (Chrome 118 behavior) are recorded
by slice 0's jobs (running since 1.3.3) and slice 3, and reported at
checkpoint A.
