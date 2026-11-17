import {
  constants,
  copyFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { platform } from 'node:os';
import { dirname, join, posix, win32 } from 'node:path';
import { isExtensionId } from './auth/extension-id.js';
import { getDataDir } from './map/paths.js';
import { sanitizeDisabledTools } from './permissions.js';

/**
 * Small per-user config persisted next to the map DB. UX preferences and
 * the tool-access deny list — never any domain data.
 */
export interface BrowserLinkConfig {
  skipWelcome?: boolean;
  /**
   * The user confirmed the product notice (`notice.ts`) on the console's
   * first run. Reads as `false` unless the file holds exactly `true`; only
   * `true` is ever written. Until it is true the TUI opens on the notice,
   * whatever `skipWelcome` says. CLI commands are never blocked by it.
   */
  noticeAcknowledged?: boolean;
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
   * Refresh the installed agent-instructions block at server start. Default
   * ON. When true (default), the primary rewrites, in place, every client's
   * block that exists but is older than the server (`installed-outdated`),
   * through the same installer `browser-link instructions install` uses, and
   * tells the agent to restart its client. A client without a block, or with
   * a corrupt file, is never touched. Set explicitly to false in config.json
   * to keep the block as it is (the agent then sees the outdated notice).
   */
  instructionsAutoRefresh?: boolean;
  /**
   * The idle-disconnect TTL of the extension's tabs, in minutes; `0` means
   * "never". The ONE value of this setting (1.3.0): only the console changes
   * it (`browser-link config set idle-ttl <minutes|never>`), the server
   * pushes it to every tab on connect and on change, and the extension and
   * the console show the same value. Absent means the default,
   * `DEFAULT_IDLE_TTL_MINUTES` (see `idleTtlMinutesInEffect`). The popup
   * no longer has a control for it: an old popup choice is ignored.
   */
  idleTtlMinutes?: number;
  /**
   * Epoch-ms timestamp of the last `idleTtlMinutes` write from the CLI.
   * Still sent as `updatedAt` with the pushed value so an extension older
   * than 1.3.0 (which compares it with its popup's own timestamp) keeps
   * parsing the push. The 1.3.0 extension ignores it: the console wins.
   */
  idleTtlUpdatedAt?: number;
  /**
   * How long a claim between agents (`browser.claim_tab`, or the auto-claim
   * of an action tool) lasts without activity, in minutes; `0` means
   * "never": the claim lasts until its agent releases it or disconnects.
   * Absent means the default, `DEFAULT_CLAIM_TTL_MINUTES` (10). It widens
   * what an agent may do (hold a tab away from the others), so only the
   * console changes it (`browser-link config set claim-ttl
   * <minutes|never|default>`); the Admin window shows it read-only. Read on
   * every check (see `claimTtlMinutesInEffect`), no restart needed. A
   * `ttl_minutes` an agent passes to `browser.claim_tab` still applies to
   * that claim.
   */
  claimTtlMinutes?: number;
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
  /**
   * Map learning. Default ON: only an explicit `false` disables it. When on,
   * every click/type/press/find/wait_for that addressed a durable target (a
   * CSS selector or a `browser.find` semantic key) adds an ok/fail count to
   * the persistent map (see `map/learning.ts`). It stores targets only,
   * never typed text, expressions or values. Read on every call, so
   * `browser-link config set map-learning <on|off>` applies without a
   * restart. Independent of `activityEnabled`.
   */
  mapLearningEnabled?: boolean;
  /**
   * Owner decision D12. Default OFF: `browser.snapshot` and `browser.find`
   * return the value of password fields, so the agent can type and check
   * them. On: a filled password field (or one the page marks with a
   * password, one-time-code or card `autocomplete` token) shows
   * `value_hidden: "filled, N characters"` instead, find neither matches
   * nor quotes it, and every such result carries `values_hidden`. Read on
   * every call (see `hidesPasswordValues`), so `browser-link config set
   * hide-password-values <on|off>` or the extension's Admin window applies
   * to the next call, no restart.
   */
  hidePasswordValues?: boolean;
  /**
   * Owner decision D13. Default `DEFAULT_ACTIVITY_HIDE_SENSITIVE`. Hide: a
   * trail row whose `browser.type` / `browser.press` acted on a sensitive
   * field, or never said which field it acted on, hides the value in every
   * column (`activity/extract.ts`). `false`: such rows are stored like any
   * other, nothing hidden. Read once when the primary wires the trail, so a
   * change needs a restart, like the other activity switches. Rows already
   * stored are never rewritten.
   */
  activityHideSensitive?: boolean;
  /**
   * Absolute directory `browser.download` writes files into. Undefined means
   * the default, `<dataDir>/downloads` (see `downloads.ts`'s
   * `resolveDownloadsDir`, which also ignores a relative or malformed value).
   * Only the human sets this, via `browser-link config set downloads.dir
   * <path|default>` — the agent can name a file, never choose where it lands.
   */
  downloadsDir?: string;
  /**
   * Per-file size cap of `browser.download`, in MiB. Undefined means the
   * default, 25 MiB (`DEFAULT_DOWNLOADS_MAX_MB`). Only the human sets this,
   * via `browser-link config set downloads.max-mb <1..64|default>`; the
   * server reads it on every download through `sanitizeDownloadsMaxMb`, so
   * a hand-edited value outside [1, 64] reads as the default.
   */
  downloadsMaxMb?: number;
  /**
   * Whether `browser.download` may save executable file types (`.exe`,
   * `.msi`, `.bat`, `.ps1`, `.lnk`, `.js`, … see `downloads.ts`'s
   * `isExecutableFilename`). Default off: they are refused. It widens what an
   * agent may do, so only the console changes it (`browser-link config set
   * downloads.allow-executables <on|off>`); the Admin window shows it
   * read-only. Read on every download through `allowsExecutableDownloads`:
   * only an explicit `true` allows them.
   */
  allowExecutableDownloads?: boolean;
  /**
   * Opt-in strict mode of the bridge's peer check, for experts. Absent or
   * empty: no path check (the peer must still run as the same OS user and
   * carry an allowlisted browser name). Non-empty: the peer's executable
   * path must also equal one of these absolute paths (case-insensitive on
   * Windows, exact elsewhere), and a path that cannot be read is refused.
   *
   * Hand-edited in config.json only: no CLI command, admin panel item,
   * bridge message or MCP tool writes it. After `loadConfig`, `undefined`
   * means off and an array means on; entries that are not absolute strings
   * are dropped but strict mode stays on, so a mistyped list refuses every
   * peer instead of silently turning the check off.
   */
  peerExecutablePaths?: string[];
  /**
   * Extra Chrome extension ids allowed to open the bridge, for experts (for
   * example a Web Store build or your own fork). The pinned id
   * (`auth/extension-id.ts`) is always allowed; the handshake compares the
   * full `Origin` with `chrome-extension://<id>` exactly.
   *
   * Hand-edited in config.json only: no CLI command, admin panel item,
   * bridge message or MCP tool writes it. After `loadConfig` it holds only
   * well-formed ids (exactly 32 letters a-p) and is absent when none is
   * left; every other entry is dropped with a warning.
   */
  allowedExtensionIds?: string[];
}

/** Safety-rail bounds mirrored from the extension's `idle-policy.ts` — kept
 * as an independent copy (not a shared import) for the same reason
 * `messages.ts` duplicates the wire types instead of depending on
 * `@browser-link/shared`: the server publishes to npm standalone and must
 * not carry an unresolvable workspace dependency. */
export const MIN_IDLE_TTL_MINUTES = 1;
export const MAX_IDLE_TTL_MINUTES = 1440;
export const DEFAULT_IDLE_TTL_MINUTES = 30;

/** Claim expiry between agents (`claim-ttl`): same bounds and same
 * "0 is never, anything malformed is the default" rule as idle-ttl. */
export const MIN_CLAIM_TTL_MINUTES = 1;
export const MAX_CLAIM_TTL_MINUTES = 1440;
export const DEFAULT_CLAIM_TTL_MINUTES = 10;

/** Read-side sanitizer for `claimTtlMinutes` (config.json is untrusted):
 * `0` ("never") and a whole number of minutes in [1, 1440] pass; anything
 * else, absent included, is the 10-minute default. */
export function clampClaimTtlMinutes(raw: unknown): number {
  if (raw === 0) return 0;
  if (
    typeof raw === 'number' &&
    Number.isInteger(raw) &&
    raw >= MIN_CLAIM_TTL_MINUTES &&
    raw <= MAX_CLAIM_TTL_MINUTES
  ) {
    return raw;
  }
  return DEFAULT_CLAIM_TTL_MINUTES;
}

/** The claim expiry in effect, in minutes (`0` = never). */
export function claimTtlMinutesInEffect(cfg: BrowserLinkConfig): number {
  return clampClaimTtlMinutes(cfg.claimTtlMinutes);
}

/** cdp-direct bounds — same clamp-at-the-boundary philosophy as the
 * idle-TTL constants above, independent copies since the two settings are
 * unrelated. */
export const DEFAULT_CDP_DIRECT_PORT = 9222;
export const MIN_CDP_DIRECT_PORT = 1;
export const MAX_CDP_DIRECT_PORT = 65535;
export const MIN_GRANT_TTL_MINUTES = 1;
export const MAX_GRANT_TTL_MINUTES = 1440;
export const DEFAULT_GRANT_TTL_MINUTES = 60;

/** `browser.download` per-file cap bounds, in MiB. The default matches
 * `downloads.ts`'s `MAX_DOWNLOAD_BYTES`; the maximum is a hard ceiling no
 * configured value can pass: the file crosses the extension socket
 * base64-encoded in one message, and 64 MiB (about 85 MiB of base64) stays
 * under the 100 MiB message limit of the `ws` library. */
export const DEFAULT_DOWNLOADS_MAX_MB = 25;
export const MIN_DOWNLOADS_MAX_MB = 1;
export const MAX_DOWNLOADS_MAX_MB = 64;

/** Read-side sanitizer for `downloadsMaxMb` (config.json is untrusted): a
 * whole number of MiB in [1, 64] passes, anything else (a string, a
 * fraction, out of range, absent) is the 25 MiB default. */
export function sanitizeDownloadsMaxMb(raw: unknown): number {
  if (
    typeof raw === 'number' &&
    Number.isInteger(raw) &&
    raw >= MIN_DOWNLOADS_MAX_MB &&
    raw <= MAX_DOWNLOADS_MAX_MB
  ) {
    return raw;
  }
  return DEFAULT_DOWNLOADS_MAX_MB;
}

/** Read-side sanitizer for `peerExecutablePaths` (config.json is
 * untrusted): absent, null or an empty array is `undefined` (strict mode
 * off); any other value turns strict mode on and keeps only the entries
 * that are absolute paths for `os`. A non-array value keeps nothing. */
export function sanitizePeerExecutablePaths(
  raw: unknown,
  os: NodeJS.Platform = platform(),
): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) return [];
  if (raw.length === 0) return undefined;
  const paths = os === 'win32' ? win32 : posix;
  return (raw as unknown[]).filter(
    (p): p is string => typeof p === 'string' && p.length > 0 && paths.isAbsolute(p),
  );
}

