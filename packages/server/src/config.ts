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
  /**
   * CLI-side mirror of the extension's idle-disconnect TTL (see
   * `packages/extension/src/idle-policy.ts`), in minutes. `0` means
   * "never". Set via `browser-link config set idle-ttl <minutes|never>`.
   *
   * Deliberately left `undefined` — NOT defaulted to 30 here — when the
   * CLI has never touched it: the WS bridge only pushes a `settings.update`
   * to the extension when this field is explicitly set, so a popup-only
   * user (who never ran the CLI command) never sees a spurious overwrite
   * of their own choice with a server-side "default". See `idleTtlUpdatedAt`
   * for the precedence rule when both sides have set a value.
   */
  idleTtlMinutes?: number;
  /**
   * Epoch-ms timestamp of the last `idleTtlMinutes` write from the CLI.
   * Sent alongside `idleTtlMinutes` in every `settings.update` push so the
   * extension can apply a last-write-wins precedence rule against its own
   * locally-stored timestamp (popup edits stamp their own `Date.now()`).
   * Always set together with `idleTtlMinutes` — never one without the other.
   */
  idleTtlUpdatedAt?: number;
  /**
   * CLI-side mirror of the extension's opt-in flow-recording toggle (see
   * `packages/extension/src/flow-recording-policy.ts`). Set via
   * `browser-link config set flow-recording <on|off>`. Deliberately left
   * `undefined` — NOT defaulted to `false` here — when the CLI has never
   * touched it, mirroring `idleTtlMinutes`'s rationale exactly: the WS
   * bridge only pushes a `settings.update` for this field when it is
   * explicitly set, so a popup-only user never sees a spurious overwrite of
   * their own choice. The extension's OWN default (recording OFF until the
   * user opts in) applies regardless of whether the CLI has ever run.
   */
  flowRecordingEnabled?: boolean;
  /**
   * Epoch-ms timestamp of the last `flowRecordingEnabled` write from the
   * CLI. Sent alongside `flowRecordingEnabled` in every `settings.update`
   * push, same last-write-wins contract as `idleTtlUpdatedAt` — always set
   * together, independent of the idle-TTL pair.
   */
  flowRecordingUpdatedAt?: number;
  /**
   * cdp-direct mode: let the server drive Chrome tabs DIRECTLY over a
   * user-launched `--remote-debugging-port`, bypassing the extension
   * entirely. Off by default and — even when on — gated behind a separate,
   * explicit, time-boxed human grant (see `cdp/grant.ts`, `cdp/gate.ts`):
   * an agent can never enable this itself, and enabling it here alone is
   * NOT enough to let a tool touch a `cdp:` tab. Set via
   * `browser-link config set cdp-direct.enabled <true|false>`.
   */
  cdpDirectEnabled?: boolean;
  /**
   * Loopback port the server dials for cdp-direct discovery/connections.
   * The HOST is never configurable — always `127.0.0.1` — only the port
   * is. Set via `browser-link config set cdp-direct.port <port>`.
   */
  cdpDirectPort?: number;
  /**
   * Default lifetime, in minutes, of a `browser-link cdp allow` grant when
   * no `--minutes` override is passed on that command. `0` ("never") is
   * allowed but reduces the security posture — documented as such in the
   * CLI help and the README. Set via
   * `browser-link config set cdp-direct.grant-ttl <minutes|never>`.
   */
  cdpDirectGrantTtlMinutes?: number;
  /**
   * Activity trail. Default ON. When true (default), every browser tool an
   * agent dispatches is appended to `activity.db` in the data dir, and the
   * extension's Activity window plus `browser-link activity` can read it back.
   *
   * Set explicitly to false to record nothing at all. The window then shows an
   * empty trail rather than pretending — a silently-disabled audit log is
   * worse than no audit log.
   */
  activityEnabled?: boolean;
  /**
   * Whether trail rows carry the free text an action moved: the string typed
   * by `browser.type`, the expression given to `browser.evaluate`, the URL of
   * a `browser.navigate`. Default ON, because a trail that cannot tell you
   * WHAT the agent typed answers none of the questions people open it for.
   *
   * Set to false to keep the shape of the trail without its contents — every
   * row still records which tool ran, where, by whom and with what outcome.
   *
   * Note this is a RECORDING switch, deliberately separate from the redaction
   * applied by `browser-link activity export --redact`: recording is about
   * what lands on your own disk, redaction about what you hand to someone
   * else. Turning this off cannot be undone after the fact; redacting on
   * export can be decided every time.
   */
  activityRecordPayloads?: boolean;
}

