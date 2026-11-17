import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  adapterCoverageSummary,
  adapterRegions,
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

test('RED: an adapter with no function in the coverage is reported', () => {
  const coverage = [
    fn('createChromeCdpSession', 'function createChromeCdpSession', 2),
    fn('send', '(m) => m', 5),
    fn('onEvent', '(l) => l', 1),
  ];
  assert.deepEqual(uncalledAdapterFunctions(BUNDLE, coverage), [
    { file: 'src/adapters/system-clock.ts', name: '(no function reported)', line: 0, calls: 0 },
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
