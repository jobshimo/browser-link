import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DetectResult, Installer } from './types.js';

const SERVER_NAME = 'browser-link';
const SCHEMA_URL = 'https://opencode.ai/config.json';

interface OpenCodeMcpEntry {
  type: 'local' | 'remote';
  command?: string[];
  url?: string;
  enabled?: boolean;
  environment?: Record<string, string>;
}

interface OpenCodeConfig {
  $schema?: string;
  mcp?: Record<string, OpenCodeMcpEntry>;
  [key: string]: unknown;
}

function configFile(): string {
  // OpenCode uses ~/.config/opencode/opencode.json on every OS, Windows included
  // (verified against an actual install — not %APPDATA% as it might seem).
  return join(homedir(), '.config', 'opencode', 'opencode.json');
}

function readConfig(path: string): OpenCodeConfig {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as OpenCodeConfig;
  } catch {
    throw new Error(`Could not parse OpenCode config at ${path}. Fix the file or delete it.`);
  }
}

function writeConfig(path: string, cfg: OpenCodeConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

function isRegistered(cfg: OpenCodeConfig): boolean {
  return !!cfg.mcp?.[SERVER_NAME];
}

export const opencodeInstaller: Installer = {
  id: 'opencode',
  displayName: 'OpenCode',

  configPath() {
    return configFile();
  },

  detect(): DetectResult {
    const path = configFile();
    if (!existsSync(path)) {
      return { installed: false, registered: false, configPath: path };
    }
    const cfg = readConfig(path);
    return { installed: true, registered: isRegistered(cfg), configPath: path };
  },

  install(command: string, args: string[]): string {
    const path = configFile();
    const cfg = readConfig(path);
    if (!cfg.$schema) cfg.$schema = SCHEMA_URL;
    cfg.mcp = cfg.mcp ?? {};
    const existing = cfg.mcp[SERVER_NAME];
    cfg.mcp[SERVER_NAME] = { type: 'local', command: [command, ...args] };
    writeConfig(path, cfg);
    return existing
      ? `Updated ${SERVER_NAME} entry in ${path}.`
      : `Added ${SERVER_NAME} entry to ${path}.`;
  },

  uninstall(): string {
    const path = configFile();
    if (!existsSync(path)) return `No OpenCode config at ${path}; nothing to remove.`;
    const cfg = readConfig(path);
    if (!cfg.mcp?.[SERVER_NAME]) return `${SERVER_NAME} was not registered in ${path}.`;
    delete cfg.mcp[SERVER_NAME];
    writeConfig(path, cfg);
    return `Removed ${SERVER_NAME} entry from ${path}.`;
  },
};
