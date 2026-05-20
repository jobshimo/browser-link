#!/usr/bin/env node
//
// Bump the 5 lockstep-versioned files to `origin/main + 1 patch` so a
// Dependabot PR can satisfy the Version Gate. Used exclusively from
// `.github/workflows/dependabot-version-bump.yml`.
//
// Idempotent. Re-running on an already-bumped branch (e.g. after a
// Dependabot rebase that didn't drop the prior bump commit) is a no-op:
// if HEAD's aligned version is already strictly greater than
// origin/main, the script exits 0 without changes.
//
// The script writes ALL 5 files unconditionally when it bumps. That
// means if a previous bump commit got dropped by rebase (or the values
// drifted), the next workflow run recreates the bump cleanly.
//
// Preconditions on the runner:
//   - `origin/main` must be fetched (use `fetch-depth: 0` in checkout).
//
// What it deliberately does NOT do:
//   - Generate a CHANGELOG entry. Dependabot bumps are mechanical;
//     human-facing notes (if any) belong in the merging PR's body or
//     a follow-up commit. Keeping the auto-commit minimal makes it
//     easy to audit.

import { execFileSync } from 'node:child_process';

import {
  SERVER_PACKAGE_FILE,
  VERSIONED_FILES,
  bump,
  checkAlignment,
  compareSemver,
  formatSemver,
  parseSemver,
  readAllVersions,
  readJson,
  writeJson,
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
        `Make sure the checkout step uses \`fetch-depth: 0\`.\n` +
        `Underlying error: ${err.message}`,
    );
  }
}

function main() {
  step('Read versions on this PR');
  const headVersions = readAllVersions();
  for (const [f, v] of Object.entries(headVersions)) info(`${v}  ${f}`);

  step('Read origin/main version');
  const mainRaw = readMainServerVersion();
  const mainSemver = parseSemver(mainRaw);
  if (!mainSemver) fail(`Version "${mainRaw}" on origin/main is not semver MAJOR.MINOR.PATCH.`);
  info(`origin/main: ${mainRaw}`);

  step('Decide whether to bump');
  const alignment = checkAlignment(headVersions);
  if (alignment.aligned) {
    const headSemver = parseSemver(alignment.version);
    if (headSemver && compareSemver(headSemver, mainSemver) > 0) {
      info(`HEAD already aligned at ${alignment.version} > main ${mainRaw}. Nothing to bump.`);
      return;
    }
  }

  const targetSemver = bump(mainSemver, 'patch');
  const targetRaw = formatSemver(targetSemver);
  info(`target version: ${targetRaw}`);

  step('Write target version to all versioned files');
  for (const f of VERSIONED_FILES) {
    const json = readJson(f);
    json.version = targetRaw;
    writeJson(f, json);
    info(`wrote ${targetRaw}  ${f}`);
  }
}

main();
