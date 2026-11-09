/**
 * Hand-written topic sections of the agent manual: cross-cutting depth that
 * belongs to no single tool. Per-tool depth lives in each tool's `doc` block
 * (`tools/browser-definitions.ts`, `map/tools.ts`); a topic only carries what
 * those blocks do not. `browser.manual({ topic })` serves one topic, and the
 * installed instructions block embeds a few of them after the core.
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
      "- `browser.download({ tab_id, selector })` captures the download the click starts, cancels it before Chrome can prompt, fetches the file in the page with the page's credentials and writes it into the human-configured downloads directory.",
      '- With a known URL, pass `url` instead (this also works on `cdp:` tabs).',
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
      'The map is a private, per-machine SQLite cache of UI structure in the data dir ($XDG_DATA_HOME/browser-link on Linux, ~/Library/Application Support/browser-link on macOS, %APPDATA%/browser-link on Windows; override with $BROWSER_LINK_DATA_DIR). It is never written to a repo.',
      '- `origin` = scheme://host:port of the tab. `app_key` tells apart apps that share an origin; omit it on the first save (derived from the page title) and fix a poor guess with `browser.map.rename_app`.',
      '- After a non-trivial flow worked end-to-end, `browser.map.save` the selectors you just executed, optionally with `flows` recipes that use placeholders (`<QUERY>`, `<NAME>`) for every free-text value.',
      '- Save how the app behaves underneath too: `mechanisms: [{ key, description }]` ("a GET of an item URL marks it complete server-side") and `pitfalls: [{ key, description, symptom? }]` ("click on the next link returns ok but does not navigate"). A pitfall costs far more to rediscover than a selector; `recall` returns pitfalls first.',
      '- A `find` single match carries `semantic_key`. When the selector you save is structural (`:nth-of-type`), save that `semantic_key` in the payload next to it, and use `browser.find({ key })` when recall returns `prefer: "semantic_key"`. Never save a key for an `ambiguous` entry.',
      '- Never save a `ref` (refs die with the document) or an `ambiguous` selector, and never domain data: no IDs, names, dates or real values.',
    ),
  },
  'token-efficiency': {
    title: 'Token-efficient patterns and reading data',
    body: lines(
      '`browser.evaluate` is the escape hatch; a dedicated tool is cheaper in tokens and more reliable.',
      '- Several actions in a row (find → click → wait_for → type → press) → ONE `browser.flow({ steps })`. A `find` step feeds the next click/type/press that omits `selector`; a failed step returns a `recovery_snapshot`. Use separate calls only to branch on an intermediate result.',
      '- `find` returned `not-found` → read `near_misses` before giving up; when `error` names a role mismatch, drop `role` or use the near-miss role.',
      '- Smaller snapshots: `within_selector`, `only_interactive`, `exclude: ["nav","footer"]`, `max_interactive`. With `since`, a changed neighbour may be listed because its selector changed: use the current one.',
      '- Where am I (dialog open, focus, scroll)? → `browser.state`, cheaper than a snapshot.',
      '- Reading N values → ONE `evaluate` returning an object: `(() => ({ a: document.querySelector("#a").value, b: ... }))()`.',
      '- Scrolling → `evaluate` with `pane.scrollTop = N` or `el.scrollIntoView({ block: "center" })`.',
      '- Keys (Enter, Tab, Escape, arrows, shortcuts) → `browser.press` (real CDP input, `isTrusted:true`), never a synthetic `KeyboardEvent` (`isTrusted:false`). Text → `browser.type`, which goes through the native setter so controlled inputs update.',
      '- `settle_ms` on `click`/`type`/`press` (default 150, max 2000) usually replaces a follow-up `wait_for`. Settle proves QUIET, not EFFECT: `settle.changes` is what the action caused since a mark taken before it, `mutation_count: 0` with `changes` present means no DOM change, and `changes: null` with `observer: "<reason>"` means the observer was unavailable. A reaction that starts after the quiet window stays invisible.',
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
      '- Action tools (`browser.click`, `browser.type`, `browser.navigate`, `browser.evaluate`) auto-claim a free tab on first use. If another agent holds it they fail naming the owner: ask the user whose tab it is, or use a different one.',
      '- Read tools (`browser.snapshot`, `browser.state`, `browser.console`, `browser.network`, `browser.network_body`, `browser.events`, `browser.ping`) ignore claims.',
      '- Give `browser.claim_tab` a stable `label` ("claude-code", "opencode"); claims also end on disconnect and after the inactivity TTL. The label is display only: ownership rests on the IPC session id, not on what an agent calls itself.',
      '- One server process is the primary. A newer browser-link that starts displaces an older primary (it reads `GET /version` on the bridge port, then stops the old process), and the extension reconnects by itself.',
      '- A `list_tabs` hint "server running X, installed Y" means the package was updated under a live server: ask the user to run `browser-link stop` and restart the agent, or to click "Repair connection" in the extension popup. Do not kill processes yourself.',
    ),
  },
  'cdp-direct': {
    title: 'cdp-direct tabs (optional, off by default, human-gated)',
    body: lines(
      "A `cdp:` tab was reached over Chrome's remote-debugging protocol instead of the extension. It appears only when the user has BOTH enabled cdp-direct AND granted a live, time-boxed permission; you cannot request, enable or grant it.",
      '- Every other tool works on it exactly as on an extension tab, including `browser.download` by `url` and `browser.screenshot`.',
      '- Unsupported tools (and a `drag` step inside a flow) fail with a clear error naming the extension as the fallback.',
      '- The two gate errors are the permission model talking, not a bug: relay the exact command they suggest.',
    ),
  },
};

/** One topic as a markdown section: `### <title>`, blank line, body. */
export function renderTopic(name: TopicName): string {
  const topic = TOPICS[name];
  return `### ${topic.title}\n\n${topic.body}`;
}
