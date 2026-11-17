import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * DRIFT GUARD for the verbatim copies under `packages/server/src/cdp/`.
 *
 * `cdp/settle.ts`, `cdp/expect.ts`, `cdp/keymap.ts`, `cdp/screenshot.ts`,
 * `cdp/flow.ts`, `cdp/clock.ts` and `cdp/observer-host.ts` are independent copies of their
 * `packages/extension/src/` originals (the server publishes to npm
 * standalone and cannot depend on the private `@browser-link/extension`
 * package — see each copy's header comment). That duplication is exactly
 * the class of bug the flow-recorder security work just addressed: a
 * security fix landed in ONE copy of shared DOM logic would silently NOT
 * reach the other.
 *
 * This test fails the build the moment the security-relevant DOM logic
 * drifts, so the two copies can never diverge unnoticed:
 *   - The in-page code (`DEEP_QUERY_JS`, `DOM_HELPERS_JS`, the builders and the
 *     page observer) is no longer copied: it lives once in `packages/core`
 *     and the server compiles the generated mirror (`scripts/sync-core.mjs`,
 *     checked by `sync-core --check`), so it has no section here.
 *   - `settle.ts`, `expect.ts`, `keymap.ts`, `screenshot.ts`, `flow.ts` and `clock.ts` are compared FULL-BODY (every
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
const EXT_ROOT = join(here, '..', '..', '..', 'extension', 'src');
// The detached-flow ceiling lives in core since slice 5b-2 (flow-registry.ts re-exports it).
const CORE_ROOT = join(here, '..', '..', '..', 'core', 'src');
const SRV_ROOT = here;
const SRV_TOOLS = join(here, '..', 'tools');

function read(file: string): string {
  return readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
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

/** Where the extension and the server each import the in-page builders from:
 * the extension from `@browser-link/core`, the server from its generated
 * mirror of core (it publishes standalone). The one line allowed to differ
 * in an otherwise byte-identical copy, so it is normalised before comparing. */
function normaliseCoreImport(text: string): string {
  return text.replace(
    /from '(?:@browser-link\/core|\.\.\/generated\/core\/inpage\/(?:builders|observer)\.js)';/g,
    "from '<core in-page module>';",
  );
}

/** Everything from the first line containing `marker` to the end of the
 * file. Used for `observer-host.ts`, whose import block cannot be identical:
 * the extension imports the observer types from `@browser-link/shared`,
 * which the standalone server package cannot resolve, so the server copy
 * declares them locally between its header and the shared body. */
function bodyFrom(text: string, marker: string): string {
  const start = text.indexOf(marker);
  if (start < 0) throw new Error(`could not find ${JSON.stringify(marker)}`);
  return text.slice(start);
}

/** Text of `export interface NAME { ... }` / `export type NAME = ...;` with
 * the `export ` keyword dropped, so an exported declaration (in
 * `@browser-link/shared`) compares equal to a module-local one. */
function typeDeclaration(text: string, name: string): string {
  const iface = new RegExp(`(?:export )?interface ${name} \\{[\\s\\S]*?\\n\\}`).exec(text);
  if (iface) return iface[0].replace(/^export /, '');
  const alias = new RegExp(`(?:export )?type ${name} = [^;]+;`).exec(text);
  if (alias) return alias[0].replace(/^export /, '');
  throw new Error(`could not find type ${name}`);
}

describe('cdp verbatim-copy drift guard: observer host (body below the imports)', () => {
  const HOST_BODY_MARKER = '/** Summaries kept in the host mirror';

  test('observer-host.ts body is byte-identical to the extension original', () => {
    const extText = read(join(EXT_ROOT, 'observer-host.ts'));
    const srvText = read(join(SRV_ROOT, 'observer-host.ts'));
    expect(bodyFrom(srvText, HOST_BODY_MARKER)).toBe(bodyFrom(extText, HOST_BODY_MARKER));
    // Both copies read the observer global from the one core module (the
    // server through its generated mirror).
    expect(extText).toContain("import { OBSERVER_GLOBAL } from '@browser-link/core';");
    expect(srvText).toContain(
      "import { OBSERVER_GLOBAL } from '../generated/core/inpage/observer.js';",
    );
    // Sanity: the body is the real module, not an empty match.
    const body = bodyFrom(srvText, HOST_BODY_MARKER);
    expect(body).toContain('export function mergeSettleChanges');
    expect(body).toContain('export function applyObserverMessage');
  });

  test('the server copy declares the observer types exactly as @browser-link/shared does', () => {
    const shared = read(join(here, '..', '..', '..', 'shared', 'src', 'index.ts'));
    const srvText = read(join(SRV_ROOT, 'observer-host.ts'));
    for (const name of [
      'PageObserverKinds',
      'PageObserverRoots',
      'PageObserverDescriptor',
      'PageObserverSummary',
      'PageObserverDocStart',
      'PageObserverNav',
      'PageObserverMessage',
      'SettleChanges',
    ]) {
      expect(typeDeclaration(srvText, name), name).toBe(typeDeclaration(shared, name));
    }
  });
});

describe('cdp verbatim-copy drift guard: settle/keymap/flow (full body)', () => {
  test('settle.ts body is byte-identical to the extension original', () => {
    const ext = normaliseCoreImport(stripHeader(read(join(EXT_ROOT, 'settle.ts'))));
    const srv = normaliseCoreImport(stripHeader(read(join(SRV_ROOT, 'settle.ts'))));
    expect(srv).toBe(ext);
    // Sanity: the stripped body is the real module, not an empty match.
    expect(srv).toContain('export const MAX_SETTLE_MS');
    expect(srv).toContain('export async function settleSafely');
  });

  test('expect.ts body is byte-identical to the extension original', () => {
    const ext = normaliseCoreImport(stripHeader(read(join(EXT_ROOT, 'expect.ts'))));
    const srv = normaliseCoreImport(stripHeader(read(join(SRV_ROOT, 'expect.ts'))));
    expect(srv).toBe(ext);
    expect(srv).toContain('export const MAX_EXPECT_TIMEOUT_MS');
    expect(srv).toContain('export async function verifyExpect');
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

  test('screenshot.ts body is byte-identical to the extension original', () => {
    const ext = stripHeader(read(join(EXT_ROOT, 'screenshot.ts')));
    const srv = stripHeader(read(join(SRV_ROOT, 'screenshot.ts')));
    expect(srv).toBe(ext);
    expect(srv).toContain('export function planClip');
    expect(srv).toContain('export async function runScreenshot');
  });

  test('flow.ts body is byte-identical to the extension original', () => {
    const ext = stripHeader(read(join(EXT_ROOT, 'flow.ts')));
    const srv = stripHeader(read(join(SRV_ROOT, 'flow.ts')));
    expect(srv).toBe(ext);
    expect(srv).toContain('export const MAX_FLOW_STEPS = 20;');
    expect(srv).toContain('export async function runFlow');
  });

  // Slices 5b-1 to 8 only (design 5.1): both flow.ts copies and both
  // expect.ts copies import `Clock` from this sibling, so the two must
  // declare the same port. Deleted with the cdp/flow.ts copy in slice 8.
  test('clock.ts body is byte-identical to the extension original', () => {
    const ext = stripHeader(read(join(EXT_ROOT, 'clock.ts')));
    const srv = stripHeader(read(join(SRV_ROOT, 'clock.ts')));
    expect(srv).toBe(ext);
    expect(srv).toContain('export interface Clock');
    expect(srv).toContain('after(ms: number, fn: () => void): () => void;');
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
    const core = numericConstant(
      read(join(CORE_ROOT, 'support', 'flow-limits.ts')),
      'MAX_DETACHED_FLOW_MS',
    );
    const cdp = numericConstant(read(join(SRV_ROOT, 'detached-flows.ts')), 'MAX_DETACHED_FLOW_MS');

    expect(dispatch).toBe(30 * 60_000);
    expect(core).toBe(dispatch);
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
