// Derive results/a2-connect.json, a3-tools.json and a4-timing.json from the
// raw e2e-<label>.json files (probe + run1..run3). No measurement happens here.
// Usage: node summarize.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LAB_DIR } from './lib.mjs';

const labels = ['probe', 'run1', 'run2', 'run3'];
const runs = labels.map((l) => JSON.parse(readFileSync(join(LAB_DIR, `results/e2e-${l}.json`), 'utf8')));
const timed = runs.filter((r) => r.label !== 'probe');

const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const sd = Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / s.length);
  return { n: s.length, min: s[0], median: s[Math.floor(s.length / 2)], max: s[s.length - 1], mean: Math.round(mean), stdev: Math.round(sd) };
};

const a2 = {
  question: 'Connect a tab without a human: send the popup message from an extension page target',
  message_shape: runs[0].connect_message,
  sent_from: 'chrome-extension://<id>/popup.html opened with Target.createTarget, Runtime.evaluate of chrome.runtime.sendMessage(...)',
  per_run: runs.map((r) => ({
    label: r.label,
    response: r.connect_response,
    connect_ms: r.connect_ms,
    listed_by_list_tabs: r.calls.find((c) => c.tool === 'browser.list_tabs')?.ok ?? false,
    server_log_tab_registered: r.server_stderr_tail.find((l) => l.includes('Tab registered'))?.replace(/127\.0\.0\.1:\d+/, '127.0.0.1:<page-port>') ?? null,
  })),
  listed_tab_fields: runs[0].listed_tab_shape,
  handshake: 'accepted: headless chrome.exe owns the socket (peer-process check) and the worker sends Origin chrome-extension://<id>',
};

const tools = {};
for (const r of runs) {
  for (const c of r.calls) {
    const t = (tools[c.tool] ??= { ok: 0, fail: 0, ms: [], checks: new Set(), errors: [] });
    c.ok ? t.ok++ : t.fail++;
    t.ms.push(c.ms);
    if (c.check) t.checks.add(c.check);
    if (c.error) t.errors.push(c.error);
  }
}
const a3 = {
  question: 'Each tool through MCP stdio -> server -> WS bridge -> the BUILT extension in headless Chrome',
  runs: labels,
  browser: runs[0].browser,
  tools: Object.fromEntries(
    Object.entries(tools).map(([k, v]) => [
      k,
      { ok: v.ok, fail: v.fail, latency_ms: stats(v.ms), checks: [...v.checks], errors: v.errors },
    ]),
  ),
  note:
    'browser.evaluate and the two browser.wrap_up calls are setup for browser.read (a reader must be kept before read runs it). list_tabs latency includes polling until the tab appears.',
};

const phaseKeys = Object.keys(timed[0].phases);
const a4 = {
  question: 'Wall time of start Chrome + start server + connect + tool calls, 3 runs',
  runs: timed.map((r) => ({ label: r.label, all_ok: r.all_ok, total_ms: r.total_ms, teardown_ms: r.teardown_ms, phases_ms_from_start: r.phases })),
  total_ms: stats(timed.map((r) => r.total_ms)),
  to_calls_done_ms: stats(timed.map((r) => r.phases.calls_done)),
  phase_stats_ms: Object.fromEntries(phaseKeys.map((k) => [k, stats(timed.map((r) => r.phases[k]))])),
  failures: timed.filter((r) => !r.all_ok).length,
  probe_run_excluded: 'the probe run is not timed: it is the first run, and it wrote the owner HOME instruction files (see README)',
};

for (const [f, o] of [['a2-connect', a2], ['a3-tools', a3], ['a4-timing', a4]]) {
  writeFileSync(join(LAB_DIR, `results/${f}.json`), JSON.stringify(o, null, 2) + '\n');
}
console.log(JSON.stringify({ a3: Object.fromEntries(Object.entries(a3.tools).map(([k, v]) => [k, `${v.ok}/${v.ok + v.fail} med ${v.latency_ms.median}ms`])), a4: { total: a4.total_ms, calls_done: a4.to_calls_done_ms, mcp: a4.phase_stats_ms.mcp_initialized } }, null, 1));
