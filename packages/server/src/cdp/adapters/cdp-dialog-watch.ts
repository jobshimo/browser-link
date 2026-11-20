// The cdp-direct `DialogWatch` (parity P3): one connection's pending dialog,
// fed by core's dialog intake subscribed to the connection's events, and its
// dialog events sent to `sink` (bound to the connection's `cdp:` tab). The
// dial builds it before `Page.enable`; the real-Chrome contract runs on it.
import {
  dialogIntake,
  PendingDialog,
  type DialogEventSink,
} from '../../generated/core/session/dialog-intake.js';
import type { CdpClient } from '../client.js';
import { createCdpClientSession } from './cdp-client-session.js';

export function createCdpDialogWatch(client: CdpClient, sink: DialogEventSink): PendingDialog {
  const pending = new PendingDialog();
  createCdpClientSession(client).onEvent(dialogIntake(pending, sink));
  return pending;
}
