import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClientId } from '../agent-instructions/index.js';
import { BEGIN_PREFIX, END_MARKER, beginMarker } from '../agent-instructions/content.js';
import { installAt } from '../agent-instructions/file-ops.js';
import { VERSION } from '../version.js';
import {
  describeState,
  displayNameColumnWidth,
  formatStatus,
  type InstructionsReport,
} from './instructions.js';

/**
 * Format-layer tests for `commands/instructions.ts`. The interesting bits
 * are width calculation and the resulting `formatStatus` layout — the
 * stateful action helpers are exercised through the per-installer suite.
 */

function report(displayName: string, client: ClientId = 'claude'): InstructionsReport {
  return {
    client,
    displayName,
    filePath: '/tmp/AGENTS.md',
    state: { kind: 'no-file' },
    ok: true,
  };
}

describe('displayNameColumnWidth', () => {
  test('returns longest length + 2 breathing gap', () => {
    expect(displayNameColumnWidth(['ab', 'abcd', 'a'])).toBe(6);
  });

  test('handles an empty list without going negative', () => {
    expect(displayNameColumnWidth([])).toBe(2);
  });

  test('grows with a long display name', () => {
    const longest = 'A Very Long Hypothetical Future Client Name';
    expect(displayNameColumnWidth(['Claude Code', longest])).toBe(longest.length + 2);
  });
});

describe('formatStatus', () => {
  test('pads every displayName to the same column width — long name does not truncate', () => {
    const longest = 'A Very Long Hypothetical Future Client Name';
    const reports: InstructionsReport[] = [report('Claude Code'), report(longest, 'opencode')];
    const out = formatStatus(reports, 'en');
    // The long name appears in full — no truncation.
    expect(out).toContain(longest);
    // The short name is padded so the status column lines up. We assert
    // by reconstructing the expected prefix.
    const width = longest.length + 2;
    expect(out).toContain(`  ${'Claude Code'.padEnd(width)} `);
    expect(out).toContain(`  ${longest.padEnd(width)} `);
  });
});

describe('describeState — installed-outdated copy', () => {
  test('EN string mentions the outdated version and the refresh command', () => {
    const label = describeState({ kind: 'installed-outdated', version: '0.0.1' }, 'en');
    expect(label).toContain('outdated');
    expect(label).toContain('0.0.1');
    expect(label).toContain('browser-link instructions install');
  });

  test('ES string mentions desactualizado in Rioplatense-friendly wording', () => {
    const label = describeState({ kind: 'installed-outdated', version: '0.0.1' }, 'es');
    expect(label).toContain('desactualizado');
    expect(label).toContain('0.0.1');
  });

  test('legacy (version null) renders the legacy label, not a v-prefix', () => {
    const en = describeState({ kind: 'installed-outdated', version: null }, 'en');
    expect(en).toContain('legacy');
    const es = describeState({ kind: 'installed-outdated', version: null }, 'es');
    expect(es).toContain('legacy');
  });
});

describe('installAt — v0.8.3 refresh message', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'browser-link-refresh-msg-'));
    file = join(dir, 'AGENTS.md');
    // Anchor $HOME inside the temp dir so the outside-$HOME guard accepts
    // the file. The guard reads homedir() live, so swapping the env var
    // here is enough.
    if (process.platform === 'win32') process.env.USERPROFILE = dir;
    else process.env.HOME = dir;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('refresh message uses the v{prev} → v{VERSION} reflex-protocol wording', () => {
    writeFileSync(file, `${beginMarker('0.0.1')}\nstale\n${END_MARKER}\n`, 'utf8');
    const msg = installAt(file, 'Test Client');
    expect(msg).toContain('v0.0.1');
    expect(msg).toContain(`v${VERSION}`);
    expect(msg).toContain('reflex protocol');
    expect(msg).toContain('restart your MCP client');
    // The stale body is gone.
    const out = readFileSync(file, 'utf8');
    expect(out).not.toContain('stale');
    expect(out).toContain(BEGIN_PREFIX);
  });

  test('legacy (unversioned) block uses "legacy" instead of v{prev}', () => {
    writeFileSync(file, `${BEGIN_PREFIX} -->\nstale\n${END_MARKER}\n`, 'utf8');
    const msg = installAt(file, 'Test Client');
    expect(msg).toContain('legacy');
    expect(msg).toContain(`v${VERSION}`);
    expect(msg).not.toContain('vlegacy');
  });
});
