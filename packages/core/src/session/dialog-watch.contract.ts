// What a transport's dialog watch guarantees (parity P3): the pending dialog
// a connection's dialog intake keeps reads open once the page shows a
// dialog, closed once the page answered it, and the intake sends one
// `dialog-opening` and one `dialog-closed` to the connection's sink. Runs on
// the in-memory `CdpSession` in core and on cdp-direct's watch over a real
// Chrome target (`cdp/adapters/contract.chrome.test.ts`). Outside
// `ports/contract/`: a `DialogWatch` is not a port (design revision 8).

import { type ContractCase, equal } from '../ports/contract/assert.js';
import type { BridgeEventPayload } from '../ports/values.js';
import type { DialogWatch } from './page-driver.js';

export interface DialogWatchHarness {
  watch: DialogWatch;
  /** What the watch's intake sent to its sink so far, in order. */
  sent: () => readonly BridgeEventPayload[];
  /** Make the page show `alert(message)`; resolves once the page shows it
   * (observed independently of the watch). */
  openAlert: (message: string) => Promise<void>;
  /** Answer the dialog showing; resolves once the page reported it closed
   * (observed independently of the watch). */
  accept: () => Promise<void>;
  dispose?: () => Promise<void> | void;
}

export function defineDialogWatchContract(
  make: () => Promise<DialogWatchHarness> | DialogWatchHarness,
): ContractCase[] {
  const withHarness =
    (body: (harness: DialogWatchHarness) => Promise<void> | void) => async (): Promise<void> => {
      const harness = await make();
      try {
        await body(harness);
      } finally {
        await harness.dispose?.();
      }
    };

  return [
    {
      name: 'with no dialog shown, the watch reads closed and nothing is sent',
      run: withHarness(({ watch, sent }) => {
        equal(watch.isOpen(), false, 'isOpen');
        equal(sent().length, 0, 'events sent');
      }),
    },
    {
      name: 'a dialog the page shows reads open and sends one dialog-opening with its type and message',
      run: withHarness(async ({ watch, sent, openAlert }) => {
        await openAlert('contract');
        equal(watch.isOpen(), true, 'isOpen');
        const events = sent();
        equal(events.length, 1, 'events sent');
        equal(events[0]?.eventKind, 'dialog-opening', 'event kind');
        equal(events[0]?.data.type, 'alert', 'dialog type');
        equal(events[0]?.data.message, 'contract', 'dialog message');
      }),
    },
    {
      name: 'once the page answered the dialog the watch reads closed and dialog-closed is sent with accept',
      run: withHarness(async ({ watch, sent, openAlert, accept }) => {
        await openAlert('contract');
        await accept();
        equal(watch.isOpen(), false, 'isOpen');
        const events = sent();
        equal(events.length, 2, 'events sent');
        equal(events[1]?.eventKind, 'dialog-closed', 'event kind');
        equal(events[1]?.data.accept, true, 'accept');
      }),
    },
  ];
}
