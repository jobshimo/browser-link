import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Package identity + version, resolved at runtime by reading the shipped
 * package.json. Works in both dev (`tsx src/cli.ts`) and installed
 * (`node_modules/@jobshimo/browser-link/dist/version.js`) layouts because
 * `package.json` always sits one directory above this module's parent in
 * either source tree (src/ or dist/).
 */
const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as {
  name: string;
  version: string;
};

export const PACKAGE_NAME: string = pkg.name;
export const VERSION: string = pkg.version;

/**
 * The version currently installed on disk, re-read from `package.json` on
 * every call. `VERSION` above is read once at boot, so it is the version
 * this process is RUNNING; after `npm install -g` replaces the files, the
 * two differ and the server knows it is outdated. `null` when the file
 * cannot be read or parsed. `pkgPath` exists for tests.
 */
export function readInstalledVersion(
  pkgPath: string = join(here, '..', 'package.json'),
): string | null {
  try {
    const data = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: unknown };
    return typeof data.version === 'string' ? data.version : null;
  } catch {
    return null;
  }
}
