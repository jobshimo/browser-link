// Writes the server's generated mirror of the private workspace packages
// (docs/design/service-worker-architecture.md, 2.3).
//
// The npm package publishes standalone and cannot depend on the private
// `@browser-link/core` or `@browser-link/shared`, so the server compiles a
// committed copy of their production files under
// packages/server/src/generated/<pkg>/. Every copy starts with a GENERATED
// header; in core files each `@browser-link/shared` specifier is rewritten
// to the relative path of the mirrored generated/shared/index.js, so the
// published dist/ stays self-contained.
//
//   node scripts/sync-core.mjs           write the mirror (and delete extra files)
//   node scripts/sync-core.mjs --check   write nothing; exit 1 listing every
//                                        missing, extra or different file and
//                                        every bare specifier left in it
//
// Production means: `*.ts`, not `*.test.ts`, not under `fitness/`, not under
// `ports/contract/fixtures/`.

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The packages mirrored, in order. `shared` joins in slice 5c, when the
 * server's messages.ts becomes a re-export of generated/shared.
 */
export const MIRRORED_ROOTS = ['core'];

export const GENERATED_DIR = 'packages/server/src/generated';
const SHARED_SPECIFIER = '@browser-link/shared';
/** Specifiers no generated file may keep (5.2, module table). */
const BARE_SPECIFIERS = ['@browser-link/shared', '@browser-link/core'];

const toPosix = (path) => path.replaceAll('\\', '/');
const lf = (text) => text.replaceAll('\r\n', '\n');

function walk(dir) {
  const files = [];
  // Directory entries carry their type, so no path is stat'ed before it is read.
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

/** Whether a path relative to a package's `src/` is a production file. */
export function isProduction(relPath) {
  if (!relPath.endsWith('.ts') || relPath.endsWith('.test.ts')) return false;
  const parts = relPath.split('/');
  if (parts.includes('fitness')) return false;
  return !relPath.startsWith('ports/contract/fixtures/');
}

/**
 * Rewrite every `@browser-link/shared` specifier of a mirrored core file
 * (static import, import type, export ... from, side-effect import) to the
 * relative path of generated/shared/index.js. `relPath` is the file's path
 * under generated/core/.
 */
export function rewriteSpecifiers(text, relPath) {
  const depth = relPath.split('/').length - 1;
  const target = `${'../'.repeat(depth + 1)}shared/index.js`;
  let rewritten = false;
  const out = text.replace(
    /(\bfrom\s*|\bimport\s*)(['"])@browser-link\/shared\2/g,
    (_match, keyword, quote) => {
      rewritten = true;
      return `${keyword}${quote}${target}${quote}`;
    },
  );
  return { text: out, rewritten };
}

/** What the mirror must hold: path under generated/ -> file text. */
export function expectedMirror(repo = REPO, roots = MIRRORED_ROOTS) {
  const files = new Map();
  for (const pkg of roots) {
    const src = join(repo, 'packages', pkg, 'src');
    for (const file of walk(src)) {
      const relPath = toPosix(relative(src, file));
      if (!isProduction(relPath)) continue;
      let text = lf(readFileSync(file, 'utf8'));
      let note = '';
      if (pkg !== 'shared' && text.includes(SHARED_SPECIFIER)) {
        const result = rewriteSpecifiers(text, relPath);
        text = result.text;
        if (result.rewritten) note = ' Specifiers rewritten.';
      }
      const header = `// GENERATED from packages/${pkg}/src/${relPath}.${note} Do not edit.\n`;
      files.set(posix.join(pkg, relPath), header + text);
    }
  }
  return files;
}

/** What the mirror holds now: path under generated/ -> file text. */
export function actualMirror(repo = REPO) {
  const dir = join(repo, GENERATED_DIR);
  const files = new Map();
  let entries;
  try {
    entries = walk(dir);
  } catch {
    return files;
  }
  for (const file of entries)
    files.set(toPosix(relative(dir, file)), lf(readFileSync(file, 'utf8')));
  return files;
}

/** Every difference between the two mirrors, plus bare specifiers left in the actual one. */
export function diffMirror(expected, actual) {
  const problems = [];
  for (const path of expected.keys()) {
    if (!actual.has(path)) problems.push(`missing: ${path}`);
    else if (actual.get(path) !== expected.get(path)) problems.push(`different: ${path}`);
  }
  for (const [path, text] of actual) {
    if (!expected.has(path)) problems.push(`extra: ${path}`);
    for (const specifier of BARE_SPECIFIERS) {
      if (new RegExp(`(['"])${specifier}\\1`).test(text)) {
        problems.push(`bare specifier ${specifier}: ${path}`);
      }
    }
  }
  return problems;
}

/** Write the expected mirror and delete every file it does not hold. */
export function writeMirror(repo = REPO, roots = MIRRORED_ROOTS) {
  const dir = join(repo, GENERATED_DIR);
  const expected = expectedMirror(repo, roots);
  for (const path of actualMirror(repo).keys()) {
    if (!expected.has(path)) rmSync(join(dir, path));
  }
  for (const [path, text] of expected) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return expected.size;
}

function main(args) {
  if (args.includes('--check')) {
    const problems = diffMirror(expectedMirror(), actualMirror());
    if (problems.length > 0) {
      console.error(`[sync-core] ${GENERATED_DIR} is out of date:`);
      for (const problem of problems) console.error(`  ${problem}`);
      console.error('[sync-core] run `node scripts/sync-core.mjs` and commit the result.');
      return 1;
    }
    console.log(`[sync-core] ${GENERATED_DIR} is up to date.`);
    return 0;
  }
  const count = writeMirror();
  console.log(`[sync-core] wrote ${count} files into ${GENERATED_DIR}.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
