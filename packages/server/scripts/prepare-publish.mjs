#!/usr/bin/env node
// Pre-publish step run by `npm publish`:
//  1) Build the Chrome extension if its dist is missing, then bundle the
//     assets into the server's dist/extension.
//  2) Copy the repo-root LICENSE next to package.json so npm includes it.
// Cross-platform — only node:fs / node:path / node:child_process, no shell.

import { existsSync, mkdirSync, rmSync, cpSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const serverPkgDir = resolve(here, '..');
const repoRoot = resolve(serverPkgDir, '..', '..');

// 1) Extension assets
const extensionPkgDir = join(repoRoot, 'packages', 'extension');
const extensionDist = join(extensionPkgDir, 'dist');
const extensionTarget = join(serverPkgDir, 'dist', 'extension');

if (!existsSync(join(extensionDist, 'manifest.json'))) {
  // Self-heal: build the extension in-place. shell:true lets Windows resolve
  // npm.cmd via PATHEXT — without it spawnSync can't execute .cmd files.
  // Args are static so there's no shell-injection surface.
  console.log('[prepare-publish] extension dist missing — building it now…');
  const r = spawnSync('npm', ['run', 'build'], {
    cwd: extensionPkgDir,
    stdio: 'inherit',
    shell: true,
  });
  if (r.status !== 0) {
    console.error('[prepare-publish] extension build failed (exit ' + r.status + ').');
    process.exit(r.status ?? 1);
  }
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
