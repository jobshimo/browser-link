import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { getAllowedBrowsers } from '../auth/allowlist.js';
import { PINNED_EXTENSION_ORIGIN } from '../auth/extension-id.js';
import {
  PEER_LOOKUP_MAX_IN_FLIGHT,
  PeerLookupLimiter,
  sharedPeerLookupLimiter,
} from '../auth/peer-lookup-limiter.js';
import type { PeerLookupRequest, PeerLookupResult } from '../auth/process-identity.js';
import { MAX_CONCURRENT_HANDSHAKE_CHECKS, evaluateHandshake } from './handshake.js';

/* The gate through the shared peer-lookup limiter (S5.4). The reason codes
 * and log lines of every other refusal are pinned in ws-bridge.test.ts. */

// The allowlist is per operating system, so the fixture takes its name from it.
const CHROMIUM: PeerLookupResult = {
  ok: true,
  peer: { pid: 4321, binaryName: getAllowedBrowsers()[0] ?? 'chrome' },
};

function request(origin: string | undefined = PINNED_EXTENSION_ORIGIN): IncomingMessage {
  return {
    headers: origin === undefined ? {} : { origin },
    socket: {
      remoteAddress: '::ffff:127.0.0.1',
      remotePort: 50_123,
      localAddress: '127.0.0.1',
      localPort: 17_529,
    },
  } as unknown as IncomingMessage;
}

type Lookup = (a: string, p: number, r: PeerLookupRequest) => Promise<PeerLookupResult>;

/** A limiter whose only slot is taken by a lookup that never ends. */
function fullLimiter(): PeerLookupLimiter {
  const limiter = new PeerLookupLimiter({ maxInFlight: 1, maxWaitMs: 1000, deadlineMs: 60_000 });
  void limiter.run(() => new Promise<PeerLookupResult>(() => undefined));
  return limiter;
}

describe('evaluateHandshake through the peer-lookup limiter', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'browser-link-handshake-limiter-'));
    process.env.BROWSER_LINK_DATA_DIR = dataDir;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.BROWSER_LINK_DATA_DIR;
    rmSync(dataDir, { recursive: true, force: true });
  });

  test('an upgrade that gets no lookup slot in time is refused, and the log says why', async () => {
    const lookup = vi.fn<Lookup>(async () => CHROMIUM);
    const verdict = evaluateHandshake(request(), lookup, fullLimiter());
    await vi.advanceTimersByTimeAsync(1000);
    expect(await verdict).toEqual({
      accepted: false,
      reason: 'peer-unknown',
      logLine:
        'Rejected WS handshake from 127.0.0.1:50123: could not identify owning process (cause: lookup-busy; 1 lookup in flight, no slot free within 1000 ms).',
    });
    expect(lookup).not.toHaveBeenCalled();
  });

  test('a lookup still running at the total deadline is refused as deadline', async () => {
    const limiter = new PeerLookupLimiter({ maxInFlight: 1, maxWaitMs: 1000, deadlineMs: 3000 });
    const lookup = vi.fn<Lookup>(() => new Promise<PeerLookupResult>(() => undefined));
    const verdict = evaluateHandshake(request(), lookup, limiter);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await verdict).toMatchObject({
      accepted: false,
      reason: 'peer-unknown',
      logLine: expect.stringContaining('(cause: deadline; total budget 3000 ms)') as string,
    });
  });

  test('the lookup is handed the total deadline as its budget', async () => {
    const limiter = new PeerLookupLimiter({ maxInFlight: 1, maxWaitMs: 1000, deadlineMs: 4321 });
    const lookup = vi.fn<Lookup>(async () => CHROMIUM);
    expect(await evaluateHandshake(request(), lookup, limiter)).toEqual({ accepted: true });
    expect(lookup).toHaveBeenCalledWith('127.0.0.1', 50_123, {
      withExecutablePath: false,
      serverEndpoint: { host: '127.0.0.1', port: 17_529 },
      totalTimeoutMs: 4321,
    });
  });

  test('a refused Origin costs no lookup and is decided even when no slot is free', async () => {
    const lookup = vi.fn<Lookup>(async () => CHROMIUM);
    const limiter = fullLimiter();
    const verdict = await evaluateHandshake(request('https://evil.example'), lookup, limiter);
    expect(verdict).toMatchObject({ accepted: false, reason: 'origin-not-allowed' });
    expect(lookup).not.toHaveBeenCalled();
    expect(limiter.inFlightCount()).toBe(1);
  });

  test('a valid browser peer is still accepted through the shared limiter by default', async () => {
    const lookup = vi.fn<Lookup>(async () => CHROMIUM);
    expect(await evaluateHandshake(request(), lookup)).toEqual({ accepted: true });
    expect(lookup.mock.calls[0]?.[2].totalTimeoutMs).toBe(
      sharedPeerLookupLimiter.limits.deadlineMs,
    );
    expect(sharedPeerLookupLimiter.inFlightCount()).toBe(0);
  });

  test('the diagnostic cap stays below the shared limiter, so diagnostics never take every slot', () => {
    expect(MAX_CONCURRENT_HANDSHAKE_CHECKS).toBe(2);
    expect(PEER_LOOKUP_MAX_IN_FLIGHT).toBeGreaterThan(MAX_CONCURRENT_HANDSHAKE_CHECKS);
  });
});
