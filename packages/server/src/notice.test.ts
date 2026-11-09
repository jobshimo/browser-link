import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOTICE } from './notice.js';

/*
 * DRIFT GUARD for the product notice. `packages/shared/src/notice.ts` is the
 * single source (the extension imports it); this package carries a
 * byte-identical copy in `./notice.ts` because the server publishes to npm
 * standalone. The leading `/** ... *\/` header is allowed to differ (it names
 * the sibling); everything below it must match byte for byte — same
 * technique as `cdp/drift.test.ts`.
 */

const here = dirname(fileURLToPath(import.meta.url));
// here = packages/server/src
const SHARED_NOTICE = join(here, '..', '..', 'shared', 'src', 'notice.ts');
const SERVER_NOTICE = join(here, 'notice.ts');

function read(file: string): string {
  return readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

/** Everything after the leading file-header doc comment. */
function bodyBelowHeader(text: string): string {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('/**')) throw new Error('expected a leading /** header */ comment');
  const end = trimmed.indexOf('*/');
  return trimmed.slice(end + 2).trimStart();
}

describe('notice copies', () => {
  test('the server copy is byte-identical to the shared source below the header', () => {
    expect(bodyBelowHeader(read(SERVER_NOTICE))).toBe(bodyBelowHeader(read(SHARED_NOTICE)));
  });
});

describe('notice shape', () => {
  for (const lang of ['es', 'en'] as const) {
    test(`${lang} has a title and exactly 3 non-empty paragraphs`, () => {
      const n = NOTICE[lang];
      expect(n.title.trim().length).toBeGreaterThan(0);
      expect(n.paragraphs).toHaveLength(3);
      for (const p of n.paragraphs) expect(p.trim().length).toBeGreaterThan(0);
    });
  }

  test('titles are the approved ones', () => {
    expect(NOTICE.es.title).toBe('Aviso importante');
    expect(NOTICE.en.title).toBe('Important notice');
  });
});
