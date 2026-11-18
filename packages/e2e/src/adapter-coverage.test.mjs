import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  adapterCoverageSummary,
  adapterRegions,
  adapterSourceMismatches,
  uncalledAdapterFunctions,
} from './adapter-coverage.mjs';

// A bundle shaped like esbuild's output: module markers, then code.
const BUNDLE = [
  '// ../core/src/session/load-wait.ts',
  'function armLoadWait() {}',
  '// src/adapters/system-clock.ts',
  'var systemClock = { now: () => Date.now() };',
  '// src/adapters/chrome-cdp-session.ts',
  'function createChromeCdpSession(tabId) {',
  '  return { send: (m) => m, onEvent: (l) => l };',
  '}',
  '// src/background.ts',
  'createChromeCdpSession(1).send("x");',
  '',
].join('\n');

const at = (snippet) => {
  const i = BUNDLE.indexOf(snippet);
  assert.ok(i >= 0, snippet);
  return i;
};
const fn = (name, snippet, count) => ({
  functionName: name,
  ranges: [{ startOffset: at(snippet), endOffset: at(snippet) + snippet.length, count }],
  isBlockCoverage: false,
});

test('finds each adapter module between its marker and the next', () => {
  const regions = adapterRegions(BUNDLE);
  assert.deepEqual(
    regions.map((r) => r.file),
    ['src/adapters/system-clock.ts', 'src/adapters/chrome-cdp-session.ts'],
  );
  assert.ok(BUNDLE.slice(regions[1].start, regions[1].end).includes('onEvent'));
  assert.ok(!BUNDLE.slice(regions[1].start, regions[1].end).includes('background'));
});

test('every adapter function called: no problem', () => {
  const coverage = [
    fn('', BUNDLE, 1),
    fn('armLoadWait', 'function armLoadWait', 0),
    fn('now', '() => Date.now()', 3),
    fn('createChromeCdpSession', 'function createChromeCdpSession', 2),
    fn('send', '(m) => m', 5),
    fn('onEvent', '(l) => l', 1),
  ];
  assert.deepEqual(uncalledAdapterFunctions(BUNDLE, coverage), []);
  assert.deepEqual(adapterCoverageSummary(BUNDLE, coverage), [
    'src/adapters/system-clock.ts 1/1',
    'src/adapters/chrome-cdp-session.ts 3/3',
  ]);
});

test('RED: a method with zero calls is reported with its adapter and line', () => {
  const coverage = [
    fn('now', '() => Date.now()', 3),
    fn('createChromeCdpSession', 'function createChromeCdpSession', 2),
    fn('send', '(m) => m', 5),
    fn('onEvent', '(l) => l', 0),
  ];
  assert.deepEqual(uncalledAdapterFunctions(BUNDLE, coverage), [
    { file: 'src/adapters/chrome-cdp-session.ts', name: 'onEvent', line: 7, calls: 0 },
  ]);
});

test('RED: an adapter with no function in the coverage reports each function by name', () => {
  const coverage = [
    fn('createChromeCdpSession', 'function createChromeCdpSession', 2),
    fn('send', '(m) => m', 5),
    fn('onEvent', '(l) => l', 1),
  ];
  assert.deepEqual(uncalledAdapterFunctions(BUNDLE, coverage), [
    { file: 'src/adapters/system-clock.ts', name: 'now', line: 4, calls: 0 },
  ]);
});

test('non-adapter functions with zero calls do not count', () => {
  const coverage = [
    fn('armLoadWait', 'function armLoadWait', 0),
    fn('now', '() => Date.now()', 1),
    fn('createChromeCdpSession', 'function createChromeCdpSession', 1),
    fn('send', '(m) => m', 1),
    fn('onEvent', '(l) => l', 1),
  ];
  assert.deepEqual(uncalledAdapterFunctions(BUNDLE, coverage), []);
});

// Built at module load, before coverage starts: V8 reports only the methods
// that were called, so an uncalled one is absent rather than at zero.
const STORE_BUNDLE = [
  '// src/adapters/chrome-store.ts',
  'var chromeStore = {',
  '  list: () => chrome.storage.session.get(null).then(parse),',
  '  put: (record) => chrome.storage.session.set(record),',
  '  remove: (ids) => chrome.storage.session.remove(ids.map((id) => key(id))),',
  '};',
  '// src/background.ts',
  'chromeStore.list();',
  '',
].join('\n');

const storeFn = (name, snippet, count) => {
  const i = STORE_BUNDLE.indexOf(snippet);
  assert.ok(i >= 0, snippet);
  return {
    functionName: name,
    ranges: [{ startOffset: i, endOffset: i + snippet.length, count }],
    isBlockCoverage: false,
  };
};

test('RED: a method of a module-load object that is never called (absent from the coverage) fails', () => {
  const coverage = [
    storeFn('list', '() => chrome.storage.session.get(null)', 2),
    storeFn('put', '(record) =>', 1),
  ];
  assert.deepEqual(uncalledAdapterFunctions(STORE_BUNDLE, coverage), [
    { file: 'src/adapters/chrome-store.ts', name: 'remove', line: 5, calls: 0 },
    { file: 'src/adapters/chrome-store.ts', name: '(anonymous)', line: 5, calls: 0 },
  ]);
  assert.deepEqual(adapterCoverageSummary(STORE_BUNDLE, coverage), [
    'src/adapters/chrome-store.ts 2/4',
  ]);
});