/** Safety-rail bounds mirrored from the extension's `idle-policy.ts` — kept
 * as an independent copy (not a shared import) for the same reason
 * `messages.ts` duplicates the wire types instead of depending on
 * `@browser-link/shared`: the server publishes to npm standalone and must
 * not carry an unresolvable workspace dependency. */
export const MIN_IDLE_TTL_MINUTES = 1;
export const MAX_IDLE_TTL_MINUTES = 1440;
export const DEFAULT_IDLE_TTL_MINUTES = 30;

/** cdp-direct bounds — same clamp-at-the-boundary philosophy as the
 * idle-TTL constants above, independent copies since the two settings are
 * unrelated. */
export const DEFAULT_CDP_DIRECT_PORT = 9222;
export const MIN_CDP_DIRECT_PORT = 1;
export const MAX_CDP_DIRECT_PORT = 65535;
export const MIN_GRANT_TTL_MINUTES = 1;
export const MAX_GRANT_TTL_MINUTES = 1440;
export const DEFAULT_GRANT_TTL_MINUTES = 60;

/** Defensive safety net for a `cdp-direct.grant-ttl` value THE USER NEVER
 * TYPED (a corrupted config.json, a hand-edited file) — mirrors
 * `clampIdleTtlMinutes` exactly: `0` ("never expires") passes through
 * untouched, anything else malformed or out of range falls back to
 * `DEFAULT_GRANT_TTL_MINUTES` rather than being snapped to the nearest
 * boundary. `commands/cdp.ts` applies its own user-facing clamp-with-note
 * for values typed at the CLI right now, the same split idle-ttl uses
 * between this module and `commands/config.ts`. */
export function clampGrantTtlMinutes(value: number): number {
  if (value === 0) return 0;
  if (!Number.isFinite(value) || !Number.isInteger(value)) return DEFAULT_GRANT_TTL_MINUTES;
  if (value < MIN_GRANT_TTL_MINUTES || value > MAX_GRANT_TTL_MINUTES)
    return DEFAULT_GRANT_TTL_MINUTES;
  return value;
}

/** Same defensive-fallback philosophy as `clampGrantTtlMinutes`, for the
 * cdp-direct port. No "never" sentinel here — a port is always a port.
 * Used by the CLI `config set cdp-direct.port` path, where the value has
 * already been parsed from a terminal argument. For the READ path — where
 * the value comes straight from an untrusted config.json and is about to be
 * interpolated into a URL — use `sanitizeCdpPort` instead. */
export function clampCdpDirectPort(value: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value)) return DEFAULT_CDP_DIRECT_PORT;
  if (value < MIN_CDP_DIRECT_PORT || value > MAX_CDP_DIRECT_PORT) return DEFAULT_CDP_DIRECT_PORT;
  return value;
}

/**
 * Trust-boundary sanitizer for the cdp-direct port. config.json is UNTRUSTED
 * (hand-edited or corrupted), and the port is interpolated into
 * `http://127.0.0.1:<port>/...` and `ws://127.0.0.1:<port>/...` discovery /
 * connection URLs. A value like the STRING `"9222@attacker.com"` would, by
 * URL userinfo syntax, resolve to host `attacker.com` — an off-host SSRF
 * breakout despite the hardcoded loopback literal (the plain `?? 9222`
 * fallback only ever caught null/undefined, never a malformed string).
 *
 * This coerces the raw value with `Number()` — NOT `parseInt`, which would
 * read `"9222@attacker.com"` as `9222` and quietly accept it — and returns
 * it ONLY when it is a whole port in `[1, 65535]`. Anything else (a string
 * with trailing garbage, a float, `NaN`, out of range, a non-number) falls
 * back to the default. The return is ALWAYS a fresh validated integer, never
 * the raw value, so no attacker-controlled text can ever reach URL
 * construction — this is also the numeric barrier that breaks CodeQL's
 * `js/file-access-to-http` taint flow. Applied on every read (via
 * `withDefaults`, so `cfg.cdpDirectPort` is valid by construction) AND again
 * at each URL construction site as defense in depth.
 */
