import type { Messages } from './i18n.js';

/**
 * Version facts the popup shows, computed from what the server reported in
 * `tab.registered`. Pure on purpose: background.ts gathers the inputs, this
 * module decides, and popup.ts only renders.
 *
 * Three versions are in play:
 * - `extension`: this extension's manifest version.
 * - `server`: the version the running server booted with (`serverVersion`).
 * - `installed`: the package version on disk right now (`installedVersion`,
 *   servers from 0.41.0). When it is newer than `server`, the package was
 *   updated while an old process kept serving: the server is outdated.
 */

/**
 * Compare two versions by semver 2.0 precedence, like the server's
 * `utils/semver.ts` (the two must agree on which side is older):
 *  - a leading `v` and surrounding spaces are ignored;
 *  - the dotted numeric core is compared segment by segment (missing or
 *    non-numeric segments count as 0);
 *  - with equal cores, a pre-release (`1.1.0-rc.1`) ranks below the release;
 *  - two pre-releases compare identifier by identifier: numeric ones
 *    numerically, alphanumeric ones lexically in ASCII order, numeric below
 *    alphanumeric, and a shorter set below a longer one when the rest is equal;
 *  - build metadata (`+...`) is ignored.
 * Returns a negative number, 0 or a positive number like a sort comparator.
 */
export function compareSemver(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  const n = Math.max(pa.core.length, pb.core.length, 3);
  for (let i = 0; i < n; i += 1) {
    const diff = (pa.core[i] ?? 0) - (pb.core[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (pa.pre === null && pb.pre === null) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  return comparePrerelease(pa.pre, pb.pre);
}

const NUMERIC = /^\d+$/;

function parseVersion(version: string): { core: number[]; pre: string[] | null } {
  const noBuild = version.trim().replace(/^v/i, '').split('+', 1)[0] ?? '';
  const dash = noBuild.indexOf('-');
  const coreText = dash === -1 ? noBuild : noBuild.slice(0, dash);
  const preText = dash === -1 ? null : noBuild.slice(dash + 1);
  return {
    core: coreText.split('.').map((part) => {
      const n = Number.parseInt(part, 10);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    }),
    pre: preText === null || preText === '' ? null : preText.split('.'),
  };
}

function comparePrerelease(a: string[], b: string[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const ia = a[i] ?? '';
    const ib = b[i] ?? '';
    const na = NUMERIC.test(ia);
    const nb = NUMERIC.test(ib);
    if (na && nb) {
      const d = Number(ia) - Number(ib);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (na !== nb) {
      return na ? -1 : 1;
    } else if (ia !== ib) {
      return ia < ib ? -1 : 1;
    }
  }
  return a.length - b.length;
}

export interface VersionCheckInput {
  extension: string;
  server: string | null;
  installed: string | null;
}

/** What background.ts answers to the popup's `versionCheck`. `extension`,
 * `server` and `aligned` keep their pre-0.41.0 meaning; `installed` and
 * `serverOutdated` are additive. */
export interface VersionCheck {
  extension: string;
  server: string | null;
  installed: string | null;
  /** Extension and server run the same version; null while no server has
   * reported one. */
  aligned: boolean | null;
  /** The installed package is newer than the code the server is running. */
  serverOutdated: boolean;
}

export function computeVersionCheck(input: VersionCheckInput): VersionCheck {
  const { extension, server, installed } = input;
  return {
    extension,
    server,
    installed,
    aligned: server === null ? null : server === extension,
    serverOutdated: server !== null && installed !== null && compareSemver(installed, server) > 0,
  };
}

/** The existing "Version mismatch" banner: shown only when a server version
 * is known and differs from the extension's. Unchanged by 0.41.0. */
export function shouldShowVersionBanner(check: VersionCheck): boolean {
  return check.server !== null && check.aligned === false;
}

/** "Server running X · installed Y" when the server runs a different version
 * than the one installed on disk; null when they match or either is unknown. */
export function runningInstalledLine(check: VersionCheck, t: Messages): string | null {
  if (check.server === null || check.installed === null) return null;
  if (check.installed === check.server) return null;
  return t.popupRunningInstalled(check.server, check.installed);
}

/** Which side runs older code, or null when there is no skew to report (no
 * server version yet, or the two compare equal). */
export type VersionSkew = 'extension-older' | 'extension-newer';

export function versionSkew(check: VersionCheck): VersionSkew | null {
  if (check.server === null) return null;
  const order = compareSemver(check.extension, check.server);
  return order < 0 ? 'extension-older' : order > 0 ? 'extension-newer' : null;
}

/** The release where a skew stops being harmless: from 1.1.0 an admin action
 * takes a `code` instead of `confirm`, `hide-password-values` exists, and the
 * extension holds a selector-mode download until the server settles it
 * (server CHANGELOG 1.1.0, Breaking). */
export const SKEW_BREAK_VERSION = '1.1.0';

/**
 * The banner line that says, plainly, which side is behind, what fixes it and
 * what does not work until then; null when there is no skew. Across 1.1.0 it
 * names the known breakage; otherwise the general effect.
 */
export function skewEffectLine(check: VersionCheck, t: Messages): string | null {
  const skew = versionSkew(check);
  if (skew === null || check.server === null) return null;
  const older = skew === 'extension-older' ? check.extension : check.server;
  const newer = skew === 'extension-older' ? check.server : check.extension;
  const crosses =
    compareSemver(older, SKEW_BREAK_VERSION) < 0 && compareSemver(newer, SKEW_BREAK_VERSION) >= 0;
  return skew === 'extension-older'
    ? t.popupSkewExtensionOlder(check.extension, check.server, crosses)
    : t.popupSkewExtensionNewer(check.extension, check.server, crosses);
}

/** The npm package the server is installed from. */
export const SERVER_PACKAGE = '@jobshimo/browser-link';

/**
 * The banner's action. Reloading the extension (the chrome://extensions
 * button) helps only when the extension is the older side or the direction
 * is unknown; when the extension is newer, the server is what must change,
 * so the banner shows how to update and restart it instead.
 */
export function versionBannerAction(check: VersionCheck): 'open-extensions' | 'update-server' {
  return versionSkew(check) === 'extension-newer' ? 'update-server' : 'open-extensions';
}

/** The update-the-server instruction for an extension newer than the server;
 * null otherwise. */
export function updateServerLine(check: VersionCheck, t: Messages): string | null {
  if (versionBannerAction(check) !== 'update-server') return null;
  return t.popupUpdateServer(`npm install -g ${SERVER_PACKAGE}@${check.extension}`);
}