/** What `JSON.stringify` leaves raw that a log line must not carry: DEL,
 * the C1 controls and the Unicode line separators. */
const UNPRINTABLE_IN_JSON = new RegExp(
  '[\\x7f-\\x9f' + String.fromCharCode(0x2028, 0x2029) + ']',
  'g',
);

/** An untrusted config value made safe and short for one warning line. */
function printableEntry(value: unknown): string {
  // The value comes from parsed JSON, so it always serializes.
  const text = JSON.stringify(value);
  const short = text.length > 80 ? `${text.slice(0, 80)}…` : text;
  return short.replace(
    UNPRINTABLE_IN_JSON,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/** Warnings already printed by this process: `loadConfig` runs on every
 * tool call and handshake, and one line per bad entry is enough. */
const warnedConfigLines = new Set<string>();

function warnOnce(line: string): void {
  if (warnedConfigLines.has(line)) return;
  warnedConfigLines.add(line);
  console.warn(line);
}

/** Read-side sanitizer for `allowedExtensionIds` (config.json is
 * untrusted): keeps the entries that are extension ids (exactly 32 letters
 * a-p), in order; every other entry, and a value that is not an array, is
 * dropped with a warning. Absent or null is no extra id. */
export function sanitizeAllowedExtensionIds(
  raw: unknown,
  warn: (line: string) => void = warnOnce,
): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    warn(
      `[browser-link] config.json allowedExtensionIds: ignored ${printableEntry(raw)} (expected an array of extension ids).`,
    );
    return [];
  }
  const ids: string[] = [];
  for (const entry of raw as unknown[]) {
    if (isExtensionId(entry)) {
      ids.push(entry);
    } else {
      warn(
        `[browser-link] config.json allowedExtensionIds: dropped ${printableEntry(entry)} (an extension id is exactly 32 letters a-p).`,
      );
    }
  }
  return ids;
}

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

