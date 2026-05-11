#!/usr/bin/env node
// Pre-publish step run by `npm publish`:
//  1) Bundle the Chrome extension assets into dist/extension.
//  2) Copy the repo-root LICENSE next to package.json so npm includes it.
// Cross-platform — only node:fs / node:path, no shell.

import { existsSync, mkdirSync, rmSync, cpSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const serverPkgDir = resolve(here, '..');
const repoRoot = resolve(serverPkgDir, '..', '..');

// 1) Extension assets
const extensionDist = join(repoRoot, 'packages', 'extension', 'dist');
const extensionTarget = join(serverPkgDir, 'dist', 'extension');

if (!existsSync(join(extensionDist, 'manifest.json'))) {
  console.error(
    '[prepare-publish] extension dist not found at',
    extensionDist,
    '\n  → run `npm run build:extension` from the repo root first.',
  );
  process.exit(1);
}

if (existsSync(extensionTarget)) rmSync(extensionTarget, { recursive: true, force: true });
mkdirSync(extensionTarget, { recursive: true });
cpSync(extensionDist, extensionTarget, { recursive: true });
console.log(`[prepare-publish] bundled extension → ${extensionTarget}`);

// 2) LICENSE copy
const licenseSrc = join(repoRoot, 'LICENSE');
const licenseDst = join(serverPkgDir, 'LICENSE');
if (existsSync(licenseSrc)) {
  copyFileSync(licenseSrc, licenseDst);
  console.log(`[prepare-publish] copied LICENSE → ${licenseDst}`);
} else {
  console.warn('[prepare-publish] no LICENSE at repo root — package will publish without one.');
}
