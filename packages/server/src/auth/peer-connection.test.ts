import { describe, expect, test, vi } from 'vitest';
import { lookupConnectionPeer, normaliseLoopback } from './peer-connection.js';
import { PeerLookupLimiter } from './peer-lookup-limiter.js';
import type { PeerLookupRequest, PeerLookupResult } from './process-identity.js';

const ACCEPTED: PeerLookupResult = { ok: true, peer: { pid: 4321, binaryName: 'node.exe' } };

describe('normaliseLoopback', () => {
  test.each([
    ['::1', '127.0.0.1'],
    ['::ffff:127.0.0.1', '127.0.0.1'],
    ['::ffff:10.0.0.5', '10.0.0.5'],
    ['127.0.0.1', '127.0.0.1'],
    ['', ''],
  ])('%s → %s', (input, expected) => {
    expect(normaliseLoopback(input)).toBe(expected);
  });
});

describe('lookupConnectionPeer', () => {
  const socket = {
    remoteAddress: '::ffff:127.0.0.1',
    remotePort: 50_123,
    localAddress: '::ffff:127.0.0.1',
    localPort: 17_530,
  };

  test('a socket that exposes no remote end is unidentified and costs no lookup', async () => {
    const lookup = vi.fn(async () => ACCEPTED);
    expect(await lookupConnectionPeer({ remotePort: 1 }, lookup)).toEqual({ identified: false });
    expect(await lookupConnectionPeer({ remoteAddress: '127.0.0.1' }, lookup)).toEqual({
      identified: false,
    });
    expect(lookup).not.toHaveBeenCalled();
  });

  test('asks for the normalised remote end, scoped to the server end, within the limiter budget', async () => {
    const lookup = vi.fn(
      async (_h: string, _p: number, _r: PeerLookupRequest): Promise<PeerLookupResult> => ACCEPTED,
    );
    const limiter = new PeerLookupLimiter({ maxInFlight: 1, maxWaitMs: 10, deadlineMs: 1234 });
    const found = await lookupConnectionPeer(socket, lookup, { withExecutablePath: true }, limiter);
    expect(found).toEqual({
      identified: true,
      remote: { host: '127.0.0.1', port: 50_123 },
      result: ACCEPTED,
    });
    expect(lookup).toHaveBeenCalledWith('127.0.0.1', 50_123, {
      withExecutablePath: true,
      serverEndpoint: { host: '127.0.0.1', port: 17_530 },
      totalTimeoutMs: 1234,
    });
  });

  test('without a local end the request carries no server endpoint', async () => {
    const lookup = vi.fn(
      async (_h: string, _p: number, _r: PeerLookupRequest): Promise<PeerLookupResult> => ACCEPTED,
    );
    await lookupConnectionPeer({ remoteAddress: '127.0.0.1', remotePort: 9 }, lookup);
    expect(lookup.mock.calls[0]?.[2]).not.toHaveProperty('serverEndpoint');
  });

  test('a limiter refusal is the result, and the lookup is not run', async () => {
    const limiter = new PeerLookupLimiter({ maxInFlight: 1, maxWaitMs: 0, deadlineMs: 10_000 });
    let releaseFirst!: () => void;
    const first = lookupConnectionPeer(
      socket,
      () =>
        new Promise<PeerLookupResult>((resolve) => {
          releaseFirst = () => resolve(ACCEPTED);
        }),
      {},
      limiter,
    );
    const second = vi.fn(async () => ACCEPTED);
    const refused = await lookupConnectionPeer(socket, second, {}, limiter);
    expect(refused).toMatchObject({
      identified: true,
      result: { ok: false, cause: 'lookup-busy' },
    });
    expect(second).not.toHaveBeenCalled();
    releaseFirst();
    await first;
  });
});
