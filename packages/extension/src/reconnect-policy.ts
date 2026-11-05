/**
 * Pure decision logic + injectable scheduler for auto-reconnecting a tab's
 * WebSocket bridge after an INVOLUNTARY close (the primary MCP server died
 * or restarted under us).
 *
 * Deliberately kept free of chrome.* — background.ts owns the WebSocket
 * lifecycle, the `chrome.storage.session` persistence, and the actual
 * `connectTab` call; this module owns WHEN to retry and at what pace, so
 * the backoff behavior is unit-tested without mocking sockets or storage.
 * Same separation idle-policy.ts already established for the WS-idle sweep.
 *
 * The reconnect itself reuses the existing continuity machinery unchanged:
 * `connectTab` reads the preserved `prevTabId:*` session key and asks the
 * new primary to honour the old tab_id (the server emits `tab-renamed` in
 * the bridge event log when it can't — existing contract).
 *
 * Security tradeoff (documented in the README's security model): a retry
 * reuses the same unauthenticated loopback channel a manual Connect uses,
 * minus the human gesture — accepted, like the port-squatting caveat.
 */

/**
 * How long a dropped tab keeps being retried: 10 minutes. Measured in a real
 * session, the primary bridge process died, the old 15s budget ran out while
 * the agent was still diagnosing, and the tab stayed released until the
 * human pressed Connect again. A retry against a dead loopback port is
 * nearly free; giving up costs the whole session, so keep trying while the
 * Chrome tab is still open. Past the window the popup's Connect button is
 * the fallback, as before.
 */
export const RECONNECT_WINDOW_MS = 10 * 60_000;

/** Slowest pace of the backoff (the plateau after the ramp). */
export const RECONNECT_MAX_DELAY_MS = 30_000;

/** First, fast steps — sized for the common failure, a primary restarting
 * within seconds — before settling onto the plateau. */
const RECONNECT_RAMP_MS: readonly number[] = [1000, 2000, 4000, 8000, 15_000];

/**
 * chrome.alarms' minimum delay (Chrome 120+). Used for the safety-net
 * alarm that wakes a sleeping MV3 service worker (see background.ts).
 */
export const ALARM_MIN_DELAY_MS = 30_000;

/** Capped exponential backoff: the `ramp` steps, then `capMs` repeated for
 * as long as the cumulative scheduled wait stays within `windowMs`. */
export function buildReconnectDelays(
  opts: { ramp?: readonly number[]; capMs?: number; windowMs?: number } = {},
): number[] {
  const ramp = opts.ramp ?? RECONNECT_RAMP_MS;
  const capMs = opts.capMs ?? RECONNECT_MAX_DELAY_MS;
  const windowMs = opts.windowMs ?? RECONNECT_WINDOW_MS;
  const delays: number[] = [];
  let total = 0;
  for (const d of ramp) {
    if (total + d > windowMs) return delays;
    delays.push(d);
    total += d;
  }
  while (total + capMs <= windowMs) {
    delays.push(capMs);
    total += capMs;
  }
  return delays;
}

/**
 * Backoff schedule, one entry per attempt: 1s, 2s, 4s, 8s, 15s, then every
 * 30s until the 10-minute window is spent (24 attempts, exactly 600s of
 * scheduled wait; each attempt's own duration — debugger attach, CDP
 * enables, WS round trip — adds on top). No jitter: it is a single local
 * client talking to a single loopback port, so there is no herd to spread.
 *
 * MV3 durability: plain timers cover the fast ramp (each fire touches
 * chrome.* APIs, which resets the worker's ~30s idle clock), but the 30s
 * plateau lets Chrome tear the worker down between attempts. background.ts
 * therefore mirrors every armed attempt into `pendingReconnect:*` storage
 * AND a `chrome.alarms` safety net; the alarm wakes the worker, which
 * resumes from storage (see resumePendingReconnects).
 */
export const RECONNECT_DELAYS_MS: readonly number[] = buildReconnectDelays();

/**
 * How long a persisted `pendingReconnect:*` entry stays resumable. Each
 * schedule refreshes `updatedAt`, so this only has to cover the longest
 * gap between schedules; it is set to the whole retry window plus a minute
 * of slack so the stored state always outlives the schedule it describes.
 * Past it the entry is discarded and the popup's Connect button is the
 * fallback.
 */
export const RECONNECT_STATE_TTL_MS = RECONNECT_WINDOW_MS + 60_000;

/** chrome.storage.session key prefix for per-tab reconnect state — sits
 * alongside the existing `prevTabId:*` keys (same area, same per-browser-
 * session lifetime, same per-Chrome-tab keying). */
export const RECONNECT_STORAGE_PREFIX = 'pendingReconnect:';

