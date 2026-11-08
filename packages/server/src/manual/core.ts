/**
 * The hand-written core of the agent manual: the part every agent must see
 * before its first browser call. It is rendered first in the MCP
 * `initialize.instructions` (hosts truncate that text; Claude Code cut it at
 * ~4,090 characters) and first in the installed instructions block, so it is
 * pinned at 3,800 characters by `manual.test.ts`.
 *
 * Rule for editing: every line must change what the agent does next. Depth
 * lives in the per-tool `doc` blocks and in `topics.ts`, reachable through
 * `browser.manual`.
 *
 * The bilingual phrases in the trigger list are DATA (what users actually
 * type), not instructions; tests pin them verbatim.
 */

import { TOPIC_NAMES } from './topics.js';

const CORE_LINES: readonly string[] = [
  '## browser-link — reflex protocol (ALWAYS ACTIVE)',
  '',
  '`browser.*` tools see only the Chrome tabs the user connected through the companion extension. Never reason about page state you have not seen.',
  '',
  '### TRIGGER LIST — call before responding when ANY apply',
  '',
  'User mentions any of these (English or Spanish):',
  '- "the button doesn\'t work" / "no anda el botón" / "no funciona X"',
  '- "broken layout" / "está roto" / "se ve mal" / "looks wrong"',
  '- "check if X works" / "fíjate si anda X" / "¿anda X?" / "does X work?"',
  '- "the page" / "la página" / "la web" / "the site"',
  '- "open this in the browser" / "abrí esto en el navegador" / "navegá a"',
  '- a UI element, web app name, URL, browser tab, layout, dialog, form',
  '→ call `browser.list_tabs` FIRST. A tab with a `map` field: read its `inline` map when present, otherwise call `browser.map.recall` BEFORE `browser.snapshot`.',
  '',
  '- Before suggesting a UI code change or a click, `browser.snapshot` and verify the element exists.',
  '- "Tab not connected" → `browser.events` for the renamed tab_id, then retry.',
  '- SELF-CHECK after each user message: is this about something visible in a browser? Did I run `browser.list_tabs`?',
  '',
  '### Success is not proof',
  '',
  'An `ok` result can still mean the action missed. Check these fields:',
  '- `hit_element` on `click` (and flow click steps) appears when a `pointer-events: none` target passes the click on, or on `force: true`; it names the real receiver: if it is not your target or inside it, the click missed → do not proceed; `find` the element that receives clicks by its text.',
  '- `retargeted` error on `click`: the click would land on an ancestor of your target (clipped or covered by its own container) → scroll or expand the container, or `find` the element that receives clicks; `force: true` clicks there anyway.',
  '- `settle.settled: false` or `mutation_count: 0`: quiet is not effect → `expect` or `wait_for` the effect you need.',
  '- `since_status` on `snapshot`: you received a full snapshot → keep its new `snapshot_id`.',
  '- `reresolved: true`: the node was replaced and re-found → fine.',
  '- `ref-stale` → take a fresh `snapshot`/`find`; never retry the same ref.',
  '- `wait_for` returning `matched: false` is not an error → decide.',
  '',
  '### Habits',
  '',
  '- One full `snapshot` per view, then `snapshot({ since: snapshot_id })` for every later look.',
  '- Act on the `ref` from the last `snapshot`/`find`, not a selector copied earlier; never inject attributes with `evaluate` to build selectors.',
  '- Locate with `find` by text (`role` optional). `evaluate` only reads, never clicks or types: synthetic events are `isTrusted: false`, apps ignore them, and nothing records what happened.',
  '- Downloads only through `browser.download` (`url` or `selector`), never a click on a download control.',
  '- Pass `expect` to `click`/`type`/`press` when the effect matters.',
  '',
  '### Shared tabs and cdp-direct',
  '',
  '- Several agents can share the bridge: `browser.claim_tab` before a multi-step flow, `browser.release_tab` after.',
  '- On a claim conflict do not spin-retry: use another tab or ask the user.',
  '- `cdp:` tabs (`transport: "cdp"`) lack drag, console, network, network_body, canvas_screenshot, dialog_respond, set_permission, wait_for_tab and download by selector.',
  '- "cdp-direct is disabled" / "requires an active grant" → relay `browser-link config set cdp-direct.enabled true` or `browser-link cdp allow` to the user; there is no workaround.',
  '',
  '### Depth on demand',
  '',
  `\`browser.manual()\` lists tools and topics; \`browser.manual({ tool: "browser.click" })\` gives one tool's full doc; \`browser.manual({ topic })\` gives one topic: ${TOPIC_NAMES.join(', ')}.`,
];

export interface CoreOptions {
  /** One line placed before everything else, e.g. an outdated-block notice. */
  notice?: string;
}

/** The core as one string; the optional notice is its first line. */
export function renderCore(opts: CoreOptions = {}): string {
  const lines = opts.notice ? [opts.notice, '', ...CORE_LINES] : CORE_LINES;
  return lines.join('\n');
}
