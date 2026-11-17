import { describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/*
 * messages.ts is the server's wire-protocol contract: every server module
 * imports its types from it. Since slice 5c it re-exports the generated
 * mirror of packages/shared instead of carrying a hand copy, so this test
 * pins every name the hand copy exported (all of them types, no runtime
 * values) and fails when one stops being exported as a type.
 */

const here = dirname(fileURLToPath(import.meta.url));
const MESSAGES = join(here, 'messages.ts');

/** Every name messages.ts exported before slice 5c, all type-only. */
const TYPE_NAMES = [
  'TabId',
  'TabRegisterPayload',
  'TabRegisteredPayload',
  'TabRegisterMessage',
  'TabRegisteredMessage',
  'ToolRequestMessage',
  'ToolResponseMessage',
  'ToolCancelMessage',
  'SettingsUpdatePayload',
  'SettingsUpdateMessage',
  'BridgeEventMessage',
  'FlowRecordedPayload',
  'FlowRecordedMessage',
  'FlowRecordedResultMessage',
  'ActivityQueryPayload',
  'ActivityQueryMessage',
  'ActivityResultMessage',
  'ActivityStatsPayload',
  'ActivityPurgeMessage',
  'ActivityPurgeResultMessage',
  'BridgeRepairMessage',
  'BridgeRepairResultMessage',
  'AdminItemKind',
  'AdminOption',
  'AdminItem',
  'AdminSection',
  'AdminUiStrings',
  'AdminState',
  'AdminActionResult',
  'AdminRequestLanguage',
  'AdminDescribeMessage',
  'AdminActionMessage',
  'AdminStateMessage',
  'AdminActionResultMessage',
  'ExtensionToServer',
  'ServerToExtension',
];

/** Compile `file` with the TypeScript API: its diagnostics and the names it exports as types. */
function typeExports(file: string): { diagnostics: string[]; types: Set<string> } {
  const program = ts.createProgram([file], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    isolatedModules: true,
    skipLibCheck: true,
    noEmit: true,
    types: [],
  });
  const source = program.getSourceFile(file);
  if (!source) throw new Error(`could not load ${file}`);
  const diagnostics = ts
    .getPreEmitDiagnostics(program)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
  const checker = program.getTypeChecker();
  const types = new Set<string>();
  const moduleSymbol = checker.getSymbolAtLocation(source);
  for (const exported of moduleSymbol ? checker.getExportsOfModule(moduleSymbol) : []) {
    const target =
      exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    if (target.flags & ts.SymbolFlags.Type) types.add(exported.name);
  }
  return { diagnostics, types };
}

const missingFrom = (types: Set<string>) => TYPE_NAMES.filter((name) => !types.has(name));

describe('messages.ts exports (slice 5c)', () => {
  test('every type it exported before is still exported as a type, and it compiles', () => {
    const { diagnostics, types } = typeExports(MESSAGES);
    expect(diagnostics).toEqual([]);
    expect(missingFrom(types)).toEqual([]);
  });

  test('it still exports no runtime value', async () => {
    expect(Object.keys(await import('./messages.js'))).toEqual([]);
  });

  test('RED: the check reports a type that disappears', () => {
    const dir = mkdtempSync(join(tmpdir(), 'messages-exports-'));
    try {
      const file = join(dir, 'messages.ts');
      writeFileSync(file, 'export type TabId = string;\n');
      const { types } = typeExports(file);
      expect(missingFrom(types)).toEqual(TYPE_NAMES.filter((name) => name !== 'TabId'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
