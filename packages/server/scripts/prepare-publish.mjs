#!/usr/bin/env node
// Pre-publish step run by `pnpm publish` (or `npm publish` if you prefer
// the legacy command — the tarball uploaded to registry.npmjs.org is
// identical either way):
//  1) Build the Chrome extension, then bundle the assets into the server's
//     dist/extension.
//  2) Copy the repo-root LICENSE next to package.json so npm includes it.
// Cross-platform — only node:fs / node:path / node:child_process, no shell.

import { existsSync, mkdirSync, rmSync, cpSync, copyFileSync, readFileSync } from 'node:fs';
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

// ALWAYS rebuild the extension before bundling. The previous logic only
// rebuilt when `dist/manifest.json` was missing — that meant a stale
// `dist/` from a months-old build (eg manifest still at 0.4.0) would be
// shipped untouched even after we bumped the source manifest. v0.5.3 hit
// this exact trap: published with extension at 0.4.0 internally.
//
// `prepublishOnly` for the server only runs `tsc` in the server workspace,
// so the extension needs its own rebuild before we copy. We blow away the
// extension's own dist/ first to make sure no stale file lingers.
console.log('[prepare-publish] cleaning + rebuilding the extension…');
if (existsSync(extensionDist)) rmSync(extensionDist, { recursive: true, force: true });
const r = spawnSync('pnpm', ['run', 'build'], {
  cwd: extensionPkgDir,
  stdio: 'inherit',
  // shell:true lets Windows resolve pnpm.cmd via PATHEXT — without it
  // spawnSync can't execute .cmd files. Args are static so there's no
  // shell-injection surface.
  shell: true,
});
if (r.status !== 0) {
  console.error('[prepare-publish] extension build failed (exit ' + r.status + ').');
  process.exit(r.status ?? 1);
}

// Sanity check: the freshly built manifest must agree with the server's
// version. If they ever drift apart (someone hand-edits one and not the
// other) we fail loud here instead of shipping an inconsistent bundle.
const serverPkg = JSON.parse(readFileSync(join(serverPkgDir, 'package.json'), 'utf8'));
const extensionManifest = JSON.parse(readFileSync(join(extensionDist, 'manifest.json'), 'utf8'));
if (extensionManifest.version !== serverPkg.version) {
  console.error(
    '[prepare-publish] version mismatch — refusing to bundle.\n' +
      `  server  package.json: ${serverPkg.version}\n` +
      `  extension manifest:   ${extensionManifest.version}\n` +
      'Align both (use `pnpm run release` or edit by hand) and try again.',
  );
  process.exit(1);
}

if (existsSync(extensionTarget)) rmSync(extensionTarget, { recursive: true, force: true });
mkdirSync(extensionTarget, { recursive: true });
cpSync(extensionDist, extensionTarget, { recursive: true });
console.log(
  `[prepare-publish] bundled extension v${extensionManifest.version} → ${extensionTarget}`,
);

// 2) LICENSE copy
const licenseSrc = join(repoRoot, 'LICENSE');
const licenseDst = join(serverPkgDir, 'LICENSE');
if (existsSync(licenseSrc)) {
  copyFileSync(licenseSrc, licenseDst);
  console.log(`[prepare-publish] copied LICENSE → ${licenseDst}`);
} else {
  console.warn('[prepare-publish] no LICENSE at repo root — package will publish without one.');
}
