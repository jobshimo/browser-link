import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAllowedBrowser } from '../auth/allowlist.js';
import { PINNED_EXTENSION_ORIGIN } from '../auth/extension-id.js';
import type { PeerLookupResult } from '../auth/process-identity.js';
import { isLoopbackHost } from '../lifecycle/version-endpoint.js';

/**
 * The WebSocket bridge's handshake gate, shared by the upgrade itself
 * (`ws-bridge.ts` `verifyClient`) and by `GET /handshake-check`, which tells
 * the extension why its upgrade was refused (a browser's WebSocket API hides
 * the HTTP status and reason of a failed upgrade).
 */

export type LookupPeerProcess = (address: string, port: number) => Promise<PeerLookupResult>;

/** Every reason the gate refuses with, as a stable code. The extension keeps
 * a copy (`packages/extension/src/handshake-diagnosis.ts`), guarded by
 * `config.drift.test.ts`. */
export const HANDSHAKE_REFUSAL_REASONS = [
  'origin-not-allowed',
  'peer-unidentified',
  'peer-unknown',
  'peer-not-browser',
  'process-lookup-failed',
] as const;

export type HandshakeRefusalReason = (typeof HANDSHAKE_REFUSAL_REASONS)[number];

/** The path the extension asks; its copy lives next to the reason codes. */
export const HANDSHAKE_CHECK_PATH = '/handshake-check';

const REFUSALS: Readonly<Record<HandshakeRefusalReason, { status: 403 | 500; message: string }>> = {
  'origin-not-allowed': { status: 403, message: 'Origin not allowed' },
  'peer-unidentified': { status: 403, message: 'Cannot identify peer' },
  'peer-unknown': { status: 403, message: 'Peer process unknown' },
  'peer-not-browser': { status: 403, message: 'Peer is not a Chromium-based browser' },
  'process-lookup-failed': { status: 500, message: 'Process lookup failed' },
};

/** The HTTP status and message an upgrade refused for `reason` gets. */
export function handshakeRefusal(reason: HandshakeRefusalReason): {
  status: 403 | 500;
  message: string;
} {
  return REFUSALS[reason];
}

/**
 * Whether a WebSocket handshake's `Origin` may open the bridge. A web page
 * running inside Chrome passes the peer-process check (the owning process is
 * Chromium) but always announces its own http(s) origin; only the extension's
 * own context (`chrome-extension://<id>`) is allowed, and a missing `Origin`
 * (non-browser clients) is left to the peer-process check. Pure. Since 0.42.0.
 */
export function isAllowedHandshakeOrigin(origin: string | undefined): boolean {
  if (origin === undefined || origin === '') return true;
  return origin.startsWith('chrome-extension://');
}

/**
 * Loopback-only addresses can show up as ::ffff:127.0.0.1 (IPv4-mapped IPv6)
 * or ::1 depending on how the kernel exposes the dual stack. Normalise to the
 * IPv4 form lsof / netstat understand.
 */
function normaliseLoopback(addr: string): string {
  if (addr === '::1' || addr === '::ffff:127.0.0.1') return '127.0.0.1';
  if (addr.startsWith('::ffff:')) return addr.slice('::ffff:'.length);
  return addr;
}

export type HandshakeVerdict =
  { accepted: true } | { accepted: false; reason: HandshakeRefusalReason; logLine: string };

/** What the gate says about a request: its `Origin`, then the process that
 * owns the other end of its TCP connection. Never rejects. */
export async function evaluateHandshake(
  req: IncomingMessage,
  lookupPeerProcess: LookupPeerProcess,
): Promise<HandshakeVerdict> {
  const origin = req.headers.origin;
  if (!isAllowedHandshakeOrigin(origin)) {
    return {
      accepted: false,
      reason: 'origin-not-allowed',
      logLine: `Rejected WS handshake from origin ${String(origin)}: only the extension may connect.`,
    };
  }
  const remoteAddress = normaliseLoopback(req.socket.remoteAddress ?? '');
  const remotePort = req.socket.remotePort;
  if (!remoteAddress || remotePort == null) {
    return {
      accepted: false,
      reason: 'peer-unidentified',
      logLine: 'Rejected WS handshake: peer address/port not exposed by socket.',
    };
  }
  let lookup: PeerLookupResult;
  try {
    lookup = await lookupPeerProcess(remoteAddress, remotePort);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      accepted: false,
      reason: 'process-lookup-failed',
      logLine: `Rejected WS handshake: process lookup failed (${msg}).`,
    };
  }
  if (!lookup.ok) {
    return {
      accepted: false,
      reason: 'peer-unknown',
      logLine: `Rejected WS handshake from ${remoteAddress}:${remotePort}: could not identify owning process (cause: ${lookup.cause}).`,
    };
  }
  if (!isAllowedBrowser(lookup.peer.binaryName)) {
    return {
      accepted: false,
      reason: 'peer-not-browser',
      logLine: `Rejected WS handshake from PID ${lookup.peer.pid} (${lookup.peer.binaryName}): not a Chromium-based browser.`,
    };
  }
  return { accepted: true };
}

/** The line logged for an accepted handshake whose `Origin` is not exactly
 * the pinned extension's, or undefined for the pinned one. 0.52.0 accepts it;
 * 1.0.0 refuses it. */
export function lockoutNotice(origin: string | undefined): string | undefined {
  if (origin === PINNED_EXTENSION_ORIGIN) return undefined;
  const from =
    origin === undefined || origin === ''
      ? 'without an Origin header'
      : `from origin ${JSON.stringify(origin)}`;
  return `Accepted WS handshake ${from}; browser-link 1.0.0 will refuse it (only ${PINNED_EXTENSION_ORIGIN} will be allowed).`;
}

/**
 * `GET /handshake-check`: the gate's verdict on this very request, as
 * `{ accepted: true }` or `{ accepted: false, reason }`. Loopback `Host`
 * only, like `/version`. Readable cross-origin only by an extension context
 * (a web page's Origin gets no CORS grant). Opens nothing and logs nothing.
 */
export async function answerHandshakeCheck(
  req: IncomingMessage,
  res: ServerResponse,
  lookupPeerProcess: LookupPeerProcess,
): Promise<void> {
  if (!isLoopbackHost(req.headers.host)) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('Forbidden');
    return;
  }
  const verdict = await evaluateHandshake(req, lookupPeerProcess);
  const origin = req.headers.origin;
  const cors =
    origin !== undefined && origin.startsWith('chrome-extension://')
      ? { 'access-control-allow-origin': origin, vary: 'Origin' }
      : {};
  res.writeHead(200, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    ...cors,
  });
  res.end(
    JSON.stringify(
      verdict.accepted ? { accepted: true } : { accepted: false, reason: verdict.reason },
    ),
  );
}

/** Whether a plain HTTP request is the handshake check. */
export function isHandshakeCheckRequest(req: IncomingMessage): boolean {
  return req.method === 'GET' && (req.url ?? '').split('?')[0] === HANDSHAKE_CHECK_PATH;
}
