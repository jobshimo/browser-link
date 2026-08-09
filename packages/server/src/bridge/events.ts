/**
 * In-memory ring buffer of bridge lifecycle events. Exposed to the agent
 * through the `browser.events` MCP tool so it can self-recover after a
 * primary swap or tab id rename: instead of failing blind on a stale
 * tab_id, the agent calls browser.events, sees a `tab-renamed` entry,
 * and resumes work on the new id.
 *
 * The buffer is per-process. When the primary dies and a new primary
 * takes over, the new primary starts with an empty buffer plus its own
 * `primary-elected` event as the fundamental marker — older history is
 * intentionally lost (the agent has nothing useful to do with it anyway).
 */

export type BridgeEventKind =
  | 'primary-elected'
  | 'tab-registered'
  | 'tab-disconnected'
  | 'tab-renamed'
  | 'tab-claimed'
  | 'tab-released'
  | 'tab-claim-rejected'
  | 'dialog-opening'
  | 'dialog-closed'
  | 'tab-created'
  | 'flow-recorded'
  | 'flow-finished';

/** Kinds the extension is permitted to push via `bridge.event`. Lifecycle
 * events (primary-elected, tab-registered, etc.) are produced server-side
 * and must NOT be spoofable from the extension side. `flow-recorded` is
 * ALSO server-owned — the extension sends the dedicated `flow.recorded`
 * message (validated + persisted by `ws-bridge.ts`'s
 * `handleFlowRecordedMessage`), never a raw `bridge.event`, so a recipe
 * cannot be announced to `browser.events` without having actually passed
 * `validateFlowSteps` and landed in the map.
 *
 * `flow-finished` IS extension-pushable, and belongs on this list rather
 * than beside `flow-recorded`: it asserts only what the extension itself
 * just did (it ran the flow), not something that had to pass server-side
 * validation and land in a database. It is emitted exactly ONCE per
 * detached flow — never per iteration, which with `MAX_EVENTS = 200` would
 * let a single 200-iteration run silently evict every other event in the
 * log. On cdp-direct the same event is added server-side by
 * `cdp/detached-flows.ts`, since there is no extension there to push it. */
const EXTENSION_EVENT_KINDS: ReadonlySet<BridgeEventKind> = new Set([
  'dialog-opening',
  'dialog-closed',
  'tab-created',
  'flow-finished',
]);

export function isExtensionEventKind(kind: string): kind is BridgeEventKind {
  return EXTENSION_EVENT_KINDS.has(kind as BridgeEventKind);
}

export interface BridgeEvent {
  /** Monotonic id assigned by addEvent. */
  id: number;
  /** ISO-8601 timestamp. */
  at: string;
  kind: BridgeEventKind;
  /** Kind-specific payload. Documented per-kind in the JSDoc below. */
  data: Record<string, unknown>;
}

const MAX_EVENTS = 200;

export type BridgeEventListener = (event: BridgeEvent) => void;

export interface SubscribeOptions {
  /** If > 0, the listener is invoked synchronously with every event in the
   * buffer that is at most `replayWithinMs` old, BEFORE subscribe returns.
   * Lets a caller racing the source of an event still see it: the agent
   * fires an action and `wait_for_tab` in the same MCP batch, the action
   * lands first, wait_for_tab subscribes with replayWithinMs=1500 and the
   * fresh `tab-created` event reaches its listener. Events older than the
   * window are NOT replayed — those belong to a previous flow. */
  replayWithinMs?: number;
}

export class BridgeEventLog {
  private buffer: BridgeEvent[] = [];
  private nextId = 1;
  private listeners = new Set<BridgeEventListener>();

  /** Append an event and return it. Drops the oldest if the buffer is full.
   * Notifies every active subscriber synchronously AFTER the buffer is
   * updated — so a listener that calls `recent()` sees the new entry. */
  add(kind: BridgeEventKind, data: Record<string, unknown> = {}): BridgeEvent {
    const event: BridgeEvent = {
      id: this.nextId++,
      at: new Date().toISOString(),
      kind,
      data,
    };
    this.buffer.push(event);
    if (this.buffer.length > MAX_EVENTS) this.buffer.shift();
    // Iterate a snapshot of the set so a listener that unsubscribes itself
    // mid-fire doesn't skip its peers. Catch per-listener errors so one
    // bad listener can't take the whole notification chain down.
    for (const fn of [...this.listeners]) {
      try {
        fn(event);
      } catch {
        // Best-effort delivery — listener failures stay local.
      }
    }
    return event;
  }

  /** Subscribe to every event ADDED after this call returns. Returns an
   * unsubscribe function the caller MUST invoke (on completion / timeout /
   * error) to avoid leaks.
   *
   * If `options.replayWithinMs` is set, recent events from the buffer are
   * replayed synchronously to the listener BEFORE subscribe returns —
   * see `SubscribeOptions.replayWithinMs` for the rationale. */
  subscribe(fn: BridgeEventListener, options: SubscribeOptions = {}): () => void {
    // Register first so a listener that opts to unsubscribe itself during
    // replay does so against a live registration (the unsubscribe path
    // calls `this.listeners.delete(fn)` and the replay loop breaks when
    // membership drops).
    this.listeners.add(fn);

    const replayMs = options.replayWithinMs;
    if (typeof replayMs === 'number' && replayMs > 0) {
      const cutoff = Date.now() - replayMs;
      for (const e of this.buffer) {
        if (!this.listeners.has(fn)) break;
        const at = Date.parse(e.at);
        if (!Number.isFinite(at) || at < cutoff) continue;
        try {
          fn(e);
        } catch {
          // Best-effort replay.
        }
      }
    }

    return () => {
      this.listeners.delete(fn);
    };
  }

  /** Return up to `limit` recent events, optionally filtered to those
   * with id > sinceId. Cursor pattern — pass the previous-call's last id
   * back in as sinceId to get only what's new. */
  recent(opts: { sinceId?: number; limit?: number } = {}): BridgeEvent[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 20, MAX_EVENTS));
    const sinceId = opts.sinceId;
    const filtered =
      sinceId === undefined ? this.buffer : this.buffer.filter((e) => e.id > sinceId);
    return filtered.slice(-limit);
  }

  /** The highest id currently in the buffer (0 if empty). */
  latestId(): number {
    return this.buffer.length === 0 ? 0 : this.buffer[this.buffer.length - 1].id;
  }

  /** Total number of events in the buffer. */
  size(): number {
    return this.buffer.length;
  }

  /** Drop every event in the buffer and reset the id counter. Returns the
   * count dropped, so callers can surface it (used by `browser.reset`). */
  clear(): number {
    const dropped = this.buffer.length;
    this.buffer = [];
    this.nextId = 1;
    return dropped;
  }
}
