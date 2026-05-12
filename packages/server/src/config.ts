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
  /**
   * Multi-agent mode. When false (default), only one MCP client can have
   * browser-link active at a time; a second client trying to spawn the
   * server crashes with EADDRINUSE. When true, the second instance becomes
   * a proxy that forwards MCP requests to the first one over an internal
   * IPC port (127.0.0.1:17530). All agents end up sharing the same Chrome
   * tabs and the same persistent UI map.
   */
  multiAgent?: boolean;
  /**
   * Only honoured when multiAgent === true. When false (default), if the
   * primary's MCP client closes, secondary clients lose the bridge and
   * have to be relaunched manually. When true, one of the secondaries
   * takes over the primary role automatically (race on bind(17529)).
   */
  autoReelect?: boolean;
}

function configFile(): string {
  return join(getDataDir(), 'config.json');
}

function normalise(cfg: BrowserLinkConfig): BrowserLinkConfig {
  // Always run the disabled-tools list through the sanitizer — both on read
  // and on write — so unknown names from a downgraded build, a typo, or a
  // manual edit never reach the server filter.
  const sanitized = sanitizeDisabledTools(cfg.disabledTools);
  let next: BrowserLinkConfig;
  if (sanitized.length === 0) {
    const { disabledTools: _omit, ...rest } = cfg;
    next = rest;
  } else {
    next = { ...cfg, disabledTools: sanitized };
  }
  // autoReelect only makes sense when multiAgent is on. Drop a stray
  // autoReelect:true if multiAgent is off, so the config file never has
  // an inert flag advertising a behaviour it does not produce.
  if (next.autoReelect && !next.multiAgent) {
    const { autoReelect: _omit2, ...rest2 } = next;
    next = rest2;
  }
  // Drop explicit `false` for the two new flags too — the default is false,
  // so storing it just adds noise.
  if (next.multiAgent === false) {
    const { multiAgent: _omit3, ...rest3 } = next;
    next = rest3;
  }
  if (next.autoReelect === false) {
    const { autoReelect: _omit4, ...rest4 } = next;
    next = rest4;
  }
  return next;
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
