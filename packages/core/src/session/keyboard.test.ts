// The page driver's `Keyboard.insertText` (slice 11): the input-only
// Keyboard contract on an in-memory session, and its RED probes.
import { describe, expect, it } from 'vitest';
import {
  createManualClock,
  createMemoryCdpSession,
  createMemoryPageInfo,
  defineKeyboardContract,
  type ContractCase,
  type KeyboardHarness,
} from '../ports/contract/index.js';
import type { Keyboard } from '../ports/page-driver.js';
import { createPageDriver } from './page-driver.js';

/** What Chrome answers for an `Input.insertText` whose text is not a string. */
const NOT_A_STRING = 'Invalid parameters';

/** A page whose focused field takes what `Input.insertText` sends. */
function harness(): KeyboardHarness & { sent: unknown[] } {
  let value = '';
  const sent: unknown[] = [];
  const clock = createManualClock();
  const session = createMemoryCdpSession({
    'Input.insertText': (params) => {
      sent.push(params);
      if (typeof params.text !== 'string') throw new Error(NOT_A_STRING);
      value += params.text;
      return {};
    },
  });
  const page = createMemoryPageInfo({ url: 'https://t.test/', title: 'T' }, clock);
  const driver = createPageDriver({ session, page, clock });
  return {
    keyboard: driver.keyboard,
    focusedValue: () => Promise.resolve(value),
    failing: { text: 5 as unknown as string, message: NOT_A_STRING },
    sent,
  };
}

function run(cases: ContractCase[]): void {
  for (const contractCase of cases) it(contractCase.name, () => contractCase.run());
}

describe('Keyboard contract: page driver on an in-memory session', () => {
  run(defineKeyboardContract(harness));

  it('insertText sends one Input.insertText with the text as given', async () => {
    const h = harness();
    await h.keyboard.insertText('a\nb');
    expect(h.sent).toEqual([{ text: 'a\nb' }]);
  });
});

describe('the Keyboard contract catches a broken keyboard (RED probes)', () => {
  const caseNamed = (cases: ContractCase[], name: string): ContractCase => {
    const found = cases.find((c) => c.name === name);
    if (!found) throw new Error(`no contract case named ${name}`);
    return found;
  };

  it('a keyboard that resolves before the text was sent', async () => {
    const cases = defineKeyboardContract(() => {
      const h = harness();
      const keyboard: Keyboard = {
        ...h.keyboard,
        insertText: (text) => {
          setTimeout(() => void h.keyboard.insertText(text), 5);
          return Promise.resolve();
        },
      };
      return { ...h, keyboard };
    });
    await expect(
      caseNamed(cases, 'insertText resolves once the focused field holds the text').run(),
    ).rejects.toThrow(/focused value/);
  });

  it('a keyboard that swallows a failed dispatch', async () => {
    const cases = defineKeyboardContract(() => {
      const h = harness();
      const keyboard: Keyboard = {
        ...h.keyboard,
        insertText: (text) => h.keyboard.insertText(text).catch(() => undefined),
      };
      return { ...h, keyboard };
    });
    await expect(
      caseNamed(cases, 'a failed insertText rejects with the CDP error message unchanged').run(),
    ).rejects.toThrow(/error message/);
  });
});
