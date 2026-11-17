// What every `DragInput` guarantees (5.3, item 5): an input port, one CDP
// command per call (slice 14). It runs against the page driver's drag input
// over a `CdpSession`, on the in-memory fake and on a real Chrome target.

import type { DragInput } from '../page-driver.js';
import type { DragEventParams } from '../values.js';
import { type ContractCase, equal } from './assert.js';

export interface DragInputHarness {
  drag: DragInput;
  /** A drag event the page refuses, and the CDP error message it fails with. */
  failing: { event: DragEventParams; message: string };
  /** An interception switch the page refuses, and its CDP error message. */
  failingIntercept: { enabled: boolean; message: string };
  dispose?: () => Promise<void> | void;
}

export function defineDragInputContract(
  make: () => Promise<DragInputHarness> | DragInputHarness,
): ContractCase[] {
  const withHarness =
    (body: (harness: DragInputHarness) => Promise<void>) => async (): Promise<void> => {
      const harness = await make();
      try {
        await body(harness);
      } finally {
        await harness.dispose?.();
      }
    };

  return [
    {
      name: 'interceptDrags resolves once the page answered it, switching on and off',
      run: withHarness(async ({ drag }) => {
        await drag.interceptDrags(true);
        await drag.interceptDrags(false);
      }),
    },
    {
      name: 'a failed interceptDrags rejects with the CDP error message unchanged',
      run: withHarness(async ({ drag, failingIntercept }) => {
        let message: string | null = null;
        try {
          await drag.interceptDrags(failingIntercept.enabled);
        } catch (err) {
          message = err instanceof Error ? err.message : String(err);
        }
        equal(message, failingIntercept.message, 'error message');
      }),
    },
    {
      name: 'a failed drag event rejects with the CDP error message unchanged',
      run: withHarness(async ({ drag, failing }) => {
        let message: string | null = null;
        try {
          await drag.dragEvent(failing.event);
        } catch (err) {
          message = err instanceof Error ? err.message : String(err);
        }
        equal(message, failing.message, 'error message');
      }),
    },
  ];
}
