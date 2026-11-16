import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, type Socket } from 'node:net';
import * as paths from '../map/paths.js';
import { IPC_MAX_PREAUTH_LINE_BYTES, IpcServer } from './server.js';
import { SERVER_INSTRUCTIONS } from '../tools/server-instructions.js';
import { IPC_PROTOCOL_VERSION, encodeFrame, parseFrame, type Frame } from './protocol.js';
import { readToken } from './token.js';
import type { DispatchDeps } from './dispatch.js';
import type { PeerProcess } from '../auth/process-identity.js';

/** Deterministic peer-lookup stub. The real lookup shells out to lsof/netstat,
 * which is flaky or unavailable on CI runners; for these integration tests we
 * only care that the handshake + dispatch logic is correct. */
const TEST_PEER_LOOKUP = (): Promise<PeerProcess> =>
  Promise.resolve({ pid: process.pid, binaryName: 'node' });

/* Integration test for the IPC server's accept loop + handshake. Spawns a
 * real listening server on an OS-assigned ephemeral port and connects to
 * it with a raw TCP client. The fact that we connect from this very test
 * process means we pass the kernel-level process-binding check naturally:
 * it's a Node process talking to a Node process. */

const STUB_DEPS: DispatchDeps = {
  browserTools: {
    listTabs: () => [],
    callBrowserTool: () => Promise.reject(new Error('not used in this test')),
  },
  disabledTools: () => [],
};

let dataDir: string;
let dataDirSpy: ReturnType<typeof vi.spyOn>;
let server: IpcServer | null = null;
const sockets: Socket[] = [];

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'browser-link-ipc-srv-'));
  dataDirSpy = vi.spyOn(paths, 'getDataDir').mockReturnValue(dataDir);
});

afterEach(async () => {
  for (const s of sockets.splice(0)) {
    try {
      s.destroy();
    } catch {
      /* ignore */
    }
  }
  if (server) {
    await server.stop();
    server = null;
  }
  dataDirSpy.mockRestore();
  rmSync(dataDir, { recursive: true, force: true });
});

/** Open a raw TCP connection to the running IPC server. */
function dial(addr: { host: string; port: number }): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = connect({ host: addr.host, port: addr.port }, () => resolve(s));
    s.once('error', reject);
    sockets.push(s);
  });
}

/** Spin up an IpcServer on a free OS-assigned port. */
async function startEphemeral(deps: DispatchDeps = STUB_DEPS): Promise<IpcServer> {
  const s = new IpcServer(deps, { port: 0, peerLookup: TEST_PEER_LOOKUP });
  await s.start();
  return s;
}

/** Read NDJSON frames from a socket until N frames have arrived or the
 * timeout elapses. Returns whatever was collected. */
function readNFrames(s: Socket, n: number, timeoutMs = 1500): Promise<Frame[]> {
  return new Promise((resolve) => {
    const out: Frame[] = [];
    let buffer = '';
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const frame = parseFrame(line);
        if (frame) out.push(frame);
        if (out.length >= n) {
          s.off('data', onData);
          clearTimeout(timer);
          resolve(out);
          return;
        }
      }
    };
    const timer = setTimeout(() => {
      s.off('data', onData);
      resolve(out);
    }, timeoutMs);
    s.on('data', onData);
  });
}

describe('IpcServer.start', () => {
  test('binds the IPC port and rotates the token on startup', async () => {
    server = await startEphemeral();
    const token = readToken();
    expect(token).not.toBeNull();
    expect(token).toBe(server.currentToken());
  });

  test('rejects EADDRINUSE on a second start of the same port', async () => {
    server = await startEphemeral();
    const { port } = server.boundAddress();
    const second = new IpcServer(STUB_DEPS, { port, peerLookup: TEST_PEER_LOOKUP });
    await expect(second.start()).rejects.toThrow(/already in use/i);
  });
});

