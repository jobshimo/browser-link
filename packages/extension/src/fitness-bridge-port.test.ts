// @vitest-environment node
// Fitness: `background.ts` is the only bundled module that declares a
// top-level `BRIDGE_PORT`. esbuild renames a colliding top-level name when
// it bundles, and the e2e patches the literal BRIDGE_PORT line of
// dist/background.js; a second declaration would rename one of them and
// break that patch. The set of bundled modules comes from esbuild itself
// (the metafile of the same entries build.mjs bundles), so a module pulled
// in later by any entry is covered without editing this test.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRIES = ['background', 'popup', 'activity', 'admin'];

async function bundledModules(): Promise<string[]> {
  const result = await build({
    absWorkingDir: packageDir,
    entryPoints: ENTRIES.map((name) => `src/${name}.ts`),
    outdir: 'out',
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'chrome118',
    write: false,
    metafile: true,
    logLevel: 'silent',
  });
  return Object.keys(result.metafile.inputs).map((input) => join(packageDir, input));
}

/** Names declared at the top level of a module (variables, functions, classes). */
function topLevelNames(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest);
  const names: string[] = [];
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text);
      }
    } else if (
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
      statement.name
    ) {
      names.push(statement.name.text);
    }
  }
  return names;
}

describe('fitness: BRIDGE_PORT', () => {
  it('is declared at the top level of background.ts only, among the bundled modules', async () => {
    const modules = await bundledModules();
    expect(modules.length).toBeGreaterThan(ENTRIES.length);
    const declaring = modules
      .filter((file) => topLevelNames(file).includes('BRIDGE_PORT'))
      .map((file) => relative(packageDir, file).replaceAll('\\', '/'));
    expect(declaring).toEqual(['src/background.ts']);
  });
});
