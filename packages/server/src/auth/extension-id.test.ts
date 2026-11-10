import { describe, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PINNED_EXTENSION_ID, PINNED_EXTENSION_ORIGIN } from './extension-id.js';

const here = dirname(fileURLToPath(import.meta.url));
// here = packages/server/src/auth
const MANIFEST = join(here, '..', '..', '..', 'extension', 'manifest.json');

/** Chrome's id for an extension carrying `key`: SHA-256 of the DER public
 * key, first 16 bytes, each hex digit 0-f written as a letter a-p. */
function chromeExtensionId(base64Key: string): string {
  const digest = createHash('sha256').update(Buffer.from(base64Key, 'base64')).digest('hex');
  return [...digest.slice(0, 32)]
    .map((digit) => String.fromCharCode('a'.charCodeAt(0) + parseInt(digit, 16)))
    .join('');
}

describe('pinned extension id', () => {
  test('the manifest key produces exactly the pinned id, so a changed key cannot drift silently', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as { key?: unknown };
    expect(typeof manifest.key).toBe('string');
    expect(chromeExtensionId(manifest.key as string)).toBe(PINNED_EXTENSION_ID);
  });

  test('is a Chrome extension id (32 letters a-p) and its origin is chrome-extension://<id>', () => {
    expect(PINNED_EXTENSION_ID).toMatch(/^[a-p]{32}$/);
    expect(PINNED_EXTENSION_ORIGIN).toBe(`chrome-extension://${PINNED_EXTENSION_ID}`);
  });
});
