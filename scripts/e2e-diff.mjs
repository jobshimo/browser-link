#!/usr/bin/env node
// Differential e2e check (design 7(b)): HEAD's harness drives the base build
// and HEAD's build, every tool call is recorded (E2E_RECORD), both records are
// normalised with the committed table (packages/e2e/src/normalise.mjs) and
// must be equal. A refactor that changes no behavior passes; any difference
// prints the first differing call with both values. Exit: 0 equal, 1 difference,
// 2 a harness run failed (HEAD or base), 3 setup error (git, install, build).
//
//   node scripts/e2e-diff.mjs [--base] <ref>   compare against merge-base(<ref>, HEAD)
//     --base-record <file>   reuse this normalised base record when it exists,
//                            write it there after a base run (CI cache)
//     --self-diff            also run HEAD twice and require equal records
//                            (normalise table completeness)
//   node scripts/e2e-diff.mjs --self-diff-only   two HEAD runs, no base
//     --ignore-scripts       pass --ignore-scripts to the base install (local
//                            Windows without the toolchain for native builds)
//     --behavior-change      the PR carries the `behavior-change` label. With
//                            --expected-labels, a difference passes only
//                            when it matches the list (below). Without a
//                            list there is no excuse: equal builds pass (a
//                            change only unit tests see), a difference fails
//                            and the summary asks for the line. A harness
//                            (2) or setup (3) failure always fails.
//     --expected-labels <list>   with --behavior-change only (ignored
//                            without it): comma-separated call labels or
//                            label prefixes (packages/e2e/src/
//                            expected-labels.mjs), taken by CI from the PR
//                            description's `Expected labels:` line after
//                            scripts/behavior-change-check.mjs validated it.
//                            The base run records those cases without
//                            asserting them (E2E_RECORD_ONLY), every other
//                            case still asserts; the base record is then
//                            never written to --base-record. The gate then
//                            compares per label: each entry must cover at
//                            least one differing call, and any differing
//                            call outside the list fails. The self-diff and
//                            the HEAD runs ignore the list.
//
// With GITHUB_STEP_SUMMARY set, the verdict and each difference are also
// written to the step summary.
//
// HEAD must already be built (`pnpm build`). The base is checked out with
// `git worktree add` in a temp dir, installed and built there, and the
// worktree is removed at the end whatever the outcome. In CI the ref is
// origin/<PR target branch>, so a stacked PR compares with the PR below it.
import { execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { entriesFor, isListed, parseLabelList } from '../packages/e2e/src/expected-labels.mjs';
import { canonical, normaliseRecord } from '../packages/e2e/src/normalise.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS = join(REPO, 'packages/e2e/src/run.mjs');

/** The first call where two normalised records differ, or null when equal:
 * `{ index, base, head }` with the whole call on each side (`undefined` when
 * one record has fewer calls), plus `path`, the first differing leaf. */
export function firstDifference(base, head) {
  const a = base.calls;
  const b = head.calls;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (i >= a.length || i >= b.length || canonical(a[i]) !== canonical(b[i])) {
      return { index: i, base: a[i], head: b[i], path: leafPath(a[i], b[i]) };
    }
  }
  if (canonical(base.ok) !== canonical(head.ok)) {
    return { index: a.length, base: { ok: base.ok }, head: { ok: head.ok }, path: 'ok' };
  }
  return null;
}

/** The path (`result.content[0].json.items[2]`) of the first leaf where two
 * values differ; '' when they differ at the root. */
export function leafPath(a, b, path = '') {
  if (canonical(a) === canonical(b)) return null;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    if (Array.isArray(a) !== Array.isArray(b)) return path;
    const keys = Array.isArray(a)
      ? Array.from({ length: Math.max(a.length, b.length) }, (_, i) => i)
      : [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const k of keys) {
      const sub = Array.isArray(a) ? `${path}[${String(k)}]` : path ? `${path}.${k}` : String(k);
      const found = leafPath(a[k], b[k], sub);
      if (found !== null) return found;
    }
  }
  return path;
}

