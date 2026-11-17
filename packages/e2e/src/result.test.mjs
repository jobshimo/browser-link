// The browser record CI keeps per e2e leg: e2e-result.json and the step summary.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { RESULT_FILE, resultRecord, summaryMarkdown, writeResult } from './lib.mjs';

const JSON_VERSION = { Browser: 'HeadlessChrome/118.0.5993.70', 'Protocol-Version': '1.3' };
const CDP_VERSION = {
  product: 'HeadlessChrome/118.0.5993.70',
  revision: '@e52f33f30b91b4ddfad649acddc39ab570473b86',
  protocolVersion: '1.3',
  userAgent: 'ignored',
};

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'bl-e2e-result-'));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('resultRecord keeps browser, product, revision, protocolVersion and ok', () => {
  assert.deepEqual(resultRecord({ jsonVersion: JSON_VERSION, cdpVersion: CDP_VERSION, ok: true }), {
    browser: 'HeadlessChrome/118.0.5993.70',
    product: 'HeadlessChrome/118.0.5993.70',
    revision: '@e52f33f30b91b4ddfad649acddc39ab570473b86',
    protocolVersion: '1.3',
    ok: true,
  });
});

test('resultRecord before Chrome started: every browser field null, ok false', () => {
  assert.deepEqual(resultRecord({ ok: false }), {
    browser: null,
    product: null,
    revision: null,
    protocolVersion: null,
    ok: false,
  });
});

test('resultRecord falls back to /json/version for the protocol when CDP gave none', () => {
  const r = resultRecord({ jsonVersion: JSON_VERSION, ok: true });
  assert.equal(r.protocolVersion, '1.3');
  assert.equal(r.product, null);
});

test('writeResult writes E2E_RESULT_FILE and appends the step summary with the leg', () => {
  const { dir, done } = scratch();
  try {
    const file = join(dir, 'nested/e2e-result.json');
    const summary = join(dir, 'summary.md');
    writeFileSync(summary, '# earlier step\n');
    const record = resultRecord({ jsonVersion: JSON_VERSION, cdpVersion: CDP_VERSION, ok: false });
    const out = writeResult(record, {
      E2E_RESULT_FILE: file,
      GITHUB_STEP_SUMMARY: summary,
      E2E_LEG: 'chrome 118',
    });
    assert.equal(out, file);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), record);
    const md = readFileSync(summary, 'utf8');
    assert.ok(md.startsWith('# earlier step\n'), 'the summary is appended, not replaced');
    assert.match(md, /### e2e \(chrome 118\): FAIL/);
    assert.match(
      md,
      /\| HeadlessChrome\/118\.0\.5993\.70 \| HeadlessChrome\/118\.0\.5993\.70 \| @e52f/,
    );
  } finally {
    done();
  }
});

test('writeResult without GITHUB_STEP_SUMMARY writes only the JSON file', () => {
  const { dir, done } = scratch();
  try {
    const file = join(dir, 'r.json');
    writeResult(resultRecord({ ok: true }), { E2E_RESULT_FILE: file });
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).ok, true);
  } finally {
    done();
  }
});

test('the default record path is build/e2e-result.json in the e2e package', () => {
  assert.match(RESULT_FILE.replaceAll('\\', '/'), /packages\/e2e\/build\/e2e-result\.json$/);
});

test('summaryMarkdown marks unknown fields instead of printing null', () => {
  const md = summaryMarkdown(resultRecord({ ok: false }));
  assert.match(md, /### e2e: FAIL/);
  assert.match(md, /\| \(unknown\) \| \(unknown\) \| \(unknown\) \| \(unknown\) \|/);
});
