import { describe, expect, test } from 'vitest';
import type { ClientId } from '../agent-instructions/index.js';
import { displayNameColumnWidth, formatStatus, type InstructionsReport } from './instructions.js';

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
