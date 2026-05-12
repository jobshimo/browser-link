import { createInterface, type Interface } from 'node:readline';
import { IpcClient } from './ipc-client.js';
import { readToken } from './token.js';

/**
 * Proxy wrapper around IpcClient. Pipes MCP frames between the parent's
 * stdin/stdout and the IPC bridge to the primary browser-link process.
 *
 * runProxy() owns the line buffer on the input side, the JSON-RPC framing,
 * the optional auto-reelect loop (survives IPC drops by reconnecting to a
 * fresh primary), and the stop()/closed handle the caller waits on.
 */

function log(msg: string): void {
  console.error(`[browser-link proxy] ${msg}`);
}

export interface ProxyOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  /** Called when the IPC connection drops and (if reelect was enabled)
   * could not be re-established. After this fires the proxy is dead;
   * callers usually want to exit the process. */
  onClose?: (reason: 'remote' | 'local' | 'primary-closing') => void;
  /** Override the token used in the hello. Tests pass this directly so
   * they don't need to write a token file. Production reads it from disk. */
  token?: string;
  /** Override IPC endpoint. */
  host?: string;
  port?: number;
  /** When true, instead of giving up on the first IPC drop, the proxy
   * tries to reconnect to a fresh primary at the same IPC port for up to
   * reelectTimeoutMs. During that window, any incoming JSON-RPC request
   * from stdin gets an immediate "bridge unavailable" error response so
   * the MCP client doesn't hang. Default: false. */
  autoReelect?: boolean;
  /** Total budget (ms) to wait for a new primary before giving up.
   * Default: 5000. */
  reelectTimeoutMs?: number;
  /** Per-attempt interval (ms) between reconnect tries. Default: 200. */
  reelectIntervalMs?: number;
  /** Hook for tests: called whenever the proxy starts a reconnect
   * attempt cycle. Production callers ignore. */
  onReelectStart?: () => void;
  /** Hook for tests: called when a reconnect cycle succeeds. */
  onReelectSuccess?: () => void;
  /** Hook for tests: called when a reconnect cycle exhausts the budget. */
  onReelectExhausted?: () => void;
}

export interface ProxyHandle {
  client: IpcClient;
  stop(): Promise<void>;
  /** Resolves once the IPC connection drops (any reason). */
  closed: Promise<void>;
}

/** Read the token from disk and connect to the running primary, then plug
 * stdin → IPC mcp.request and IPC mcp.response → stdout.
 *
 * When `autoReelect: true` is passed, the proxy survives IPC drops by
 * waiting for a fresh primary to appear at the same port. During the
 * wait, incoming JSON-RPC requests get an immediate error response so
 * the MCP client never hangs on a missing reply. */
