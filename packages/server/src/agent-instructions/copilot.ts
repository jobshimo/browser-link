import { homedir } from 'node:os';
import { join } from 'node:path';
import { detectAt, installAt, uninstallAt } from './file-ops.js';
import type { InstructionsDetect, InstructionsInstaller } from './types.js';

/**
 * GitHub Copilot CLI keeps its config under `~/.copilot/` (overridable via
 * COPILOT_HOME, same env var the rest of our Copilot integration honours).
 * AGENTS.md alongside `mcp-config.json` is the convention recent versions
 * pick up; older releases ignore the file, in which case the block sits
 * there harmlessly until they catch up.
 */
function file(): string {
  const root = process.env.COPILOT_HOME ?? join(homedir(), '.copilot');
  return join(root, 'AGENTS.md');
}

export const copilotInstructionsInstaller: InstructionsInstaller = {
  id: 'copilot',
  displayName: 'GitHub Copilot CLI',

  filePath() {
    return file();
  },

  detect(): InstructionsDetect {
    return detectAt(file());
  },

  install(): string {
    return installAt(file(), 'GitHub Copilot CLI');
  },

  uninstall(): string {
    return uninstallAt(file(), 'GitHub Copilot CLI');
  },
};