test('every method of a module-load object called, its closure included: no problem', () => {
  const coverage = [
    storeFn('list', '() => chrome.storage.session.get(null)', 2),
    storeFn('put', '(record) =>', 1),
    storeFn('remove', '(ids) =>', 1),
    storeFn('', '(id) => key(id)', 3),
  ];
  assert.deepEqual(uncalledAdapterFunctions(STORE_BUNDLE, coverage), []);
  assert.deepEqual(adapterCoverageSummary(STORE_BUNDLE, coverage), [
    'src/adapters/chrome-store.ts 4/4',
  ]);
});

test('RED: an inner closure never called fails, though its method ran', () => {
  const coverage = [
    storeFn('list', '() => chrome.storage.session.get(null)', 2),
    storeFn('put', '(record) =>', 1),
    storeFn('remove', '(ids) =>', 1),
  ];
  assert.deepEqual(uncalledAdapterFunctions(STORE_BUNDLE, coverage), [
    { file: 'src/adapters/chrome-store.ts', name: '(anonymous)', line: 5, calls: 0 },
  ]);
});

// The shipped bundle (ESM) and the in-worker contract bundle (IIFE, markers
// indented): `set` and `onFire` run only in the contract.
const ALARMS_SOURCE = [
  'var chromeAlarms = {',
  '  set: async (name, when) => { await chrome.alarms.create(name, { when }); },',
  '  clear: async (name) => { await chrome.alarms.clear(name); },',
  '  onFire: (listener) => { chrome.alarms.onAlarm.addListener((alarm) => { listener(alarm.name); }); },',
  '};',
];
const SHIPPED = [
  '// src/adapters/chrome-alarms.ts',
  ...ALARMS_SOURCE,
  '// src/background.ts',
  'chromeAlarms.onFire(() => {});',
  '',
].join('\n');
const CONTRACT = [
  '(() => {',
  '  // src/adapters/chrome-alarms.ts',
  ...ALARMS_SOURCE.map((line) => `  ${line}`),
  '  // contract/entry.ts',
  '  globalThis.run = () => {};',
  '})();',
  '',
].join('\n');

const covered = (bundle, calls) =>
  Object.entries(calls).map(([snippet, count]) => {
    const i = bundle.indexOf(snippet);
    assert.ok(i >= 0, snippet);
    return { functionName: '', ranges: [{ startOffset: i, endOffset: i + 1, count }] };
  });

const SHIPPED_RUN = covered(SHIPPED, { 'async (name) =>': 1 });
const CONTRACT_RUN = covered(CONTRACT, {
  'async (name, when)': 1,
  'async (name) =>': 1,
  '(listener) =>': 1,
  '(alarm) =>': 2,
});

test('an indented module marker (IIFE bundle) opens a region too', () => {
  assert.deepEqual(
    adapterRegions(CONTRACT).map((r) => r.file),
    ['src/adapters/chrome-alarms.ts'],
  );
});

test('a function reached only by the in-worker contract run counts, and the summary names it', () => {
  assert.equal(uncalledAdapterFunctions(SHIPPED, SHIPPED_RUN).length, 3);
  const contract = { bundle: CONTRACT, functions: CONTRACT_RUN };
  assert.deepEqual(uncalledAdapterFunctions(SHIPPED, SHIPPED_RUN, contract), []);
  assert.deepEqual(adapterCoverageSummary(SHIPPED, SHIPPED_RUN, contract), [
    'src/adapters/chrome-alarms.ts 4/4 (in-worker contract: set onFire (anonymous))',
  ]);
});

test('RED: a function neither the run nor the contract called fails', () => {
  const contract = {
    bundle: CONTRACT,
    functions: covered(CONTRACT, { 'async (name, when)': 1, '(listener) =>': 1 }),
  };
  assert.deepEqual(uncalledAdapterFunctions(SHIPPED, SHIPPED_RUN, contract), [
    { file: 'src/adapters/chrome-alarms.ts', name: '(anonymous)', line: 5, calls: 0 },
  ]);
});

test('RED: a contract region listing other functions credits nothing', () => {
  const other = CONTRACT.replace(
    '  clear: async (name) => { await chrome.alarms.clear(name); },\n',
    '',
  );
  const contract = {
    bundle: other,
    functions: covered(other, { 'async (name, when)': 1, '(listener) =>': 1, '(alarm) =>': 1 }),
  };
  const problems = uncalledAdapterFunctions(SHIPPED, SHIPPED_RUN, contract);
  assert.deepEqual(
    problems.map((p) => p.name),
    ['(contract bundle lists other functions)', 'set', 'onFire', '(anonymous)'],
  );
});

const map = (sources) => ({
  sources: Object.keys(sources),
  sourcesContent: Object.values(sources),
});

test('the contract compiled the same adapter sources as the shipped bundle', () => {
  const shipped = map({ '../src/adapters/chrome-alarms.ts': 'A', '../src/background.ts': 'B' });
  const contract = map({ '../../repo/packages/extension/src/adapters/chrome-alarms.ts': 'A' });
  assert.deepEqual(adapterSourceMismatches(shipped, contract), []);
});

test('RED: an adapter source that differs, is missing from the shipped bundle, or no adapter at all', () => {
  const shipped = map({ '../src/adapters/chrome-alarms.ts': 'A' });
  assert.deepEqual(
    adapterSourceMismatches(
      shipped,
      map({ 'src/adapters/chrome-alarms.ts': 'A2', 'src/adapters/web-socket.ts': 'W' }),
    ),
    [
      'src/adapters/chrome-alarms.ts: differs from the shipped source',
      'src/adapters/web-socket.ts: not in the shipped bundle',
    ],
  );
  assert.deepEqual(adapterSourceMismatches(shipped, map({ 'contract/entry.ts': 'E' })), [
    'the contract bundle compiled no adapter source',
  ]);
});
