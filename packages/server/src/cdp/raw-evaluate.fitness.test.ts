import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, test } from 'vitest';

/*
 * FITNESS: cdp-direct evaluates in the page through the page driver (core's
 * `session/page-driver.ts`, slice 9). No raw `Runtime.evaluate` is allowed:
 * the last one, the `evaluate` case of `callCdpTool`, moved onto the driver
 * in slice 15 (its `timeout_ms` is now the per-command timeout of the
 * session its evaluator sends through).
 *
 * A raw call site is a `'Runtime.evaluate'` string literal in a production
 * file under `cdp/` (tests excluded). The rule: there is none.
 */

interface RawEvaluateSite {
  /** File relative to `cdp/`, forward slashes. */
  file: string;
  /** The enclosing function, and the `case` label when inside one. */
  where: string;
}

const here = dirname(fileURLToPath(import.meta.url));

function productionFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return productionFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

function enclosing(node: ts.Node): string {
  let caseLabel: string | undefined;
  for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
    if (caseLabel === undefined && ts.isCaseClause(at)) caseLabel = at.expression.getText();
    if (ts.isFunctionDeclaration(at) && at.name) {
      return caseLabel === undefined ? at.name.text : `${at.name.text} case ${caseLabel}`;
    }
  }
  return caseLabel === undefined ? '<module>' : `<module> case ${caseLabel}`;
}

function rawEvaluateSites(files: { file: string; text: string }[]): RawEvaluateSite[] {
  const sites: RawEvaluateSite[] = [];
  for (const { file, text } of files) {
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (
        (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
        node.text === 'Runtime.evaluate'
      ) {
        sites.push({ file, where: enclosing(node) });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return sites;
}

function rawEvaluateViolations(sites: RawEvaluateSite[]): string[] {
  return sites.map((s) => `raw Runtime.evaluate outside the page driver: ${s.file}: ${s.where}`);
}

const transportText = readFileSync(join(here, 'transport.ts'), 'utf8');

describe('cdp-direct raw Runtime.evaluate (none since slice 15)', () => {
  test('no production file under cdp/ sends a raw Runtime.evaluate', () => {
    const files = productionFiles(here).map((path) => ({
      file: relative(here, path).split('\\').join('/'),
      text: readFileSync(path, 'utf8'),
    }));
    expect(files.some((f) => f.file === 'transport.ts')).toBe(true);
    expect(rawEvaluateViolations(rawEvaluateSites(files))).toEqual([]);
  });

  test('RED: a raw call site in the transport fails', () => {
    const probe = `${transportText}\nasync function probe(c: { send(m: string): Promise<unknown> }) {\n  return c.send('Runtime.evaluate');\n}\n`;
    expect(
      rawEvaluateViolations(rawEvaluateSites([{ file: 'transport.ts', text: probe }])),
    ).toEqual(['raw Runtime.evaluate outside the page driver: transport.ts: probe']);
  });

  test('RED: a raw call back in callCdpTool fails', () => {
    const probe = transportText.replace(
      'const entry = TOOL_REGISTRY.get(tool);',
      "const entry = TOOL_REGISTRY.get(tool);\n  void client.send('Runtime.evaluate', {});",
    );
    expect(probe).not.toBe(transportText);
    expect(
      rawEvaluateViolations(rawEvaluateSites([{ file: 'transport.ts', text: probe }])),
    ).toEqual(['raw Runtime.evaluate outside the page driver: transport.ts: callCdpTool']);
  });

  test('RED: a raw call in an adapter fails', () => {
    const probe =
      "export const send = (c: { send(m: string): Promise<unknown> }) => c.send('Runtime.evaluate');\n";
    expect(
      rawEvaluateViolations(
        rawEvaluateSites([{ file: 'adapters/cdp-client-session.ts', text: probe }]),
      ),
    ).toEqual([
      'raw Runtime.evaluate outside the page driver: adapters/cdp-client-session.ts: <module>',
    ]);
  });
});
