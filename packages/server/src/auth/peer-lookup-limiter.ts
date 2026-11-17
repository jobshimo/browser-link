import { PEER_LOOKUP_DEADLINE_MS, type PeerLookupResult } from './process-identity.js';

/**
 * Lookups that may run at once across both ports (IPC accepts and WebSocket
 * upgrades, `/handshake-check` included). One Windows lookup is one cold
 * PowerShell reading the kernel TCP table, about 0.4 s (about 1.5 s when it
 * falls back to netstat plus a PowerShell CIM call); four keeps
 * a burst of reconnecting tabs and proxies moving without letting a local
 * flood start dozens of them. It stays above the `/handshake-check` cap (2),
 * so diagnostics alone can never take every slot.
 */
export const PEER_LOOKUP_MAX_IN_FLIGHT = 4;

/**
 * How long a connection may wait for a slot before it is refused with
 * `lookup-busy`. About one normal Windows lookup: with four slots, a burst of
 * eight connections arriving together is still served.
 */
export const PEER_LOOKUP_MAX_WAIT_MS = 1000;

/** The longest the peer gate can take to decide on one connection: the wait
 * for a slot plus the lookup's total deadline. A client that waits for the
 * gate's answer (the proxy's reconnect handshake) waits at least this. */
export const PEER_GATE_MAX_MS = PEER_LOOKUP_MAX_WAIT_MS + PEER_LOOKUP_DEADLINE_MS;

export interface PeerLookupLimits {
  maxInFlight: number;
  maxWaitMs: number;
  /** The total budget each lookup gets, across all its commands. */
  deadlineMs: number;
}

/** One lookup, given its total budget in ms. */
export type BudgetedLookup = (totalTimeoutMs: number) => Promise<PeerLookupResult>;

/**
 * Bounds the OS process lookups the peer gate starts: at most `maxInFlight`
 * run, a connection waits at most `maxWaitMs` for a slot (in arrival order),
 * and each lookup is answered within `deadlineMs`. Every bound fails closed:
 * no slot in time is `lookup-busy`, a lookup still running at its deadline
 * is `deadline`; the lookup's own answer never turns either into an accept.
 *
 * The lookup is handed the same deadline as its budget, so its commands are
 * killed by then; the slot is freed at the deadline at the latest, so a
 * lookup that never settles cannot hold one for ever. A rejection (a bug,
 * never a verdict) is passed on and frees the slot.
 */
export class PeerLookupLimiter {
  readonly limits: PeerLookupLimits;
  private inFlight = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(limits: Partial<PeerLookupLimits> = {}) {
    this.limits = {
      maxInFlight: limits.maxInFlight ?? PEER_LOOKUP_MAX_IN_FLIGHT,
      maxWaitMs: limits.maxWaitMs ?? PEER_LOOKUP_MAX_WAIT_MS,
      deadlineMs: limits.deadlineMs ?? PEER_LOOKUP_DEADLINE_MS,
    };
  }

  /** Lookups running now. */
  inFlightCount(): number {
    return this.inFlight;
  }

  run(lookup: BudgetedLookup): Promise<PeerLookupResult> {
    return new Promise((resolve, reject) => {
      const start = (): void => {
        this.start(lookup, resolve, reject);
      };
      if (this.inFlight < this.limits.maxInFlight && this.waiting.length === 0) {
        start();
        return;
      }
      const { maxInFlight, maxWaitMs } = this.limits;
      const waiter = (): void => {
        clearTimeout(timer);
        start();
      };
      const timer = setTimeout(() => {
        const index = this.waiting.indexOf(waiter);
        if (index >= 0) this.waiting.splice(index, 1);
        resolve({
          ok: false,
          cause: 'lookup-busy',
          detail: `${String(maxInFlight)} ${maxInFlight === 1 ? 'lookup' : 'lookups'} in flight, no slot free within ${String(maxWaitMs)} ms`,
        });
      }, maxWaitMs);
      timer.unref();
      this.waiting.push(waiter);
    });
  }

  private start(
    lookup: BudgetedLookup,
    resolve: (result: PeerLookupResult) => void,
    reject: (err: unknown) => void,
  ): void {
    const { deadlineMs } = this.limits;
    this.inFlight++;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      clearTimeout(timer);
      this.inFlight--;
      if (this.inFlight < this.limits.maxInFlight) this.waiting.shift()?.();
    };
    const timer = setTimeout(() => {
      release();
      resolve({ ok: false, cause: 'deadline', detail: `total budget ${String(deadlineMs)} ms` });
    }, deadlineMs);
    timer.unref();
    let pending: Promise<PeerLookupResult>;
    try {
      pending = lookup(deadlineMs);
    } catch (err) {
      release();
      reject(err);
      return;
    }
    pending.then(
      (result) => {
        release();
        resolve(result);
      },
      (err: unknown) => {
        release();
        reject(err);
      },
    );
  }
}

/** The one limiter the IPC server and the WebSocket gate share. */
export const sharedPeerLookupLimiter = new PeerLookupLimiter();
