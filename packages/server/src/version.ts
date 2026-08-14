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
