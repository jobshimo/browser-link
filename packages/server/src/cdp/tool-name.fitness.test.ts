import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, test } from 'vitest';
import { TOOL_REGISTRY } from '../generated/core/tools/catalog.js';

/*
 * FITNESS: cdp-direct decides nothing by a tool's name (design revision 9).
 * What a registered tool needs from the transport, it declares on its
 * registry entry (`requires`, `needs`, `commandTimeout`), and the transport
 * reads the entry. A tool-name check is a comparison (`===`, `!==`, `==`,
 * `!=`) between an expression named `tool` (`tool`, `msg.tool`) and a string
 * literal, in a production file under `cdp/` (tests excluded). Since slice
 * 18b `callCdpTool` has no `switch (tool)`: every wire tool runs through the
 * registry.
 */

const here = dirname(fileURLToPath(import.meta.url));

function productionFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return productionFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

const EQUALITY = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

const namedTool = (node: ts.Expression): boolean =>
  (ts.isIdentifier(node) && node.text === 'tool') ||
  (ts.isPropertyAccessExpression(node) && node.name.text === 'tool');

const isString = (node: ts.Expression): boolean =>
  ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);

/** `file: <comparison text>` for each tool-name check. */
function toolNameChecks(files: { file: string; text: string }[]): string[] {
  const found: string[] = [];
  for (const { file, text } of files) {
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (
        ts.isBinaryExpression(node) &&
        EQUALITY.has(node.operatorToken.kind) &&
        ((namedTool(node.left) && isString(node.right)) ||
          (namedTool(node.right) && isString(node.left)))
      ) {
        found.push(`${file}: ${node.getText()}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return found;
}

const transportText = readFileSync(join(here, 'transport.ts'), 'utf8');

describe('cdp-direct makes no tool-name checks (slice 15)', () => {
  test('no production file under cdp/ compares a tool name', () => {
    const files = productionFiles(here).map((path) => ({
      file: relative(here, path).split('\\').join('/'),
      text: readFileSync(path, 'utf8'),
    }));
    expect(files.some((f) => f.file === 'transport.ts')).toBe(true);
    expect(toolNameChecks(files)).toEqual([]);
  });

  test("RED: the slice 15 `tool === 'evaluate'` branch fails", () => {
    const probe = transportText.replace(
      "entry?.commandTimeout === 'call-budget'",
      "tool === 'evaluate'",
    );
    expect(probe).not.toBe(transportText);
    expect(toolNameChecks([{ file: 'transport.ts', text: probe }])).toEqual([
      "transport.ts: tool === 'evaluate'",
    ]);
  });

  test('RED: a reversed or property comparison fails too', () => {
    const probe = "export const a = (msg: { tool: string }) => 'screenshot' !== msg.tool;\n";
    expect(toolNameChecks([{ file: 'x.ts', text: probe }])).toEqual([
      "x.ts: 'screenshot' !== msg.tool",
    ]);
  });
});

/** `case` labels of a source that name a registered tool: every wire tool
 * runs through the registry (`dispatchTool`), so a tool `case` in the cdp
 * transport is tool logic left in the adapter. Same rule as the extension's
 * check on background.ts (slice 18b), applied to the server side. */
function toolCaseLabels(source: string, tools: ReadonlySet<string>): string[] {
  const sf = ts.createSourceFile('transport.ts', source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCaseClause(node) &&
      (ts.isStringLiteral(node.expression) ||
        ts.isNoSubstitutionTemplateLiteral(node.expression)) &&
      tools.has(node.expression.text)
    ) {
      found.push(`case '${node.expression.text}'`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

const REGISTERED_TOOLS: ReadonlySet<string> = new Set(TOOL_REGISTRY.keys());

describe('cdp transport has no tool case', () => {
  test('holds for the real transport.ts, against every registered tool', () => {
    expect(REGISTERED_TOOLS.has('flow')).toBe(true);
    expect(REGISTERED_TOOLS.has('evaluate')).toBe(true);
    expect(toolCaseLabels(transportText, REGISTERED_TOOLS)).toEqual([]);
  });

  test('a case that does not name a registered tool does not count', () => {
    expect(
      toolCaseLabels(
        "switch (failure.kind) {\n  case 'action':\n    break;\n}\n",
        REGISTERED_TOOLS,
      ),
    ).toEqual([]);
  });

  test('RED: a `switch (tool)` with tool cases fails', () => {
    expect(
      toolCaseLabels(
        "switch (tool) {\n  case 'evaluate':\n    break;\n  case `flow`:\n    break;\n}\n",
        REGISTERED_TOOLS,
      ),
    ).toEqual(["case 'evaluate'", "case 'flow'"]);
  });

  test('RED: a tool case appended to the real transport.ts fails', () => {
    const probe = `${transportText}\nexport function leak(tool: string): void {\n  switch (tool) {\n    case 'navigate':\n      break;\n  }\n}\n`;
    expect(toolCaseLabels(probe, REGISTERED_TOOLS)).toEqual(["case 'navigate'"]);
  });
});

// No hand-mirrored action handler: every `perform*` lives once in core's
// `actions/` (slices 10-14). Formerly guarded by transport-parity.test.ts,
// retired in slice 22.
function performDeclarations(source: string): string[] {
  const sf = ts.createSourceFile('probe.ts', source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  sf.forEachChild((node) => {
    if (ts.isFunctionDeclaration(node) && node.name && /^perform[A-Z]/.test(node.name.text)) {
      found.push(node.name.text);
    }
  });
  return found;
}

describe('cdp transport declares no perform* action', () => {
  test('holds for the real transport.ts', () => {
    expect(performDeclarations(transportText)).toEqual([]);
  });

  test('RED: a perform* function declared in transport.ts fails', () => {
    const probe = `${transportText}\nasync function performClick(client: unknown): Promise<void> {}\n`;
    expect(performDeclarations(probe)).toEqual(['performClick']);
  });
});
