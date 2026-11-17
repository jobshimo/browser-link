// @vitest-environment node
// Fitness of the extension (design 5.3, item 3). Each rule runs on the real
// sources of packages/extension/src and on in-memory RED fixtures that the
// same function must reject.
//
//   - Zones: the worker zone is background.ts plus its transitive import
//     closure (type-only imports included); the UI zone is UI_ZONE. In the
//     worker zone `chrome` identifiers (AST identifiers: comments do not
//     count) appear only in adapters/** and background.ts; no worker-zone
//     module imports a UI-zone module; UI-zone modules import neither
//     background.ts, adapters/** nor app/**.
//   - Adapters stay free of logic: every function-like node in adapters/**
//     has a decision count of 0 (if, ?:, case, loops, catch, &&, ||; not
//     ?? or ?.), outside ADAPTER_EXEMPTIONS (at most three).
//   - background.ts stays within BACKGROUND_LINE_BUDGET (5.4).
//   - Wake listeners (R1): for every event of WAKE_SUBSCRIPTIONS,
//     background.ts holds a subscription as a top-level expression
//     statement; a mapped adapter method (resolved with the type checker) is
//     called only from such statements, and its body in the adapter is the
//     single addListener call (plus returning the unsubscribe), with no
//     await.
// The BRIDGE_PORT rule lives in fitness-bridge-port.test.ts. The rule "no
// tool `case` in background.ts" lands with slice 18.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/** Lowered by every slice that moves code out; never raised without arch sign-off. */
const BACKGROUND_LINE_BUDGET = 5035;

/** Scripts of the three HTML pages, and the module only they import. */
const UI_ZONE = ['popup.ts', 'activity.ts', 'admin.ts', 'ui-language.ts'];

/** Named logic-free exemptions: { file, fn, reason, test }; capped at three. */
const ADAPTER_EXEMPTIONS: readonly { file: string; fn: string; reason: string; test: string }[] =
  [];

interface AdapterMethod {
  /** The extension interface (in app/) that declares the method. */
  iface: string;
  method: string;
}

interface WakeSubscription {
  event: string;
  /** Callee texts that subscribe directly. */
  calls: readonly string[];
  /** Adapter methods that wrap the subscription (added by the slice that adds the adapter). */
  adapterMethods: readonly AdapterMethod[];
}

const wake = (event: string, adapterMethods: readonly AdapterMethod[] = []): WakeSubscription => ({
  event,
  calls: [`chrome.${event}.addListener`],
  adapterMethods,
});

/** The ten permanent registrations of section 1: eight distinct events. */
const WAKE_SUBSCRIPTIONS: readonly WakeSubscription[] = [
  wake('storage.onChanged'),
  wake('windows.onRemoved'),
  wake('debugger.onEvent'),
  wake('alarms.onAlarm'),
  wake('runtime.onMessage'),
  wake('tabs.onRemoved'),
  wake('tabs.onCreated'),
  wake('debugger.onDetach'),
];

type Sources = ReadonlyMap<string, string>;

const srcDir = dirname(fileURLToPath(import.meta.url));

/** Production modules of packages/extension/src: path relative to src -> text. */
function realSources(dir = srcDir): Map<string, string> {
  const files = new Map<string, string>();
  // Directory entries carry their type, so no path is stat'ed before it is read.
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const { name } = entry;
    const path = join(dir, name);
    if (entry.isDirectory()) {
      for (const [k, v] of realSources(path)) files.set(k, v);
    } else if (entry.isFile() && name.endsWith('.ts') && !name.endsWith('.test.ts')) {
      files.set(relative(srcDir, path).replaceAll('\\', '/'), readFileSync(path, 'utf8'));
    }
  }
  return files;
}

const parse = (path: string, text: string): ts.SourceFile =>
  ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);

/** Relative imports of a module resolved inside `files` (type-only and re-exports included). */
function importsOf(path: string, files: Sources): string[] {
  const found: string[] = [];
  const add = (specifier: string): void => {
    if (!specifier.startsWith('.')) return;
    const base = posix.normalize(posix.join(posix.dirname(path), specifier));
    const target = [base.replace(/\.js$/, '.ts'), `${base}.ts`, `${base}/index.ts`].find((c) =>
      files.has(c),
    );
    if (target !== undefined) found.push(target);
  };
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      add(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      add(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(path, files.get(path) ?? ''));
  return found;
}

function hasChromeIdentifier(path: string, text: string): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === 'chrome') found = true;
    else ts.forEachChild(node, visit);
  };
  visit(parse(path, text));
  return found;
}

