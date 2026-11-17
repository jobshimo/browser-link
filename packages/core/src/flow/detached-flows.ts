/**
 * The records of detached flows: what a valid record is, how it is keyed,
 * and its bounds (design 3.1 and section 4). The extension's
 * `DetachedFlowStore` adapter only serialises; cdp-direct keeps its own
 * model (`server/src/cdp/detached-flows.ts`, design section 8, Q4).
 *
 * DETACHED-FLOW RECORDS ARE A DIFFERENT ANIMAL from the flow history, and
 * the distinction matters. A record (`DetachedFlowRecord`, keyed
 * `detached-flow:<flow_id>`) carries the flow's ACTION MANIFEST — the very
 * `results[]` a synchronous flow returns to its caller — plus the failure
 * message, so the agent that launched a detached run can still answer
 * "which things did you just delete?" after the fact. That is page-derived
 * data at rest in `chrome.storage.session`, deliberately, because a
 * detached flow has no open tool call to return it through. It is NEVER
 * shown in the popup, it is only ever handed back over the bridge to an
 * agent that can already read the page, and it dies with the browser
 * session like everything else here.
 */

import type { DetachedFlowRecord } from '../ports/values.js';
import { utf8ByteLength } from '../support/utf8.js';
import type { FlowResult } from './flow-engine.js';
import { isFlowStopReason, summarizeFlow, type FlowRun } from './flow-run.js';

/** Storage key holding ONE detached flow's record. Keyed by `flow_id` (not
 * by tab): the id is what `browser.flow_status` and `browser.flow_cancel`
 * address, and it stays valid across a tab reconnecting under a new
 * browser-link id. */
export function detachedFlowKey(flowId: string): string {
  return `detached-flow:${flowId}`;
}

const DETACHED_FLOW_KEY_PREFIX = 'detached-flow:';

/** Inverse of `detachedFlowKey`, for the sweep over the whole store.
 * Returns null for every other key. */
export function flowIdFromDetachedFlowKey(key: string): string | null {
  if (!key.startsWith(DETACHED_FLOW_KEY_PREFIX)) return null;
  const flowId = key.slice(DETACHED_FLOW_KEY_PREFIX.length);
  return flowId.length > 0 ? flowId : null;
}

/** How many detached-flow records are kept at once, across every tab.
 * Small on purpose: each terminal record carries a full action manifest,
 * `chrome.storage.session` is a shared, quota-bounded store, and the
 * realistic access pattern is "the agent that launched it polls it, reads
 * the manifest once, and moves on". Oldest-first eviction. */
export const MAX_DETACHED_FLOW_RECORDS = 10;

/** Byte ceiling on ONE stored record's serialized manifest. A 500-iteration
 * repeat over a 20-step body can produce a manifest far larger than
 * anything a session store should hold, and losing the whole record to a
 * quota rejection would be strictly worse than losing the manifest: the
 * counts, the outcome and the failing step all still fit. Over the ceiling
 * the manifest is dropped and `manifestTruncated` says so out loud, rather
 * than a silently short array the agent would read as "that's all that
 * happened". */
export const MAX_DETACHED_MANIFEST_BYTES = 128_000;

/** The record written the instant a detached flow is launched. Its whole
 * job is to exist: a `running` record with no live run behind it is the
 * ONLY evidence that Chrome killed the service worker mid-flow. */
export function startedDetachedFlowRecord(entry: FlowRun): DetachedFlowRecord {
  return {
    flowId: entry.flowId,
    tabId: entry.tabId,
    state: 'running',
    startedAt: entry.startedAt,
    steps: entry.steps,
    stepsCompleted: 0,
  };
}

/** The terminal record, manifest included. `endedAt` is passed in rather
 * than read off the clock so the caller can use the same instant for the
 * record, the history entry and the audit event. */
