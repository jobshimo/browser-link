// The tool-to-case table (tool-cases.mjs) against the server's catalogue and
// the harness: a tool with no case and no exemption, or a case run.mjs does
// not contain, fails here.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  CATALOGUE_FILE,
  EXEMPT,
  HARNESS_FILE,
  TOOL_CASES,
  catalogueTools,
  committedTableProblems,
  harnessCases,
  tableProblems,
  uncalledCases,
} from './tool-cases.mjs';

const tools = catalogueTools(readFileSync(CATALOGUE_FILE, 'utf8'));
const harness = harnessCases(readFileSync(HARNESS_FILE, 'utf8'));
const table = { tools, cases: TOOL_CASES, exempt: EXEMPT, harness };

test('the committed table covers every catalogue tool with a case in run.mjs or an exemption', () => {
  assert.deepEqual(committedTableProblems(), []);
});

test('the catalogue is read from permissions.ts, not copied', () => {
  assert.ok(tools.length >= 40, `only ${String(tools.length)} tools parsed`);
  assert.equal(new Set(tools).size, tools.length);
  for (const t of tools) assert.match(t, /^browser\.[a-z_]+(\.[a-z_]+)?$/);
  assert.ok(tools.includes('browser.click') && tools.includes('browser.map.rename_app'));
  assert.throws(() => catalogueTools('export const OTHER = [];'), /TOOL_CATALOGUE not found/);
});

test('a catalogue tool with neither a case nor an exemption fails', () => {
  const cases = { ...TOOL_CASES };
  delete cases['browser.drag'];
  assert.deepEqual(tableProblems({ ...table, cases }), [
    'browser.drag: no e2e case and no exemption',
  ]);
  const exempt = { ...EXEMPT };
  delete exempt['browser.reset'];
  assert.deepEqual(tableProblems({ ...table, exempt }), [
    'browser.reset: no e2e case and no exemption',
  ]);
  // A new tool in the catalogue that nobody mapped.
  assert.deepEqual(tableProblems({ ...table, tools: [...tools, 'browser.new_tool'] }), [
    'browser.new_tool: no e2e case and no exemption',
  ]);
  // An empty case list counts as none.
  assert.deepEqual(tableProblems({ ...table, cases: { ...TOOL_CASES, 'browser.drag': [] } }), [
    'browser.drag: no e2e case and no exemption',
  ]);
});

test('a case that run.mjs does not contain fails', () => {
  const cases = { ...TOOL_CASES, 'browser.drag': ['browser.drag.no-such-case'] };
  assert.deepEqual(tableProblems({ ...table, cases }), [
    'browser.drag: case "browser.drag.no-such-case" is not in run.mjs',
  ]);
  // The same table against a harness whose drag case was removed.
  const src = readFileSync(HARNESS_FILE, 'utf8').replaceAll("'browser.drag'", "'removed'");
  assert.deepEqual(tableProblems({ ...table, harness: harnessCases(src) }), [
    'browser.drag: case "browser.drag" is not in run.mjs',
  ]);
});

test('stale entries, double entries and empty reasons fail', () => {
  assert.deepEqual(
    tableProblems({ ...table, exempt: { ...EXEMPT, 'browser.gone': 'removed tool' } }),
    ['browser.gone: not in TOOL_CATALOGUE'],
  );
  assert.deepEqual(
    tableProblems({ ...table, exempt: { ...EXEMPT, 'browser.drag': 'covered elsewhere' } }),
    ['browser.drag: both a case and an exemption'],
  );
  assert.deepEqual(tableProblems({ ...table, exempt: { ...EXEMPT, 'browser.reset': ' ' } }), [
    'browser.reset: exemption without a reason',
  ]);
});

test('harnessCases reads labels, tool names and expectError names', () => {
  const src = [
    "await call('browser.ping', {}, check);",
    "await call('browser.click', a, c, { label: 'browser.click.no-box' });",
    'await expectError(',
    "  'thrown',",
    "  'browser.evaluate',",
  ].join('\n');
  const cases = harnessCases(src);
  for (const name of ['browser.ping', 'browser.click.no-box', 'error.thrown']) {
    assert.ok(cases.has(name), name);
  }
  assert.equal(cases.has('error.browser.evaluate'), false);
});

test('a mapped case counts only when its tool was called under that case name', () => {
  const cases = {
    'browser.drag': ['browser.drag'],
    'browser.ping': ['browser.ping', 'wait_for_tab'],
  };
  const calls = [
    { tool: 'browser.drag' },
    { tool: 'browser.ping', label: 'browser.ping' },
    { tool: 'browser.ping', label: 'wait_for_tab' },
  ];
  assert.deepEqual(uncalledCases(calls, cases), []);
  // The literal exists in run.mjs but another tool made the call under it.
  assert.deepEqual(uncalledCases([{ tool: 'browser.click', label: 'browser.drag' }], cases), [
    'browser.drag: case "browser.drag" was never called',
    'browser.ping: case "browser.ping" was never called',
    'browser.ping: case "wait_for_tab" was never called',
  ]);
  // A call with a label is no longer the tool's own case.
  assert.deepEqual(
    uncalledCases([{ tool: 'browser.drag', label: 'other' }, ...calls.slice(1)], cases),
    ['browser.drag: case "browser.drag" was never called'],
  );
});
