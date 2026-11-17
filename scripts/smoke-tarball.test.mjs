// The bundled-extension assertions of scripts/smoke-tarball.mjs, on
// synthetic tarball entries (no pack, no install).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EXTENSION_ENTRIES, extensionFailures, hasTopLevelAwait } from './smoke-tarball.mjs';

const P = 'package/dist/extension/';
const manifest = (version, worker = 'background.js') =>
  JSON.stringify({ version, background: { service_worker: worker, type: 'module' } });
const sources = () =>
  new Map([
    ['manifest.json', Buffer.from(manifest('1.0.0'))],
    ['popup.html', Buffer.from('<script type="module" src="popup.js"></script>')],
    ['icons/icon-16.png', Buffer.from([1, 2, 3])],
  ]);
const goodEntries = () => {
  const entries = new Map([['package/dist/cli.js', Buffer.from('')]]);
  for (const entry of EXTENSION_ENTRIES) {
    entries.set(P + entry, Buffer.from('async function f() { await 1; }\nexport {};\n'));
    entries.set(`${P + entry}.map`, Buffer.from('{}'));
  }
  for (const [file, bytes] of sources()) entries.set(P + file, Buffer.from(bytes));
  return entries;
};

test('the expected bundled extension passes', () => {
  assert.deepEqual(extensionFailures(goodEntries(), sources()), []);
});

test('a .d.ts under dist/extension fails', () => {
  const entries = goodEntries();
  entries.set(`${P}background.d.ts`, Buffer.from(''));
  assert.deepEqual(extensionFailures(entries, sources()), [
    `declaration file shipped: ${P}background.d.ts`,
  ]);
});

test('a missing entry or source map fails, and so does an unexpected file', () => {
  const entries = goodEntries();
  entries.delete(`${P}admin.js.map`);
  entries.delete(`${P}popup.js`);
  entries.set(`${P}inpage/builders.js`, Buffer.from(''));
  assert.deepEqual(extensionFailures(entries, sources()), [
    `missing entry ${P}popup.js`,
    `missing entry ${P}admin.js.map`,
    `unexpected entry ${P}inpage/builders.js`,
  ]);
});

test('a manifest, page or icon that differs from packages/extension fails', () => {
  const entries = goodEntries();
  entries.set(`${P}manifest.json`, Buffer.from(manifest('2.0.0')));
  entries.set(`${P}icons/icon-16.png`, Buffer.from([9]));
  assert.deepEqual(extensionFailures(entries, sources()), [
    `${P}manifest.json differs from packages/extension/manifest.json`,
    `${P}icons/icon-16.png differs from packages/extension/icons/icon-16.png`,
  ]);
});

test('a manifest naming another service worker fails', () => {
  const entries = goodEntries();
  const renamed = Buffer.from(manifest('1.0.0', 'worker.js'));
  entries.set(`${P}manifest.json`, renamed);
  const expected = sources().set('manifest.json', renamed);
  assert.deepEqual(extensionFailures(entries, expected), [
    `${P}manifest.json names service worker worker.js, expected background.js`,
  ]);
});

test('a top-level await in a page module passes', () => {
  const entries = goodEntries();
  entries.set(`${P}popup.js`, Buffer.from('const lang = await start();\nexport {};\n'));
  assert.deepEqual(extensionFailures(entries, sources()), []);
});

test('a top-level await in the service worker fails', () => {
  const entries = goodEntries();
  entries.set(`${P}background.js`, Buffer.from('const x = await fetch("/");\nexport {};\n'));
  assert.deepEqual(extensionFailures(entries, sources()), [
    `${P}background.js (the service worker) has a top-level await`,
  ]);
});

test('hasTopLevelAwait looks at the parsed module, not at the text', () => {
  assert.equal(hasTopLevelAwait('await x;'), true);
  assert.equal(hasTopLevelAwait('for await (const v of xs) {}'), true);
  assert.equal(hasTopLevelAwait('if (a) { const y = await x; }'), true);
  assert.equal(hasTopLevelAwait('async function f() { await x; }'), false);
  assert.equal(hasTopLevelAwait('const f = async () => { for await (const v of xs) {} };'), false);
  assert.equal(hasTopLevelAwait('class C { async m() { await x; } }'), false);
  assert.equal(hasTopLevelAwait('const s = "await x"; // await y'), false);
});
