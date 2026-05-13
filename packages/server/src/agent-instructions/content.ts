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

/** Block body. Plain English by design — every LLM understands it, and a
 * mixed-language user is still served. Triggers-first; no marketing copy. */
function body(): string {
  return [
    '## browser-link — when to reach for it',
    '',
    'When you have access to `browser.*` MCP tools (the bridge exposed by',
    '@jobshimo/browser-link), reach for them BEFORE speculating about UI',
    'behavior. Tabs the user has not explicitly connected through the',
    'Chrome extension are invisible to you; never reason about state you',
    'cannot see.',
    '',
    '### Triggers — call these reflexively',
    '',
    '- **User reports a UI bug, broken layout, "the button does not fire",',
    '  or asks "does X work" in a web app**: call `browser.list_tabs` first.',
    '  If one tab is connected, snapshot it. If several, ask which.',
    '- **Before suggesting a code change to a UI component**: verify the',
    '  current page state with `browser.snapshot`. Do not guess.',
    '- **Any non-trivial debugging session on a web app the user mentioned**:',
    '  call `browser.map.recall` with the tab origin first. Past selectors,',
    '  flows and gotchas come back; you save tokens and avoid re-deriving.',
    '- **Tool call fails with "Tab not connected"**: call `browser.events`',
    '  and look for `tab-renamed` entries before retrying.',
    '- **After any non-trivial flow you discovered end-to-end** (opened a',
    '  dialog, completed a form, found a setting): persist it with',
    '  `browser.map.save`. UI structure only — never save domain data',
    '  (IDs, names, dates).',
    '',
    '### Multi-agent cooperation',
    '',
    'When several MCP clients share one bridge (multi-agent mode), call',
    '`browser.claim_tab` before operating on a tab so other agents see it',
    'is in use. Release with `browser.release_tab` when done.',
  ].join('\n');
}

/** Full fenced block to write into the file, including a trailing newline.
 * The line between markers carries the managed-by stamp so a user reading
 * the file knows it is auto-generated and how to refresh it. */
export function block(version = VERSION): string {
  return [
    beginMarker(version),
    `<!-- managed-by: browser-link v${version}; do not edit between markers; run \`browser-link instructions install\` to refresh. -->`,
    '',
    body(),
    '',
    END_MARKER,
    '',
  ].join('\n');
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
