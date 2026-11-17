// What every `Keyboard.insertText` guarantees (5.3, item 5): an input port,
// one `Input.insertText` per call into whatever has focus (slice 11). It runs
// against the page driver's keyboard over a `CdpSession`, on the in-memory
// fake and on a real Chrome target. Whether the focused field is sensitive is
// the action's business (it reads it through the evaluator), not the port's.

import type { Keyboard } from '../page-driver.js';
import { type ContractCase, equal } from './assert.js';

export interface KeyboardHarness {
  keyboard: Keyboard;
  /** The value of the field that has focus now ('' when it is empty). */
  focusedValue: () => Promise<string>;
  /** A text the page refuses, and the CDP error message it fails with. */
  failing: { text: string; message: string };
  dispose?: () => Promise<void> | void;
}

export function defineKeyboardContract(
  make: () => Promise<KeyboardHarness> | KeyboardHarness,
): ContractCase[] {
  const withHarness =
    (body: (harness: KeyboardHarness) => Promise<void>) => async (): Promise<void> => {
      const harness = await make();
      try {
        await body(harness);
      } finally {
        await harness.dispose?.();
      }
    };

  return [
    {
      name: 'insertText resolves once the focused field holds the text',
      run: withHarness(async ({ keyboard, focusedValue }) => {
        await keyboard.insertText('héllo wörld');
        equal(await focusedValue(), 'héllo wörld', 'focused value');
      }),
    },
    {
      name: 'texts inserted in turn arrive in that order',
      run: withHarness(async ({ keyboard, focusedValue }) => {
        await keyboard.insertText('ab');
        await keyboard.insertText('cd');
        equal(await focusedValue(), 'abcd', 'focused value');
      }),
    },
    {
      name: 'a failed insertText rejects with the CDP error message unchanged',
      run: withHarness(async ({ keyboard, failing }) => {
        let message: string | null = null;
        try {
          await keyboard.insertText(failing.text);
        } catch (err) {
          message = err instanceof Error ? err.message : String(err);
        }
        equal(message, failing.message, 'error message');
      }),
    },
  ];
}
