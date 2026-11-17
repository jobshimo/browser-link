// The cdp-direct `CdpSession` (design 3.1): one `CdpClient` connection.
// Commands keep the client's own per-command timeout (15s default), or
// `commandTimeoutMs` when given: the transport builds such a session for
// `browser.evaluate`, whose budget is its one command's timeout.
import type { CdpSession } from '../../generated/core/ports/cdp-session.js';
import type { CdpClient } from '../client.js';

export function createCdpClientSession(client: CdpClient, commandTimeoutMs?: number): CdpSession {
  return {
    send: <T>(method: string, params?: Record<string, unknown>): Promise<T> =>
      client.send<T>(method, params, commandTimeoutMs),
    onEvent: (listener) => client.onAny(listener),
  };
}
