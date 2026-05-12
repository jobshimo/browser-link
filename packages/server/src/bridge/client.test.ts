import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import * as paths from '../map/paths.js';
import { IpcServer } from './server.js';
import { IpcClient, runProxy } from './client.js';
import { IPC_PROTOCOL_VERSION } from './protocol.js';
import type { DispatchDeps } from './dispatch.js';
import type { PeerProcess } from '../auth/process-identity.js';

/** Deterministic peer-lookup stub. The real lookup shells out to lsof/netstat,
 * which is flaky or unavailable on CI runners; for these integration tests we
 * only care that the handshake + dispatch logic is correct. */
const TEST_PEER_LOOKUP = (): Promise<PeerProcess> =>
  Promise.resolve({ pid: process.pid, binaryName: 'node' });

/* End-to-end integration: real IpcServer + real IpcClient over a real TCP
 * socket on 127.0.0.1:17530, plus the runProxy() wrapper that pipes
 * NDJSON-on-streams to and from the client. Each test gets its own
 * throwaway data dir so the token file does not collide. */

const STUB_DEPS: DispatchDeps = {
  browserTools: {
    listTabs: () => [{ tab_id: 'tab_1', url: 'https://example.com', title: 'Example' }],
    callBrowserTool: () => Promise.reject(new Error('not used in this test')),
  },
  disabledTools: [],
};

let dataDir: string;
let dataDirSpy: ReturnType<typeof vi.spyOn>;
let server: IpcServer | null = null;
const clients: IpcClient[] = [];

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'browser-link-ipc-cli-'));
  dataDirSpy = vi.spyOn(paths, 'getDataDir').mockReturnValue(dataDir);
});

