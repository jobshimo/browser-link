import { VERSION } from '../version.js';

/**
 * The block we drop into each agent's global instructions markdown file.
 * Wrapped in HTML-comment marker fences so:
 *  - rendered markdown viewers hide the markers,
 *  - the installer can detect / re-find / replace the exact span,
 *  - other content in the same .md file is left untouched.
 *
 * The version inside the begin marker lets a newer browser-link tell whether
 * an installed block is current; install() always rewrites to the running
 * version, so reinstalling is the upgrade path.
 */

export const BEGIN_PREFIX = '<!-- browser-link:instructions:begin';
export const END_MARKER = '<!-- browser-link:instructions:end -->';

export function beginMarker(version = VERSION): string {
  return `${BEGIN_PREFIX} v${version} -->`;
}

/** Regex that matches either an explicit version marker or a legacy one
 * with no version. The named `version` group is set when a version is
 * present (a plain capture group is typed as `string` by TS, which would
 * collapse the `undefined` branch we want; the named-group form keeps
 * `version` as `string | undefined`). */
export const BEGIN_RE =
  /<!--\s*browser-link:instructions:begin(?:\s+v(?<version>\d+\.\d+\.\d+))?\s*-->/;
export const END_RE = /<!--\s*browser-link:instructions:end\s*-->/;

/** Block body. Engram-style reflex protocol — imperative TRIGGER LIST that
 * the agent treats as ALWAYS ACTIVE, not descriptive prose. Plain English
 * by design (LLMs reason in English); the bilingual phrases inside the
 * trigger list are DATA — what the user actually types — not instructions
 * to the agent. */
