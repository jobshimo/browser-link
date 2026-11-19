// The expected-labels list of a behavior-change PR (design 7(b), revision 14):
// the call labels of the e2e record (run.mjs records { tool, label, args,
// result }) whose difference between the base build and HEAD's build the PR
// expects. One parser and one matcher, shared by the PR check
// (scripts/behavior-change-check.mjs), the differential
// (scripts/e2e-diff.mjs) and the harness's record-only base run (run.mjs,
// E2E_RECORD_ONLY), so the three never disagree on what an entry covers.
//
// An entry of three or more dot-separated segments is a label or a label
// prefix (`browser.drag.flow` covers `browser.drag.flow.cdp`, never
// `browser.drag.flowx`). An entry of fewer segments matches only that exact
// label: a call's default label is its tool name, so `browser.click` stays a
// valid exact label but never covers `browser.click.cdp`, and no entry can
// cover a tool's or a namespace's cases.

/** What one entry may contain; anything else is refused, never escaped. */
export const ENTRY = /^[A-Za-z0-9._-]+$/;
/** More entries than this is a blanket list, not a named change. */
export const MAX_ENTRIES = 32;

/**
 * Parses a comma-separated list. Returns `{ entries }` (validated, unique,
 * sorted) or `{ error }`. An empty or blank text is the empty list.
 */
export function parseLabelList(text) {
  const raw = String(text ?? '').trim();
  if (raw === '') return { entries: [] };
  const parts = raw.split(',').map((p) => p.trim());
  for (const p of parts) {
    if (p === '') return { error: 'an empty entry (two commas, or a trailing comma)' };
    if (!ENTRY.test(p)) {
      return { error: `entry ${JSON.stringify(p.slice(0, 80))} is not [A-Za-z0-9._-]+` };
    }
  }
  const entries = [...new Set(parts)].sort();
  if (entries.length > MAX_ENTRIES) {
    return { error: `${String(entries.length)} entries, more than ${String(MAX_ENTRIES)}` };
  }
  return { entries };
}

/** Segments an entry needs to act as a prefix. */
export const PREFIX_SEGMENTS = 3;

/** true when `entry` covers `label`: equal, or a prefix of three or more
 * segments followed by a dot. */
export function labelMatches(label, entry) {
  if (typeof label !== 'string') return false;
  if (label === entry) return true;
  return entry.split('.').length >= PREFIX_SEGMENTS && label.startsWith(`${entry}.`);
}

/** The entries that cover `label` (empty when it is not listed). */
export function entriesFor(label, entries) {
  return entries.filter((e) => labelMatches(label, e));
}

export function isListed(label, entries) {
  return entries.some((e) => labelMatches(label, e));
}

/**
 * The harness's record-only wrapper (run.mjs, E2E_RECORD_ONLY): returns
 * `recordOnly(label, fn)`, which runs one case. When `label` is listed, a
 * failure of the case (`isFailure(e)`) is reported through `onListedFailure`
 * and swallowed (the call stays in the record, the run goes on, the exit is
 * not touched); the result is then undefined. An unlisted label, an empty
 * list, or any other error passes through unchanged.
 */
export function recordOnlyRunner({ entries, isFailure, onListedFailure }) {
  return async function recordOnly(label, fn) {
    if (entries.length === 0 || !isListed(label, entries)) return fn();
    try {
      return await fn();
    } catch (e) {
      if (!isFailure(e)) throw e;
      onListedFailure(label, e);
      return undefined;
    }
  };
}