/** Error message background.ts's `connectTab` returns to a caller that
 * lost the per-tab in-flight race (e.g. a popup Connect landing while a
 * scheduled reconnect attempt is mid-flight). The popup matches on this
 * EXACT string to render the benign "Reconnecting" card instead of an
 * error card — both entrypoints import it from here so the contract
 * cannot drift. */
export const CONNECT_IN_PROGRESS_ERROR = 'A connection attempt for this tab is already in progress';

export function reconnectStorageKey(tabId: number): string {
  return `${RECONNECT_STORAGE_PREFIX}${tabId}`;
}

/** Inverse of `reconnectStorageKey` — `null` for keys that are not ours or
 * do not carry a plain non-negative integer tab id. */
export function tabIdFromReconnectKey(key: string): number | null {
  if (!key.startsWith(RECONNECT_STORAGE_PREFIX)) return null;
  const raw = key.slice(RECONNECT_STORAGE_PREFIX.length);
  if (!/^\d+$/.test(raw)) return null;
  return Number(raw);
}

/** Delay before the given 0-based attempt, or `undefined` once the retry
 * budget is exhausted. */
export function reconnectDelayMs(
  attempt: number,
  delays: readonly number[] = RECONNECT_DELAYS_MS,
): number | undefined {
  if (!Number.isInteger(attempt) || attempt < 0) return undefined;
  return delays[attempt];
}

/**
 * What background.ts's WS close handler knows about a close, reduced to the
 * three facts that decide whether auto-reconnect should kick in.
 */
export interface CloseContext {
  /** The closing socket is still the one this tab's TabState points at.
   * False when `cleanup` already ran (explicit disconnect, tab removal,
   * idle park, debugger detach — every extension-initiated teardown
   * deletes the state BEFORE the close event dispatches) or when a newer
   * connection superseded this socket. */
  tracked: boolean;
  /** `tab.registered` completed on this connection — pre-registration
   * failures are connect errors the popup surfaces, not drops to recover. */
  registered: boolean;
  /** CloseEvent.wasClean — a clean close means the peer deliberately said
   * goodbye (e.g. the server's browser.reset closing every tab socket,
   * which documents that the user must re-press Connect). Only an UNCLEAN
   * close (dead process, killed socket) is an involuntary drop. */
  wasClean: boolean;
}

/** Whether a WS close should trigger the auto-reconnect scheduler. */
export function isInvoluntaryClose(ctx: CloseContext): boolean {
  return ctx.tracked && ctx.registered && !ctx.wasClean;
}

/** Persisted per-tab reconnect state (`pendingReconnect:*` value shape). */
export interface StoredReconnectState {
  /** 0-based index of the attempt that was scheduled when the state was
   * written — resuming re-arms the SAME attempt, so a killed service
   * worker replays the pending delay instead of restarting the budget. */
  attempt: number;
  /** Epoch ms of the last schedule — see `isReconnectStateFresh`. */
  updatedAt: number;
  /** Epoch ms the scheduled attempt is due. Lets a resumed cycle wait only
   * the REMAINING time (or fire at once if the worker slept past it)
   * instead of replaying the full step. Optional: older entries lack it. */
  dueAt?: number;
}

/** Remaining wait for a resumed attempt, or `undefined` when the entry has
 * no `dueAt` (the scheduler then uses the attempt's regular delay). */
export function resumeDelayMs(state: StoredReconnectState, now: number): number | undefined {
  if (state.dueAt === undefined) return undefined;
  return Math.max(0, state.dueAt - now);
}

/** Runtime shape guard for a stored `pendingReconnect:*` value — storage
 * contents are untrusted (corruption, future shape changes), so malformed
 * entries are rejected here and discarded by the caller. */
export function parseStoredReconnectState(value: unknown): StoredReconnectState | null {
  if (!value || typeof value !== 'object') return null;
  const s = value as Record<string, unknown>;
  if (typeof s.attempt !== 'number' || !Number.isInteger(s.attempt) || s.attempt < 0) return null;
  if (typeof s.updatedAt !== 'number' || !Number.isFinite(s.updatedAt)) return null;
  const dueAt = typeof s.dueAt === 'number' && Number.isFinite(s.dueAt) ? s.dueAt : undefined;
  return dueAt === undefined
    ? { attempt: s.attempt, updatedAt: s.updatedAt }
    : { attempt: s.attempt, updatedAt: s.updatedAt, dueAt };
}

/** Whether a persisted reconnect entry is still worth resuming. A negative
 * age (clock went backwards) counts as stale — the fallback is just the
 * popup's Connect button, so err on the quiet side. */
export function isReconnectStateFresh(updatedAt: number, now: number): boolean {
  const age = now - updatedAt;
  return age >= 0 && age < RECONNECT_STATE_TTL_MS;
}

