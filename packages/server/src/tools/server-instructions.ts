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
\`browser.map.save\`.

## Sharing tabs with other agents (multi-agent mode)

Several MCP clients may share one bridge. To stop two agents fighting
over the same Chrome tab, a cooperative claim layer is in place:

- Action tools (\`browser.click\`, \`browser.type\`, \`browser.navigate\`,
  \`browser.evaluate\`) auto-claim a free tab on first use. If another
  agent holds the tab, they return an error naming the owner — do NOT
  retry blindly; ask the user whose tab it should be, or use a
  different tab.
- Read tools (\`browser.snapshot\`, \`browser.console\`, \`browser.network\`,
  \`browser.network_body\`, \`browser.events\`, \`browser.ping\`) ignore
  claims.
- Use \`browser.claim_tab\` with a stable \`label\` ("claude-code",
  "opencode") to reserve a tab before a multi-step flow; release with
  \`browser.release_tab\` (or let the inactivity TTL handle it).

The label is display only — security relies on the IPC session id
(kernel-vetted), not on what an agent calls itself. When you get a
claim-conflict error: do NOT spin-retry. Either work on a different tab
from \`list_tabs\`, or surface the conflict to the user.

## Identifying the app

- \`origin\` = scheme://host:port of the tab.
- \`app_key\` distinguishes apps that share an origin over time. On
  first save you may omit it; it will be derived from the page title
  (slugified). Use \`browser.map.rename_app\` if that initial guess is
  poor.

The live snapshot is always the source of truth. The persistent map is
a cache of navigation, not a substitute.

## Token-efficient patterns (READ THIS BEFORE REACHING FOR EVALUATE)

\`browser.evaluate\` is the all-purpose escape hatch. Reach for it only
when no dedicated tool fits — every dedicated tool below is cheaper in
tokens AND more reliable than a hand-rolled expression.

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
- **Reading N values** → ONE \`browser.evaluate\` that returns an
  object: \`(() => ({ a: document.querySelector('#a').value, b: ... }))()\`.
  Never call \`browser.evaluate\` N times in a row to read N values.
- **Scrolling** → \`browser.evaluate\` with \`pane.scrollTop = N\` or
  \`el.scrollIntoView({block:'center'})\`. No dedicated tool needed.
- **Special keys (Enter / Tab / Escape / arrow keys)** →
  \`browser.evaluate\` with
  \`el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))\`.
  Vanilla handlers AND React's delegated root handlers (React 17+)
  pick up bubbled dispatched events. For TYPING text into an input,
  use \`browser.type\` — it goes through the native setter so controlled
  components update their state. \`dispatchEvent\` on \`value\` does NOT.
- **Paging through \`browser.events\`** → keep \`lastId = result.latest_id\`
  in your working notes and pass it as \`since_id\` on the next call.
  That is one variable. The server does not maintain per-agent cursors.`;

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
