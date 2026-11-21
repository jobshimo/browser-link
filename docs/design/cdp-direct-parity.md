# cdp-direct parity with the extension

Status: revision 1 (2026-11-19), for arch's audit before any code. Written at
`main` `9191c79` (release 1.4.34); every `path:line` below is at that commit.
No code, test or other document is changed by this file. The owner decided
on 2026-11-19 that the program starts; two of its decisions are still his
(section 5). Revision 6 (2026-11-21, release 1.4.48) records the owner's G10
answer and G10 as built. Revision 5 (2026-11-21, release 1.4.45) records gate A's answer
and P5 (G5-G8) as built. Revision 4 (2026-11-20, release 1.4.41) records experiment X3
and P7's G11 as built. Revision 3 (2026-11-20, release 1.4.39) records P3 as built.
Revision 2 (2026-11-20, P3's refactor PR, release 1.4.38) records
experiment X1 and the dialog-intake move; the files it names are at that
release, every other citation stays at `9191c79`. Revisions:

| # | Date | Change |
|---|---|---|
| 1 | 2026-11-19 | The program, for arch's audit. |
| 2 | 2026-11-20 | Experiment X1 ran (lab `packages/plan/lab/2026-11-20-cdp-direct-dialogs/`, Chrome for Testing 118.0.5993.70 and stable 157, headless, same answers on both). Measured: a dialog opened while no cdp-direct connection to the page exists cannot be seen or answered over cdp-direct. A connection dialed with the dialog already open never finishes `Page.enable` (15 s command timeout), receives no `Page.javascriptDialogOpening` (nothing is replayed), and its `Page.handleJavaScriptDialog` fails with `No dialog is showing`, with or without `Page.enable`. Only a connection whose `Page.enable` completed before the dialog opened receives the opening event and can answer it; answering leaves the connection open and the waiting click returns. The P3 caveat (step "Caveat kept in the docs") and the risk rows (section 8) are reworded to this. Lab note: the lab's `late` connection is the lab client mirroring dial (`Target.getTargetInfo`, then `Page.enable`), not `dial()` itself; the server's own lazy dial was observed only through its tool answers (the `preopen-*` cases: the first call fails on `Page.enable` after 15 s). P3's refactor PR also moves the dialog half of the intake to core (step 3.4) and settles step 3.5 for dialogs. |
| 3 | 2026-11-20 | P3 done (release 1.4.39): see P3 "As built", including the correction that the click result carries no `dialog` field, the named `Page.enable` error, and the click move now bounded by the dialog watch (declared after an independent verification). |
| 5 | 2026-11-21 | Gate A answered and P5 done in one PR (release 1.4.45, G5-G8): see P5 "As built" and 5.1 "Answer". |
| 6 | 2026-11-21 | G10 answered (option a: a temporary override that says so) and done (release 1.4.48): see P7 "G10 as built" and section 5's G10 entry. |
| 4 | 2026-11-20 | Experiment X3 ran (lab `packages/plan/lab/2026-11-20-cdp-direct-browser-socket/`, Chrome for Testing 118.0.5993.70 and stable 157, headless only; the owner's headed browser is untested). `Target.targetCreated` on the browser socket carries `openerId` for `window.open` from a click or a script and for `target=_blank` links (with or without `noopener`) on both; its url is empty and arrives in the next `Target.targetInfoChanged`; `/json/list` has no opener field. A permission override lives as long as the DevTools session that set it, and when a session that set one closes, every override of that browser context is cleared (per browser context, not browser-wide), other clients' included; `Browser.setPermission` also works on a page socket. Browser-context ids differ: Chrome 118 does not list the default context's id and refuses it, 157 accepts it. P7's G11 done (release 1.4.41), see P7 "G11 as built": a per-call browser socket that sends only `Target.setDiscoverTargets`, and `tab-created` through a sink keyed by the new `cdp:` id. The risk rows (section 8) on permissions and footprint are reworded to X3. |

Marks used: **verified** (read in code at `9191c79` or pinned by a test),
**likely** (follows from code, not run), **experiment** (needs a Chrome run;
section 6), **assumption** (this design's choice, open to arch).

## 1. Goal and non-goals

Goal: every tool works over cdp-direct as it does over the extension, before
the plans layer (v5) starts. Each missing capability is added the way the
service-worker program added the extension's: a registry requirement in
`CDP_DIRECT_PROVIDES`, an input-only port or a read-only watch, one authored
body in core shared by both transports, a real-Chrome contract for every new
cdp adapter, and an e2e `.cdp` case that fails first.

Non-goals (by design, they stay as they are): recording flows by
demonstration (popup-only); the popup Stop button (`browser-link cdp revoke`
replaces it); the popup, Activity and Admin windows; extension version-skew
fields; persistence of detached-flow manifests across a restart (cdp-direct is
per-process); the `worker-terminated` stop reason. Also not a goal: making
cdp-direct dial or script tabs it is not asked to drive, except where an owner
decision says so (G12).

## 2. The gaps

`EXTENSION_PROVIDES` (`packages/extension/src/app/connect.ts:48`) minus
`CDP_DIRECT_PROVIDES` (`packages/server/src/cdp/support.ts:36`) is `drag`,
`capture-buffers`, `canvas`, `response-bodies`, `dialog-input`, `downloads`,
`content-settings` (**verified**). The reverse difference is `flow-cancel`
(**verified**, revision 11 of the service-worker design). Difficulty: S a
provides entry and its tests, M new cdp-side state or adapter, L a decision or
experiment first.

| # | Gap | Today on cdp-direct | Missing piece, in core terms | Diff. | Risk | Mark |
|---|---|---|---|---|---|---|
| G1 | `drag`, flow drag step | refusal text (`support.ts:81`); flow step bound to a refusal (`transport.ts:363`) | `drag` in provides; flow `performDrag` bound to core `performDrag` | S | Low | verified |
| G2 | `canvas_screenshot` | refusal text | `canvas` in provides (handler uses the evaluator only, `core/src/tools/page-read.ts:207`) | S | Low | verified |
| G3 | `dialog_respond` | refusal text, although `actionDeps` builds `driver.dialog` | `dialog-input` in provides (`dialog-permission.ts:44`) | S | Low alone | verified |
| G4 | dialog tracking | no `DialogWatch` (`transport.ts:209`), so a dialog-opening click is awaited, not raced | pending-dialog state fed by `Page.javascriptDialogOpening/Closed`, given as `dialogs`; `dialog-*` events | M | Medium (stranded tab) | code verified; failure text **experiment** |
| G5 | `console` | refusal text | `capture-buffers` + a `CaptureWatch` fed by `Runtime.consoleAPICalled`, `Log.entryAdded`; `Log.enable` | M | Medium | verified |
| G6 | `network` | refusal text | same watch fed by `Network.*`; `Network.enable` | M | Medium | verified |
| G7 | `network_body` | refusal text | `response-bodies` (port exists, `page-read.ts:261`) with G6 | S after G6 | Low | verified |
| G8 | `wait_for` `network_url` | its own refusal text (`core/src/actions/perform-wait-for.ts:44`) | G6's `finishedUrls()` (`perform-wait-for.ts:155`) | S after G6 | Low | verified |
| G9 | `download` selector mode, `download_settle` | refusal; `url` mode works (rides `evaluate`) | a cdp `Downloads` adapter; no CDP primitive for D17's hold-then-settle | L | High | code verified; CDP side **experiment** |
| G10 | `set_permission` | refusal text | a cdp `ContentSettings` adapter on the tab's page connection (done in P7, 1.4.48) | L | Medium | measured by X3 and on stable |
| G11 | `wait_for_tab` | refused in the dispatcher (`browser-dispatch.ts:3034-3043`), declared `false` (`support.ts:50`) | opener-to-new-target signal, `tab-created` for `cdp:` tabs (done in P7, 1.4.41) | M | Medium | code verified; `openerId` measured by X3 |
| G12 | `build`, `view_sig` in `list_tabs` | absent (README line 2670) | the observer's `doc_info` reaching `listCdpTargets` | M | Medium (footprint) | verified |
| G13 | idle and claim model | fixed 5 min socket sweep (`transport.ts:79`), no call hold | an owner decision superseding Q4 | L | Medium | verified |
| G14 | foreground flow registry | `start` registers detached flows only (`cdp/flow-control.ts:39`) | register foreground runs (done in P4, 1.4.40) | M | Low | not agent-visible; internal parity only |
| G15 | per-transport coercion | done in P2 (1.4.37): the five entries (`find`, `click`, `type`, `navigate`, `evaluate`) share the extension's coercion | one `coerce` per entry | S | Low, agent-visible | reachable over the wire (verified) |
| G16 | bridge events | only `flow-finished` (`server.ts:420`), claim and `download-*` | `dialog-*` (G4) and `tab-created` (G11) | M | Low | verified |

G16 residue (**assumption**): `tab-navigated`, `tab-renamed`,
`tab-registered` and `tab-disconnected` stay extension-only; `list_tabs` reads
title and URL live, and a `cdp:` tab is never registered or disconnected. The
docs will say so. Arch confirms or asks the owner.

## 3. Shape shared by every slice

1. **Provides first.** A capability becomes visible on cdp-direct only by an
   entry in `CDP_DIRECT_PROVIDES`. `CDP_TOOL_SUPPORT` stays derived
   (`support.ts`, `cdpToolSupport` in `core/src/tools/registry.ts:78-90`);
   each entry flips `provides.test.ts` (which pins the set and the refusal
   texts) and the `support.test.ts` snapshot in the same PR.
2. **Ports are input only.** A new port reports nothing the transport observes
   on its own; a command's answer to the core's own request is allowed
   (revisions 8 and 9). Value types go in `core/src/ports/values.ts` with only
   the fields core uses.
3. **Observed state is a watch.** Dialog and capture state reach core through
   `DialogWatch` and `CaptureWatch` (`core/src/session/page-driver.ts:110,148`),
   outside `ports/`.
4. **Intake shared, never copied.** The CDP-event-to-state mapping lives in the
   extension's `debuggerIntake` (`extension/src/app/tab-connection.ts:247-342`:
   console, log, network, dialog, and the recorder's binding). Its
   console/network/dialog part moves to core `session/` as one authored body
   that both transports subscribe to (core already has the port it needs:
   `CdpSession.onEvent`, `core/src/ports/cdp-session.ts:8`). The recorder part
   stays in the extension. The buffer and pending-dialog part of `TabSession`
   (`core/src/session/tab-session.ts`: `pushConsole`, `networkEntry`,
   `dialogOpened`, `dialogClosed`, the 200-entry bounds at lines 24-26) splits
   into a smaller core object (working name `PageBuffers`, **assumption**)
   that `TabSession` composes and cdp-direct holds per target, since
   `TabSession` needs a driver and its idle rules (Q4). Closed for dialogs in
   P3's refactor PR (revision 2): the pending dialog is `PendingDialog`
   (`core/src/session/dialog-intake.ts`), a holder of at most one
   `PendingDialogInfo` that is itself a `DialogWatch`; `TabSession` composes
   one (`session.dialog`) and keeps `pendingDialog`, `dialogOpened` and
   `dialogClosed` as delegating members, and cdp-direct will hold one per
   target. The intake's dialog half is `dialogIntake(pending, sink)`, a CDP
   event listener the extension's `debuggerIntake` calls and cdp-direct will
   subscribe with `CdpSession.onEvent`. Dialogs do not use the name
   `PageBuffers`: the buffers are P5's. P5 does the same for console and
   network (`pushConsole`, `networkEntry` and the 200-entry bounds into a
   core buffers holder that `TabSession` composes, and the console/network
   half of the intake beside `dialogIntake`), and settles that holder's name
   then. Closed for console and network in P5's refactor PR: the holder is
   `CaptureBuffers` (`core/src/session/capture-intake.ts`, with
   `CONSOLE_BUFFER_MAX` and `NETWORK_BUFFER_MAX`), itself a
   `CaptureWatch` and built with only a clock; `TabSession` composes one
   (`session.capture`), keeps `consoleBuffer`, `networkBuffer`,
   `networkOrder`, `pushConsole` and `networkEntry` as delegating members,
   and `sessionCaptureWatch` answers it. The intake's console/network half is
   `captureIntake(buffers, clock)`, a CDP event listener with no sink (it
   sends nothing toward the server) that the extension's `debuggerIntake`
   calls. Each move is a
   **refactor PR of its own**, before the behavior PR that uses it (7(e)):
   e2e differential empty, title `refactor(core): ...`.
5. **Events out.** `EventsOut.emit(tabId: number, event)`
   (`core/src/ports/events-out.ts`) takes a numeric Chrome tab id; `cdp:` tab
   ids are strings. Open point for arch (not the owner): widen the tab key of
   `EventsOut` (a contract change in the refactor PR) or give the core intake a
   tab-bound emitter. cdp-direct's adapter writes into `BridgeEventLog`, the
   sink `server.ts:420` already installs for `flow-finished`, and gets the
   `events-out.contract.ts` suite.
   Arch's answer, applied in P3's refactor PR (revision 2): the extension's
   dialog intake never used `EventsOut` (it sends on its own connection), so
   the shared intake takes a narrow sink bound to its connection,
   `DialogEventSink` (`emit(event: BridgeEventPayload): void`, no tab key,
   in `session/dialog-intake.ts`, not a port), built by each transport: the
   extension's over `sendBridgeEvent`, cdp-direct's (in P3's behaviour PR)
   over `BridgeEventLog`. `EventsOut` stays as it is, for flow events. The
   bound form is not the general answer: P7's `tab-created` is raised for a
   target cdp-direct never dialed (from the browser-level socket), so it
   needs a sink keyed by the new `cdp:` id; P7 decides it.
6. **Fitness.** No tool `case`, no tool-name comparison and no `perform*`
   declaration in `cdp/transport.ts` (`cdp/tool-name.fitness.test.ts:153-171`);
   no raw `Runtime.evaluate` (`cdp/raw-evaluate.fitness.test.ts`). Bindings to
   imported core `perform*` are allowed (as for `performClick` today).
7. **Behavior PR form.** Each slice PR: the `.cdp` case(s) that fail today
   first (RED commit), then the change; label `behavior-change`, a line
   `Expected difference: ...` (`scripts/behavior-change-check.mjs`, ci.yml
   lines 269-300); never a `refactor:` title. New `.cdp` cases go into
   `packages/e2e/src/tool-cases.mjs`, run in `cdpDirectChecks`
   (`packages/e2e/src/run.mjs:811`), and so into `e2e-diff`.
8. **Real-Chrome contract.** Every new cdp adapter gets its contract in
   `packages/server/src/cdp/adapters/contract.chrome.test.ts`. Correction to the
   inventory: that file runs only in the `e2e` job on Chrome 118 (ci.yml
   lines 146-150), not on stable (**verified**). Stable coverage of cdp-direct
   comes from `e2e-stable` running `cdpDirectChecks`, which reports without
   blocking.

## 4. Slices, in order

Each slice is one behavior PR, preceded by a refactor PR only where step 3.4
moves shared code. Case names are as they would appear in `tool-cases.mjs`.

### P1. G2 canvas and G1 drag (S)

- **Shape.** `canvas` and `drag` into `CDP_DIRECT_PROVIDES`. In
  `buildCdpFlowDeps` (`transport.ts:339`), `performDrag` binds core
  `performDrag` with the connection's page driver, as the extension's flow
  steps do. No new port: `DragInput` and `CdpEvents` already exist on
  cdp-direct and pass `contract.chrome.test.ts:240,264` (Chrome 118).
- **RED first.** `browser.canvas_screenshot.cdp`,
  `browser.canvas_screenshot.region.cdp`, `browser.drag.cdp`,
  `browser.flow.drag-step.cdp`.
- **Tests that flip.** `provides.test.ts` (drag and canvas refusal cases, the
  set), `support.test.ts` snapshot, `transport.test.ts` flow drag step
  (**assumption**: the case exists as the inventory says; not opened).
- **Statements.** `browser-definitions.ts:117` (refused list) and `:1390`
  (drag step); manual topic `cdp-direct` (`manual/topics.ts:137-140`); README
  v1 support table and intro (2682-2694), README 520-531 (`.cdp` list), README
  2727-2729 (v2 list: canvas, drag); headers of `cdp/support.ts`,
  `cdp/provides.test.ts`, `buildCdpFlowDeps` comment (`transport.ts:359-362`),
  `browser-dispatch.ts:1353-1357`, `core/src/tools/drag.ts` header.
- **Expected difference:** `browser.drag`, `browser.canvas_screenshot` and a
  flow drag step on a `cdp:` tab run instead of answering "not supported over
  cdp-direct in v1"; extension cases unchanged.

### P2. G15 coercion (S) — done, release 1.4.37

- **Shape.** Each of the five entries has one `coerce`, the extension's
  `String(x)` (owner decision of 2026-11-20, "unificamos si es mejor": the
  extension is the reference transport).
- **Reachable.** Nothing between the MCP client and `callCdpTool` validates
  the arguments: the server registers raw `setRequestHandler` handlers (no
  input-schema validation) and the dispatcher passes the arguments on. A
  `transport.test.ts` case and two `.cdp` e2e cases (`error.coerce.cdp`,
  `browser.evaluate.coerce.cdp`) send non-string arguments to a `cdp:` tab.
- **Expected difference:** a missing or non-string argument on a `cdp:` tab
  answers as on an extension tab; `browser.type` with neither `selector` nor
  `ref` no longer types into the focused element on a `cdp:` tab.

### P3. G4 dialog tracking and G3 `dialog_respond` (M) — done, release 1.4.39

- **Before code:** experiment X1 (section 6).
- **Refactor PR first.** Dialog half of the intake and the pending-dialog
  state move to core (step 3.4); `sessionDialogWatch` reads the moved state.
  Differential empty. Done in release 1.4.38 (revision 2): `dialogIntake`,
  `PendingDialog` and `DialogEventSink` in `core/src/session/dialog-intake.ts`;
  nothing wired into cdp-direct.
- **Shape.** On dial (`transport.ts:149-201`), cdp-direct creates the target's
  pending-dialog state, subscribes the core intake to the connection, and
  passes a `DialogWatch` as `dialogs` to `createPageDriver` (today
  `newPageDriver`, `transport.ts:209`, passes none). Core's
  `dispatchMouseEvents` then races each mouse event against `isOpen()`
  (`page-driver.ts:193-220`) and the click result carries `dialog: true`.
  `dialog-input` into provides. `dialog-opening` / `dialog-closed` go to
  `BridgeEventLog` through the cdp `EventsOut` adapter (step 3.5).
  `dialog_respond` already passes the claim guard as a kill switch.
- **Caveat kept in the docs.** The connection is dialed lazily, so a dialog
  opened while no cdp-direct connection to the page exists (before the first
  call, or after the sweep closed the socket) cannot be seen or answered over
  cdp-direct: a connection dialed with it open never finishes `Page.enable`
  (15 s timeout, every call on the tab), gets no opening event (nothing is
  replayed), and `Page.handleJavaScriptDialog` fails with `No dialog is
  showing`. Only a connection whose `Page.enable` completed before the dialog
  opened receives `Page.javascriptDialogOpening` and can answer it
  (**verified**, X1, Chrome 118 and 157; revision 2). Such a tab must be
  answered by the user or another client; `dialog_respond` cannot offer it.
  As built (1.4.39, arch's decision): the dial's `Page.enable` timeout
  (`CdpCommandTimeoutError`, a typed timeout of `CdpClient`, never matched
  by text) becomes `PageEnableTimeoutError`, whose text does not claim a
  dialog (a hung renderer gives the same timeout): "cdp-direct: the page did
  not answer Page.enable within 15 s; a JavaScript dialog opened while
  cdp-direct had no connection may be blocking it, or the page is
  unresponsive; close any dialog in the browser and retry." A failed
  `Page.enable` now closes its socket. README and manual state the limit in
  one line.
- **RED first.** `browser.click.opens-dialog.cdp` (click answers
  `dialog: true`, `dialog_respond` closes it, the tab answers `evaluate`
  after), and a `browser.events` check for `dialog-opening` on the cdp tab.
- **Tests that flip.** `provides.test.ts` (`dialog_respond` refusal),
  `support.test.ts`; `transport.test.ts` dial cases gain the watch.
- **Statements.** `browser-definitions.ts:117`; manual `cdp-direct`; README
  support table and the intro's "the popup's dialog channel"; service-worker
  design revision 8 rows 1-2 and 4, revision 10 row 1 (section 8 below).
- **As built (1.4.39).** `cdp/adapters/cdp-dialog-watch.ts`
  (`createCdpDialogWatch`) builds the connection's `PendingDialog` and
  subscribes `dialogIntake` through `CdpSession.onEvent`, before the dial's
  `Page.enable` (frames are delivered in order, so an opening right behind
  the `Page.enable` answer cannot slip past); the page driver and the tool
  deps get it as `dialogs`. The sink is bound to the connection's `cdp:` id
  and adds the event, with `tab_id`, to `BridgeEventLog` through
  `setCdpBridgeEventSink`, installed by `server.ts` as the flow sink is (only
  the kinds an extension may push). Correction to the shape above: the click
  result has no `dialog` field on either transport; a click that opened a
  dialog answers `hit_check: "not_verifiable"` with the dialog note
  (`HIT_CHECK_DIALOG_NOTE`), which the RED case asserts exactly. The
  `browser.events` check is a unit test (`transport.test.ts`), not an e2e
  case: `browser.events` is exempt from the e2e tool table (server only).
  The real-Chrome contract runs `defineDialogWatchContract`
  (`core/src/session/dialog-watch.contract.ts`) on `createCdpDialogWatch`
  (Chrome 118 and 157 locally); `error.dialog-before-dial.cdp` pins the
  named error.
  Also a difference, declared after independent verification: with a watch,
  core's `dispatchWatchedMove` (`session/page-driver.ts`) dispatches the
  click's move through `dispatchMouseEvents` instead of racing it against
  the remaining `HIT_CHECK_TIMEOUT_MS` budget (`actions/click-landing.ts`
  `moveOntoTarget`). So on a `cdp:` tab a move whose
  `Input.dispatchMouseEvent` fails (connection closed, any CDP error) now
  fails the whole click with that error, where before it was `unanswered`
  and the click failed with `miss: no-answer` and no press sent; and a slow
  move on a busy page waits up to the client's 15 s command timeout instead
  of the budget. This is the extension's behaviour (parity).
- **Expected difference:** on a `cdp:` tab a click that opens a JavaScript
  dialog answers `hit_check: "not_verifiable"` with the dialog note instead
  of waiting for the command timeout;
  `browser.dialog_respond` works; `browser.events` shows `dialog-opening` and
  `dialog-closed` for `cdp:` tabs; a dialog open before the dial answers the
  named `Page.enable` error.

### P4. G14 foreground flow registry (M) — done, release 1.4.40, internal parity

- **Done, internal parity.** The foreground flag assumption is closed: `RunningFlow` carries `detached`, and the one-detached-per-tab rule, the 30-minute ceiling, the finished records and the `flow-finished` event apply to detached runs only; a foreground run is dropped when it ends, so its id answers `unknown` as on the extension. **Finding: not agent-visible; internal parity only.** A running foreground flow has no id an agent can name over MCP on either transport: `browser-dispatch` mints the `flow_id` and returns it only with the result, the activity trail is written after the call settles, and no event, `list_tabs` field or activity row names a running flow. So `flow_status` and `flow_cancel` on a running foreground flow cannot be called, there is no wire difference and no e2e case or expected label, and the PR is not a behaviour change. The proof is `cdp/detached-flows.test.ts` and `cdp/flow-control.test.ts` (service-worker design revision 19).

- **Shape.** `createCdpFlowControl.start` registers foreground runs in
  `cdp/detached-flows.ts` with `onProgress`, keeps the gate re-check and
  connection hold it has today, and `status`/`cancel` find them. The registry
  module may need a foreground/detached flag so the one-detached-per-tab rule
  and the 30-minute ceiling apply to detached runs only (**assumption**).
  Adopting `FlowRun`/`FlowRegistry` instead touches Q4 and is left to gate A.
- **RED first.** Unit tests only (see Done): the two e2e cases the plan named cannot be written.
- **Statements.** README 2701-2717 ("behave identically" holds for foreground
  flows too); manual topic `flows` (`manual/topics.ts:79`) if it mentions it.
- **Expected difference:** none on the wire (not agent-visible; internal parity only).

### Gate A. G13, the idle and connection model (owner, section 5.1)

Asked before P5, because capture buffers (and P3's dialog state) are lost at
every idle close today.

### P5. G5-G8 capture (M), one PR or two

- **Before code:** experiment X2 (section 6); gate A answered.
- **Refactor PR first.** Console/log/network half of the intake and the
  buffers move to core (step 3.4); `sessionCaptureWatch` (`tab-session.ts:185`)
  reads the moved buffers.
- **Shape.** On dial, `Log.enable` and `Network.enable` (today only
  `Page.enable`, `transport.ts:189`, and `Runtime` through the observer,
  `:197`); the intake fills the target's buffers (same 200-entry bounds); a
  `CaptureWatch` over them is given as `captureBuffers` in `callCdpTool`'s deps
  (`transport.ts:431`); `capture-buffers` and `response-bodies` into provides
  (`ResponseBodies` already passes `contract.chrome.test.ts:373`). Buffer
  lifetime follows gate A.
- **Split if over ~400 lines:** P5a console and network (G5, G6); P5b
  `network_body` and `wait_for` `network_url` (G7, G8).
- **RED first.** `browser.console.cdp`, `browser.console.error.cdp`,
  `browser.console.warn.cdp`, `browser.network.cdp`,
  `browser.network_body.cdp`, `browser.wait_for.network.cdp`.
  `error.wait-for-network.cdp` (asserts the refusal text) is removed in the
  same PR, replaced by `browser.wait_for.network.cdp`.
- **Tests that flip.** `provides.test.ts` (console, network, network_body
  refusals and the network_url case at line 94), `support.test.ts`, core
  `perform-wait-for` tests of the refusal text if the text is deleted (it is
  still reached by a transport without `capture-buffers`, so it may stay).
- **Statements.** `browser-definitions.ts:117`; manual `cdp-direct`; README
  support table, its `wait_for*` footnote, 2727-2729; service-worker design
  3.3 text at line 988 ("`network_body` ... v1 scope"), 7(e) and the program
  follow-ups list.
- **Expected difference:** `browser.console`, `browser.network`,
  `browser.network_body` and `wait_for` `network_url` work on `cdp:` tabs,
  for events after the tab's first call (section 5.1 decides what happens at
  an idle close).

**As built (release 1.4.45, one PR, G5-G8).**

- The dial subscribes core's `captureIntake` into one `CaptureBuffers` per
  connection (`cdp/adapters/cdp-capture-watch.ts`, beside the dialog watch)
  before `Page.enable`, then sends `Page.enable`, `Log.enable`,
  `Network.enable`, and the observer's `Runtime.enable`. Subscribing first
  keeps the replay Chrome sends after `Log.enable` and `Runtime.enable`
  (X2). A failed `Log.enable` or `Network.enable` closes the socket and
  fails the dial, as `Page.enable` does.
- `actionDeps` gives the buffers as `captureBuffers`, so `console`,
  `network`, a `network_url` wait (standalone and as a flow step) read them;
  `network_body` uses the page driver's `ResponseBodies` over the same
  connection. `capture-buffers` and `response-bodies` are in
  `CDP_DIRECT_PROVIDES`.
- Buffers are raw: headers, post data and response headers, no redaction,
  and no per-tab consent on `cdp:` tabs (owner decision 2026-11-19: "esto es
  una herramienta de desarrollo y esa limitacion sobra"). The grant stays
  the only consent.
- No redial duplicates: the buffers live and die with the connection. A kept
  connection is never re-enabled; a new dial starts with empty buffers that
  its own replay fills once, so a redial never holds an entry twice
  (`transport.test.ts`, "a redial does not duplicate").
- `network_body` answers only for requests the current connection saw (X2:
  after a close the body is gone, `No resource with given identifier found`).
- The sweep follows gate A's answer (5.1). The real-Chrome contract is
  `session/capture-watch.contract.ts`, run in core and in
  `contract.chrome.test.ts`.
- e2e: `browser.console.cdp`, `browser.console.error.cdp`,
  `browser.console.warn.cdp`, `browser.network.cdp`,
  `browser.network_body.cdp`, `browser.wait_for.network.cdp`;
  `error.wait-for-network.cdp` removed.

### P6. G12 `build` and `view_sig` (M), after the owner picks the footprint

- **Shape (option a).** `driver.install` gets `onTopDocument`
  (`transport.ts:197`); `listCdpTargets` (`cdp/targets.ts`) adds `build` and
  `view_sig` for targets with a live connection. **(option b)** a one-off
  evaluation of the two pure DOM functions of `core/src/inpage/observer.ts`
  on every listed target at `list_tabs` time.
- **RED first.** `browser.list_tabs.build.cdp` (a driven `cdp:` tab lists
  `build` and `view_sig`).
- **Statements.** README 2662-2677 ("One thing is missing"); manual
  `cdp-direct` (`topics.ts:138`).
- **Expected difference:** (a) a `cdp:` tab this server has driven lists
  `build` and `view_sig`; (b) every `cdp:` tab does.
- **As built (release 1.4.46, option a, the owner's decision).** `driver.install`
  gets `onTopDocument` (`cdp/transport.ts`, `noteTopDocument`): a `doc_info`
  of the top document is kept per connection and a new `doc_start` drops it.
  `withCdpFootprint` adds `build` and `view_sig` to the listed `cdp:` tabs that
  have a connection in the cache and have reported; `server.ts` wires it
  behind `listCdpTargets`. `list_tabs` never dials and never runs script. A tab
  without a connection lists as before and the map start pack falls back to
  origin and path. The learner reads the same listing, so it records both for
  a connected tab. The G12 row of the gap table is closed by this.

### P7. Browser-level socket, G11 `wait_for_tab`, then G10 `set_permission`

- **G11 as built (release 1.4.41).** `cdp/opened-tabs.ts`. Decisions:
  - **Socket lifetime: per call.** `browser.wait_for_tab` with a `cdp:`
    `opened_from` opens one browser-level socket (the `webSocketDebuggerUrl`
    of `/json/version`; only its `/devtools/browser/<id>` path is taken and
    rebuilt on `127.0.0.1` and the sanitized port, `cdp/targets.ts`
    `browserSocketUrl`) after the gate, and closes it on every way the call
    ends: a match, the timeout, a watch that fails to start (it closes its
    own socket), and a watch that starts after the wait already settled. It
    is never cached, so the 5-minute sweep and gate A do not apply to it.
    The dispatcher has no per-call cancel; the 60 s cap bounds the socket.
  - **Discovery only.** The socket sends `Target.setDiscoverTargets
    {discover: true}` and nothing else (`BROWSER_SOCKET_COMMANDS`, pinned by
    a unit test): no `Browser.setPermission` or `grantPermissions`, so
    closing it cannot clear another client's permission overrides (X3: only
    a session that set an override clears its browser context's overrides
    on close).
  - **Filter.** Discovery sees every target of the instance, the user's own
    tabs included. A target is reported only when it is a drivable page
    (`isDrivablePageTarget`), its `openerId` is the waiting tab's target
    id, its url (from `targetInfoChanged`, or from the discovery listing
    for a page that already existed) is not empty, the opener is itself
    listed as a drivable page, and the gate (enabled + live grant) is open
    when it is reported. Everything else is ignored.
  - **Sink.** `CdpTabCreatedSink`, `(tabId: string, data: { opened_from,
    url }) => void`, keyed by the new `cdp:<targetId>` (the
    connection-bound `DialogEventSink` cannot fit a target never dialed),
    in `cdp/opened-tabs.ts`, not a port; `server.ts` installs it
    (`setCdpTabCreatedSink`) over `BridgeEventLog` as
    `tab-created { opened_from, url, tab_id }`, the extension's payload once
    the bridge adds `tab_id`. The dispatcher's existing listener matches and
    auto-claims it, so the answer has the extension's shape.
  - **A page opened before the call** (arch's ruling on review, replacing
    "any already-open child counts"). Discovery lists the existing targets
    before it answers `Target.setDiscoverTargets`; the watch buffers those
    events and classifies them on the answer's frame (`CdpClient.send`'s
    synchronous `onAnswer`, so an event right behind the answer in the same
    chunk is live; pinned by a unit test on a real `CdpClient` and by the
    `stale` e2e case). A page of that first listing the opener opened is
    returned only when the opener ran an action through the dispatcher
    within the extension's replay window (`REPLAY_WITHIN_MS`, 1.5 s) before
    the wait started, or during it: `runAction` notes the start and end of
    every action tool per tab (`tools/tab-actions.ts`); it fits there
    cleanly, since every action tool goes through it. Several such pages
    (after the `url_substring`) are an error naming them, sorted by url,
    never a pick by Chrome's listing order; every other page of the listing
    is ignored for the whole watch. Pages created after the listing count as
    they come. Remaining difference, stated in the tool text, the manual and
    the README: the extension measures the 1.5 s from the `tab-created`
    event, this from the opener's last action.
  - **Returned, not announced.** A tab counts as already returned only when a
    wait matched it (the dispatcher calls `markOpenedTabReturned` on a
    match; a bounded set of 256 ids); one announced to a wait whose
    `url_substring` did not match stays visible to later waits.
  - **Allowlist at the socket.** `openBrowserSocket` wraps the client in
    `guardBrowserSocket`, whose `send` refuses any command but
    `Target.setDiscoverTargets` without sending it.
  - **A dropped socket** ends the wait at once with
    `cdp-direct: the browser closed the browser-level DevTools connection browser.wait_for_tab was watching; no new tab can be seen on it. Retry the call.` (`CdpClient.onClose`), not with `reason: 'timeout'`.
  - Browser-context ids (118 vs 157) do not matter: discovery does not use
    them.
  - **Footprint.** X3 saw none on other tabs (no attach, no latency change),
    headless only.

- **G10 as built (release 1.4.48).** Owner decision of 2026-11-21, option a:
  `set_permission` works on `cdp:` tabs as a temporary override, and says so.
  - **Mechanism.** `cdp/adapters/cdp-content-settings.ts`
    (`createCdpContentSettings`), given as `content-settings` in
    `actionDeps` (`cdp/transport.ts`) over the tab's own page connection;
    `content-settings` joined `CDP_DIRECT_PROVIDES`. Each `set(setting,
    pattern, value)` core writes is one `Browser.setPermission
    { permission: { name }, setting, origin }` with no `browserContextId`
    (the default context, X3), never `Browser.grantPermissions` (it replaces
    the whole override set, X3). Never on the P7 discovery socket:
    `BROWSER_SOCKET_COMMANDS` is unchanged and still pinned.
  - **Names.** The extension's seven names, unchanged in core. The adapter maps
    the content setting core writes back to the descriptor Chrome takes:
    `location` to `geolocation`, `clipboard` to `clipboard-read` (the
    read-write permission `chrome.contentSettings.clipboard` holds, so both
    clipboard names act as on the extension), `sensors` to `accelerometer`
    (gyroscope follows it); `notifications`, `camera`, `microphone` as they
    are; `allow`/`block`/`ask` to `granted`/`denied`/`prompt`; the
    pattern's `/*` is dropped for the origin. Measured on headless stable
    (157): Chrome refuses `location`, `sensors` and `clipboardReadWrite` as
    descriptor names. A setting not mapped goes to Chrome unchanged.
  - **Data, not a tool name.** The `ContentSettings` port gained an optional
    `temporaryNote` (`core/src/ports/content-settings.ts`); only the cdp
    adapter gives it. With it, `setPermissionTool` adds `note` to its result
    and its unsupported-name error drops ` by chrome.contentSettings in MV3`:
    `set_permission: 'midi' is not supported. Supported names: geolocation,
    notifications, camera, microphone, clipboardReadWrite,
    clipboardSanitizedWrite, sensors.` The extension's adapter gives none, so
    its results and texts are unchanged.
  - **Lifetime.** The connection is not held for the override: the normal
    idle close (30 minutes, 5 when nothing was captured) closes it and the
    override goes with it; any DevTools client closing clears the overrides
    of that browser context (X3). The result's `note`, the tool text, the
    manual `cdp-direct` topic and the README say so.
  - **Contract.** `contract.chrome.test.ts` runs the `ContentSettings`
    contract on a real page connection, reading the state the page sees on
    `https://a.test` (served through `Fetch` on that connection). The state
    after the setting connection closes is not asserted (X3 measured it).
  - **e2e.** `browser.set_permission.cdp` (granted, denied, prompt, with the
    note), `browser.set_permission.read.cdp` (the page's
    `navigator.permissions` state after each) and
    `error.set_permission-name.cdp` on the cdp tab.

- **Before code:** experiment X3 (section 6); the G10 semantics question.
- **Shape.** One browser-level `CdpClient` to the `webSocketDebuggerUrl` of
  `/json/version` (already fetched, `cdp/targets.ts:78`), behind the same
  gate and loopback checks as page sockets, opened only while needed
  (**assumption**: lifetime follows gate A). G11: `Target.setDiscoverTargets`
  and `targetCreated` with `openerId` emit `tab-created { opened_from, url }`
  for the `cdp:` id into `BridgeEventLog`; the dispatcher refusal
  (`browser-dispatch.ts:3034-3043`) and the `CDP_DECLARED_SUPPORT` row go.
  G10: a cdp `ContentSettings` adapter mapping `set(setting, pattern, value)`
  to `Browser.setPermission`, with its real-Chrome contract; `content-settings`
  into provides.
- **Two PRs** (G11 builds the socket, G10 uses it).
- **RED first.** `browser.wait_for_tab.cdp` (a click on a `cdp:` tab opening a
  window answers the new `cdp:` id), `browser.set_permission.cdp`.
- **Statements.** `browser-definitions.ts:117` and `:794` (set_permission
  "Backed by `chrome.contentSettings`"); manual `cdp-direct`; README support
  table and intro ("native permission grants", "`window.open` tab-creation
  events"); `browser-dispatch.ts:3028-3033` comment; `support.ts` header;
  `core/src/tools/dialog-permission.ts` header (lines 9-10).
- **Expected difference:** `browser.wait_for_tab` with a `cdp:` opener answers
  the opened tab; `browser.set_permission` works on `cdp:` tabs with the
  semantics the owner picks.

### P8. G9 downloads, last (L)

- **Before code:** experiments E1-E5, then owner gate B (section 5.2).
- **Shape (whichever option).** A cdp `Downloads` adapter implementing
  `captureAround`/`settle` (`core/src/ports/downloads.ts`), its contract on real
  Chrome (`ports/contract/downloads.contract.ts` exists on the fake only),
  `downloads` into provides, a `download_settle` row derived (it is unlisted
  today, so `cdpToolSupport` skips it, `registry.ts:84`), and a server choice
  of `runDownload` path for `cdp:` tabs. Revert of any download behavior on
  socket close, crash and revoke is part of the slice, not a follow-up.
- **RED first.** `.cdp` twins of `browser.download.selector`, `.unrelated`,
  `.post`, `.one-time`, `.chunked`, `.gzip`, `.click-failed`.
- **Statements.** README 1822-1830 and 1955 ("On cdp-direct tabs only `url`
  mode works"); `browser-definitions.ts:117,893`; manual `topics.ts:44`;
  `core/src/tools/download.ts` header; service-worker design 3.1 row
  `Downloads` "none".
- **Expected difference:** to be written after gate B.

## 5. Owner decisions, ready to forward

### 5.1 Gate A (before P5): connection lifetime and buffers on cdp-direct

Q4 (owner, 2026-11-17) kept cdp-direct's idle and flow models. Today a `cdp:`
connection closes after 5 minutes without a call (`transport.ts:79`, not a
setting), a single long call holds nothing, and the tab stays listed; the
extension disconnects the tab after its idle TTL (default 30 minutes, user
setting) and holds the clock during a call for up to 10 minutes
(`core/src/policies/idle-rules.ts:26`). Once dialogs and capture exist, an idle
close drops the pending dialog state and every buffer. Claims are already
shared (server registry); this question is about the connection only.

| Option | What it means | For | Against |
|---|---|---|---|
| 1. Keep Q4, decouple state | Socket sweep stays; dialog state and buffers live per target, not per socket, and survive a redial; buffers are dropped when Chrome closes the target | smallest change; no new setting | events while the socket is closed are not captured (a gap in the console/network history); state for many targets |
| 2. Keep Q4, never sweep a connection holding state | A socket with armed capture or a pending dialog is not swept | history has no gaps | a long-forgotten tab keeps a socket, CDP domains and up to 400 entries; Chrome's own "being debugged" state lasts longer (**experiment** what the user sees) |
| 3. Adopt the extension's model | `TabSession` idle rules, the idle TTL setting and call hold for `cdp:` tabs | one model | idle would remove the tab from `list_tabs` or need a new meaning of "disconnect" for a tab the user never connected; largest change |
| Independent of 1-3: call hold | A running call holds the connection, as on the extension | removes the README asymmetry; small | none known |

Recommendation: option 1 plus call hold (**assumption**). The answer
supersedes Q4 and is recorded in the service-worker design (section 8).

**Answer (owner, 2026-11-21, through arch): "Como la extensión".** Built in
P5 (release 1.4.45), superseding the earlier "No barrer si hay estado":

- A connection whose capture buffers hold at least one entry is swept after
  30 minutes without a tool call on its tab (the extension's default idle
  TTL, `core/src/policies/idle-rules.ts` `DEFAULT_IDLE_TTL_MINUTES`; fixed,
  not a setting); one with empty buffers keeps the 5-minute sweep. Almost
  every used tab falls under the 30-minute branch, because the console
  replay of the first dial fills the buffers within seconds.
- Console and network events do not restart the clock; only a tool call on
  the tab does.
- A pending JavaScript dialog keeps the connection with no time limit until
  it is answered or the tab closes.
- A running flow's hold skips the connection as before.
- The buffers are dropped with the connection (`transport.ts`
  `idleLimitOf`, read by `sweepIdleConnections`).

### 5.2 Gate B (after E1-E5): downloads on cdp-direct

Decision D17 (the extension holds Chrome's download in
`onDeterminingFilename`, the server re-fetches the bytes in the page, then
settles) has no CDP primitive (**experiment** E1, E2). Options to bring with
the results:

| Option | Contract | For | Against |
|---|---|---|---|
| a. Stage then adopt | `setDownloadBehavior allow` with a browser-link staging path; Chrome writes the bytes, attributed by `Page.downloadWillBegin` on the tab's own session; the server moves the file into `downloads.dir` | POST, one-time, chunked, gzip work; no prompt (if E1 holds) | a different contract from D17 (Chrome saves first); cap and Zone.Identifier redone; user's other downloads redirected while set unless E2 shows tab scope; must revert on close and crash |
| b. Re-fetch, D17-like without hold | attribute by event, `deny` the original, re-fetch in the page | same file path as today | rejected on the facts unless E4 contradicts: `deny` loses POST and one-time downloads |
| c. Keep `url` mode only | no change | no risk to the user's browser | parity not reached for selector mode |

### 5.3 Smaller owner questions

- **G15:** answered 2026-11-20: unify on the extension's coercion (P2, done).
- **G12:** footprint (a) driven tabs only, or (b) script every listed target
  at each `list_tabs`.
- **G10:** which semantics is "the same" for `set_permission`: the
  extension's persistent `chrome.contentSettings` (profile) and its name set,
  or CDP's runtime `Browser.setPermission` override (lost when Chrome exits,
  larger name set), and which error text an unsupported name gets.
  **Answered 2026-11-21 (option a):** the runtime override, on the tab's own
  page connection, with the extension's names; the result, the tool text, the
  manual and the README say it is temporary; an unsupported name gets the
  extension's text without the MV3 wording. Done in 1.4.48 (P7, "G10 as
  built").
- **Privacy (inform, not decide):** cdp tabs have no per-tab consent, and P5
  buffers hold request headers and post data on any granted tab the agent
  drives.

## 6. Experiments before code

All run on Chrome 118 (Chrome for Testing 118.0.5993.70) and current stable,
headless as in CI, and headed once locally where noted. Each is recorded as a
real-Chrome vitest file under `packages/server/src/cdp/` (named
`*.chrome.test.ts`, run on demand with the `CDP_CONTRACT_CHROME` path, like
`contract.chrome.test.ts`) whose assertions state the observation, and its
result (Chrome version, pass/fail, observed values) goes into the slice PR and
the checkpoint report. An observation that becomes a guarantee moves into the
slice's RED case or contract.

| # | Before | Observe |
|---|---|---|
| X1 | P3 | On a page socket without a `DialogWatch`: what a click on an `alert()` button answers (inventory: `cdp-direct: command "Input.dispatchMouseEvent" timed out after 15000ms`, `client.ts:145`) and after how long; what `Runtime.evaluate` does while the dialog is open (hangs, errors, times out); whether `Page.handleJavaScriptDialog` closes a dialog opened before the socket connected; whether `Page.javascriptDialogOpening` is replayed on `Page.enable` |
| X2 | P5 | Whether `Runtime.enable` / `Log.enable` replay console entries logged before enabling; ordering and duplicates on redial; that `Network.*` does not replay; event volume on a busy page (entries per minute) |
| X3 | P7 | Whether `Browser.setPermission` is refused on a page session and works on the browser socket; its `browserContextId` handling; whether `Target.targetCreated`/`getTargets` carry `openerId` for `window.open` from a click and from a script, and for `target=_blank` links; whether `/json/list` has any opener field |
| E1 | P8 | `Page.setDownloadBehavior` and `Browser.setDownloadBehavior` `allow` with a path: accepted on a page-target socket and the browser socket, headless and headed; whether it suppresses "Ask where to save each file" (headed, with the setting on) |
| E2 | P8 | Scope of the setting (tab, browser context, browser); whether it reverts when the socket closes and when the server process is killed; what a concurrent user download in another tab does while it is set |
| E3 | P8 | Field set of `Page.downloadWillBegin` (`guid`, `frameId`, `suggestedFilename`, `url`) and `Page.downloadProgress` (`state`, `receivedBytes`, `totalBytes`); whether downloads from a new window, a cross-origin iframe and a service worker reach the clicked tab's session |
| E4 | P8 | Behavior with the e2e pages for `post`, `one-time`, `chunked`, `gzip` under the behavior E1 accepts, and under `deny` |
| E5 | P8 | Two concurrent downloads with the same URL: attribution and the files written |

X1 ran on 2026-11-20 (revision 2; lab
`packages/plan/lab/2026-11-20-cdp-direct-dialogs/`, recorded as a lab script
over the built server rather than a `*.chrome.test.ts` file).

E1 and E2 need a headed run for the prompt and the user-download question;
CI is headless, so those two are recorded locally with the Chrome version
written down (**assumption**: allowed by the owner as for earlier R3 checks).

## 7. Measuring the program

Every slice PR description and every checkpoint (after P4, after P5, after
P7, after P8; **assumption**) carries a section "Program measures" with:

1. **Required checks that blocked something:** each required job that failed
   on the PR (`gh pr checks`, the run's failed jobs) and what it caught, or
   "none".
2. **Catalog cards or findings used:** each one consulted while working and
   what it changed, or "none".
3. **Arch answers changed by the second validation:** reported by arch; the
   PR leaves the field for arch to fill.
4. **CI minutes:** the sum of job durations of the PR's runs
   (`gh run view <id> --json jobs`, `completedAt - startedAt` per job),
   including reruns.
5. **Tokens:** an estimate for the session(s) that produced the PR, stated as
   an estimate with its basis.

The checkpoint sums them per slice, so the owner gets cost and benefit per
piece at the end.

## 8. Risks and containment

| Risk | Where | Containment |
|---|---|---|
| A dialog strands a `cdp:` tab | before 1.4.39; P3 removed it for a dialog that opens while the tab's connection is open (X1: one opened with no connection cannot be answered over cdp-direct) | P3 comes before every other M slice; X1 recorded the exact failure (15 s `Input.dispatchMouseEvent` timeout, then 15 s per call); `dialog_respond` stays outside the claim guard |
| Download behavior left redirected or denied after disconnect or crash | P8 | no P8 code before E2 shows the scope and revert; revert on close, revoke and process exit is in the slice; option c stays available |
| Permissions persist in the user's profile | P7 (G10) | X3: they do not; an override lives as long as the DevTools session that set it, and closing a session that set one clears every override of that browser context (per browser context, not browser-wide), other clients' included. The owner picks the semantics; the contract asserts the state after the setting connection closes; G11's socket sets nothing |
| Capture buffers expose headers and post data on tabs without per-tab consent | P5 | same bound (200) as the extension; the gate and grant stay the only consent; stated to the owner (5.3) and in the README |
| Memory and event volume on busy tabs | P5, gate A option 2 | bounded buffers; `Network.enable` only on driven targets; X2 measures volume |
| Lost state at idle close | P3, P5 | gate A before P5; P3 documents the measured behaviour (X1): a dialog that opens while no connection to the page exists (before the lazy dial or after the sweep) cannot be seen or answered over cdp-direct, and every call on that tab fails on the `Page.enable` timeout until the user or another client answers it |
| Footprint on tabs not driven | P6 option b, P7 socket | owner choice; G11's browser socket is open only for one `wait_for_tab` call and X3 saw no footprint (headless only) |
| Experimental CDP methods (`Input.setInterceptDrags`) change | P1 | contract on 118 (required) and `cdpDirectChecks` on stable (reported) |
| Mixing refactor and behavior | P3, P5 | the shared-intake move is its own refactor PR with an empty differential |

## 9. Changes this program makes to `service-worker-architecture.md`

Listed only; this design does not edit that file. Each lands in the PR that
makes it true.

- A revision note (revision 14) recording the program, gate A's answer
  (superseding Q4 or confirming it) and gate B's.
- Status line (line 3): "program complete" stays, plus a pointer to this
  program.
- Goals non-goals (lines 355-357): "making cdp-direct support the tools it
  refuses today" and "changing cdp-direct's idle or flow models" become
  history pointing here.
- Revision 8 rows 1, 2 and 4 (lines 135-138: `DialogWatch` given by the
  extension only; cdp-direct passes none; unifying the click paths stays out).
- Revision 9 rows 1 and 6, revision 10 rows 1 and 3, revision 11 row 4
  ("cdp-direct's flow drag step keeps its refusal").
- 3.1 adapter table rows (lines 704-711): `Downloads`, `ContentSettings`
  "none"; `IdleSettings`, `FlowHistoryStore`, `DetachedFlowStore` "not used by
  cdp-direct (Q4)"; `EventsOut` row (cdp adapter).
- 3.3 "As built" text at lines 960-968 and 988 (refusals as v1 scope).
- Section 4: line 1197 ("cdp-direct does not use `TabRegistry`") and the
  `TabSession` paragraph, if the buffer split happens.
- Slice table row 14 (line 1524), the "Program complete" follow-ups
  (lines 1575-1584) and 7(e) (lines 1748-1757; it also still names
  `transport-parity.test.ts`, retired in slice 22: already stale).
- Q4 (line 1790): superseded or confirmed by gate A.

## 10. What was verified from the inventory

Verified at `9191c79`: the provides difference and both sets; the refusal
text (`support.ts:81`) and the `network_url` text; `actionDeps` building
`drag`, `dialog`, response bodies (`transport.ts:227-245`); the flow drag
refusal (`transport.ts:363`); only `Page.enable` and the observer's `Runtime`
at dial; `newPageDriver` without `dialogs`; no `onTopDocument`; the 5-minute
sweep and no call hold; foreground flows not registered
(`cdp/flow-control.ts:39`); the extension's domains (`connect.ts:281`) and
intake (`tab-connection.ts:247-342`, which also maps dialogs and emits their
events); buffer bounds; `cdpToolSupport` skipping unlisted entries; the
`wait_for_tab` dispatcher refusal; the page-only socket URL
(`targets.ts:192`); the downloads comment (`server/src/downloads.ts:22-30`);
the existing `.cdp` cases; the contract file's `DragInput`, `DialogInput`,
`ResponseBodies` blocks (lines 240, 326, 373); the behavior-change check; the
README, tool-text and manual statements cited (manual lines are 137-140, not
138-140).

Corrected: the real-Chrome contract runs on Chrome 118 only, not stable
(step 3.8); `downloadChecks` starts at `run.mjs:2000` (inventory: 1995).

Not verified: anything marked **experiment**; the `transport.test.ts` case count and its flow drag case;
`run.mjs:2051`'s comment; the generated mirror under
`packages/server/src/generated/core` against core (citations use core paths).
