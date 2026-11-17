// The sibling `clock.ts` and core's `ports/clock.ts` must declare the same
// port (design 5.1, slice 5b-1): the flow runner and expect read time
// through the sibling until slice 8 moves them to core. Test files are not
// part of `tsc --noEmit`, so this compiles a probe with the TypeScript API.
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = dirname(fileURLToPath(import.meta.url));
const PROBE = join(SRC, '__clock_probe__.ts');

/** Type errors of `source`, compiled as if it lived in this directory. */
function typeErrors(source: string): string[] {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    types: [],
  };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, ...rest) =>
    resolve(fileName) === PROBE
      ? ts.createSourceFile(fileName, source, languageVersion)
      : getSourceFile(fileName, languageVersion, ...rest);
  const program = ts.createProgram([PROBE], options, host);
  return ts
    .getPreEmitDiagnostics(program)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}

const assignBothWays = (sibling: string): string =>
  `${sibling}
import type { Clock as CoreClock } from '@browser-link/core';
declare const fromSibling: SiblingClock;
declare const fromCore: CoreClock;
export const toCore: CoreClock = fromSibling;
export const toSibling: SiblingClock = fromCore;
`;

describe('sibling clock.ts', () => {
  it("is mutually assignable with core's ports/clock.ts Clock", () => {
    expect(
      typeErrors(assignBothWays("import type { Clock as SiblingClock } from './clock.js';")),
    ).toEqual([]);
  });

  it('RED: a port missing `every` is not assignable to core', () => {
    const errors = typeErrors(
      assignBothWays(
        'interface SiblingClock { now(): number; sleep(ms: number): Promise<void>; after(ms: number, fn: () => void): () => void; }',
      ),
    );
    expect(errors.join('\n')).toContain("Property 'every' is missing");
  });
});
