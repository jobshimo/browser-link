// What every `DialogInput` guarantees (5.3, item 5): one
// `Page.handleJavaScriptDialog` per call, input only (slice 16). It runs
// against the page driver's dialog input over a `CdpSession`, on the
// in-memory fake and on a real Chrome target.

import type { DialogInput } from '../page-driver.js';
import { type ContractCase, equal } from './assert.js';

export interface DialogInputHarness {
  dialog: DialogInput;
  /** Make the page show a dialog; resolves once it shows. */
  openDialog: () => Promise<void>;
  /** The CDP error message of a response while no dialog is showing. */
  noDialogMessage: string;
  dispose?: () => Promise<void> | void;
}

export function defineDialogInputContract(
  make: () => Promise<DialogInputHarness> | DialogInputHarness,
): ContractCase[] {
  const withHarness =
    (body: (harness: DialogInputHarness) => Promise<void>) => async (): Promise<void> => {
      const harness = await make();
      try {
        await body(harness);
      } finally {
        await harness.dispose?.();
      }
    };

  const messageOf = async (work: Promise<void>): Promise<string | null> => {
    try {
      await work;
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };

  return [
    {
      name: 'respond answers a showing dialog and resolves once the page answered it',
      run: withHarness(async ({ dialog, openDialog }) => {
        await openDialog();
        await dialog.respond(true);
      }),
    },
    {
      name: 'respond with prompt text answers a showing dialog',
      run: withHarness(async ({ dialog, openDialog }) => {
        await openDialog();
        await dialog.respond(false, 'answer');
      }),
    },
    {
      name: 'with no dialog showing, respond rejects with the CDP error message unchanged',
      run: withHarness(async ({ dialog, noDialogMessage }) => {
        equal(await messageOf(dialog.respond(true)), noDialogMessage, 'error message');
      }),
    },
    {
      name: 'a dialog answered once is gone: a second response rejects',
      run: withHarness(async ({ dialog, openDialog, noDialogMessage }) => {
        await openDialog();
        await dialog.respond(true);
        equal(await messageOf(dialog.respond(true)), noDialogMessage, 'error message');
      }),
    },
  ];
}
