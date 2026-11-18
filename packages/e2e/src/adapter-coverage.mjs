// R6 condition 1 (docs/design/service-worker-architecture.md, section 8):
// every function of every extension adapter (`packages/extension/src/
// adapters/*.ts`) must be called at least once while the e2e runs. run.mjs
// collects V8 precise coverage of the service worker through CDP
// (`Profiler.startPreciseCoverage` on the worker target, before the tab is
// connected; `Profiler.takePreciseCoverage` after the tool calls), and this
// module checks it against the bundle.
//
// The bundle (esbuild, unminified) opens each source module with a
// `// src/<path>.ts` line, so an adapter's code is the text from its marker
// to the next one. The functions to reach are found STATICALLY: the region
// is parsed (TypeScript's parser, a root devDependency) and every function,
// arrow and method in it is listed. Coverage alone is not enough: V8 omits a
// function that was never compiled, and the methods of an object built at
// module load (before coverage starts) are compiled only when first called,
// so an uncalled one is simply missing from the report. Each coverage entry
// belongs to the innermost listed function that contains its start; a listed
// function with no entry, or whose entry has zero calls, fails.
//
// The in-worker contract run (design section 8, R6, primary path; slice 19)
// reaches what the e2e cannot (`Alarms.set`, and `Alarms.onFire`, which
// background.ts calls at module load, before coverage starts): the e2e
// evaluates a test-only IIFE bundle of the adapters' contracts
// (packages/extension/contract/) in the worker. That bundle is built with the
// same esbuild options from the same adapter sources (`adapterSourceMismatches`
// checks the sources both source maps embed), so its adapter regions list the
// same functions in the same order; a shipped function counts as reached
// when it, or its counterpart in the contract bundle, was called. This proves
// that the same source compiled the same way ran, not the shipped bytes.

import ts from 'typescript';

// An IIFE bundle (the contract run) indents its module markers by two spaces.
const MODULE_MARKER = /^(?: {2})?\/\/ ((?:\.\.\/)*[\w./-]+\.[cm]?[jt]sx?)$/gm;
const ADAPTER_FILE = /^src\/adapters\/[\w.-]+\.ts$/;

/** The adapter modules of a bundle: `{ file, start, end }`, `end` exclusive,
 * offsets in UTF-16 code units like V8's coverage offsets. */
export function adapterRegions(bundle) {
  const markers = [...bundle.matchAll(MODULE_MARKER)].map((m) => ({
    file: m[1],
    start: m.index,
  }));
  return markers
    .map((marker, i) => ({
      file: marker.file,
      start: marker.start,
      end: i + 1 < markers.length ? markers[i + 1].start : bundle.length,
    }))
    .filter((region) => ADAPTER_FILE.test(region.file));
}

