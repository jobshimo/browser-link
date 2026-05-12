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
  | 'tab-claim-rejected';

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

export class BridgeEventLog {
  private buffer: BridgeEvent[] = [];
  private nextId = 1;

  /** Append an event and return it. Drops the oldest if the buffer is full. */
  add(kind: BridgeEventKind, data: Record<string, unknown> = {}): BridgeEvent {
    const event: BridgeEvent = {
      id: this.nextId++,
      at: new Date().toISOString(),
      kind,
      data,
    };
    this.buffer.push(event);
    if (this.buffer.length > MAX_EVENTS) this.buffer.shift();
    return event;
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
}
