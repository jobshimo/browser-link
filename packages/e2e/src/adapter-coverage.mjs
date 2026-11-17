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
// to the next one. V8 reports every function of a script that was compiled,
// called or not (count 0), including nameless ones, as long as the function
// around it ran; a factory never called is itself reported with count 0. So
// "every function whose start falls inside an adapter's region has a count
// above 0" covers the factory, the methods of the object it returns and any
// callback they pass, without parsing the source.

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

/**
 * The adapter functions the coverage shows as never called, and the adapter
 * modules with no function in the coverage at all. `functions` is the
 * `functions` array of the bundle's entry in `Profiler.takePreciseCoverage`.
 * Each problem is `{ file, name, line, calls }`; an empty list passes.
 */
export function uncalledAdapterFunctions(bundle, functions) {
  const regions = adapterRegions(bundle);
  const seen = new Map(regions.map((r) => [r.file, 0]));
  const problems = [];
  for (const fn of functions) {
    const first = fn.ranges?.[0];
    if (!first) continue;
    const region = regions.find((r) => first.startOffset >= r.start && first.startOffset < r.end);
    if (!region) continue;
    seen.set(region.file, seen.get(region.file) + 1);
    if (first.count === 0) {
      problems.push({
        file: region.file,
        name: fn.functionName || '(anonymous)',
        line: lineAt(bundle, first.startOffset),
        calls: 0,
      });
    }
  }
  for (const [file, count] of seen) {
    if (count === 0) problems.push({ file, name: '(no function reported)', line: 0, calls: 0 });
  }
  return problems;
}

/** One summary line per adapter: functions reached of functions reported. */
export function adapterCoverageSummary(bundle, functions) {
  return adapterRegions(bundle).map((region) => {
    const inside = functions.filter((fn) => {
      const at = fn.ranges?.[0]?.startOffset;
      return at !== undefined && at >= region.start && at < region.end;
    });
    const called = inside.filter((fn) => fn.ranges[0].count > 0).length;
    return `${region.file} ${String(called)}/${String(inside.length)}`;
  });
}
