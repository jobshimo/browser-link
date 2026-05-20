/**
 * MCP tool definitions for the browser-bridge family. Kept separate from
 * the runtime dispatcher so the JSON schemas stay reviewable in one place
 * and the dispatch logic stays small.
 *
 * Each entry carries a `doc` block (`ToolDoc`) with structured human-facing
 * documentation. `buildServerInstructions()` reads those blocks to produce
 * the SERVER_INSTRUCTIONS string the MCP host receives on `initialize`. The
 * structured shape keeps the "when to use" copy beside the tool that owns
 * it instead of drifting in a single monolithic string.
 */

import type { ToolDefinition } from './types.js';

export const BROWSER_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'browser.list_tabs',
    description:
      'List Chrome tabs currently connected to browser-link. A tab is connected only after the user clicks Connect in the extension popup. Each entry includes tab_id, url, title, claimed_by (null when free, or { agent_id, pid, binary, label?, claimed_at, last_activity_at } when another agent owns it) and claimed_by_me (true when YOU hold the claim).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    doc: {
      purpose:
        'List the Chrome tabs the user has explicitly connected through the browser-link extension popup.',
      when_to_use: [
        'Before doing anything on a tab whose state you do not already own.',
        'When the user mentions a UI bug, web page, or asks "does X work" — call this FIRST.',
        'To see which tabs are claimed by other agents (claimed_by) and which are yours (claimed_by_me).',
      ],
      gotchas: [
        'Returns only tabs the user has connected manually. If the list is empty the user has not connected anything yet — ask them to open the extension popup.',
      ],
    },
  },
  {
    name: 'browser.claim_tab',
    description:
      'Claim a tab so other agents stop touching it. Returns ok:true with your claim, or ok:false reason:"conflict" with the existing claim. Pass an optional label (eg "claude-code") that other agents will see in browser.list_tabs. Pass ttl_minutes (default 10, max 60) — the claim auto-expires after that many minutes of inactivity. Action tools (click/type/navigate/evaluate) auto-claim free tabs, so an explicit claim_tab is only needed when you want to reserve a tab before you start, or to refresh the label/TTL.',
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: { type: 'string' },
        ttl_minutes: {
          type: 'number',
          description: 'Inactivity timeout for the claim, in minutes. Default 10, capped at 60.',
        },
        label: {
          type: 'string',
          description:
            'Optional self-declared display label (eg "claude-code", "opencode"). Visible to other agents in browser.list_tabs. Display only — not used for enforcement.',
        },
      },
      required: ['tab_id'],
      additionalProperties: false,
    },
    doc: {
      purpose:
        'Reserve a tab cooperatively so other MCP clients sharing the bridge see it is in use.',
      when_to_use: [
        'Before a multi-step flow on a tab in multi-agent mode, so other agents see you working on it.',
        'To refresh the inactivity TTL or update the display label on a tab you already hold.',
      ],
      gotchas: [
        'Action tools (click/type/navigate/evaluate) auto-claim a free tab on first use, so explicit claim_tab is only required for early reservation.',
        'On conflict the response includes the existing claim — do NOT spin-retry; pick a different tab or surface the conflict to the user.',
      ],
      example: 'browser.claim_tab({ tab_id: "tab_1", label: "claude-code", ttl_minutes: 15 })',
    },
  },
  {
    name: 'browser.release_tab',
    description:
      'Release a tab claim you hold. Returns ok:true on success, ok:false reason:"not-owner" if another agent holds it, or ok:false reason:"not-claimed" if the tab is free. Releasing is also automatic on agent disconnect and when the inactivity TTL elapses, so calling this explicitly is only needed for early hand-off.',
    inputSchema: {
      type: 'object',
      properties: { tab_id: { type: 'string' } },
      required: ['tab_id'],
      additionalProperties: false,
    },
    doc: {
      purpose: 'Hand a previously claimed tab back so another agent can take it.',
      when_to_use: [
        'After you finished working on a tab and want to hand it off before the TTL expires.',
      ],
      gotchas: [
        'Claims also auto-release on agent disconnect and after the inactivity TTL (default 10 minutes) — explicit release is only for early hand-off.',
      ],
    },
  },
  {
    name: 'browser.my_tabs',
    description:
      'List the tabs YOU currently hold a claim on. Returns { claims: [{ tab_id, claimed_at, last_activity_at, ttl_ms, label? }] } sorted by claimed_at. Use this to answer the user when they ask which tabs you are working on.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    doc: {
      purpose: 'Return the tabs the current agent has claimed, with timestamps and TTL.',
      when_to_use: [
        'When the user asks which tab you are using ("¿qué pestaña tenés?", "which tab are you on?").',
        'To verify which tab is yours before performing an action in multi-agent mode.',
      ],
    },
  },
  {
    name: 'browser.ping',
    description: 'Verify the bridge to a tab. Returns its current title and url.',
    inputSchema: {
      type: 'object',
      properties: { tab_id: { type: 'string' } },
      required: ['tab_id'],
      additionalProperties: false,
    },
    doc: {
      purpose: 'Confirm the bridge to a specific tab is healthy and read back its title/url.',
      when_to_use: ['When you suspect a tab may have been closed or disconnected between calls.'],
    },
  },
  {
    name: 'browser.navigate',
    description: 'Navigate the connected tab to a URL. By default waits for the load event.',
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: { type: 'string' },
        url: { type: 'string', description: 'Full URL including protocol.' },
        wait_for_load: { type: 'boolean', default: true },
      },
      required: ['tab_id', 'url'],
      additionalProperties: false,
    },
    doc: {
      purpose: 'Drive a connected tab to a new URL.',
      when_to_use: [
        'The user asks you to open a page in the browser ("abrí esto en el navegador", "navigate to X").',
        'You need to reach a specific route before snapshotting or interacting.',
      ],
      gotchas: [
        'Defaults to wait_for_load=true so the snapshot you take next reflects the loaded page.',
      ],
      example: 'browser.navigate({ tab_id: "tab_1", url: "https://example.com" })',
    },
  },
  {
    name: 'browser.snapshot',
    description:
      'Snapshot of the tab: title, url, visible text (truncated) and a list of interactive elements (buttons, links, inputs, selects, textareas) with a CSS selector and labels. Use this to understand page state before clicking or typing. Optional filters keep the response small: `within_selector` restricts the scan to a subtree; `only_interactive` skips headings and the text dump; `exclude` drops landmarks like nav/footer; `max_interactive` overrides the default cap of 120. The per-entry serializer omits empty-string fields, so the same call returns a leaner payload than before — no behavior change for clients that read by key.',
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: { type: 'string' },
        within_selector: {
          type: 'string',
          description:
            'Restrict the scan to elements within the subtree of this CSS selector. When the selector does not match, the response carries an empty interactive list and `notice` explains why.',
        },
        only_interactive: {
          type: 'boolean',
          description:
            'When true, skip the headings list and the visible-text dump. Use when you only need the interactive elements and selectors. Default false.',
        },
        exclude: {
          type: 'array',
          items: { type: 'string', enum: ['nav', 'footer', 'header', 'aside'] },
          description:
            'Drop interactive elements and headings that live inside any of these landmark tags. Common case: pass `["nav"]` to skip site-wide navigation that repeats on every page.',
        },
        max_interactive: {
          type: 'number',
          description:
            'Cap on the number of interactive entries returned. Default 120, hard ceiling 500.',
        },
      },
      required: ['tab_id'],
      additionalProperties: false,
    },
    doc: {
      purpose:
        'Inspect what is currently on the tab — title, URL, visible text, interactive elements with selectors. Supports optional filters to trim the response.',
      when_to_use: [
        'Before suggesting any code change to a UI component — verify the current state, do NOT speculate.',
        'Before clicking or typing, to find a stable selector for the target element.',
        'When the user reports a layout or visual issue and you need to ground your reasoning in what is actually rendered.',
        'When you only care about a region of the page, pass `within_selector` so the response stays small.',
      ],
      gotchas: [
        'The snapshot is the source of truth; the persistent map is a cache, not a substitute.',
        'Filters are applied in-page, so the dropped material never travels back — they are a token win, not a post-filter.',
        'Empty-string fields (`placeholder`, `aria_label`, etc.) are omitted from each entry. Read by key with optional-chaining or fall back to "".',
      ],
      example:
        'browser.snapshot({ tab_id: "tab_1", within_selector: "main", exclude: ["nav", "footer"] })',
    },
  },
  {
    name: 'browser.find',
    description:
      'Locate ONE interactive element by its visible text and return a stable selector plus viewport coordinates. The match is case-insensitive substring by default (set `exact:true` for full-string equality). Pass `role` to narrow to a specific ARIA role (`button`, `link`, `textbox`, `checkbox`, `tab`, `menuitem`) — without it the scan covers buttons, links, inputs, role-bearing elements, contenteditable nodes, and `[onclick]` divs (the "peruvian markup" case). Returns `{ matched: true, selector, coords:{x,y}, tag, text }` on a unique hit, `{ matched: false, reason: "not-found" }` when nothing matches, or `{ matched: false, reason: "multiple-matches", candidates: [{selector, text, tag}] }` (up to 5) when several elements match — pick one and try again with `exact:true` or a longer text. The returned `selector` uses the same heuristic as `browser.snapshot` (id → data-testid → aria-label → name → positional fallback), so a subsequent `browser.click` / `browser.type` works without re-querying.',
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: { type: 'string' },
        text: {
          type: 'string',
          description:
            'Visible text to match. Matched against innerText, aria-label, value, placeholder, or title — whichever the element exposes first. Case-insensitive substring by default.',
        },
        role: {
          type: 'string',
          enum: ['button', 'link', 'textbox', 'checkbox', 'tab', 'menuitem'],
          description:
            'Optional ARIA role to narrow the scan. Without role the scan covers all common interactive elements including [onclick] divs.',
        },
        exact: {
          type: 'boolean',
          description:
            'When true, the visible text must equal the needle (case-insensitive). Default false (substring).',
        },
      },
      required: ['tab_id', 'text'],
      additionalProperties: false,
    },
    doc: {
      purpose:
        'Find one interactive element by its visible text and return a stable selector plus viewport coordinates.',
      when_to_use: [
        'When `browser.snapshot` returned no `data-testid` and the agent only knows the user-facing label of the element it wants to act on.',
        'Before `browser.click` / `browser.type` on a page whose markup lacks stable selectors — `find` does the visibility + ARIA + role-aware lookup once and returns a selector reusable by the action tool.',
        'When the agent would otherwise write a hand-rolled `browser.evaluate` to grep textContent — `find` encapsulates the silently-failing patterns (missing visibility checks, `<div onclick>` not matching `button`, multi-match ambiguity).',
      ],
      gotchas: [
        'A `<div onclick>` IS considered clickable here — the broad selector set (`[onclick]`, `[role]`, `[tabindex]`, `[contenteditable]`) is the whole point. A naive `querySelectorAll("button")` misses these silently.',
        'On `multiple-matches`, the response includes up to 5 candidates with their selectors and snippets so the agent can disambiguate without another round-trip. Retry with `exact:true` or a longer/unique substring.',
        '`coords` are viewport-relative at the moment of the call. If the page reflows between `find` and `click`, the selector is the durable identifier — prefer it over coords.',
      ],
      example: 'browser.find({ tab_id: "tab_1", text: "Save changes", role: "button" })',
    },
  },
  {
    name: 'browser.canvas_screenshot',
    description:
      'Capture a `<canvas>` element from the connected tab as a PNG/JPEG and return it base64-encoded. Designed for pages whose visible UI is rendered to a canvas — Qt for WebAssembly (Venus OS, Felgo apps), WebGL games, custom rendering, etc. — where `browser.snapshot` and `browser.find` return nothing useful because there is no DOM inside the canvas to inspect. The finder traverses nested Shadow DOM roots, so a canvas hidden behind one or more `attachShadow` boundaries (very common in Qt-WASM apps) is still reachable without passing an explicit selector. Pass `selector` only when several canvases exist and you want a specific one; otherwise the first visible canvas wins. `region` crops to a sub-rect in canvas pixels — useful when you want to focus the LLM on one area and save tokens. Returns `{ ok: true, canvas_size, canvas_pixels, region, format, image_b64, taken_at_ms }` on success; `{ ok: false, reason: "no-canvas" }` when no canvas is found.',
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: { type: 'string' },
        selector: {
          type: 'string',
          description:
            'Optional CSS selector. When omitted, the finder picks the first visible canvas in the document, descending into Shadow DOM roots. Pass it only when several canvases coexist and you want to disambiguate. The selector is matched in the LIGHT DOM first; if it does not resolve to a canvas there, the finder still falls back to the visible-canvas heuristic.',
        },
        region: {
          type: 'object',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            w: { type: 'number' },
            h: { type: 'number' },
          },
          required: ['x', 'y', 'w', 'h'],
          additionalProperties: false,
          description:
            'Optional crop rectangle in canvas pixels (NOT CSS pixels — canvas pixels are `canvas.width` x `canvas.height`, which may differ from the rendered CSS size on HiDPI). Coordinates outside the canvas are clamped. Default: the full canvas.',
        },
        format: {
          type: 'string',
          enum: ['png', 'jpeg'],
          description:
            'Output format. PNG (default) is lossless and larger; JPEG is smaller but lossy and drops the alpha channel. Pick PNG for fidelity, JPEG when you need to ship many screenshots cheaply.',
        },
      },
      required: ['tab_id'],
      additionalProperties: false,
    },
    doc: {
      purpose:
        'Capture a canvas element as PNG/JPEG so the agent can SEE pages where the visible UI is rendered to a canvas (Qt-WASM, WebGL, custom rendering) and no DOM exists inside.',
      when_to_use: [
        'When `browser.snapshot` returns an empty `interactive` list and the page clearly has a UI on screen — that mismatch almost always means the UI is rendered into a `<canvas>`.',
        'When the user mentions Victron VRM Remote Console, Venus OS, Felgo apps, WebGL games, or any "the UI is one big rectangle" page.',
        'Before deciding whether the agent can act on a canvas page. Reading is free with this tool; clicking on a canvas needs CDP-level input dispatch and is not yet exposed.',
      ],
      gotchas: [
        'Qt-WASM and similar runtimes consume only "real" browser input (events with `isTrusted: true`). `browser.click` / `browser.type` / synthetic `dispatchEvent` from `browser.evaluate` will not interact with the canvas content. This tool is READ-ONLY by design.',
        'For pure WebGL canvases compiled without `preserveDrawingBuffer: true`, `toDataURL` may return a blank image — the framebuffer is cleared between frames. Qt-WASM enables preservation, so VRM Remote Console / Venus OS work. If you get a blank capture on a known-rendered canvas, that is the cause.',
        'Coordinates in `region` are in CANVAS pixels, not CSS pixels. On HiDPI displays these differ — `canvas_size` returns CSS dimensions, `canvas_pixels` returns the backing store size, divide accordingly.',
        'The canvas content can mutate between calls without any DOM signal (Qt repaints, animation frames, internal scrolling). Take a fresh screenshot before each decision; do not reuse a screenshot across many turns.',
      ],
      example:
        'browser.canvas_screenshot({ tab_id: "tab_1" })  // first visible canvas, full size, PNG',
    },
  },
  {
    name: 'browser.console',
    description:
      'Return recent console messages (log, info, warn, error) from the connected tab since it was attached. Rolling buffer (last 200).',
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: { type: 'string' },
        level: { type: 'string', enum: ['log', 'info', 'warn', 'error', 'debug'] },
      },
      required: ['tab_id'],
      additionalProperties: false,
    },
    doc: {
      purpose: 'Read recent console messages from the tab — log, info, warn, error, debug.',
      when_to_use: [
        'When the user says "the button does not work" or "something is broken" — check console errors first.',
        'After an action to see what the page logged in response.',
      ],
      gotchas: [
        'Rolling buffer of 200 entries — older logs are dropped. Snapshot console output early in a long session.',
      ],
    },
  },
  {
    name: 'browser.network',
    description:
      'Return recent network requests from the connected tab (rolling buffer, last 200). Includes request_id, method, url, status, mime, size, timing. Use browser.network_body to fetch the body of a specific request.',
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: { type: 'string' },
        url_filter: { type: 'string', description: 'Optional substring to filter request URLs.' },
      },
      required: ['tab_id'],
      additionalProperties: false,
    },
    doc: {
      purpose: 'List recent network requests with status, mime, size and timing.',
      when_to_use: [
        'When the user reports a failed API call, slow request, or a 4xx/5xx response in the page.',
        'To verify whether a request fired after a click or form submission.',
      ],
      gotchas: [
        'Rolling buffer of 200 entries — pair with url_filter to narrow the result.',
        'Use browser.network_body with the request_id to fetch a specific response body.',
      ],
    },
  },
  {
    name: 'browser.network_body',
    description:
      'Fetch the response body of a single network request by request_id (from browser.network).',
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: { type: 'string' },
        request_id: { type: 'string' },
      },
      required: ['tab_id', 'request_id'],
      additionalProperties: false,
    },
    doc: {
      purpose: 'Fetch the response body for one request_id returned by browser.network.',
      when_to_use: [
        'After identifying a suspicious request in browser.network, to see what the server returned.',
      ],
    },
  },
  {
    name: 'browser.wait_for',
    description:
      'Wait for a condition to become true on the page before continuing. Pick exactly ONE target: (a) `selector` plus an optional `condition` of visible|hidden|attached|detached (default visible), (b) `expression` — any JS that should become truthy, or (c) `network_url` — a substring that a completed network request URL must contain. Returns { matched, elapsed_ms, checks, reason? }. `matched: false` is NOT an error — the caller decides whether to proceed or branch. Polls every `poll_interval_ms` (default 100, range 50–1000) until `timeout_ms` (default 5000, capped at 30000). This is a read tool and does not require a claim — multiple agents can wait on the same tab in parallel.',
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: { type: 'string' },
        selector: {
          type: 'string',
          description:
            'CSS selector. Use with condition. Mutually exclusive with expression and network_url.',
        },
        condition: {
          type: 'string',
          enum: ['visible', 'hidden', 'attached', 'detached'],
          description:
            'For selector mode. visible = exists + non-zero box + opacity > 0; hidden = inverse; attached = exists in DOM; detached = does not exist. Default visible.',
        },
        expression: {
          type: 'string',
          description:
            'JavaScript expression evaluated each poll. wait_for stops as soon as Boolean(expression) is true. Mutually exclusive with selector and network_url.',
        },
        network_url: {
          type: 'string',
          description:
            'Case-insensitive substring matched against the URL of completed network requests in the rolling buffer. wait_for stops when at least one matching request has finished. Mutually exclusive with selector and expression.',
        },
        timeout_ms: {
          type: 'number',
          description:
            'Max time to wait in ms. Default 5000, capped at 30000. Past the cap, split the flow — the bridge does not park requests longer than that.',
        },
        poll_interval_ms: {
          type: 'number',
          description: 'Time between checks in ms. Default 100, clamped to [50, 1000].',
        },
      },
      required: ['tab_id'],
      additionalProperties: false,
    },
    doc: {
      purpose:
        'Block until a selector matches a condition, a JS expression is truthy, or a network request URL completes.',
      when_to_use: [
        'After clicking a button that triggers an async load — wait for the spinner to disappear or the result element to appear.',
        'Before snapshot/click on a SPA route that mounts content after navigation.',
        'When you depend on a backend response — wait for the network request URL to land before reading the DOM.',
      ],
      gotchas: [
        'matched: false is not an error. Read it and decide — many flows have a plan B when the condition does not happen.',
        'expression mode runs arbitrary JS via Runtime.evaluate. Subject to the same disabled-list as browser.evaluate would be if you want to gate it.',
        'network_url matches against the rolling buffer of recent requests (last 200). If the request happened before wait_for started, it still counts as matched — wait_for has no concept of "fresh" requests.',
      ],
      example:
        'browser.wait_for({ tab_id: "tab_1", selector: "[data-testid=loaded]", condition: "visible", timeout_ms: 3000 })',
    },
  },
  {
    name: 'browser.wait_for_tab',
    description:
      'Wait for a new tab opened by a previous action on a connected tab. The extension auto-emits `tab-created` events to the bridge stream whenever a tab connected to browser-link spawns a new one (via window.open, target=_blank, etc.). This tool polls that stream until it sees a matching `tab-created` event whose `opened_from` equals the `opened_from` you passed (the tab_id of the action originator). On match, browser-link automatically claims the new tab under YOUR agent_id — the waiting call IS the explicit intent — and returns its tab_id ready to use. Optional `url_substring` narrows the match (case-insensitive). Returns `{ matched, tab_id?, url?, elapsed_ms, checks, claimed?, claim_conflict?, reason? }`. `matched: false` is NOT an error — the action may have failed to open a tab, or the tab opened too slowly.',
    inputSchema: {
      type: 'object',
      properties: {
        opened_from: {
          type: 'string',
          description:
            'The browser-link tab_id whose action is expected to spawn the new tab. Get this from your current tab before clicking the link / button that triggers the new tab.',
        },
        url_substring: {
          type: 'string',
          description:
            'Optional case-insensitive substring the new tab URL must contain. Useful when several tabs could spawn and you want a specific one.',
        },
        timeout_ms: {
          type: 'number',
          description: 'Max wait in ms. Default 10000, capped at 60000.',
        },
      },
      required: ['opened_from'],
      additionalProperties: false,
    },
    doc: {
      purpose:
        'Block until a new tab spawned by an action on a connected tab appears in the bridge, then auto-claim it under the calling agent.',
      when_to_use: [
        'Right after clicking a link with target="_blank" or a button known to call window.open.',
        'Before reading the content of a popup-style auth tab you triggered.',
      ],
      gotchas: [
        'Only matches tabs whose opener is a tab already connected to browser-link. A bare window.open without an opener relation will not match.',
        'Auto-claim is part of the contract — if another agent races and claims first, you get matched:true with claimed:false and a claim_conflict description. Decide if you want to retry or surface to the user.',
        'matched:false often means the underlying action did not open a tab. Inspect browser.events for diagnostic context.',
        'If the action you are waiting for is a click on a button whose onClick calls window.open(), do NOT use browser.click — Chrome treats CDP `Input.dispatchMouseEvent` as a non-user-gesture for popups and the window silently never opens. Use browser.evaluate({ expression: "document.querySelector(\'<selector>\').click()" }) instead; that path goes through Runtime.evaluate with userGesture:true and Chrome accepts it.',
      ],
      example:
        'browser.wait_for_tab({ opened_from: "tab_1", url_substring: "/oauth/", timeout_ms: 8000 })',
    },
  },
  {
    name: 'browser.dialog_respond',
    description:
      'Respond to a pending native JavaScript dialog (alert / confirm / prompt / beforeunload) on a connected tab. browser-link does NOT auto-dismiss dialogs — when a dialog opens, the page JS thread freezes and the bridge emits a `dialog-opening` event in browser.events with `{ tab_id, type, message, default_prompt }`. The agent reads that, decides what to answer based on the page flow, and calls this tool. `accept:true` is the "OK" path (submit for prompt, continue for beforeunload); `accept:false` is "Cancel". `prompt_text` is only used for `prompt` type — ignored otherwise. After the response, the page JS thread resumes and a `dialog-closed` event lands on the stream.',
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: { type: 'string' },
        accept: {
          type: 'boolean',
          description:
            'true = OK / continue (in prompt: submit prompt_text). false = Cancel / dismiss.',
        },
        prompt_text: {
          type: 'string',
          description:
            'Text to submit when the dialog is a prompt and accept=true. Ignored for alert/confirm/beforeunload.',
        },
      },
      required: ['tab_id', 'accept'],
      additionalProperties: false,
    },
    doc: {
      purpose:
        'Answer a native alert/confirm/prompt that is currently blocking a connected tab. Reads from the dialog-opening event in browser.events for context.',
      when_to_use: [
        'After browser.events reports a dialog-opening entry and the tab JS is paused waiting for an answer.',
        'When a click you just dispatched is expected to surface a confirm() (delete confirmation, payment confirm).',
      ],
      gotchas: [
        'Native dialogs are NOT in the DOM — you cannot dismiss them with browser.click. This is the only way to answer them.',
        'While a dialog is open, browser.evaluate / browser.snapshot / browser.wait_for (expression mode) hang on the tab. Respond first, then resume.',
        'For beforeunload, accept:true allows navigation, accept:false stays on the page.',
      ],
      example: 'browser.dialog_respond({ tab_id: "tab_1", accept: true, prompt_text: "Hello" })',
    },
  },
  {
    name: 'browser.set_permission',
    description:
      'Grant or deny a browser permission for a given origin BEFORE the page asks for it. Backed by `chrome.contentSettings` (the surface exposed to MV3 extensions — `Browser.setPermission` would need a browser-level CDP target that `chrome.debugger` does not give us). Subsequent page calls to navigator.geolocation / Notification.requestPermission / navigator.mediaDevices.getUserMedia / etc. then return the chosen state without surfacing a native prompt. Scope is per-ORIGIN (URL pattern `<origin>/*`), persistent until you call again or the user clears settings.',
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: {
          type: 'string',
          description:
            'A connected tab — used to route the call through its debugger session. The permission itself is applied per ORIGIN, not per tab.',
        },
        origin: {
          type: 'string',
          description:
            'Full origin (eg https://example.com or http://127.0.0.1:7373) the permission applies to. Must match exactly what the page reports as its origin.',
        },
        name: {
          type: 'string',
          enum: [
            'geolocation',
            'notifications',
            'camera',
            'microphone',
            'clipboardReadWrite',
            'clipboardSanitizedWrite',
            'sensors',
          ],
          description:
            'Permission name. These are the names `chrome.contentSettings` exposes in MV3. Other CDP permission names (midi, paymentHandler, windowManagement, etc.) are NOT supported by this surface — calling with one of those returns ok:false with a descriptive error.',
        },
        state: {
          type: 'string',
          enum: ['granted', 'denied', 'prompt'],
          description:
            'granted (chrome.contentSettings allow) = page gets the resource silently. denied (block) = page receives a denial silently. prompt (ask) = restore default Chrome behaviour, the page will see the native prompt.',
        },
      },
      required: ['tab_id', 'origin', 'name', 'state'],
      additionalProperties: false,
    },
    doc: {
      purpose:
        'Pre-set a browser permission for an origin so the page API responds silently — no native prompt surfaces.',
      when_to_use: [
        'Before clicking a button known to request geolocation / notifications / camera / etc. — pre-grant or pre-deny so the flow does not stall on a prompt the agent cannot click.',
        'When you intentionally want a page to think permission was denied (eg. testing the no-permission code path).',
      ],
      gotchas: [
        'Permissions are per-ORIGIN, NOT per-tab. Setting `granted` for https://x.com affects every tab the user opens on that origin until you reset (state: "prompt").',
        'MV3 limitation: only the names in the enum are supported. Anything else (midi, paymentHandler, windowManagement, etc.) returns ok:false because chrome.contentSettings does not expose them.',
        'Both `clipboardReadWrite` and `clipboardSanitizedWrite` map to the single `clipboard` content setting — there is no finer-grained read-vs-write distinction in this surface.',
        'Reset to default with state:"prompt" when you are done if the user expects Chrome to ask again next time.',
      ],
      example:
        'browser.set_permission({ tab_id: "tab_1", origin: "https://maps.example.com", name: "geolocation", state: "granted" })',
    },
  },
  {
    name: 'browser.click',
    description:
      'Click an element by CSS selector in the connected tab. The selector usually comes from browser.snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: { type: 'string' },
        selector: { type: 'string' },
      },
      required: ['tab_id', 'selector'],
      additionalProperties: false,
    },
    doc: {
      purpose: 'Click an element identified by a CSS selector.',
      when_to_use: [
        'After browser.snapshot returned a selector for the element the user asked you to interact with.',
      ],
      gotchas: [
        'Never click a selector you have not just verified via browser.snapshot or browser.map.recall — speculating wastes a turn.',
        'Auto-claims the tab on first use in multi-agent mode.',
      ],
    },
  },
  {
    name: 'browser.type',
    description:
      'Focus an input by CSS selector and type text into it. If clear=true, clears the current value first.',
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: { type: 'string' },
        selector: { type: 'string' },
        text: { type: 'string' },
        clear: { type: 'boolean', default: false },
      },
      required: ['tab_id', 'selector', 'text'],
      additionalProperties: false,
    },
    doc: {
      purpose: 'Focus an input element by selector and type text into it.',
      when_to_use: [
        'After browser.snapshot returned a selector for the input the user wants filled.',
      ],
      gotchas: [
        'Pass clear:true when you need to replace the current value instead of appending to it.',
      ],
    },
  },
  {
    name: 'browser.drag',
    description:
      'Drag an element from a source to a destination. Provide each end as either a CSS selector OR a viewport coordinate pair (x,y). The drag is interpolated over duration_ms (default 1500) so you can watch the cursor traverse the path — this also helps activation-by-distance constraints in pointer-based libraries. Auto-detects HTML5 native drag (element.draggable, <img>, <a href>) vs pointer-based drag (dnd-kit and similar). For HTML5 it uses Input.setInterceptDrags + Input.dragIntercepted + Input.dispatchDragEvent. For pointer-based it interpolates Input.dispatchMouseEvent only. setInterceptDrags is always cleared in finally. Both source and destination must be visible in the viewport simultaneously — drag does NOT scroll between them. Returns { from, to, duration_ms_actual, drag_mode: "html5"|"pointer", events_fired }.',
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: { type: 'string' },
        from_selector: {
          type: 'string',
          description: 'CSS selector of the source element. Mutually exclusive with from_x/from_y.',
        },
        from_x: {
          type: 'number',
          description:
            'Viewport x of the source point. Use with from_y when there is no stable selector (canvas, map, etc).',
        },
        from_y: { type: 'number', description: 'Viewport y of the source point.' },
        to_selector: {
          type: 'string',
          description:
            'CSS selector of the destination element. Mutually exclusive with to_x/to_y.',
        },
        to_x: { type: 'number', description: 'Viewport x of the destination point.' },
        to_y: { type: 'number', description: 'Viewport y of the destination point.' },
        duration_ms: {
          type: 'number',
          description:
            'Total movement duration in ms. Default 1500. Lower values reduce visual feedback and may miss activation thresholds in some pointer libs.',
        },
        hold_before_move_ms: {
          type: 'number',
          description:
            'Time to stay pressed at the source before starting the move. Default 0. Useful for handlers that require a press-and-hold gesture.',
        },
        hold_before_release_ms: {
          type: 'number',
          description:
            'Time to stay at the destination before releasing. Default 0. Useful when the drop target validates asynchronously.',
        },
      },
      required: ['tab_id'],
      additionalProperties: false,
    },
    doc: {
      purpose:
        'Drag an element to another element or to a coordinate, with a visible interpolated path.',
      when_to_use: [
        'Reordering a sortable list, moving cards between columns, dropping items onto targets.',
        'Painting on a canvas by dragging a swatch, or any other coordinate-based drop.',
        'When click+type cannot express the interaction — drag is its own gesture.',
      ],
      gotchas: [
        'Both endpoints must be visible in the viewport at the same time — the tool does not scroll between them. If one is offscreen, scroll first (via evaluate) or pass viewport coords.',
        'Default duration is 1500ms so a human watching can follow the cursor. Drop it lower only when you are sure no library has a movement-based activation constraint.',
        'drag_mode in the response tells you whether HTML5 native drag (dragstart/drop) or pointer-only events fired — use it to diagnose silently-failing drops.',
      ],
      example:
        'browser.drag({ tab_id: "tab_1", from_selector: "[data-testid=card-1]", to_selector: "[data-testid=column-done]" })',
    },
  },
  {
    name: 'browser.evaluate',
    description:
      'Run a JavaScript expression in the page context and return its result. Use an IIFE with return if you need multi-step logic.',
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: { type: 'string' },
        expression: { type: 'string' },
      },
      required: ['tab_id', 'expression'],
      additionalProperties: false,
    },
    doc: {
      purpose: 'Execute a JavaScript expression in the page and return its value.',
      when_to_use: [
        'When snapshot/click/type are not expressive enough — pulling a computed value, reading a JS variable, or invoking page APIs.',
      ],
      gotchas: ['Wrap multi-step logic in an IIFE that returns the value you want.'],
    },
  },
  {
    name: 'browser.events',
    description:
      'Return recent bridge lifecycle events: primary-elected (a new browser-link primary started), tab-registered / tab-disconnected (Chrome tabs joined/left), tab-renamed (the same Chrome tab got a new tab_id, usually after a primary swap). Call this when you get "Tab not connected: …" so you can pick up the new tab_id and resume work. Returns { events, latest_id } — pass latest_id back as since_id next time to get only new entries.',
    inputSchema: {
      type: 'object',
      properties: {
        since_id: {
          type: 'number',
          description: 'Only return events with id > since_id. Omit to get the most recent slice.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of events to return (default 20, max 200).',
        },
      },
      additionalProperties: false,
    },
    doc: {
      purpose:
        'Inspect bridge lifecycle events — primary elections, tab registrations, tab renames.',
      when_to_use: [
        'When a tool call returns "Tab not connected: …" — look for a tab-renamed entry to find the new tab_id.',
        'To diagnose why a tab disappeared between calls.',
      ],
      gotchas: [
        'Pass latest_id from the previous call as since_id to page through new entries efficiently.',
      ],
    },
  },
  {
    name: 'browser.reset',
    description:
      'Soft-reset the bridge state. Drops every connected tab session, releases every claim, and clears the in-memory event log — but does NOT kill the MCP server itself. The user has to re-press Connect in the extension popup for each tab they want back. Use this when the bridge state looks inconsistent (stale tab_ids that browser.events does not explain, tab.click that hangs, claims you cannot release through normal means) and you are sure a clean slate is the right move.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    doc: {
      purpose:
        'Soft-reset the bridge: drop tab sessions + claims + event log, keep the MCP server alive.',
      when_to_use: [
        'Bridge state looks inconsistent (stale tab_ids, hung action tools, claims you cannot release).',
        'You explicitly want to start the bridge state from scratch without killing the MCP server.',
      ],
      gotchas: [
        'This drops every tab the user had connected — they will need to re-press Connect in the extension popup for each one.',
        'Use sparingly. Most "tab not connected" cases resolve via browser.events showing a tab-renamed entry, not via reset.',
      ],
    },
  },
];
