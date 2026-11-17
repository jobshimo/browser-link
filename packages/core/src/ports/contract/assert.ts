// The contract suite's only assertion helper: no test-runner globals, so the
// same contract runs under vitest, inside the extension's service worker and
// against a real Chrome target (5.3, item 5).

/** One named check of a contract; `run` rejects when the subject breaks it. */
export interface ContractCase {
  name: string;
  run(): Promise<void>;
}

export class ContractViolation extends Error {
  override name = 'ContractViolation';
}

export function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new ContractViolation(message);
}

/** Structural equality through canonical JSON (key order included). */
export function equal(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(a === e, `${what}: expected ${e}, got ${a}`);
}

export type Outcome = 'resolved' | 'rejected' | 'pending';

/**
 * Observe how a promise ends, without leaving a rejection unobserved.
 * `now()` reports `'pending'` while it has not settled. It first yields a
 * few microtasks, so a settlement already scheduled is seen, and never waits
 * on a timer (core has none): a subject that never settles fails the
 * contract instead of hanging it.
 */
export function observe(promise: Promise<unknown>): { now(): Promise<Outcome> } {
  let state: Outcome = 'pending';
  promise.then(
    () => {
      state = 'resolved';
    },
    () => {
      state = 'rejected';
    },
  );
  return {
    async now() {
      for (let i = 0; i < 10; i++) await Promise.resolve();
      return state;
    },
  };
}
