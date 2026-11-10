import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAllowedBrowser, isAllowedExecutablePath } from '../auth/allowlist.js';
import { PINNED_EXTENSION_ORIGIN } from '../auth/extension-id.js';
import type { PeerLookupRequest, PeerLookupResult } from '../auth/process-identity.js';
import { loadConfig } from '../config.js';
import { isLoopbackHost } from '../lifecycle/version-endpoint.js';

/**
 * The WebSocket bridge's handshake gate, shared by the upgrade itself
 * (`ws-bridge.ts` `verifyClient`) and by `GET /handshake-check`, which tells
 * the extension why its upgrade was refused (a browser's WebSocket API hides
 * the HTTP status and reason of a failed upgrade).
 */

/** Who owns the other end of a TCP connection; refused unless it runs as
 * this server's OS user. */
export type LookupPeerProcess = (
  address: string,
  port: number,
  request: PeerLookupRequest,
) => Promise<PeerLookupResult>;

/** Every reason the gate refuses with, as a stable code. The extension keeps
 * a copy (`packages/extension/src/handshake-diagnosis.ts`), guarded by
 * `config.drift.test.ts`. */
export const HANDSHAKE_REFUSAL_REASONS = [
  'origin-not-allowed',
  'peer-unidentified',
  'peer-unknown',
  'peer-other-user',
  'peer-not-browser',
  'peer-path-not-allowed',
  'process-lookup-failed',
] as const;

export type HandshakeRefusalReason = (typeof HANDSHAKE_REFUSAL_REASONS)[number];

/** The path the extension asks; its copy lives next to the reason codes. */
export const HANDSHAKE_CHECK_PATH = '/handshake-check';

