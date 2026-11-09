#!/usr/bin/env node
// Smoke test of the publishable npm tarball of @jobshimo/browser-link.
//
// Runs in CI before anything irreversible (tag, GitHub Release, npm
// publish) and locally with `node scripts/smoke-tarball.mjs`:
//  1) `pnpm pack` the server package into a fresh temp directory (the
//     `prepack` hook builds the server and bundles the extension).
//  2) List the tarball entries and assert the publishable set is there:
//     dist/cli.js, dist/index.js, dist/extension/manifest.json (with the
//     package version), LICENSE, README.md, and no compiled test files.
//  3) Install the tarball into a temp prefix and run the installed
//     `browser-link version` binary; its stdout must equal the version.
// Every failed assertion prints one `FAIL:` line; the exit code is 1 if
// any assertion failed. Temp directories live under os.tmpdir() and are
// removed on exit.
//
// SMOKE_TARBALL=<path to .tgz> skips step 1 and checks that tarball
// instead (used to prove the assertions fire on a broken package).
// Cross-platform: node built-ins only; the tarball is read with zlib.

import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const serverPkgPath = join(repoRoot, 'packages', 'server', 'package.json');
const { name: pkgName, version } = JSON.parse(readFileSync(serverPkgPath, 'utf8'));
const isWindows = process.platform === 'win32';

const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

/** Quote one argument for the shell spawnSync uses on this platform. */
const quote = (arg) => (isWindows ? `"${arg}"` : `'${arg.replace(/'/g, `'\''`)}'`);

/**
 * Run a command through the shell (Windows needs it to resolve `.cmd`
 * shims such as pnpm.cmd, npm.cmd and the installed bin). Arguments are
 * repo-controlled paths, quoted here.
 */
function run(command, args, options = {}) {
  return spawnSync([command, ...args.map(quote)].join(' '), {
    shell: true,
    encoding: 'utf8',
    ...options,
  });
}

/** Read a .tgz into a Map of entry path -> file content (Buffer). */
function readTarball(tgzPath) {
  const tar = gunzipSync(readFileSync(tgzPath));
  const entries = new Map();
  let offset = 0;
  let longName = null;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start, length) =>
      header
        .subarray(start, start + length)
        .toString('utf8')
        .replace(/\0.*$/s, '');
    const size = parseInt(field(124, 12).trim() || '0', 8);
    const type = field(156, 1);
    const prefix = field(345, 155);
    const body = tar.subarray(offset + 512, offset + 512 + size);
    let name = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100);
    if (longName !== null) {
      name = longName;
      longName = null;
    }
    if (type === 'L') {
      longName = body.toString('utf8').replace(/\0.*$/s, '');
    } else if (type === '0' || type === '') {
      entries.set(name, body);
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

const tempDirs = [];
const makeTemp = (label) => {
  const dir = mkdtempSync(join(tmpdir(), `browser-link-smoke-${label}-`));
  tempDirs.push(dir);
  return dir;
};

try {
  // 1) Pack
  let tgzPath = process.env.SMOKE_TARBALL;
  if (tgzPath) {
    console.log(`[smoke] using SMOKE_TARBALL=${tgzPath}`);
  } else {
    const packDir = makeTemp('pack');
    console.log(`[smoke] packing ${pkgName}@${version} into ${packDir}`);
    const packed = run('pnpm', ['--filter', pkgName, 'pack', '--pack-destination', packDir], {
      cwd: repoRoot,
      stdio: 'inherit',
    });
    if (packed.status !== 0) {
      throw new Error(`pnpm pack exited with ${packed.status}`);
    }
    const tgz = readdirSync(packDir).find((file) => file.endsWith('.tgz'));
    if (!tgz) throw new Error(`pnpm pack produced no .tgz in ${packDir}`);
    tgzPath = join(packDir, tgz);
  }

  // 2) Entries
  const entries = readTarball(tgzPath);
  console.log(`[smoke] ${entries.size} entries in ${tgzPath}`);
  for (const required of [
    'package/package.json',
    'package/dist/cli.js',
    'package/dist/index.js',
    'package/dist/extension/manifest.json',
    'package/LICENSE',
    'package/README.md',
  ]) {
    check(entries.has(required), `missing entry ${required}`);
  }
  const packedPkg = entries.get('package/package.json');
  if (packedPkg) {
    const packedVersion = JSON.parse(packedPkg.toString('utf8')).version;
    check(
      packedVersion === version,
      `package/package.json version is ${packedVersion}, expected ${version}`,
    );
  }
  const manifest = entries.get('package/dist/extension/manifest.json');
  if (manifest) {
    const manifestVersion = JSON.parse(manifest.toString('utf8')).version;
    check(
      manifestVersion === version,
      `dist/extension/manifest.json version is ${manifestVersion}, expected ${version}`,
    );
  }
  const testFiles = [...entries.keys()].filter((entry) => /\.test\.(js|d\.ts)$/.test(entry));
  console.log(`[smoke] compiled test files in the tarball: ${testFiles.length}`);
  check(
    testFiles.length === 0,
    `${testFiles.length} compiled test files shipped (first: ${testFiles[0]})`,
  );

  // 3) Install and run the binary (only when the package looks complete,
  // otherwise the install error would hide the precise failures above).
  if (failures.length === 0) {
    const prefix = makeTemp('install');
    console.log(`[smoke] installing the tarball into ${prefix}`);
    const installed = run(
      'npm',
      ['install', '--prefix', prefix, '--no-audit', '--no-fund', tgzPath],
      {
        stdio: 'inherit',
      },
    );
    check(installed.status === 0, `npm install of the tarball exited with ${installed.status}`);
    if (installed.status === 0) {
      const bin = join(
        prefix,
        'node_modules',
        '.bin',
        isWindows ? 'browser-link.cmd' : 'browser-link',
      );
      const result = run(bin, ['version']);
      const stdout = (result.stdout ?? '').trim();
      check(
        result.status === 0,
        `browser-link version exited with ${result.status}: ${result.stderr}`,
      );
      check(stdout === version, `browser-link version printed "${stdout}", expected "${version}"`);
    }
  }
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  process.exit(1);
}
console.log(`[smoke] OK: ${pkgName}@${version} packs, installs and runs`);