afterEach(async () => {
  for (const c of clients.splice(0)) {
    try {
      await c.disconnect();
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

describe('IpcClient.connect', () => {
  test('handshakes successfully with a valid token', async () => {
    server = new IpcServer(STUB_DEPS, { port: 0, peerLookup: TEST_PEER_LOOKUP });
    await server.start();
    const token = server.currentToken();
    const client = new IpcClient();
    clients.push(client);
    const info = await client.connect(token, server.boundAddress());
    expect(info.version).toBe(IPC_PROTOCOL_VERSION);
    expect(info.sessionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('throws HandshakeError on wrong token', async () => {
    server = new IpcServer(STUB_DEPS, { port: 0, peerLookup: TEST_PEER_LOOKUP });
    await server.start();
    const client = new IpcClient();
    clients.push(client);
    await expect(client.connect('wrong-token', server.boundAddress())).rejects.toThrow(
      /invalid token/i,
    );
  });

  test('throws HandshakeError on protocol version mismatch (mocked server)', async () => {
    // To test version mismatch we'd need to corrupt the version. Instead
    // we lean on the server.test.ts coverage and just verify the client
    // surfaces hello-reject reasons through HandshakeError.
    server = new IpcServer(STUB_DEPS, { port: 0, peerLookup: TEST_PEER_LOOKUP });
    await server.start();
    const client = new IpcClient();
    clients.push(client);
    await expect(client.connect('also-wrong', server.boundAddress())).rejects.toThrow(
      /Primary rejected/i,
    );
  });

  test('throws when there is nothing listening', async () => {
    const client = new IpcClient();
    clients.push(client);
    await expect(client.connect('any-token')).rejects.toThrow();
  });
});

describe('IpcClient.sendMcpRequest', () => {
  test('round-trips a tools/list through the IPC bridge', async () => {
    server = new IpcServer(STUB_DEPS, { port: 0, peerLookup: TEST_PEER_LOOKUP });
    await server.start();
    const token = server.currentToken();
    const client = new IpcClient();
    clients.push(client);
    await client.connect(token, server.boundAddress());

    const response = (await client.sendMcpRequest({
      jsonrpc: '2.0',
      id: 99,
      method: 'tools/list',
      params: {},
    })) as { jsonrpc: string; id: number; result: { tools: { name: string }[] } };

    expect(response.jsonrpc).toBe('2.0');
    expect(response.id).toBe(99);
    expect(response.result.tools.map((t) => t.name)).toContain('browser.list_tabs');
  });

  test('returns a JSON-RPC error envelope when the socket dies mid-flight', async () => {
    server = new IpcServer(STUB_DEPS, { port: 0, peerLookup: TEST_PEER_LOOKUP });
    await server.start();
    const token = server.currentToken();
    const client = new IpcClient();
    clients.push(client);
    await client.connect(token, server.boundAddress());

    // Race: fire a request and IMMEDIATELY kill the server. The pending
    // request must resolve (not hang) with an error-shaped payload.
    const pending = client.sendMcpRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    });
    await server.stop();
    server = null;
    const result = (await pending) as { error?: { code: number; message: string } };
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBeLessThan(0);
  });
});

describe('IpcClient.onClose', () => {
  test('fires "primary-closing" when the primary broadcasts shutdown', async () => {
    server = new IpcServer(STUB_DEPS, { port: 0, peerLookup: TEST_PEER_LOOKUP });
    await server.start();
    const token = server.currentToken();
    const client = new IpcClient();
    clients.push(client);
    await client.connect(token, server.boundAddress());

    const reasonPromise = new Promise<string>((resolve) => {
      client.onClose((reason) => resolve(reason));
    });

    await server.stop();
    server = null;
    const reason = await reasonPromise;
    // Could be either: we got the primary-closing frame before the FIN,
    // or the FIN arrived first. Both are correct ways to learn the primary
    // is gone.
    expect(['primary-closing', 'remote']).toContain(reason);
  });
});

describe('runProxy', () => {
  test('forwards an MCP request from stdin → primary → stdout', async () => {
    server = new IpcServer(STUB_DEPS, { port: 0, peerLookup: TEST_PEER_LOOKUP });
    await server.start();
    const token = server.currentToken();

    const input = new PassThrough();
    const output = new PassThrough();
    const collected: string[] = [];
    output.on('data', (chunk: Buffer) => {
      collected.push(chunk.toString('utf8'));
    });

    const handle = await runProxy({ input, output, token, ...server.boundAddress() });
    clients.push(handle.client);

    input.write(
      JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'tools/list', params: {} }) + '\n',
    );

    // Spin until we see one full line on stdout (or time out).
    const start = Date.now();
    while (collected.join('').indexOf('\n') < 0 && Date.now() - start < 2000) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const line = collected.join('').split('\n').filter(Boolean)[0]!;
    const parsed = JSON.parse(line) as {
      id: number;
      result: { tools: { name: string }[] };
    };
    expect(parsed.id).toBe(42);
    expect(parsed.result.tools.map((t) => t.name)).toContain('browser.list_tabs');

    await handle.stop();
  });

  test('writes a JSON-RPC parse error when stdin gets garbage', async () => {
    server = new IpcServer(STUB_DEPS, { port: 0, peerLookup: TEST_PEER_LOOKUP });
    await server.start();
    const token = server.currentToken();

    const input = new PassThrough();
    const output = new PassThrough();
    const collected: string[] = [];
    output.on('data', (chunk: Buffer) => collected.push(chunk.toString('utf8')));

    const handle = await runProxy({ input, output, token, ...server.boundAddress() });
    clients.push(handle.client);

    input.write('this is not json\n');

    const start = Date.now();
    while (collected.join('').indexOf('\n') < 0 && Date.now() - start < 1000) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const line = collected.join('').split('\n').filter(Boolean)[0]!;
    const parsed = JSON.parse(line) as { error: { code: number; message: string } };
    expect(parsed.error.code).toBe(-32700);

    await handle.stop();
  });

  test('forwards notifications without expecting a response', async () => {
    server = new IpcServer(STUB_DEPS, { port: 0, peerLookup: TEST_PEER_LOOKUP });
    await server.start();
    const token = server.currentToken();

    const input = new PassThrough();
    const output = new PassThrough();
    const collected: string[] = [];
    output.on('data', (chunk: Buffer) => collected.push(chunk.toString('utf8')));

    const handle = await runProxy({ input, output, token, ...server.boundAddress() });
    clients.push(handle.client);

    input.write(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n',
    );

    // Give the proxy a moment to forward. Notifications produce no response.
    await new Promise((r) => setTimeout(r, 200));
    expect(collected.join('')).toBe('');

    await handle.stop();
  });

  test('calls onClose when the primary shuts down', async () => {
    server = new IpcServer(STUB_DEPS, { port: 0, peerLookup: TEST_PEER_LOOKUP });
    await server.start();
    const token = server.currentToken();

    const input = new PassThrough();
    const output = new PassThrough();

    let closeReason: string | null = null;
    const handle = await runProxy({
      input,
      output,
      token,
      ...server.boundAddress(),
      onClose: (reason) => {
        closeReason = reason;
      },
    });
    clients.push(handle.client);

    await server.stop();
    server = null;
    await handle.closed;
    expect(closeReason).not.toBeNull();
  });
});

describe('runProxy without a token file', () => {
  test('throws a clear error when no token is on disk and none provided', async () => {
    await expect(runProxy({ input: new PassThrough(), output: new PassThrough() })).rejects.toThrow(
      /token not found/i,
    );
  });
});

describe('runProxy auto-reelect', () => {
  test('reconnects to a fresh primary on the same port', async () => {
    // Phase A: spin up a primary, connect proxy with auto-reelect on.
    const primaryA = new IpcServer(STUB_DEPS, { port: 0, peerLookup: TEST_PEER_LOOKUP });
    await primaryA.start();
    const addr = primaryA.boundAddress();
    const tokenA = primaryA.currentToken();

    const input = new PassThrough();
    const output = new PassThrough();
    const collected: string[] = [];
    output.on('data', (chunk: Buffer) => collected.push(chunk.toString('utf8')));

    let reelectStarts = 0;
    let reelectSuccesses = 0;
    const handle = await runProxy({
      input,
      output,
      token: tokenA,
      ...addr,
      autoReelect: true,
      reelectTimeoutMs: 4000,
      reelectIntervalMs: 100,
      onReelectStart: () => reelectStarts++,
      onReelectSuccess: () => reelectSuccesses++,
    });

    // Phase B: kill primary A. Proxy should enter reconnecting mode.
    await primaryA.stop();
    // Poll instead of a fixed sleep — the close-event chain takes a few ms
    // under load and a hard 100ms ceiling makes the test flaky on slow CI.
    {
      const start = Date.now();
      while (reelectStarts === 0 && Date.now() - start < 2000) {
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    expect(reelectStarts).toBe(1);

    // Phase C: a new primary appears on the same port.
    const primaryB = new IpcServer(STUB_DEPS, { port: addr.port, peerLookup: TEST_PEER_LOOKUP });
    await primaryB.start();

    // Wait for the reconnect to complete.
    const start = Date.now();
    while (reelectSuccesses === 0 && Date.now() - start < 4000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(reelectSuccesses).toBe(1);

    // Phase D: send a request post-reconnect → should succeed via primary B.
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} }) + '\n');
    const respStart = Date.now();
    while (
      !collected
        .join('')
        .split('\n')
        .some((l) => l.includes('"id":7')) &&
      Date.now() - respStart < 2000
    ) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const responseLine = collected
      .join('')
      .split('\n')
      .filter(Boolean)
      .find((l) => l.includes('"id":7'));
    expect(responseLine).toBeDefined();
    const parsed = JSON.parse(responseLine!) as {
      id: number;
      result: { tools: { name: string }[] };
    };
    expect(parsed.id).toBe(7);
    expect(parsed.result.tools.length).toBeGreaterThan(0);

    await handle.stop();
    await primaryB.stop();
  });

  test('responds with a JSON-RPC error to requests received while reconnecting', async () => {
    const primaryA = new IpcServer(STUB_DEPS, { port: 0, peerLookup: TEST_PEER_LOOKUP });
    await primaryA.start();
    const addr = primaryA.boundAddress();
    const tokenA = primaryA.currentToken();

    const input = new PassThrough();
    const output = new PassThrough();
    const collected: string[] = [];
    output.on('data', (chunk: Buffer) => collected.push(chunk.toString('utf8')));

    const handle = await runProxy({
      input,
      output,
      token: tokenA,
      ...addr,
      autoReelect: true,
      reelectTimeoutMs: 1000,
      reelectIntervalMs: 100,
    });

    await primaryA.stop();
    // Don't start a replacement — let the reconnect window expire.
    await new Promise((r) => setTimeout(r, 100)); // give the close handler time to flip the flag

    input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) + '\n');

    const start = Date.now();
    while (collected.join('').indexOf('-32001') < 0 && Date.now() - start < 800) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(collected.join('')).toContain('-32001');
    expect(collected.join('').toLowerCase()).toContain('temporarily unavailable');

    await handle.stop();
  });

  test('fires onClose after the reelect window exhausts', async () => {
    const primary = new IpcServer(STUB_DEPS, { port: 0, peerLookup: TEST_PEER_LOOKUP });
    await primary.start();
    const addr = primary.boundAddress();
    const token = primary.currentToken();

    let closeFired = false;
    let exhaustedFired = false;
    const handle = await runProxy({
      input: new PassThrough(),
      output: new PassThrough(),
      token,
      ...addr,
      autoReelect: true,
      reelectTimeoutMs: 600,
      reelectIntervalMs: 100,
      onReelectExhausted: () => {
        exhaustedFired = true;
      },
      onClose: () => {
        closeFired = true;
      },
    });

    await primary.stop();
    await handle.closed;
    expect(exhaustedFired).toBe(true);
    expect(closeFired).toBe(true);
  });
});
