// @vitest-environment node
// Fitness of core (design 5.3, item 2). Every production file of
// packages/core/src is parsed with the TypeScript API, and the test fails on
//   - an import that is not relative and not `@browser-link/shared` (npm or
//     a bare Node built-in), any `node:` import, any `chrome` identifier and
//     any `import(` (call or type);
//   - an import against the layers of `layers.ts` (5.2);
//   - any import cycle (Tarjan over the import graph, type-only included).
// Each rule has a RED fixture under `fixtures/`, a miniature core tree that
// the same function must reject with that rule and no other.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { LAYERS, ROOT_FOLDER } from './layers.js';

type Rule =
  | 'chrome-identifier'
  | 'node-import'
  | 'external-import'
  | 'dynamic-import'
  | 'unresolved-import'
  | 'unknown-folder'
  | 'layer'
  | 'cycle';

interface Violation {
  rule: Rule;
  file: string;
  detail: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, '..');
const FIXTURES = join(here, 'fixtures');
const SHARED = '@browser-link/shared';

/** Production files under `root`: `.ts`, not tests, not the fitness folder. */
function productionFiles(root: string, dir = root): string[] {
  const files: string[] = [];
  // Directory entries carry their type, so no path is stat'ed before it is read.
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    const { name } = entry;
    const path = join(dir, name);
    if (entry.isDirectory()) {
      if (relative(root, path) !== 'fitness') files.push(...productionFiles(root, path));
    } else if (entry.isFile() && name.endsWith('.ts') && !name.endsWith('.test.ts')) {
      files.push(path);
    }
  }
  return files;
}

const rel = (root: string, file: string): string => relative(root, file).replaceAll('\\', '/');
const folderOf = (relPath: string): string =>
  relPath.includes('/') ? relPath.slice(0, relPath.indexOf('/')) : ROOT_FOLDER;

/** Resolve against the files already listed, never by probing the file system. */
function resolveRelative(
  from: string,
  specifier: string,
  known: ReadonlySet<string>,
): string | null {
  const base = resolve(dirname(from), specifier);
  const candidates = [base.replace(/\.js$/, '.ts'), `${base}.ts`, join(base, 'index.ts')];
  return candidates.find((c) => known.has(c)) ?? null;
}

function layerAllows(fromRel: string, toRel: string): boolean {
  const from = folderOf(fromRel);
  const to = folderOf(toRel);
  if (from === ROOT_FOLDER || from === to) return true;
  return (LAYERS[from] ?? []).some((allowed) => allowed === to || allowed === toRel);
}

/** Strongly connected components with more than one file, or a self-import. */
function cycles(graph: Map<string, Set<string>>): string[][] {
  let index = 0;
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const found: string[][] = [];
  const visit = (node: string): void => {
    indices.set(node, index);
    low.set(node, index);
    index++;
    stack.push(node);
    onStack.add(node);
    for (const next of graph.get(node) ?? []) {
      if (!indices.has(next)) {
        visit(next);
        low.set(node, Math.min(low.get(node)!, low.get(next)!));
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node)!, indices.get(next)!));
      }
    }
    if (low.get(node) === indices.get(node)) {
      const component: string[] = [];
      let member: string;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
      } while (member !== node);
      if (component.length > 1 || graph.get(node)?.has(node)) found.push(component.sort());
    }
  };
  for (const node of graph.keys()) if (!indices.has(node)) visit(node);
  return found;
}

function analyzeCore(root: string): { files: number; violations: Violation[] } {
  const files = productionFiles(root);
  const known = new Set(files);
  const violations: Violation[] = [];
  const graph = new Map<string, Set<string>>();
  for (const file of files) {
    const fileRel = rel(root, file);
    const report = (rule: Rule, detail: string): void => {
      violations.push({ rule, file: fileRel, detail });
    };
    const edges = new Set<string>();
    graph.set(fileRel, edges);
    if (folderOf(fileRel) !== ROOT_FOLDER && !(folderOf(fileRel) in LAYERS)) {
      report('unknown-folder', `${folderOf(fileRel)} is not in layers.ts`);
    }
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest);
    const onSpecifier = (specifier: string): void => {
      if (specifier.startsWith('node:')) return report('node-import', specifier);
      if (specifier === SHARED) return;
      if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
        return report('external-import', specifier);
      }
      const target = resolveRelative(file, specifier, known);
      if (target === null || relative(root, target).startsWith('..')) {
        return report('unresolved-import', specifier);
      }
      const targetRel = rel(root, target);
      edges.add(targetRel);
      if (!layerAllows(fileRel, targetRel)) report('layer', `${fileRel} -> ${targetRel}`);
    };
    const visit = (node: ts.Node): void => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        onSpecifier(node.moduleSpecifier.text);
      } else if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference) &&
        ts.isStringLiteral(node.moduleReference.expression)
      ) {
        onSpecifier(node.moduleReference.expression.text);
      } else if (
        (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) ||
        ts.isImportTypeNode(node)
      ) {
        report('dynamic-import', node.getText(source));
      } else if (ts.isIdentifier(node) && node.text === 'chrome') {
        report(
          'chrome-identifier',
          `line ${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`,
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  for (const component of cycles(graph)) {
    violations.push({ rule: 'cycle', file: component[0]!, detail: component.join(' -> ') });
  }
  return { files: files.length, violations };
}

describe('fitness: core architecture', () => {
  it('core imports neither chrome nor node, follows the layers and has no cycle', () => {
    const { files, violations } = analyzeCore(SRC);
    expect(files).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });

  // RED probes: fixture directory -> the one rule it must break.
  const RED: Record<string, Rule> = {
    'chrome-identifier': 'chrome-identifier',
    'node-import': 'node-import',
    'npm-import': 'external-import',
    'dynamic-import': 'dynamic-import',
    'policies-imports-flow': 'layer',
    'actions-imports-tools': 'layer',
    'ports-imports-support': 'layer',
    cycle: 'cycle',
  };

  it('every fixture directory has a RED probe', () => {
    expect(readdirSync(FIXTURES).sort()).toEqual(Object.keys(RED).sort());
  });

  for (const [fixture, rule] of Object.entries(RED)) {
    it(`RED: fixture ${fixture} fails with rule ${rule}`, () => {
      const { violations } = analyzeCore(join(FIXTURES, fixture));
      expect(violations.length).toBeGreaterThan(0);
      expect(new Set(violations.map((v) => v.rule))).toEqual(new Set([rule]));
    });
  }
});