function body(): string {
  return [
    '## browser-link — reflex protocol (ALWAYS ACTIVE)',
    '',
    'You have `browser.*` MCP tools (the bridge exposed by `@jobshimo/browser-link`).',
    'These tools see only Chrome tabs the user explicitly connected via the',
    'companion extension. Never reason about state you cannot see.',
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
    '→ call `browser.list_tabs` FIRST, then `browser.map.recall` with the tab origin.',
    '',
    '`browser.list_tabs` entry carries a `map` field',
    '(`{ app_key, entries, flows }`):',
    "→ that tab's origin already has data in the persistent map — call",
    '`browser.map.recall` BEFORE `browser.snapshot`. No `map` field means',
    'the map has nothing for that origin yet; skip straight to snapshot.',
    '',
    'About to suggest a code change to UI / React / DOM:',
    '→ `browser.snapshot` first, verify current state. Do not speculate.',
    '',
    'Tool call returned "Tab not connected":',
    '→ `browser.events` to see tab-renamed entries before retrying.',
    '',
    'After a non-trivial flow worked end-to-end (opened dialog, filled form,',
    'found a setting):',
    '→ `browser.map.save` (UI structure only — never IDs, names, dates).',
    'Optionally attach `flows` (named, replayable step recipes) to the same',
    'call — see the recall → adapt → flow pattern below.',
    '',
    '`browser.map.recall` returned saved `flows` for this app:',
    '→ ADAPT the steps first — substitute any placeholder text (e.g.',
    '`type text "<QUERY>"`) with the real value the user asked for — THEN',
    'run the adapted steps via `browser.flow`. Never replay a saved flow',
    'verbatim when it contains a placeholder.',
    '',
    'Several MCP clients sharing one bridge (multi-agent mode):',
    '→ `browser.claim_tab` before operating on a tab so other agents see it',
    'in use. `browser.release_tab` when done.',
    '',
    'A `list_tabs` entry has `tab_id` starting with `cdp:` (`transport: "cdp"`):',
    '→ that tab is reached via cdp-direct, not the extension — every tool',
    'works the same EXCEPT drag/console/network/network_body/',
    'canvas_screenshot/dialog_respond/set_permission/wait_for_tab (clear',
    'error naming the extension as the fallback). cdp-direct only appears',
    'when the user has both enabled it AND granted access — you cannot',
    'enable or grant it yourself. A "cdp-direct is disabled" or "requires an',
    'active grant" error means relay the suggested command to the user',
    '(`browser-link config set cdp-direct.enabled true` or',
    '`browser-link cdp allow`) — there is no workaround from here.',
    '',
    '### SELF-CHECK after each user message',
    '',
    '"Is the user talking about a web page, UI, or anything visible in a browser?',
    'If yes → did I run `browser.list_tabs` yet? If no → STOP and run it now."',
    '',
    '### NEVER',
    '',
    '- Speculate about DOM state without a snapshot.',
    '- Suggest "try clicking X" without verifying X exists in the current page.',
    '- Save selectors you have not just successfully executed.',
    '- Store domain data (IDs, user names, dates, etc.) in the persistent map.',
    '- Save a flow recipe with a real value baked into a step (a real search',
    '  query, a real name) instead of a placeholder like `<QUERY>` — flows',
    '  store UI structure only, exactly like every other map entry.',
    '',
    '### TOKEN-EFFICIENT PATTERNS — prefer dedicated tools, fall back to evaluate',
    '',
    '`browser.evaluate` is the escape hatch. Every dedicated tool below is',
    'cheaper in tokens AND more reliable than a hand-rolled expression.',
    '',
    '- Any multi-step interaction (find a target → act on it → wait → act',
    '  again) → `browser.flow({ steps: [...] })` is now the DEFAULT, not a',
    '  fallback. find → click → wait_for → type → press used to cost 5+',
    '  separate MCP round trips — each one a full LLM inference — and now',
    '  costs ONE `browser.flow` call (two if a step fails and you need a',
    "  corrective follow-up). A `find` step's selector becomes the implicit",
    '  target for the very next click/type/press step that omits',
    '  `selector`. Flow is strictly sequential and fails fast — reach for',
    '  individual click/type/press/find/wait_for calls only when you need',
    '  to branch on an intermediate result.',
    '- Finding an element by visible text → `browser.find({ text, role? })`,',
    '  NOT `browser.evaluate` with a `textContent` grep. `find` covers',
    '  `<div onclick>` (which a naive `querySelectorAll("button")` MISSES',
    '  SILENTLY), applies visibility + ARIA checks, returns a stable',
    '  selector + viewport coords, and on multi-match returns up to 5',
    '  candidates with snippets for disambiguation. On `not-found`, read',
    '  `near_misses` (up to 3 ranked candidates) before giving up — and if',
    '  `error` names a role mismatch, drop `role` or match the role the',
    '  closest near-miss actually has.',
    '- Quick orientation without a full snapshot → `browser.state({})`.',
    '  Returns `{ url, title, focused?, dialogs?, scroll?, viewport }` —',
    '  cheaper than `browser.snapshot` when you just need to know where you',
    '  are (is a dialog open, what has focus) before deciding whether a',
    '  full snapshot is even needed.',
    '- `snapshot`/`find`/`click`/`type` all pierce OPEN Shadow DOM roots and',
    '  same-origin iframes automatically — no special handling needed for',
    '  web components or in-page iframes. CLOSED shadow roots and',
    '  cross-origin iframes stay out of reach (no CDP workaround). If',
    '  `click` returns "Element covered by …", something else is on top of',
    '  the target — click or dismiss that element first, do not blindly',
    '  retry with `force:true`. A pointer-events:none target (invisible',
    '  a11y layer) is NOT reported as covered: the click proceeds and the',
    '  ok result carries `hit_element` naming what actually received it —',
    '  present on any off-target click (force:true included), omitted',
    '  when the click hit the resolved element itself.',
    '- A snapshot/find entry with `ambiguous: true` has a selector that',
    '  matches structurally-identical twins in other shadow roots/iframes',
    '  (no CSS syntax can scope to one root). It resolves first-match-wins:',
    '  use it in the SAME turn, and NEVER `browser.map.save` it.',
    '- Trimming snapshot size → `browser.snapshot({ within_selector, only_interactive, exclude, max_interactive })`.',
    '  Filters are applied IN-page so the dropped material never travels back.',
    '  Pass `exclude:["nav","footer"]` to skip repeated landmarks; pass',
    '  `within_selector` when only one region matters.',
    '- Reading N values → ONE `browser.evaluate` returning an object:',
    '  `(() => ({ a: document.querySelector("#a").value, b: ... }))()`.',
    '  Never N separate evaluates for N reads.',
    '- Scrolling → `browser.evaluate` with `pane.scrollTop = N` or',
    '  `el.scrollIntoView({ block: "center" })`. No dedicated tool needed.',
    '- Special keys (Enter/Tab/Escape/arrows/shortcuts) → `browser.press`,',
    '  NOT `browser.evaluate` with a synthetic `KeyboardEvent`. Synthetic',
    '  `dispatchEvent` produces `isTrusted:false` events — rich editors,',
    '  autocompletes, and non-DOM runtimes (Qt-WASM, WebGL) silently ignore',
    '  them. `browser.press` dispatches a real CDP `Input.dispatchKeyEvent`',
    '  sequence (`isTrusted:true`). For TYPING text → `browser.type` (native',
    '  setter; controlled components update their state).',
    '- After `click`/`type`/`press`, a separate `browser.wait_for` is',
    '  usually unnecessary — all three accept `settle_ms` (default 150) and',
    '  return a `settle` object (`{ settled, duration_ms, mutation_count,',
    '  url_changed?, focus_moved? }`) once the page goes quiet. Settle',
    '  proves QUIET, not EFFECT: mutations completing before the observer',
    '  installs (right after dispatch) and async reactions starting after',
    '  the quiet window are both invisible — `mutation_count: 0` does NOT',
    '  mean the action did nothing. Reach for `wait_for` when you need a',
    '  SPECIFIC condition (a particular selector, network request, or',
    '  expression), not just "did anything change".',
    '- Paging `browser.events` → keep `lastId = result.latest_id` in your',
    '  working notes and pass as `since_id` next call. One variable. The',
    '  server does not maintain per-agent cursors.',
  ].join('\n');
}

