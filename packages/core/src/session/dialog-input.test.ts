// The page driver's dialog input (slice 16): the DialogInput contract on an
// in-memory session, the command it sends, and RED probes showing the
// contract catches a broken subject.
import { describe, expect, it } from 'vitest';
import {
  createManualClock,
  createMemoryCdpSession,
  createMemoryPageInfo,
  defineDialogInputContract,
  type ContractCase,
  type DialogInputHarness,
} from '../ports/contract/index.js';
import type { DialogInput } from '../ports/page-driver.js';
import { createPageDriver } from './page-driver.js';

const NO_DIALOG = 'No dialog is showing';

/** A page that shows a dialog on demand and answers
 * `Page.handleJavaScriptDialog` like Chrome. */
function dialogHarness(sent: unknown[] = []): DialogInputHarness {
  let showing = false;
  const clock = createManualClock();
  const session = createMemoryCdpSession({
    'Page.handleJavaScriptDialog': (params) => {
      sent.push(params);
      if (!showing) throw new Error(NO_DIALOG);
      showing = false;
      return {};
    },
  });
  const driver = createPageDriver({
    session,
    page: createMemoryPageInfo({ url: 'https://t.test/', title: 'T' }, clock),
    clock,
  });
  return {
    dialog: driver.dialog,
    openDialog: () => {
      showing = true;
      return Promise.resolve();
    },
    noDialogMessage: NO_DIALOG,
  };
}

function run(cases: ContractCase[]): void {
  for (const contractCase of cases) it(contractCase.name, () => contractCase.run());
}

function caseNamed(cases: ContractCase[], name: string): ContractCase {
  const found = cases.find((c) => c.name === name);
  if (!found) throw new Error(`no contract case named ${name}`);
  return found;
}

describe('DialogInput contract: page driver on an in-memory session', () => {
  run(defineDialogInputContract(() => dialogHarness()));

  it('sends accept alone, or accept and promptText when given', async () => {
    const sent: unknown[] = [];
    const harness = dialogHarness(sent);
    await harness.openDialog();
    await harness.dialog.respond(true);
    await harness.openDialog();
    await harness.dialog.respond(false, 'answer');
    expect(sent).toEqual([{ accept: true }, { accept: false, promptText: 'answer' }]);
  });
});

describe('the DialogInput contract catches a broken port (RED probes)', () => {
  it('a dialog input that swallows the refusal', async () => {
    const cases = defineDialogInputContract(() => {
      const harness = dialogHarness();
      const dialog: DialogInput = { respond: () => Promise.resolve() };
      return { ...harness, dialog };
    });
    await expect(
      caseNamed(
        cases,
        'with no dialog showing, respond rejects with the CDP error message unchanged',
      ).run(),
    ).rejects.toThrow(/error message/);
  });

  it('a dialog input that rewrites the error text', async () => {
    const cases = defineDialogInputContract(() => {
      const harness = dialogHarness();
      const dialog: DialogInput = {
        respond: (accept, promptText) =>
          harness.dialog.respond(accept, promptText).catch(() => {
            throw new Error('no dialog');
          }),
      };
      return { ...harness, dialog };
    });
    await expect(
      caseNamed(cases, 'a dialog answered once is gone: a second response rejects').run(),
    ).rejects.toThrow(/error message/);
  });
});
