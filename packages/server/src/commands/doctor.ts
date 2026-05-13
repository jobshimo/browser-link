import { existsSync, statSync } from 'node:fs';
import { createConnection } from 'node:net';
import { INSTALLERS } from '../installers/index.js';
import { getAllowedBrowsers } from '../auth/allowlist.js';
import { getDbPath } from '../map/paths.js';
import { listApps } from '../map/queries.js';
import { resolveExtensionPath } from './extension.js';
import type { Language } from './welcome.js';
import { loadConfig } from '../config.js';
import { IPC_HOST, IPC_PORT } from '../bridge/protocol.js';
import { getInstructionsInstaller, type InstructionsState } from '../agent-instructions/index.js';

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
    const timer = setTimeout(() => {
      settle(false, `no response within ${timeoutMs}ms`);
    }, timeoutMs);
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
  ipc: { listening: boolean; detail: string; host: string; port: number };
  multiAgent: { enabled: boolean; autoReelect: boolean };
  clients: {
    id: string;
    displayName: string;
    installed: boolean;
    registered: boolean;
    configPath: string;
    instructions: { state: InstructionsState; filePath: string };
  }[];
  extension: { path: string | null };
  map: { dbPath: string; exists: boolean; sizeBytes: number; apps: number };
  security: { allowedBrowsers: readonly string[] };
}