/** What the gate prints for a difference (labels name the harness step). */
export function formatDifference(diff, names = ['base', 'head']) {
  const show = (v) => (v === undefined ? '(no such call)' : JSON.stringify(v, null, 2));
  const call = diff.base ?? diff.head;
  const label = call?.label ?? call?.tool ?? 'end of run';
  return [
    `e2e-diff: first difference at call #${String(diff.index)} (${String(label)})${
      diff.path ? `, at ${diff.path}` : ''
    }`,
    `--- ${names[0]}`,
    show(diff.base),
    `--- ${names[1]}`,
    show(diff.head),
  ].join('\n');
}

/** A record's calls grouped by label, each group in record order. */
export function callsByLabel(record) {
  const groups = new Map();
  for (const c of record?.calls ?? []) {
    const label = String(c?.label ?? c?.tool);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(c);
  }
  return groups;
}

/**
 * The per-label comparison of a behavior-change PR with an expected-labels
 * list (design 7(b), revision 14). Each label's calls are compared as a
 * group on both sides.
 * - `listed`: one row per entry with the labels it covers, their calls on
 *   each side and whether any of them differs. Calls are paired by position
 *   within a label; a pair counts as a difference only when the base call
 *   has a result (a tool result or an isError tool error) or threw a tool's
 *   own MCP error (thrownKind). A base call that threw transport noise (a
 *   timeout, a lost connection) never satisfies an entry and goes to
 *   `noise`. An entry with no counting difference (equal, noise only, or no
 *   call at all) is in `equalEntries`: the list names a change that did not
 *   happen.
 * - `unexpected`: the labels outside the list whose calls differ.
 * - `residual`: with every listed call removed, the first difference left
 *   (an unlisted call moved, added or dropped, or the runs' `ok`), else null.
 * `ok` holds only when every entry differs and nothing outside it does.
 */
export function expectedLabelsVerdict(base, head, entries) {
  const a = callsByLabel(base);
  const b = callsByLabel(head);
  const labels = [...new Set([...a.keys(), ...b.keys()])].sort();
  const differs = (label) => canonical(a.get(label) ?? []) !== canonical(b.get(label) ?? []);
  const noise = [];
  /** Whether a listed label differs through a base call that counts. */
  const listedDiffers = (label) => {
    const [ba, hb] = [a.get(label) ?? [], b.get(label) ?? []];
    let found = false;
    for (let i = 0; i < Math.max(ba.length, hb.length); i++) {
      if (canonical(ba[i]) === canonical(hb[i])) continue;
      if (baseCallCounts(ba[i])) found = true;
      else if (ba[i]?.thrown !== undefined) noise.push({ label, thrown: ba[i].thrown });
    }
    return found;
  };
  const listed = entries.map((entry) => {
    const covered = labels.filter((l) => entriesFor(l, [entry]).length > 0);
    return {
      entry,
      labels: covered,
      differs: covered.map(listedDiffers).some(Boolean),
      base: covered.flatMap((l) => a.get(l) ?? []),
      head: covered.flatMap((l) => b.get(l) ?? []),
    };
  });
  const equalEntries = listed.filter((row) => !row.differs).map((row) => row.entry);
  const unexpected = labels.filter((l) => !isListed(l, entries) && differs(l));
  const keep = (rec) => ({
    ok: rec?.ok,
    calls: (rec?.calls ?? []).filter((c) => !isListed(String(c?.label ?? c?.tool), entries)),
  });
  const residual = firstDifference(keep(base), keep(head));
  const ok = equalEntries.length === 0 && unexpected.length === 0 && residual === null;
  return { ok, listed, equalEntries, unexpected, residual, noise };
}

/** The MCP SDK's own transport codes: ConnectionClosed and RequestTimeout. */
const TRANSPORT_CODES = new Set(['-32000', '-32001']);

/**
 * What a recorded `thrown` (the MCP client's exception, run.mjs callTool)
 * is: `tool` when it is an McpError the server answered for this call
 * (`MCP error <code>: ...` with any code but the transport ones, for
 * example -32602 invalid params), `noise` when it is a transport timeout
 * (-32001), a lost connection (-32000) or not an McpError at all.
 */
export function thrownKind(text) {
  const m = /^MCP error (-?\d+):/.exec(String(text ?? ''));
  return m && !TRANSPORT_CODES.has(m[1]) ? 'tool' : 'noise';
}

/** A base call that can satisfy a listed label: it has a result and did not
 * throw, or it threw the tool's own McpError. */
