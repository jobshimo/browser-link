/**
 * Build the MCP `initialize.instructions` payload from the structured `doc`
 * blocks each tool definition carries. Keeping the per-tool copy beside the
 * tool definition (in `browser-definitions.ts` and `map/tools.ts`) prevents
 * drift between the schema and the human-facing documentation.
 *
 * `SERVER_INSTRUCTIONS` is computed once at module load and exported as a
 * plain string so the existing consumers (`server.ts`, `bridge/server.ts`)
 * keep working without changes.
 */

import { BROWSER_TOOL_DEFINITIONS } from './browser-definitions.js';
import { MAP_TOOL_DEFINITIONS } from '../map/tools.js';
import type { ToolDefinition } from './types.js';

/** Stable preamble — explains what the bridge is, where state lives, and
 * what the agent must NOT do. Lives here (not in a tool doc) because it is
 * cross-cutting context, not tied to any one tool. */
const PREAMBLE = `browser-link bridges Claude Code to the Chrome tabs the user has
explicitly connected through the companion extension, and ships a
persistent UI map backed by a local SQLite DB. The data dir resolves
per-OS via env-paths ($XDG_DATA_HOME/browser-link on Linux,
~/Library/Application Support/browser-link on macOS, %APPDATA%/browser-link
on Windows). Override with $BROWSER_LINK_DATA_DIR. The map is private
and per-machine; never persisted in any repo.

## Reflex protocol (ALWAYS ACTIVE)

Tools you have here see only Chrome tabs the user explicitly connected
through the companion extension. Never reason about state you cannot
see — call \`browser.list_tabs\` BEFORE answering when the user mentions
a UI element, a web app, a URL, a broken layout, "the page", or asks
"does X work". Take a \`browser.snapshot\` before suggesting any UI code
change. If a call returns "Tab not connected", call \`browser.events\`
to find the new tab_id before retrying. After a non-trivial flow worked
end-to-end, persist UI structure (NEVER domain data) with
\`browser.map.save\`. When \`list_tabs\` shows a \`map\` hint on a tab
(\`{ app_key, entries, flows }\`), call \`browser.map.recall\` BEFORE
snapshotting — the map already has selectors, gotchas or flow recipes
for that origin, so recall first instead of rediscovering them from
scratch.

## Sharing tabs with other agents (multi-agent mode)

Several MCP clients may share one bridge. To stop two agents fighting
over the same Chrome tab, a cooperative claim layer is in place:

- Action tools (\`browser.click\`, \`browser.type\`, \`browser.navigate\`,
  \`browser.evaluate\`) auto-claim a free tab on first use. If another
  agent holds the tab, they return an error naming the owner — do NOT
  retry blindly; ask the user whose tab it should be, or use a
  different tab.
- Read tools (\`browser.snapshot\`, \`browser.state\`, \`browser.console\`,
  \`browser.network\`, \`browser.network_body\`, \`browser.events\`,
  \`browser.ping\`) ignore claims.
- Use \`browser.claim_tab\` with a stable \`label\` ("claude-code",
  "opencode") to reserve a tab before a multi-step flow; release with
  \`browser.release_tab\` (or let the inactivity TTL handle it).

The label is display only — security relies on the IPC session id
(kernel-vetted), not on what an agent calls itself. When you get a
claim-conflict error: do NOT spin-retry. Either work on a different tab
from \`list_tabs\`, or surface the conflict to the user.

## cdp-direct tabs (optional, off by default, human-gated)

\`browser.list_tabs\` may show tabs whose \`tab_id\` starts with \`cdp:\` and
carry \`transport: "cdp"\` — the server reached them directly over Chrome's
remote-debugging protocol instead of through the extension. This ONLY
happens when the user has BOTH enabled cdp-direct AND granted a live,
time-boxed permission — you cannot request, enable, or grant this
yourself. Every \`browser.*\` tool works on a \`cdp:\` tab exactly like on an
extension tab, EXCEPT \`browser.drag\` (standalone and as a
\`browser.flow\` drag step), \`browser.console\`,
\`browser.network\`, \`browser.network_body\`, \`browser.canvas_screenshot\`,
\`browser.dialog_respond\`, \`browser.set_permission\` and
\`browser.wait_for_tab\`, which are not implemented for this transport yet —
those calls fail with a clear error naming the extension as the fallback.
If any tool call on a \`cdp:\` tab fails with "cdp-direct is disabled" or
"cdp-direct requires an active grant", that is the two-step permission gate
talking, not a bug — relay the exact suggested command
(\`browser-link config set cdp-direct.enabled true\` or
\`browser-link cdp allow\`) to the user; there is no way around it from here.

## Identifying the app

- \`origin\` = scheme://host:port of the tab.
- \`app_key\` distinguishes apps that share an origin over time. On
  first save you may omit it; it will be derived from the page title
  (slugified). Use \`browser.map.rename_app\` if that initial guess is
  poor.

The live snapshot is always the source of truth. The persistent map is
a cache of navigation, not a substitute.

## Replaying a saved flow recipe

\`browser.map.save\` can persist named flow recipes (\`flows: [{ name,
description?, steps }]\`) alongside selectors/gotchas — \`steps\` follows
the EXACT \`browser.flow\` step grammar and is validated with the same
rules. \`browser.map.recall\` returns the app's saved flows
(\`name\`, \`description\`, \`steps\`, \`use_count\`). The pattern:
recall → ADAPT the steps (substitute placeholder text like
\`type text "<QUERY>"\` for the real value the user asked for) →
\`browser.flow\` with the adapted steps. Never replay a saved flow
verbatim when it contains a placeholder — substitute first. This is the
SAME privacy rule as every other map entry: flows store UI STRUCTURE
only, never domain data (real names, IDs, dates, message content) —
placeholders exist precisely so a flow can be saved without ever writing
that data to disk.

## Token-efficient patterns (READ THIS BEFORE REACHING FOR EVALUATE)

\`browser.evaluate\` is the all-purpose escape hatch. Reach for it only
when no dedicated tool fits — every dedicated tool below is cheaper in
tokens AND more reliable than a hand-rolled expression.

- **Any multi-step interaction** (find a target, act on it, wait, act
  again) → \`browser.flow({ steps: [...] })\` is now the DEFAULT, not a
  fallback. A sequence like find → click → wait_for → type → press used
  to cost 5-10+ separate MCP round trips — each one a full LLM inference
  — and now costs ONE \`browser.flow\` call (two if a step fails and you
  need a corrective follow-up). A \`find\` step's resolved selector
  becomes the implicit target for the very next click/type/press step
  that omits \`selector\`, so you never have to copy a selector from one
  call into the next by hand. Repeated drag-and-drop (card-matching
  exercises, sortable lists) batches the same way: N \`drag\` steps —
  same params as \`browser.drag\`, endpoints always explicit, drag stays
  OUT of the implicit-target chain — in ONE flow instead of N
  \`browser.drag\` calls (extension tabs only; a drag step on a \`cdp:\`
  tab fails at that step). Flow is strictly sequential and fails fast
  on the first bad step, returning a focused \`recovery_snapshot\` so you
  do not need a follow-up \`browser.snapshot\` to see where it stopped.
  Reach for individual click/type/press/find/wait_for/drag calls only
  when you need to branch on an intermediate result.
- **Finding an element by visible text** → call \`browser.find\` (not
  \`browser.evaluate\` with a textContent grep). \`find\` covers
  \`<div onclick>\` and other "no testid" markup that a naive
  \`querySelectorAll('button')\` MISSES SILENTLY, applies visibility +
  ARIA checks consistently, returns a stable selector + coords, and on
  multi-match returns up to 5 candidates with snippets for
  disambiguation. The hand-rolled version forgets at least one of
  these every time.
- **Trimming snapshot size** → pass filters to \`browser.snapshot\`:
  \`within_selector\` restricts the scan to a subtree, \`only_interactive\`
  skips headings + visible text, \`exclude:["nav","footer"]\` drops
  repeated landmarks, \`max_interactive\` overrides the cap of 120.
  Cuts token cost on the most-called tool; not hackeable from the
  client side (the filtering happens in-page).
- **Quick orientation without a full snapshot** → \`browser.state\`. Returns
  \`{ url, title, focused?, dialogs?, scroll?, viewport }\` — cheaper than
  \`browser.snapshot\` when you only need to know where you are (is a
  dialog open, what has focus, did the page scroll) before deciding
  whether a full snapshot is even needed.
- **\`browser.find\` returned \`not-found\`** → read \`near_misses\` (up to 3
  ranked candidates) before giving up or re-snapshotting blind. When
  \`error\` names a role mismatch (text exists, wrong role), drop \`role\`
  or match the role the closest near-miss actually has.
- **Reading N values** → ONE \`browser.evaluate\` that returns an
  object: \`(() => ({ a: document.querySelector('#a').value, b: ... }))()\`.
  Never call \`browser.evaluate\` N times in a row to read N values.
- **Scrolling** → \`browser.evaluate\` with \`pane.scrollTop = N\` or
  \`el.scrollIntoView({block:'center'})\`. No dedicated tool needed.
- **Special keys (Enter / Tab / Escape / arrow keys / shortcuts)** →
  \`browser.press\`, NOT \`browser.evaluate\` with a synthetic
  \`KeyboardEvent\`. \`el.dispatchEvent(new KeyboardEvent(...))\` produces
  \`isTrusted:false\` events that rich text editors, autocompletes, and
  non-DOM runtimes (Qt-WASM, WebGL) silently ignore. \`browser.press\`
  dispatches a real CDP \`Input.dispatchKeyEvent\` sequence
  (\`isTrusted:true\`) — pass \`key\` ("Enter", "ArrowUp", a single
  character, …) and optional \`modifiers\` for shortcuts (Ctrl+A, Cmd+S).
  For TYPING text into an input, use \`browser.type\` — it goes through
  the native setter so controlled components update their state.
  \`dispatchEvent\` on \`value\` does NOT.
- **Waiting for the result of an action** → pass \`settle_ms\` to
  \`browser.click\` / \`.type\` / \`.press\` (default 150, max 2000)
  instead of a follow-up \`browser.wait_for\` + \`browser.snapshot\`. The
  action waits for the page to go quiet — no DOM mutations for
  \`settle_ms\` — and returns a \`settle\` object
  (\`{ settled, duration_ms, mutation_count, url_changed?, focus_moved? }\`).
  Settle proves QUIET, not EFFECT: mutations completing before the
  observer installs (right after dispatch) and async reactions starting
  after the quiet window are both invisible — \`mutation_count: 0\` does
  NOT mean the action did nothing. Reach for \`wait_for\` when you need a
  SPECIFIC condition (a particular selector, network request, or
  expression), not just "did anything change".
- **Paging through \`browser.events\`** → keep \`lastId = result.latest_id\`
  in your working notes and pass it as \`since_id\` on the next call.
  That is one variable. The server does not maintain per-agent cursors.

## Pages rendered to a canvas (Qt-WASM, WebGL, DOMless UIs)

Some pages render their entire UI to a single \`<canvas>\` element — Victron
VRM Remote Console, Venus OS, Felgo apps, WebGL games, custom rendering
engines. On those pages \`browser.snapshot\` returns an empty
\`interactive\` list and \`browser.find\` finds nothing, because the visible
UI lives inside the canvas's pixel buffer, not in the DOM.

When you see that mismatch (clear UI on screen, nothing in snapshot),
reach for \`browser.canvas_screenshot\`. It returns the canvas as PNG/JPEG
base64 so you can SEE the page as a vision input. The finder walks
nested Shadow DOM roots automatically — Qt-WASM hides its canvas behind
two layers of \`attachShadow\` and a no-selector call still finds it.

Acting on a canvas page is NOT yet possible from this server.
Qt-WASM and similar runtimes only accept \`isTrusted: true\` input from
the browser kernel; \`browser.click\` / \`browser.type\` / synthetic
\`dispatchEvent\` go straight through without effect. Take screenshots,
reason about what is on screen, ask the user to act when interaction
is needed.`;

