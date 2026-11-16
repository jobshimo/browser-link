import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  editMcpConfig,
  expectObjectAt,
  isJsonObject,
  loadMcpConfig,
  type EditOp,
  type JsonObject,
  type McpConfigFile,
} from './json-config.js';
import type { DetectResult, Installer } from './types.js';

const SERVER_NAME = 'browser-link';
const SCHEMA_URL = 'https://opencode.ai/config.json';

function configFile(): McpConfigFile {
  // OpenCode uses ~/.config/opencode/opencode.json on every OS, Windows included
  // (verified against an actual install — not %APPDATA% as it might seem).
  return { path: join(homedir(), '.config', 'opencode', 'opencode.json'), label: 'OpenCode' };
}

/** `mcp` is an object when present. */
function checkShape(cfg: JsonObject): string | null {
  return expectObjectAt(cfg.mcp, ['mcp']);
}

function hasEntry(cfg: JsonObject): boolean {
  return isJsonObject(cfg.mcp) && SERVER_NAME in cfg.mcp;
}

export const opencodeInstaller: Installer = {
  id: 'opencode',
  displayName: 'OpenCode',

  configPath() {
    return configFile().path;
  },

  detect(): DetectResult {
    const file = configFile();
    if (!existsSync(file.path)) {
      return { installed: false, registered: false, configPath: file.path };
    }
    const { data } = loadMcpConfig(file, checkShape);
    const registered = isJsonObject(data.mcp) && !!data.mcp[SERVER_NAME];
    return { installed: true, registered, configPath: file.path };
  },

  install(command: string, args: string[]): string {
    const file = configFile();
    return editMcpConfig(file, checkShape, ({ data }) => {
      const schema: EditOp[] = data.$schema
        ? []
        : [{ kind: 'set', path: ['$schema'], value: SCHEMA_URL }];
      const entry = { type: 'local', command: [command, ...args] };
      return {
        ops: [...schema, { kind: 'set', path: ['mcp', SERVER_NAME], value: entry }],
        message: hasEntry(data)
          ? `Updated ${SERVER_NAME} entry in ${file.path}.`
          : `Added ${SERVER_NAME} entry to ${file.path}.`,
      };
    });
  },

  uninstall(): string {
    const file = configFile();
    if (!existsSync(file.path)) return `No OpenCode config at ${file.path}; nothing to remove.`;
    return editMcpConfig(file, checkShape, ({ data }) =>
      hasEntry(data)
        ? {
            ops: [{ kind: 'remove', path: ['mcp', SERVER_NAME] }],
            message: `Removed ${SERVER_NAME} entry from ${file.path}.`,
          }
        : { ops: [], message: `${SERVER_NAME} was not registered in ${file.path}.` },
    );
  },
};