/** The idle-disconnect TTL in effect, in minutes (`0` = never): the console's
 * value, or the 30-minute default when it was never set. What the server
 * pushes to the extension and what the console and the Admin window show. */
export function idleTtlMinutesInEffect(cfg: BrowserLinkConfig): number {
  return cfg.idleTtlMinutes === undefined
    ? DEFAULT_IDLE_TTL_MINUTES
    : clampIdleTtlMinutes(cfg.idleTtlMinutes);
}

/** Defaults applied at load time so consumers can read `cfg.multiAgent`
 * directly. Persisted form (see `normaliseForWrite`) only carries the field
 * when the user overrides the default, keeping the on-disk config minimal. */
const DEFAULT_MULTI_AGENT = true;
const DEFAULT_AUTO_REELECT = true;
const DEFAULT_CDP_DIRECT_ENABLED = false;
const DEFAULT_INSTRUCTIONS_AUTO_REFRESH = true;

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
  // Only an explicit boolean false turns the refresh off; anything else in a
  // hand-edited file reads as the default.
  const instructionsAutoRefresh = cfg.instructionsAutoRefresh !== false;
  // Only an explicit boolean true counts as acknowledged.
  const noticeAcknowledged = cfg.noticeAcknowledged === true;
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
  // idleTtlMinutes stays undefined when never set, so config.json keeps only
  // what the user chose (`idleTtlMinutesInEffect` reads it as 30). When
  // present, clampIdleTtlMinutes neutralizes a corrupted config.json the same
  // way sanitizeCdpPort does for the port.
  const idleTtlMinutes =
    cfg.idleTtlMinutes === undefined ? undefined : clampIdleTtlMinutes(cfg.idleTtlMinutes);
  // claimTtlMinutes: same rule as idleTtlMinutes, absent stays absent and a
  // present value is always a valid one (an invalid one reads as 10).
  const claimTtlMinutes =
    cfg.claimTtlMinutes === undefined ? undefined : clampClaimTtlMinutes(cfg.claimTtlMinutes);
  // Present only when strict mode is on, so `undefined` keeps meaning off.
  const peerExecutablePaths = sanitizePeerExecutablePaths(cfg.peerExecutablePaths);
  // Present only when at least one well-formed id is left.
  const allowedExtensionIds = sanitizeAllowedExtensionIds(cfg.allowedExtensionIds);
  const { peerExecutablePaths: _raw, allowedExtensionIds: _rawIds, ...rest } = cfg;
  return {
    ...rest,
    ...(peerExecutablePaths !== undefined ? { peerExecutablePaths } : {}),
    ...(allowedExtensionIds.length > 0 ? { allowedExtensionIds } : {}),
    multiAgent,
    autoReelect,
    cdpDirectEnabled,
    cdpDirectPort,
    cdpDirectGrantTtlMinutes,
    idleTtlMinutes,
    claimTtlMinutes,
    instructionsAutoRefresh,
    noticeAcknowledged,
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
  if (next.instructionsAutoRefresh === DEFAULT_INSTRUCTIONS_AUTO_REFRESH) {
    const { instructionsAutoRefresh: _omit8, ...rest8 } = next;
    next = rest8;
  }
  // The acknowledgement is written only as `true`; anything else is the
  // implicit "not acknowledged" state.
  if ('noticeAcknowledged' in next && next.noticeAcknowledged !== true) {
    const { noticeAcknowledged: _omit9, ...rest9 } = next;
    next = rest9;
  }
  return next;
}

