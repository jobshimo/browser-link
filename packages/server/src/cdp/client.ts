import { WebSocket } from 'ws';

/**
 * Minimal CDP-over-WebSocket client: one connection to a single Chrome
 * DevTools target's `webSocketDebuggerUrl`, with JSON-RPC-style command/
 * response correlation by numeric id, plus event subscription for CDP
 * events (e.g. `Page.loadEventFired`). This is the cdp-direct analogue of
 * what `chrome.debugger.sendCommand` / `chrome.debugger.onEvent` give the
 * extension in `packages/extension/src/background.ts` — same protocol
 * (Chrome DevTools Protocol), different transport (a raw WebSocket the
 * server dials itself instead of the extension's privileged API).
 */

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

type CdpEventHandler = (params: unknown) => void;

interface CdpFrame {
  id?: number;
  result?: unknown;
  error?: { message?: string; code?: number };
  method?: string;
  params?: unknown;
}

export interface CdpClientOptions {
  /** How long `connect()` waits for the WS handshake before giving up.
   * Default 5s — a local loopback connection should be near-instant; a
   * long default here would make a dead/stale target hang tool calls. */
  connectTimeoutMs?: number;
}

function frameToText(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  if (Array.isArray(raw)) return Buffer.concat(raw as Buffer[]).toString('utf8');
  return Buffer.from(raw as ArrayBuffer).toString('utf8');
}

export class CdpClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();
  private readonly eventHandlers = new Map<string, Set<CdpEventHandler>>();
  private closed = false;

  constructor(
    private readonly url: string,
    private readonly options: CdpClientOptions = {},
  ) {}

  /** Open the WebSocket and wait for it to be ready. Rejects on a bind
   * failure or on timeout — never leaves the caller waiting forever on a
   * target that vanished between discovery and connect. */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(this.url);
      const timeoutMs = this.options.connectTimeoutMs ?? 5_000;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        ws.terminate();
        reject(new Error(`cdp-direct: connection to ${this.url} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      ws.once('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.ws = ws;
        resolve();
      });
      ws.once('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
      ws.on('message', (raw) => {
        this.handleMessage(raw);
      });
      ws.on('close', () => {
        this.handleClose();
      });
    });
  }

  private handleMessage(raw: unknown): void {
    let msg: CdpFrame;
    try {
      msg = JSON.parse(frameToText(raw)) as CdpFrame;
    } catch {
      return;
    }
    if (typeof msg.id === 'number') {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(msg.error.message ?? 'CDP command failed'));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }
    if (typeof msg.method === 'string') {
      const handlers = this.eventHandlers.get(msg.method);
      if (handlers) for (const handler of handlers) handler(msg.params);
    }
  }

  private handleClose(): void {
    this.closed = true;
    const err = new Error('cdp-direct: connection closed');
    for (const pending of this.pending.values()) pending.reject(err);
    this.pending.clear();
  }

  /** Whether the underlying WebSocket is open and this client has not been
   * explicitly closed. Used by the transport's connection cache to decide
   * whether a cached client is still worth reusing. */
  get isOpen(): boolean {
    return !this.closed && this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /** Send one CDP command and wait for its matching response. */
  send<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 15_000,
  ): Promise<T> {
    if (!this.ws || this.closed) {
      return Promise.reject(new Error('cdp-direct: client is not connected'));
    }
    const id = this.nextId++;
    const ws = this.ws;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`cdp-direct: command "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Subscribe to a CDP event by method name (e.g. `Page.loadEventFired`).
   * Returns an unsubscribe function. Multiple handlers for the same method
   * may be registered independently. */
  on(method: string, handler: CdpEventHandler): () => void {
    let set = this.eventHandlers.get(method);
    if (!set) {
      set = new Set();
      this.eventHandlers.set(method, set);
    }
    set.add(handler);
    return () => set.delete(handler);
  }

  close(): void {
    this.closed = true;
    try {
      this.ws?.close();
    } catch {
      /* best effort */
    }
  }
}
