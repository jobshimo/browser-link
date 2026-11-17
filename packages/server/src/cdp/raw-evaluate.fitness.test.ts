import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, test } from 'vitest';

/*
 * FITNESS: cdp-direct evaluates in the page through the page driver (core's
 * `session/page-driver.ts`, slice 9). One raw `Runtime.evaluate` is allowed
 * to stay until slice 15 moves its tool case onto the driver: the
 * `evaluate` case of `callCdpTool`, whose `timeout_ms` is the client's own
 * per-command timeout and whose timeout error text reaches the agent.
 *
 * A raw call site is a `'Runtime.evaluate'` string literal in a production
 * file under `cdp/` (tests excluded). The rule: the sites are exactly
 * `ALLOWED_RAW_EVALUATE`. A second site fails (the exception cannot grow);
 * an entry whose site is gone fails as stale, so slice 15 deletes the entry
 * with the call (the exception cannot outlive it).
 */

interface RawEvaluateSite {
  /** File relative to `cdp/`, forward slashes. */
  file: string;
  /** The enclosing function, and the `case` label when inside one. */
  where: string;
}

const ALLOWED_RAW_EVALUATE: readonly (RawEvaluateSite & { removedBy: string })[] = [
  { file: 'transport.ts', where: "callCdpTool case 'evaluate'", removedBy: 'slice 15' },
];

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

/** Sites outside the allowlist, and allowlist entries with no site. */
function rawEvaluateViolations(sites: RawEvaluateSite[]): string[] {
  const key = (s: RawEvaluateSite): string => `${s.file}: ${s.where}`;
  const allowed = new Set(ALLOWED_RAW_EVALUATE.map(key));
  const found = sites.map(key);
  const extra = found.filter((k) => !allowed.has(k));
  const counted = found.filter((k) => allowed.has(k));
  const repeated = counted.filter((k, i) => counted.indexOf(k) !== i);
  const stale = [...allowed].filter((k) => !found.includes(k));
  return [
    ...extra.map((k) => `raw Runtime.evaluate outside the page driver: ${k}`),
    ...repeated.map((k) => `second raw Runtime.evaluate in the allowed place: ${k}`),
    ...stale.map((k) => `stale exception (the raw call is gone; delete its entry): ${k}`),
  ];
}

const transportText = readFileSync(join(here, 'transport.ts'), 'utf8');

describe('cdp-direct raw Runtime.evaluate (slice 9, removed by slice 15)', () => {
  test('the only raw call site is the allowed one', () => {
    const files = productionFiles(here).map((path) => ({
      file: relative(here, path).split('\\').join('/'),
      text: readFileSync(path, 'utf8'),
    }));
    expect(rawEvaluateViolations(rawEvaluateSites(files))).toEqual([]);
  });

  test('every exception names the slice that removes it', () => {
    for (const entry of ALLOWED_RAW_EVALUATE) expect(entry.removedBy).toMatch(/^slice \d+$/);
  });

  test('RED: a second raw call site fails', () => {
    const probe = `${transportText}\nasync function probe(c: { send(m: string): Promise<unknown> }) {\n  return c.send('Runtime.evaluate');\n}\n`;
    expect(
      rawEvaluateViolations(rawEvaluateSites([{ file: 'transport.ts', text: probe }])),
    ).toEqual(['raw Runtime.evaluate outside the page driver: transport.ts: probe']);
  });

  test('RED: a second raw call inside the allowed case fails', () => {
    const probe = transportText.replace(
      "case 'evaluate': {",
      "case 'evaluate': {\n      void client.send('Runtime.evaluate', {});",
    );
    expect(
      rawEvaluateViolations(rawEvaluateSites([{ file: 'transport.ts', text: probe }])),
    ).toEqual([
      "second raw Runtime.evaluate in the allowed place: transport.ts: callCdpTool case 'evaluate'",
    ]);
  });

  test('RED: the exception goes stale once the raw call is gone', () => {
    const probe = transportText.replace(/'Runtime\.evaluate'/g, "'Runtime.somethingElse'");
    expect(
      rawEvaluateViolations(rawEvaluateSites([{ file: 'transport.ts', text: probe }])),
    ).toEqual([
      "stale exception (the raw call is gone; delete its entry): transport.ts: callCdpTool case 'evaluate'",
    ]);
  });
});
