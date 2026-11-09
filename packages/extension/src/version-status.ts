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
 * Compare two `major.minor.patch` versions numerically. A leading `v` and any
 * prerelease or build suffix are ignored; missing or non-numeric parts count
 * as 0. Returns a negative number, 0 or a positive number like a sort
 * comparator.
 */
export function compareSemver(a: string, b: string): number {
  const pa = semverParts(a);
  const pb = semverParts(b);
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function semverParts(version: string): number[] {
  const core = version.trim().replace(/^v/i, '').split(/[-+]/, 1)[0] ?? '';
  return core.split('.').map((part) => {
    const n = Number.parseInt(part, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  });
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
export function runningInstalledLine(check: VersionCheck): string | null {
  if (check.server === null || check.installed === null) return null;
  if (check.installed === check.server) return null;
  return `Server running ${check.server} · installed ${check.installed}`;
}