/** Full fenced block to write into the file, including a trailing newline.
 * The line between markers carries the managed-by stamp so a user reading
 * the file knows it is auto-generated and how to refresh it.
 *
 * `eol` controls the line separator. Default is LF; pass CRLF to match a
 * Windows-edited file's dominant line ending. The body() helper composes
 * its own lines with `\n`; we replace them when joining so the produced
 * block is uniformly LF or CRLF — never mixed. */
export function block(version = VERSION, eol: '\n' | '\r\n' = '\n'): string {
  const parts = [
    beginMarker(version),
    `<!-- managed-by: browser-link v${version}; do not edit between markers; run \`browser-link instructions install\` to refresh. -->`,
    '',
    body(),
    '',
    END_MARKER,
    '',
  ];
  if (eol === '\n') return parts.join('\n');
  // body() returned a multi-line string joined with \n; flip each \n to \r\n.
  return parts.map((p) => p.replace(/\n/g, '\r\n')).join('\r\n');
}

/** Count occurrences of the BEGIN marker in `text`. The base BEGIN_RE has
 * no `g` flag (it's used for single-span detection); this helper compiles
 * the same pattern with `g` so duplicates can be diagnosed. */
export function countBeginMarkers(text: string): number {
  return (text.match(/<!--\s*browser-link:instructions:begin(?:\s+v\d+\.\d+\.\d+)?\s*-->/g) ?? [])
    .length;
}

/** Pick the dominant line ending of `text`. CRLF wins only when it is the
 * majority of newline sequences; otherwise LF. Used by installAt to keep
 * Windows-edited files from acquiring a mixed-EOL block. */
export function detectEol(text: string): '\n' | '\r\n' {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lfTotal = (text.match(/\n/g) ?? []).length;
  const loneLf = lfTotal - crlf;
  return crlf > loneLf && crlf > 0 ? '\r\n' : '\n';
}

/** Locate the block boundaries in the given file text. Returns null when
 * either marker is missing. Used by detect/install/uninstall to act on the
 * exact span the installer owns. */
export interface BlockSpan {
  startIndex: number;
  endIndex: number; // index AFTER the end marker line (newline-inclusive)
  installedVersion: string | null;
}

export function findBlockSpan(text: string): BlockSpan | null {
  const begin = BEGIN_RE.exec(text);
  if (!begin) return null;
  const afterBegin = begin.index + begin[0].length;
  const end = END_RE.exec(text.slice(afterBegin));
  if (!end) return null;
  const endMarkerStartAbsolute = afterBegin + end.index;
  const endMarkerEndAbsolute = endMarkerStartAbsolute + end[0].length;
  // Consume the trailing newline after the end marker, if any.
  const nextChar = text[endMarkerEndAbsolute];
  const endIndex = nextChar === '\n' ? endMarkerEndAbsolute + 1 : endMarkerEndAbsolute;
  return {
    startIndex: begin.index,
    endIndex,
    installedVersion: begin.groups?.version ?? null,
  };
}
