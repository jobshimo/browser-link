// GENERATED from packages/core/src/session/dialog-intake.ts. Do not edit.
// The dialog half of a tab's CDP event intake (cdp-direct parity design,
// step 3.4 and slice P3): `Page.javascriptDialogOpening` and
// `Page.javascriptDialogClosed` into the tab's pending dialog, and the
// `dialog-opening` / `dialog-closed` events toward the server. One authored
// body for both transports. The extension calls it from its debugger intake
// (`app/tab-connection.ts`); cdp-direct does not use it yet (P3's behaviour
// PR subscribes it to the connection's `CdpSession.onEvent`).
//
// Not a port (design revisions 8 and 13): `PendingDialog` is observed state
// read through `DialogWatch`, and `DialogEventSink` is a narrow sink bound to
// one connection that each transport builds over its own channel. `EventsOut`
// stays the flow events' port, keyed by a numeric Chrome tab id.

import type { BridgeEventPayload } from '../ports/values.js';
import type { DialogWatch } from './page-driver.js';

/** A native dialog blocking the tab, set on `Page.javascriptDialogOpening`
 * and cleared on `Page.javascriptDialogClosed`. */
export interface PendingDialogInfo {
  type: string;
  message: string;
  default_prompt?: string;
  url?: string;
}

/**
 * The pending JavaScript dialog of one page, without the rest of a
 * `TabSession` (no driver, no idle rules), so a transport that holds no
 * `TabSession` can keep it per target. It is its own `DialogWatch`.
 *
 * Invariant: at most one pending dialog; opening replaces it, closing
 * clears it.
 */
export class PendingDialog implements DialogWatch {
  private dialog: PendingDialogInfo | undefined;

  /** The dialog open now, if any. */
  get current(): PendingDialogInfo | undefined {
    return this.dialog;
  }

  isOpen(): boolean {
    return this.dialog !== undefined;
  }

  opened(info: PendingDialogInfo): void {
    this.dialog = info;
  }

  closed(): void {
    this.dialog = undefined;
  }
}

/** Where the intake sends its dialog events: bound to one connection by the
 * transport that builds it, so it takes no tab key. Delivery is best effort,
 * as the connection's own channel allows (the extension drops an event while
 * its tab is not registered). */
export interface DialogEventSink {
  emit(event: BridgeEventPayload): void;
}

interface CdpPageJavascriptDialogOpening {
  type?: string;
  message?: string;
  defaultPrompt?: string;
  url?: string;
}

interface CdpPageJavascriptDialogClosed {
  result?: boolean;
  userInput?: string;
}

/**
 * The dialog intake of one connection: a CDP event listener that maps the
 * two dialog events into `pending` and sends `dialog-opening` /
 * `dialog-closed` to `sink`. Answers true when it handled the event, false
 * for any other method (left untouched). It never answers the dialog: the
 * page's JS thread stays frozen until `Page.handleJavaScriptDialog`
 * (`DialogInput.respond`, `browser.dialog_respond`).
 */
export function dialogIntake(
  pending: PendingDialog,
  sink: DialogEventSink,
): (method: string, params: unknown) => boolean {
  return (method, params) => {
    if (method === 'Page.javascriptDialogOpening') {
      const p = params as CdpPageJavascriptDialogOpening;
      const info: PendingDialogInfo = {
        type: p.type ?? 'alert',
        message: p.message ?? '',
      };
      if (typeof p.defaultPrompt === 'string') info.default_prompt = p.defaultPrompt;
      if (typeof p.url === 'string') info.url = p.url;
      pending.opened(info);
      const data: Record<string, unknown> = {
        type: info.type,
        message: info.message,
      };
      if (info.default_prompt !== undefined) data.default_prompt = info.default_prompt;
      if (info.url !== undefined) data.url = info.url;
      sink.emit({ eventKind: 'dialog-opening', data });
      return true;
    }
    if (method === 'Page.javascriptDialogClosed') {
      const p = params as CdpPageJavascriptDialogClosed;
      pending.closed();
      const data: Record<string, unknown> = { accept: p.result === true };
      if (typeof p.userInput === 'string') data.user_input = p.userInput;
      sink.emit({ eventKind: 'dialog-closed', data });
      return true;
    }
    return false;
  };
}
