import { claudeInstaller } from './claude.js';
import type { ClientId, Installer } from './types.js';

/**
 * Installers that are currently shippable. OpenCode lives in opencode.ts as
 * a scaffold but is not part of this array yet — installFor / installAll
 * will never invoke its (throwing) install/uninstall stubs.
 */
export const INSTALLERS: Installer[] = [claudeInstaller];

export function getInstaller(id: ClientId): Installer {
  const found = INSTALLERS.find((i) => i.id === id);
  if (!found) throw new Error(`Unknown or unsupported client: ${id}`);
  return found;
}

export type { ClientId, Installer } from './types.js';
