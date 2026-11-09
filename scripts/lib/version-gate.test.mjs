import { test } from 'node:test';
import assert from 'node:assert/strict';

import { VERSIONED_FILES } from './versions.mjs';
import { evaluateGate } from './version-gate.mjs';

const aligned = (version) => Object.fromEntries(VERSIONED_FILES.map((file) => [file, version]));
const codes = (result) => result.reasons.map((reason) => reason.code);

test('evaluateGate passes when aligned and strictly greater than the base', () => {
  const result = evaluateGate({ versions: aligned('0.46.0'), baseVersion: '0.45.0' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.reasons, []);
  assert.equal(result.headVersion, '0.46.0');
});

test('evaluateGate fails when the version equals the base', () => {
  const result = evaluateGate({ versions: aligned('0.45.0'), baseVersion: '0.45.0' });
  assert.equal(result.ok, false);
  assert.deepEqual(codes(result), ['not-greater']);
  assert.match(
    result.reasons[0].message,
    /\(0\.45\.0\) is not strictly greater than origin\/main \(0\.45\.0\)/,
  );
});

test('evaluateGate fails when the version is lower than the base', () => {
  const result = evaluateGate({ versions: aligned('0.44.9'), baseVersion: '0.45.0' });
  assert.equal(result.ok, false);
  assert.deepEqual(codes(result), ['not-greater']);
});

test('evaluateGate fails when the versioned files are misaligned', () => {
  const versions = { ...aligned('0.46.0'), 'packages/shared/package.json': '0.45.0' };
  const result = evaluateGate({ versions, baseVersion: '0.45.0' });
  assert.equal(result.ok, false);
  assert.deepEqual(codes(result), ['misaligned']);
  assert.match(result.reasons[0].message, /not aligned/);
  assert.match(result.reasons[0].message, /0\.45\.0 {2}packages\/shared\/package\.json/);
});

test('evaluateGate fails on a prerelease head version', () => {
  const result = evaluateGate({ versions: aligned('1.0.0-rc.1'), baseVersion: '0.45.0' });
  assert.equal(result.ok, false);
  assert.deepEqual(codes(result), ['head-not-semver']);
});

test('evaluateGate fails on a non-semver base version', () => {
  const result = evaluateGate({ versions: aligned('0.46.0'), baseVersion: '0.45.0-beta' });
  assert.equal(result.ok, false);
  assert.deepEqual(codes(result), ['base-not-semver']);
});

test('evaluateGate reports a missing base only after the head checks pass', () => {
  const missing = evaluateGate({ versions: aligned('0.46.0'), baseVersion: undefined });
  assert.deepEqual(codes(missing), ['base-missing']);
  const misaligned = { ...aligned('0.46.0'), 'package.json': '0.1.0' };
  assert.deepEqual(codes(evaluateGate({ versions: misaligned, baseVersion: undefined })), [
    'misaligned',
  ]);
});
