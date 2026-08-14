// Shared version utilities for the release pipeline.
//
// Two consumers:
//  - scripts/release.mjs           (local release engine: bump + open PR)
//  - scripts/version-gate.mjs      (CI gate: block PR merge if versions
//                                   are not aligned and strictly greater
//                                   than the version on `main`)
//
// One list of versioned files, one semver parser, one alignment check.
// If a new versioned file is ever added to the monorepo, append it to
// VERSIONED_FILES here and both consumers pick it up automatically.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, '..', '..');

export const VERSIONED_FILES = [
  'package.json',
  'packages/server/package.json',
  'packages/extension/package.json',
  'packages/extension/manifest.json',
  'packages/shared/package.json',
];

// The published npm package — used as the canonical "current" version on
// `main` when nothing else is available (e.g. the gate comparing against
// the base ref).
export const SERVER_PACKAGE_FILE = 'packages/server/package.json';

export function readJson(relPath, root = REPO_ROOT) {
  return JSON.parse(readFileSync(join(root, relPath), 'utf8'));
}

export function writeJson(relPath, value, root = REPO_ROOT) {
  // Trailing newline matches what the rest of the repo uses; without it
  // every release would create a noisy 1-byte diff.
  writeFileSync(join(root, relPath), JSON.stringify(value, null, 2) + '\n', 'utf8');
}

export function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

export function formatSemver(v) {
  return `${v.major}.${v.minor}.${v.patch}`;
}

export function compareSemver(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

export function bump(current, kind) {
  if (kind === 'patch') return { ...current, patch: current.patch + 1 };
  if (kind === 'minor') return { major: current.major, minor: current.minor + 1, patch: 0 };
  if (kind === 'major') return { major: current.major + 1, minor: 0, patch: 0 };
  return parseSemver(kind);
}

export function readAllVersions(root = REPO_ROOT) {
  const out = {};
  for (const f of VERSIONED_FILES) {
    out[f] = readJson(f, root).version;
  }
  return out;
}

export function checkAlignment(versions) {
  const distinct = new Set(Object.values(versions));
  if (distinct.size === 1) {
    return { aligned: true, version: [...distinct][0] };
  }
  return { aligned: false, version: null };
}
