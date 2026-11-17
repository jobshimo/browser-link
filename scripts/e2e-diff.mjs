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
//     --behavior-change      the PR carries the `behavior-change` label: a
//                            difference is still computed and printed, but
//                            exits 0; a harness (2) or setup (3) failure
//                            still fails. The PR description names the
//                            expected difference.
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

/** The process exit code: the script's own code, except that a base-vs-HEAD
 * difference passes when the PR carries the `behavior-change` label. A
 * self-diff difference (two runs of HEAD: the normalise table is incomplete),
 * a harness failure or a setup error is never excused. */
export function gateExit(code, { behaviorChange = false, selfDiffers = false } = {}) {
  return behaviorChange && !selfDiffers && code === EXIT.difference ? EXIT.equal : code;
}

/** The step summary: the verdict, what the label means for it, and each
 * difference report as printed in the log. */
export function summaryMarkdown({ code, behaviorChange, selfDiffers = false, reports }) {
  const lines = ['## e2e differential', ''];
  if (code === EXIT.difference && behaviorChange && !selfDiffers) {
    lines.push(
      'Verdict: difference, accepted: the PR carries the `behavior-change` label.',
      'The PR description must name this difference as the expected one.',
    );
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

function parseArgs(argv) {
  const opts = { ref: undefined, baseRecord: undefined, selfDiff: false, selfDiffOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') opts.ref = argv[++i];
    else if (a === '--base-record') opts.baseRecord = resolve(argv[++i]);
    else if (a === '--self-diff') opts.selfDiff = true;
    else if (a === '--self-diff-only') opts.selfDiffOnly = true;
    else if (a === '--ignore-scripts') opts.ignoreScripts = true;
    else if (a === '--behavior-change') opts.behaviorChange = true;
    else if (!a.startsWith('--') && opts.ref === undefined) opts.ref = a;
    else throw new SetupError(`unknown argument: ${a}`);
  }
  if (!opts.selfDiffOnly && !opts.ref) {
    throw new SetupError('usage: e2e-diff.mjs [--base] <ref> [--base-record <file>] [--self-diff]');
  }
  return opts;
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

/** One harness run (HEAD's run.mjs) against the build rooted at `root`;
 * returns the normalised record (null when the run wrote none) and whether
 * the run passed. */
function harnessRun(name, root, scratch) {
  const raw = join(scratch, `${name}.raw.json`);
  const env = {
    ...process.env,
    E2E_RECORD: raw,
    E2E_RESULT_FILE: join(scratch, `${name}.result.json`),
    E2E_EXT_DIST: join(root, 'packages/extension/dist'),
    E2E_SERVER_CLI: join(root, 'packages/server/dist/cli.js'),
    E2E_SERVER_EXTENSION_ID: join(root, 'packages/server/dist/auth/extension-id.js'),
  };
  delete env.GITHUB_STEP_SUMMARY;
  delete env.E2E_EXPECT_FAIL;
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
        const run = harnessRun('base', worktree, scratch);
        base = run.record;
        if (!run.passed) state.harnessFailed = true;
        else if (opts.baseRecord) {
          mkdirSync(dirname(opts.baseRecord), { recursive: true });
          writeFileSync(opts.baseRecord, `${JSON.stringify(base, null, 2)}\n`);
        }
      }
      if (differ(base, head.record, ['base', 'head'], reports)) state.differs = true;
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
  const gate = { behaviorChange: opts.behaviorChange === true, selfDiffers: state.selfDiffers };
  const exit = gateExit(code, gate);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryMarkdown({ code, ...gate, reports }));
  }
  console.log(`e2e-diff: ${VERDICTS[code]}, exit ${String(code)}`);
  if (exit !== code) {
    console.log(
      'e2e-diff: difference accepted (behavior-change label); the PR description must name it, exit 0',
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
