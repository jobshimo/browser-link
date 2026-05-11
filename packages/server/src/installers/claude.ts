import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DetectResult, Installer } from './types.js';

const SERVER_NAME = 'browser-link';

interface ClaudeMcpEntry {
  type?: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface ClaudeProjectConfig {
  mcpServers?: Record<string, ClaudeMcpEntry>;
  [key: string]: unknown;
}

interface ClaudeConfig {
  mcpServers?: Record<string, ClaudeMcpEntry>;
  projects?: Record<string, ClaudeProjectConfig>;
  [key: string]: unknown;
}

function configFile(): string {
  // Claude Code stores its config at the user's home root on every OS.
  // os.homedir() resolves correctly on Windows (%USERPROFILE%) and *nix.
  return join(homedir(), '.claude.json');
}

function readConfig(path: string): ClaudeConfig {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ClaudeConfig;
  } catch {
    throw new Error(`Could not parse Claude config at ${path}. Fix the file or delete it.`);
  }
}

function writeConfig(path: string, cfg: ClaudeConfig): void {
  writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

function isRegistered(cfg: ClaudeConfig): boolean {
  if (cfg.mcpServers?.[SERVER_NAME]) return true;
  const projects = cfg.projects ?? {};
  return Object.values(projects).some((p) => !!p.mcpServers?.[SERVER_NAME]);
}

export const claudeInstaller: Installer = {
  id: 'claude',
  displayName: 'Claude Code',

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
    cfg.mcpServers[SERVER_NAME] = { type: 'stdio', command, args };
    writeConfig(path, cfg);
    return existing
      ? `Updated ${SERVER_NAME} entry (user scope) in ${path}.`
      : `Added ${SERVER_NAME} entry (user scope) to ${path}.`;
  },

  uninstall(): string {
    const path = configFile();
    if (!existsSync(path)) return `No Claude config at ${path}; nothing to remove.`;
    const cfg = readConfig(path);
    let removed = false;
    if (cfg.mcpServers?.[SERVER_NAME]) {
      delete cfg.mcpServers[SERVER_NAME];
      removed = true;
    }
    const projects = cfg.projects ?? {};
    for (const proj of Object.values(projects)) {
      if (proj.mcpServers?.[SERVER_NAME]) {
        delete proj.mcpServers[SERVER_NAME];
        removed = true;
      }
    }
    if (!removed) return `${SERVER_NAME} was not registered in ${path}.`;
    writeConfig(path, cfg);
    return `Removed ${SERVER_NAME} entry from ${path} (user + project scopes).`;
  },
};
