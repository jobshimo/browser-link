import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRESETS, TOOL_CATALOGUE } from './permissions.js';

/*
 * DRIFT GUARD for the tool counts the two READMEs publish. The root README
 * and `packages/server/README.md` (the page npm shows) both quote the total
 * number of MCP tools, the per-group figures and the `readonly` preset row.
 * They went stale more than once (37 / 40 / 36 / 31 against 40 in code), so
 * every figure is compared with TOOL_CATALOGUE / PRESETS here — same idea as
 * `config.drift.test.ts` for the other hand-kept copies.
 */

const here = dirname(fileURLToPath(import.meta.url));
// here = packages/server/src
const ROOT_README = join(here, '..', '..', '..', 'README.md');
const PACKAGE_README = join(here, '..', 'README.md');

/** Whitespace collapsed so a figure and its noun may sit on different lines. */
function read(file: string): string {
  return readFileSync(file, 'utf8').replace(/\s+/g, ' ');
}

const count = (pred: (m: (typeof TOOL_CATALOGUE)[number]) => boolean): number =>
  TOOL_CATALOGUE.filter(pred).length;

const total = TOOL_CATALOGUE.length;
const bridge = count((m) => m.family === 'bridge');
const map = count((m) => m.family === 'map');
const mapRead = count((m) => m.category === 'map-read');
const mapWrite = count((m) => m.category === 'map-write');
const read_ = count((m) => m.category === 'read');
const action = count((m) => m.category === 'action');
const jsAndLoop = count((m) => m.category === 'eval' || m.category === 'write');
const readonlyDisabled = PRESETS.find((p) => p.id === 'readonly')!.disabled.length;
const readonlyEnabled = total - readonlyDisabled;
/** Bridge tools the readonly preset turns off (the row lists them by name). */
const readonlyBridgeOff = readonlyDisabled - mapWrite;

/** Every `{ label: [regex, expected] }`; each regex has ONE capture group per
 * expected value and must match, otherwise the sentence changed and the guard
 * has to be re-pointed (a silent no-match would defeat it). */
type Check = readonly [pattern: RegExp, expected: readonly number[]];

const ROOT_CHECKS: Record<string, Check> = {
  'intro: bridge / map / total': [
    /(\d+) bridge tools that drive the connected tab, read the activity trail or the manual, or close the knowledge loop, and (\d+) persistent-map tools \((\d+) read, (\d+) write\): (\d+) in all\. All (\d+) are individually toggle-able/,
    [bridge, map, mapRead, mapWrite, total, total],
  ],
  'permissions: total / bridge / map': [
    /exposes \*\*(\d+) MCP tools\*\* — (\d+) bridge tools .*? and (\d+) to read\/write the persistent UI map \((\d+) read, (\d+) write\)\. \*\*All (\d+) are individually toggle-able/,
    [total, bridge, map, mapRead, mapWrite, total],
  ],
  'cli listing': [/current state of all (\d+) toggle-able tools/, [total]],
  'readonly preset row': [
    /\| `readonly` \| The (\d+) non-read bridge tools .*? and the (\d+) map-write tools .*? — (\d+) disabled\. Leaves the (\d+) read bridge tools and the (\d+) map-read tools .*? — (\d+) tools total/,
    [readonlyBridgeOff, mapWrite, readonlyDisabled, read_, mapRead, readonlyEnabled],
  ],
  'no-map preset row': [/\| `no-map` \| All (\d+) persistent-map tools/, [map]],
};

const PACKAGE_CHECKS: Record<string, Check> = {
  'intro: total / bridge / map': [
    /It exposes (\d+) MCP tools — (\d+) for driving the connected tab .*? and (\d+) for a persistent UI map/,
    [total, bridge, map],
  ],
  'cli listing': [/show which of the (\d+) MCP tools are enabled/, [total]],
  'at-a-glance heading': [/## The (\d+) tools, at a glance/, [total]],
  'group: read': [/\| Browser bridge — read \| (\d+) \|/, [read_]],
  'group: actions': [/\| Browser bridge — actions \| (\d+) \|/, [action]],
  'group: js and knowledge loop': [
    /\| Browser bridge — JS and knowledge loop \| (\d+) \|/,
    [jsAndLoop],
  ],
  'group: map': [/\| Persistent UI map \| (\d+) \|/, [map]],
  'map section': [/The (\d+) map tools above/, [map]],
};

/** Returns one message per figure that disagrees with the code. */
export function readmeCountProblems(text: string, checks: Record<string, Check>): string[] {
  const problems: string[] = [];
  for (const [label, [pattern, expected]] of Object.entries(checks)) {
    const m = pattern.exec(text);
    if (!m) {
      problems.push(`${label}: sentence not found (README wording changed?)`);
      continue;
    }
    const got = m.slice(1).map(Number);
    if (got.join(',') !== expected.join(',')) {
      problems.push(`${label}: README says ${got.join('/')}, code says ${expected.join('/')}`);
    }
  }
  // Catch-all: any "<n> tools" / "<n> MCP tools" must be the total or the
  // readonly leftover, so a new stray figure cannot slip in unchecked.
  for (const m of text.matchAll(/\b(\d+) (?:MCP |toggle-able )?tools\b/g)) {
    const n = Number(m[1]);
    if (n !== total && n !== readonlyEnabled) {
      problems.push(`stray figure "${m[0]}" is neither ${total} nor ${readonlyEnabled}`);
    }
  }
  return problems;
}

describe('README tool counts match the catalogue', () => {
  test('the catalogue still has the shape the checks assume', () => {
    expect(bridge + map).toBe(total);
    expect(read_ + action + jsAndLoop).toBe(bridge);
    expect(mapRead + mapWrite).toBe(map);
    expect(readonlyBridgeOff).toBe(action + jsAndLoop);
  });

  test('README.md figures match TOOL_CATALOGUE and the readonly preset', () => {
    expect(readmeCountProblems(read(ROOT_README), ROOT_CHECKS)).toEqual([]);
  });

  test('packages/server/README.md figures match TOOL_CATALOGUE', () => {
    expect(readmeCountProblems(read(PACKAGE_README), PACKAGE_CHECKS)).toEqual([]);
  });

  test('the guard fails when a figure drifts (scratch copy of the text)', () => {
    const root = read(ROOT_README);
    const drifted = root
      .replace(`exposes **${total} MCP tools**`, `exposes **${total - 3} MCP tools**`)
      .replace(`— ${readonlyDisabled} disabled`, `— ${readonlyDisabled - 5} disabled`);
    const problems = readmeCountProblems(drifted, ROOT_CHECKS);
    expect(problems.length).toBeGreaterThanOrEqual(2);
    expect(problems.join('\n')).toContain('permissions: total / bridge / map');
    expect(problems.join('\n')).toContain('readonly preset row');

    const pkg = read(PACKAGE_README).replace(
      '| Browser bridge — actions | 13 |',
      '| Browser bridge — actions | 12 |',
    );
    expect(readmeCountProblems(pkg, PACKAGE_CHECKS).join('\n')).toContain('group: actions');
  });
});
