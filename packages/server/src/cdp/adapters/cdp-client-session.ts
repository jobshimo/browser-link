// The cdp-direct `CdpSession` (design 3.1): one `CdpClient` connection.
// Commands keep the client's own per-command timeout (15s default).
import type { CdpSession } from '../../generated/core/ports/cdp-session.js';
import type { CdpClient } from '../client.js';

export function createCdpClientSession(client: CdpClient): CdpSession {
  return {
    send: <T>(method: string, params?: Record<string, unknown>): Promise<T> =>
      client.send<T>(method, params),
    onEvent: (listener) => client.onAny(listener),
  };
}
