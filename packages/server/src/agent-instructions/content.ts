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
    'About to suggest a code change to UI / React / DOM:',
    '→ `browser.snapshot` first, verify current state. Do not speculate.',
    '',
    'Tool call returned "Tab not connected":',
    '→ `browser.events` to see tab-renamed entries before retrying.',
    '',
    'After a non-trivial flow worked end-to-end (opened dialog, filled form,',
    'found a setting):',
    '→ `browser.map.save` (UI structure only — never IDs, names, dates).',
    '',
    'Several MCP clients sharing one bridge (multi-agent mode):',
    '→ `browser.claim_tab` before operating on a tab so other agents see it',
    'in use. `browser.release_tab` when done.',
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
    '',
    '### TOKEN-EFFICIENT PATTERNS — prefer dedicated tools, fall back to evaluate',
    '',
    '`browser.evaluate` is the escape hatch. Every dedicated tool below is',
    'cheaper in tokens AND more reliable than a hand-rolled expression.',
    '',
    '- Finding an element by visible text → `browser.find({ text, role? })`,',
    '  NOT `browser.evaluate` with a `textContent` grep. `find` covers',
    '  `<div onclick>` (which a naive `querySelectorAll("button")` MISSES',
    '  SILENTLY), applies visibility + ARIA checks, returns a stable',
    '  selector + viewport coords, and on multi-match returns up to 5',
    '  candidates with snippets for disambiguation.',
    '- `snapshot`/`find`/`click`/`type` all pierce OPEN Shadow DOM roots and',
    '  same-origin iframes automatically — no special handling needed for',
    '  web components or in-page iframes. CLOSED shadow roots and',
    '  cross-origin iframes stay out of reach (no CDP workaround). If',
    '  `click` returns "Element covered by …", something else is on top of',
    '  the target — click or dismiss that element first, do not blindly',
    '  retry with `force:true`.',
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
    '- Special keys (Enter/Tab/Escape/arrows) → `browser.evaluate` with',
    '  `el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))`.',
    '  Vanilla AND React-delegated handlers (React 17+ root delegation)',
    '  pick up bubbled dispatched events. For TYPING text → `browser.type`',
    '  (native setter; controlled components update their state).',
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
