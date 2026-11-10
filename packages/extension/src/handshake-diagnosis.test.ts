// @vitest-environment node
import { afterEach, describe, expect, test } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { diagnoseConnectFailure, HANDSHAKE_CHECK_PATH } from './handshake-diagnosis.js';

/*
 * After a failed WebSocket connect the worker asks the bridge's
 * `GET /handshake-check` why. These tests stand a real HTTP server in for
 * the bridge: a current one that refuses, one that accepts, an older one
 * without the endpoint, none at all, and broken answers.
 */

let server: Server | undefined;

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
});

/** A stub bridge answering `/handshake-check` with `status` and `body`;
 * every other path is a 404, as on a real bridge. Returns the check URL. */
async function stub(status: number, body: string): Promise<string> {
  server = createServer((req, res) => {
    if (req.url === HANDSHAKE_CHECK_PATH) {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${String(port)}${HANDSHAKE_CHECK_PATH}`;
}

describe('diagnoseConnectFailure', () => {
  test.each([
    'origin-not-allowed',
    'peer-unidentified',
    'peer-unknown',
    'peer-owner-unreadable',
    'peer-other-user',
    'peer-not-browser',
    'peer-path-not-allowed',
    'process-lookup-failed',
  ])('a refusal for %s becomes ws-handshake-refused with that reason', async (reason) => {
    const url = await stub(200, JSON.stringify({ accepted: false, reason }));
    expect(await diagnoseConnectFailure(url)).toEqual({
      code: 'ws-handshake-refused',
      values: { reason },
    });
  });

  test('a refusal with a reason this version does not know is still a refusal, reason other', async () => {
    const url = await stub(200, JSON.stringify({ accepted: false, reason: 'from-the-future' }));
    expect(await diagnoseConnectFailure(url)).toEqual({
      code: 'ws-handshake-refused',
      values: { reason: 'other' },
    });
  });

  test('an accepting server means the refusal is not the gate: the generic connect failure', async () => {
    const url = await stub(200, JSON.stringify({ accepted: true }));
    expect(await diagnoseConnectFailure(url)).toEqual({ code: 'ws-connect-failed' });
  });

  test('an older server without the endpoint (404): the generic connect failure, as today', async () => {
    const url = await stub(404, 'Not found');
    expect(await diagnoseConnectFailure(url)).toEqual({ code: 'ws-connect-failed' });
  });

  test('a busy bridge (503 { busy: true }): no diagnosis, the generic connect failure', async () => {
    const url = await stub(503, JSON.stringify({ busy: true }));
    expect(await diagnoseConnectFailure(url)).toEqual({ code: 'ws-connect-failed' });
  });

  test('a plain 403 refusal of the check itself: no diagnosis, the generic connect failure', async () => {
    const url = await stub(403, 'Forbidden');
    expect(await diagnoseConnectFailure(url)).toEqual({ code: 'ws-connect-failed' });
  });

  test('no server listening: the generic connect failure', async () => {
    const url = await stub(200, '{}');
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
    expect(await diagnoseConnectFailure(url)).toEqual({ code: 'ws-connect-failed' });
  });

  test('an answer that is not the expected JSON: the generic connect failure', async () => {
    const url = await stub(200, 'not json');
    expect(await diagnoseConnectFailure(url)).toEqual({ code: 'ws-connect-failed' });
  });

  test('a server that never answers: the generic connect failure once the timeout passes', async () => {
    server = createServer(() => {
      // never answers
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${String(port)}${HANDSHAKE_CHECK_PATH}`;
    const t0 = Date.now();
    expect(await diagnoseConnectFailure(url, 100)).toEqual({ code: 'ws-connect-failed' });
    expect(Date.now() - t0).toBeLessThan(5_000);
    server.closeAllConnections();
  });
});