export async function runDoctor(): Promise<DoctorReport> {
  const ws = await checkPort(WS_HOST, WS_PORT);
  const ipc = await checkPort(IPC_HOST, IPC_PORT);

  const clients = INSTALLERS.map((i) => {
    const d = i.detect();
    const instructions = getInstructionsInstaller(i.id).detect();
    return {
      id: i.id,
      displayName: i.displayName,
      ...d,
      instructions: { state: instructions.state, filePath: instructions.filePath },
    };
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
  const cfg = loadConfig();

  return {
    ws: { ...ws, host: WS_HOST, port: WS_PORT },
    ipc: { ...ipc, host: IPC_HOST, port: IPC_PORT },
    multiAgent: { enabled: cfg.multiAgent === true, autoReelect: cfg.autoReelect === true },
    clients,
    extension: { path: extPath },
    map: { dbPath, exists: dbExists, sizeBytes, apps },
    security: { allowedBrowsers: getAllowedBrowsers() },
  };
}

function symbol(ok: boolean): string {
  return ok ? '✓' : '✗';
}

/** Wrap `text` in the ANSI red SGR sequence so terminals (and Ink, which
 * passes ANSI codes through) render it red. We intentionally avoid pulling
 * a colour library into the doctor formatter — one escape pair is cheaper
 * than a dependency. The reset ([39m) only restores the default
 * foreground colour so the rest of the line keeps its surrounding style.
 *
 * Escalating outdated agent-instructions blocks to red was the v0.8.3 ask:
 * yellow was being ignored. Red + a follow-up subline makes the state
 * impossible to miss. */
const RED = '[31m';
const RED_RESET = '[39m';

function red(text: string): string {
  return `${RED}${text}${RED_RESET}`;
}

interface DoctorI18n {
  title: string;
  wsBridge: string;
  wsHint: string;
  clientsHeader: string;
  clientNotInstalled: string;
  clientRegistered: string;
  clientNotRegistered: string;
  clientConfig: string;
  clientInstructions: string;
  instructionsInstalled: (version: string | null) => string;
  instructionsOutdated: (version: string | null) => string;
  /** Subline shown directly below an outdated client — names the
   * installed version (or "legacy" for the unversioned case) and tells
   * the user a refresh is recommended. Surfaced in red along with the
   * status label so the outdated state is impossible to miss. */
  instructionsOutdatedSubline: (version: string | null) => string;
  instructionsNotInstalled: string;
  instructionsNoFile: string;
  instructionsCorrupt: string;
  extensionHeader: string;
  extensionNotFound: string;
  mapHeader: string;
  mapPath: string;
  mapNotCreated: string;
  mapSize: string;
  mapApps: string;
  processBinding: string;
  processBindingNone: string;
  processBindingOk: (n: number) => string;
  multiAgentHeader: string;
  multiAgentMode: string;
  autoReelect: string;
  on: string;
  off: string;
  ipcLine: string;
  ipcListening: string;
  ipcFree: string;
}

const DOCTOR_I18N: Record<Language, DoctorI18n> = {
  en: {
    title: 'browser-link doctor',
    wsBridge: 'WebSocket bridge',
    wsHint:
      '                   (the server is launched by your MCP client; open Claude Code / OpenCode / Copilot CLI to start it)',
    clientsHeader: 'MCP clients:',
    clientNotInstalled: '✗ not installed',
    clientRegistered: '✓ registered',
    clientNotRegistered: '⚠ installed but not registered',
    clientConfig: 'config:',
    clientInstructions: 'instructions:',
    instructionsInstalled: (v) => (v === null ? `✓ installed (legacy)` : `✓ installed (v${v})`),
    instructionsOutdated: (v) => (v === null ? `⚠ outdated (legacy)` : `⚠ outdated (v${v})`),
    instructionsOutdatedSubline: (v) =>
      v === null
        ? 'outdated since legacy — refresh recommended.'
        : `outdated since v${v} — refresh recommended.`,
    instructionsNotInstalled: '· not installed',
    instructionsNoFile: '· file not present',
    instructionsCorrupt: '⚠ multiple blocks — resolve manually',
    extensionHeader: 'Chrome extension assets:',
    extensionNotFound: 'not found (run `browser-link extension` for guidance)',
    mapHeader: 'Map DB:',
    mapPath: 'path:',
    mapNotCreated: '  (not created yet — will be initialized on first run)',
    mapSize: 'size:',
    mapApps: 'apps tracked:',
    processBinding: 'Process binding:',
    processBindingNone: '  ✗ no allowlist for this OS — incoming WS connections will be rejected.',
    processBindingOk: (n) => `  ✓ accepts WS connections from ${n} known browser binaries.`,
    multiAgentHeader: 'Multi-agent:',
    multiAgentMode: '  Mode             ',
    autoReelect: '  Auto-reelect     ',
    on: 'on',
    off: 'off',
    ipcLine: '  IPC port         ',
    ipcListening: 'listening (a primary is running)',
    ipcFree: 'free (no primary on this machine)',
  },
  es: {
    title: 'browser-link doctor',
    wsBridge: 'Puente WebSocket',
    wsHint:
      '                   (lo arranca tu cliente MCP; abrí Claude Code / OpenCode / Copilot CLI para iniciarlo)',
    clientsHeader: 'Clientes MCP:',
    clientNotInstalled: '✗ no instalado',
    clientRegistered: '✓ registrado',
    clientNotRegistered: '⚠ instalado pero no registrado',
    clientConfig: 'config:',
    clientInstructions: 'instrucciones:',
    instructionsInstalled: (v) => (v === null ? `✓ instaladas (legacy)` : `✓ instaladas (v${v})`),
    instructionsOutdated: (v) =>
      v === null ? `⚠ desactualizadas (legacy)` : `⚠ desactualizadas (v${v})`,
    instructionsOutdatedSubline: (v) =>
      v === null
        ? 'desactualizadas desde legacy — se recomienda refrescar.'
        : `desactualizadas desde v${v} — se recomienda refrescar.`,
    instructionsNotInstalled: '· no instaladas',
    instructionsNoFile: '· sin archivo',
    instructionsCorrupt: '⚠ múltiples bloques — resolvé a mano',
    extensionHeader: 'Assets de la extensión de Chrome:',
    extensionNotFound: 'no encontrada (corré `browser-link extension` para la guía)',
    mapHeader: 'Base de datos del mapa:',
    mapPath: 'ruta:',
    mapNotCreated: '  (todavía no se creó — se inicializa en el primer arranque)',
    mapSize: 'tamaño:',
    mapApps: 'apps registradas:',
    processBinding: 'Validación por proceso:',
    processBindingNone: '  ✗ sin allowlist para este SO — las conexiones WS entrantes se rechazan.',
    processBindingOk: (n) => `  ✓ acepta conexiones WS desde ${n} binarios de navegador conocidos.`,
    multiAgentHeader: 'Multi-agente:',
    multiAgentMode: '  Modo             ',
    autoReelect: '  Re-elección auto ',
    on: 'activado',
    off: 'desactivado',
    ipcLine: '  Puerto IPC       ',
    ipcListening: 'escuchando (hay un primary corriendo)',
    ipcFree: 'libre (no hay primary en esta máquina)',
  },
};

export function formatDoctor(r: DoctorReport, language: Language = 'en'): string {
  const t = DOCTOR_I18N[language];
  const lines: string[] = [];
  lines.push(t.title);
  lines.push('');
  lines.push(`${t.wsBridge}  ${symbol(r.ws.listening)} ${r.ws.host}:${r.ws.port} — ${r.ws.detail}`);
  if (!r.ws.listening) {
    lines.push(t.wsHint);
  }
  lines.push('');
  lines.push(t.clientsHeader);
  for (const c of r.clients) {
    const status = !c.installed
      ? t.clientNotInstalled
      : c.registered
        ? t.clientRegistered
        : t.clientNotRegistered;
    lines.push(`  ${c.displayName.padEnd(20)} ${status}`);
    lines.push(`  ${' '.repeat(20)} ${t.clientConfig} ${c.configPath}`);
    const instr = c.instructions.state;
    let instrLabel: string;
    let outdatedSubline: string | null = null;
    switch (instr.kind) {
      case 'installed':
        instrLabel = t.instructionsInstalled(instr.version);
        break;
      case 'installed-outdated':
        // v0.8.3: escalate outdated from yellow to red, and add an
        // explanatory subline. Yellow blended in with the "not registered"
        // warning and users were ignoring it.
        instrLabel = red(t.instructionsOutdated(instr.version));
        outdatedSubline = red(t.instructionsOutdatedSubline(instr.version));
        break;
      case 'not-installed':
        instrLabel = t.instructionsNotInstalled;
        break;
      case 'no-file':
        instrLabel = t.instructionsNoFile;
        break;
      case 'corrupt':
        instrLabel = t.instructionsCorrupt;
        break;
    }
    lines.push(
      `  ${' '.repeat(20)} ${t.clientInstructions} ${instrLabel} (${c.instructions.filePath})`,
    );
    if (outdatedSubline !== null) {
      // Indent so the subline aligns under the instructions: label.
      lines.push(
        `  ${' '.repeat(20)} ${' '.repeat(t.clientInstructions.length)} ${outdatedSubline}`,
      );
    }
  }
  lines.push('');
  lines.push(t.extensionHeader);
  if (r.extension.path) {
    lines.push(`  ${symbol(true)} ${r.extension.path}`);
  } else {
    lines.push(`  ${symbol(false)} ${t.extensionNotFound}`);
  }
  lines.push('');
  lines.push(t.mapHeader);
  lines.push(`  ${t.mapPath} ${r.map.dbPath}`);
  if (!r.map.exists) {
    lines.push(t.mapNotCreated);
  } else {
    lines.push(`  ${t.mapSize} ${r.map.sizeBytes} bytes`);
    lines.push(`  ${t.mapApps} ${r.map.apps}`);
  }
  lines.push('');
  lines.push(t.processBinding);
  if (r.security.allowedBrowsers.length === 0) {
    lines.push(t.processBindingNone);
  } else {
    lines.push(t.processBindingOk(r.security.allowedBrowsers.length));
    lines.push(
      `    (${r.security.allowedBrowsers.slice(0, 4).join(', ')}${r.security.allowedBrowsers.length > 4 ? ', …' : ''})`,
    );
  }
  lines.push('');
  lines.push(t.multiAgentHeader);
  lines.push(`${t.multiAgentMode}${r.multiAgent.enabled ? t.on : t.off}`);
  lines.push(`${t.autoReelect}${r.multiAgent.autoReelect ? t.on : t.off}`);
  lines.push(`${t.ipcLine}${r.ipc.listening ? t.ipcListening : t.ipcFree}`);
  return lines.join('\n');
}
