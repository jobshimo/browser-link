import { existsSync } from 'node:fs';
import { SERVER_ENTRY_PATH } from '../entry-info.js';
import { INSTALLERS, getInstaller, type ClientId } from '../installers/index.js';

/**
 * Where this CLI lives on disk. Used to build the MCP command that clients
 * must spawn. We prefer the bin name "browser-link" on PATH; if the user
 * invoked us via an absolute path (e.g. unpublished dev install), we fall
 * back to that absolute node command.
 */
function resolveServerCommand(): { command: string; args: string[] } {
  // npm installs put `browser-link` on PATH. That's the most portable across OSes.
  // For dev runs (no global install) the user can override via env var.
  const override = process.env.BROWSER_LINK_BIN;
  if (override) {
    const parts = override.split(' ').filter(Boolean);
    return { command: parts[0]!, args: parts.slice(1) };
  }
  // Default: rely on the PATH lookup. This works on Windows because npm
  // creates a `browser-link.cmd` shim alongside the global node binary.
  return { command: 'browser-link', args: [] };
}

/**
 * Same shape but using the absolute path to the compiled MCP entry — useful
 * as a fallback when the bin is not yet on PATH (fresh clone, no `npm link`).
 * The entry path is resolved at runtime by `entry-info.js` so this stays
 * correct even if the dist layout changes.
 */
export function resolveAbsoluteServerCommand(): { command: string; args: string[] } {
  if (existsSync(SERVER_ENTRY_PATH)) {
    return { command: process.execPath, args: [SERVER_ENTRY_PATH] };
  }
  return resolveServerCommand();
}

export interface InstallReport {
  client: ClientId;
  displayName: string;
  installedClient: boolean;
  message: string;
}

export function installFor(client: ClientId, mode: 'bin' | 'absolute' = 'bin'): InstallReport {
  const inst = getInstaller(client);
  const detect = inst.detect();
  if (!detect.installed) {
    return {
      client,
      displayName: inst.displayName,
      installedClient: false,
      message: `${inst.displayName} config not found at ${detect.configPath}. Install ${inst.displayName} first.`,
    };
  }
  const cmd = mode === 'absolute' ? resolveAbsoluteServerCommand() : resolveServerCommand();
  const message = inst.install(cmd.command, cmd.args);
  return { client, displayName: inst.displayName, installedClient: true, message };
}

export function installAll(mode: 'bin' | 'absolute' = 'bin'): InstallReport[] {
  return INSTALLERS.map((i) => installFor(i.id, mode));
}
