/**
 * Identity keys of what the map learns (knowledge-loop S1). Pure functions,
 * no DB access, so the dispatcher can use them without pulling the map DB
 * module into its import graph.
 *
 *   - origin: canonical `scheme://host:port` (see origin.ts);
 *   - path pattern: the URL path with id-like segments replaced by `:id`
 *     (`/facturas/48213` → `/facturas/:id`), so a record learned on one
 *     invoice applies to every invoice;
 *   - view signature and build fingerprint: computed in the page by the
 *     observer (`doc_info`), carried on the tab session, never here.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGITS = /^\d+$/;
const HEX = /^[0-9a-f]{8,}$/i;
const BASE64URL = /^[A-Za-z0-9_-]{16,}$/;

/**
 * True for a base64url-ish token (≥ 16 chars of `[A-Za-z0-9_-]`) in which
 * some `-`/`_`-separated part mixes letters and digits. The mix is what
 * tells `k3j4h5g6f7d8s9a0` (an id) from `annual-report-2024` (a slug whose
 * parts are all-letter or all-digit words).
 */
function isTokenLike(segment: string): boolean {
  if (!BASE64URL.test(segment)) return false;
  return segment.split(/[-_]/).some((part) => /\d/.test(part) && /[A-Za-z]/.test(part));
}

/** True when a path segment is an identifier rather than a route word. */
export function isIdSegment(segment: string): boolean {
  if (segment.length === 0) return false;
  return DIGITS.test(segment) || UUID.test(segment) || HEX.test(segment) || isTokenLike(segment);
}

/**
 * The path pattern of a pathname: segments made only of digits, uuids, hex
 * runs of 8 or more characters, or base64url-ish tokens of 16 or more
 * characters (see `isTokenLike`) become `:id`; every other segment is kept
 * as is. A trailing slash is stripped; the root stays `/`. Idempotent:
 * `:id` is never itself an id.
 */
export function pathPattern(pathname: string): string {
  const replaced = pathname
    .split('/')
    .map((segment) => (isIdSegment(segment) ? ':id' : segment))
    .join('/')
    .replace(/\/+$/, '');
  return replaced.length === 0 ? '/' : replaced;
}

/** `{ origin, pathname }` of a URL, or null when it has no usable origin. */
export function splitUrl(
  url: string | null | undefined,
): { origin: string; pathname: string } | null {
  if (typeof url !== 'string' || url.length === 0) return null;
  try {
    const parsed = new URL(url);
    if (parsed.origin === 'null') return null;
    return { origin: parsed.origin, pathname: parsed.pathname };
  } catch {
    return null;
  }
}

export type TargetKind = 'selector' | 'key';

export interface DurableTarget {
  target: string;
  target_kind: TargetKind;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/**
 * The durable target of a call, or null. A selector string counts for every
 * tool. A semantic key counts only for `browser.find` — on `browser.press`,
 * `key` is the keyboard key, not an element. A `ref` (or `find` by text)
 * names no durable target: refs die with the document and text is a value.
 */
export function durableTarget(tool: string, args: unknown): DurableTarget | null {
  const a = asRecord(args);
  if (!a) return null;
  if (typeof a.selector === 'string' && a.selector.length > 0) {
    return { target: a.selector, target_kind: 'selector' };
  }
  if (tool === 'browser.find') {
    const key = asRecord(a.key);
    if (key) {
      // Fixed field order so the same key always yields the same row.
      return {
        target: JSON.stringify({ role: key.role, name: key.name, path: key.path }),
        target_kind: 'key',
      };
    }
  }
  return null;
}
