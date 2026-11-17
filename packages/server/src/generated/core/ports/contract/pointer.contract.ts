// GENERATED from packages/core/src/ports/contract/pointer.contract.ts. Do not edit.
// What every `Pointer` guarantees (5.3, item 5): the page driver's pointer
// over a `CdpSession`, on the in-memory fake and on a real Chrome target.

import type { Pointer } from '../page-driver.js';
import { type ContractCase, equal } from './assert.js';

export interface PointerHarness {
  pointer: Pointer;
  /** A point on the page where mouse events land. */
  at: { x: number; y: number };
  /** The mouse events the page received so far, as CDP event types
   * (`mouseMoved`, `mousePressed`, `mouseReleased`), in order. */
  received: () => Promise<readonly string[]>;
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
      name: 'mouse dispatches the events in order and reports no dialog',
      run: withHarness(async ({ pointer, at, received }) => {
        const answer = await pointer.mouse([
          { type: 'mouseMoved', x: at.x, y: at.y },
          { type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 1 },
          { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 1 },
        ]);
        equal(answer, { dialog: false }, 'mouse answer');
        equal(await received(), ['mouseMoved', 'mousePressed', 'mouseReleased'], 'events');
      }),
    },
    {
      name: 'a watched move within its budget is sent and reports no dialog',
      run: withHarness(async ({ pointer, at, received }) => {
        const answer = await pointer.watchedMove({ type: 'mouseMoved', x: at.x, y: at.y }, 1_500);
        equal(answer, { dialog: false }, 'watched move answer');
        equal(await received(), ['mouseMoved'], 'events');
      }),
    },
    {
      name: 'no dialog is open on a page that opened none',
      run: withHarness(({ pointer }) => {
        equal(pointer.dialogOpen(), false, 'dialogOpen');
        return Promise.resolve();
      }),
    },
  ];
}
