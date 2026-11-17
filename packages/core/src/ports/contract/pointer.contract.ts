// What every `Pointer` guarantees (5.3, item 5): an input port, one mouse
// event per call (design revision 8). It runs against the page driver's
// pointer over a `CdpSession`, on the in-memory fake and on a real Chrome
// target. Dialog handling is the driver's, not the port's.

import type { Pointer } from '../page-driver.js';
import type { MouseEventParams } from '../values.js';
import { type ContractCase, equal } from './assert.js';

export interface PointerHarness {
  pointer: Pointer;
  /** A point on the page where mouse events land. */
  at: { x: number; y: number };
  /** The mouse events the page received so far, as CDP event types
   * (`mouseMoved`, `mousePressed`, `mouseReleased`), in order. */
  received: () => Promise<readonly string[]>;
  /** An event the page refuses, and the CDP error message it fails with. */
  failing: { event: MouseEventParams; message: string };
  dispose?: () => Promise<void> | void;
}

export function definePointerContract(
  make: () => Promise<PointerHarness> | PointerHarness,
): ContractCase[] {
  const withHarness =
    (body: (harness: PointerHarness) => Promise<void>) => async (): Promise<void> => {
      const harness = await make();
      try {
        await body(harness);
      } finally {
        await harness.dispose?.();
      }
    };

  return [
    {
      name: 'mouse resolves once the page received the event',
      run: withHarness(async ({ pointer, at, received }) => {
        await pointer.mouse({ type: 'mouseMoved', x: at.x, y: at.y });
        equal(await received(), ['mouseMoved'], 'events');
      }),
    },
    {
      name: 'events dispatched in turn arrive in that order',
      run: withHarness(async ({ pointer, at, received }) => {
        await pointer.mouse({ type: 'mouseMoved', x: at.x, y: at.y });
        await pointer.mouse({
          type: 'mousePressed',
          x: at.x,
          y: at.y,
          button: 'left',
          clickCount: 1,
        });
        await pointer.mouse({
          type: 'mouseReleased',
          x: at.x,
          y: at.y,
          button: 'left',
          clickCount: 1,
        });
        equal(await received(), ['mouseMoved', 'mousePressed', 'mouseReleased'], 'events');
      }),
    },
    {
      name: 'a failed dispatch rejects with the CDP error message unchanged',
      run: withHarness(async ({ pointer, failing }) => {
        let message: string | null = null;
        try {
          await pointer.mouse(failing.event);
        } catch (err) {
          message = err instanceof Error ? err.message : String(err);
        }
        equal(message, failing.message, 'error message');
      }),
    },
  ];
}
