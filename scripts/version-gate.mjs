#!/usr/bin/env node
//
// CI gate — fails the PR if the monorepo versions are not aligned, or if
// the aligned version is not strictly greater than the published version
// on `origin/main`. Invoked from `.github/workflows/version-gate.yml`.
//
// The decision lives in ./lib/version-gate.mjs (pure, unit-tested); this
// file only reads the versions, prints progress and sets the exit code.
//
// The contract this gate enforces (in plain words):
//   1. All five files in `VERSIONED_FILES` must carry the same version.
//   2. That version must be strictly greater than what's on origin/main.
//
// Together they mean: every PR that lands on main IS a release. No silent
// merges, no half-bumped lockstep, no relying on commit-message regex.
// The version file is the source of truth.
//
// Preconditions on the runner:
//   - `origin/main` is fetched (use `fetch-depth: 0` in checkout, or fetch
//     main explicitly before invoking this script).

import { execFileSync } from 'node:child_process';

import { SERVER_PACKAGE_FILE, VERSIONED_FILES, readAllVersions } from './lib/versions.mjs';
import { evaluateGate } from './lib/version-gate.mjs';

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

/** Server version on origin/main, or the error that prevented reading it. */
function readMainServerVersion() {
  try {
    const json = execFileSync('git', ['show', `origin/main:${SERVER_PACKAGE_FILE}`], {
      encoding: 'utf8',
    });
    return { version: JSON.parse(json).version };
  } catch (err) {
    return { error: err };
  }
}

function main() {
  step('Read versions on this PR');
  const headVersions = readAllVersions();
  for (const [f, v] of Object.entries(headVersions)) info(`${v}  ${f}`);

  const base = readMainServerVersion();
  const result = evaluateGate({ versions: headVersions, baseVersion: base.version });
  const reason = result.reasons[0];

  step('Check alignment across all versioned files');
  if (reason && (reason.code === 'misaligned' || reason.code === 'head-not-semver')) {
    fail(reason.message);
  }
  info(`aligned head version: ${result.headVersion}`);

  step('Compare against origin/main');
  if (base.error) {
    fail(
      `Could not read \`${SERVER_PACKAGE_FILE}\` from origin/main.\n` +
        `The checkout must fetch main (use \`fetch-depth: 0\` or fetch it explicitly).\n` +
        `Underlying error: ${base.error.message}`,
    );
  }
  if (reason && reason.code === 'base-not-semver') fail(reason.message);
  info(`origin/main version: ${base.version}`);
  if (reason) fail(reason.message);

  step('Pass');
  info(
    `${result.headVersion} > ${base.version} and all ${VERSIONED_FILES.length} versioned files are aligned.`,
  );
}

main();
