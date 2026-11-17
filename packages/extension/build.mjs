// Bundles the extension's four entry points with esbuild into dist/.
//
// One ESM file per entry, named as before (background.js is the manifest's
// service worker; popup.js, activity.js and admin.js are the `src` of the
// three HTML pages), each with a linked source map next to it. No minify,
// so the output stays readable and the e2e can still patch the literal
// `const BRIDGE_PORT = 17529;` line in background.js. `tsc --noEmit` is the
// type check; this script only emits. copy-assets.mjs adds the manifest,
// the HTML pages and the icons afterwards.

import { build } from 'esbuild';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, 'dist');

/** The extension's entry points; each becomes `dist/<name>.js`. */
const ENTRIES = ['background', 'popup', 'activity', 'admin'];

// No stale output from an earlier tsc build (per-module .js and .d.ts).
await rm(dist, { recursive: true, force: true });

await build({
  absWorkingDir: here,
  entryPoints: Object.fromEntries(ENTRIES.map((name) => [name, `src/${name}.ts`])),
  outdir: dist,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome118',
  minify: false,
  sourcemap: 'linked',
  logLevel: 'warning',
});

console.log(`[browser-link/extension] bundled ${ENTRIES.join(', ')} into dist/`);
