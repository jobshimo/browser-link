// The dialog intake (`dialogIntake`, `PendingDialog`) on the in-memory
// `CdpSession`: the intake subscribed to the session's events, as a
// transport wires it, writing the pending dialog and sending the two dialog
// events through a sink bound to the connection.
import { describe, expect, test } from 'vitest';
import { createManualClock, createMemoryCdpSession } from '../ports/contract/index.js';
import type { BridgeEventPayload } from '../ports/values.js';
import { dialogIntake, PendingDialog } from './dialog-intake.js';
import type { DialogWatch, PageDriverHandle } from './page-driver.js';
import { sessionDialogWatch, TabSession } from './tab-session.js';

function wired() {
  const cdp = createMemoryCdpSession({});
  const pending = new PendingDialog();
  const sent: BridgeEventPayload[] = [];
  const intake = dialogIntake(pending, { emit: (event) => sent.push(event) });
  const off = cdp.onEvent(intake);
  return { cdp, pending, sent, intake, off };
}

describe('dialogIntake', () => {
  test('an opening sets the pending dialog and sends dialog-opening with every field CDP gave', () => {
    const { cdp, pending, sent } = wired();
    cdp.emit('Page.javascriptDialogOpening', {
      type: 'prompt',
      message: 'name?',
      defaultPrompt: 'def',
      url: 'https://x.test/',
      hasBrowserHandler: true,
      frameId: 'F1',
    });
    expect(pending.current).toEqual({
      type: 'prompt',
      message: 'name?',
      default_prompt: 'def',
      url: 'https://x.test/',
    });
    expect(pending.isOpen()).toBe(true);
    expect(sent).toEqual([
      {
        eventKind: 'dialog-opening',
        data: { type: 'prompt', message: 'name?', default_prompt: 'def', url: 'https://x.test/' },
      },
    ]);
  });

  test('an opening without fields reads as an empty alert; non-string prompt and url are left out', () => {
    const { cdp, pending, sent } = wired();
    cdp.emit('Page.javascriptDialogOpening', { defaultPrompt: 3, url: null });
    expect(pending.current).toEqual({ type: 'alert', message: '' });
    expect(sent).toEqual([{ eventKind: 'dialog-opening', data: { type: 'alert', message: '' } }]);
  });

  test('a second opening replaces the first (at most one pending dialog)', () => {
    const { cdp, pending } = wired();
    cdp.emit('Page.javascriptDialogOpening', { type: 'alert', message: 'one' });
    cdp.emit('Page.javascriptDialogOpening', { type: 'confirm', message: 'two' });
    expect(pending.current).toEqual({ type: 'confirm', message: 'two' });
  });

  test('a close clears the pending dialog and sends dialog-closed with accept and user_input', () => {
    const { cdp, pending, sent } = wired();
    cdp.emit('Page.javascriptDialogOpening', { type: 'prompt', message: 'm' });
    cdp.emit('Page.javascriptDialogClosed', { result: true, userInput: 'typed' });
    expect(pending.current).toBeUndefined();
    expect(pending.isOpen()).toBe(false);
    expect(sent[1]).toEqual({
      eventKind: 'dialog-closed',
      data: { accept: true, user_input: 'typed' },
    });
  });

  test('a close without result reads as not accepted, and a non-string userInput is left out', () => {
    const { cdp, sent } = wired();
    cdp.emit('Page.javascriptDialogClosed', { result: 'yes', userInput: 7 });
    expect(sent).toEqual([{ eventKind: 'dialog-closed', data: { accept: false } }]);
  });

  test('answers true for the two dialog events and false, touching nothing, for any other', () => {
    const { intake, pending, sent } = wired();
    expect(intake('Runtime.consoleAPICalled', { type: 'log', args: [] })).toBe(false);
    expect(intake('Page.javascriptDialogOpeningX', { type: 'alert' })).toBe(false);
    expect(intake('Page.frameNavigated', {})).toBe(false);
    expect(pending.current).toBeUndefined();
    expect(sent).toEqual([]);
    expect(intake('Page.javascriptDialogOpening', { type: 'alert', message: 'a' })).toBe(true);
    expect(intake('Page.javascriptDialogClosed', { result: false })).toBe(true);
  });

  test('after unsubscribing, events no longer reach the pending dialog or the sink', () => {
    const { cdp, pending, sent, off } = wired();
    off();
    cdp.emit('Page.javascriptDialogOpening', { type: 'alert', message: 'late' });
    expect(pending.current).toBeUndefined();
    expect(sent).toEqual([]);
  });
});

describe('PendingDialog as the DialogWatch', () => {
  test('the holder is a DialogWatch that reads the dialog the intake opened, live', () => {
    const { cdp, pending } = wired();
    const watch: DialogWatch = pending;
    expect(watch.isOpen()).toBe(false);
    cdp.emit('Page.javascriptDialogOpening', { type: 'alert', message: 'x' });
    expect(watch.isOpen()).toBe(true);
    cdp.emit('Page.javascriptDialogClosed', { result: true });
    expect(watch.isOpen()).toBe(false);
  });

  test("TabSession's pending dialog is its PendingDialog: the intake writes what the session and its watch read", () => {
    const session = new TabSession({
      clock: createManualClock(0),
      driver: {} as PageDriverHandle,
    });
    const cdp = createMemoryCdpSession({});
    cdp.onEvent(dialogIntake(session.dialog, { emit: () => {} }));
    const watch = sessionDialogWatch(() => session);
    cdp.emit('Page.javascriptDialogOpening', { type: 'confirm', message: 'sure?' });
    expect(session.pendingDialog).toEqual({ type: 'confirm', message: 'sure?' });
    expect(watch.isOpen()).toBe(true);
    cdp.emit('Page.javascriptDialogClosed', { result: false });
    expect(session.pendingDialog).toBeUndefined();
    expect(watch.isOpen()).toBe(false);
  });
});