const isAdapter = (path: string): boolean => path.startsWith('adapters/');
const isApp = (path: string): boolean => path.startsWith('app/');

function workerZone(files: Sources): Set<string> {
  const zone = new Set<string>();
  const queue = ['background.ts'];
  while (queue.length > 0) {
    const path = queue.pop()!;
    if (zone.has(path) || !files.has(path)) continue;
    zone.add(path);
    queue.push(...importsOf(path, files));
  }
  return zone;
}

function zoneViolations(files: Sources, uiZone: readonly string[] = UI_ZONE): string[] {
  const violations: string[] = [];
  const zone = workerZone(files);
  for (const path of [...zone].sort()) {
    if (
      path !== 'background.ts' &&
      !isAdapter(path) &&
      hasChromeIdentifier(path, files.get(path)!)
    ) {
      violations.push(`worker zone: ${path} names chrome outside adapters/** and background.ts`);
    }
    for (const target of importsOf(path, files)) {
      if (uiZone.includes(target))
        violations.push(`worker zone: ${path} imports UI-zone ${target}`);
    }
  }
  for (const path of uiZone) {
    if (!files.has(path)) continue;
    for (const target of importsOf(path, files)) {
      if (target === 'background.ts' || isAdapter(target) || isApp(target)) {
        violations.push(`UI zone: ${path} imports ${target}`);
      }
    }
  }
  return violations;
}

const DECISION_KINDS = new Set([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ConditionalExpression,
  ts.SyntaxKind.CaseClause,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.CatchClause,
]);
const DECISION_OPERATORS = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
]);

function functionName(node: ts.FunctionLikeDeclaration): string {
  if (node.name && ts.isIdentifier(node.name)) return node.name.text;
  const parent = node.parent;
  if (
    (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent)) &&
    ts.isIdentifier(parent.name)
  ) {
    return parent.name.text;
  }
  return '<anonymous>';
}

