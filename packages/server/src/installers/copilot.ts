import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  editMcpConfig,
  expectObjectAt,
  isJsonObject,
  loadMcpConfig,
  type JsonObject,
  type McpConfigFile,
} from './json-config.js';
import type { DetectResult, Installer } from './types.js';

const SERVER_NAME = 'browser-link';

function configFile(): McpConfigFile {
  // GitHub Copilot CLI reads from ~/.copilot/mcp-config.json by default.
  // COPILOT_HOME overrides the directory (the same env var the CLI honours);
  // a path the user redirected there may sit outside the home directory.
  const override = process.env.COPILOT_HOME;
  return {
    path: join(override ?? join(homedir(), '.copilot'), 'mcp-config.json'),
    label: 'Copilot',
    allowOutsideHome: override !== undefined,
  };
}

/** `mcpServers` is an object when present. */
function checkShape(cfg: JsonObject): string | null {
  return expectObjectAt(cfg.mcpServers, ['mcpServers']);
}

function hasEntry(cfg: JsonObject): boolean {
  return isJsonObject(cfg.mcpServers) && SERVER_NAME in cfg.mcpServers;
}

export const copilotInstaller: Installer = {
  id: 'copilot',
  displayName: 'GitHub Copilot CLI',

  configPath() {
    return configFile().path;
  },

  detect(): DetectResult {
    const file = configFile();
    if (!existsSync(file.path)) {
      return { installed: false, registered: false, configPath: file.path };
    }
    const { data } = loadMcpConfig(file, checkShape);
    const registered = isJsonObject(data.mcpServers) && !!data.mcpServers[SERVER_NAME];
    return { installed: true, registered, configPath: file.path };
  },

  install(command: string, args: string[]): string {
    const file = configFile();
    return editMcpConfig(file, checkShape, ({ data }) => {
      // Copilot requires `env` and `tools` even when empty/wildcard.
      const entry = { type: 'local', command, args, env: {}, tools: ['*'] };
      return {
        ops: [{ kind: 'set', path: ['mcpServers', SERVER_NAME], value: entry }],
        message: hasEntry(data)
          ? `Updated ${SERVER_NAME} entry in ${file.path}.`
          : `Added ${SERVER_NAME} entry to ${file.path}.`,
      };
    });
  },

  uninstall(): string {
    const file = configFile();
    if (!existsSync(file.path)) return `No Copilot CLI config at ${file.path}; nothing to remove.`;
    return editMcpConfig(file, checkShape, ({ data }) =>
      hasEntry(data)
        ? {
            ops: [{ kind: 'remove', path: ['mcpServers', SERVER_NAME] }],
            message: `Removed ${SERVER_NAME} entry from ${file.path}.`,
          }
        : { ops: [], message: `${SERVER_NAME} was not registered in ${file.path}.` },
    );
  },
};
