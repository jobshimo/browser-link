import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Resolve the directory where browser-link stores user data (the map DB).
 * Respects $XDG_DATA_HOME; falls back to $HOME/.browser-link.
 * Override with $BROWSER_LINK_DATA_DIR for tests / portable installs.
 */
export function getDataDir(): string {
  const override = process.env.BROWSER_LINK_DATA_DIR;
  if (override && override.trim().length > 0) return override;

  const xdg = process.env.XDG_DATA_HOME;
  if (xdg && xdg.trim().length > 0) return join(xdg, 'browser-link');

  return join(homedir(), '.browser-link');
}

export function getDbPath(): string {
  return join(getDataDir(), 'map.db');
}
