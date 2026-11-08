import { renderInstallBody } from '../manual/render.js';
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

/** Block body: the agent manual core followed by the topics an agent needs
 * every session, rendered by `../manual/render.ts` (one source shared with
 * the MCP connect-time instructions). */
function body(): string {
  return renderInstallBody().join('\n');
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
