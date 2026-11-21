// Tool-to-case table (design 7(a)): every tool of the server's catalogue
// (packages/server/src/permissions.ts TOOL_CATALOGUE, read from the source,
// never copied) either has an e2e case in run.mjs or an explicit exemption
// with its reason. A case name is the call label run.mjs records (the tool
// name itself when a call has no label of its own). tool-cases.test.mjs fails
// when a catalogue tool has neither, and when a case named here is not in
// run.mjs. Cases ending in `.cdp` run on a cdp-direct tab (the server's second
// transport, run.mjs cdpDirectChecks); the others on the extension's tab.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = dirname(fileURLToPath(import.meta.url));
export const CATALOGUE_FILE = join(SRC, '../../server/src/permissions.ts');
export const HARNESS_FILE = join(SRC, 'run.mjs');

/** Tool -> the run.mjs cases that call it. */
export const TOOL_CASES = {
  'browser.list_tabs': ['browser.list_tabs', 'browser.list_tabs.cdp'],
  'browser.activity': [
    'browser.activity.sensitive',
    'browser.activity.error-sensitive',
    'browser.activity.error-sensitive.cdp',
  ],
  'browser.ping': ['browser.ping', 'wait_for_tab'],
  'browser.snapshot': ['browser.snapshot', 'browser.snapshot.cut', 'browser.snapshot.cdp'],
  'browser.find': ['browser.find', 'browser.find.cut', 'browser.find.cdp'],
  'browser.state': ['browser.state'],
  'browser.canvas_screenshot': [
    'browser.canvas_screenshot',
    'browser.canvas_screenshot.region',
    'browser.canvas_screenshot.cdp',
    'browser.canvas_screenshot.region.cdp',
  ],
  'browser.screenshot': ['browser.screenshot', 'browser.screenshot.viewport'],
  'browser.console': [
    'browser.console',
    'browser.console.error',
    'browser.console.warn',
    'browser.console.cdp',
    'browser.console.error.cdp',
    'browser.console.warn.cdp',
  ],
  'browser.network': ['browser.network', 'browser.network.cdp'],
  'browser.network_body': ['browser.network_body', 'browser.network_body.cdp'],
  'browser.wait_for': [
    'browser.wait_for',
    'error.timeout',
    'browser.wait_for.network',
    'browser.wait_for.network.cdp',
  ],
  'browser.wait_for_tab': [
    'browser.wait_for_tab',
    'browser.wait_for_tab.cdp',
    'browser.wait_for_tab.blank-link.cdp',
    'browser.wait_for_tab.unrelated.cdp',
    'browser.wait_for_tab.after-click.cdp',
    'browser.wait_for_tab.stale.cdp',
    'error.wait-for-tab-ambiguous.cdp',
  ],
  'browser.flow_status': [
    'browser.flow_status',
    'browser.flow_status.cancelled',
    'browser.flow_status.evicted',
  ],
  'browser.navigate': ['browser.navigate', 'browser.navigate.cdp'],
  'browser.click': [
    'browser.click',
    'browser.click.no-box',
    'browser.click.forced-no-box',
    'browser.click.settle-closed-shadow',
    'browser.click.settle-frames',
    'browser.click.settle-frames-late',
    'browser.click.after-scroll',
    'browser.click.frame-element',
    'browser.click.opens-dialog',
    'error.action',
    'browser.click.cdp',
    'error.action.cdp',
    'error.coerce.cdp',
    'browser.click.opens-dialog.cdp',
    'browser.click.opens-tab.cdp',
    'browser.click.blank-link.cdp',
    'browser.click.after-link.cdp',
    'browser.click.stale-link.cdp',
    'browser.click.two-a.cdp',
    'browser.click.two-b.cdp',
  ],
  'browser.type': [
    'browser.type',
    'browser.type.sensitive',
    'error.sensitive',
    'browser.type.cdp',
    'error.sensitive.cdp',
  ],
  'browser.press': ['browser.press'],
  'browser.drag': ['browser.drag', 'browser.drag.cdp'],
  'browser.flow': ['browser.flow', 'browser.flow.drag-step.cdp'],
  'browser.flow_cancel': ['browser.flow_cancel'],
  'browser.dialog_respond': [
    'browser.click.opens-dialog',
    'browser.download.stress-after-scroll',
    'browser.dialog_respond.cdp',
  ],
  'browser.set_permission': [
    'browser.set_permission',
    'browser.set_permission.cdp',
    'error.set_permission-name.cdp',
  ],
  'browser.download': [
    'browser.download.selector',
    'browser.download.url',
    'browser.download.unrelated',
    'browser.download.post',
    'browser.download.one-time',
    'browser.download.chunked',
    'browser.download.gzip',
    'browser.download.click-failed',
    'browser.download.stress-after-scroll',
  ],
  'browser.evaluate': [
    'browser.evaluate',
    'error.thrown',
    'browser.evaluate.cdp',
    'browser.evaluate.value.cdp',
    'browser.evaluate.coerce.cdp',
    'browser.evaluate.opened-tab.cdp',
    'browser.evaluate.linked-tab.cdp',
    'browser.evaluate.after-tab.cdp',
    'browser.evaluate.two-a.cdp',
    'browser.evaluate.two-b.cdp',
    'browser.evaluate.opener-acts.cdp',
    'browser.drag.drop-check.cdp',
    'browser.flow.drag-step.drop-check.cdp',
    'browser.evaluate.after-dialog.cdp',
    'browser.set_permission.read.cdp',
    'error.dialog-before-dial.cdp',
  ],
  'browser.read': ['browser.read'],
  'browser.wrap_up': ['browser.wrap_up'],
};