/** The console language when config.json does not name one. */
export const DEFAULT_LANGUAGE: 'en' | 'es' = 'en';

/**
 * What reading config.json found. `missing` (no file) reads as the defaults,
 * as it always has. `unreadable` (the file exists but cannot be read, does
 * not parse as JSON, or is not a JSON object) carries no config at all, so
 * no caller can take it for the defaults: browser-link refuses to work
 * until the file is fixed or `browser-link config restore-defaults` runs.
 */
export type ConfigReadResult =
  | { readonly state: 'ok'; readonly path: string; readonly config: BrowserLinkConfig }
  | { readonly state: 'missing'; readonly path: string; readonly config: BrowserLinkConfig }
  | { readonly state: 'unreadable'; readonly path: string; readonly error: string };

/** The file and the reason it could not be read. */
export interface UnreadableConfig {
  readonly path: string;
  readonly error: string;
}

/** The one text every refusal shows (tool calls, the handshake log, CLI
 * commands, the Admin window, doctor): the file, the error, the two ways
 * out. One line, so it reads the same in a log. */
export function unreadableConfigMessage(problem: UnreadableConfig): string {
  return (
    `browser-link refuses to work: its config file ${problem.path} cannot be read (${problem.error}). ` +
    'It will not guess your settings (disabled tools, allowed extension ids, strict mode) from a broken file. ' +
    'Two ways out: fix the file by hand so it holds one JSON object, or run ' +
    '`browser-link config restore-defaults` to keep a copy of it and start again from the default settings.'
  );
}

