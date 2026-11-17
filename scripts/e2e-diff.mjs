#!/usr/bin/env node
// Differential e2e check (design 7(b)): HEAD's harness drives the base build
// and HEAD's build, every tool call is recorded (E2E_RECORD), both records are
// normalised with the committed table (packages/e2e/src/normalise.mjs) and
// must be equal. A refactor that changes no behavior passes; any difference
// prints the first differing call with both values and exits 1.
//
//   node scripts/e2e-diff.mjs [--base] <ref>   compare against merge-base(<ref>, HEAD)
//     --base-record <file>   reuse this normalised base record when it exists,
//                            write it there after a base run (CI cache)
//     --self-diff            also run HEAD twice and require equal records
//                            (normalise table completeness)
//   node scripts/e2e-diff.mjs --self-diff-only   two HEAD runs, no base
//     --ignore-scripts       pass --ignore-scripts to the base install (local
//                            Windows without the toolchain for native builds)
//
// HEAD must already be built (`pnpm build`). The base is checked out with
// `git worktree add` in a temp dir, installed and built there, and the
// worktree is removed at the end whatever the outcome. In CI the ref is
// origin/<PR target branch>, so a stacked PR compares with the PR below it.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function parseArgs(argv) {
  const opts = { ref: undefined, baseRecord: undefined, selfDiff: false, selfDiffOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') opts.ref = argv[++i];
    else if (a === '--base-record') opts.baseRecord = resolve(argv[++i]);
    else if (a === '--self-diff') opts.selfDiff = true;
    else if (a === '--self-diff-only') opts.selfDiffOnly = true;
    else if (a === '--ignore-scripts') opts.ignoreScripts = true;
    else if (!a.startsWith('--') && opts.ref === undefined) opts.ref = a;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!opts.selfDiffOnly && !opts.ref) {
    throw new Error('usage: e2e-diff.mjs [--base] <ref> [--base-record <file>] [--self-diff]');
  }
  return opts;
}

const git = (args, cwd = REPO) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function pnpm(args, cwd) {
  console.log(`e2e-diff: pnpm ${args.join(' ')} (in ${cwd})`);
  const r = spawnSync('pnpm', args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (r.status !== 0) throw new Error(`pnpm ${args.join(' ')} failed in ${cwd}`);
}

/** One harness run (HEAD's run.mjs) against the build rooted at `root`;
 * returns the normalised record and whether the run passed. */
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
  if (!existsSync(raw)) throw new Error(`run "${name}" wrote no record (${raw})`);
  const normalised = normaliseRecord(JSON.parse(readFileSync(raw, 'utf8')));
  writeFileSync(join(scratch, `${name}.json`), `${JSON.stringify(normalised, null, 2)}\n`);
  return { record: normalised, passed: r.status === 0 };
}

function compare(a, b, names) {
  const diff = firstDifference(a, b);
  if (!diff) {
    console.log(`e2e-diff: ${names[0]} and ${names[1]} equal (${String(a.calls.length)} calls)`);
    return true;
  }
  console.log(formatDifference(diff, names));
  return false;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!existsSync(join(REPO, 'packages/server/dist/cli.js'))) {
    throw new Error('HEAD is not built; run pnpm build first');
  }
  const scratch = mkdtempSync(join(tmpdir(), 'bl-e2e-diff-'));
  console.log(`e2e-diff: records in ${scratch}`);
  let ok;
  let worktree;
  try {
    const head = harnessRun('head', REPO, scratch);
    ok = head.passed;
    if (opts.selfDiff || opts.selfDiffOnly) {
      const again = harnessRun('head-2', REPO, scratch);
      ok = again.passed && compare(head.record, again.record, ['head', 'head-2']) && ok;
    }
    if (!opts.selfDiffOnly) {
      const sha = git(['merge-base', opts.ref, 'HEAD']);
      console.log(`e2e-diff: base = merge-base(${opts.ref}, HEAD) = ${sha}`);
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
        if (!run.passed) {
          ok = false;
          console.log('e2e-diff: the harness failed on the base build');
        } else if (opts.baseRecord) {
          mkdirSync(dirname(opts.baseRecord), { recursive: true });
          writeFileSync(opts.baseRecord, `${JSON.stringify(base, null, 2)}\n`);
        }
      }
      ok = compare(base, head.record, ['base', 'head']) && ok;
    }
  } finally {
    if (worktree) {
      try {
        git(['worktree', 'remove', '--force', worktree]);
        console.log(`e2e-diff: worktree ${worktree} removed`);
      } catch (e) {
        ok = false;
        console.error(`e2e-diff: could not remove worktree ${worktree}: ${String(e.message)}`);
      }
    }
    if (process.env.E2E_DIFF_KEEP !== '1') rmSync(scratch, { recursive: true, force: true });
  }
  console.log(`e2e-diff: ${ok ? 'ok' : 'FAIL'}`);
  return ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = main();
  } catch (e) {
    console.error(`e2e-diff: ${String(e?.message ?? e)}`);
    process.exitCode = 1;
  }
}
