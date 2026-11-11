import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket, type WebSocketServer } from 'ws';
import { PINNED_EXTENSION_ORIGIN } from '../auth/extension-id.js';
import { getAllowedBrowsers } from '../auth/allowlist.js';
import type { PeerLookupRequest, PeerLookupResult } from '../auth/process-identity.js';
import { readConfig, unreadableConfigMessage, type UnreadableConfig } from '../config.js';
import { closeDb } from '../map/db.js';
import { BridgeEventLog } from './events.js';
import {
  HANDSHAKE_CHECK_PATH,
  createHandshakeCheckHandler,
  evaluateHandshake,
} from './handshake.js';
import { startWsBridge } from './ws-bridge.js';

/* S6.2: while config.json is unreadable, no browser connection is accepted
 * on the WebSocket port. The refusal is decided before any process lookup
 * and reuses an existing reason code (the wire protocol is byte-guarded). */

const CHROMIUM = getAllowedBrowsers()[0] ?? 'chrome';
const chromiumPeer = async (): Promise<PeerLookupResult> => ({
  ok: true,
  peer: { pid: 4321, binaryName: CHROMIUM },
});
type Lookup = (a: string, p: number, r?: PeerLookupRequest) => Promise<PeerLookupResult>;

let dataDir: string;
let wss: WebSocketServer | null = null;
const sockets: WebSocket[] = [];

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'browser-link-handshake-config-'));
  process.env.BROWSER_LINK_DATA_DIR = dataDir;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  if (wss) await new Promise<void>((resolve) => wss?.close(() => resolve()));
  wss = null;
  closeDb();
  vi.restoreAllMocks();
  delete process.env.BROWSER_LINK_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

function writeConfig(contents: string): void {
  writeFileSync(join(dataDir, 'config.json'), contents, 'utf8');
}

function problem(): UnreadableConfig {
  const read = readConfig();
  if (read.state !== 'unreadable') throw new Error('config is not unreadable');
  return read;
}

function request(origin: string = PINNED_EXTENSION_ORIGIN): IncomingMessage {
  return {
    method: 'GET',
    url: HANDSHAKE_CHECK_PATH,
    headers: { origin, host: '127.0.0.1:17529' },
    socket: {
      remoteAddress: '127.0.0.1',
      remotePort: 50_123,
      localAddress: '127.0.0.1',
      localPort: 17_529,
    },
  } as unknown as IncomingMessage;
}

async function bridgeUrl(lookup: Lookup): Promise<string> {
  wss = await startWsBridge(new Map(), new Map(), new BridgeEventLog(), {
    port: 0,
    version: '9.9.9',
    lookupPeerProcess: lookup,
  });
  return `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
}

function connect(
  url: string,
  origin: string,
): Promise<{ ws: WebSocket } | { status: number; message: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { origin });
    sockets.push(ws);
    ws.once('open', () => resolve({ ws }));
    ws.once('unexpected-response', (_req, res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, message: body }));
    });
    ws.once('error', reject);
  });
}

describe('evaluateHandshake with an unreadable config.json', () => {
  test('refuses the pinned extension with an existing reason, the message in the log line, and no lookup', async () => {
    writeConfig('{ not json');
    const lookup = vi.fn<Lookup>(chromiumPeer);
    expect(await evaluateHandshake(request(), lookup)).toEqual({
      accepted: false,
      reason: 'process-lookup-failed',
      logLine: `Rejected WS handshake: ${unreadableConfigMessage(problem())}`,
    });
    expect(lookup).not.toHaveBeenCalled();
  });

  test('a valid config still accepts the pinned extension (unchanged)', async () => {
    writeConfig('{}');
    const lookup = vi.fn<Lookup>(chromiumPeer);
    expect(await evaluateHandshake(request(), lookup)).toEqual({ accepted: true });
    expect(lookup).toHaveBeenCalledOnce();
  });
});

describe('the WebSocket port with an unreadable config.json', () => {
  test('a real upgrade from the pinned extension is refused and the server log names the file', async () => {
    writeConfig('[1, 2]');
    const lookup = vi.fn<Lookup>(chromiumPeer);
    const url = await bridgeUrl(lookup);
    expect(await connect(url, PINNED_EXTENSION_ORIGIN)).toEqual({
      status: 500,
      message: 'Process lookup failed',
    });
    expect(lookup).not.toHaveBeenCalled();
    const logged = vi.mocked(console.error).mock.calls.flat().map(String).join('\n');
    expect(logged).toContain(unreadableConfigMessage(problem()));
  });

  test('once the file is fixed, the same bridge accepts again without a restart', async () => {
    writeConfig('{ broken');
    const lookup = vi.fn<Lookup>(chromiumPeer);
    const url = await bridgeUrl(lookup);
    expect('status' in (await connect(url, PINNED_EXTENSION_ORIGIN))).toBe(true);
    writeConfig('{}');
    expect('ws' in (await connect(url, PINNED_EXTENSION_ORIGIN))).toBe(true);
  });
});

describe('GET /handshake-check with an unreadable config.json', () => {
  test('answers the existing refusal reason without any lookup', async () => {
    writeConfig('"just a string"');
    const lookup = vi.fn<Lookup>(chromiumPeer);
    const handler = createHandshakeCheckHandler(lookup);
    const res = { status: 0, body: '', writeHead: vi.fn(), end: vi.fn() };
    res.writeHead.mockImplementation((status: number) => (res.status = status));
    res.end.mockImplementation((body: string) => (res.body = body));
    await handler(request(), res as unknown as ServerResponse);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ accepted: false, reason: 'process-lookup-failed' });
    expect(lookup).not.toHaveBeenCalled();
  });
});
