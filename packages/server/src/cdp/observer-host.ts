/**
 * Independent copy of `packages/extension/src/observer-host.ts` — see
 * `inpage/deep-query.ts`'s header comment for why this package duplicates
 * rather than imports these modules. The extension original imports the
 * observer message types from `@browser-link/shared`, which this standalone
 * package cannot resolve, so they are declared below, copied from that
 * package; `cdp/drift.test.ts` asserts both the declarations and everything
 * from "Summaries kept in the host mirror" to the end of the file stay
 * byte-identical to the originals.
 *
 * Host side of the page observer (spec v4 §5.4–§5.5): the per-connection
 * mirror of what the in-page observer (`inpage/observer.ts`) has pushed
 * through its binding, and the rule that folds an action's "changes since
 * mark" into the settle result. Free of CDP calls; `cdp/transport.ts` owns
 * every evaluation.
 */
import { OBSERVER_GLOBAL } from './inpage/observer.js';

/** Per-kind MutationRecord counts reported by the page observer. */
interface PageObserverKinds {
  childList: number;
  attributes: number;
  characterData: number;
}

/** Which kinds of root the counted records came from. `frame` is true when
 * the observer runs in a child frame (`window !== window.top`). */
interface PageObserverRoots {
  document: boolean;
  shadow: boolean;
  frame: boolean;
}

/** One mutated target, as described by the page observer. `path` is a short
 * structural path such as `body>div#app>ul` (at most six element segments,
 * no indexes), with a `#shadow` segment at each shadow-root boundary. A
 * shadow root that was itself the mutation target is reported with tag
 * `#shadow-root`. */
interface PageObserverDescriptor {
  tag: string;
  id?: string;
  role?: string;
  path: string;
}

/** One coalesced flush of the page observer: every MutationRecord seen
 * since the previous flush, folded per target element. */
interface PageObserverSummary {
  type: 'summary';
  doc_id: string;
  /** Monotonic per document, starting at 1. */
  seq: number;
  /** `performance.now()` at the first record and at the flush. */
  t0: number;
  t1: number;
  records: number;
  /** Distinct target elements in this flush. */
  targets: number;
  kinds: PageObserverKinds;
  roots: PageObserverRoots;
  /** Up to the descriptor cap, ordered by record count (highest first). */
  descriptors: PageObserverDescriptor[];
  /** Targets beyond the descriptor cap. */
  overflow: number;
}

/** Pushed once when the page observer installs in a document. */
interface PageObserverDocStart {
  type: 'doc_start';
  doc_id: string;
  url: string;
  version: number;
  /** `partial` when `attachShadow` could not be patched and the observer
   * falls back to a periodic rescan for open shadow roots. */
  coverage: 'full' | 'partial';
}

/** Pushed on `pushState`, `replaceState`, `popstate` and `hashchange`. */
interface PageObserverNav {
  type: 'nav';
  doc_id: string;
  url: string;
}

/** Every message the page observer pushes through its binding (JSON). */
type PageObserverMessage = PageObserverSummary | PageObserverDocStart | PageObserverNav;

/** What an action caused, aggregated from the page observer's summaries
 * since the action mark; attached to settle results. `targets` sums the
 * distinct targets of each flush, so an element touched in two flushes counts
 * twice. `truncated` is set when the observer's ring no longer held every
 * summary since the mark. */
interface SettleChanges {
  records: number;
  targets: number;
  kinds: PageObserverKinds;
  roots: PageObserverRoots;
  descriptors: PageObserverDescriptor[];
  overflow: number;
  truncated?: true;
}

/** Summaries kept in the host mirror (the page keeps its own, larger ring). */
export const OBSERVER_RECENT_CAP = 32;

/** Per-tab host state for the page observer of the tab's top document. */
export interface ObserverMirror {
  /** True once the install commands succeeded on this tab. */
  installed: boolean;
  doc_id?: string;
  url?: string;
  coverage?: 'full' | 'partial';
  last_seq: number;
  recent: PageObserverSummary[];
}

export type ObserverMessageOutcome =
  | { kind: 'doc_start'; url: string }
  | { kind: 'nav'; url: string }
  | { kind: 'summary' }
  | { kind: 'ignored' };

/** Reason attached as `settle.observer` when `changes` could not be read. */
export type ObserverChangesFailure = 'observer-unavailable' | 'doc-changed' | 'changes-error';

/** The settle result as the action callers carry it (`settleSafely`). */
export type SettleResultLike = Record<string, unknown>;

export function createObserverMirror(): ObserverMirror {
  return { installed: false, last_seq: 0, recent: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isKinds(value: unknown): boolean {
  return (
    isRecord(value) &&
    isCount(value.childList) &&
    isCount(value.attributes) &&
    isCount(value.characterData)
  );
}

function isRoots(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.document === 'boolean' &&
    typeof value.shadow === 'boolean' &&
    typeof value.frame === 'boolean'
  );
}

/** Shared by summaries and by the "changes since mark" aggregate. */
function hasChangeCounts(value: Record<string, unknown>): boolean {
  return (
    isCount(value.records) &&
    isCount(value.targets) &&
    isKinds(value.kinds) &&
    isRoots(value.roots) &&
    Array.isArray(value.descriptors) &&
    isCount(value.overflow)
  );
}

/**
 * Parse one binding payload. The binding is a page-visible global, so the
 * payload is untrusted: anything that is not valid JSON in one of the three
 * observer message shapes yields `null`.
 */
export function parseObserverMessage(payload: string): PageObserverMessage | null {
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!isRecord(raw) || typeof raw.doc_id !== 'string') return null;
  switch (raw.type) {
    case 'summary':
      return isCount(raw.seq) && hasChangeCounts(raw)
        ? (raw as unknown as PageObserverSummary)
        : null;
    case 'doc_start':
      return typeof raw.url === 'string' && (raw.coverage === 'full' || raw.coverage === 'partial')
        ? (raw as unknown as PageObserverMessage)
        : null;
    case 'nav':
      return typeof raw.url === 'string' ? (raw as unknown as PageObserverMessage) : null;
    default:
      return null;
  }
}