function lineAt(text, offset) {
  let line = 1;
  for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** A function's name for the report: its own, or the property, variable or
 * method it is assigned to. */
function nameOf(node) {
  if (node.name && ts.isIdentifier(node.name)) return node.name.text;
  const parent = node.parent;
  if (
    parent &&
    (ts.isPropertyAssignment(parent) || ts.isVariableDeclaration(parent)) &&
    ts.isIdentifier(parent.name)
  ) {
    return parent.name.text;
  }
  return '(anonymous)';
}

/** Every function-like node of an adapter region, as `{ name, start, end }`
 * in bundle offsets (start without leading trivia, like V8's). */
export function adapterFunctions(bundle, region) {
  const text = bundle.slice(region.start, region.end);
  const source = ts.createSourceFile(
    'region.js',
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const found = [];
  const visit = (node) => {
    if (ts.isFunctionLike(node) && 'body' in node && node.body) {
      found.push({
        name: nameOf(node),
        start: region.start + node.getStart(source),
        end: region.start + node.end,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** For each statically found function, the calls V8 reports for it: the
 * count of the coverage entry it holds innermost, or `undefined` when V8
 * reported none. */
function callsPerFunction(bundle, region, functions) {
  const statics = adapterFunctions(bundle, region).map((f) => ({ ...f, calls: undefined }));
  for (const fn of functions) {
    const first = fn.ranges?.[0];
    if (!first || first.startOffset < region.start || first.startOffset >= region.end) continue;
    const owner = statics
      .filter((f) => first.startOffset >= f.start && first.startOffset < f.end)
      .sort((x, y) => y.start - x.start)[0];
    if (owner) owner.calls = Math.max(owner.calls ?? 0, first.count);
  }
  return statics;
}

/**
 * Each adapter region of the shipped bundle with its functions, each marked
 * `byRun` (called while the e2e ran) and `byContract` (its counterpart in the
 * contract bundle was called). `contract` is `{ bundle, functions }` of the
 * contract run, or undefined. A region whose contract counterpart lists
 * other functions (by count or name) is reported in `shapeErrors`.
 */
function reach(bundle, functions, contract) {
  const contractRegions = new Map(
    contract
      ? adapterRegions(contract.bundle).map((region) => [
          region.file,
          callsPerFunction(contract.bundle, region, contract.functions),
        ])
      : [],
  );
  const shapeErrors = [];
  const regions = adapterRegions(bundle).map((region) => {
    const statics = callsPerFunction(bundle, region, functions);
    const counterpart = contractRegions.get(region.file);
    const sameShape =
      counterpart !== undefined &&
      counterpart.length === statics.length &&
      counterpart.every((f, i) => f.name === statics[i].name);
    if (counterpart !== undefined && !sameShape) shapeErrors.push(region.file);
    const fns = statics.map((f, i) => ({
      ...f,
      byRun: (f.calls ?? 0) > 0,
      byContract: sameShape && (counterpart[i].calls ?? 0) > 0,
    }));
    return { region, fns };
  });
  return { regions, shapeErrors };
}

/**
 * The adapter functions never called: missing from the coverage, or reported
 * with zero calls, by the run and by the contract run. `functions` is the
 * `functions` array of the bundle's entry in `Profiler.takePreciseCoverage`;
 * `contract`, optional, is `{ bundle, functions }` of the contract script.
 * Each problem is `{ file, name, line, calls }` (`calls` 0); an empty list
 * passes. A contract region whose functions differ from the shipped one's is
 * one problem named `(contract bundle lists other functions)`.
 */
export function uncalledAdapterFunctions(bundle, functions, contract) {
  const problems = [];
  const { regions, shapeErrors } = reach(bundle, functions, contract);
  for (const { region, fns } of regions) {
    if (shapeErrors.includes(region.file)) {
      const name = '(contract bundle lists other functions)';
      problems.push({ file: region.file, name, line: lineAt(bundle, region.start), calls: 0 });
    }
    for (const f of fns) {
      if (f.byRun || f.byContract) continue;
      problems.push({ file: region.file, name: f.name, line: lineAt(bundle, f.start), calls: 0 });
    }
  }
  return problems;
}

/** One summary line per adapter: functions reached of functions found, and
 * the ones only the contract run reached. */
export function adapterCoverageSummary(bundle, functions, contract) {
  return reach(bundle, functions, contract).regions.map(({ region, fns }) => {
    const called = fns.filter((f) => f.byRun || f.byContract).length;
    const onlyContract = fns.filter((f) => !f.byRun && f.byContract).map((f) => f.name);
    const note = onlyContract.length > 0 ? ` (in-worker contract: ${onlyContract.join(' ')})` : '';
    return `${region.file} ${String(called)}/${String(fns.length)}${note}`;
  });
}

const ADAPTER_SOURCE = /(?:^|\/)(src\/adapters\/[\w.-]+\.ts)$/;

/** `src/adapters/<name>.ts` -> the source a source map embeds for it. */
function adapterSources(map) {
  const sources = new Map();
  (map.sources ?? []).forEach((source, i) => {
    const m = ADAPTER_SOURCE.exec(source.replaceAll('\\', '/'));
    if (m) sources.set(m[1], map.sourcesContent?.[i]);
  });
  return sources;
}

/**
 * Every adapter source the contract bundle compiled is the one the shipped
 * bundle compiled, byte for byte, as each source map embeds it
 * (`sourcesContent`). Returns one message per mismatch; a contract bundle
 * that compiled no adapter is one too.
 */
export function adapterSourceMismatches(shippedMap, contractMap) {
  const shipped = adapterSources(shippedMap);
  const contract = adapterSources(contractMap);
  if (contract.size === 0) return ['the contract bundle compiled no adapter source'];
  const problems = [];
  for (const [file, text] of contract) {
    if (typeof text !== 'string') problems.push(`${file}: no embedded source in the contract map`);
    else if (!shipped.has(file)) problems.push(`${file}: not in the shipped bundle`);
    else if (shipped.get(file) !== text) problems.push(`${file}: differs from the shipped source`);
  }
  return problems;
}
