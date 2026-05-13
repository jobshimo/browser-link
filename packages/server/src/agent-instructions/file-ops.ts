import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { VERSION } from '../version.js';
import { block, findBlockSpan } from './content.js';
import type { InstructionsDetect } from './types.js';

/**
 * Shared file-level operations for the three agent-instructions installers.
 * Per-client modules only know which path their target file lives at; the
 * marker handling and the text splice are the same everywhere.
 */

function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

export function detectAt(filePath: string): InstructionsDetect {
  if (!existsSync(filePath)) {
    return { filePath, state: { kind: 'no-file' } };
  }
  const text = readFileSync(filePath, 'utf8');
  const span = findBlockSpan(text);
  if (!span) {
    return { filePath, state: { kind: 'not-installed' } };
  }
  const installedVersion = span.installedVersion ?? '0.0.0';
  const cmp = compareSemver(installedVersion, VERSION);
  return {
    filePath,
    state:
      cmp < 0
        ? { kind: 'installed-outdated', version: installedVersion }
        : { kind: 'installed', version: installedVersion },
  };
}

/**
 * Insert or refresh the block in `filePath`. Returns a one-line description
 * of what changed, suitable for surfacing to the user.
 */
export function installAt(filePath: string, displayName: string): string {
  const fresh = block();
  if (!existsSync(filePath)) {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, fresh, 'utf8');
    return `Created ${filePath} and inserted the browser-link instructions block for ${displayName}.`;
  }
  const text = readFileSync(filePath, 'utf8');
  const span = findBlockSpan(text);
  if (!span) {
    // Append. Ensure a blank line separator from prior content.
    const separator =
      text.length === 0 || text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
    writeFileSync(filePath, text + separator + fresh, 'utf8');
    return `Appended the browser-link instructions block to ${filePath} (${displayName}).`;
  }
  const before = text.slice(0, span.startIndex);
  const after = text.slice(span.endIndex);
  writeFileSync(filePath, before + fresh + after, 'utf8');
  const prev = span.installedVersion ?? 'unversioned';
  return `Refreshed the browser-link instructions block in ${filePath} (${displayName}, was v${prev}).`;
}

export function uninstallAt(filePath: string, displayName: string): string {
  if (!existsSync(filePath)) {
    return `No ${displayName} instructions file at ${filePath}; nothing to remove.`;
  }
  const text = readFileSync(filePath, 'utf8');
  const span = findBlockSpan(text);
  if (!span) {
    return `browser-link instructions block was not present in ${filePath}; nothing to remove.`;
  }
  const before = text.slice(0, span.startIndex);
  const after = text.slice(span.endIndex);
  // Collapse double blank lines created by removing the block, but keep the
  // user's own content. A single trailing newline at EOF is restored.
  let next = (before + after).replace(/\n{3,}/g, '\n\n');
  if (next.length > 0 && !next.endsWith('\n')) next += '\n';
  writeFileSync(filePath, next, 'utf8');
  return `Removed the browser-link instructions block from ${filePath} (${displayName}).`;
}
