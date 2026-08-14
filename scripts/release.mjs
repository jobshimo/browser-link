#!/usr/bin/env node
/**
 * Release tooling for browser-link.
 *
 * Usage:
 *   node scripts/release.mjs patch    # 0.5.2 → 0.5.3
 *   node scripts/release.mjs minor    # 0.5.2 → 0.6.0
 *   node scripts/release.mjs major    # 0.5.2 → 1.0.0
 *   node scripts/release.mjs 0.5.3    # explicit version
 *
 * What it does:
 *   1. Bumps every version field across the monorepo (root package.json,
 *      every workspace package.json, the Chrome extension manifest, and the
 *      lockfile metadata).
 *   2. Generates a CHANGELOG entry from conventional commits since the last
 *      tag, grouped by type (Features / Bug Fixes / etc).
 *   3. Commits the changes on a fresh branch `release/v<next>`.
 *   4. Pushes the branch.
 *   5. Opens a PR against main with the CHANGELOG entry in the body.
 *
 * What it explicitly does NOT do:
 *   - Push to main. Releases always go through a PR — that respects branch
 *     protection now and forever, with zero bypass tricks.
 *   - Create the git tag. The `.github/workflows/release-finalize.yml`
 *     workflow does that after the PR merges and CI passes on main — it
 *     reads the version straight out of `packages/server/package.json`,
 *     so the trigger is the *file*, not the commit message.
 *   - Create the GitHub Release. Same — handled by the finalize workflow.
 *   - Publish to npm. That stays a deliberate manual step
 *     (`cd packages/server && pnpm publish`). The tarball uploaded to
 *     registry.npmjs.org is identical regardless of the package manager;
 *     consumers can still install with `npm i -g @jobshimo/browser-link`.
 *
 * Preconditions checked before any write:
 *   - working tree is clean
 *   - on `main` branch
 *   - in sync with `origin/main`
 *   - all version fields across the monorepo agree (otherwise: prints the
 *     mismatched files and refuses — alignment is the user's call, not ours)
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  REPO_ROOT,
  VERSIONED_FILES,
  bump,
  checkAlignment,
  formatSemver,
  parseSemver,
  readAllVersions,
  readJson,
  writeJson,
} from './lib/versions.mjs';

const CHANGELOG_PATH = 'packages/server/CHANGELOG.md';
const CHANGELOG_REPO_URL = 'https://github.com/jobshimo/browser-link';

const CONVENTIONAL_SECTIONS = [
  { type: 'feat', label: 'Features' },
  { type: 'fix', label: 'Bug Fixes' },
  { type: 'perf', label: 'Performance' },
  { type: 'revert', label: 'Reverts' },
  { type: 'refactor', label: 'Refactor' },
  { type: 'docs', label: 'Documentation' },
];

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: opts.inheritStdout ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe'],
    ...opts,
  }).toString();
}

function tryRun(cmd, args, opts = {}) {
  try {
    return run(cmd, args, opts).trim();
  } catch {
    return null;
  }
}

function fail(msg) {
  process.stderr.write(`\n✘ ${msg}\n\n`);
  process.exit(1);
}

function info(msg) {
  process.stdout.write(`  ${msg}\n`);
}

function step(msg) {
  process.stdout.write(`\n→ ${msg}\n`);
}

function bumpOrFail(current, kind) {
  const next = bump(current, kind);
  if (!next) fail(`Invalid bump type: "${kind}". Use patch, minor, major, or X.Y.Z.`);
  return next;
}

function assertCleanTree() {
  const status = run('git', ['status', '--porcelain']).trim();
  if (status.length > 0) {
    fail(
      'Working tree has uncommitted changes. Commit, stash or revert before releasing.\n' + status,
    );
  }
}

function assertOnMain() {
  const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  if (branch !== 'main') {
    fail(`Releases must be cut from main. You are on "${branch}".`);
  }
}

function assertInSyncWithOrigin() {
  run('git', ['fetch', 'origin', 'main']);
  const local = run('git', ['rev-parse', 'main']).trim();
  const remote = run('git', ['rev-parse', 'origin/main']).trim();
  if (local !== remote) {
    fail(
      `Local main is not in sync with origin/main.\n  local : ${local}\n  remote: ${remote}\nPull (or push) before releasing.`,
    );
  }
}

function assertVersionsAligned() {
  const versions = readAllVersions();
  const result = checkAlignment(versions);
  if (!result.aligned) {
    const lines = Object.entries(versions)
      .map(([f, v]) => `  ${v}  ${f}`)
      .join('\n');
    fail(
      `Version fields across the monorepo are misaligned:\n${lines}\n` +
        `Align them by hand (pick the correct number, edit each file, commit) before running release.`,
    );
  }
  return result.version;
}

function lastReleaseTag() {
  const tag = tryRun('git', ['describe', '--tags', '--abbrev=0', '--match', 'v*']);
  return tag && tag.length > 0 ? tag : null;
}

function commitsSince(tag) {
  // %H = full sha, %s = subject. Tab-separated so we can split safely.
  const range = tag ? `${tag}..HEAD` : 'HEAD';
  const out = tryRun('git', ['log', range, '--pretty=format:%H%x09%s']);
  if (!out) return [];
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, ...rest] = line.split('\t');
      return { sha, subject: rest.join('\t') };
    });
}

function classifyCommit(subject) {
  const m = /^([a-z]+)(?:\([^)]+\))?!?:\s*(.+)$/.exec(subject);
  if (!m) return null;
  const type = m[1];
  const message = m[2];
  const section = CONVENTIONAL_SECTIONS.find((s) => s.type === type);
  if (!section) return null;
  return { type, label: section.label, message };
}

function buildChangelogEntry(nextVersion, previousVersion, commits) {
  const groups = new Map();
  for (const c of commits) {
    const k = classifyCommit(c.subject);
    if (!k) continue;
    if (!groups.has(k.label)) groups.set(k.label, []);
    groups.get(k.label).push({ ...k, sha: c.sha });
  }

  const header = previousVersion
    ? `## [${nextVersion}](${CHANGELOG_REPO_URL}/compare/v${previousVersion}...v${nextVersion}) (${todayIso()})`
    : `## [${nextVersion}] (${todayIso()})`;

  const lines = [header, ''];
  if (groups.size === 0) {
    lines.push('### Miscellaneous', '');
    lines.push('* No conventional commits since the previous release. Manual release cut.');
    lines.push('');
    return lines.join('\n');
  }
  // Stable order: Features, Bug Fixes, Performance, Reverts, Refactor, Docs.
  for (const section of CONVENTIONAL_SECTIONS) {
    const entries = groups.get(section.label);
    if (!entries) continue;
    lines.push(`### ${section.label}`, '');
    for (const e of entries) {
      const short = e.sha.slice(0, 7);
      lines.push(`* ${e.message} ([${short}](${CHANGELOG_REPO_URL}/commit/${e.sha}))`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function todayIso() {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function prependChangelog(entry) {
  const full = join(REPO_ROOT, CHANGELOG_PATH);
  // Read-then-write without an `existsSync` guard: the `existsSync → write`
  // sequence opens a TOCTOU window (the file could be created/deleted in
  // between). Catching ENOENT off `readFileSync` makes the operation a
  // single, atomic decision based on what actually happened, not on a
  // stale earlier check.
  let current;
  try {
    current = readFileSync(full, 'utf8');
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
    writeFileSync(full, `# Changelog\n\n${entry}\n`, 'utf8');
    return;
  }
  // Insert right after the first "# Changelog" header line so the newest
  // release sits at the top of the table of contents.
  const headerMatch = current.match(/^#\s+Changelog\s*\n+/);
  if (!headerMatch) {
    writeFileSync(full, `# Changelog\n\n${entry}\n${current}`, 'utf8');
    return;
  }
  const head = current.slice(0, headerMatch[0].length);
  const rest = current.slice(headerMatch[0].length);
  writeFileSync(full, `${head}${entry}\n${rest}`, 'utf8');
}

function setVersion(relPath, version) {
  const data = readJson(relPath);
  data.version = version;
  writeJson(relPath, data);
}

function ensureGhAvailable() {
  const v = tryRun('gh', ['--version']);
  if (!v) {
    fail(
      'The GitHub CLI (`gh`) is required to open the release PR.\n  Install: https://cli.github.com/  then `gh auth login`.',
    );
  }
}

function main() {
  const bumpArg = process.argv[2];
  if (!bumpArg) {
    fail(
      'Usage:\n  node scripts/release.mjs <patch|minor|major|X.Y.Z>\n\n' +
        'Run from the repo root with a clean working tree, on main, in sync with origin.',
    );
  }

  step('Pre-flight checks');
  assertCleanTree();
  info('working tree clean');
  assertOnMain();
  info('on main');
  assertInSyncWithOrigin();
  info('main is in sync with origin');
  ensureGhAvailable();
  info('gh CLI available');

  const currentRaw = assertVersionsAligned();
  const current = parseSemver(currentRaw);
  if (!current) fail(`Current version "${currentRaw}" is not semver MAJOR.MINOR.PATCH.`);
  info(`current aligned version: ${currentRaw}`);

  const next = bumpOrFail(current, bumpArg);
  const nextRaw = formatSemver(next);
  if (formatSemver(current) === nextRaw) {
    fail(`Computed next version equals current (${nextRaw}). Nothing to release.`);
  }
  info(`next version: ${nextRaw}`);

  const lastTag = lastReleaseTag();
  if (lastTag) info(`last tag: ${lastTag}`);
  else info('no previous tag — this will be the first cut');

  step('Generate changelog entry');
  const commits = commitsSince(lastTag);
  info(`${commits.length} commit(s) since ${lastTag ?? 'the beginning'}`);
  const previous = lastTag ? lastTag.replace(/^v/, '') : null;
  const entry = buildChangelogEntry(nextRaw, previous, commits);

  step('Create release branch');
  const branch = `release/v${nextRaw}`;
  // Abort early if the branch already exists locally to avoid clobbering an
  // in-flight attempt. The user can delete the stale branch and re-run.
  const existing = tryRun('git', ['rev-parse', '--verify', `refs/heads/${branch}`]);
  if (existing) {
    fail(`Branch ${branch} already exists locally. Delete it or finish the prior release first.`);
  }
  run('git', ['checkout', '-b', branch], { inheritStdout: true });

  step('Bump versions across the monorepo');
  for (const f of VERSIONED_FILES) {
    setVersion(f, nextRaw);
    info(`bumped ${f}`);
  }

  step('Sync lockfile (lockfile-only)');
  run('pnpm', ['install', '--lockfile-only'], { inheritStdout: true });

  step('Update CHANGELOG');
  prependChangelog(entry);
  info(`prepended new section to ${CHANGELOG_PATH}`);

  step('Commit and push release branch');
  run('git', ['add', ...VERSIONED_FILES, CHANGELOG_PATH, 'pnpm-lock.yaml']);
  run('git', ['commit', '-m', `chore(release): v${nextRaw}`], { inheritStdout: true });
  run('git', ['push', '-u', 'origin', branch], { inheritStdout: true });

  step('Open release PR');
  const prBody = [
    `Cut release \`v${nextRaw}\`.`,
    '',
    'Merging this PR triggers `.github/workflows/release-finalize.yml`, which:',
    `- Creates and pushes the tag \`v${nextRaw}\`.`,
    `- Creates the corresponding GitHub Release with the notes below.`,
    '',
    'npm publish remains manual:',
    '```bash',
    'cd packages/server',
    'pnpm publish',
    '```',
    '',
    '---',
    '',
    entry,
  ].join('\n');
  run(
    'gh',
    [
      'pr',
      'create',
      '--base',
      'main',
      '--head',
      branch,
      '--title',
      `chore(release): v${nextRaw}`,
      '--body',
      prBody,
    ],
    { inheritStdout: true },
  );

  step('Done');
  info(`Release PR opened for v${nextRaw}.`);
  info('Review the diff, then merge via GitHub UI to trigger the tag/release.');
  info('After the GH Release lands, run `cd packages/server && pnpm publish` to push to npm.');
}

main();
