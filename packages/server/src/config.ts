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
   * Multi-agent mode. Default ON. When true (default), several MCP clients
   * (Claude Code + OpenCode + Copilot, …) can share the same browser-link
   * primary: the second `browser-link` spawn becomes a thin proxy that
   * forwards MCP traffic to the first one over an internal IPC port
   * (127.0.0.1:17530), and all agents see the same Chrome tabs and the
   * same persistent UI map. Set explicitly to false to disable.
   */
  multiAgent?: boolean;
  /**
   * Auto-reelect. Default ON, gated by `multiAgent`. When true and the
   * current primary's MCP client closes, the secondary proxies enter a
   * short reconnect window and race to become the new primary; clients
   * recover automatically instead of needing a manual relaunch. Set
   * explicitly to false to keep the previous behaviour (proxies die when
   * the primary does). Has no effect when multiAgent is false.
   */
  autoReelect?: boolean;
}

/** Defaults applied at load time so consumers can read `cfg.multiAgent`
 * directly. Persisted form (see `normaliseForWrite`) only carries the field
 * when the user overrides the default, keeping the on-disk config minimal. */
const DEFAULT_MULTI_AGENT = true;
const DEFAULT_AUTO_REELECT = true;

function configFile(): string {
  return join(getDataDir(), 'config.json');
}

/** Apply the runtime defaults so every consumer of loadConfig() reads the
 * effective configuration directly — no per-call `?? true` plumbing. */
function withDefaults(cfg: BrowserLinkConfig): BrowserLinkConfig {
  const multiAgent = cfg.multiAgent ?? DEFAULT_MULTI_AGENT;
  // autoReelect is gated on multiAgent: when multi-agent is off, the flag
  // has no effect, so the effective value is forced to false to avoid any
  // ambiguity for the consumer.
  const autoReelect = multiAgent ? (cfg.autoReelect ?? DEFAULT_AUTO_REELECT) : false;
  return { ...cfg, multiAgent, autoReelect };
}

/** Strip fields that hold their default value before writing — the on-disk
 * config only carries explicit overrides. Keeps the file diff-friendly and
 * forward-compatible when defaults shift in a future release. */
function normaliseForWrite(cfg: BrowserLinkConfig): BrowserLinkConfig {
  // Always run the disabled-tools list through the sanitizer so unknown
  // names from a downgraded build, a typo, or a manual edit never reach
  // the server filter.
  const sanitized = sanitizeDisabledTools(cfg.disabledTools);
  let next: BrowserLinkConfig;
  if (sanitized.length === 0) {
    const { disabledTools: _omit, ...rest } = cfg;
    next = rest;
  } else {
    next = { ...cfg, disabledTools: sanitized };
  }
  // autoReelect only makes sense when multiAgent is on. Drop the flag
  // entirely when multiAgent has been turned off so the file never carries
  // an inert override.
  if (next.multiAgent === false && 'autoReelect' in next) {
    const { autoReelect: _omit2, ...rest2 } = next;
    next = rest2;
  }
  // Drop fields whose value matches the runtime default — they are the
  // implicit state; the file should only show user-chosen overrides.
  if (next.multiAgent === DEFAULT_MULTI_AGENT) {
    const { multiAgent: _omit3, ...rest3 } = next;
    next = rest3;
  }
  if (next.autoReelect === DEFAULT_AUTO_REELECT) {
    const { autoReelect: _omit4, ...rest4 } = next;
    next = rest4;
  }
  return next;
}

export function loadConfig(): BrowserLinkConfig {
  const path = configFile();
  if (!existsSync(path)) return withDefaults({});
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') return withDefaults(parsed as BrowserLinkConfig);
    return withDefaults({});
  } catch (err) {
    // Surface corruption rather than silently masking it: the file is
    // small and user-owned, so a one-line stderr warning is the right
    // signal. We still fall back to defaults so the CLI keeps working.
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[browser-link] could not read config at ${path}: ${message}. Using defaults.`);
    return withDefaults({});
  }
}

export function saveConfig(patch: Partial<BrowserLinkConfig>): BrowserLinkConfig {
  const path = configFile();
  mkdirSync(dirname(path), { recursive: true });
  // Read the persisted form (pre-defaults) so merging the patch doesn't
  // accidentally promote a default into an explicit field on disk.
  const persisted = readPersisted();
  const stripped = normaliseForWrite({ ...persisted, ...patch });
  writeFileSync(path, JSON.stringify(stripped, null, 2) + '\n', 'utf8');
  return loadConfig();
}

function readPersisted(): BrowserLinkConfig {
  const path = configFile();
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') return parsed as BrowserLinkConfig;
    return {};
  } catch {
    return {};
  }
}
