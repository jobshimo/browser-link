// Bundles the test-only in-worker contract run (`entry.ts`; design section
// 8, R6) into `<outDir>/contract.js`, never into dist/: the same esbuild
// options as the shipped bundles (`../build.mjs` BUNDLE_OPTIONS), except
// `format: 'iife'` (the e2e evaluates it with `Runtime.evaluate`, which runs
// a script, not a module; no dynamic import, R2) and an external source map
// (no `sourceMappingURL` comment in the evaluated text). The source map's
// `sourcesContent` is what the e2e compares with background.js.map to show
// both bundles compiled the same adapter sources.
//
//   node contract/build.mjs <outDir>

import { build } from 'esbuild';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BUNDLE_OPTIONS } from '../build.mjs';

/** The `//# sourceURL` the e2e gives the evaluated script: its coverage URL. */
export const CONTRACT_SOURCE_URL = 'browser-link-contract.js';

/** Build the contract bundle into `outDir`; returns its script and map paths. */
export async function buildContract(outDir) {
  await build({
    ...BUNDLE_OPTIONS,
    entryPoints: { contract: 'contract/entry.ts' },
    outdir: outDir,
    format: 'iife',
    sourcemap: 'external',
  });
  return { script: join(outDir, 'contract.js'), map: join(outDir, 'contract.js.map') };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const outDir = process.argv[2];
  if (!outDir) throw new Error('usage: node contract/build.mjs <outDir>');
  const { script } = await buildContract(resolve(outDir));
  console.log(`[browser-link/extension] contract bundle in ${script}`);
}