function baseCallCounts(call) {
  if (!call) return false;
  if (call.thrown !== undefined) return thrownKind(call.thrown) === 'tool';
  return call.result !== undefined;
}

/** One call's outcome, short enough for a log line: its result, or what it
 * threw. */
function outcome(call) {
  const v = call.result ?? (call.thrown !== undefined ? { thrown: call.thrown } : null);
  const s = JSON.stringify(v);
  return s.length > 600 ? `${s.slice(0, 600)}... (${String(s.length)} chars)` : s;
}

/** What the gate prints for an expected-labels verdict: each entry with both
 * sides' results, then what fails it. */
export function formatExpectedLabels(verdict) {
  const lines = [
    `e2e-diff: expected labels: ${verdict.ok ? 'met' : 'NOT met'} (${String(verdict.listed.length)} listed)`,
  ];
  for (const row of verdict.listed) {
    lines.push(
      '',
      `listed ${row.entry}: ${row.differs ? 'differs' : 'EQUAL on base and head'}${
        row.labels.length ? ` (labels: ${row.labels.join(', ')})` : ' (no call has this label)'
      }`,
    );
    for (const [side, calls] of [
      ['base', row.base],
      ['head', row.head],
    ]) {
      lines.push(`--- ${side}`);
      if (calls.length === 0) lines.push('(no such call)');
      for (const c of calls) lines.push(`${String(c.label ?? c.tool)}: ${outcome(c)}`);
    }
  }
  if (verdict.equalEntries.length) {
    lines.push(
      '',
      `listed but equal (the list names a change that did not happen): ${verdict.equalEntries.join(', ')}`,
    );
  }
  if (verdict.unexpected.length) {
    lines.push('', `differing but not listed: ${verdict.unexpected.join(', ')}`);
  }
  if (verdict.residual) {
    lines.push('', 'outside the list:', formatDifference(verdict.residual));
  }
  for (const n of verdict.noise ?? []) {
    lines.push('', `noise (does not count for ${n.label}): the base call threw ${outcome(n)}`);
  }
  return lines.join('\n');
}

/** Exit codes: 0 equal, 1 the records differ, 2 a harness run failed (HEAD
 * or base; its record may still be compared and printed), 3 setup or
 * infrastructure error (arguments, git, install, build, worktree cleanup).
 * When several hold, the highest wins: a difference is only meaningful when
 * both harness runs passed and the setup worked. */
export const EXIT = { equal: 0, difference: 1, harness: 2, setup: 3 };

export function exitCode({ setupError = false, harnessFailed = false, differs = false }) {
  if (setupError) return EXIT.setup;
  if (harnessFailed) return EXIT.harness;
  if (differs) return EXIT.difference;
  return EXIT.equal;
}

const VERDICTS = ['ok', 'FAIL (difference)', 'FAIL (harness)', 'FAIL (setup)'];

/** The process exit code: the script's own code, except that a labelled PR
 * with an expected-labels list (`expected`, its verdict; `{ ok: false }`
 * when no verdict could be computed) passes a base-vs-HEAD difference only
 * when the verdict holds, and fails an equal run (every listed label must
 * differ). A labelled PR without a list gets no excuse: it passes when the
 * builds behave the same (a behavior change only unit tests see) and fails
 * on a difference, and the summary asks for the line. A self-diff difference
 * (two runs of HEAD: the normalise table is incomplete), a harness failure or
 * a setup error is never excused. Without the label the list is never read. */
export function gateExit(code, { behaviorChange = false, selfDiffers = false, expected } = {}) {
  if (!behaviorChange || selfDiffers || !expected) return code;
  if (code === EXIT.difference || code === EXIT.equal) {
    return expected.ok ? EXIT.equal : EXIT.difference;
  }
  return code;
}

/** Rule 6 of revision 14: a base record is written to the cache file only
 * when the base run passed while asserting every case. A record-only run
 * (an expected-labels list) is never cached, so no later run can reuse a
 * base record whose listed cases were never asserted. */
export function cacheBaseRecord({ passed, baseRecord, expectedEntries = [] }) {
  return passed && Boolean(baseRecord) && expectedEntries.length === 0;
}

/** The step summary: the verdict, what the label means for it, and each
 * difference report as printed in the log. */
