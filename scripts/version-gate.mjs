#!/usr/bin/env node
//
// CI gate — fails the PR if the monorepo versions are not aligned, or if
// the aligned version is not strictly greater than the published version
// on `origin/main`. Invoked from `.github/workflows/version-gate.yml`.
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

import {
  SERVER_PACKAGE_FILE,
  VERSIONED_FILES,
  checkAlignment,
  compareSemver,
  parseSemver,
  readAllVersions,
} from './lib/versions.mjs';

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

function readMainServerVersion() {
  try {
    const json = execFileSync('git', ['show', `origin/main:${SERVER_PACKAGE_FILE}`], {
      encoding: 'utf8',
    });
    return JSON.parse(json).version;
  } catch (err) {
    fail(
      `Could not read \`${SERVER_PACKAGE_FILE}\` from origin/main.\n` +
        `The checkout must fetch main (use \`fetch-depth: 0\` or fetch it explicitly).\n` +
        `Underlying error: ${err.message}`,
    );
  }
}

function main() {
  step('Read versions on this PR');
  const headVersions = readAllVersions();
  for (const [f, v] of Object.entries(headVersions)) info(`${v}  ${f}`);

  step('Check alignment across all versioned files');
  const alignment = checkAlignment(headVersions);
  if (!alignment.aligned) {
    const lines = Object.entries(headVersions)
      .map(([f, v]) => `  ${v}  ${f}`)
      .join('\n');
    fail(
      `Version fields are not aligned across the monorepo:\n${lines}\n\n` +
        `Every PR must bump ALL of these to the same number.\n` +
        `Run \`pnpm run release -- <patch|minor|major>\` to do it correctly,\n` +
        `or edit each file by hand.`,
    );
  }
  const headRaw = alignment.version;
  const headSemver = parseSemver(headRaw);
  if (!headSemver) {
    fail(`Version "${headRaw}" is not semver MAJOR.MINOR.PATCH.`);
  }
  info(`aligned head version: ${headRaw}`);

  step('Compare against origin/main');
  const mainRaw = readMainServerVersion();
  const mainSemver = parseSemver(mainRaw);
  if (!mainSemver) {
    fail(`Version "${mainRaw}" on origin/main is not semver MAJOR.MINOR.PATCH.`);
  }
  info(`origin/main version: ${mainRaw}`);

  const cmp = compareSemver(headSemver, mainSemver);
  if (cmp <= 0) {
    fail(
      `Version on this PR (${headRaw}) is not strictly greater than origin/main (${mainRaw}).\n\n` +
        `Every PR merged to main MUST bump the version.\n` +
        `Run \`pnpm run release -- <patch|minor|major>\` on a clean main,\n` +
        `or bump the ${VERSIONED_FILES.length} versioned files by hand.`,
    );
  }

  step('Pass');
  info(`${headRaw} > ${mainRaw} and all ${VERSIONED_FILES.length} versioned files are aligned.`);
}

main();