describe('IpcServer handshake', () => {
  test('accepts a valid hello and replies hello-ack', async () => {
    server = await startEphemeral();
    const token = server.currentToken();

    const s = await dial(server.boundAddress());
    s.write(encodeFrame({ kind: 'hello', version: IPC_PROTOCOL_VERSION, token }));
    const frames = await readNFrames(s, 1);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.kind).toBe('hello-ack');
    const ack = frames[0] as { kind: 'hello-ack'; version: string; sessionId: string };
    expect(ack.version).toBe(IPC_PROTOCOL_VERSION);
    expect(ack.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(server.sessionCount()).toBe(1);
  });

  test('rejects a hello with wrong protocol version', async () => {
    server = await startEphemeral();
    const token = server.currentToken();

    const s = await dial(server.boundAddress());
    s.write(encodeFrame({ kind: 'hello', version: '999', token }));
    const frames = await readNFrames(s, 1);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.kind).toBe('hello-reject');
    const rej = frames[0] as { kind: 'hello-reject'; reason: string };
    expect(rej.reason).toMatch(/version mismatch/);
    expect(server.sessionCount()).toBe(0);
  });

  test('rejects a hello with wrong token', async () => {
    server = await startEphemeral();

    const s = await dial(server.boundAddress());
    s.write(encodeFrame({ kind: 'hello', version: IPC_PROTOCOL_VERSION, token: 'wrong' }));
    const frames = await readNFrames(s, 1);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.kind).toBe('hello-reject');
    const rej = frames[0] as { kind: 'hello-reject'; reason: string };
    expect(rej.reason).toMatch(/invalid token/);
    expect(server.sessionCount()).toBe(0);
  });

  test('sessionCount counts only authenticated proxies and follows disconnects (D18)', async () => {
    server = await startEphemeral();
    const token = server.currentToken();
    const hello = encodeFrame({ kind: 'hello', version: IPC_PROTOCOL_VERSION, token });
    expect(server.sessionCount()).toBe(0);

    // Connected, past the process check, but silent: not a session yet.
    const silent = await dial(server.boundAddress());
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(server.sessionCount()).toBe(0);

    const a = await dial(server.boundAddress());
    a.write(hello);
    await readNFrames(a, 1);
    const b = await dial(server.boundAddress());
    b.write(hello);
    await readNFrames(b, 1);
    expect(server.sessionCount()).toBe(2);

    // A refused hello on the same server never joins the count.
    const refused = await dial(server.boundAddress());
    refused.write(encodeFrame({ kind: 'hello', version: IPC_PROTOCOL_VERSION, token: 'wrong' }));
    await readNFrames(refused, 1);
    expect(server.sessionCount()).toBe(2);

    a.destroy();
    for (let i = 0; i < 50 && server.sessionCount() > 1; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(server.sessionCount()).toBe(1);
    silent.destroy();
  });

  test('drops a connection whose first frame is not hello', async () => {
    server = await startEphemeral();

    const s = await dial(server.boundAddress());
    s.write(encodeFrame({ kind: 'ping' }));
    const frames = await readNFrames(s, 1, 400);
    expect(frames).toHaveLength(0);
    expect(server.sessionCount()).toBe(0);
  });
});

describe('IpcServer resilience during the peer lookup', () => {
  test('a client that resets while the peer lookup is pending does not crash the primary', async () => {
    // The lookup resolves only after the client has sent RST, so the reset
    // arrives while handleConnection is still awaiting it.
    let releaseLookup: () => void = () => undefined;
    let lookupStarted: () => void = () => undefined;
    const started = new Promise<void>((r) => (lookupStarted = r));
    let first = true;
    const slowLookup = (): Promise<PeerProcess> => {
      if (!first) return TEST_PEER_LOOKUP();
      first = false;
      lookupStarted();
      return new Promise((resolve) => {
        releaseLookup = () => resolve({ pid: process.pid, binaryName: 'node' });
      });
    };
    const uncaught: Error[] = [];
    const probe = (err: Error) => uncaught.push(err);
    process.on('uncaughtException', probe);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      server = new IpcServer(STUB_DEPS, { port: 0, peerLookup: slowLookup });
      await server.start();

      const s = await dial(server.boundAddress());
      s.on('error', () => undefined);
      await started;
      s.resetAndDestroy();
      await new Promise((r) => setTimeout(r, 200));
      releaseLookup();
      await new Promise((r) => setTimeout(r, 50));

      expect(uncaught).toEqual([]);
      const logged = errSpy.mock.calls.map((c) => String(c[0]));
      expect(
        logged.some((l) => l.startsWith('[browser-link ipc] Proxy socket error: "ECONNRESET"')),
      ).toBe(true);
      expect(logged.every((l) => !/[\r\n]/.test(l))).toBe(true);

      // The primary keeps serving: a second, well-behaved client completes
      // the handshake.
      const second = await dial(server.boundAddress());
      second.write(
        encodeFrame({ kind: 'hello', version: IPC_PROTOCOL_VERSION, token: server.currentToken() }),
      );
      const frames = await readNFrames(second, 1);
      expect(frames[0]?.kind).toBe('hello-ack');
    } finally {
      process.off('uncaughtException', probe);
      errSpy.mockRestore();
    }
  });
});

