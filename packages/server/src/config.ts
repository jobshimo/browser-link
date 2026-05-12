import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getDataDir } from './map/paths.js';
import { sanitizeDisabledTools } from './permissions.js';

/**
 * Small per-user config persisted next to the map DB. UX preferences and
 * the tool-access deny list — never any domain data.
 */
export interface BrowserLinkConfig {
  skipWelcome?: boolean;
  language?: 'en' | 'es';
  /**
   * Tool names the MCP server must not expose. Empty / undefined means
   * "everything enabled" (default, backwards-compatible). Unknown names
   * are dropped silently by sanitizeDisabledTools so old configs survive
   * tool renames or removals.
   */
  disabledTools?: string[];
}

function configFile(): string {
  return join(getDataDir(), 'config.json');
}

function normalise(cfg: BrowserLinkConfig): BrowserLinkConfig {
  // Always run the disabled-tools list through the sanitizer — both on read
  // and on write — so unknown names from a downgraded build, a typo, or a
  // manual edit never reach the server filter.
  const sanitized = sanitizeDisabledTools(cfg.disabledTools);
  if (sanitized.length === 0) {
    const { disabledTools: _omit, ...rest } = cfg;
    return rest;
  }
  return { ...cfg, disabledTools: sanitized };
}

export function loadConfig(): BrowserLinkConfig {
  const path = configFile();
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') return normalise(parsed as BrowserLinkConfig);
    return {};
  } catch (err) {
    // Surface corruption rather than silently masking it: the file is
    // small and user-owned, so a one-line stderr warning is the right
    // signal. We still fall back to defaults so the CLI keeps working.
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[browser-link] could not read config at ${path}: ${message}. Using defaults.`);
    return {};
  }
}

export function saveConfig(patch: Partial<BrowserLinkConfig>): BrowserLinkConfig {
  const path = configFile();
  mkdirSync(dirname(path), { recursive: true });
  const current = loadConfig();
  const next = normalise({ ...current, ...patch });
  writeFileSync(path, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return next;
}
