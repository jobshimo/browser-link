import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import type { DetectResult, Installer } from './types.js';

/**
 * OpenCode integration is a placeholder until we wire up its config format.
 * detect() looks for the conventional config path per OS; install/uninstall
 * throw with a clear message so the CLI surface is consistent.
 */
function configFile(): string {
  if (platform() === 'win32') {
    const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'opencode', 'opencode.json');
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && xdg.trim().length > 0) return join(xdg, 'opencode', 'opencode.json');
  if (platform() === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'opencode', 'opencode.json');
  }
  return join(homedir(), '.config', 'opencode', 'opencode.json');
}

export const opencodeInstaller: Installer = {
  id: 'opencode',
  displayName: 'OpenCode',

  configPath() {
    return configFile();
  },

  detect(): DetectResult {
    const path = configFile();
    return { installed: existsSync(path), registered: false, configPath: path };
  },

  install() {
    throw new Error(
      `OpenCode installer is not implemented yet. Edit ${configFile()} manually or open an issue.`,
    );
  },

  uninstall() {
    throw new Error(
      `OpenCode installer is not implemented yet. Edit ${configFile()} manually or open an issue.`,
    );
  },
};
