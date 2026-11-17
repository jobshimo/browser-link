// The live sessions of a transport, by tab id, and the connects in flight
// (design section 4, `TabRegistry<S>`). The extension instantiates it with
// its `TabConnection`; cdp-direct keeps its own connection cache.

/** The error code of a connect on a tab that already has a live session. */
export const TAB_ALREADY_CONNECTED = 'tab-already-connected';

/** One connect attempt's hold on its tab, from `reserve` to `release`. */
export interface TabReservation {
  readonly tabId: number;
}

interface ReservationState {
  committed: boolean;
}

/**
 * Invariants:
 * 1. Create once: `commit` refuses (throws `TAB_ALREADY_CONNECTED`) a tab
 *    that already has a live session; the connect checks `has` first and
 *    answers `tab-already-connected` itself.
 * 2. In-flight reservation: `reserve` returns `null` while another
 *    reservation of the same tab is open. A reservation is committed at most
 *    once, never after it was released; `release` ends it, and releasing one
 *    that was never committed is its abort. The hold covers the whole
 *    attempt: the session it committed is live before the attempt ends.
 *    `isReservedOrLive` is what the popup's status reads.
 */
export class TabRegistry<S> {
  private readonly live = new Map<number, S>();
  private readonly open = new Map<number, TabReservation>();
  private readonly states = new WeakMap<TabReservation, ReservationState>();

  get(tabId: number): S | undefined {
    return this.live.get(tabId);
  }

  /** Whether the tab has a live session. */
  has(tabId: number): boolean {
    return this.live.has(tabId);
  }

  /** Whether a connect attempt holds the tab. */
  isReserved(tabId: number): boolean {
    return this.open.has(tabId);
  }

  isReservedOrLive(tabId: number): boolean {
    return this.isReserved(tabId) || this.has(tabId);
  }

  keys(): IterableIterator<number> {
    return this.live.keys();
  }

  values(): IterableIterator<S> {
    return this.live.values();
  }

  entries(): IterableIterator<[number, S]> {
    return this.live.entries();
  }

  [Symbol.iterator](): IterableIterator<[number, S]> {
    return this.live.entries();
  }

  /** Open a reservation on the tab; `null` while another one is open. */
  reserve(tabId: number): TabReservation | null {
    if (this.open.has(tabId)) return null;
    const reservation: TabReservation = { tabId };
    this.open.set(tabId, reservation);
    this.states.set(reservation, { committed: false });
    return reservation;
  }

  /** Make `session` the tab's live session. Throws when the reservation is
   * not open or already committed, or when the tab already has a session. */
  commit(reservation: TabReservation, session: S): void {
    const state = this.states.get(reservation);
    if (this.open.get(reservation.tabId) !== reservation || !state) {
      throw new Error('TabRegistry: commit of a reservation that is not open');
    }
    if (state.committed) throw new Error('TabRegistry: reservation already committed');
    if (this.live.has(reservation.tabId)) throw new Error(TAB_ALREADY_CONNECTED);
    state.committed = true;
    this.live.set(reservation.tabId, session);
  }

  /** End the reservation; a no-op when it already ended. */
  release(reservation: TabReservation): void {
    if (this.open.get(reservation.tabId) === reservation) this.open.delete(reservation.tabId);
  }

  /** Drop the tab's live session (its teardown); returns it, if any. */
  remove(tabId: number): S | undefined {
    const session = this.live.get(tabId);
    this.live.delete(tabId);
    return session;
  }
}
