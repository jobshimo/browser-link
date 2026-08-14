import { homedir } from 'node:os';
import { join } from 'node:path';
import { detectAt, installAt, uninstallAt } from './file-ops.js';
import type { ClientId, InstructionsDetect, InstructionsInstaller } from './types.js';

/**
 * Build an `InstructionsInstaller` for a client whose only per-client knobs
 * are `id`, `displayName`, and the path resolution function. The three
 * wrappers `claude.ts` / `opencode.ts` / `copilot.ts` used to be hand-written
 * copies of the same 36-line shape; collapsing them here keeps the shared
 * shape (and any future change to it) in one place. `allowOutsideHome`
 * lets a client opt out of the outside-`$HOME` guard when the user has
 * explicitly redirected the path through a client-specific env var
 * (e.g. Copilot CLI's `COPILOT_HOME`).
 */
interface InstallerSpec {
  id: ClientId;
  displayName: string;
  file: () => string;
  /** Returns true when the resolved `file()` was redirected by an explicit
   * env-var override the user controls, in which case the outside-`$HOME`
   * guard must let the write through. Evaluated on every call so toggling
   * the env var between operations is honoured. */
  allowOutsideHome?: () => boolean;
}

function createInstructionsInstaller(spec: InstallerSpec): InstructionsInstaller {
  const { id, displayName, file, allowOutsideHome } = spec;
  const opts = (): { allowOutsideHome: boolean } => ({
    allowOutsideHome: allowOutsideHome?.() ?? false,
  });
  return {
    id,
    displayName,
    filePath(): string {
      return file();
    },
    detect(): InstructionsDetect {
      return detectAt(file());
    },
    install(): string {
      return installAt(file(), displayName, opts());
    },
    uninstall(): string {
      return uninstallAt(file(), displayName, opts());
    },
  };
}

/**
 * Claude Code reads `~/.claude/CLAUDE.md` as the user-level global
 * instructions file (applied to every project). That is where the block
 * lives so the trigger list reaches every Claude session, regardless of
 * which repo the user is in.
 */
export const claudeInstructionsInstaller: InstructionsInstaller = createInstructionsInstaller({
  id: 'claude',
  displayName: 'Claude Code',
  file: () => join(homedir(), '.claude', 'CLAUDE.md'),
});

/**
 * OpenCode follows the AGENTS.md convention (https://agents.md). Global
 * instructions live next to the MCP config at
 * `~/.config/opencode/AGENTS.md` on every OS — same dir as `opencode.json`.
 * Project-level AGENTS.md still applies in addition; the global file is
 * the one we manage so the agent gets the trigger list everywhere.
 */
export const opencodeInstructionsInstaller: InstructionsInstaller = createInstructionsInstaller({
  id: 'opencode',
  displayName: 'OpenCode',
  file: () => join(homedir(), '.config', 'opencode', 'AGENTS.md'),
});

/**
 * GitHub Copilot CLI keeps its config under `~/.copilot/` (overridable via
 * COPILOT_HOME, same env var the rest of our Copilot integration honours).
 * AGENTS.md alongside `mcp-config.json` is the convention recent versions
 * pick up; older releases ignore the file, in which case the block sits
 * there harmlessly until they catch up.
 *
 * When `COPILOT_HOME` is set the resolved path may sit outside `$HOME`.
 * That is the user opting in explicitly, so the outside-`$HOME` guard is
 * relaxed for this client only when the env var is present.
 */
export const copilotInstructionsInstaller: InstructionsInstaller = createInstructionsInstaller({
  id: 'copilot',
  displayName: 'GitHub Copilot CLI',
  file: () => {
    const root = process.env.COPILOT_HOME ?? join(homedir(), '.copilot');
    return join(root, 'AGENTS.md');
  },
  allowOutsideHome: () => process.env.COPILOT_HOME !== undefined,
});

/**
 * Order matches the MCP `INSTALLERS` array so the agent-instructions screen
 * and the MCP installers screen list clients in the same sequence.
 */
export const INSTRUCTIONS_INSTALLERS: InstructionsInstaller[] = [
  claudeInstructionsInstaller,
  opencodeInstructionsInstaller,
  copilotInstructionsInstaller,
];

export function getInstructionsInstaller(id: ClientId): InstructionsInstaller {
  const found = INSTRUCTIONS_INSTALLERS.find((i) => i.id === id);
  if (!found) throw new Error(`Unknown or unsupported client: ${id}`);
  return found;
}

export type {
  ClientId,
  InstructionsDetect,
  InstructionsInstaller,
  InstructionsState,
} from './types.js';

export { CorruptBlockError, OutsideHomeError, SymlinkRefusedError } from './errors.js';