const REFUSALS: Readonly<Record<HandshakeRefusalReason, { status: 403 | 500; message: string }>> = {
  'origin-not-allowed': { status: 403, message: 'Origin not allowed' },
  'peer-unidentified': { status: 403, message: 'Cannot identify peer' },
  'peer-unknown': { status: 403, message: 'Peer process unknown' },
  'peer-other-user': { status: 403, message: 'Peer runs as another OS user' },
  'peer-not-browser': { status: 403, message: 'Peer is not a Chromium-based browser' },
  'peer-path-not-allowed': { status: 403, message: 'Peer executable path not allowed' },
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

/** Control characters (C0, DEL, C1) and the Unicode line separators. */
const LINE_SEPARATORS = String.fromCharCode(0x2028, 0x2029);
const UNPRINTABLE = new RegExp('[\\x00-\\x1f\\x7f-\\x9f' + LINE_SEPARATORS + ']', 'g');

/** A client-supplied Origin made safe for one log line: every control or
 * line-separator character becomes its `\uXXXX` escape. */
export function printableOrigin(origin: string): string {
  return origin.replace(UNPRINTABLE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
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
 * owns the other end of its TCP connection (same OS user, browser name and,
 * in the opt-in strict mode, a listed executable path). Never rejects. */
export async function evaluateHandshake(
  req: IncomingMessage,
  lookupPeerProcess: LookupPeerProcess,
): Promise<HandshakeVerdict> {
  const origin = req.headers.origin;
  if (!isAllowedHandshakeOrigin(origin)) {
    return {
      accepted: false,
      reason: 'origin-not-allowed',
      logLine: `Rejected WS handshake from origin ${printableOrigin(String(origin))}: only the extension may connect.`,
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
  // Read on every handshake, like every other config key the primary
  // honours without a restart. `undefined` means strict mode is off.
  const strictPaths = loadConfig().peerExecutablePaths;
  // The bridge's own end of this connection: only OS rows whose remote end
  // is the bridge count, so stale rows on the peer's port do not.
  const localAddress = normaliseLoopback(req.socket.localAddress ?? '');
  const localPort = req.socket.localPort;
  let lookup: PeerLookupResult;
  try {
    lookup = await lookupPeerProcess(remoteAddress, remotePort, {
      withExecutablePath: strictPaths !== undefined,
      ...(localAddress && localPort != null
        ? { serverEndpoint: { host: localAddress, port: localPort } }
        : {}),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      accepted: false,
      reason: 'process-lookup-failed',
      logLine: `Rejected WS handshake: process lookup failed (${msg}).`,
    };
  }
  if (!lookup.ok) {
    if (lookup.cause === 'owner-mismatch') {
      return {
        accepted: false,
        reason: 'peer-other-user',
        logLine: `Rejected WS handshake from ${remoteAddress}:${remotePort}: the owning process runs as another OS user (cause: owner-mismatch).`,
      };
    }
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
  if (
    strictPaths !== undefined &&
    !isAllowedExecutablePath(lookup.peer.executablePath, strictPaths)
  ) {
    return {
      accepted: false,
      reason: 'peer-path-not-allowed',
      logLine: `Rejected WS handshake from PID ${lookup.peer.pid} (${lookup.peer.binaryName}): executable path ${JSON.stringify(lookup.peer.executablePath ?? 'unread')} is not in peerExecutablePaths.`,
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
    origin === undefined
      ? 'without an Origin header'
      : origin === ''
        ? 'with an empty Origin header'
        : `from origin ${printableOrigin(origin)}`;
  return `Accepted WS handshake ${from}; browser-link 1.0.0 will refuse it (only ${PINNED_EXTENSION_ORIGIN} will be allowed).`;
}

/** Diagnostic lookups that may run at once, across all callers. Each one is
 * an OS process lookup (netstat plus PowerShell on Windows, about 0.5 s). */
export const MAX_CONCURRENT_HANDSHAKE_CHECKS = 2;

function forbidden(res: ServerResponse): void {
  res.writeHead(403, { 'content-type': 'text/plain' });
  res.end('Forbidden');
}

/**
 * The `GET /handshake-check` handler: the gate's verdict on the asking
 * request, as `{ accepted: true }` or `{ accepted: false, reason }`, for an
 * extension context only. A foreign `Host` or any `Origin` that is not
 * `chrome-extension://…` (missing, empty, `null`, a web page's) gets a plain
 * 403 with no process lookup and no CORS grant, so a web page cannot use the
 * endpoint to make the server run lookups.
 *
 * Bounded work: one lookup in flight per remote endpoint (a second request on
 * the same connection shares it) and at most `maxConcurrent` in all; over the
 * cap the answer is `503 { busy: true }`, which the extension reads as "no
 * diagnosis". Verdicts are never cached past their lookup. Logs nothing.
 */
export function createHandshakeCheckHandler(
  lookupPeerProcess: LookupPeerProcess,
  maxConcurrent: number = MAX_CONCURRENT_HANDSHAKE_CHECKS,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const inFlight = new Map<string, Promise<HandshakeVerdict>>();
  return async (req, res) => {
    const origin = req.headers.origin;
    if (!isLoopbackHost(req.headers.host) || !origin?.startsWith('chrome-extension://')) {
      forbidden(res);
      return;
    }
    const headers = {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'access-control-allow-origin': origin,
      vary: 'Origin',
    };
    const endpoint = `${req.socket.remoteAddress ?? ''}:${String(req.socket.remotePort)}`;
    let verdict = inFlight.get(endpoint);
    if (verdict === undefined) {
      if (inFlight.size >= maxConcurrent) {
        res.writeHead(503, headers);
        res.end(JSON.stringify({ busy: true }));
        return;
      }
      verdict = evaluateHandshake(req, lookupPeerProcess).finally(() => {
        inFlight.delete(endpoint);
      });
      inFlight.set(endpoint, verdict);
    }
    const settled = await verdict;
    res.writeHead(200, headers);
    res.end(
      JSON.stringify(
        settled.accepted ? { accepted: true } : { accepted: false, reason: settled.reason },
      ),
    );
  };
}

/** Whether a plain HTTP request is the handshake check. */
export function isHandshakeCheckRequest(req: IncomingMessage): boolean {
  return req.method === 'GET' && (req.url ?? '').split('?')[0] === HANDSHAKE_CHECK_PATH;
}