function adapterLogicViolations(files: Sources): string[] {
  const violations: string[] = [];
  for (const [path, text] of files) {
    if (!isAdapter(path)) continue;
    const countIn = (fn: ts.FunctionLikeDeclaration): number => {
      let decisions = 0;
      const visit = (node: ts.Node): void => {
        if (node !== fn && ts.isFunctionLike(node)) return;
        if (DECISION_KINDS.has(node.kind)) decisions++;
        if (ts.isBinaryExpression(node) && DECISION_OPERATORS.has(node.operatorToken.kind))
          decisions++;
        ts.forEachChild(node, visit);
      };
      visit(fn);
      return decisions;
    };
    const visit = (node: ts.Node): void => {
      if (
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node) ||
        ts.isConstructorDeclaration(node)
      ) {
        const name = functionName(node);
        const decisions = countIn(node);
        const exempt = ADAPTER_EXEMPTIONS.some((e) => e.file === path && e.fn === name);
        if (decisions > 0 && !exempt) {
          violations.push(`adapter ${path} ${name}: decision count ${decisions}, expected 0`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(parse(path, text));
  }
  return violations;
}

function lineCount(text: string): number {
  const lines = text.split('\n').length;
  return text.endsWith('\n') ? lines - 1 : lines;
}

function budgetViolations(background: string, budget = BACKGROUND_LINE_BUDGET): string[] {
  const lines = lineCount(background);
  return lines > budget ? [`background.ts has ${lines} lines, budget ${budget}`] : [];
}

/** A type-checked program over in-memory sources (no lib: only symbols matter). */
function virtualProgram(files: Sources): { program: ts.Program; root: string } {
  const root = '/virtual/';
  const key = (name: string): string => name.replaceAll('\\', '/').replace(/^.*\/virtual\//, '');
  const host: ts.CompilerHost = {
    getSourceFile: (name, languageVersion) => {
      const text = files.get(key(name));
      return text === undefined
        ? undefined
        : ts.createSourceFile(name, text, languageVersion, true);
    },
    getDefaultLibFileName: () => `${root}lib.d.ts`,
    writeFile: () => undefined,
    getCurrentDirectory: () => root,
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (name) => files.has(key(name)),
    readFile: (name) => files.get(key(name)),
  };
  const options: ts.CompilerOptions = {
    noLib: true,
    types: [],
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  };
  const program = ts.createProgram(
    [...files.keys()].map((k) => root + k),
    options,
    host,
  );
  return { program, root };
}

const calleeText = (call: ts.CallExpression): string =>
  call.expression.getText().replace(/\s+/g, '');

function wakeViolations(
  files: Sources,
  subscriptions: readonly WakeSubscription[] = WAKE_SUBSCRIPTIONS,
): string[] {
  const violations: string[] = [];
  const mapped = subscriptions.flatMap((s) =>
    s.adapterMethods.map((m) => ({ ...m, event: s.event })),
  );
  const checked = mapped.length > 0 ? virtualProgram(files) : null;
  const sourceOf = (path: string): ts.SourceFile =>
    checked?.program.getSourceFile(checked.root + path) ?? parse(path, files.get(path) ?? '');
  const checker = checked?.program.getTypeChecker();

  /** The mapped adapter method a call goes through, if any. */
  const adapterCall = (
    call: ts.CallExpression,
  ): (AdapterMethod & { event: string }) | undefined => {
    if (!checker || !ts.isPropertyAccessExpression(call.expression)) return undefined;
    const receiver = checker.getTypeAtLocation(call.expression.expression);
    const iface = (receiver.aliasSymbol ?? receiver.getSymbol())?.getName();
    const method = call.expression.name.text;
    return mapped.find((m) => m.iface === iface && m.method === method);
  };

  // 1. Every event has a top-level subscription in background.ts.
  const background = sourceOf('background.ts');
  const topLevel = background.statements.flatMap((statement) =>
    ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)
      ? [statement.expression]
      : [],
  );
  for (const subscription of subscriptions) {
    const subscribed = topLevel.some(
      (call) =>
        subscription.calls.includes(calleeText(call)) ||
        adapterCall(call)?.event === subscription.event,
    );
    if (!subscribed) {
      violations.push(`wake: ${subscription.event} has no top-level subscription in background.ts`);
    }
  }
  if (!checker) return violations;

  // 2. A mapped adapter method is called only from those top-level statements.
  for (const path of files.keys()) {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const via = adapterCall(node);
        if (via && !(path === 'background.ts' && topLevel.includes(node))) {
          violations.push(
            `wake: ${via.iface}.${via.method} called outside a top-level statement of background.ts (${path})`,
          );
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceOf(path));
  }

  // 3. Its adapter body is the single addListener call, with no await.
  const isAddListener = (node: ts.Node): boolean =>
    ts.isCallExpression(node) && /^chrome\..+\.addListener$/.test(calleeText(node));
  for (const path of [...files.keys()].filter(isAdapter)) {
    const visit = (node: ts.Node): void => {
      if (
        (ts.isMethodDeclaration(node) || ts.isPropertyAssignment(node)) &&
        ts.isIdentifier(node.name) &&
        ts.isObjectLiteralExpression(node.parent)
      ) {
        const contextual = checker.getContextualType(node.parent);
        const iface = (contextual?.aliasSymbol ?? contextual?.getSymbol())?.getName();
        const target = mapped.find((m) => m.iface === iface && m.method === node.name.getText());
        const fn = ts.isMethodDeclaration(node) ? node : node.initializer;
        if (target && ts.isFunctionLike(fn) && 'body' in fn && fn.body) {
          const body = fn.body;
          let awaits = false;
          const findAwait = (n: ts.Node): void => {
            if (ts.isAwaitExpression(n)) awaits = true;
            ts.forEachChild(n, findAwait);
          };
          findAwait(body);
          const statements = ts.isBlock(body) ? body.statements : null;
          const single = statements
            ? statements.length >= 1 &&
              statements.length <= 2 &&
              ts.isExpressionStatement(statements[0]!) &&
              isAddListener(statements[0].expression) &&
              (statements.length === 1 || ts.isReturnStatement(statements[1]!))
            : isAddListener(body);
          if (awaits || !single) {
            violations.push(
              `wake: adapter ${path} ${target.iface}.${target.method} is not a single addListener call`,
            );
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceOf(path));
  }
  return violations;
}

// ---------------------------------------------------------------- fixtures

/** A background.ts subscribing every wake event at top level, minus `omit`. */
function backgroundSource(omit: readonly string[] = [], extra = ''): string {
  const lines = WAKE_SUBSCRIPTIONS.filter((s) => !omit.includes(s.event)).map(
    (s) => `chrome.${s.event}.addListener(() => undefined);`,
  );
  return `${extra}\n${lines.join('\n')}\n`;
}

const ALARMS: AdapterMethod = { iface: 'Alarms', method: 'onFire' };
const ALARMS_MAP = WAKE_SUBSCRIPTIONS.map((s) =>
  s.event === 'alarms.onAlarm' ? { ...s, adapterMethods: [ALARMS] } : s,
);
const ALARMS_IFACE = 'export interface Alarms {\n  onFire(listener: () => void): void;\n}\n';
const alarmsAdapter = (body: string): string =>
  `import type { Alarms } from '../app/alarms.js';\nexport function chromeAlarms(): Alarms {\n  return {\n    ${body}\n  };\n}\n`;
const GOOD_ADAPTER = alarmsAdapter(
  'onFire(listener) {\n      chrome.alarms.onAlarm.addListener(listener);\n    },',
);
const backgroundWithAlarms = (extra: string): string =>
  backgroundSource(
    ['alarms.onAlarm'],
    `import { chromeAlarms } from './adapters/chrome-alarms.js';\nconst alarms = chromeAlarms();\n${extra}`,
  );

describe('fitness: extension zones', () => {
  const files = realSources();

  it('the UI zone list names existing modules', () => {
    expect(UI_ZONE.filter((path) => !files.has(path))).toEqual([]);
  });

  it('chrome stays in adapters/** and background.ts in the worker zone; the zones stay apart', () => {
    expect(workerZone(files).size).toBeGreaterThan(10);
    expect(zoneViolations(files)).toEqual([]);
  });

  it('a chrome mention in a comment does not count', () => {
    const fixture = new Map([
      ['background.ts', "import './helper.js';\n"],
      ['helper.ts', '// calls chrome.tabs.get in the adapter\nexport const x = 1;\n'],
    ]);
    expect(zoneViolations(fixture)).toEqual([]);
  });

  it('RED: chrome in a worker-zone module outside adapters/**', () => {
    const fixture = new Map([
      ['background.ts', "import { info } from './helper.js';\nvoid info;\n"],
      ['helper.ts', 'export const info = () => chrome.tabs.get(1);\n'],
      ['adapters/tabs.ts', 'export const get = () => chrome.tabs.get(1);\n'],
    ]);
    expect(zoneViolations(fixture)).toEqual([
      'worker zone: helper.ts names chrome outside adapters/** and background.ts',
    ]);
  });

  it('RED: a worker-zone module imports a UI-zone module', () => {
    const fixture = new Map([
      ['background.ts', "import type { Lang } from './ui-language.js';\nexport type L = Lang;\n"],
      ['ui-language.ts', 'export type Lang = string;\n'],
    ]);
    expect(zoneViolations(fixture)).toEqual([
      'worker zone: background.ts imports UI-zone ui-language.ts',
    ]);
  });

  it('RED: a UI-zone module imports background.ts, adapters/** or app/**', () => {
    const fixture = new Map([
      ['background.ts', 'export const BRIDGE_PORT = 1;\n'],
      [
        'popup.ts',
        "import { BRIDGE_PORT } from './background.js';\nimport { open } from './app/windows.js';\nvoid [BRIDGE_PORT, open];\n",
      ],
      ['admin.ts', "export { get } from './adapters/tabs.js';\n"],
      ['app/windows.ts', 'export const open = 1;\n'],
      ['adapters/tabs.ts', 'export const get = 1;\n'],
    ]);
    expect(zoneViolations(fixture)).toEqual([
      'UI zone: popup.ts imports background.ts',
      'UI zone: popup.ts imports app/windows.ts',
      'UI zone: admin.ts imports adapters/tabs.ts',
    ]);
  });
});

describe('fitness: adapters stay free of logic', () => {
  it('holds for the real adapters, with at most three exemptions', () => {
    expect(ADAPTER_EXEMPTIONS.length).toBeLessThanOrEqual(3);
    expect(adapterLogicViolations(realSources())).toEqual([]);
  });

  it('?? and ?. do not count', () => {
    const fixture = new Map([
      ['adapters/a.ts', 'export const read = (p?: { v?: number }) => ({ v: p?.v ?? 0 });\n'],
    ]);
    expect(adapterLogicViolations(fixture)).toEqual([]);
  });

  it('RED: an if, a ternary or a short-circuit in any adapter function body', () => {
    const fixture = new Map([
      [
        'adapters/a.ts',
        'export function guard(x: number) {\n  if (x > 0) return x;\n  return 0;\n}\n',
      ],
      [
        'adapters/b.ts',
        'export const make = () => ({\n  pick: (a: boolean, b: boolean) => a && b,\n});\n',
      ],
      ['adapters/c.ts', 'export const sign = (x: number) => (x > 0 ? 1 : -1);\n'],
    ]);
    expect(adapterLogicViolations(fixture)).toEqual([
      'adapter adapters/a.ts guard: decision count 1, expected 0',
      'adapter adapters/b.ts pick: decision count 1, expected 0',
      'adapter adapters/c.ts sign: decision count 1, expected 0',
    ]);
  });
});

describe('fitness: background.ts line budget', () => {
  it(`stays within ${BACKGROUND_LINE_BUDGET} lines`, () => {
    expect(budgetViolations(realSources().get('background.ts')!)).toEqual([]);
  });

  it('RED: one line over the budget', () => {
    expect(budgetViolations('a\nb\nc\n', 2)).toEqual(['background.ts has 3 lines, budget 2']);
  });
});

describe('fitness: wake listeners are registered synchronously at top level', () => {
  it('holds for the real background.ts, for every wake event', () => {
    expect(wakeViolations(realSources())).toEqual([]);
  });

  it('RED: a wake listener registered inside a function', () => {
    const fixture = new Map([
      [
        'background.ts',
        backgroundSource(
          ['alarms.onAlarm'],
          'function start() {\n  chrome.alarms.onAlarm.addListener(() => undefined);\n}\nstart();',
        ),
      ],
    ]);
    expect(wakeViolations(fixture)).toEqual([
      'wake: alarms.onAlarm has no top-level subscription in background.ts',
    ]);
  });

  it('a mapped adapter method called at top level of background.ts subscribes', () => {
    const fixture = new Map([
      ['background.ts', backgroundWithAlarms('alarms.onFire(() => undefined);')],
      ['app/alarms.ts', ALARMS_IFACE],
      ['adapters/chrome-alarms.ts', GOOD_ADAPTER],
    ]);
    expect(wakeViolations(fixture, ALARMS_MAP)).toEqual([]);
  });

  it('RED: a mapped adapter method called from app/ instead of the composition root', () => {
    const fixture = new Map([
      [
        'background.ts',
        backgroundWithAlarms("import { wire } from './app/connection.js';\nwire(alarms);"),
      ],
      ['app/alarms.ts', ALARMS_IFACE],
      [
        'app/connection.ts',
        "import type { Alarms } from './alarms.js';\nexport function wire(alarms: Alarms) {\n  alarms.onFire(() => undefined);\n}\n",
      ],
      ['adapters/chrome-alarms.ts', GOOD_ADAPTER],
    ]);
    expect(wakeViolations(fixture, ALARMS_MAP)).toEqual([
      'wake: alarms.onAlarm has no top-level subscription in background.ts',
      'wake: Alarms.onFire called outside a top-level statement of background.ts (app/connection.ts)',
    ]);
  });

  it('RED: an adapter method that awaits before subscribing', () => {
    const fixture = new Map([
      ['background.ts', backgroundWithAlarms('alarms.onFire(() => undefined);')],
      ['app/alarms.ts', ALARMS_IFACE],
      [
        'adapters/chrome-alarms.ts',
        alarmsAdapter(
          'async onFire(listener) {\n      await Promise.resolve();\n      chrome.alarms.onAlarm.addListener(listener);\n    },',
        ),
      ],
    ]);
    expect(wakeViolations(fixture, ALARMS_MAP)).toEqual([
      'wake: adapter adapters/chrome-alarms.ts Alarms.onFire is not a single addListener call',
    ]);
  });
});
