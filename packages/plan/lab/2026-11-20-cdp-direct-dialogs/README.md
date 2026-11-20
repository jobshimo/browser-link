# Lab 2026-11-20: cdp-direct and JavaScript dialogs (experiment X1)

Experiment X1 of [`docs/design/cdp-direct-parity.md`](../../../../docs/design/cdp-direct-parity.md) (section 6), asked before P3 (dialog tracking and `dialog_respond`). Built from `main` at 84dfe8d (release 1.4.36), where `transport.ts` still passes no `DialogWatch` to the page driver. No product code was changed.

`packages/plan/lab/` is the lab folder in use, so this lab follows `2026-11-09-e2e-net/`. The two `chrome-*.txt` files are the verbatim stdout and stderr of one run each and are never edited.

| File | What it is |
|---|---|
| `x1-dialogs.mjs` | The experiment script (`CHROME_PATH=<chrome> node x1-dialogs.mjs <label>`; stdout is the record). |
| `fixture.html` | Buttons `#alert-btn` (`alert('x')`), `#confirm-btn`, `#prompt-btn`, `#timer-btn` (arms a 1.5 s timer that calls `alert('t')`); `#out` shows what the page saw. |
| `chrome-118.txt` | Chrome for Testing 118.0.5993.70 (installed with `@puppeteer/browsers@3.2.6`, like the CI e2e job), headless. |
| `chrome-stable.txt` | The local stable Chrome, `Chrome/157.0.8103.51` as it reports itself, headless. |

## Question

On a `cdp:` tab with no `DialogWatch`: what do a click that opens a dialog, a following `evaluate` and `snapshot` answer, does `Page.javascriptDialogOpening` reach a connection (dialed before the dialog, and dialed lazily after it), does `Page.handleJavaScriptDialog` work in each case, and what does the page report afterwards. Also for `confirm()`, `prompt()` and an `alert` opened by a timer.

## Method

Same shape as the e2e cdp-direct phase (`packages/e2e/src/run.mjs` `cdpDirectChecks`, helpers from `packages/e2e/src/lib.mjs` and `cdp-direct.mjs`): a headless Chrome with a free remote-debugging port, the built server (`packages/server/dist/cli.js`) over stdio MCP in the isolated environment (own WS/IPC ports, data dir, HOME, USERPROFILE), cdp-direct enabled and granted with the server's own CLI, then `browser.*` calls on `cdp:<targetId>` tabs. Every case uses a fresh tab. The harness checks that the owner's primary on 17529/17530 is alive at the end (it was: both files end with `owner primary: pid 54284 still alive`).

For events and the dialog answer the script dials a second connection to the same page target with the server's own `CdpClient` (`dist/cdp/client.js`), the way `transport.ts` `dial` does (`Target.getTargetInfo`, then `Page.enable`), and records every `Page.javascriptDialog*` event. Its name tags are: `obs`, dialed before the dialog opens (the shape of the server's own connection, which also did `Page.enable` at dial); `late`, dialed after the dialog is open; `bare`, a connection that never sends `Page.enable`. The server's own connection is not directly observable from outside; `obs` stands in for it. The cases:

- `click-alert|confirm|prompt`: server dialed first (a snapshot), then a click opens the dialog and nobody else is connected. Items 1 and 2, then `late` and `bare` try to accept (items 3 and 4, lazy shape).
- `observer-alert|confirm|prompt`: `obs` exists before the click; the click runs while `obs` accepts after 1.5 s. Items 3 and 4, dialed-before shape.
- `timer-alert`: the click only arms a timer; the alert opens by itself 1.5 s later.
- `preopen-alert|confirm`: the dialog is already open (started from the harness session with a `setTimeout`) before the server's first call on the tab, so its lazy dial happens with the dialog open.

Each MCP call has a 60 s client timeout, so any 15 s answer below is the server's, not the harness's.

## Observations

Every line below is quoted from the raw files. Chrome 118 and 157 gave the same text in every case and timings within about 30 ms of each other; the only other differences in the record are a settle `duration_ms` (162 against 152) and that 157 adds a `frameId` field to the two dialog events. Timings are the `duration=` of the call; where a number is quoted below it comes from `chrome-118.txt` unless it says 157, and the other file has the matching line.

### 1. `browser.click` on a button whose handler calls `alert('x')`

```
CALL browser.click {"tab_id":"cdp:...","selector":"#alert-btn"} (opens alert) -> isError=true duration=15035ms
  text: Error: cdp-direct: command "Input.dispatchMouseEvent" timed out after 15000ms
```

So it is the 15 s command timeout of `client.ts`, with exactly the inventory text, `isError: true`, 15.03 s. `confirm()` (`duration=15033ms`) and `prompt()` (`duration=15026ms` on 157; the 118 file has the same text) answer the same. The click does not return a `dialog` field and the page does not get the click's settle report.

### 2. While the dialog is open

```
CALL browser.evaluate {"expression":"1+1"} (dialog still open) -> isError=true duration=15022ms
  text: Error: cdp-direct: command "Runtime.evaluate" timed out after 15000ms
CALL browser.snapshot {} (dialog still open) -> isError=true duration=15010ms
  text: Error: cdp-direct: command "Runtime.evaluate" timed out after 15000ms
```

`evaluate` and `snapshot` each take 15 s and fail with the `Runtime.evaluate` timeout text; neither returns early or names the dialog. The same holds for the timer-opened alert (`browser.evaluate` `duration=15018ms`, `browser.snapshot` `duration=15012ms` on 157, same text), and for a click on a dialog the server never saw open: the timer's own `browser.click` returned `isError=false duration=169ms` because the dialog opened after it, and the stranding shows only on the next call. Each further call on the tab costs another 15 s until someone answers the dialog.

