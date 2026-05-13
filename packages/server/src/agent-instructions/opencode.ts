import { homedir } from 'node:os';
import { join } from 'node:path';
import { detectAt, installAt, uninstallAt } from './file-ops.js';
import type { InstructionsDetect, InstructionsInstaller } from './types.js';

/**
 * OpenCode follows the AGENTS.md convention (https://agents.md). Global
 * instructions live next to the MCP config at
 * `~/.config/opencode/AGENTS.md` on every OS — same dir as `opencode.json`.
 * Project-level AGENTS.md still applies in addition; the global file is
 * the one we manage so the agent gets the trigger list everywhere.
 */
function file(): string {
  return join(homedir(), '.config', 'opencode', 'AGENTS.md');
}

export const opencodeInstructionsInstaller: InstructionsInstaller = {
  id: 'opencode',
  displayName: 'OpenCode',

  filePath() {
    return file();
  },

  detect(): InstructionsDetect {
    return detectAt(file());
  },

  install(): string {
    return installAt(file(), 'OpenCode');
  },

  uninstall(): string {
    return uninstallAt(file(), 'OpenCode');
  },
};
