// Pure decision of the CI version gate (scripts/version-gate.mjs owns the
// I/O and the exit code). The contract, in plain words:
//   1. All files in VERSIONED_FILES carry the same version.
//   2. That version is plain MAJOR.MINOR.PATCH and strictly greater than
//      the server version on the base branch (origin/main).
//
// Checks run in that order and stop at the first failure, so `reasons`
// holds at most one entry. Each reason has a stable `code` and the
// human-readable `message` the gate prints.

import { VERSIONED_FILES, checkAlignment, compareSemver, parseSemver } from './versions.mjs';

/**
 * @param {{ versions: Record<string, string>, baseVersion: string | undefined | null }} input
 *   `versions` maps each versioned file to its version on the PR head;
 *   `baseVersion` is the server version on the base branch, or nullish
 *   when it could not be read.
 * @returns {{ ok: boolean, reasons: { code: string, message: string }[], headVersion: string | null }}
 */
export function evaluateGate({ versions, baseVersion }) {
  const failWith = (code, message, headVersion = null) => ({
    ok: false,
    reasons: [{ code, message }],
    headVersion,
  });

  const alignment = checkAlignment(versions);
  if (!alignment.aligned) {
    const lines = Object.entries(versions)
      .map(([file, version]) => `  ${version}  ${file}`)
      .join('\n');
    return failWith(
      'misaligned',
      `Version fields are not aligned across the monorepo:\n${lines}\n\n` +
        `Every PR must bump ALL of these to the same number.\n` +
        `Run \`pnpm run release -- <patch|minor|major>\` to do it correctly,\n` +
        `or edit each file by hand.`,
    );
  }

  const headVersion = alignment.version;
  const headSemver = parseSemver(headVersion);
  if (!headSemver) {
    return failWith(
      'head-not-semver',
      `Version "${headVersion}" is not semver MAJOR.MINOR.PATCH.`,
      headVersion,
    );
  }

  if (baseVersion === undefined || baseVersion === null) {
    return failWith('base-missing', 'No base version to compare against.', headVersion);
  }
  const baseSemver = parseSemver(baseVersion);
  if (!baseSemver) {
    return failWith(
      'base-not-semver',
      `Version "${baseVersion}" on origin/main is not semver MAJOR.MINOR.PATCH.`,
      headVersion,
    );
  }

  if (compareSemver(headSemver, baseSemver) <= 0) {
    return failWith(
      'not-greater',
      `Version on this PR (${headVersion}) is not strictly greater than origin/main (${baseVersion}).\n\n` +
        `Every PR merged to main MUST bump the version.\n` +
        `Run \`pnpm run release -- <patch|minor|major>\` on a clean main,\n` +
        `or bump the ${VERSIONED_FILES.length} versioned files by hand.`,
      headVersion,
    );
  }

  return { ok: true, reasons: [], headVersion };
}
