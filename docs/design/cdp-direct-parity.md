# cdp-direct parity with the extension

Status: revision 1 (2026-11-19), for arch's audit before any code. Written at
`main` `9191c79` (release 1.4.34); every `path:line` below is at that commit.
No code, test or other document is changed by this file. The owner decided
on 2026-11-19 that the program starts; two of its decisions are still his
(section 5).

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
| G10 | `set_permission` | refusal text | a cdp `ContentSettings` adapter over a browser-level socket | L | Medium | **experiment** |
| G11 | `wait_for_tab` | refused in the dispatcher (`browser-dispatch.ts:3034-3043`), declared `false` (`support.ts:50`) | opener-to-new-target signal, `tab-created` for `cdp:` tabs | M | Medium | code verified; `openerId` **experiment** |
| G12 | `build`, `view_sig` in `list_tabs` | absent (README line 2670) | the observer's `doc_info` reaching `listCdpTargets` | M | Medium (footprint) | verified |
| G13 | idle and claim model | fixed 5 min socket sweep (`transport.ts:79`), no call hold | an owner decision superseding Q4 | L | Medium | verified |
| G14 | foreground flow registry | `start` registers detached flows only (`cdp/flow-control.ts:39`) | register foreground runs; `flow_status` answers `running` | M | Low | code verified; observable answer **likely** |
| G15 | per-transport coercion | 5 entries differ (`interaction.ts:53,96,131`, `page-read.ts:78,177`) | one `coerce` per entry | S | Low, agent-visible | entries verified; reachability **unverified** |
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
   `TabSession` needs a driver and its idle rules (Q4). Each move is a
   **refactor PR of its own**, before the behavior PR that uses it (7(e)):
   e2e differential empty, title `refactor(core): ...`.
5. **Events out.** `EventsOut.emit(tabId: number, event)`
   (`core/src/ports/events-out.ts`) takes a numeric Chrome tab id; `cdp:` tab
   ids are strings. Open point for arch (not the owner): widen the tab key of
   `EventsOut` (a contract change in the refactor PR) or give the core intake a
   tab-bound emitter. cdp-direct's adapter writes into `BridgeEventLog`, the
   sink `server.ts:420` already installs for `flow-finished`, and gets the
   `events-out.contract.ts` suite.
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

### P2. G15 coercion (S) — only if the owner wants it

- **Shape.** Each of the five entries gets one `coerce` (the extension's
  `String(x)` or cdp-direct's `''`, the owner's choice, **assumption**: the
  extension's, since it is the reference transport).
- **RED first.** A dispatcher-level unit test sending a non-string or missing
  `selector`/`text`/`url`/`expression` to a `cdp:` tab; an e2e case only if
  the unit test shows the MCP path reaches it. Whether MCP input-schema
  validation stops such input first is **unverified** (`server.ts:172` uses a
  raw `setRequestHandler`; the validation path was not followed).
- **Expected difference:** a missing or non-string argument on a `cdp:` tab
  answers as on an extension tab.

### P3. G4 dialog tracking and G3 `dialog_respond` (M)

- **Before code:** experiment X1 (section 6).
- **Refactor PR first.** Dialog half of the intake and the pending-dialog
  state move to core (step 3.4); `sessionDialogWatch` reads the moved state.
  Differential empty.
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
  opened before the first call has no opening event; `Page.handleJavaScriptDialog`
  still answers it (**experiment**, X1).
- **RED first.** `browser.click.opens-dialog.cdp` (click answers
  `dialog: true`, `dialog_respond` closes it, the tab answers `evaluate`
  after), and a `browser.events` check for `dialog-opening` on the cdp tab.
- **Tests that flip.** `provides.test.ts` (`dialog_respond` refusal),
  `support.test.ts`; `transport.test.ts` dial cases gain the watch.
- **Statements.** `browser-definitions.ts:117`; manual `cdp-direct`; README
  support table and the intro's "the popup's dialog channel"; service-worker
  design revision 8 rows 1-2 and 4, revision 10 row 1 (section 8 below).
- **Expected difference:** on a `cdp:` tab a click that opens a JavaScript
  dialog answers `dialog: true` instead of waiting for the command timeout;
  `browser.dialog_respond` works; `browser.events` shows `dialog-opening` and
  `dialog-closed` for `cdp:` tabs.

### P4. G14 foreground flow registry (M)

- **Shape.** `createCdpFlowControl.start` registers foreground runs in
  `cdp/detached-flows.ts` with `onProgress`, keeps the gate re-check and
  connection hold it has today, and `status`/`cancel` find them. The registry
  module may need a foreground/detached flag so the one-detached-per-tab rule
  and the 30-minute ceiling apply to detached runs only (**assumption**).
  Adopting `FlowRun`/`FlowRegistry` instead touches Q4 and is left to gate A.
- **RED first.** `browser.flow_status.running.cdp` (status of a running
  foreground flow from a second call answers `running` with
  `steps_completed`), `browser.flow_cancel.foreground.cdp`.
- **Statements.** README 2701-2717 ("behave identically" holds for foreground
  flows too); manual topic `flows` (`manual/topics.ts:79`) if it mentions it.
- **Expected difference:** on a `cdp:` tab, `browser.flow_status` of a running
  foreground flow answers `running` instead of `unknown`, and
  `browser.flow_cancel` stops it.

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

### P7. Browser-level socket, G11 `wait_for_tab`, then G10 `set_permission`

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

- **G15:** do P2 at all, and if so which coercion is "the same" (section 4 P2).
- **G12:** footprint (a) driven tabs only, or (b) script every listed target
  at each `list_tabs`.
- **G10:** which semantics is "the same" for `set_permission`: the
  extension's persistent `chrome.contentSettings` (profile) and its name set,
  or CDP's runtime `Browser.setPermission` override (lost when Chrome exits,
  larger name set), and which error text an unsupported name gets.
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
| A dialog strands a `cdp:` tab | today; P3 removes it | P3 comes before every other M slice; X1 records the exact failure first; `dialog_respond` stays outside the claim guard |
| Download behavior left redirected or denied after disconnect or crash | P8 | no P8 code before E2 shows the scope and revert; revert on close, revoke and process exit is in the slice; option c stays available |
| Permissions persist in the user's profile | P7 (G10) | the owner picks the semantics; the contract test restores what it set; the README says what persists |
| Capture buffers expose headers and post data on tabs without per-tab consent | P5 | same bound (200) as the extension; the gate and grant stay the only consent; stated to the owner (5.3) and in the README |
| Memory and event volume on busy tabs | P5, gate A option 2 | bounded buffers; `Network.enable` only on driven targets; X2 measures volume |
| Lost state at idle close | P3, P5 | gate A before P5; P3 documents the lazy-dial and sweep caveat |
| Footprint on tabs not driven | P6 option b, P7 socket | owner choice; browser socket opened only while needed |
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

Not verified: anything marked **experiment**; that MCP input validation makes
G15 unreachable; the `transport.test.ts` case count and its flow drag case;
`run.mjs:2051`'s comment; the generated mirror under
`packages/server/src/generated/core` against core (citations use core paths).