describe('IpcServer.stop', () => {
  test('broadcasts primary-closing to live sessions', async () => {
    server = await startEphemeral();
    const token = server.currentToken();

    const s = await dial(server.boundAddress());
    s.write(encodeFrame({ kind: 'hello', version: IPC_PROTOCOL_VERSION, token }));
    const ack = await readNFrames(s, 1);
    expect(ack[0]!.kind).toBe('hello-ack');

    const broadcast = readNFrames(s, 1, 1500);
    await server.stop();
    server = null;
    const frames = await broadcast;
    expect(frames).toHaveLength(1);
    expect(frames[0]!.kind).toBe('primary-closing');
  });
});

describe('IpcServer MCP dispatch', () => {
  test('routes tools/list through the shared dispatcher', async () => {
    server = await startEphemeral({ ...STUB_DEPS, disabledTools: () => ['browser.evaluate'] });
    const token = server.currentToken();

    const s = await dial(server.boundAddress());
    s.write(encodeFrame({ kind: 'hello', version: IPC_PROTOCOL_VERSION, token }));
    await readNFrames(s, 1); // ack

    s.write(
      encodeFrame({
        kind: 'mcp.request',
        requestId: 42,
        payload: { jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} },
      }),
    );

    const frames = await readNFrames(s, 5, 1500);
    const response = frames.find(
      (f) => f.kind === 'mcp.response' && (f as { requestId: number }).requestId === 42,
    ) as { kind: 'mcp.response'; requestId: number; payload: unknown } | undefined;
    expect(response).toBeDefined();
    const jsonrpc = response!.payload as {
      jsonrpc: string;
      id: number;
      result?: { tools: { name: string }[] };
    };
    expect(jsonrpc.jsonrpc).toBe('2.0');
    expect(jsonrpc.id).toBe(7);
    expect(jsonrpc.result!.tools.map((t) => t.name)).not.toContain('browser.evaluate');
    expect(jsonrpc.result!.tools.map((t) => t.name)).toContain('browser.list_tabs');
  });

  test('routes initialize and returns server capabilities', async () => {
    server = await startEphemeral();
    const token = server.currentToken();
    const s = await dial(server.boundAddress());
    s.write(encodeFrame({ kind: 'hello', version: IPC_PROTOCOL_VERSION, token }));
    await readNFrames(s, 1);
    s.write(
      encodeFrame({
        kind: 'mcp.request',
        requestId: 1,
        payload: { jsonrpc: '2.0', id: 100, method: 'initialize', params: {} },
      }),
    );
    const frames = await readNFrames(s, 5, 1500);
    const response = frames.find(
      (f) => f.kind === 'mcp.response' && (f as { requestId: number }).requestId === 1,
    ) as
      { payload: { result: { serverInfo: { name: string }; instructions?: string } } } | undefined;
    expect(response).toBeDefined();
    expect(response!.payload.result.serverInfo.name).toBe('browser-link');
    expect(response!.payload.result.instructions).toBeTruthy();
  });

  test('initialize returns the instructions the primary built at start (notice included)', async () => {
    const notice =
      'Your browser-link instructions block is installed-outdated (installed v0.1.0, server v9.9.9): run `browser-link instructions install` and restart the client.';
    server = new IpcServer(STUB_DEPS, {
      port: 0,
      peerLookup: TEST_PEER_LOOKUP,
      instructions: [notice, '', 'rest'].join('\n'),
    });
    await server.start();
    const s = await dial(server.boundAddress());
    s.write(
      encodeFrame({ kind: 'hello', version: IPC_PROTOCOL_VERSION, token: server.currentToken() }),
    );
    await readNFrames(s, 1);
    s.write(
      encodeFrame({
        kind: 'mcp.request',
        requestId: 2,
        payload: { jsonrpc: '2.0', id: 101, method: 'initialize', params: {} },
      }),
    );
    const frames = await readNFrames(s, 5, 1500);
    const response = frames.find(
      (f) => f.kind === 'mcp.response' && (f as { requestId: number }).requestId === 2,
    ) as { payload: { result: { instructions?: string } } } | undefined;
    expect(response!.payload.result.instructions!.split('\n')[0]).toBe(notice);
  });

  test('initialize without an injected text returns SERVER_INSTRUCTIONS', async () => {
    server = await startEphemeral();
    const s = await dial(server.boundAddress());
    s.write(
      encodeFrame({ kind: 'hello', version: IPC_PROTOCOL_VERSION, token: server.currentToken() }),
    );
    await readNFrames(s, 1);
    s.write(
      encodeFrame({
        kind: 'mcp.request',
        requestId: 3,
        payload: { jsonrpc: '2.0', id: 102, method: 'initialize', params: {} },
      }),
    );
    const frames = await readNFrames(s, 5, 1500);
    const response = frames.find(
      (f) => f.kind === 'mcp.response' && (f as { requestId: number }).requestId === 3,
    ) as { payload: { result: { instructions?: string } } } | undefined;
    expect(response!.payload.result.instructions).toBe(SERVER_INSTRUCTIONS);
  });

  test('returns method-not-found for unknown methods', async () => {
    server = await startEphemeral();
    const token = server.currentToken();
    const s = await dial(server.boundAddress());
    s.write(encodeFrame({ kind: 'hello', version: IPC_PROTOCOL_VERSION, token }));
    await readNFrames(s, 1);
    s.write(
      encodeFrame({
        kind: 'mcp.request',
        requestId: 2,
        payload: { jsonrpc: '2.0', id: 1, method: 'totally/fake' },
      }),
    );
    const frames = await readNFrames(s, 5, 1500);
    const response = frames.find(
      (f) => f.kind === 'mcp.response' && (f as { requestId: number }).requestId === 2,
    ) as { payload: { error?: { code: number; message: string } } } | undefined;
    expect(response).toBeDefined();
    expect(response!.payload.error?.code).toBe(-32601);
    expect(response!.payload.error?.message).toMatch(/Method not found/);
  });
});

