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
import { BRIDGE_PORT, DEFAULT_BRIDGE_PORT } from './bridge/protocol.js';
import { WS_PORT } from './bridge/ws-bridge.js';

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

/*
 * DRIFT GUARD for the WS bridge port. `@browser-link/shared` defines
 * BRIDGE_PORT; the server (`bridge/protocol.ts`, published standalone) and
 * the extension (`background.ts`, compiled by plain tsc with no bundler)
 * each keep a copy because neither can import the workspace package at
 * runtime. All three must agree, or the extension dials a port nobody
 * listens on. The server's copy is DEFAULT_BRIDGE_PORT; BRIDGE_PORT is that
 * default unless BROWSER_LINK_WS_PORT overrides it (isolated second instance,
 * e.g. the e2e harness, which patches its own extension copy to match).
 */
describe('BRIDGE_PORT drift guard', () => {
  const SHARED_INDEX = join(here, '..', '..', 'shared', 'src', 'index.ts');
  const EXT_BACKGROUND = join(here, '..', '..', 'extension', 'src', 'background.ts');

  function portIn(file: string): number {
    const m = /^(?:export )?const BRIDGE_PORT = (\d+);$/m.exec(read(file));
    if (!m) throw new Error(`could not find BRIDGE_PORT in ${file}`);
    return Number(m[1]);
  }

  test('the server, shared and extension copies are equal, and the WS bridge binds it', () => {
    expect(portIn(SHARED_INDEX)).toBe(DEFAULT_BRIDGE_PORT);
    expect(portIn(EXT_BACKGROUND)).toBe(DEFAULT_BRIDGE_PORT);
    expect(WS_PORT).toBe(BRIDGE_PORT);
  });

  test('the extension dials the constant, not a literal', () => {
    expect(read(EXT_BACKGROUND)).toMatch(/const WS_URL = `ws:\/\/127\.0\.0\.1:\$\{BRIDGE_PORT\}`;/);
  });

  test('the port is still 17529 (no runtime change)', () => {
    expect(DEFAULT_BRIDGE_PORT).toBe(17529);
    if (!process.env.BROWSER_LINK_WS_PORT) expect(BRIDGE_PORT).toBe(17529);
  });
});

/*
 * DRIFT GUARD for the wire protocol. `packages/shared/src/index.ts` is the
 * canonical definition (the extension imports it); `messages.ts` is the
 * server's verbatim copy, kept because the published server cannot depend
 * on the private workspace package. The protocol section is delimited by
 * the same two marker lines in both files and must be byte-identical
 * between them (line endings normalised). Only the copy's header above the
 * opening marker may differ.
 */
describe('wire protocol drift guard: packages/shared/src/index.ts', () => {
  const SHARED_INDEX = join(here, '..', '..', 'shared', 'src', 'index.ts');
  const SERVER_MESSAGES = join(here, 'messages.ts');
  const BEGIN = '// <wire-protocol> verbatim in packages/server/src/messages.ts';
  const END = '// </wire-protocol>';

  function protocolSection(file: string): string {
    const text = read(file);
    const start = text.indexOf(BEGIN);
    const end = text.indexOf(END);
    if (start < 0 || end < 0 || end < start) {
      throw new Error(`could not find the wire-protocol markers in ${file}`);
    }
    return text.slice(start, end + END.length);
  }

  test('the server copy of the protocol section is byte-identical to shared', () => {
    const shared = protocolSection(SHARED_INDEX).split('\n');
    const server = protocolSection(SERVER_MESSAGES).split('\n');
    const firstDiff = shared.findIndex((line, i) => line !== server[i]);
    const at = firstDiff >= 0 ? firstDiff : shared.length < server.length ? shared.length : -1;
    expect(
      at,
      at < 0
        ? 'identical'
        : `first differing line ${at + 1} of the section:\n  shared: ${shared[at]}\n  server: ${server[at]}`,
    ).toBe(-1);
  });

  test('the server copy carries the guard header', () => {
    const header = read(SERVER_MESSAGES).split(BEGIN)[0];
    expect(header).toContain('Copied from packages/shared/src/index.ts');
    expect(header).toContain('config.drift.test.ts');
  });
});
