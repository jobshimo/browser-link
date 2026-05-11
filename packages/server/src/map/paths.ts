import envPaths from 'env-paths';
import { join } from 'node:path';

/**
 * Resolve the directory where browser-link stores user data (the map DB).
 *
 * Defaults follow per-OS convention via env-paths:
 *   - Linux: $XDG_DATA_HOME/browser-link, fallback ~/.local/share/browser-link
 *   - macOS: ~/Library/Application Support/browser-link
 *   - Windows: %APPDATA%/browser-link
 *
 * Override with $BROWSER_LINK_DATA_DIR for tests or portable installs.
 */
export function getDataDir(): string {
  const override = process.env.BROWSER_LINK_DATA_DIR;
  if (override && override.trim().length > 0) return override;
  return envPaths('browser-link', { suffix: '' }).data;
}

export function getDbPath(): string {
  return join(getDataDir(), 'map.db');
}