/** Outcome of one reconnect attempt, as reported by the injected `attempt`
 * callback: 'connected' and 'stop' both end the cycle (success vs. "the
 * tab is gone, nothing to reconnect"), 'retry' arms the next backoff step. */
export type ReconnectAttemptResult = 'connected' | 'retry' | 'stop';

export interface ReconnectSchedulerOptions {
  /** Perform one reconnect attempt for this tab. A rejection is treated as
   * 'retry' so a throwing chrome.* call never strands the cycle. */
  attempt(tabId: number): Promise<ReconnectAttemptResult>;
  /** Override the backoff schedule (tests). */
  delaysMs?: readonly number[];
  /** Timer injection (tests) — defaults to global setTimeout/clearTimeout. */
  setTimer?: (fn: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Persistence hook: called with the newly-armed attempt on every
   * schedule, and with `null` whenever the cycle ends for any reason
   * (success, stop, cancel, exhaustion) — background.ts mirrors this into
   * `chrome.storage.session` so a killed service worker can resume. */
  onStateChange?(tabId: number, state: { attempt: number; delayMs: number } | null): void;
}

export interface ReconnectScheduler {
  /** Arm a reconnect cycle for this tab starting at `startAttempt`
   * (0 for a fresh drop; the persisted attempt when resuming). Returns
   * false — scheduling nothing — when a cycle is already pending for the
   * tab (per-tab backoff, no thundering herd) or the budget is already
   * exhausted at `startAttempt` (a stale resume). `firstDelayMs`
   * overrides the first wait (a resume waits only the time that was left). */
  schedule(tabId: number, startAttempt?: number, firstDelayMs?: number): boolean;
  /** Abort the tab's pending cycle, if any — explicit disconnect, explicit
   * popup Connect, and tab removal all route here. Safe mid-attempt: an
   * in-flight `attempt` whose cycle was cancelled never re-arms. */
  cancel(tabId: number): boolean;
  /** Whether a reconnect cycle (timer armed or attempt in flight) is
   * pending for this tab — what the popup's "Reconnecting" state reads. */
  isPending(tabId: number): boolean;
}

interface PendingEntry {
  attempt: number;
  /** Undefined while the attempt callback is in flight. */
  timer: unknown;
}

export function createReconnectScheduler(options: ReconnectSchedulerOptions): ReconnectScheduler {
  const delays = options.delaysMs ?? RECONNECT_DELAYS_MS;
  const setTimer =
    options.setTimer ?? ((fn: () => void, delayMs: number): unknown => setTimeout(fn, delayMs));
  const clearTimer =
    options.clearTimer ??
    ((handle: unknown): void => {
      clearTimeout(handle as number);
    });
  const pending = new Map<number, PendingEntry>();

  const notify = (tabId: number, state: { attempt: number; delayMs: number } | null): void => {
    options.onStateChange?.(tabId, state);
  };

  function arm(
    tabId: number,
    entry: PendingEntry,
    attempt: number,
    delayOverrideMs?: number,
  ): boolean {
    const stepMs = reconnectDelayMs(attempt, delays);
    if (stepMs === undefined) {
      // Budget exhausted — end the cycle cleanly. The popup's Connect
      // button remains the fallback, exactly as before this feature.
      pending.delete(tabId);
      notify(tabId, null);
      return false;
    }
    const delayMs = delayOverrideMs ?? stepMs;
    entry.attempt = attempt;
    entry.timer = setTimer(() => {
      void fire(tabId, entry);
    }, delayMs);
    notify(tabId, { attempt, delayMs });
    return true;
  }

  async function fire(tabId: number, entry: PendingEntry): Promise<void> {
    entry.timer = undefined;
    let result: ReconnectAttemptResult;
    try {
      result = await options.attempt(tabId);
    } catch {
      result = 'retry';
    }
    // Cancelled (or superseded) while the attempt was in flight — the
    // canceller already cleared state and notified; do nothing more.
    if (pending.get(tabId) !== entry) return;
    if (result === 'retry') {
      arm(tabId, entry, entry.attempt + 1);
      return;
    }
    pending.delete(tabId);
    notify(tabId, null);
  }

  return {
    schedule(tabId: number, startAttempt = 0, firstDelayMs?: number): boolean {
      if (pending.has(tabId)) return false;
      const entry: PendingEntry = { attempt: startAttempt, timer: undefined };
      pending.set(tabId, entry);
      return arm(tabId, entry, startAttempt, firstDelayMs);
    },
    cancel(tabId: number): boolean {
      const entry = pending.get(tabId);
      if (!entry) return false;
      if (entry.timer !== undefined) clearTimer(entry.timer);
      pending.delete(tabId);
      notify(tabId, null);
      return true;
    },
    isPending(tabId: number): boolean {
      return pending.has(tabId);
    },
  };
}