export function summaryMarkdown({
  code,
  behaviorChange,
  selfDiffers = false,
  expected,
  differingLabels = [],
  reports,
}) {
  const lines = ['## e2e differential', ''];
  if (
    expected &&
    behaviorChange &&
    !selfDiffers &&
    (code === EXIT.difference || code === EXIT.equal)
  ) {
    lines.push(
      expected.ok
        ? 'Verdict: difference, accepted: the PR carries the `behavior-change` label and every difference is in its `Expected labels:` list.'
        : 'Verdict: FAIL (expected labels): a listed label did not differ, or a label outside the list did.',
    );
    if (expected.listed) {
      lines.push('', '### Expected labels', '');
      for (const row of expected.listed) {
        lines.push(`- \`${row.entry}\`: ${row.differs ? 'differs' : '**equal on base and head**'}`);
      }
      for (const n of expected.noise ?? []) {
        lines.push(`- noise on \`${n.label}\` (the base call threw, does not count)`);
      }
      lines.push('', '```text', formatExpectedLabels(expected), '```');
    }
  } else if (code === EXIT.difference && behaviorChange && !selfDiffers) {
    lines.push(
      `Verdict: ${VERDICTS[code]}. The PR carries the \`behavior-change\` label but its`,
      'description has no `Expected labels:` line: add one naming every call label',
      'that differs (for example `Expected labels: browser.drag.cdp`), then push or',
      'toggle the label to re-run the job.',
    );
    if (differingLabels.length) {
      lines.push('', `Differing labels: ${differingLabels.map((l) => `\`${l}\``).join(', ')}`);
    }
  } else if (code === EXIT.difference && selfDiffers) {
    lines.push(
      `Verdict: ${VERDICTS[code]}. Two runs of HEAD differ: the normalise table`,
      '(packages/e2e/src/normalise.mjs) is incomplete or the fixture is not',
      'deterministic. The `behavior-change` label does not excuse this.',
    );
  } else if (code === EXIT.difference) {
    lines.push(
      `Verdict: ${VERDICTS[code]}. A refactor must not change behavior; an intended`,
      'behavior change goes in its own PR with the `behavior-change` label, and its',
      'description names the expected difference.',
    );
  } else if (code === EXIT.equal) {
    lines.push('Verdict: ok: no difference.');
    if (behaviorChange) {
      lines.push(
        '',
        'The `behavior-change` label is set but the builds behave the same: check',
        'that the e2e covers the change the PR description names.',
      );
    }
  } else {
    lines.push(`Verdict: ${VERDICTS[code]}. See the job log.`);
  }
  for (const report of reports) lines.push('', '```text', report, '```');
  return `${lines.join('\n')}\n`;
}

/** An error of the setup (git, pnpm, arguments), not of the code under test. */
export class SetupError extends Error {}

export function parseArgs(argv) {
  const opts = { ref: undefined, baseRecord: undefined, selfDiff: false, selfDiffOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') opts.ref = argv[++i];
    else if (a === '--base-record') opts.baseRecord = resolve(argv[++i]);
    else if (a === '--self-diff') opts.selfDiff = true;
    else if (a === '--self-diff-only') opts.selfDiffOnly = true;
    else if (a === '--ignore-scripts') opts.ignoreScripts = true;
    else if (a === '--behavior-change') opts.behaviorChange = true;
    else if (a === '--expected-labels') {
      const { entries, error } = parseLabelList(argv[++i]);
      if (error) throw new SetupError(`--expected-labels: ${error}`);
      opts.expectedLabels = entries;
    } else if (!a.startsWith('--') && opts.ref === undefined) opts.ref = a;
    else throw new SetupError(`unknown argument: ${a}`);
  }
  if (!opts.selfDiffOnly && !opts.ref) {
    throw new SetupError('usage: e2e-diff.mjs [--base] <ref> [--base-record <file>] [--self-diff]');
  }
  return opts;
}

/** The expected labels this run uses: only with the behavior-change label,
 * and never for a self-diff-only run; otherwise the list is ignored. */
export function expectedEntriesFor(opts) {
  return opts.behaviorChange && !opts.selfDiffOnly ? (opts.expectedLabels ?? []) : [];
}

function git(args, cwd = REPO) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  } catch (e) {
    throw new SetupError(`git ${args.join(' ')} failed: ${String(e?.message ?? e)}`);
  }
}

function pnpm(args, cwd) {
  console.log(`e2e-diff: pnpm ${args.join(' ')} (in ${cwd})`);
  const r = spawnSync('pnpm', args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (r.status !== 0) throw new SetupError(`pnpm ${args.join(' ')} failed in ${cwd}`);
}

/** The environment of one harness run: the inherited one, minus what only
 * this script may decide (the step summary, E2E_EXPECT_FAIL and
 * E2E_RECORD_ONLY: a value set by hand on the runner never reaches a run),
 * plus the build's paths and the run's own record. E2E_RECORD_ONLY is set
 * from `recordOnly`, which only the base run gets. */
export function harnessEnv(inherited, { name, root, scratch, recordOnly = [] }) {
  const env = {
    ...inherited,
    E2E_RECORD: join(scratch, `${name}.raw.json`),
    E2E_RESULT_FILE: join(scratch, `${name}.result.json`),
    E2E_EXT_DIST: join(root, 'packages/extension/dist'),
    E2E_SERVER_CLI: join(root, 'packages/server/dist/cli.js'),
    E2E_SERVER_EXTENSION_ID: join(root, 'packages/server/dist/auth/extension-id.js'),
  };
  delete env.GITHUB_STEP_SUMMARY;
  delete env.E2E_EXPECT_FAIL;
  delete env.E2E_RECORD_ONLY;
  if (recordOnly.length) env.E2E_RECORD_ONLY = recordOnly.join(',');
  // A base build may predate the adapters the coverage check (R6) expects.
  env.E2E_ADAPTER_COVERAGE = '0';
  return env;
}

/** One harness run (HEAD's run.mjs) against the build rooted at `root`;
 * returns the normalised record (null when the run wrote none) and whether
 * the run passed. `recordOnly` (the expected labels) goes to the base run
 * only; every other run asserts every case. */
function harnessRun(name, root, scratch, recordOnly = []) {
  const raw = join(scratch, `${name}.raw.json`);
  const env = harnessEnv(process.env, { name, root, scratch, recordOnly });
  console.log(`e2e-diff: harness run "${name}" against ${root}`);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [HARNESS], { cwd: REPO, env, stdio: 'inherit' });
  console.log(`e2e-diff: run "${name}" exit ${String(r.status)} in ${String(Date.now() - t0)} ms`);
  if (!existsSync(raw)) {
    console.log(`e2e-diff: run "${name}" wrote no record (${raw})`);
    return { record: null, passed: false };
  }
  const normalised = normaliseRecord(JSON.parse(readFileSync(raw, 'utf8')));
  writeFileSync(join(scratch, `${name}.json`), `${JSON.stringify(normalised, null, 2)}\n`);
  if (r.status !== 0) console.log(`e2e-diff: the harness failed on "${name}"`);
  return { record: normalised, passed: r.status === 0 };
}

/** true when the two records differ (or one is missing); a difference's
 * report is printed and added to `reports` (the step summary). */
function differ(a, b, names, reports) {
  if (!a || !b) return true;
  const diff = firstDifference(a, b);
  if (!diff) {
    console.log(`e2e-diff: ${names[0]} and ${names[1]} equal (${String(a.calls.length)} calls)`);
    return false;
  }
  const report = formatDifference(diff, names);
  console.log(report);
  reports.push(report);
  return true;
}

function main() {
  const state = { setupError: false, harnessFailed: false, differs: false, selfDiffers: false };
  const reports = [];
  const opts = parseArgs(process.argv.slice(2));
  const expectedEntries = expectedEntriesFor(opts);
  if (!opts.behaviorChange && opts.expectedLabels?.length) {
    console.log('e2e-diff: --expected-labels ignored: no behavior-change label');
  }
  if (expectedEntries.length) {
    console.log(`e2e-diff: expected labels (base run record-only): ${expectedEntries.join(', ')}`);
  }
  let expected;
  let differingLabels = [];
  if (!existsSync(join(REPO, 'packages/server/dist/cli.js'))) {
    throw new SetupError('HEAD is not built; run pnpm build first');
  }
  const scratch = mkdtempSync(join(tmpdir(), 'bl-e2e-diff-'));
  console.log(`e2e-diff: records in ${scratch}`);
  let worktree;
  try {
    // Resolve the base first: a bad ref is a setup error before any run.
    const sha = opts.selfDiffOnly ? undefined : git(['merge-base', opts.ref, 'HEAD']);
    if (sha) console.log(`e2e-diff: base = merge-base(${opts.ref}, HEAD) = ${sha}`);
    const head = harnessRun('head', REPO, scratch);
    if (!head.passed) state.harnessFailed = true;
    if (opts.selfDiff || opts.selfDiffOnly) {
      const again = harnessRun('head-2', REPO, scratch);
      if (!again.passed) state.harnessFailed = true;
      if (differ(head.record, again.record, ['head', 'head-2'], reports)) {
        state.differs = true;
        state.selfDiffers = true;
      }
    }
    if (!opts.selfDiffOnly) {
      let base;
      if (opts.baseRecord && existsSync(opts.baseRecord)) {
        console.log(`e2e-diff: base record from ${opts.baseRecord}`);
        base = JSON.parse(readFileSync(opts.baseRecord, 'utf8'));
      } else {
        worktree = join(scratch, 'base');
        git(['worktree', 'add', '--detach', worktree, sha]);
        pnpm(
          ['install', '--frozen-lockfile', ...(opts.ignoreScripts ? ['--ignore-scripts'] : [])],
          worktree,
        );
        pnpm(['--config.verify-deps-before-run=false', 'build'], worktree);
        const run = harnessRun('base', worktree, scratch, expectedEntries);
        base = run.record;
        if (!run.passed) state.harnessFailed = true;
        else if (cacheBaseRecord({ ...run, baseRecord: opts.baseRecord, expectedEntries })) {
          mkdirSync(dirname(opts.baseRecord), { recursive: true });
          writeFileSync(opts.baseRecord, `${JSON.stringify(base, null, 2)}\n`);
        }
      }
      if (differ(base, head.record, ['base', 'head'], reports)) state.differs = true;
      if (expectedEntries.length && base && head.record) {
        expected = expectedLabelsVerdict(base, head.record, expectedEntries);
        const report = formatExpectedLabels(expected);
        console.log(report);
      } else if (opts.behaviorChange && base && head.record) {
        // Labelled without a list: name the labels the line would need.
        differingLabels = expectedLabelsVerdict(base, head.record, []).unexpected;
        if (differingLabels.length) {
          console.log(
            `e2e-diff: no Expected labels line; differing labels: ${differingLabels.join(', ')}`,
          );
        }
      }
    }
  } catch (e) {
    state.setupError = true;
    console.error(`e2e-diff: ${String(e?.message ?? e)}`);
  } finally {
    if (worktree) {
      try {
        git(['worktree', 'remove', '--force', worktree]);
        console.log(`e2e-diff: worktree ${worktree} removed`);
      } catch (e) {
        state.setupError = true;
        console.error(`e2e-diff: could not remove worktree ${worktree}: ${String(e.message)}`);
      }
    }
    if (process.env.E2E_DIFF_KEEP !== '1') rmSync(scratch, { recursive: true, force: true });
  }
  const code = exitCode(state);
  if (expectedEntries.length && !expected) expected = { ok: false };
  const gate = {
    behaviorChange: opts.behaviorChange === true,
    selfDiffers: state.selfDiffers,
    expected,
  };
  const exit = gateExit(code, gate);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      summaryMarkdown({ code, ...gate, differingLabels, reports }),
    );
  }
  console.log(`e2e-diff: ${VERDICTS[code]}, exit ${String(code)}`);
  if (exit !== code && exit === EXIT.equal) {
    console.log(
      'e2e-diff: difference accepted: every difference is in the expected labels, exit 0',
    );
  } else if (exit !== code) {
    console.log('e2e-diff: expected labels not met (see above), exit 1');
  } else if (code === EXIT.difference && gate.behaviorChange && !expected && !gate.selfDiffers) {
    console.log(
      'e2e-diff: behavior-change label without an Expected labels line: a difference fails; add the line',
    );
  }
  return exit;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = main();
  } catch (e) {
    console.error(`e2e-diff: ${String(e?.message ?? e)}`);
    process.exitCode = EXIT.setup;
  }
}
