import { claudeInstaller } from './claude.js';
import { opencodeInstaller } from './opencode.js';
import type { ClientId, Installer } from './types.js';

export const INSTALLERS: Installer[] = [claudeInstaller, opencodeInstaller];

export function getInstaller(id: ClientId): Installer {
  const found = INSTALLERS.find((i) => i.id === id);
  if (!found) throw new Error(`Unknown client: ${id}`);
  return found;
}

export type { ClientId, Installer } from './types.js';
