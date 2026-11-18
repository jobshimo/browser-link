// GENERATED from packages/core/src/session/pending-replies.ts. Do not edit.
// Request/reply correlation by id over a channel that answers out of order
// (design section 4, `PendingReplies<T>`). The extension keeps one per kind
// of round trip it makes over a tab's socket: the Activity trail, the Admin
// console and the Repair button.

import type { Clock } from '../ports/clock.js';

/**
 * Invariants:
 * 1. An id settles at most once: by its reply (`settle`) or by its timeout,
 *    whichever comes first; the other one is then a no-op.
 * 2. A reply for an unknown id (never waited for, already answered or
 *    timed out) is ignored.
 * 3. A waiter never leaks past its timeout: the timeout settles it with
 *    `onTimeout()` and forgets the id. A disconnect settles nothing; the
 *    waiter still ends at its timeout.
 */
export class PendingReplies<T> {
  private readonly waiters = new Map<string, (reply: T) => void>();

  constructor(private readonly clock: Clock) {}

  /**
   * Wait for the reply to `id`. The waiter is registered before this
   * returns, so the request may be sent right after. After `timeoutMs` the
   * promise resolves with `onTimeout()` and a later reply is ignored.
   */
  wait(id: string, timeoutMs: number, onTimeout: () => T): Promise<T> {
    return new Promise<T>((resolve) => {
      const cancel = this.clock.after(timeoutMs, () => {
        this.waiters.delete(id);
        resolve(onTimeout());
      });
      this.waiters.set(id, (reply) => {
        cancel();
        resolve(reply);
      });
    });
  }

  /**
   * Hand `reply` to the waiter of `id` and forget it. `id` arrives off the
   * socket: a `Map` lookup returns only what `wait` stored (an id such as
   * `__proto__` finds nothing), and the `typeof` check makes "never call
   * something this class did not store" a property of the code.
   */
  settle(id: string, reply: T): void {
    const waiter = this.waiters.get(id);
    if (typeof waiter !== 'function') return;
    this.waiters.delete(id);
    waiter(reply);
  }
}
