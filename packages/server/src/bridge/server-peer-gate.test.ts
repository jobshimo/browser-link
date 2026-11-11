import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, type Socket } from 'node:net';
import * as paths from '../map/paths.js';
import { PeerLookupLimiter } from '../auth/peer-lookup-limiter.js';
import type { PeerLookupRequest, PeerLookupResult, PeerProcess } from '../auth/process-identity.js';
import { IPC_PROTOCOL_VERSION, encodeFrame, parseFrame } from './protocol.js';
import { IpcServer, type IpcServerOptions } from './server.js';
import type { DispatchDeps } from './dispatch.js';

/* The IPC port's peer check (S5.2, S5.4): the same detailed lookup and
 * limiter as the WebSocket gate, a log line that names the real cause, and
 * what stays IPC-only (Node-family binaries, no strict mode by path). */

const STUB_DEPS: DispatchDeps = {
  browserTools: {
    listTabs: () => [],
    callBrowserTool: () => Promise.reject(new Error('not used in this test')),
  },
  disabledTools: () => [],
};

let dataDir: string;
let server: IpcServer | null = null;
const sockets: Socket[] = [];
let logged: string[];

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'browser-link-ipc-gate-'));
  vi.spyOn(paths, 'getDataDir').mockReturnValue(dataDir);
  logged = [];
  vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
    logged.push(String(line));
  });
});

afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  if (server) await server.stop();
  server = null;
  vi.restoreAllMocks();
  rmSync(dataDir, { recursive: true, force: true });
});

async function start(options: IpcServerOptions): Promise<IpcServer> {
  server = new IpcServer(STUB_DEPS, { port: 0, ...options });
  await server.start();
  return server;
}

/** Connect, send a valid hello, and resolve with the first frame kind, or
 * `closed` when the server drops the connection without one. */
function helloOutcome(s: IpcServer): Promise<string> {
  return new Promise((resolve, reject) => {
    const { host, port } = s.boundAddress();
    const socket = connect({ host, port }, () => {
      socket.write(
        encodeFrame({ kind: 'hello', version: IPC_PROTOCOL_VERSION, token: s.currentToken() }),
      );
    });
    sockets.push(socket);
    let buffer = '';
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const nl = buffer.indexOf('\n');
      if (nl >= 0) resolve(parseFrame(buffer.slice(0, nl))?.kind ?? 'invalid');
    });
    socket.on('close', () => resolve('closed'));
    socket.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ECONNRESET') resolve('closed');
      else reject(err);
    });
  });
}

const rejections = (): string[] =>
  logged.filter((l) => l.startsWith('[browser-link ipc] Rejected IPC connection'));

const NODE: PeerProcess = { pid: process.pid, binaryName: 'node' };
type Lookup = NonNullable<IpcServerOptions['peerLookup']>;

describe('IPC refusal log lines name the real cause', () => {
  test.each<[string, PeerLookupResult, string]>([
    [
      'lookup timeout',
      { ok: false, cause: 'timeout' },
      'could not identify owning process (cause: timeout).',
    ],
    [
      'owner mismatch',
      { ok: false, cause: 'owner-mismatch' },
      'the owning process runs as another OS user (cause: owner-mismatch).',
    ],
    [
      'owner unreadable',
      { ok: false, cause: 'owner-unreadable' },
      'the owner of the owning process could not be read (cause: owner-unreadable).',
    ],
    [
      'endpoint not listed',
      {
        ok: false,
        cause: 'endpoint-not-listed',
        detail: '6 netstat snapshots, 0 rows for the local port in the last',
      },
      'could not identify owning process (cause: endpoint-not-listed; 6 netstat snapshots, 0 rows for the local port in the last).',
    ],
    [
      'output too large',
      { ok: false, cause: 'output-too-large' },
      'could not identify owning process (cause: output-too-large).',
    ],
  ])('%s', async (_label, result, tail) => {
    const s = await start({ peerLookup: async () => result });
    expect(await helloOutcome(s)).toBe('closed');
    expect(rejections()).toHaveLength(1);
    expect(rejections()[0]).toMatch(
      /^\[browser-link ipc\] Rejected IPC connection from 127\.0\.0\.1:\d+: /,
    );
    expect(rejections()[0]?.endsWith(`: ${tail}`)).toBe(true);
    expect(rejections()[0]).not.toContain('(unknown)');
  });

  test('a binary not in the Node list keeps its line', async () => {
    const s = await start({
      peerLookup: async () => ({ ok: true, peer: { pid: 4321, binaryName: 'chrome.exe' } }),
    });
    expect(await helloOutcome(s)).toBe('closed');
    expect(rejections()[0]).toMatch(
      /^\[browser-link ipc\] Rejected IPC connection from 127\.0\.0\.1:\d+: not a known Node process \(chrome\.exe\)\.$/,
    );
  });

  test('a lookup that throws refuses with the failure in the log', async () => {
    const s = await start({
      peerLookup: () => Promise.reject(new Error('lookup\nexploded')),
    });
    expect(await helloOutcome(s)).toBe('closed');
    expect(rejections()[0]).toMatch(
      /^\[browser-link ipc\] Rejected IPC connection from 127\.0\.0\.1:\d+: process lookup failed \(lookup exploded\)\.$/,
    );
  });
});

describe('what the IPC port shares with the WebSocket gate, and what it keeps', () => {
  test('a valid Node peer is accepted, whether the lookup answers a result or a bare peer', async () => {
    const detailed = await start({ peerLookup: async () => ({ ok: true, peer: NODE }) });
    expect(await helloOutcome(detailed)).toBe('hello-ack');
    await detailed.stop();
    const bare = await start({ peerLookup: async () => NODE });
    expect(await helloOutcome(bare)).toBe('hello-ack');
    expect(rejections()).toEqual([]);
  });

  test('the lookup is scoped to the IPC end, bounded by the limiter deadline, and never asks for a path', async () => {
    const lookup = vi.fn<Lookup>(async (_h: string, _p: number, _r: PeerLookupRequest) => NODE);
    const limiter = new PeerLookupLimiter({ maxInFlight: 1, maxWaitMs: 1000, deadlineMs: 2345 });
    const s = await start({ peerLookup: lookup, peerLookupLimiter: limiter });
    expect(await helloOutcome(s)).toBe('hello-ack');
    const [host, , req] = lookup.mock.calls[0] ?? [];
    expect(host).toBe('127.0.0.1');
    expect(req).toEqual({
      serverEndpoint: { host: '127.0.0.1', port: s.boundAddress().port },
      totalTimeoutMs: 2345,
    });
  });

  test('a connection that gets no lookup slot is refused and the log says why', async () => {
    const limiter = new PeerLookupLimiter({ maxInFlight: 1, maxWaitMs: 0, deadlineMs: 60_000 });
    void limiter.run(() => new Promise<PeerLookupResult>(() => undefined));
    const lookup = vi.fn<Lookup>(async () => NODE);
    const s = await start({ peerLookup: lookup, peerLookupLimiter: limiter });
    expect(await helloOutcome(s)).toBe('closed');
    expect(lookup).not.toHaveBeenCalled();
    expect(rejections()[0]).toMatch(
      /: could not identify owning process \(cause: lookup-busy; 1 lookup in flight, no slot free within 0 ms\)\.$/,
    );
  });
});
