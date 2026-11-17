// What every `CdpSession` adapter guarantees (5.3, item 5).

import type { CdpSession } from '../cdp-session.js';
import { check, type ContractCase, equal } from './assert.js';

export interface CdpSessionHarness {
  session: CdpSession;
  /** A command the subject answers, and the result it answers with. */
  answered: { method: string; params?: Record<string, unknown>; result: unknown };
  /** A command the subject fails, and the CDP error message it fails with. */
  failing: { method: string; params?: Record<string, unknown>; message: string };
  /**
   * Make the page emit events. Resolves once they were delivered, with the
   * methods of the expected events in emission order.
   */
  trigger: () => Promise<readonly string[]>;
  dispose?: () => Promise<void> | void;
}

export function defineCdpSessionContract(
  make: () => Promise<CdpSessionHarness> | CdpSessionHarness,
): ContractCase[] {
  const withHarness =
    (body: (harness: CdpSessionHarness) => Promise<void>) => async (): Promise<void> => {
      const harness = await make();
      try {
        await body(harness);
      } finally {
        await harness.dispose?.();
      }
    };

  return [
    {
      name: 'send resolves with the CDP result',
      run: withHarness(async ({ session, answered }) => {
        const result = await session.send(answered.method, answered.params);
        equal(result, answered.result, `${answered.method} result`);
      }),
    },
    {
      name: 'send rejects with the CDP error message unchanged',
      run: withHarness(async ({ session, failing }) => {
        let message: string | null = null;
        try {
          await session.send(failing.method, failing.params);
        } catch (err) {
          message = err instanceof Error ? err.message : String(err);
        }
        equal(message, failing.message, `${failing.method} error message`);
      }),
    },
    {
      name: 'events arrive in emission order',
      run: withHarness(async ({ session, trigger }) => {
        const received: string[] = [];
        const unsubscribe = session.onEvent((method) => received.push(method));
        const expected = await trigger();
        unsubscribe();
        check(expected.length > 0, 'trigger() must expect at least one event');
        const wanted = new Set(expected);
        equal(
          received.filter((method) => wanted.has(method)),
          expected,
          'event methods',
        );
      }),
    },
    {
      name: 'no event reaches a listener after it unsubscribed',
      run: withHarness(async ({ session, trigger }) => {
        const received: string[] = [];
        const unsubscribe = session.onEvent((method) => received.push(method));
        unsubscribe();
        await trigger();
        equal(received, [], 'events after unsubscribe');
      }),
    },
  ];
}
