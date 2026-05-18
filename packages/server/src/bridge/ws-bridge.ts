import { WebSocket, WebSocketServer } from 'ws';
import type { ExtensionToServer, ServerToExtension } from '../messages.js';
import { isAllowedBrowser } from '../auth/allowlist.js';
import { lookupPeerProcess } from '../auth/process-identity.js';
import { VERSION } from '../version.js';
import { isExtensionEventKind, type BridgeEventLog } from './events.js';

export const WS_HOST = '127.0.0.1';
export const WS_PORT = 17529;

export interface TabSession {
  tabId: string;
  url: string;
  title: string;
  ws: WebSocket;
}

export interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
}

function log(msg: string): void {
  console.error(`[browser-link] ${msg}`);
}

function safeParse(raw: string): ExtensionToServer | null {
  try {
    return JSON.parse(raw) as ExtensionToServer;
  } catch {
    return null;
  }
}

function send(ws: WebSocket, msg: ServerToExtension): void {
  ws.send(JSON.stringify(msg));
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

/** Sentinel error used by the caller to detect a port-in-use and decide
 * whether to fall back to proxy mode. Anything else propagates unchanged. */
class AddrInUseError extends Error {
  constructor() {
    super(`browser-link: port ${WS_HOST}:${WS_PORT} is already in use.`);
    this.name = 'AddrInUseError';
  }
}

function translateBindError(err: NodeJS.ErrnoException): Error {
  if (err.code === 'EADDRINUSE') return new AddrInUseError();
  return err;
}

export function isAddrInUse(err: unknown): boolean {
  return err instanceof AddrInUseError;
}

let tabIdCounter = 0;
function assignTabId(): string {
  tabIdCounter += 1;
  return `tab_${tabIdCounter}`;
}

/** Bring up the WebSocket bridge for the Chrome extension. Resolves only
 * after the server is listening, so the caller can fail fast (and refuse
 * to expose the MCP transport) when the port is taken or any other bind
 * error happens. */
export function startWsBridge(
  tabs: Map<string, TabSession>,
  pendingRequests: Map<string, PendingRequest>,
  events: BridgeEventLog,
): Promise<WebSocketServer> {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({
      host: WS_HOST,
      port: WS_PORT,
      // Refuse the upgrade unless the OS confirms the peer is a Chromium-based
      // browser. The check happens before any application bytes are exchanged.
      verifyClient: (info, cb) => {
        const remoteAddress = normaliseLoopback(info.req.socket.remoteAddress ?? '');
        const remotePort = info.req.socket.remotePort;
        if (!remoteAddress || remotePort == null) {
          log('Rejected WS handshake: peer address/port not exposed by socket.');
          cb(false, 403, 'Cannot identify peer');
          return;
        }
        lookupPeerProcess(remoteAddress, remotePort)
          .then((peer) => {
            if (!peer) {
              log(
                `Rejected WS handshake from ${remoteAddress}:${remotePort}: could not identify owning process.`,
              );
              cb(false, 403, 'Peer process unknown');
              return;
            }
            if (!isAllowedBrowser(peer.binaryName)) {
              log(
                `Rejected WS handshake from PID ${peer.pid} (${peer.binaryName}): not a Chromium-based browser.`,
              );
              cb(false, 403, 'Peer is not a Chromium-based browser');
              return;
            }
            cb(true);
          })
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            log(`Rejected WS handshake: process lookup failed (${msg}).`);
            cb(false, 500, 'Process lookup failed');
          });
      },
    });

    let settled = false;

    wss.on('listening', () => {
      settled = true;
      log(`WebSocket listening on ws://${WS_HOST}:${WS_PORT}`);
      resolve(wss);
    });

    wss.on('error', (err: NodeJS.ErrnoException) => {
      if (!settled) {
        settled = true;
        reject(translateBindError(err));
        return;
      }
      // Post-listening errors: log but keep running; ws will emit per-connection
      // errors separately.
      log(`WebSocket server error: ${err.message}`);
    });

    wss.on('connection', (ws) => {
      let assignedTabId: string | null = null;

      ws.on('message', (raw) => {
        // `raw` from ws is Buffer | ArrayBuffer | Buffer[]. Normalize to
        // a single utf-8 string so safeParse can't see '[object Object]'
        // when the platform hands us an unexpected shape.
        const text = Buffer.isBuffer(raw)
          ? raw.toString('utf8')
          : Array.isArray(raw)
            ? Buffer.concat(raw).toString('utf8')
            : Buffer.from(raw).toString('utf8');
        const msg = safeParse(text);
        if (!msg) return;

        if (msg.kind === 'tab.register' && !assignedTabId) {
          // The extension may pass `previousTabId` so we can preserve the
          // browser-link tab id across primary swaps. We honour it when it
          // is free; otherwise we assign a new id and emit `tab-renamed`
          // so the agent can recover.
          const previousTabId =
            typeof msg.payload.previousTabId === 'string' ? msg.payload.previousTabId : undefined;
          if (previousTabId && !tabs.has(previousTabId) && /^tab_\d+$/.test(previousTabId)) {
            assignedTabId = previousTabId;
            // Bump the counter so future fresh assignments don't collide.
            const n = parseInt(previousTabId.slice('tab_'.length), 10);
            if (Number.isFinite(n) && n > tabIdCounter) tabIdCounter = n;
          } else {
            assignedTabId = assignTabId();
          }
          tabs.set(assignedTabId, {
            tabId: assignedTabId,
            url: msg.payload.url,
            title: msg.payload.title,
            ws,
          });
          send(ws, {
            kind: 'tab.registered',
            payload: { tabId: assignedTabId, serverVersion: VERSION },
          });
          log(`Tab registered: ${assignedTabId} -> ${msg.payload.url}`);
          if (previousTabId && previousTabId !== assignedTabId) {
            events.add('tab-renamed', {
              previous: previousTabId,
              current: assignedTabId,
              url: msg.payload.url,
              title: msg.payload.title,
            });
            log(`Tab id renamed: ${previousTabId} -> ${assignedTabId}`);
          } else {
            events.add('tab-registered', {
              tabId: assignedTabId,
              url: msg.payload.url,
              title: msg.payload.title,
            });
          }
          return;
        }

        if (msg.kind === 'tool.response') {
          const pending = pendingRequests.get(msg.id);
          if (!pending) return;
          clearTimeout(pending.timeout);
          pendingRequests.delete(msg.id);
          if (msg.ok) pending.resolve(msg.result);
          else pending.reject(new Error(msg.error));
          return;
        }

        if (msg.kind === 'bridge.event') {
          // Closed allowlist — the extension can only push the kinds tied to
          // popup awareness (dialogs / new tabs). Lifecycle kinds (primary-elected,
          // tab-registered, etc.) stay server-owned so they can't be spoofed
          // from the renderer side.
          if (!isExtensionEventKind(msg.eventKind)) {
            log(`Ignoring bridge.event with unknown/forbidden kind: ${msg.eventKind}`);
            return;
          }
          const data: Record<string, unknown> = { ...msg.data };
          if (msg.tabId) data.tab_id = msg.tabId;
          events.add(msg.eventKind, data);
          return;
        }
      });

      ws.on('close', () => {
        if (assignedTabId) {
          tabs.delete(assignedTabId);
          events.add('tab-disconnected', { tabId: assignedTabId });
          log(`Tab disconnected: ${assignedTabId}`);
        }
      });

      ws.on('error', (err) => {
        log(`WS connection error: ${err.message}`);
      });
    });
  });
}

/** Build the callback that sends a tool.request frame to a specific tab and
 * resolves with the matching tool.response (or rejects on timeout). Kept here
 * because it touches the same `tabs` / `pendingRequests` maps the bridge
 * owns. */
export function sendToolRequest(
  tabs: Map<string, TabSession>,
  pendingRequests: Map<string, PendingRequest>,
  tabId: string,
  id: string,
  tool: string,
  params: unknown,
  timeoutMs: number,
): Promise<unknown> {
  const session = tabs.get(tabId);
  if (!session) {
    // Auto-hint pointing the agent at `browser.events`. The event log
    // tracks tab-renamed entries that explain stale tab_ids after a
    // primary swap, so the agent can self-recover instead of failing.
    return Promise.reject(
      new Error(
        `Tab not connected: ${tabId}. The Chrome extension may have re-registered with a new id ` +
          `after a primary change. Call browser.events (look for tab-renamed entries with previous=${tabId}) ` +
          `to find the current id, then retry the call on it.`,
      ),
    );
  }
  return new Promise<unknown>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Tool '${tool}' timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pendingRequests.set(id, { resolve, reject, timeout });
    send(session.ws, { kind: 'tool.request', id, tool, params });
  });
}
