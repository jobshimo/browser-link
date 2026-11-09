// Pins the current behaviour of the shared release/version-gate helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  VERSIONED_FILES,
  bump,
  checkAlignment,
  compareSemver,
  formatSemver,
  parseSemver,
  readAllVersions,
} from './versions.mjs';

test('parseSemver accepts plain MAJOR.MINOR.PATCH', () => {
  assert.deepEqual(parseSemver('0.45.0'), { major: 0, minor: 45, patch: 0 });
  assert.deepEqual(parseSemver('10.2.33'), { major: 10, minor: 2, patch: 33 });
});

test('parseSemver rejects prereleases, build metadata and garbage', () => {
  for (const raw of [
    '1.0.0-rc.1',
    '1.0.0+build.5',
    'v1.0.0',
    '1.0',
    '1.0.0.0',
    '',
    'latest',
    ' 1.0.0',
  ]) {
    assert.equal(parseSemver(raw), null, raw);
  }
});

test('compareSemver orders by major, then minor, then patch', () => {
  const v = (raw) => parseSemver(raw);
  assert.ok(compareSemver(v('1.0.0'), v('0.99.99')) > 0);
  assert.ok(compareSemver(v('0.46.0'), v('0.45.9')) > 0);
  assert.ok(compareSemver(v('0.45.1'), v('0.45.0')) > 0);
  assert.ok(compareSemver(v('0.45.0'), v('0.45.1')) < 0);
  assert.equal(compareSemver(v('0.45.0'), v('0.45.0')), 0);
});

test('bump handles patch, minor, major and an explicit version', () => {
  const current = parseSemver('0.45.3');
  assert.equal(formatSemver(bump(current, 'patch')), '0.45.4');
  assert.equal(formatSemver(bump(current, 'minor')), '0.46.0');
  assert.equal(formatSemver(bump(current, 'major')), '1.0.0');
  assert.equal(formatSemver(bump(current, '2.0.1')), '2.0.1');
  assert.equal(bump(current, 'nonsense'), null);
});

test('VERSIONED_FILES lists the five lockstep files', () => {
  assert.deepEqual(VERSIONED_FILES, [
    'package.json',
    'packages/server/package.json',
    'packages/extension/package.json',
    'packages/extension/manifest.json',
    'packages/shared/package.json',
  ]);
});

/** Temp repo root holding the five versioned files with the given versions. */
function fixtureRoot(versionFor) {
  const root = mkdtempSync(join(tmpdir(), 'browser-link-versions-'));
  for (const file of VERSIONED_FILES) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), JSON.stringify({ name: file, version: versionFor(file) }));
  }
  return root;
}

test('checkAlignment over a fixture root: aligned versions', () => {
  const root = fixtureRoot(() => '0.46.0');
  try {
    const versions = readAllVersions(root);
    assert.equal(Object.keys(versions).length, 5);
    assert.deepEqual(checkAlignment(versions), { aligned: true, version: '0.46.0' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('checkAlignment over a fixture root: one file behind is misaligned', () => {
  const root = fixtureRoot((file) =>
    file === 'packages/extension/manifest.json' ? '0.45.0' : '0.46.0',
  );
  try {
    const versions = readAllVersions(root);
    assert.equal(versions['packages/extension/manifest.json'], '0.45.0');
    assert.deepEqual(checkAlignment(versions), { aligned: false, version: null });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