### 3. `Page.javascriptDialogOpening` on a connection

- Dialed before the dialog (`obs`, `Page.enable` done first): delivered, for the click and for the timer, for all three kinds.
  ```
  [obs] EVENT Page.javascriptDialogOpening {"url":"http://127.0.0.1:.../","message":"x","type":"alert","hasBrowserHandler":true,"defaultPrompt":""}
  ```
  The `prompt` event carries `"defaultPrompt":"def"`. It arrives about 25 ms after the click starts. `Page.javascriptDialogClosed` follows on accept (`{"result":true,"userInput":"typed"}` for the prompt).
- Dialed after the dialog is already open (`late` after a click dialog, and the server's own first call in `preopen-*`): not delivered, and the dialog is not replayed. `Page.enable` does not return:
  ```
  [late] Page.enable FAILED after 15008ms: cdp-direct: command "Page.enable" timed out after 15000ms
  [late] dialog events seen after dial+500ms: 0
  [late] dialog events replayed on Page.enable: []
  ```
  On a lazy dial the server's own first call fails the same way, before any tool runs: `browser.snapshot ... (first call on the tab, alert already open: lazy dial) -> isError=true duration=15013ms` with `text: Error: cdp-direct: command "Page.enable" timed out after 15000ms`. Every later call re-dials and fails identically (`browser.evaluate` `duration=15019ms`, `browser.snapshot` `duration=15018ms`, same `Page.enable` text).

### 4. `Page.handleJavaScriptDialog` (accept)

- On the connection dialed before (`obs`), it works and does not close the connection:
  ```
  [obs] Page.handleJavaScriptDialog {"accept":true} -> {} after 1ms; connection open after: true
  ```
  The click that had been waiting then returns normally (`browser.click ... -> isError=false duration=1673ms`, the 1.5 s being the harness's delay), and the page reports `after-alert` (`confirm=true`, `prompt=typed`, `after-timer-alert` for the others) in a `browser.evaluate` that takes 4-5 ms. After the timer alert is accepted, `browser.evaluate` answers `after-timer-alert` in 4-7 ms: the server's own connection is intact, nothing needs to be redialed.
- On a connection dialed after the dialog opened, it fails, with or without `Page.enable`:
  ```
  [late] Page.handleJavaScriptDialog {"accept":true} FAILED after 1ms: No dialog is showing; connection open after: true
  [bare] (no Page.enable) Page.handleJavaScriptDialog FAILED after 1ms: No dialog is showing
  ```
  The `late` connection stays open too. After these attempts the tab is still stranded (`browser.evaluate ... (after the attempts to accept) -> isError=true duration=15009ms`, `Runtime.evaluate` timeout text; in the `preopen-*` cases the text is `Page.enable` timed out again). The harness's own cleanup (`Page.handleJavaScriptDialog` on a browser-level session, then `Target.closeTarget`) is the only thing that moved those tabs on.

### 5. `confirm()`, `prompt()`, timer alert

Same as above in every item, one case each (`click-confirm`, `click-prompt`, `observer-confirm`, `observer-prompt`, `timer-alert`, `preopen-confirm`). The only per-kind differences are the event payload (`type`, `message`, `defaultPrompt`) and the page's answer (`confirm=true`, `prompt=typed`).

## What it means for P3

- **The old answer the RED case should expect.** `browser.click.opens-dialog.cdp` on today's build: `isError: true`, text exactly `Error: cdp-direct: command "Input.dispatchMouseEvent" timed out after 15000ms`, after about 15 s. The new answer is a click that returns at once with `dialog: true`. Since the old answer takes 15 s, a differential run needs a per-call timeout above 15 s (the e2e `CALL_TIMEOUT_MS` is 45 s, enough).
- **Order matters, and it is not a detail.** The dialog event only reaches a connection whose `Page.enable` completed before the dialog opened. So the pending-dialog state has to be fed from the connection's very first `Page.enable`, and the `DialogWatch` must be wired at dial, as the P3 design says (`transport.ts` dial, not per call).
- **The lazy-dial caveat is worse than "no opening event".** The design says `Page.handleJavaScriptDialog` "still answers" a dialog opened before the first call. It does not: on Chrome 118 and 157, a connection dialed with a dialog open cannot even finish `Page.enable` (15 s timeout), and `Page.handleJavaScriptDialog` fails with `No dialog is showing`, with or without `Page.enable`. Such a tab is stranded for cdp-direct whatever P3 ships, and every call on it costs 15 s and fails on `Page.enable`. P3 must either document this as a limit (the dialog has to be dismissed by the user or another client) or answer it with a faster, clearer error than the generic `Page.enable` timeout; it cannot offer `dialog_respond` for it.
- **A connection that saw the opening can answer it and survives.** `dialog_respond` on the server's own connection is therefore feasible for any dialog that opened after the dial, including timer-opened ones, and a pending click resolves on its own once the dialog is answered. That also means a timer alert is only seen if the connection is still alive and has not been idle-swept: P3's sweep rule ("never sweep a connection holding state") matters for it.
- **The `evaluate`/`snapshot` calls during a dialog are not racy, just slow.** With the dialog state tracked they can answer a dialog-pending error at once instead of taking 15 s.
- **`confirm()`, `prompt()` and the timer alert need no special handling** beyond reading `type`, `message` and `defaultPrompt` from the event and passing `promptText` through.
- **Not run here:** headed Chrome, and a click that opens a dialog on a tab where the harness itself had `Page` enabled. Neither was needed for the questions above.
