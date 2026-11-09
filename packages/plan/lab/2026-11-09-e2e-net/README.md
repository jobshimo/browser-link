# Lab 2026-11-09 — e2e net: the real extension, headless, driven over MCP

Phase A of [`odd/tasks/e2e-net.md`](../../../../odd/tasks/e2e-net.md). Everything here ran on Windows 11 with the owner's Google Chrome 156.0.8078.81 in `--headless=new`, Node 24.16.0, and the built `packages/extension/dist` and `packages/server/dist` of `main` at 277400c (0.46.0). Every number below comes from a file in `results/`; every Chrome/runner claim cites a URL fetched on 2026-11-09 or a run.

| Script | Question | Result file | Answer |
|---|---|---|---|
| `a1-headless-sw.mjs` | A1: does headless Chrome load the built extension and start its MV3 worker? | `results/a1-headless-sw.json` | `--load-extension` is **ignored** by branded Chrome 156 (no `background.js` worker after 8 s; see the Chromium PSA "Removing `--load-extension` flag in Chrome branded builds", https://groups.google.com/a/chromium.org/g/chromium-extensions/c/1-g8EFx2BBY). CDP `Extensions.loadUnpacked { path }` on the browser target **works**: returned the id in 5–189 ms; `chrome-extension://<id>/background.js` appeared as a `service_worker` target ~60 ms later, ~0.3–0.4 s after launch; evaluating `chrome.runtime.getManifest()` in it returned `0.46.0`. It worked both with and without `--enable-unsafe-extension-debugging` on this build. Right after attach the worker can answer `chrome is not defined` once; retry. |
| (documentation) | A1: what does `ubuntu-latest` ship? | `results/a1-runner-image.json` | Ubuntu 24.04, image 20261101.360.1: Google Chrome 156.0.8078.79, Chromium 156.0.8078.0 (runner-images README). `lsof` is not listed. Not run on Linux. |
| `e2e-run.mjs` + `page/index.html` | A2: connect a tab without a human | `results/a2-connect.json` | Message `{ action: 'connect', tabId: <chrome tab id> }` (popup.ts), sent with `chrome.runtime.sendMessage` from `chrome-extension://<id>/popup.html` opened as a CDP target (a worker's own `sendMessage` does not reach its own `onMessage`). Response `{ ok: true, serverTabId: 'tab_1' }` in 480–979 ms; `browser.list_tabs` listed the tab in every run (4/4). The WS handshake accepted headless `chrome.exe` (peer-process check) with the worker's `chrome-extension://` Origin: verified, not assumed. |
| `e2e-run.mjs` | A3: snapshot, find, click, type, press, wait_for, read, flow through an MCP stdio client | `results/a3-tools.json` | 4/4 runs, every call ok and every effect check passed (click `expect text_appears`, press `expect text_appears`, wait_for `matched`, read returned `Items: 2`, flow 4 steps). Median latency: snapshot 5, find 4, type 168, click 163, wait_for 227, press 166, read 3, flow 680 ms. Tab id `tab_1` (extension transport; cdp-direct is off by default). |
| `e2e-run.mjs` ×3 | A4: wall time and flakiness | `results/a4-timing.json`, `results/e2e-run{1,2,3}.json` | Chrome start → last call: 2.8 / 3.2 / 6.0 s; with teardown: 5.0 / 5.3 / 8.2 s (stdev 1.4 s, all from run1's cold server start, 3.7 s vs 0.7–0.9 s). Teardown ~2.2 s each. 0 failures in 3 timed runs + 1 probe. |
| (documentation) | A5: `minimum_chrome_version` | `results/a5-min-chrome.json` | **118**: "Active debugger sessions created using the browser.debugger API now keep the service worker alive" (Chrome 118); WebSocket keepalive is 116 (https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle). Not run on 118. |

`summarize.mjs` derives `a2`/`a3`/`a4` from the raw `e2e-*.json`; it measures nothing.

## How a run isolates itself (all lab-side, no product change)

- Chrome: `--headless=new --remote-debugging-port=<p> --user-data-dir=<mkdtemp> --no-first-run --no-default-browser-check [--enable-unsafe-extension-debugging] about:blank`, then `Extensions.loadUnpacked` on a temp **copy** of `packages/extension/dist`.
- Ports: the server hard-codes 17529 (WS) and 17530 (IPC/election), and the extension hard-codes `ws://127.0.0.1:17529`. The owner's own 0.45.0 primary held both during the lab. A lab server on those ports would have proxied to it, and the version-aware election (`lifecycle/election.ts`) kills an **older** primary to take over. So the lab moves both: `port-preload.mjs` (`node --import`, `module.registerHooks`) rewrites the two literals in `packages/server/dist/**` at load time, and the extension copy gets its `WS_URL` rewritten (`lib.mjs` `extensionCopy`). Lab ports 27529/27530, CDP 29222–29230.
- Data: `BROWSER_LINK_DATA_DIR=<mkdtemp>` with `config.json` `{ "instructionsAutoRefresh": false }`, and `HOME`/`USERPROFILE`/`COPILOT_HOME` pointed at another mkdtemp.
- Page: `page/index.html` served from an in-process `http://127.0.0.1:<random>/` (an http origin so the map and readers work as for a real app).
- Teardown: MCP client close (ends the server), CDP `Browser.close` then `taskkill /T /F` if Chrome is still up after 5 s, then removal of every mkdtemp dir. All runs report `cleanup` all true and `chrome_clean_exit: true`.

## Side effect found on the owner's machine (probe run)

The first run (`results/e2e-probe.json`, `server_stderr_tail`) had only the data dir isolated. On boot the server refreshed every **outdated** agent-instruction block under the real HOME: `~/.claude/CLAUDE.md`, `~/.config/opencode/AGENTS.md` and the Copilot CLI file went from the owner's 0.45.0 block to the 0.46.0 block (`server.ts` `buildStartInstructions`, refresh only when the installed block is older). The guards above were added after it; runs 1–3 log no refresh and the files' mtimes did not change. A CI harness on a clean runner is unaffected, but a harness run on a dev machine must set both guards.

## Known lab artefacts

- `browser.list_tabs` latency includes polling until the freshly connected tab appears.
- `browser.evaluate` and two `browser.wrap_up` calls are setup for `browser.read`, which only runs a kept reader.
- The probe run is excluded from A4 timing.
