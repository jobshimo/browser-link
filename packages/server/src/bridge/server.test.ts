import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, type Socket } from 'node:net';
import * as paths from '../map/paths.js';
import { IpcServer } from './server.js';
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

  test('drops a connection whose first frame is not hello', async () => {
    server = await startEphemeral();

    const s = await dial(server.boundAddress());
    s.write(encodeFrame({ kind: 'ping' }));
    const frames = await readNFrames(s, 1, 400);
    expect(frames).toHaveLength(0);
    expect(server.sessionCount()).toBe(0);
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
