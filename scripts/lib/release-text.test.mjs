import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildReleasePrBody, releaseDoneInstructions } from './release-text.mjs';

// Character classes keep these literals out of the repository-wide grep
// that asserts no script or workflow mentions them.
const FORBIDDEN_PUBLISH = /(pnpm|npm) publi[s]h/;
const FORBIDDEN_FINALIZE = /release-finali[z]e/;
const FORBIDDEN = new RegExp(`${FORBIDDEN_PUBLISH.source}|${FORBIDDEN_FINALIZE.source}`);

const entry = '## [0.46.0] (2026-11-09)\n\n### Features\n\n* something\n';

test('the release PR body states the automated flow after merge', () => {
  const body = buildReleasePrBody({ version: '0.46.0', changelogEntry: entry });
  assert.match(body, /^Cut release `v0\.46\.0`\./);
  assert.match(body, /Merging this PR runs the `ci` workflow on `main`/);
  assert.match(body, /smoke-tests the npm tarball/);
  assert.match(body, /creates the tag `v0\.46\.0` and the GitHub Release/);
  assert.match(body, /publishes `@jobshimo\/browser-link@0\.46\.0` to npm with OIDC provenance/);
  assert.match(body, /Nothing is manual after the merge\./);
  assert.ok(body.endsWith(entry), 'the changelog entry closes the body');
});

test('the release PR body mentions no manual publish and no finalize workflow', () => {
  const body = buildReleasePrBody({ version: '0.46.0', changelogEntry: entry });
  assert.doesNotMatch(body, FORBIDDEN_PUBLISH);
  assert.doesNotMatch(body, FORBIDDEN_FINALIZE);
  assert.doesNotMatch(body, /remains manual/i);
});

test('the final instructions describe merge-to-publish without a manual step', () => {
  const text = releaseDoneInstructions('0.46.0').join('\n');
  assert.match(text, /Release PR opened for v0\.46\.0\./);
  assert.match(text, /publishes to npm/);
  assert.doesNotMatch(text, FORBIDDEN);
});
