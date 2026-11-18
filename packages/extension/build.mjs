// Bundles the extension's four entry points with esbuild into dist/.
//
// One ESM file per entry, named as before (background.js is the manifest's
// service worker; popup.js, activity.js and admin.js are the `src` of the
// three HTML pages), each with a linked source map next to it. No minify,
// so the output stays readable and the e2e can still patch the literal
// `const BRIDGE_PORT = 17529;` line in background.js. `tsc --noEmit` is the
// type check; this script only emits. copy-assets.mjs adds the manifest,
// the HTML pages and the icons afterwards. `contract/build.mjs` bundles the
// test-only in-worker contract run with the same options (BUNDLE_OPTIONS).

import { build } from 'esbuild';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, 'dist');

/** The extension's entry points; each becomes `dist/<name>.js`. */
const ENTRIES = ['background', 'popup', 'activity', 'admin'];

/** How every bundle of the extension's sources is compiled. */
export const BUNDLE_OPTIONS = {
  absWorkingDir: here,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome118',
  minify: false,
  sourcemap: 'linked',
  logLevel: 'warning',
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  // No stale output from an earlier tsc build (per-module .js and .d.ts).
  await rm(dist, { recursive: true, force: true });

  await build({
    ...BUNDLE_OPTIONS,
    entryPoints: Object.fromEntries(ENTRIES.map((name) => [name, `src/${name}.ts`])),
    outdir: dist,
  });

  console.log(`[browser-link/extension] bundled ${ENTRIES.join(', ')} into dist/`);
}