/** Tool -> why it has no e2e case. All of them run in the server alone: no
 * extension or Chrome code is on their path, so their unit tests cover them
 * and the differential (which compares extension behavior) has nothing to
 * see. */
export const EXEMPT = {
  'browser.claim_tab': 'server only: the claim registry, no extension message',
  'browser.release_tab': 'server only: the claim registry, no extension message',
  'browser.my_tabs': 'server only: reads the claim registry',
  'browser.manual': 'server only: static manual text',
  'browser.events': 'server only: the bridge lifecycle event log',
  'browser.feedback': 'server only: writes a local feedback record',
  'browser.reset':
    'server only: drops every connection, which would end the harness session itself',
  'browser.map.recall': 'server only: the persistent map store (SQLite)',
  'browser.map.apps': 'server only: the persistent map store (SQLite)',
  'browser.map.save': 'server only: the persistent map store (SQLite)',
  'browser.map.record_use': 'server only: the persistent map store (SQLite)',
  'browser.map.forget': 'server only: the persistent map store (SQLite)',
  'browser.map.rename_app': 'server only: the persistent map store (SQLite)',
};

/** The tool names of TOOL_CATALOGUE, parsed from permissions.ts source text
 * (the e2e package does not compile TypeScript). */
export function catalogueTools(src) {
  const start = src.indexOf('export const TOOL_CATALOGUE');
  if (start < 0) throw new Error('TOOL_CATALOGUE not found in permissions.ts');
  const end = src.indexOf('\n];', start);
  if (end < 0) throw new Error('end of TOOL_CATALOGUE not found in permissions.ts');
  return [...src.slice(start, end).matchAll(/\bname: '([^']+)'/g)].map((m) => m[1]);
}

/** The case names run.mjs source contains: every single-quoted literal (a
 * label, or a tool name used as its own label), plus `error.<name>` for each
 * `expectError('<name>', ...)`. */
export function harnessCases(src) {
  const cases = new Set([...src.matchAll(/'([^'\n]+)'/g)].map((m) => m[1]));
  for (const m of src.matchAll(/expectError\(\s*'([^']+)'/g)) cases.add(`error.${m[1]}`);
  return cases;
}

/** What is wrong with a table, as a list of messages (empty when sound). */
export function tableProblems({ tools, cases, exempt, harness }) {
  const problems = [];
  for (const tool of tools) {
    const has = (cases[tool]?.length ?? 0) > 0;
    if (!has && !exempt[tool]) problems.push(`${tool}: no e2e case and no exemption`);
    if (has && exempt[tool]) problems.push(`${tool}: both a case and an exemption`);
  }
  for (const tool of [...Object.keys(cases), ...Object.keys(exempt)]) {
    if (!tools.includes(tool)) problems.push(`${tool}: not in TOOL_CATALOGUE`);
  }
  for (const [tool, names] of Object.entries(cases)) {
    for (const name of names) {
      if (!harness.has(name)) problems.push(`${tool}: case "${name}" is not in run.mjs`);
    }
  }
  for (const [tool, why] of Object.entries(exempt)) {
    if (typeof why !== 'string' || why.trim() === '')
      problems.push(`${tool}: exemption without a reason`);
  }
  return problems;
}

/** The committed table checked against the real catalogue and harness. */
export function committedTableProblems() {
  return tableProblems({
    tools: catalogueTools(readFileSync(CATALOGUE_FILE, 'utf8')),
    cases: TOOL_CASES,
    exempt: EXEMPT,
    harness: harnessCases(readFileSync(HARNESS_FILE, 'utf8')),
  });
}

/** The mapped cases a run did not execute with their tool: `calls` are the
 * `{ tool, label }` of every tool call the run made (a call without a label
 * is its own case, named by the tool). A case named for a tool counts only
 * when that tool was called under that case name, so a literal in run.mjs
 * that nothing calls does not pass. */
export function uncalledCases(calls, cases = TOOL_CASES) {
  const seen = new Set(calls.map((c) => `${c.tool} | ${c.label ?? c.tool}`));
  const missing = [];
  for (const [tool, names] of Object.entries(cases)) {
    for (const name of names) {
      if (!seen.has(`${tool} | ${name}`)) missing.push(`${tool}: case "${name}" was never called`);
    }
  }
  return missing;
}