/** Render a single tool's documentation as a markdown section. Skips
 * tools without a `doc` block (the structured shape is opt-in for now
 * so future contributors can stage the migration tool-by-tool). */
function renderTool(def: ToolDefinition): string | null {
  if (!def.doc) return null;
  const { purpose, when_to_use, gotchas, example } = def.doc;
  const lines: string[] = [`### ${def.name}`, '', purpose, '', '**When to use:**'];
  for (const w of when_to_use) lines.push(`- ${w}`);
  if (gotchas && gotchas.length > 0) {
    lines.push('', '**Gotchas:**');
    for (const g of gotchas) lines.push(`- ${g}`);
  }
  if (example !== undefined && example !== '') {
    lines.push('', '**Example:**', '```', example, '```');
  }
  return lines.join('\n');
}

/** Generate the SERVER_INSTRUCTIONS string from the tool definitions.
 * Exported for tests and for any future caller that needs to re-render
 * the string after a hot-reload or runtime tool registration. */
export function buildServerInstructions(): string {
  const all: ToolDefinition[] = [...BROWSER_TOOL_DEFINITIONS, ...MAP_TOOL_DEFINITIONS];
  const sections: string[] = [PREAMBLE, '', '## Tools'];
  for (const def of all) {
    const rendered = renderTool(def);
    if (rendered) {
      sections.push('', rendered);
    }
  }
  return sections.join('\n');
}

/** Usage protocol pushed to the MCP client on `initialize`. Plain string,
 * generated from the per-tool `doc` blocks at module load. */
export const SERVER_INSTRUCTIONS = buildServerInstructions();