/** Thrown by `loadConfig` and `saveConfig` while config.json is unreadable.
 * Its message is `unreadableConfigMessage`. */
export class ConfigUnreadableError extends Error {
  readonly path: string;
  readonly error: string;

  constructor(problem: UnreadableConfig) {
    super(unreadableConfigMessage(problem));
    this.name = 'ConfigUnreadableError';
    this.path = problem.path;
    this.error = problem.error;
  }
}

/** C0 and C1 controls, DEL and the Unicode line separators: a parse error
 * may quote the file, and the error ends up in one log line. */
const UNPRINTABLE_IN_ERROR = new RegExp(
  '[\\x00-\\x1f\\x7f-\\x9f' + String.fromCharCode(0x2028, 0x2029, 0xfeff) + ']',
  'g',
);
const MAX_ERROR_LENGTH = 300;

function printableError(err: unknown): string {
  const text = (err instanceof Error ? err.message : String(err)).replace(
    UNPRINTABLE_IN_ERROR,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
  return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH)}…` : text;
}

/** No file where config.json should be: ENOENT, or ENOTDIR when the data
 * directory itself is not a directory (both read as "missing" before). */
function isMissingFileError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function describeJsonValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

/** Read errors that can pass by themselves: another process (an antivirus
 * scan, a sync client, an editor saving) holds the file for a moment, or the
 * process is briefly out of file handles. */
const TRANSIENT_READ_CODES: ReadonlySet<string> = new Set([
  'EBUSY',
  'EPERM',
  'EACCES',
  'EMFILE',
  'ENFILE',
]);

/** How a transient read error is retried. `readPersisted` is synchronous
 * (many callers depend on that), so the wait blocks the thread. 5 tries with
 * 4 waits of 50 ms is at most about 200 ms: enough for a scanner or an editor
 * to let go, short enough that a permanently denied file (also EACCES) only
 * costs a fifth of a second before it is reported. Exported so tests inject
 * the read and the wait instead of sleeping. */
export const configReadRetry = {
  attempts: 5,
  waitMs: 50,
  readFile: (path: string): Buffer => readFileSync(path),
  sleep: (ms: number): void => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  },
};

/** The file's bytes. A transient error is retried; ENOENT, ENOTDIR and every
 * other error are thrown at once. After the last try the last error is thrown. */
function readBytesWithRetry(path: string): Buffer {
  const { attempts, waitMs, readFile, sleep } = configReadRetry;
  for (let attempt = 1; ; attempt++) {
    try {
      return readFile(path);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (attempt >= attempts || code === undefined || !TRANSIENT_READ_CODES.has(code)) throw err;
      sleep(waitMs);
    }
  }
}

type PersistedRead =
  | { readonly state: 'missing' }
  | { readonly state: 'ok'; readonly persisted: BrowserLinkConfig }
  | { readonly state: 'unreadable'; readonly error: string };

/** config.json as written on disk (before defaults), or why it is not there
 * or cannot be used. */
function readPersisted(path: string): PersistedRead {
  let raw: string;
  try {
    const bytes = readBytesWithRetry(path);
    // UTF-16 (a BOM of FF FE or FE FF) would only fail later as a baffling
    // parse error; say what is wrong and how to fix it.
    if (
      bytes.length >= 2 &&
      ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))
    ) {
      return {
        state: 'unreadable',
        error: 'the file is encoded as UTF-16; save it as UTF-8 (a UTF-8 byte order mark is fine)',
      };
    }
    raw = bytes.toString('utf8');
    // A UTF-8 byte order mark (Windows PowerShell 5, old Notepad) is not part
    // of the JSON; the next save writes the file without it.
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  } catch (err) {
    if (isMissingFileError(err)) return { state: 'missing' };
    return { state: 'unreadable', error: printableError(err) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (err) {
    return { state: 'unreadable', error: printableError(err) };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      state: 'unreadable',
      error: `expected a JSON object, found ${describeJsonValue(parsed)}`,
    };
  }
  // Untrusted shape: `withDefaults` and the sanitizers decide each field.
  return { state: 'ok', persisted: parsed };
}

/** Read config.json and say which of the three states it is in. */
export function readConfig(): ConfigReadResult {
  const path = configFile();
  const read = readPersisted(path);
  if (read.state === 'unreadable') return { state: 'unreadable', path, error: read.error };
  if (read.state === 'missing') return { state: 'missing', path, config: withDefaults({}) };
  return { state: 'ok', path, config: withDefaults(read.persisted) };
}

/** The effective configuration. A missing file is the defaults; an
 * unreadable one throws `ConfigUnreadableError`, never the defaults. */
export function loadConfig(): BrowserLinkConfig {
  const result = readConfig();
  if (result.state === 'unreadable') throw new ConfigUnreadableError(result);
  return result.config;
}

/** The only writer of config.json: a sibling temp file renamed over it, so a
 * reader in another process (the primary re-reads config on every tool
 * call) sees either the old file or the new one, never a truncated one. */
function writeConfigFile(path: string, persisted: BrowserLinkConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}-${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(persisted, null, 2) + '\n', 'utf8');
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** Merge `patch` into config.json. Throws `ConfigUnreadableError`, and
 * writes nothing, while the file is unreadable: a merge would replace it
 * with only the patched keys and lose the rest for good. */
export function saveConfig(patch: Partial<BrowserLinkConfig>): BrowserLinkConfig {
  const path = configFile();
  // Read the persisted form (pre-defaults) so merging the patch doesn't
  // accidentally promote a default into an explicit field on disk.
  const read = readPersisted(path);
  if (read.state === 'unreadable') throw new ConfigUnreadableError({ path, error: read.error });
  const persisted = read.state === 'ok' ? read.persisted : {};
  writeConfigFile(path, normaliseForWrite({ ...persisted, ...patch }));
  return loadConfig();
}

/**
 * Default of `activityHideSensitive` (owner decision D13): true hides the
 * value of a sensitive trail row in every column. PENDING the owner's
 * confirmation: he did not pick the default; hide is what the finding
 * recorded as the proposal. Changing it is this one line and its test in
 * `config.test.ts`.
 */
export const DEFAULT_ACTIVITY_HIDE_SENSITIVE = true;

/** Default of `hidePasswordValues` (owner decision D12): values are shown. */
export const DEFAULT_HIDE_PASSWORD_VALUES = false;

/** The in-effect `activityHideSensitive`: a boolean as written, anything
 * else (absent, a hand-edited string) the default. */
export function activityHidesSensitive(cfg: BrowserLinkConfig): boolean {
  return typeof cfg.activityHideSensitive === 'boolean'
    ? cfg.activityHideSensitive
    : DEFAULT_ACTIVITY_HIDE_SENSITIVE;
}

/** Default of `allowExecutableDownloads`: executable types are refused. */
export const DEFAULT_ALLOW_EXECUTABLE_DOWNLOADS = false;

/** The in-effect `allowExecutableDownloads`: only an explicit `true` allows
 * executable types; anything else (absent, a hand-edited string) refuses
 * them. */
export function allowsExecutableDownloads(cfg: BrowserLinkConfig): boolean {
  return cfg.allowExecutableDownloads === true;
}

/** The in-effect `hidePasswordValues`: a boolean as written, anything else
 * the default. */
export function hidesPasswordValues(cfg: BrowserLinkConfig): boolean {
  return typeof cfg.hidePasswordValues === 'boolean'
    ? cfg.hidePasswordValues
    : DEFAULT_HIDE_PASSWORD_VALUES;
}

/**
 * The value every persisted key has when config.json holds nothing, as the
 * code reads it: `withDefaults` applied to an empty config, then each
 * key's sanitizer or "only an explicit false turns it off" rule. A
 * `Record` over every key, so a new config field does not compile until it
 * is listed here. `undefined` means "not set" (the extension's own choice of
 * flow recording, strict mode off, the default downloads folder).
 */
export function defaultSettings(): Readonly<Record<keyof BrowserLinkConfig, unknown>> {
  const d = withDefaults({});
  return {
    peerExecutablePaths: d.peerExecutablePaths,
    allowedExtensionIds: d.allowedExtensionIds ?? [],
    disabledTools: sanitizeDisabledTools(d.disabledTools),
    multiAgent: d.multiAgent,
    autoReelect: d.autoReelect,
    cdpDirectEnabled: d.cdpDirectEnabled,
    cdpDirectPort: d.cdpDirectPort,
    cdpDirectGrantTtlMinutes: d.cdpDirectGrantTtlMinutes,
    idleTtlMinutes: idleTtlMinutesInEffect(d),
    idleTtlUpdatedAt: d.idleTtlUpdatedAt,
    claimTtlMinutes: claimTtlMinutesInEffect(d),
    language: d.language ?? DEFAULT_LANGUAGE,
    flowRecordingEnabled: d.flowRecordingEnabled,
    flowRecordingUpdatedAt: d.flowRecordingUpdatedAt,
    activityEnabled: d.activityEnabled !== false,
    activityRecordPayloads: d.activityRecordPayloads !== false,
    mapLearningEnabled: d.mapLearningEnabled !== false,
    hidePasswordValues: hidesPasswordValues(d),
    activityHideSensitive: activityHidesSensitive(d),
    downloadsDir: d.downloadsDir,
    downloadsMaxMb: sanitizeDownloadsMaxMb(d.downloadsMaxMb),
    allowExecutableDownloads: allowsExecutableDownloads(d),
    instructionsAutoRefresh: d.instructionsAutoRefresh,
    skipWelcome: d.skipWelcome === true,
    noticeAcknowledged: d.noticeAcknowledged,
  };
}

export type RestoreDefaultsResult =
  | {
      readonly restored: true;
      readonly path: string;
      /** Why the old file could not be read. */
      readonly error: string;
      /** Where the old file was copied, byte for byte. */
      readonly backupPath: string;
      /** What is in effect now: `defaultSettings()`. */
      readonly inEffect: Readonly<Record<keyof BrowserLinkConfig, unknown>>;
    }
  | { readonly restored: false; readonly state: 'ok' | 'missing'; readonly path: string };

/** `2026-11-11T10:20:30.123Z` as `2026-11-11T10-20-30-123Z`: no `:`, which
 * Windows does not allow in a file name. */
function fileTimestamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

/**
 * `browser-link config restore-defaults`: only while config.json is
 * unreadable, copy it to `config.json.unreadable-<timestamp>` next to it,
 * then write a fresh default config through the same atomic writer as
 * `saveConfig`. The copy never overwrites an existing file; when it cannot
 * be made, nothing is written. A readable or missing file is left as it is.
 */
export function restoreDefaultConfig(now: Date = new Date()): RestoreDefaultsResult {
  const path = configFile();
  const read = readPersisted(path);
  if (read.state !== 'unreadable') return { restored: false, state: read.state, path };
  const backupPath = `${path}.unreadable-${fileTimestamp(now)}`;
  try {
    copyFileSync(path, backupPath, constants.COPYFILE_EXCL);
  } catch (err) {
    throw new Error(
      `Could not keep a copy of ${path} at ${backupPath} (${printableError(err)}). Nothing was changed.`,
      { cause: err },
    );
  }
  writeConfigFile(path, normaliseForWrite({}));
  return { restored: true, path, error: read.error, backupPath, inEffect: defaultSettings() };
}
