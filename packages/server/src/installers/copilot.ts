import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DetectResult, Installer } from './types.js';

const SERVER_NAME = 'browser-link';

interface CopilotMcpEntry {
  type: 'local' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  tools?: string[];
  url?: string;
  headers?: Record<string, string>;
}

interface CopilotConfig {
  mcpServers?: Record<string, CopilotMcpEntry>;
  [key: string]: unknown;
}

function configFile(): string {
  // GitHub Copilot CLI reads from ~/.copilot/mcp-config.json by default.
  // COPILOT_HOME overrides the directory (the same env var the CLI honours).
  const root = process.env.COPILOT_HOME ?? join(homedir(), '.copilot');
  return join(root, 'mcp-config.json');
}

function readConfig(path: string): CopilotConfig {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as CopilotConfig;
  } catch {
    throw new Error(`Could not parse Copilot config at ${path}. Fix the file or delete it.`);
  }
}

function writeConfig(path: string, cfg: CopilotConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

function isRegistered(cfg: CopilotConfig): boolean {
  return !!cfg.mcpServers?.[SERVER_NAME];
}

export const copilotInstaller: Installer = {
  id: 'copilot',
  displayName: 'GitHub Copilot CLI',

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
    cfg.mcpServers = cfg.mcpServers ?? {};
    const existing = cfg.mcpServers[SERVER_NAME];
    // Copilot requires `env` and `tools` even when empty/wildcard.
    cfg.mcpServers[SERVER_NAME] = {
      type: 'local',
      command,
      args,
      env: {},
      tools: ['*'],
    };
    writeConfig(path, cfg);
    return existing
      ? `Updated ${SERVER_NAME} entry in ${path}.`
      : `Added ${SERVER_NAME} entry to ${path}.`;
  },

  uninstall(): string {
    const path = configFile();
    if (!existsSync(path)) return `No Copilot CLI config at ${path}; nothing to remove.`;
    const cfg = readConfig(path);
    if (!cfg.mcpServers?.[SERVER_NAME]) return `${SERVER_NAME} was not registered in ${path}.`;
    delete cfg.mcpServers[SERVER_NAME];
    writeConfig(path, cfg);
    return `Removed ${SERVER_NAME} entry from ${path}.`;
  },
};