export function sanitizeCdpPort(raw: unknown): number {
  const n = Number(raw);
  if (Number.isInteger(n) && n >= MIN_CDP_DIRECT_PORT && n <= MAX_CDP_DIRECT_PORT) {
    return n;
  }
  return DEFAULT_CDP_DIRECT_PORT;
}

/**
 * Clamp a CLI-provided idle-TTL value the same way the extension clamps a
 * stored one: `0` ("never") passes through untouched; a non-integer, an
 * out-of-range value, or anything malformed falls back to
 * `DEFAULT_IDLE_TTL_MINUTES` rather than being snapped to the nearest
 * boundary. Exported so `commands/config.ts` and its tests share one
 * implementation instead of re-deriving the bounds.
 */
export function clampIdleTtlMinutes(value: number): number {
  if (value === 0) return 0;
  if (!Number.isFinite(value) || !Number.isInteger(value)) return DEFAULT_IDLE_TTL_MINUTES;
  if (value < MIN_IDLE_TTL_MINUTES || value > MAX_IDLE_TTL_MINUTES) return DEFAULT_IDLE_TTL_MINUTES;
  return value;
}

/** Defaults applied at load time so consumers can read `cfg.multiAgent`
 * directly. Persisted form (see `normaliseForWrite`) only carries the field
 * when the user overrides the default, keeping the on-disk config minimal. */
const DEFAULT_MULTI_AGENT = true;
const DEFAULT_AUTO_REELECT = true;
const DEFAULT_CDP_DIRECT_ENABLED = false;

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
  const cdpDirectEnabled = cfg.cdpDirectEnabled ?? DEFAULT_CDP_DIRECT_ENABLED;
  // sanitizeCdpPort (not `?? DEFAULT`) so cfg.cdpDirectPort is ALWAYS a valid
  // integer by construction — an untrusted config.json string that would
  // otherwise reach a discovery URL is neutralized here, at the read
  // boundary, for every consumer. See sanitizeCdpPort's doc.
  const cdpDirectPort = sanitizeCdpPort(cfg.cdpDirectPort);
  // clampGrantTtlMinutes (not `?? DEFAULT`) so cfg.cdpDirectGrantTtlMinutes is
  // ALWAYS a valid value by construction, same trust-boundary treatment as
  // cdpDirectPort above: a corrupted config.json ("abc", -5, 1.5, 1e9) would
  // otherwise flow straight through `??` (which only catches null/undefined)
  // into `browser-link config get`, the `settings.update` WS push, and the
  // CLI's own display line.
  const cdpDirectGrantTtlMinutes = clampGrantTtlMinutes(
    cfg.cdpDirectGrantTtlMinutes ?? DEFAULT_GRANT_TTL_MINUTES,
  );
  // idleTtlMinutes keeps its "never touched by the CLI" undefined sentinel
  // (see the field doc above) — only clamp when a value is actually present,
  // so a popup-only user's absence of a value still reads as "not set" and
  // not as a coerced default. When present, clampIdleTtlMinutes neutralizes
  // a corrupted config.json the same way sanitizeCdpPort does for the port.
  const idleTtlMinutes =
    cfg.idleTtlMinutes === undefined ? undefined : clampIdleTtlMinutes(cfg.idleTtlMinutes);
  return {
    ...cfg,
    multiAgent,
    autoReelect,
    cdpDirectEnabled,
    cdpDirectPort,
    cdpDirectGrantTtlMinutes,
    idleTtlMinutes,
  };
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
  if (next.cdpDirectEnabled === DEFAULT_CDP_DIRECT_ENABLED) {
    const { cdpDirectEnabled: _omit5, ...rest5 } = next;
    next = rest5;
  }
  if (next.cdpDirectPort === DEFAULT_CDP_DIRECT_PORT) {
    const { cdpDirectPort: _omit6, ...rest6 } = next;
    next = rest6;
  }
  if (next.cdpDirectGrantTtlMinutes === DEFAULT_GRANT_TTL_MINUTES) {
    const { cdpDirectGrantTtlMinutes: _omit7, ...rest7 } = next;
    next = rest7;
  }
  return next;
}

export function loadConfig(): BrowserLinkConfig {
  const path = configFile();
  if (!existsSync(path)) return withDefaults({});
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') return withDefaults(parsed);
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
    if (parsed && typeof parsed === 'object') return parsed;
    return {};
  } catch {
    return {};
  }
}
