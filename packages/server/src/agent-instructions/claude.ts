import { homedir } from 'node:os';
import { join } from 'node:path';
import { detectAt, installAt, uninstallAt } from './file-ops.js';
import type { InstructionsDetect, InstructionsInstaller } from './types.js';

/**
 * Claude Code reads `~/.claude/CLAUDE.md` as the user-level global
 * instructions file (applied to every project). That is where the block
 * lives so the trigger list reaches every Claude session, regardless of
 * which repo the user is in.
 */
function file(): string {
  return join(homedir(), '.claude', 'CLAUDE.md');
}

export const claudeInstructionsInstaller: InstructionsInstaller = {
  id: 'claude',
  displayName: 'Claude Code',

  filePath() {
    return file();
  },

  detect(): InstructionsDetect {
    return detectAt(file());
  },

  install(): string {
    return installAt(file(), 'Claude Code');
  },

  uninstall(): string {
    return uninstallAt(file(), 'Claude Code');
  },
};
