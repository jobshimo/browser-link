import { afterEach, describe, expect, test } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebSocketServer } from 'ws';
import {
  buildVersionInfo,
  INSTALLED_CLI_PATH,
  readInstalledCodeMtime,
} from './version-endpoint.js';
import { readInstalledVersion, VERSION } from '../version.js';
import { startWsBridge } from '../bridge/ws-bridge.js';
import { BridgeEventLog } from '../bridge/events.js';

/* S5: the bridge's own HTTP server answers GET /version and 404s every other
 * plain request; upgrades still go to the WebSocket server. Bound on port 0. */

const scratch = mkdtempSync(join(tmpdir(), 'bl-version-endpoint-'));
const bridges: WebSocketServer[] = [];

afterEach(async () => {
  await Promise.all(
    bridges.splice(0).map((wss) => new Promise<void>((resolve) => wss.close(() => resolve()))),
  );
});

function get(
  port: number,
  path: string,
  method = 'GET',
): Promise<{ status: number; type: string | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, type: res.headers['content-type'], body }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

async function bridgePort(version?: string): Promise<number> {
  const wss = await startWsBridge(new Map(), new Map(), new BridgeEventLog(), {
    port: 0,
    ...(version ? { version } : {}),
  });
  bridges.push(wss);
  return (wss.address() as AddressInfo).port;
}

describe('GET /version', () => {
  test('200 application/json { name, version, pid, startedAt, installedVersion }', async () => {
    const port = await bridgePort('0.40.0');
    const res = await get(port, '/version');
    expect(res.status).toBe(200);
    expect(res.type).toMatch(/^application\/json/);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      ['installedVersion', 'name', 'pid', 'startedAt', 'version'].sort(),
    );
    expect(body).toMatchObject({
      name: '@jobshimo/browser-link',
      version: '0.40.0',
      pid: process.pid,
      installedVersion: readInstalledVersion(),
    });
  });

  test('defaults to the running VERSION when no version option is given', async () => {
    const port = await bridgePort();
    const body = JSON.parse((await get(port, '/version')).body) as { version: string };
    expect(body.version).toBe(VERSION);
  });

  test('every other plain request is a 404', async () => {
    const port = await bridgePort('0.40.0');
    expect((await get(port, '/')).status).toBe(404);
    expect((await get(port, '/version/x')).status).toBe(404);
    expect((await get(port, '/version', 'POST')).status).toBe(404);
  });
});

describe('buildVersionInfo', () => {
  test('startedAt is an ISO timestamp', () => {
    const info = buildVersionInfo('1.2.3', 42, 0, () => '1.2.4');
    expect(info).toEqual({
      name: '@jobshimo/browser-link',
      version: '1.2.3',
      pid: 42,
      startedAt: '1970-01-01T00:00:00.000Z',
      installedVersion: '1.2.4',
    });
  });
});

describe('readInstalledVersion', () => {
  test('re-reads package.json on every call', () => {
    const pkg = join(scratch, 'package.json');
    writeFileSync(pkg, JSON.stringify({ version: '0.40.0' }));
    expect(readInstalledVersion(pkg)).toBe('0.40.0');
    writeFileSync(pkg, JSON.stringify({ version: '0.41.0' }));
    expect(readInstalledVersion(pkg)).toBe('0.41.0');
  });

  test('null when the file is missing or malformed', () => {
    expect(readInstalledVersion(join(scratch, 'missing.json'))).toBeNull();
    const bad = join(scratch, 'bad.json');
    writeFileSync(bad, '{');
    expect(readInstalledVersion(bad)).toBeNull();
  });
});

describe('installed CLI path', () => {
  test('points at the package dist/cli.js', () => {
    expect(INSTALLED_CLI_PATH.replace(/\\/g, '/')).toMatch(/\/dist\/cli\.js$/);
  });

  test('mtime is null for a missing file', () => {
    expect(readInstalledCodeMtime(join(scratch, 'nope.js'))).toBeNull();
    const f = join(scratch, 'cli.js');
    writeFileSync(f, '');
    expect(typeof readInstalledCodeMtime(f)).toBe('number');
  });
});