export async function runProxy(opts: ProxyOptions = {}): Promise<ProxyHandle> {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const autoReelect = opts.autoReelect === true;
  const reelectTimeoutMs = opts.reelectTimeoutMs ?? 5000;
  const reelectIntervalMs = opts.reelectIntervalMs ?? 200;

  const initialToken = opts.token ?? readToken();
  if (!initialToken) {
    throw new Error(
      'Multi-agent token not found. The primary browser-link instance is not running with multi-agent enabled.',
    );
  }

  let client = new IpcClient();
  await client.connect(initialToken, { host: opts.host, port: opts.port });

  /* When the IPC drops AND autoReelect is on, we enter "reconnecting"
   * mode. While reconnecting, the data pipe stays attached but requests
   * are answered immediately with an error envelope so the MCP client
   * does not stall on a missing reply.
   *
   * The flags live behind a getter pair on purpose: any read pattern
   * TS can statically narrow (let-binding, object literal property)
   * gets refined after the first `if (flag) return` and stays narrowed
   * across the subsequent `await reconnectLoop(...)`, even though
   * `stop()` can flip the value concurrently. TS does NOT narrow the
   * return type of a function call, which is exactly the safety net
   * we need for the post-await re-check. */
  const flags = { stopped: false, reconnecting: false };
  const isStopped = (): boolean => flags.stopped;
  const isReconnecting = (): boolean => flags.reconnecting;

  let closedResolve: () => void = () => {
    /* replaced synchronously in the Promise executor below */
  };
  const closed = new Promise<void>((resolve) => {
    closedResolve = resolve;
  });

  const fail = (reason: 'remote' | 'local' | 'primary-closing') => {
    if (isStopped()) return;
    flags.stopped = true;
    input.off('data', onData);
    if (opts.onClose) {
      try {
        opts.onClose(reason);
      } catch (err) {
        log(`onClose handler threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    closedResolve();
  };

  // Set up the input pipe. We can't use readline.createInterface on a raw
  // stream that has already been data-event-attached, but we can use a
  // simple line buffer like the server side.
  let lineBuffer = '';
  const onData = (chunk: Buffer | string) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    lineBuffer += text;
    let nl: number;
    while ((nl = lineBuffer.indexOf('\n')) >= 0) {
      const line = lineBuffer.slice(0, nl).replace(/\r$/, '');
      lineBuffer = lineBuffer.slice(nl + 1);
      if (line.length === 0) continue;
      handleLine(line);
    }
  };

  const handleLine = (line: string): void => {
    let msg: { id?: number | string | null };
    try {
      msg = JSON.parse(line) as { id?: number | string | null };
    } catch {
      output.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error in proxy input.' },
        }) + '\n',
      );
      return;
    }
    if (typeof msg !== 'object') return;

    if (msg.id === undefined || msg.id === null) {
      // Notification — fire and forget when connected; drop during reconnect.
      if (!isReconnecting()) client.sendMcpNotification(msg);
      return;
    }

    if (isReconnecting()) {
      // Fail fast so the MCP client can decide to retry.
      output.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          error: {
            code: -32001,
            message:
              'browser-link bridge temporarily unavailable (primary just closed; reconnecting).',
          },
        }) + '\n',
      );
      return;
    }

    // Capture the id NOW; by the time the catch fires the closure scope
    // still has `msg`, but TS narrowing of `msg` inside the catch is
    // weaker than reading the field upfront.
    const incomingId = msg.id;
    client
      .sendMcpRequest(msg)
      .then((responsePayload) => {
        output.write(JSON.stringify(responsePayload) + '\n');
      })
      .catch((err: unknown) => {
        output.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: incomingId,
            error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
          }) + '\n',
        );
      });
  };

  input.on('data', onData);

  const wireCloseHandler = (c: IpcClient): void => {
    // The onClose contract is sync (returns void). The body needs awaits
    // for the reconnect loop, so we kick off an async IIFE inside.
    c.onClose((reason) => {
      void (async () => {
        if (isStopped()) return;
        if (!autoReelect) {
          fail(reason);
          return;
        }
        // Enter reconnect mode and try to find a new primary.
        flags.reconnecting = true;
        opts.onReelectStart?.();
        log(`Primary closed (${reason}); reelect window opened for ${reelectTimeoutMs}ms.`);
        const newClient = await reconnectLoop(
          opts.host,
          opts.port,
          reelectTimeoutMs,
          reelectIntervalMs,
        );
        // `stop()` may have run during the await above and flipped
        // `flags.stopped`. The `isStopped()` call dodges TS narrowing
        // from the check at the top of this IIFE so the runtime guard
        // stays real.
        if (isStopped()) {
          if (newClient) await newClient.disconnect();
          return;
        }
        if (!newClient) {
          log('Reelect window exhausted; closing proxy.');
          opts.onReelectExhausted?.();
          flags.reconnecting = false;
          fail(reason);
          return;
        }
        // Hot-swap clients. The old one is already torn down by its close
        // handler chain; we just install the new one and wire it up.
        log('Reconnected to new primary.');
        opts.onReelectSuccess?.();
        client = newClient;
        flags.reconnecting = false;
        wireCloseHandler(client);
      })();
    });
  };
  wireCloseHandler(client);

  const stop = async (): Promise<void> => {
    flags.stopped = true;
    input.off('data', onData);
    await client.disconnect();
    closedResolve();
  };

  return {
    get client() {
      return client;
    },
    stop,
    closed,
  };
}

/** Repeatedly try to connect to the IPC port until success or budget
 * expires. Re-reads the token on every attempt because a new primary
 * rotates it on startup. Returns the connected client, or null on
 * timeout. */
async function reconnectLoop(
  host: string | undefined,
  port: number | undefined,
  totalBudgetMs: number,
  intervalMs: number,
): Promise<IpcClient | null> {
  const deadline = Date.now() + totalBudgetMs;
  // Generous handshake budget — Windows under load can take >200ms for a
  // local socket round-trip and a too-tight ceiling makes reconnects flap.
  const handshakeTimeoutMs = Math.min(1500, Math.max(800, intervalMs * 4));
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const token = readToken();
    if (!token) continue;
    const c = new IpcClient();
    try {
      await c.connect(token, { host, port, handshakeTimeoutMs });
      return c;
    } catch {
      try {
        await c.disconnect();
      } catch {
        /* ignore */
      }
      // Retry until deadline.
    }
  }
  return null;
}

/** Convenience: open a readline-style line iterator over a stream. Currently
 * unused (we use a hand-rolled line buffer for symmetry with the server)
 * but exported for future tooling. */
export function readlines(stream: NodeJS.ReadableStream): Interface {
  return createInterface({ input: stream, crlfDelay: Infinity });
}
