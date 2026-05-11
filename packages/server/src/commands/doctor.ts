import { existsSync, statSync } from 'node:fs';
import { createConnection } from 'node:net';
import { INSTALLERS } from '../installers/index.js';
import { getDbPath } from '../map/paths.js';
import { listApps } from '../map/queries.js';
import { resolveExtensionPath } from './extension.js';

const WS_HOST = '127.0.0.1';
const WS_PORT = 17529;

interface PortStatus {
  listening: boolean;
  detail: string;
}

function checkPort(host: string, port: number, timeoutMs = 500): Promise<PortStatus> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const settle = (listening: boolean, detail: string) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve({ listening, detail });
    };
    const timer = setTimeout(() => settle(false, `no response within ${timeoutMs}ms`), timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      settle(true, `something is listening on ${host}:${port}`);
    });
    socket.once('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (err.code === 'ECONNREFUSED') settle(false, 'no MCP server running');
      else settle(false, err.message);
    });
  });
}

export interface DoctorReport {
  ws: { listening: boolean; detail: string; host: string; port: number };
  clients: { id: string; displayName: string; installed: boolean; registered: boolean; configPath: string }[];
  extension: { path: string | null };
  map: { dbPath: string; exists: boolean; sizeBytes: number; apps: number };
}

export async function runDoctor(): Promise<DoctorReport> {
  const ws = await checkPort(WS_HOST, WS_PORT);

  const clients = INSTALLERS.map((i) => {
    const d = i.detect();
    return { id: i.id, displayName: i.displayName, ...d };
  });

  const extPath = resolveExtensionPath();
  const dbPath = getDbPath();
  const dbExists = existsSync(dbPath);
  const sizeBytes = dbExists ? statSync(dbPath).size : 0;
  let apps = 0;
  if (dbExists) {
    try {
      apps = listApps().length;
    } catch {
      apps = -1;
    }
  }

  return {
    ws: { ...ws, host: WS_HOST, port: WS_PORT },
    clients,
    extension: { path: extPath },
    map: { dbPath, exists: dbExists, sizeBytes, apps },
  };
}

function symbol(ok: boolean): string {
  return ok ? '✓' : '✗';
}

export function formatDoctor(r: DoctorReport): string {
  const lines: string[] = [];
  lines.push('browser-link doctor');
  lines.push('');
  lines.push(`WebSocket bridge  ${symbol(r.ws.listening)} ${r.ws.host}:${r.ws.port} — ${r.ws.detail}`);
  if (!r.ws.listening) {
    lines.push('                   (the server is launched by your MCP client; open Claude Code / OpenCode to start it)');
  }
  lines.push('');
  lines.push('MCP clients:');
  for (const c of r.clients) {
    const status = !c.installed
      ? '✗ not installed'
      : c.registered
        ? '✓ registered'
        : '⚠ installed but not registered';
    lines.push(`  ${c.displayName.padEnd(14)} ${status}`);
    lines.push(`  ${' '.repeat(14)} config: ${c.configPath}`);
  }
  lines.push('');
  lines.push('Chrome extension assets:');
  if (r.extension.path) {
    lines.push(`  ${symbol(true)} ${r.extension.path}`);
  } else {
    lines.push(`  ${symbol(false)} not found (run \`browser-link extension\` for guidance)`);
  }
  lines.push('');
  lines.push('Map DB:');
  lines.push(`  path: ${r.map.dbPath}`);
  if (!r.map.exists) {
    lines.push('  (not created yet — will be initialized on first run)');
  } else {
    lines.push(`  size: ${r.map.sizeBytes} bytes`);
    lines.push(`  apps tracked: ${r.map.apps}`);
  }
  return lines.join('\n');
}