export function finishedDetachedFlowRecord(
  entry: FlowRun,
  result: FlowResult | null,
  endedAt: number,
): DetachedFlowRecord {
  const summary = summarizeFlow(entry, result);
  const manifest = result !== null && result.ok ? result.results : [];
  // Measured on the manifest alone: the rest of the record is a handful of
  // numbers and a bounded error string, and charging them against the
  // ceiling would make the cutoff depend on an error message's length.
  const oversized = measureJsonBytes(manifest) > MAX_DETACHED_MANIFEST_BYTES;
  return {
    flowId: entry.flowId,
    tabId: entry.tabId,
    state: summary.outcome,
    startedAt: entry.startedAt,
    endedAt,
    steps: entry.steps,
    stepsCompleted: summary.stepsCompleted,
    ...(summary.iterationsCompleted === undefined
      ? {}
      : { iterationsCompleted: summary.iterationsCompleted }),
    ...(summary.stoppedBy === undefined ? {} : { stoppedBy: summary.stoppedBy }),
    ...(summary.error === undefined ? {} : { error: summary.error }),
    ...(oversized ? { manifestTruncated: true as const } : { manifest }),
  };
}

/** UTF-8 byte size of a value serialized as JSON, or `Infinity` when it
 * cannot be serialized at all (a cycle, a BigInt). Unserializable is
 * treated as over the ceiling: the alternative is letting the store's
 * write throw and losing the entire record.
 *
 * Encoded rather than measured by `.length`: a string's length counts
 * UTF-16 code units, while the quota counts bytes. A manifest of CJK or
 * emoji page text costs up to three or four bytes per code unit, so
 * `.length` would let a record two to four times over the ceiling through
 * — precisely the quota rejection this cap exists to avoid. */
