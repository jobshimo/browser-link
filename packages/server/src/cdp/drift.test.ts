import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * DRIFT GUARD for the verbatim copies under `packages/server/src/cdp/`.
 *
 * `cdp/inpage/{deep-query,dom-helpers,builders}.ts`, `cdp/settle.ts`,
 * `cdp/keymap.ts` and `cdp/flow.ts` are independent copies of their
 * `packages/extension/src/` originals (the server publishes to npm
 * standalone and cannot depend on the private `@browser-link/extension`
 * package — see each copy's header comment). That duplication is exactly
 * the class of bug the flow-recorder security work just addressed: a
 * security fix landed in ONE copy of shared DOM logic would silently NOT
 * reach the other.
 *
 * This test fails the build the moment the security-relevant DOM logic
 * drifts, so the two copies can never diverge unnoticed:
 *   - The injected `DEEP_QUERY_JS` / `DOM_HELPERS_JS` bodies (visibility,
 *     selector generation, deep traversal, occlusion hit-testing — the
 *     actual JS that runs in the page) must be byte-identical.
 *   - The numeric safety invariants of settle/flow/keymap must match.
 *
 * If you INTENTIONALLY change one copy, apply the identical change to its
 * sibling and this test goes green again — that is the whole point.
 */

const here = dirname(fileURLToPath(import.meta.url));
// here = packages/server/src/cdp
const EXT_INPAGE = join(here, '..', '..', '..', 'extension', 'src', 'inpage');
const EXT_ROOT = join(here, '..', '..', '..', 'extension', 'src');
const SRV_INPAGE = join(here, 'inpage');
const SRV_ROOT = here;

function read(file: string): string {
  return readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

/** Extract the raw body of an `export const NAME = \`...\`;` template
 * literal. deep-query/dom-helpers bodies contain no nested backticks (their
 * only backticks live in the doc-comment header ABOVE the export), so the
 * first backtick after the marker opens the template and the next one
 * closes it. */
function templateBody(text: string, name: string): string {
  const marker = `export const ${name} = `;
  const start = text.indexOf(marker);
  if (start < 0) throw new Error(`could not find ${name}`);
  const open = text.indexOf('`', start + marker.length);
  const close = text.indexOf('`', open + 1);
  return text.slice(open + 1, close);
}

/** Pull `export const NAME = <number>;` values so numeric contracts can be
 * compared regardless of surrounding comments. Underscored numeric
 * separators (10_000) are normalized away. */
function numericConst(text: string, name: string): number {
  const m = new RegExp(`export const ${name} = ([0-9_]+);`).exec(text);
  if (!m) throw new Error(`could not find numeric const ${name}`);
  return Number(m[1].replace(/_/g, ''));
}

describe('cdp verbatim-copy drift guard: injected DOM logic', () => {
  test('DEEP_QUERY_JS body is byte-identical to the extension original', () => {
    const ext = templateBody(read(join(EXT_INPAGE, 'deep-query.ts')), 'DEEP_QUERY_JS');
    const srv = templateBody(read(join(SRV_INPAGE, 'deep-query.ts')), 'DEEP_QUERY_JS');
    expect(srv).toBe(ext);
    // Sanity: the body is the real DOM logic, not an empty match.
    expect(srv).toContain('function deepQueryFirst');
    expect(srv).toContain('function checkOcclusion');
  });

  test('DOM_HELPERS_JS body is byte-identical to the extension original', () => {
    const ext = templateBody(read(join(EXT_INPAGE, 'dom-helpers.ts')), 'DOM_HELPERS_JS');
    const srv = templateBody(read(join(SRV_INPAGE, 'dom-helpers.ts')), 'DOM_HELPERS_JS');
    expect(srv).toBe(ext);
    expect(srv).toContain('function isVisible');
    expect(srv).toContain('function genSelectorInfo');
  });
});

describe('cdp verbatim-copy drift guard: numeric safety invariants', () => {
  test('settle constants match the extension original', () => {
    const ext = read(join(EXT_ROOT, 'settle.ts'));
    const srv = read(join(SRV_ROOT, 'settle.ts'));
    for (const name of [
      'DEFAULT_SETTLE_MS',
      'MAX_SETTLE_MS',
      'DEFAULT_SETTLE_TIMEOUT_MS',
      'MAX_SETTLE_TIMEOUT_MS',
    ]) {
      expect(numericConst(srv, name)).toBe(numericConst(ext, name));
    }
  });

  test('MAX_FLOW_STEPS matches the extension original', () => {
    const ext = read(join(EXT_ROOT, 'flow.ts'));
    const srv = read(join(SRV_ROOT, 'flow.ts'));
    expect(numericConst(srv, 'MAX_FLOW_STEPS')).toBe(numericConst(ext, 'MAX_FLOW_STEPS'));
  });

  test('keymap MODIFIER_BITS mapping matches the extension original', () => {
    // The modifier bitmask feeds trusted CDP key events — a drift here would
    // silently change what Shift/Control/etc. dispatch as. Compare the raw
    // object literal text (bit values only) between the two copies.
    const grabBits = (text: string): string => {
      // Anchor on the EXPORT, not a doc-comment mention of MODIFIER_BITS.
      const m = /export const MODIFIER_BITS[^=]*=\s*\{([\s\S]*?)\}/.exec(text);
      if (!m) throw new Error('could not find MODIFIER_BITS');
      return m[1].replace(/\s+/g, '');
    };
    const ext = grabBits(read(join(EXT_ROOT, 'keymap.ts')));
    const srv = grabBits(read(join(SRV_ROOT, 'keymap.ts')));
    expect(srv).toBe(ext);
    expect(srv).toContain('Shift:8');
  });
});
