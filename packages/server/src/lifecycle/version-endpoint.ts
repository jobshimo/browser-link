import { statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACKAGE_NAME, readInstalledVersion } from '../version.js';
import type { VersionInfo } from './election.js';

/**
 * `GET /version` on the bridge port (S5). The election (`election.ts`),
 * `doctor` and anything else that needs to know "which browser-link is the
 * primary, and is it outdated?" read it. Every other plain HTTP request is a
 * 404; WebSocket upgrades never reach this handler.
 */

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The installed CLI entry point: `<package>/dist/cli.js`. This module lives
 * in `dist/lifecycle/` (installed) or `src/lifecycle/` (dev), two levels
 * below the package root either way. After `npm install -g` this is the
 * same path the running process started from, now holding the new code.
 */
export const INSTALLED_CLI_PATH: string = join(here, '..', '..', 'dist', 'cli.js');

/** Last-modified time of the installed CLI (epoch ms), or `null`. */
export function readInstalledCodeMtime(path: string = INSTALLED_CLI_PATH): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/** Approximate wall-clock start of this process, epoch ms. */
export const PROCESS_STARTED_AT: number = Date.now() - Math.round(process.uptime() * 1000);

export function buildVersionInfo(
  version: string,
  pid: number = process.pid,
  startedAt: number = PROCESS_STARTED_AT,
  installed: () => string | null = readInstalledVersion,
): VersionInfo {
  return {
    name: PACKAGE_NAME,
    version,
    pid,
    startedAt: new Date(startedAt).toISOString(),
    installedVersion: installed(),
  };
}

/** The bridge's plain-HTTP handler: `/version` or 404. */
export function handleBridgeHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  version: string,
): void {
  const path = (req.url ?? '').split('?')[0];
  if (req.method === 'GET' && path === '/version') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(buildVersionInfo(version)));
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('Not found');
}
