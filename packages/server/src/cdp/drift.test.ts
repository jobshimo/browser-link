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
 *   - `settle.ts`, `keymap.ts` and `flow.ts` are compared FULL-BODY (every
 *     line below the leading file-header doc comment, not just the
 *     numeric constants) — the header itself is allowed to differ since it
 *     names the sibling path, which is necessarily file-specific.
 *
 * If you INTENTIONALLY change one copy, apply the identical change to its
 * sibling (adjusting only the header if needed) and this test goes green
 * again — that is the whole point.
 */

const here = dirname(fileURLToPath(import.meta.url));
// here = packages/server/src/cdp
const EXT_INPAGE = join(here, '..', '..', '..', 'extension', 'src', 'inpage');
const EXT_ROOT = join(here, '..', '..', '..', 'extension', 'src');
const SRV_INPAGE = join(here, 'inpage');
const SRV_ROOT = here;
const SRV_TOOLS = join(here, '..', 'tools');

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

/** Strip the leading `/** ... *\/` file-header doc comment and return
 * everything after it. The header is the one place the two copies are
 * INTENTIONALLY allowed to differ (it names the sibling path, which is
 * necessarily file-specific) — everything else must be byte-identical. */
function stripHeader(text: string): string {
  const start = text.indexOf('/**');
  if (start !== 0) throw new Error('expected file to start with a header doc comment');
  const end = text.indexOf('*/', start);
  if (end < 0) throw new Error('unterminated header doc comment');
  return text.slice(end + 2);
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

describe('cdp verbatim-copy drift guard: settle/keymap/flow (full body)', () => {
  test('settle.ts body is byte-identical to the extension original', () => {
    const ext = stripHeader(read(join(EXT_ROOT, 'settle.ts')));
    const srv = stripHeader(read(join(SRV_ROOT, 'settle.ts')));
    expect(srv).toBe(ext);
    // Sanity: the stripped body is the real module, not an empty match.
    expect(srv).toContain('export const MAX_SETTLE_MS');
    expect(srv).toContain('export async function settleSafely');
  });

  test('keymap.ts body is byte-identical to the extension original', () => {
    const ext = stripHeader(read(join(EXT_ROOT, 'keymap.ts')));
    const srv = stripHeader(read(join(SRV_ROOT, 'keymap.ts')));
    expect(srv).toBe(ext);
    // Sanity: the modifier bitmask feeds trusted CDP key events — a drift
    // here would silently change what Shift/Control/etc. dispatch as.
    expect(srv).toContain('Shift: 8');
    expect(srv).toContain('export function buildKeyEventSequence');
  });

  test('flow.ts body is byte-identical to the extension original', () => {
    const ext = stripHeader(read(join(EXT_ROOT, 'flow.ts')));
    const srv = stripHeader(read(join(SRV_ROOT, 'flow.ts')));
    expect(srv).toBe(ext);
    expect(srv).toContain('export const MAX_FLOW_STEPS = 20;');
    expect(srv).toContain('export async function runFlow');
  });
});

/*
 * DRIFT GUARD for the manually-synced detached-flow constants.
 *
 * Unlike the modules above these files are NOT copies of each other — the
 * three detached-flow implementations are deliberately different shapes
 * (see `detached-flows.ts`'s header). What they do share is a NUMBER that
 * must agree across all three, and a comment in each saying "kept in sync
 * manually". A ceiling that is 30 minutes in the dispatcher's up-front
 * budget check but 20 in the runner's deadline would reject flows it then
 * cannot run, or run flows past the bound it validated them against —
 * silently, and only for runs long enough to notice. Reading the numbers
 * out of the sources is what turns "kept in sync manually" into a
 * statement the build can check.
 */

/** Value of a `const NAME = <numeric literals joined by *>;` declaration.
 * The ceilings are written as a product (`30 * 60_000`) on purpose — the
 * unit is part of the documentation — so the factors are multiplied out
 * rather than string-compared, and the same number spelled `1_800_000`
 * somewhere else would still match. Deliberately arithmetic on parsed
 * literals, never `eval`: this reads source files. */
function numericConstant(text: string, name: string): number {
  const match = new RegExp(`\\b(?:export )?const ${name} = ([^;]+);`).exec(text);
  if (!match) throw new Error(`could not find ${name}`);
  const value = match[1]
    .split('*')
    .reduce((product, factor) => product * Number(factor.trim().replace(/_/g, '')), 1);
  if (!Number.isFinite(value)) throw new Error(`${name} is not a product of numeric literals`);
  return value;
}

describe('manually-synced constant drift guard: the detached-flow ceiling', () => {
  test('the 30-minute ceiling is the same number in all three packages', () => {
    const dispatch = numericConstant(
      read(join(SRV_TOOLS, 'browser-dispatch.ts')),
      'MAX_DETACHED_FLOW_TIMEOUT_MS',
    );
    const extension = numericConstant(
      read(join(EXT_ROOT, 'flow-registry.ts')),
      'MAX_DETACHED_FLOW_MS',
    );
    const cdp = numericConstant(read(join(SRV_ROOT, 'detached-flows.ts')), 'MAX_DETACHED_FLOW_MS');

    expect(dispatch).toBe(30 * 60_000);
    expect(extension).toBe(dispatch);
    expect(cdp).toBe(dispatch);
  });

  test('the manifest byte ceiling is the same on both transports', () => {
    const extension = numericConstant(
      read(join(EXT_ROOT, 'flow-registry.ts')),
      'MAX_DETACHED_MANIFEST_BYTES',
    );
    const cdp = numericConstant(
      read(join(SRV_ROOT, 'detached-flows.ts')),
      'MAX_DETACHED_MANIFEST_BYTES',
    );
    expect(cdp).toBe(extension);
  });

  test('the finished-record cap is the same on both transports', () => {
    const extension = numericConstant(
      read(join(EXT_ROOT, 'flow-registry.ts')),
      'MAX_DETACHED_FLOW_RECORDS',
    );
    const cdp = numericConstant(
      read(join(SRV_ROOT, 'detached-flows.ts')),
      'MAX_DETACHED_FLOW_RECORDS',
    );
    expect(cdp).toBe(extension);
  });
});
