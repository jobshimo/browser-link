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

import ts from 'typescript';

const MODULE_MARKER = /^\/\/ ((?:\.\.\/)*[\w./-]+\.[cm]?[jt]sx?)$/gm;
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
 * The adapter functions never called: missing from the coverage, or reported
 * with zero calls. `functions` is the `functions` array of the bundle's
 * entry in `Profiler.takePreciseCoverage`. Each problem is
 * `{ file, name, line, calls }` (`calls` 0); an empty list passes.
 */
export function uncalledAdapterFunctions(bundle, functions) {
  const problems = [];
  for (const region of adapterRegions(bundle)) {
    for (const f of callsPerFunction(bundle, region, functions)) {
      if ((f.calls ?? 0) > 0) continue;
      problems.push({ file: region.file, name: f.name, line: lineAt(bundle, f.start), calls: 0 });
    }
  }
  return problems;
}

/** One summary line per adapter: functions reached of functions found. */
export function adapterCoverageSummary(bundle, functions) {
  return adapterRegions(bundle).map((region) => {
    const statics = callsPerFunction(bundle, region, functions);
    const called = statics.filter((f) => (f.calls ?? 0) > 0).length;
    return `${region.file} ${String(called)}/${String(statics.length)}`;
  });
}
