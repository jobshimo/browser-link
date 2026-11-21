/**
 * Hand-written topic sections of the agent manual: cross-cutting depth that
 * belongs to no single tool. Per-tool depth lives in each tool's `doc` block
 * (`tools/browser-definitions.ts`, `map/tools.ts`); a topic only carries what
 * those blocks do not. `browser.manual({ topic })` serves one topic; the
 * installed instructions block carries none of them.
 *
 * A topic never repeats a sentence of the core (`manual.test.ts` pins it).
 */

export const TOPIC_NAMES = [
  'downloads',
  'canvas',
  'screenshot',
  'flows',
  'map',
  'token-efficiency',
  'multi-agent',
  'cdp-direct',
  'results',
] as const;

export type TopicName = (typeof TOPIC_NAMES)[number];

export interface Topic {
  title: string;
  body: string;
}

const lines = (...l: string[]): string => l.join('\n');

export const TOPICS: Record<TopicName, Topic> = {
  downloads: {
    title: 'Downloads — never click a download button',
    body: lines(
      'A plain `browser.click` on a Download / Export button can open Chrome\'s native "Save as" dialog (when the user enabled "Ask where to save each file"). Nothing in CDP or the page can press that dialog, so the agent is stuck.',
      "- `browser.download({ tab_id, selector })` captures the download the clicked tab starts and holds it so Chrome cannot prompt, fetches the file in the page with the page's credentials and writes it into the human-configured downloads directory. Chrome's own download is cancelled and erased only after the file is written; if the fetch or the write fails it is released untouched (`chrome_download` says which).",
      '- A download the tab did not report itself is never touched and Chrome keeps it: another tab, a new tab or window the click opened, a cross-origin iframe, a service worker, or the same URL downloaded twice during the wait. The call ends `ok: false`, `state: "interrupted"`, `chrome_download: "left_in_chrome"`, with "the capture failed" in `error`. Pass the link as `url`, or ask the user.',
      '- `chrome_download` (selector mode): `removed` (saved, the Chrome copy erased), `cancelled` (saved, the erase failed), `left_in_chrome` (Chrome carries on with its own copy and may ask the user where to save it: nothing was erased; after a saved file it means two copies), `unknown` (not known: the settle answer was lost, or the extension no longer held the download; a saved file then carries `chrome_download_note`, there may be a second copy). The `error` of a failed save ends with what happened to the Chrome copy.',
      "- Before Chrome's copy can be erased, the file fetched again must match what Chrome reported (the exact size, the type when Chrome knew it, the final URL). A difference (a 200 HTML error page, a redirect to a login page, other bytes), or a download Chrome reported no size for, saves nothing and keeps Chrome's copy: `ok: false`, \"the capture failed\" and every difference in `error`. Tell the user to take Chrome's own download from chrome://downloads.",
      '- Executable types (`.exe`, `.msi`, `.bat`, `.cmd`, `.ps1`, `.lnk`, `.scr`, `.js`, `.vbs`, `.hta`, `.jar`, `.reg`, `.msix` and similar, judged by the last extension so `x.pdf.exe` counts) are refused unless the user ran `browser-link config set downloads.allow-executables on`; only the user can, from the console. Do not rename to get around it.',
      '- On Windows each saved file gets the Mark-of-the-Web (Zone.Identifier stream) like a Chrome download: `mark_of_the_web: "written"`, or `"failed"` with `mark_of_the_web_error` (the file is kept).',
      '- The file is written under a temporary name and linked into place when complete, so a failed write leaves nothing; an existing file is never overwritten (the name gets " (1)").',
      '- With a known URL, pass `url` instead (this also works on `cdp:` tabs).',
      '- On `cdp:` tabs selector mode is refused, by decision (2026-11-21): Chrome gives a DevTools client no way to hold a download until it is saved. Pass `url`, or use a tab connected through the extension.',
      '- The result always says what happened: `state: "complete" | "interrupted" | "timeout"` with `path`, `bytes`, `mime`.',
    ),
  },
  canvas: {
    title: 'Pages rendered to a canvas (Qt-WASM, WebGL, DOMless UIs)',
    body: lines(
      'Some pages draw their whole UI into one `<canvas>` (Victron VRM Remote Console, Venus OS, Felgo apps, WebGL games). There `browser.snapshot` returns an empty `interactive` list and `browser.find` finds nothing: the UI is pixels, not DOM.',
      '- Clear UI on screen but nothing in the snapshot → `browser.canvas_screenshot`. It returns the canvas as PNG/JPEG for vision and walks nested Shadow DOM roots (Qt-WASM hides its canvas behind two), so a call without `selector` still finds it.',
      '- Acting on a canvas page is not possible from this server: those runtimes accept only `isTrusted: true` input from the browser itself, and `browser.click` / `browser.type` / synthetic `dispatchEvent` go through without effect. Look, reason about what is on screen, and ask the user to act.',
    ),
  },
  screenshot: {
    title: 'Seeing a page: browser.screenshot',
    body: lines(
      'To SEE a page, use `browser.screenshot`: `mode: "viewport"` (default), `"full_page"` (the whole document in one image, no scrolling) or `"element"` (with `selector`).',
      '- It returns a real image plus metadata, scales long pages down to `max_dimension` (default 8000 px) and caps the result at ~8 MB. It is a read tool and works on `cdp:` tabs too.',
      '- Images cost tokens: prefer `"element"` or JPEG when full fidelity is not needed.',
    ),
  },
  flows: {
    title: 'Flows — saved recipes, bulk work, work longer than 60s',
    body: lines(
      '**Replaying a saved recipe.** `browser.map.recall` returns the app\'s saved `flows` (`name`, `description`, `steps`, `use_count`); `steps` follows the exact `browser.flow` step grammar. Recall → ADAPT the steps (substitute placeholder text like `type text "<QUERY>"` with the real value the user asked for) → `browser.flow` with the adapted steps. Never replay a saved flow verbatim when it contains a placeholder.',
      '',
      '**Bulk work — `flow` + `repeat`, NEVER a loop inside `evaluate`.** "Click every element matching X until the list drains" is one `repeat` step:',
      '`{ repeat: { steps: [{ click: { selector: ".row .delete" } }], max_iterations: 200, while_found: ".row", delay_ms: 250 } }`',
      '- Every click stays trusted CDP input with the occlusion guard and a recovery snapshot, and each iteration is recorded. An `evaluate` loop has none of that: `el.click()` is untrusted, nothing hit-tests, nothing is recorded.',
      '- Budget: `2000 + max_iterations * (inner + delay_ms + 500 if while_found) <= 60000`. A click costs 2500ms with default settle, 500ms with `settle_ms: 0`, so a throttled drain fits ~46 iterations per call with `settle_ms: 0` on the inner click and ~23 without. Draining a long list takes several calls; each resumes while `while_found` still matches.',
      '- The worst case per click is its settle cap (`settle_timeout_ms`, default 2000): a page that never goes quiet burns it every time.',
      '- Out of time, a flow returns `{ ok: true, stopped_by: "timeout", steps_completed, results }` (a repeat adds `iterations_completed`, `partial_iteration`). Continue the remaining work, but never relaunch irreversible steps that already completed. With `results_available: false`, `steps_completed` can be ONE LOWER than what ran: check the page before re-running that step.',
      '- Before an irreversible bulk run (deleting, sending, paying), run the same flow once with `dry_run: true`: it dispatches nothing and reports the projection, `budget_ms` and `requires_detach`.',
      '',
      '**Longer than 60s — `detach`, then poll.** `dry_run: true` → `flow({ steps, detach: true })` (keep `flow_id`) → `browser.flow_status` at a human pace → `browser.flow_cancel` to stop. `state: "expired"` (30-minute ceiling) leaves a partial manifest of real work: reconcile it before anything else. `failed` / `worker-terminated` is never resumed and its manifest is gone: re-derive what is left from the page before relaunching.',
      '',
      "**Clocks.** A running flow, foreground or detached, holds your tab claim, the extension's idle disconnect and the `cdp:` connection, each for at most the flow's own maximum duration (60 s; 30 minutes detached); each restarts from the flow's last step when the flow ends. A long single call (`wait_for`, `download`) holds the extension's idle disconnect while it runs, not your claim. After a primary restart a detached flow still running in the extension holds no claim until you act on its tab.",
      '',
      '**`evaluate` for long work — last resort.** A bridge timeout drops the RESPONSE only: the expression KEEPS RUNNING in the page and cannot be cancelled. If an `evaluate` times out, verify whether it is still working BEFORE relaunching, or a second loop runs over the same irreversible items. Launch a self-guarding worker that reports to a global, then read it with short calls:',
      '`if (window.__job?.running) return { already: true, state: window.__job }; window.__job = { running: true, done: 0, manifest: [], finished: false }; (async () => { /* work */ })(); return { launched: true };`',
      '- The guard on `running` is mandatory: without it a retried call starts a second concurrent worker.',
      '- Wait with `browser.wait_for` on `window.__job?.finished === true`, not a chain of `evaluate` calls.',
      '- Record what you touched (`window.__job.manifest.push(id)`) and read it back before the tab navigates away: `browser.events` records that actions happened, never their subject.',
    ),
  },
  map: {
    title: 'The persistent map — identifying the app, mechanisms and pitfalls',
    body: lines(
      'The map is a private per-machine SQLite cache of UI structure in the data dir ($BROWSER_LINK_DATA_DIR overrides it), never in a repo.',
      '- `origin` = scheme://host:port of the tab. `app_key` tells apart apps that share an origin; omit it on the first save (from the page title) and fix a poor guess with `browser.map.rename_app`.',
      '- After a non-trivial flow worked end-to-end, `browser.map.save` the selectors you just executed, optionally with `flows` recipes that use placeholders (`<QUERY>`, `<NAME>`) for every free-text value.',
      '- Save how the app behaves underneath too: `mechanisms: [{ key, description }]` ("a GET of an item URL marks it complete server-side") and `pitfalls: [{ key, description, symptom? }]` ("click on the next link returns ok but does not navigate"). A pitfall costs far more to rediscover than a selector; `recall` returns pitfalls first.',
      '- A `find` single match carries `semantic_key`. When the selector you save is structural (`:nth-of-type`), save that `semantic_key` in the payload next to it, and use `browser.find({ key })` when recall returns `prefer: "semantic_key"`. Never save a key for an `ambiguous` entry.',
      '- Never save a `ref` or an `ambiguous` selector, and never domain data: no IDs, names, dates or real values.',
      '- It learns alone: `recall`/`list_tabs` show `learned` counts per selector or `find` key, failed first: avoid those. Never values. Off: `browser-link config set map-learning off`.',
      '- `confidence` is `fresh` when an item worked on the current `build` (a hash of the external script and stylesheet URLs, compared only within one app). A page without external assets always reports `811c9dc5`, and a redeploy that changes only inline code or unversioned asset URLs keeps items `fresh`: treat `fresh` as a hint, not proof.',
    ),
  },
  'token-efficiency': {
    title: 'Token-efficient patterns and reading data',
    body: lines(
      '`browser.evaluate` is the escape hatch; a dedicated tool is cheaper in tokens and more reliable.',
      '- Several actions in a row (find → click → wait_for → type → press) → ONE `browser.flow({ steps })`. A `find` step feeds the next click/type/press that omits `selector`; a failed step returns a `recovery_snapshot`. Use separate calls only to branch on an intermediate result.',
      '- `find` returned `not-found` → read `near_misses` before giving up; when `error` names a role mismatch, drop `role` or use the near-miss role.',
      '- Smaller snapshots: `within_selector`, `only_interactive`, `exclude: ["nav","footer"]`, `max_interactive`. With `since`, a changed neighbour may be listed because its selector changed: use the current one.',
      '- A snapshot or find result with `truncated` was cut: it counts what was left out, so an element absent from it may still exist. Narrow the scope first; pass `offset: truncated.next_offset` only when you need the rest.',
      '- Where am I (dialog open, focus, scroll)? → `browser.state`, cheaper than a snapshot.',
      '- Reading N values → ONE `evaluate` returning an object: `(() => ({ a: document.querySelector("#a").value, b: ... }))()`.',
      '- Scrolling → `evaluate` with `pane.scrollTop = N` or `el.scrollIntoView({ block: "center" })`.',
      '- Keys (Enter, Tab, Escape, arrows, shortcuts) → `browser.press` (real CDP input, `isTrusted:true`), never a synthetic `KeyboardEvent` (`isTrusted:false`). Text → `browser.type`, which goes through the native setter so controlled inputs update.',
      '- `settle_ms` on `click`/`type`/`press` (default 150, max 2000) usually replaces a follow-up `wait_for`. Settle proves QUIET, not EFFECT: `settle.changes` is what the action caused since a mark taken before it, `mutation_count: 0` with `changes` present means no DOM change in what settle watches (the document, its shadow roots, same-origin iframes), `settle.unobserved` names what it could not watch (cross-origin frames, or closed shadow roots when the page observer is missing), and `changes: null` with `observer: "<reason>"` means the observer was unavailable. A reaction that starts after the quiet window stays invisible.',
      '- `expect` (`url_changed`, `selector_appears`, `selector_disappears`, `text_appears`, `timeout_ms`) also works on flow steps; a no-op fails with `expectation not met: ...`. It asserts a transition: a condition that already held before the action fails at once.',
      '- Paging `browser.events` → keep `lastId = result.latest_id` and pass it as `since_id`; the server keeps no per-agent cursor.',
      "- Reading data: never regex over a `DOMParser` document's text (`innerText` is `undefined` on a document with no layout, and `textContent` sweeps up scripts, CSS and hidden nodes); select per field and read that leaf, then sanity-check figures against the snapshot.",
      '- Never trust a paginated list\'s own counter: take the authoritative total elsewhere and confirm completion by an explicit empty-state string, because counters vanish at zero and leave a phantom "1 remaining".',
    ),
  },
  'multi-agent': {
    title: 'Sharing tabs with other agents (multi-agent mode)',
    body: lines(
      'Several MCP clients can share one bridge; a cooperative claim layer keeps two agents off the same tab.',
      '- `browser.claim_tab` before a multi-step flow, `browser.release_tab` after.',
      '- On a claim conflict do not spin-retry: use another tab or ask the user.',
      '- Action tools (`browser.click`, `browser.type`, `browser.navigate`, `browser.evaluate`) auto-claim a free tab on first use. If another agent holds it they fail naming the owner: ask the user whose tab it is, or use a different one.',
      '- Read tools (`browser.snapshot`, `browser.state`, `browser.console`, `browser.network`, `browser.network_body`, `browser.events`, `browser.ping`) ignore claims.',
      '- Give `browser.claim_tab` a stable `label` ("claude-code", "opencode"); claims also end on disconnect and after the inactivity TTL, which a running `browser.flow` you launched holds off until it ends. Without your own `ttl_minutes` the TTL is the console setting `claim-ttl` (10 minutes by default); `ttl_ms: null` on a claim means the user set it to never, so only a release, a disconnect or a reset ends it. The label is display only: ownership rests on the IPC session id, not on what an agent calls itself.',
      '- One server process is the primary. A newer browser-link that starts displaces an older primary (it reads `GET /version` on the bridge port, then stops the old process), and the extension reconnects by itself.',
      '- `browser.activity({ summary: true })` is the friction report: errors and flagged calls (`not-found`, `unsettled`, flow or download `timeout`...) by flag, by tool, top failing selectors and one line per agent session; narrow it with `since`, `since_id` or `agent_id`.',
      '- A `list_tabs` hint "server running X, installed Y" means the package was updated under a live server: ask the user to run `browser-link stop` and restart the agent, or to click "Repair connection" in the extension popup. Do not kill processes yourself.',
    ),
  },
  'cdp-direct': {
    title: 'cdp-direct tabs (optional, off by default, human-gated)',
    body: lines(
      "A `cdp:` tab was reached over Chrome's remote-debugging protocol instead of the extension. It appears only when the user has BOTH enabled cdp-direct AND granted a live, time-boxed permission; you cannot request, enable or grant it.",
      '- Every other tool works on it exactly as on an extension tab, including `browser.download` by `url` and `browser.screenshot`. `browser.read` and `browser.flow` by name, the `known` hint, map hints and the trail work as on an extension tab; `list_tabs` shows `build` and `view_sig` for a `cdp:` tab only once browser-link already holds a connection to it; it never connects to list.',
      '- Unsupported tools fail with a clear error naming the extension as the fallback.',
      '- `cdp:` tabs (`transport: "cdp"`) lack set_permission and download by selector. `drag` (also as a flow step), `canvas_screenshot`, `dialog_respond`, `wait_for_tab`, `console`, `network`, `network_body` and `wait_for` by `network_url` work as on an extension tab.',
      '- Capture on a `cdp:` tab starts at the first browser-link call to it: `console` also holds the earlier console history Chrome replays then; `network` and `network_body` see only requests made since. Headers and post data are kept raw. The connection, and what it captured, is dropped after 30 minutes without a tool call on the tab (5 minutes when nothing was captured; never while a JavaScript dialog is pending); after that the next call starts again from the replayed console history, and `network_body` answers only for requests the current connection saw.',
      '- `wait_for_tab` with a `cdp:` `opened_from` watches the browser for the length of the call and answers only a page that tab opened (`window.open`, a `target=_blank` link); a page it opened before the call is returned only after an action on that tab in the last 1.5 s, and several such pages are an error naming them (pick one with `list_tabs`).',
      '- A JavaScript dialog that opened while cdp-direct had no connection to the tab (before its first call, or after its idle close) cannot be seen or answered over cdp-direct: calls fail with "the page did not answer Page.enable within 15 s" → ask the user to close the dialog in the browser.',
      '- The two gate errors are the permission model talking, not a bug: "cdp-direct is disabled" / "requires an active grant" → relay `browser-link config set cdp-direct.enabled true` or `browser-link cdp allow` to the user; there is no workaround.',
    ),
  },
  results: {
    title: 'Reading results — what an ok does not prove',
    body: lines(
      'An `ok` result can still mean the action missed. The fields that say so:',
      '- `hit_element` on `click` (and flow click steps) appears when a `pointer-events: none` target passes the click on, or on `force: true`; it names the real receiver: if it is not your target or inside it, the click missed → do not proceed; `find` the element that receives clicks by its text.',
      '- `retargeted` error on `click`: the click would land on an ancestor of your target (clipped or covered by its own container) → scroll or expand the container, or `find` the element that receives clicks; `force: true` clicks there anyway.',
      "- `no visible box` error on `click`: the target is not rendered or visibility-hidden; it is never clicked at (0,0) → make it visible first; `force: true` calls the element's own click() instead, and the result says so in `programmatic_click` (no pointer, hover, mousedown or mouseup); it is refused when the target is disabled or an `<option>`, where click() does nothing.",
      '- `click` reports a pointer click only where its press was seen landing; the press is sent only after the mouse move was seen on the target, so a click whose move never reaches it, or cannot be confirmed (the page did not answer, or the document was replaced), fails with `Click on <target> did not reach it` and `no press was sent`; a press seen elsewhere or not at all fails with the same prefix → check the effect (`snapshot` or `screenshot`) before retrying. `hit_check: "not_verifiable"` with `hit_check_note` (on `click` and on flow click steps) means the landing could not be checked (the target is an iframe, frame, embed or object; a JavaScript dialog opened, answer it with `dialog_respond`; the page did not answer in time; or the document was replaced) → `expect` or `snapshot` the effect.',
      '- `mutation_count: 0` or `settle.settled: false` → `expect` or `wait_for` the effect you need.',
      '- `since_status` on `snapshot`: you received a full snapshot → keep its new `snapshot_id`.',
      '- `reresolved: true`: the node was replaced by a re-render and re-found (never a look-alike that already existed) → fine.',
      '- `ref-stale` → take a fresh `snapshot`/`find`; never retry the same ref.',
      '- `wait_for` returning `matched: false` is not an error → decide.',
      '- `extension_outdated: true` on `list_tabs` → extension older than server, fields may be missing: ask the user to update or reload the extension.',
      '- `extension_newer: true` on `list_tabs` → extension newer than server: the server runs older code; ask the user to run `browser-link stop` and restart the agent. Either flag comes with `version_note`: relay it, it names what does not work until then.',
      '- "Tab not connected" → `browser.events` for the renamed tab_id, then retry.',
      '- One full `snapshot` per view, then `snapshot({ since: snapshot_id })` for every later look.',
      '- Before suggesting a UI code change or a click, `browser.snapshot` and verify the element exists.',
      '- Never inject attributes with `evaluate` to build selectors: synthetic events are `isTrusted: false`, apps ignore them, and nothing records what happened.',
    ),
  },
};

/** One topic as a markdown section: `### <title>`, blank line, body. */
export function renderTopic(name: TopicName): string {
  const topic = TOPICS[name];
  return `### ${topic.title}\n\n${topic.body}`;
}