function measureJsonBytes(value: unknown): number {
  try {
    const json = JSON.stringify(value);
    if (typeof json !== 'string') return Number.POSITIVE_INFINITY;
    return utf8ByteLength(json);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Reconcile a persisted record against the fact that this service worker
 * has no live run for it — i.e. Chrome terminated the worker while the
 * flow was mid-run.
 *
 * THE RULE, and it is not negotiable: mark it `failed` /
 * `'worker-terminated'` and NEVER resume. A detached flow exists to do
 * irreversible bulk work; a resume that could not know how far the dead run
 * actually got would double-act on some prefix of it. A loud, honest
 * failure is strictly better than a silent second pass, and a phantom
 * `running` state — a flow that looks alive while nothing is executing it —
 * is worse than both.
 *
 * The manifest of the dead run is genuinely unrecoverable: it lived in the
 * runner's closure, and there was never a per-step write that could have
 * saved it. `manifestTruncated` says so rather than presenting an empty
 * array as "nothing happened".
 *
 * Returns `null` for a record that is already terminal — a second worker
 * restart must not rewrite an outcome, nor re-fire its audit event.
 */
export function terminatedDetachedFlowRecord(
  record: DetachedFlowRecord,
  endedAt: number,
): DetachedFlowRecord | null {
  if (record.state !== 'running') return null;
  const { manifest: _dropped, ...rest } = record;
  return {
    ...rest,
    state: 'failed',
    endedAt,
    stoppedBy: 'worker-terminated',
    manifestTruncated: true,
    eventPending: true,
  };
}

/** Character ceiling on the error string of a MINIMAL record. The normal
 * terminal record keeps the failure message whole — it is the answer to
 * "why did it stop". This bound applies only where the full write already
 * came back refused, and a flow error is page-derived free text with no
 * upper bound of its own (a `find: multiple-matches` over a huge table
 * quotes every candidate), so it is the one remaining field that could
 * still be what breaches the quota. */
export const MAX_MINIMAL_RECORD_ERROR_CHARS = 1_024;

/** The same terminal record without its manifest — what gets written when
 * storage refuses the full one. The manifest is the only part large enough
 * to be refused under normal conditions; state, `stoppedBy` and the
 * counters are a few hundred bytes. Losing the manifest is a documented
 * outcome; losing the write is not: the stale `running` record becomes
 * `worker-terminated`. The error is trimmed to
 * `MAX_MINIMAL_RECORD_ERROR_CHARS` with a visible ellipsis, so a
 * pathological message cannot be what sinks the retry too. */
export function minimalDetachedFlowRecord(record: DetachedFlowRecord): DetachedFlowRecord {
  const { manifest: _dropped, ...rest } = record;
  return {
    ...rest,
    ...(rest.error === undefined ? {} : { error: truncateError(rest.error) }),
    manifestTruncated: true,
  };
}

function truncateError(error: string): string {
  if (error.length <= MAX_MINIMAL_RECORD_ERROR_CHARS) return error;
  return `${error.slice(0, MAX_MINIMAL_RECORD_ERROR_CHARS)}…`;
}

/** Narrow whatever the store hands back into a record. Same posture as
 * `parseFlowHistory`: storage is not a typed channel, and a record written
 * by an older extension version must be dropped rather than rendered as a
 * half-`undefined` status payload. */
export function parseDetachedFlowRecord(raw: unknown): DetachedFlowRecord | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const c = raw as Partial<DetachedFlowRecord>;
  if (typeof c.flowId !== 'string' || c.flowId.length === 0) return null;
  if (typeof c.tabId !== 'number') return null;
  if (typeof c.startedAt !== 'number') return null;
  if (typeof c.steps !== 'number') return null;
  if (typeof c.stepsCompleted !== 'number') return null;
  if (
    c.state !== 'running' &&
    c.state !== 'completed' &&
    c.state !== 'cancelled' &&
    c.state !== 'failed' &&
    c.state !== 'expired'
  ) {
    return null;
  }
  return {
    flowId: c.flowId,
    tabId: c.tabId,
    state: c.state,
    startedAt: c.startedAt,
    steps: c.steps,
    stepsCompleted: c.stepsCompleted,
    ...(typeof c.endedAt === 'number' ? { endedAt: c.endedAt } : {}),
    ...(typeof c.iterationsCompleted === 'number'
      ? { iterationsCompleted: c.iterationsCompleted }
      : {}),
    ...(isFlowStopReason(c.stoppedBy) ? { stoppedBy: c.stoppedBy } : {}),
    ...(typeof c.error === 'string' ? { error: c.error } : {}),
    ...(Array.isArray(c.manifest) ? { manifest: c.manifest } : {}),
    ...(c.manifestTruncated === true ? { manifestTruncated: true as const } : {}),
    ...(c.eventPending === true ? { eventPending: true as const } : {}),
  };
}

/** Every valid detached-flow record among a store's key/value pairs (one
 * read of the whole store rather than N keyed reads; the record set is
 * capped at `MAX_DETACHED_FLOW_RECORDS`): other keys and records that do
 * not parse are skipped. */
export function detachedFlowRecordsIn(stored: Record<string, unknown>): DetachedFlowRecord[] {
  const records: DetachedFlowRecord[] = [];
  for (const [key, value] of Object.entries(stored)) {
    if (flowIdFromDetachedFlowKey(key) === null) continue;
    const record = parseDetachedFlowRecord(value);
    if (record) records.push(record);
  }
  return records;
}

/** Which stored records to evict so `MAX_DETACHED_FLOW_RECORDS` holds,
 * oldest-start first. RUNNING records are never evicted regardless of age:
 * dropping one would erase the only evidence that a flow was in flight, and
 * a worker restart would then have nothing to mark `worker-terminated`.
 * Records still owing their summary event (`eventPending`) go LAST, reached
 * only when nothing else is left: evicting one destroys an audit event no
 * one has received, but a cap that can never be enforced would block every
 * new record. The exemption lapses when the flush clears the flag. */
export function detachedFlowRecordsToEvict(
  records: readonly DetachedFlowRecord[],
): DetachedFlowRecord[] {
  const terminal = records
    .filter((r) => r.state !== 'running')
    .sort((a, b) => a.startedAt - b.startedAt);
  const keep = Math.max(0, MAX_DETACHED_FLOW_RECORDS - (records.length - terminal.length));
  const excess = terminal.length - keep;
  if (excess <= 0) return [];
  return [
    ...terminal.filter((r) => r.eventPending !== true),
    ...terminal.filter((r) => r.eventPending === true),
  ].slice(0, excess);
}
