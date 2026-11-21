// The cdp-direct `CaptureWatch` (parity P5): one connection's console and
// network buffers, fed by core's capture intake subscribed to the
// connection's events. The dial builds it before `Log.enable` and the
// observer's `Runtime.enable`, whose answers Chrome follows with a replay of
// the page's earlier console and log entries (lab X2), so the replay lands
// in the buffers. The buffers live and die with the connection: a redial
// builds fresh ones, which that dial's own replay refills once, so a redial
// never holds an entry twice. Kept raw: headers and post data as Chrome
// reports them.
import { CaptureBuffers, captureIntake } from '../../generated/core/session/capture-intake.js';
import type { Clock } from '../../generated/core/ports/clock.js';
import type { CdpClient } from '../client.js';
import { createCdpClientSession } from './cdp-client-session.js';

export function createCdpCaptureWatch(client: CdpClient, clock: Clock): CaptureBuffers {
  const buffers = new CaptureBuffers({ clock });
  const intake = captureIntake(buffers, clock);
  createCdpClientSession(client).onEvent((method, params) => {
    intake(method, params);
  });
  return buffers;
}
