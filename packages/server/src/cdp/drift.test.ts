import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * DRIFT GUARD for the manually-synced constants the transports share.
 *
 * Nothing under `packages/server/src/cdp/` is a verbatim copy of an
 * extension file any more: the in-page code (slice 6), the support modules
 * (slice 7) and the flow engine with its `Clock` port (slice 8) live once in
 * `packages/core`, and the server compiles the generated mirror
 * (`scripts/sync-core.mjs`, checked by `sync-core --check`), so they have
 * no section here. What remains are the numeric constants below, which two
 * implementations declare by hand and this file keeps equal.
 *
 * If you INTENTIONALLY change one of them, change its sibling too and this
 * test goes green again — that is the whole point.
 */

const here = dirname(fileURLToPath(import.meta.url));
// here = packages/server/src/cdp
// The detached-flow ceiling lives in core since slice 5b-2, the record bounds
// since slice 17 (`flow/detached-flows.ts`).
const CORE_ROOT = join(here, '..', '..', '..', 'core', 'src');
const SRV_ROOT = here;
const SRV_TOOLS = join(here, '..', 'tools');

function read(file: string): string {
  return readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

/*
 * DRIFT GUARD for the manually-synced detached-flow constants.
 *
 * These files are NOT copies of each other — the
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
    const core = numericConstant(
      read(join(CORE_ROOT, 'flow', 'detached-flows.ts')),
      'MAX_DETACHED_MANIFEST_BYTES',
    );
    const cdp = numericConstant(
      read(join(SRV_ROOT, 'detached-flows.ts')),
      'MAX_DETACHED_MANIFEST_BYTES',
    );
    expect(cdp).toBe(core);
  });

  test('the finished-record cap is the same on both transports', () => {
    const core = numericConstant(
      read(join(CORE_ROOT, 'flow', 'detached-flows.ts')),
      'MAX_DETACHED_FLOW_RECORDS',
    );
    const cdp = numericConstant(
      read(join(SRV_ROOT, 'detached-flows.ts')),
      'MAX_DETACHED_FLOW_RECORDS',
    );
    expect(cdp).toBe(core);
  });
});