/**
 * Fold one observer message into the mirror. `doc_start` and `nav` are
 * assumed to come from the top document — the caller confirms that first
 * with `TOP_DOCUMENT_PROBE_JS` / `isTopDocumentMessage`, because the install
 * script also runs in same-process child frames. Summaries from a child
 * frame (`roots.frame`) or from a document other than the mirrored one are
 * ignored. A `nav` that does not change the URL (e.g. a state-only
 * `replaceState`) is ignored so it does not emit a navigation event.
 */
export function applyObserverMessage(
  mirror: ObserverMirror,
  message: PageObserverMessage,
): ObserverMessageOutcome {
  switch (message.type) {
    case 'doc_start':
      mirror.doc_id = message.doc_id;
      mirror.url = message.url;
      mirror.coverage = message.coverage;
      mirror.last_seq = 0;
      mirror.recent = [];
      return { kind: 'doc_start', url: message.url };
    case 'nav':
      if (mirror.doc_id !== undefined && message.doc_id !== mirror.doc_id)
        return { kind: 'ignored' };
      if (message.url === mirror.url) return { kind: 'ignored' };
      mirror.url = message.url;
      return { kind: 'nav', url: message.url };
    case 'summary':
      if (message.roots.frame) return { kind: 'ignored' };
      if (mirror.doc_id !== undefined && message.doc_id !== mirror.doc_id)
        return { kind: 'ignored' };
      mirror.last_seq = Math.max(mirror.last_seq, message.seq);
      mirror.recent.push(message);
      while (mirror.recent.length > OBSERVER_RECENT_CAP) mirror.recent.shift();
      return { kind: 'summary' };
    default:
      return { kind: 'ignored' };
  }
}

/**
 * Expression evaluated in the tab's top document (default `Runtime.evaluate`
 * context) to tell whether a `doc_start` / `nav` came from it: evaluates to
 * `{ doc_id }` of the observer installed there, or `{ doc_id: null }`.
 */
export const TOP_DOCUMENT_PROBE_JS = `(() => {
  const g = window[${JSON.stringify(OBSERVER_GLOBAL)}];
  return { doc_id: g && typeof g.doc_id === 'string' ? g.doc_id : null };
})()`;

/** True when the top-document probe reports the message's `doc_id`. */
export function isTopDocumentMessage(probe: unknown, docId: string): boolean {
  return isRecord(probe) && typeof probe.doc_id === 'string' && probe.doc_id === docId;
}

/** The part of an action mark (`buildObserverMarkJs`) the changes read needs. */
export interface ObserverMark {
  mark: number;
  doc_id: string;
}

/**
 * Validate the result of the mark evaluation. `null` means there is no
 * usable mark (observer missing, `ok: false`, or a malformed value); the
 * caller then skips the changes read and reports the failure instead.
 */
export function readObserverMark(value: unknown): ObserverMark | null {
  if (!isRecord(value) || value.ok !== true) return null;
  if (!isCount(value.mark) || typeof value.doc_id !== 'string') return null;
  return { mark: value.mark, doc_id: value.doc_id };
}

function failureReason(changes: unknown): ObserverChangesFailure {
  if (
    isRecord(changes) &&
    changes.ok === false &&
    (changes.reason === 'observer-unavailable' || changes.reason === 'doc-changed')
  ) {
    return changes.reason;
  }
  return 'changes-error';
}

/**
 * Fold the observer's "changes since mark" into a settle result (spec v4
 * §5.4). With valid changes: attach `changes` (the `SettleChanges` shape),
 * recompute `mutation_count` from the observer's records, and replace
 * `url_changed` / `focus_moved` with the values baselined at the action
 * mark (present only when they changed). Otherwise keep every settle field
 * as `settleSafely` produced it and add `changes: null` plus
 * `observer: <reason>`. A `null` settle (settle disabled) stays `null`.
 * Returns a new object; never throws.
 */
export function mergeSettleChanges(
  settle: SettleResultLike | null,
  changes: unknown,
): SettleResultLike | null {
  if (settle === null) return null;
  if (!isRecord(changes) || changes.ok !== true || !hasChangeCounts(changes)) {
    return { ...settle, changes: null, observer: failureReason(changes) };
  }
  const summary: SettleChanges = {
    records: changes.records as number,
    targets: changes.targets as number,
    kinds: changes.kinds as SettleChanges['kinds'],
    roots: changes.roots as SettleChanges['roots'],
    descriptors: changes.descriptors as SettleChanges['descriptors'],
    overflow: changes.overflow as number,
  };
  if (changes.truncated === true) summary.truncated = true;
  const merged: SettleResultLike = { ...settle, mutation_count: summary.records };
  delete merged.url_changed;
  delete merged.focus_moved;
  if (typeof changes.url_changed === 'string') merged.url_changed = changes.url_changed;
  if (changes.focus_moved === true) merged.focus_moved = true;
  merged.changes = summary;
  return merged;
}