describe('IpcServer settings.push', () => {
  test('forwards to the injected pushSettings callback and acks with its return value', async () => {
    const received: Array<{ idleTtlMinutes: number; updatedAt: number }> = [];
    server = new IpcServer(STUB_DEPS, {
      port: 0,
      peerLookup: TEST_PEER_LOOKUP,
      pushSettings: (settings) => {
        received.push(settings);
        return 3;
      },
    });
    await server.start();
    const token = server.currentToken();

    const s = await dial(server.boundAddress());
    s.write(encodeFrame({ kind: 'hello', version: IPC_PROTOCOL_VERSION, token }));
    await readNFrames(s, 1); // ack

    s.write(
      encodeFrame({
        kind: 'settings.push',
        settings: { idleTtlMinutes: 45, updatedAt: 1_700_000_000_000 },
      }),
    );
    const frames = await readNFrames(s, 1, 1500);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({ kind: 'settings.push-ack', notified: 3 });
    expect(received).toEqual([{ idleTtlMinutes: 45, updatedAt: 1_700_000_000_000 }]);
  });

  test('acks with 0 when no pushSettings callback was configured', async () => {
    server = new IpcServer(STUB_DEPS, { port: 0, peerLookup: TEST_PEER_LOOKUP });
    await server.start();
    const token = server.currentToken();

    const s = await dial(server.boundAddress());
    s.write(encodeFrame({ kind: 'hello', version: IPC_PROTOCOL_VERSION, token }));
    await readNFrames(s, 1);

    s.write(
      encodeFrame({
        kind: 'settings.push',
        settings: { idleTtlMinutes: 10, updatedAt: 1 },
      }),
    );
    const frames = await readNFrames(s, 1, 1500);
    expect(frames[0]).toEqual({ kind: 'settings.push-ack', notified: 0 });
  });
});

