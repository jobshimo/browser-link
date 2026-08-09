import { compareSemver } from '../utils/semver.js';
import { PACKAGE_NAME, VERSION } from '../version.js';
import type { Language } from './welcome.js';

/**
 * Conservative subset of npm's official name grammar — lowercase ASCII,
 * digits, dash/underscore/dot, optional `@scope/` prefix. PACKAGE_NAME is
 * read from package.json at runtime; routing that string into a URL without
 * a validation gate would let a tampered package.json point the registry
 * lookup elsewhere. Refusing to query at all is the safer failure mode.
 */
const NPM_NAME_REGEX = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

export function assertSafeNpmName(name: string): string {
  if (!NPM_NAME_REGEX.test(name)) {
    throw new Error(
      `Refusing to query registry: package name "${name}" does not match the npm grammar.`,
    );
  }
  return name;
}

export interface UpdateInfo {
  current: string;
  latest: string | null;
  /** `null` means we could not reach the registry; check `error` for why. */
  newer: boolean | null;
  error?: string;
}

/**
 * Ask the npm registry for the `latest` dist-tag and compare it to the
 * version baked into this package. Network round-trip is one tiny GET.
 *
 * Compares plain MAJOR.MINOR.PATCH numerically. Pre-release suffixes
 * (`0.3.0-beta.1`) are not handled — current and latest are both expected
 * to be plain semver. If they are not, the comparison still produces a
 * consistent ordering, just not the semver-correct one.
 */
export async function checkUpdates(timeoutMs = 4000): Promise<UpdateInfo> {
  let safeName: string;
  try {
    safeName = assertSafeNpmName(PACKAGE_NAME);
  } catch (err) {
    return {
      current: VERSION,
      latest: null,
      newer: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  const url = `https://registry.npmjs.org/-/package/${safeName}/dist-tags`;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) {
      return {
        current: VERSION,
        latest: null,
        newer: null,
        error: `npm registry returned HTTP ${res.status}`,
      };
    }
    const body = (await res.json()) as { latest?: string };
    const latest = body.latest ?? null;
    if (!latest) {
      return {
        current: VERSION,
        latest: null,
        newer: null,
        error: 'registry response had no "latest" dist-tag',
      };
    }
    return { current: VERSION, latest, newer: isNewer(latest, VERSION) };
  } catch (err) {
    const reason =
      err instanceof Error
        ? err.name === 'AbortError'
          ? `timed out after ${timeoutMs}ms`
          : err.message
        : String(err);
    return { current: VERSION, latest: null, newer: null, error: reason };
  } finally {
    clearTimeout(timer);
  }
}

/** Wrap `compareSemver` so the registry-comparison call site keeps its
 * boolean shape. Plain semver triplets (no pre-release suffix) only —
 * non-numeric segments fall back to `0`, matching the shared util. */
function isNewer(latest: string, current: string): boolean {
  return compareSemver(latest, current) > 0;
}

interface UpdatesCliI18n {
  /** Prefix including colon + trailing whitespace so the version aligns. */
  currentLabel: string;
  /** Prefix including colon + trailing whitespace so the version aligns. */
  latestLabel: string;
  cantReach: string;
  upToDate: string;
  available: (cmd: string) => string;
}

const UPDATES_CLI_I18N: Record<Language, UpdatesCliI18n> = {
  en: {
    currentLabel: 'Current: ',
    latestLabel: 'Latest:  ',
    cantReach: 'Could not check the registry',
    upToDate: 'You are up to date.',
    available: (cmd) => `Update available. Run: ${cmd}`,
  },
  es: {
    currentLabel: 'Instalada: ',
    latestLabel: 'Última:    ',
    cantReach: 'No se pudo consultar el registry',
    upToDate: 'Estás en la última versión.',
    available: (cmd) => `Hay una actualización disponible. Corré: ${cmd}`,
  },
};

/** Plain-text formatter for the non-interactive `browser-link updates`. */
export function formatUpdate(info: UpdateInfo, language: Language = 'en'): string {
  const t = UPDATES_CLI_I18N[language];
  if (info.error || info.latest === null) {
    return [
      `${t.currentLabel}${info.current}`,
      `${t.cantReach}: ${info.error ?? 'unknown error'}`,
    ].join('\n');
  }
  if (info.newer) {
    return [
      `${t.currentLabel}${info.current}`,
      `${t.latestLabel}${info.latest}`,
      t.available(`npm install -g ${PACKAGE_NAME}@latest`),
    ].join('\n');
  }
  return [`${t.currentLabel}${info.current}`, `${t.latestLabel}${info.latest}`, t.upToDate].join(
    '\n',
  );
}
