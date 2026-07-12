import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  clampIdleTtlMinutes,
  DEFAULT_IDLE_TTL_MINUTES,
  MAX_IDLE_TTL_MINUTES,
  MIN_IDLE_TTL_MINUTES,
} from './config.js';

/*
 * DRIFT GUARD for the idle-TTL clamp — `config.ts`'s `clampIdleTtlMinutes`
 * (and its `MIN`/`MAX`/`DEFAULT_IDLE_TTL_MINUTES` constants) is a
 * hand-duplicate of `packages/extension/src/idle-policy.ts`'s function of
 * the same name, for the same npm-publish-isolation reason `cdp/drift.test.ts`'s
 * siblings are duplicated (see that file's header comment).
 *
 * Unlike the `cdp/` copies, the two `clampIdleTtlMinutes` signatures
 * intentionally differ — `(value: number)` here vs `(value: unknown)` on
 * the extension, which also fields raw `chrome.storage` reads and incoming
 * WS payloads — so a byte-for-byte text comparison would always fail on
 * the signature alone. This guard instead:
 *   - reads the extension source from disk as text (same pattern as
 *     `cdp/drift.test.ts`) and extracts its `MIN`/`MAX`/`DEFAULT` bounds,
 *     comparing them against this package's real, imported constants;
 *   - reconstructs the extension's `clampIdleTtlMinutes` BODY (pure JS, no
 *     TS-only syntax inside it) as a sandboxed function via `new Function`,
 *     and runs it against a probe set of values alongside this package's
 *     real, imported `clampIdleTtlMinutes` — any behavioral drift between
 *     the two copies fails the build, exactly like the cdp/ byte-identity
 *     guards do for their own copies.
 */

const here = dirname(fileURLToPath(import.meta.url));
// here = packages/server/src
const EXT_IDLE_POLICY = join(here, '..', '..', 'extension', 'src', 'idle-policy.ts');

function read(file: string): string {
  return readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

/** Pull `export const NAME = <number>;` values so numeric contracts can be
 * compared regardless of surrounding comments. Underscored numeric
 * separators (10_000) are normalized away. Mirrors `cdp/drift.test.ts`'s
 * former helper of the same shape. */
function numericConst(text: string, name: string): number {
  const m = new RegExp(`export const ${name} = ([0-9_]+);`).exec(text);
  if (!m) throw new Error(`could not find numeric const ${name}`);
  return Number(m[1].replace(/_/g, ''));
}

/** Extract the BODY only (no signature, no type annotations) of
 * `export function NAME(...) { ... }`, by brace-matching from the first
 * `{` after the marker. `clampIdleTtlMinutes`'s body contains zero
 * TS-only syntax (no type annotations, casts, or generics inside it), so
 * the extracted text can be handed straight to `new Function` without any
 * TypeScript-stripping step. */
function functionBody(text: string, name: string): string {
  const marker = `export function ${name}(`;
  const start = text.indexOf(marker);
  if (start < 0) throw new Error(`could not find function ${name}`);
  const braceOpen = text.indexOf('{', start);
  if (braceOpen < 0) throw new Error(`could not find body of ${name}`);
  let depth = 0;
  let i = braceOpen;
  for (; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) throw new Error(`unterminated function body for ${name}`);
  return text.slice(braceOpen + 1, i);
}

const extText = read(EXT_IDLE_POLICY);

describe('config idle-ttl clamp drift guard: packages/extension/src/idle-policy.ts', () => {
  test('MIN/MAX/DEFAULT idle-ttl bounds match the extension original', () => {
    expect(MIN_IDLE_TTL_MINUTES).toBe(numericConst(extText, 'MIN_IDLE_TTL_MINUTES'));
    expect(MAX_IDLE_TTL_MINUTES).toBe(numericConst(extText, 'MAX_IDLE_TTL_MINUTES'));
    expect(DEFAULT_IDLE_TTL_MINUTES).toBe(numericConst(extText, 'DEFAULT_IDLE_TTL_MINUTES'));
  });

  test('clampIdleTtlMinutes behaves identically to the extension original over a probe set', () => {
    const extIdleTtlNever = numericConst(extText, 'IDLE_TTL_NEVER');
    const extMin = numericConst(extText, 'MIN_IDLE_TTL_MINUTES');
    const extMax = numericConst(extText, 'MAX_IDLE_TTL_MINUTES');
    const extDefault = numericConst(extText, 'DEFAULT_IDLE_TTL_MINUTES');
    const extClamp = new Function(
      'value',
      'IDLE_TTL_NEVER',
      'MIN_IDLE_TTL_MINUTES',
      'MAX_IDLE_TTL_MINUTES',
      'DEFAULT_IDLE_TTL_MINUTES',
      functionBody(extText, 'clampIdleTtlMinutes'),
    ) as (value: unknown, never_: number, min: number, max: number, def: number) => number;
    const runExtClamp = (value: unknown): number =>
      extClamp(value, extIdleTtlNever, extMin, extMax, extDefault);

    // 0/negatives/floats/huge/garbage/boundary — the same classes of input
    // a corrupted config.json or a malformed WS `settings.update` payload
    // could hand either copy.
    const probes: unknown[] = [
      0,
      -1,
      -1440,
      1,
      1440,
      1441,
      1.5,
      -0.5,
      30,
      1e9,
      Number.MAX_SAFE_INTEGER,
      NaN,
      Infinity,
      -Infinity,
      'never',
      '30',
      null,
      undefined,
      true,
    ];

    for (const probe of probes) {
      const extResult = runExtClamp(probe);
      // The server's declared signature is `(value: number) => number` — in
      // practice it is only ever called with a numeric config field — but
      // that field is read straight out of an untrusted config.json, so
      // exercise it with the same garbage the extension defends against,
      // same trust-boundary treatment `sanitizeCdpPort` and
      // `clampGrantTtlMinutes` get for their own config fields.
      const srvResult = clampIdleTtlMinutes(probe as number);
      expect(srvResult, `probe ${JSON.stringify(probe) ?? String(probe)}`).toBe(extResult);
    }
  });
});