describe('IpcServer pre-authentication limits', () => {
  /** Resolves when the server closes the connection, false after `ms`. */
  function closedWithin(s: Socket, ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (s.destroyed) return resolve(true);
      const timer = setTimeout(() => resolve(false), ms);
      s.once('close', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  test('destroys an accepted socket that never completes the hello', async () => {
    server = new IpcServer(STUB_DEPS, {
      port: 0,
      peerLookup: TEST_PEER_LOOKUP,
      helloTimeoutMs: 150,
    });
    await server.start();
    const silent = await dial(server.boundAddress());
    expect(await closedWithin(silent, 3000)).toBe(true);
    expect(server.sessionCount()).toBe(0);
  });

  test('a completed hello cancels the deadline', async () => {
    server = new IpcServer(STUB_DEPS, {
      port: 0,
      peerLookup: TEST_PEER_LOOKUP,
      helloTimeoutMs: 150,
    });
    await server.start();
    const s = await dial(server.boundAddress());
    s.write(
      encodeFrame({ kind: 'hello', version: IPC_PROTOCOL_VERSION, token: server.currentToken() }),
    );
    expect((await readNFrames(s, 1))[0]!.kind).toBe('hello-ack');
    expect(await closedWithin(s, 500)).toBe(false);
    expect(server.sessionCount()).toBe(1);
  });

  test('destroys a socket whose unauthenticated line grows past the bound', async () => {
    server = await startEphemeral();
    const s = await dial(server.boundAddress());
    // No newline: the buffer would grow without limit.
    s.write('x'.repeat(IPC_MAX_PREAUTH_LINE_BYTES + 1));
    expect(await closedWithin(s, 3000)).toBe(true);
    expect(server.sessionCount()).toBe(0);
  });

  test('destroys a socket whose complete first line is over the bound', async () => {
    server = await startEphemeral();
    const s = await dial(server.boundAddress());
    s.write(`${'y'.repeat(IPC_MAX_PREAUTH_LINE_BYTES + 1)}
`);
    expect(await closedWithin(s, 3000)).toBe(true);
    expect(server.sessionCount()).toBe(0);
  });

  test('destroys a socket whose multi-byte unterminated remainder is over the bound in bytes', async () => {
    server = await startEphemeral();
    const s = await dial(server.boundAddress());
    // 3 bytes per char: fewer chars than the bound, more bytes than the bound.
    const chars = Math.ceil(IPC_MAX_PREAUTH_LINE_BYTES / 3) + 1;
    expect(chars).toBeLessThan(IPC_MAX_PREAUTH_LINE_BYTES);
    s.write('€'.repeat(chars));
    expect(await closedWithin(s, 3000)).toBe(true);
  });

  test('a hello and a post-auth frame pipelined in one chunk are both handled', async () => {
    server = await startEphemeral();
    const s = await dial(server.boundAddress());
    const hello = encodeFrame({
      kind: 'hello',
      version: IPC_PROTOCOL_VERSION,
      token: server.currentToken(),
    });
    const big = encodeFrame({
      kind: 'mcp.notification',
      payload: { pad: 'p'.repeat(IPC_MAX_PREAUTH_LINE_BYTES * 2) },
    } as never);
    s.write(hello + big + encodeFrame({ kind: 'ping' }));
    const frames = await readNFrames(s, 2);
    expect(frames.map((f) => f.kind)).toEqual(['hello-ack', 'pong']);
    expect(server.sessionCount()).toBe(1);
  });

  test('a legitimate hello well under the bound is still accepted', async () => {
    server = await startEphemeral();
    const s = await dial(server.boundAddress());
    const hello = encodeFrame({
      kind: 'hello',
      version: IPC_PROTOCOL_VERSION,
      token: server.currentToken(),
    });
    expect(hello.length).toBeLessThan(IPC_MAX_PREAUTH_LINE_BYTES / 8);
    s.write(hello);
    expect((await readNFrames(s, 1))[0]!.kind).toBe('hello-ack');
  });

  test('a rejected hello stops parsing: a valid hello pipelined behind it opens no session', async () => {
    server = await startEphemeral();
    const s = await dial(server.boundAddress());
    const bad = encodeFrame({ kind: 'hello', version: IPC_PROTOCOL_VERSION, token: 'wrong' });
    const good = encodeFrame({
      kind: 'hello',
      version: IPC_PROTOCOL_VERSION,
      token: server.currentToken(),
    });
    s.write(bad + good);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const frames = await readNFrames(s, 1);
    expect(frames[0]!.kind).toBe('hello-reject');
    expect((await readNFrames(s, 1, 300)).map((f) => f.kind)).not.toContain('hello-ack');
    // A session opened by the pipelined hello would have been logged, even
    // if the socket's close removed it again before the reject frame arrived.
    const lines = logged.mock.calls.map((c) => String(c[0]));
    logged.mockRestore();
    expect(lines.some((l) => l.includes('Proxy connected'))).toBe(false);
    expect(server.sessionCount()).toBe(0);
    expect(await closedWithin(s, 3000)).toBe(true);
  });

  test('a version-mismatch reject also stops parsing', async () => {
    server = await startEphemeral();
    const s = await dial(server.boundAddress());
    const bad = encodeFrame({ kind: 'hello', version: '999', token: server.currentToken() });
    const good = encodeFrame({
      kind: 'hello',
      version: IPC_PROTOCOL_VERSION,
      token: server.currentToken(),
    });
    s.write(bad + good);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const frames = await readNFrames(s, 1);
    expect(frames[0]!.kind).toBe('hello-reject');
    expect((await readNFrames(s, 1, 300)).map((f) => f.kind)).not.toContain('hello-ack');
    // A session opened by the pipelined hello would have been logged, even
    // if the socket's close removed it again before the reject frame arrived.
    const lines = logged.mock.calls.map((c) => String(c[0]));
    logged.mockRestore();
    expect(lines.some((l) => l.includes('Proxy connected'))).toBe(false);
    expect(server.sessionCount()).toBe(0);
  });
});
