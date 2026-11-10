/**
 * Why a WebSocket connect to the bridge failed. A browser's WebSocket API
 * hides the HTTP status and reason of a refused upgrade, so after a failed
 * connect the worker asks the bridge's `GET /handshake-check`, which answers
 * the same gate's verdict on the asking request: `{ accepted: true }` or
 * `{ accepted: false, reason }`.
 *
 * Anything else (no server, an older server without the endpoint, a broken
 * or late answer, an accepting verdict) leaves today's generic connect
 * failure. Pure apart from the one request.
 */
import type { WorkerMessage } from './worker-messages.js';

/** Copy of the server's `HANDSHAKE_CHECK_PATH` and
 * `HANDSHAKE_REFUSAL_REASONS` (`packages/server/src/bridge/handshake.ts`):
 * the extension cannot import the server. `config.drift.test.ts` keeps them
 * equal. */
export const HANDSHAKE_CHECK_PATH = '/handshake-check';

export const HANDSHAKE_REFUSAL_REASONS = [
  'origin-not-allowed',
  'peer-unidentified',
  'peer-unknown',
  'peer-owner-unreadable',
  'peer-other-user',
  'peer-not-browser',
  'peer-path-not-allowed',
  'process-lookup-failed',
] as const;

/** A known reason, or `other` for one a newer server sends. */
export type HandshakeRefusalReason = (typeof HANDSHAKE_REFUSAL_REASONS)[number] | 'other';

/** Above the server's 5 s peer-lookup timeout, so a slow lookup still answers. */
const CHECK_TIMEOUT_MS = 8_000;

const CONNECT_FAILED: WorkerMessage = { code: 'ws-connect-failed' };

function knownReason(value: unknown): HandshakeRefusalReason {
  return HANDSHAKE_REFUSAL_REASONS.find((reason) => reason === value) ?? 'other';
}

export async function diagnoseConnectFailure(
  checkUrl: string,
  timeoutMs: number = CHECK_TIMEOUT_MS,
): Promise<WorkerMessage> {
  try {
    const res = await fetch(checkUrl, {
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return CONNECT_FAILED;
    const body: unknown = await res.json();
    if (typeof body !== 'object' || body === null) return CONNECT_FAILED;
    const verdict = body as { accepted?: unknown; reason?: unknown };
    if (verdict.accepted !== false) return CONNECT_FAILED;
    return { code: 'ws-handshake-refused', values: { reason: knownReason(verdict.reason) } };
  } catch {
    return CONNECT_FAILED;
  }
}
