// The server's generated mirror (scripts/sync-core.mjs): which files are
// copied, the specifier rewrite, and the --check failures, each RED-probed on
// a throwaway repository layout.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import {
  actualMirror,
  diffMirror,
  expectedMirror,
  GENERATED_DIR,
  isProduction,
  rewriteSpecifiers,
  writeMirror,
} from './sync-core.mjs';

function scratchRepo(files) {
  const repo = mkdtempSync(join(tmpdir(), 'sync-core-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  return repo;
}

const CORE = {
  'packages/core/src/index.ts': "export * from './ports/index.js';\n",
  'packages/core/src/ports/index.ts': "export type { Clock } from './clock.js';\n",
  'packages/core/src/ports/clock.ts': 'export interface Clock {\n  now(): number;\n}\n',
  'packages/core/src/ports/clock.test.ts': "import { it } from 'vitest';\n",
  'packages/core/src/fitness/layers.ts': 'export const LAYERS = {};\n',
  'packages/core/src/tools/x.ts':
    "import type { Bridge } from '@browser-link/shared';\nexport type { Bridge } from \"@browser-link/shared\";\nimport '@browser-link/shared';\n",
};

const check = (repo) => diffMirror(expectedMirror(repo), actualMirror(repo));

function withRepo(files, body) {
  const repo = scratchRepo(files);
  try {
    body(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

test('production files only: no tests, no fitness folder, no contract fixtures', () => {
  assert.equal(isProduction('ports/clock.ts'), true);
  assert.equal(isProduction('ports/contract/fakes.ts'), true);
  assert.equal(isProduction('ports/clock.test.ts'), false);
  assert.equal(isProduction('fitness/layers.ts'), false);
  assert.equal(isProduction('fitness/fixtures/cycle/support/a.ts'), false);
  assert.equal(isProduction('ports/contract/fixtures/page.ts'), false);
  assert.equal(isProduction('ports/contract/data.fixture.json'), false);
});

test('the shared specifier becomes the relative path of generated/shared/index.js', () => {
  assert.equal(
    rewriteSpecifiers("import type { A } from '@browser-link/shared';", 'x.ts').text,
    "import type { A } from '../shared/index.js';",
  );
  assert.equal(
    rewriteSpecifiers("export { A } from '@browser-link/shared';", 'tools/x.ts').text,
    "export { A } from '../../shared/index.js';",
  );
  assert.equal(
    rewriteSpecifiers("import '@browser-link/shared';", 'a/b/x.ts').text,
    "import '../../../shared/index.js';",
  );
  assert.equal(rewriteSpecifiers("import { a } from './a.js';", 'x.ts').rewritten, false);
});

test('the written mirror holds headers and rewritten specifiers, and passes --check', () => {
  withRepo(CORE, (repo) => {
    assert.equal(writeMirror(repo), 4);
    const mirror = actualMirror(repo);
    assert.deepEqual([...mirror.keys()].sort(), [
      'core/index.ts',
      'core/ports/clock.ts',
      'core/ports/index.ts',
      'core/tools/x.ts',
    ]);
    assert.equal(
      mirror.get('core/ports/clock.ts'),
      '// GENERATED from packages/core/src/ports/clock.ts. Do not edit.\nexport interface Clock {\n  now(): number;\n}\n',
    );
    const tools = mirror.get('core/tools/x.ts');
    assert.match(
      tools,
      /^\/\/ GENERATED from packages\/core\/src\/tools\/x\.ts\. Specifiers rewritten\. Do not edit\.\n/,
    );
    assert.equal(tools.includes('@browser-link/shared'), false);
    assert.equal(tools.split("'../../shared/index.js'").length - 1, 2);
    assert.equal(tools.includes('"../../shared/index.js"'), true);
    assert.deepEqual(check(repo), []);
  });
});

test('RED: --check reports a changed byte', () => {
  withRepo(CORE, (repo) => {
    writeMirror(repo);
    writeFileSync(join(repo, GENERATED_DIR, 'core/ports/clock.ts'), 'tampered\n');
    assert.deepEqual(check(repo), ['different: core/ports/clock.ts']);
  });
});

test('RED: --check reports an extra file', () => {
  withRepo(CORE, (repo) => {
    writeMirror(repo);
    writeFileSync(join(repo, GENERATED_DIR, 'core/stale.ts'), 'export {};\n');
    assert.deepEqual(check(repo), ['extra: core/stale.ts']);
  });
});

test('RED: --check reports a missing file', () => {
  withRepo(CORE, (repo) => {
    writeMirror(repo);
    rmSync(join(repo, GENERATED_DIR, 'core/index.ts'));
    assert.deepEqual(check(repo), ['missing: core/index.ts']);
  });
});

test('RED: --check reports a specifier left un-rewritten', () => {
  withRepo(CORE, (repo) => {
    writeMirror(repo);
    const path = join(repo, GENERATED_DIR, 'core/tools/x.ts');
    const text = actualMirror(repo).get('core/tools/x.ts');
    writeFileSync(path, text.replace("'../../shared/index.js'", "'@browser-link/shared'"));
    assert.deepEqual(check(repo), [
      'different: core/tools/x.ts',
      'bare specifier @browser-link/shared: core/tools/x.ts',
    ]);
  });
});

test('RED: --check reports a wrong relative depth', () => {
  withRepo(CORE, (repo) => {
    writeMirror(repo);
    const path = join(repo, GENERATED_DIR, 'core/tools/x.ts');
    const text = actualMirror(repo).get('core/tools/x.ts');
    writeFileSync(path, text.replaceAll('../../shared/index.js', '../shared/index.js'));
    assert.deepEqual(check(repo), ['different: core/tools/x.ts']);
  });
});

test('writing deletes files the mirror no longer holds', () => {
  withRepo(CORE, (repo) => {
    writeMirror(repo);
    writeFileSync(join(repo, GENERATED_DIR, 'core/stale.ts'), 'export {};\n');
    writeMirror(repo);
    assert.equal(actualMirror(repo).has('core/stale.ts'), false);
    assert.deepEqual(check(repo), []);
  });
});
