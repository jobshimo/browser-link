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

function configFile(): McpConfigFile {
  // Claude Code stores its config at the user's home root on every OS.
  // os.homedir() resolves correctly on Windows (%USERPROFILE%) and *nix.
  return { path: join(homedir(), '.claude.json'), label: 'Claude' };
}

function objectOrEmpty(value: unknown): JsonObject {
  return isJsonObject(value) ? value : {};
}

/** `mcpServers` and `projects` are objects when present; so is every project
 * and every project's `mcpServers`. */
function checkShape(cfg: JsonObject): string | null {
  const top =
    expectObjectAt(cfg.mcpServers, ['mcpServers']) ?? expectObjectAt(cfg.projects, ['projects']);
  if (top !== null) return top;
  for (const [key, project] of Object.entries(objectOrEmpty(cfg.projects))) {
    const problem =
      expectObjectAt(project, ['projects', key]) ??
      expectObjectAt(objectOrEmpty(project).mcpServers, ['projects', key, 'mcpServers']);
    if (problem !== null) return problem;
  }
  return null;
}

/** Project keys whose `mcpServers` hold the entry. */
function projectsWithEntry(cfg: JsonObject): string[] {
  return Object.entries(objectOrEmpty(cfg.projects))
    .filter(([, p]) => SERVER_NAME in objectOrEmpty(objectOrEmpty(p).mcpServers))
    .map(([key]) => key);
}

function isRegistered(cfg: JsonObject): boolean {
  return !!objectOrEmpty(cfg.mcpServers)[SERVER_NAME] || projectsWithEntry(cfg).length > 0;
}

export const claudeInstaller: Installer = {
  id: 'claude',
  displayName: 'Claude Code',

  configPath() {
    return configFile().path;
  },

  detect(): DetectResult {
    const file = configFile();
    if (!existsSync(file.path)) {
      return { installed: false, registered: false, configPath: file.path };
    }
    const { data } = loadMcpConfig(file, checkShape);
    return { installed: true, registered: isRegistered(data), configPath: file.path };
  },

  install(command: string, args: string[]): string {
    const file = configFile();
    return editMcpConfig(file, checkShape, ({ data }) => {
      const existed = SERVER_NAME in objectOrEmpty(data.mcpServers);
      return {
        ops: [
          {
            kind: 'set',
            path: ['mcpServers', SERVER_NAME],
            value: { type: 'stdio', command, args },
          },
        ],
        message: existed
          ? `Updated ${SERVER_NAME} entry (user scope) in ${file.path}.`
          : `Added ${SERVER_NAME} entry (user scope) to ${file.path}.`,
      };
    });
  },

  uninstall(): string {
    const file = configFile();
    if (!existsSync(file.path)) return `No Claude config at ${file.path}; nothing to remove.`;
    return editMcpConfig(file, checkShape, ({ data }) => {
      const projects = projectsWithEntry(data);
      if (!(SERVER_NAME in objectOrEmpty(data.mcpServers)) && projects.length === 0) {
        return { ops: [], message: `${SERVER_NAME} was not registered in ${file.path}.` };
      }
      const ops: EditOp[] = [
        { kind: 'remove', path: ['mcpServers', SERVER_NAME] },
        ...projects.map((key): EditOp => ({
          kind: 'remove',
          path: ['projects', key, 'mcpServers', SERVER_NAME],
        })),
      ];
      return {
        ops,
        message: `Removed ${SERVER_NAME} entry from ${file.path} (user + project scopes).`,
      };
    });
  },
};
