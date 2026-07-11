import { afterEach, describe, expect, test } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { CdpClient } from './client.js';

/* Fake CDP-over-WS server: a real ephemeral WebSocketServer (port: 0, same
 * pattern IpcServer's own tests use) that echoes back a JSON-RPC-shaped
 * response for every command it receives, or does whatever the test's
 * `onMessage` callback decides. No real Chrome required. */

let wss: WebSocketServer | null = null;

afterEach(async () => {
  if (wss) {
    await new Promise<void>((resolve) => wss?.close(() => resolve()));
    wss = null;
  }
});

interface FakeFrame {
  id: number;
  method: string;
  params: unknown;
}

function startFakeCdpServer(onMessage: (ws: WebSocket, msg: FakeFrame) => void): Promise<number> {
  return new Promise((resolve) => {
    wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString()) as FakeFrame;
        onMessage(ws, msg);
      });
    });
    wss.on('listening', () => {
      const address = wss?.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });
}

describe('CdpClient', () => {
  test('send() resolves with the matching result', async () => {
    const port = await startFakeCdpServer((ws, msg) => {
      ws.send(JSON.stringify({ id: msg.id, result: { echoed: msg.method } }));
    });
    const client = new CdpClient(`ws://127.0.0.1:${port}`);
    await client.connect();
    const result = await client.send<{ echoed: string }>('Test.method', {});
    expect(result.echoed).toBe('Test.method');
    client.close();
  });

  test('send() rejects with the server error message', async () => {
    const port = await startFakeCdpServer((ws, msg) => {
      ws.send(JSON.stringify({ id: msg.id, error: { message: 'boom' } }));
    });
    const client = new CdpClient(`ws://127.0.0.1:${port}`);
    await client.connect();
    await expect(client.send('Test.method')).rejects.toThrow('boom');
    client.close();
  });

  test('send() times out when no response arrives', async () => {
    const port = await startFakeCdpServer(() => {
      /* never respond */
    });
    const client = new CdpClient(`ws://127.0.0.1:${port}`);
    await client.connect();
    await expect(client.send('Test.method', {}, 50)).rejects.toThrow(/timed out/i);
    client.close();
  });

  test('two concurrent send() calls resolve independently by id', async () => {
    const port = await startFakeCdpServer((ws, msg) => {
      // Reply out of order to prove correlation is by id, not arrival order.
      setTimeout(
        () => ws.send(JSON.stringify({ id: msg.id, result: { method: msg.method } })),
        msg.method === 'First' ? 20 : 0,
      );
    });
    const client = new CdpClient(`ws://127.0.0.1:${port}`);
    await client.connect();
    const [first, second] = await Promise.all([
      client.send<{ method: string }>('First'),
      client.send<{ method: string }>('Second'),
    ]);
    expect(first.method).toBe('First');
    expect(second.method).toBe('Second');
    client.close();
  });

  test('on() delivers a matching CDP event by method name', async () => {
    const port = await startFakeCdpServer((ws, msg) => {
      ws.send(JSON.stringify({ method: 'Page.loadEventFired', params: { timestamp: 1 } }));
      ws.send(JSON.stringify({ id: msg.id, result: {} }));
    });
    const client = new CdpClient(`ws://127.0.0.1:${port}`);
    await client.connect();
    const eventParams = await new Promise((resolve) => {
      client.on('Page.loadEventFired', resolve);
      // Trigger the fake server to push the event (any outbound frame works).
      void client.send('Trigger');
    });
    expect(eventParams).toEqual({ timestamp: 1 });
    client.close();
  });

  test('unsubscribe stops further delivery', async () => {
    const port = await startFakeCdpServer((ws, msg) => {
      ws.send(JSON.stringify({ method: 'Custom.event', params: { n: 1 } }));
      ws.send(JSON.stringify({ id: msg.id, result: {} }));
    });
    const client = new CdpClient(`ws://127.0.0.1:${port}`);
    await client.connect();
    let calls = 0;
    const off = client.on('Custom.event', () => {
      calls++;
    });
    off();
    await client.send('Trigger');
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(0);
    client.close();
  });

  test('isOpen is false before connect and immediately after close()', async () => {
    const port = await startFakeCdpServer((ws, msg) => {
      ws.send(JSON.stringify({ id: msg.id, result: {} }));
    });
    const client = new CdpClient(`ws://127.0.0.1:${port}`);
    expect(client.isOpen).toBe(false);
    await client.connect();
    expect(client.isOpen).toBe(true);
    client.close();
    expect(client.isOpen).toBe(false);
  });

  test('connect() rejects when nothing is listening', async () => {
    const client = new CdpClient('ws://127.0.0.1:1', { connectTimeoutMs: 500 });
    await expect(client.connect()).rejects.toThrow();
  });

  test('send() rejects immediately when never connected', async () => {
    const client = new CdpClient('ws://127.0.0.1:1');
    await expect(client.send('Test.method')).rejects.toThrow(/not connected/i);
  });

  test('pending commands reject when the server closes the connection', async () => {
    const port = await startFakeCdpServer(() => {
      /* never respond — the server closes the socket from its side instead */
    });
    const client = new CdpClient(`ws://127.0.0.1:${port}`);
    await client.connect();
    const pending = client.send('Test.method', {}, 5_000);
    for (const serverSideWs of wss?.clients ?? []) serverSideWs.close();
    await expect(pending).rejects.toThrow(/closed/i);
  });
});
