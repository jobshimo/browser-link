import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAllowedBrowser, isAllowedExecutablePath } from '../auth/allowlist.js';
import { allowedExtensionIds } from '../auth/extension-id.js';
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
  'peer-owner-unreadable',
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
  'peer-owner-unreadable': { status: 403, message: 'Cannot read peer owner' },
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
 * Whether a WebSocket handshake's `Origin` may open the bridge: it must equal
 * `chrome-extension://<id>` exactly, for the pinned id or a well-formed id in
 * `configuredIds` (`allowedExtensionIds` in config.json). A web page inside
 * Chrome passes the peer-process check but announces its own origin; another
 * extension announces its own id; a missing `Origin` is refused too. Pure.
 * Since 1.0.0 (0.42.0 accepted any `chrome-extension://` and no `Origin`).
 */
export function isAllowedHandshakeOrigin(
  origin: string | undefined,
  configuredIds: readonly unknown[],
): boolean {
  if (origin === undefined) return false;
  return allowedExtensionIds(configuredIds).some((id) => origin === `chrome-extension://${id}`);
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

export type HandshakeRefusal = {
  accepted: false;
  reason: HandshakeRefusalReason;
  logLine: string;
};

export type HandshakeVerdict = { accepted: true } | HandshakeRefusal;

/** The gate's verdict on the `Origin` alone, decided before any process
 * lookup: a refusal naming the origin and the ids allowed to connect, or
 * undefined when the origin is allowed. */
function refuseOrigin(
  origin: string | undefined,
  configuredIds: readonly unknown[],
): HandshakeRefusal | undefined {
  if (isAllowedHandshakeOrigin(origin, configuredIds)) return undefined;
  const from =
    origin === undefined
      ? 'without an Origin header'
      : origin === ''
        ? 'with an empty Origin header'
        : `from origin ${printableOrigin(origin)}`;
  const ids = allowedExtensionIds(configuredIds);
  return {
    accepted: false,
    reason: 'origin-not-allowed',
    logLine: `Rejected WS handshake ${from}: only extension ${ids.length === 1 ? 'id' : 'ids'} ${ids.join(', ')} may connect.`,
  };
}

/** What the gate says about a request: its `Origin`, then the process that
 * owns the other end of its TCP connection (same OS user, browser name and,
 * in the opt-in strict mode, a listed executable path). Both are required.
 * A lookup failure is a refusal; only a bug rejects, which both callers
 * turn into a 500. */
export async function evaluateHandshake(
  req: IncomingMessage,
  lookupPeerProcess: LookupPeerProcess,
): Promise<HandshakeVerdict> {
  // Read on every handshake, like every other config key the primary
  // honours without a restart.
  const config = loadConfig();
  const originRefusal = refuseOrigin(req.headers.origin, config.allowedExtensionIds ?? []);
  if (originRefusal !== undefined) return originRefusal;
  const remoteAddress = normaliseLoopback(req.socket.remoteAddress ?? '');
  const remotePort = req.socket.remotePort;
  if (!remoteAddress || remotePort == null) {
    return {
      accepted: false,
      reason: 'peer-unidentified',
      logLine: 'Rejected WS handshake: peer address/port not exposed by socket.',
    };
  }
  // `undefined` means strict mode is off.
  const strictPaths = config.peerExecutablePaths;
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
    if (lookup.cause === 'owner-unreadable') {
      return {
        accepted: false,
        reason: 'peer-owner-unreadable',
        logLine: `Rejected WS handshake from ${remoteAddress}:${remotePort}: the owner of the owning process could not be read (cause: owner-unreadable).`,
      };
    }
    if (lookup.cause === 'path-unreadable') {
      return {
        accepted: false,
        reason: 'peer-path-not-allowed',
        logLine: `Rejected WS handshake from ${remoteAddress}:${remotePort}: the executable path of the owning process could not be read for peerExecutablePaths (cause: path-unreadable).`,
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

/** Diagnostic lookups that may run at once, across all callers. Each one is
 * an OS process lookup (netstat plus PowerShell on Windows, about 0.5 s). */
export const MAX_CONCURRENT_HANDSHAKE_CHECKS = 2;

/** The message of a 500 when the gate itself failed (a bug, never a
 * verdict): the upgrade and the check are refused rather than left open. */
export const HANDSHAKE_GATE_FAILED = 'Handshake check failed';

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
 * The origin decides first: an extension whose id is not allowed (an old
 * install, a foreign extension) gets `origin-not-allowed` at once, with no
 * process lookup and outside the cap below.
 *
 * Bounded work: one lookup in flight per connection (a second request on the
 * same socket shares it; a new connection never does, even on a reused
 * address and port) and at most `maxConcurrent` in all; over the cap the
 * answer is `503 { busy: true }`, which the extension reads as "no
 * diagnosis". A verdict is shared only while its lookup runs. Logs nothing,
 * never rejects: a failure of the gate itself answers 500.
 */
export function createHandshakeCheckHandler(
  lookupPeerProcess: LookupPeerProcess,
  maxConcurrent: number = MAX_CONCURRENT_HANDSHAKE_CHECKS,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const inFlight = new Map<object, Promise<HandshakeVerdict>>();
  const answer = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
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
    const originRefusal = refuseOrigin(origin, loadConfig().allowedExtensionIds ?? []);
    if (originRefusal !== undefined) {
      res.writeHead(200, headers);
      res.end(JSON.stringify({ accepted: false, reason: originRefusal.reason }));
      return;
    }
    const connection = req.socket;
    let verdict = inFlight.get(connection);
    if (verdict === undefined) {
      if (inFlight.size >= maxConcurrent) {
        res.writeHead(503, headers);
        res.end(JSON.stringify({ busy: true }));
        return;
      }
      verdict = evaluateHandshake(req, lookupPeerProcess).finally(() => {
        inFlight.delete(connection);
      });
      inFlight.set(connection, verdict);
    }
    const settled = await verdict;
    res.writeHead(200, headers);
    res.end(
      JSON.stringify(
        settled.accepted ? { accepted: true } : { accepted: false, reason: settled.reason },
      ),
    );
  };
  return async (req, res) => {
    try {
      await answer(req, res);
    } catch {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(HANDSHAKE_GATE_FAILED);
    }
  };
}

/** Whether a plain HTTP request is the handshake check. */
export function isHandshakeCheckRequest(req: IncomingMessage): boolean {
  return req.method === 'GET' && (req.url ?? '').split('?')[0] === HANDSHAKE_CHECK_PATH;
}
