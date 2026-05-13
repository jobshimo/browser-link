import { claudeInstructionsInstaller } from './claude.js';
import { copilotInstructionsInstaller } from './copilot.js';
import { opencodeInstructionsInstaller } from './opencode.js';
import type { ClientId, InstructionsInstaller } from './types.js';

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

export { CorruptBlockError, SymlinkRefusedError } from './errors.js';
