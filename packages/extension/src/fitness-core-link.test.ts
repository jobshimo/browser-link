// @vitest-environment node
// Fitness: esbuild resolves a runtime import of @browser-link/core from the
// extension (design 2.2), and that import does not ship: core-link.check.ts
// is bundled here in memory, and no entry of build.mjs reaches it.
import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { coreLinkSession } from './core-link.check.js';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRIES = ['background', 'popup', 'activity', 'admin'];

async function bundledInputs(entryPoints: string[]): Promise<string[]> {
  const result = await build({
    absWorkingDir: packageDir,
    entryPoints,
    outdir: 'out',
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'chrome118',
    write: false,
    metafile: true,
    logLevel: 'silent',
  });
  return Object.keys(result.metafile.inputs).map((input) => input.replaceAll('\\', '/'));
}

describe('fitness: the runtime import of @browser-link/core', () => {
  it('bundles core-link.check.ts with core sources resolved through the workspace', async () => {
    const inputs = await bundledInputs(['src/core-link.check.ts']);
    expect(inputs).toContain('src/core-link.check.ts');
    expect(inputs.some((input) => input.endsWith('core/src/ports/contract/fakes.ts'))).toBe(true);
  });

  it('runs: the imported core value answers', async () => {
    await expect(coreLinkSession()).resolves.toEqual({ product: 'core-link' });
  });

  it('is reached by no bundle entry', async () => {
    const inputs = await bundledInputs(ENTRIES.map((name) => `src/${name}.ts`));
    expect(inputs.filter((input) => input.includes('core-link'))).toEqual([]);
  });
});
