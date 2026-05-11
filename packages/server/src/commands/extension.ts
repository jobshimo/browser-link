import { existsSync } from 'node:fs';
import { platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolve the absolute path to the Chrome extension assets.
 * Tries the npm-install layout first, then the monorepo dev layout.
 * Returns null if neither has a manifest.json.
 */
export function resolveExtensionPath(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // npm package layout (extension bundled alongside server dist)
    join(here, '..', 'extension'),
    // monorepo dev layout (packages/server/dist/commands → packages/extension/dist)
    resolve(here, '..', '..', '..', 'extension', 'dist'),
    // monorepo dev layout when cli is at dist root (packages/server/dist → packages/extension/dist)
    resolve(here, '..', '..', 'extension', 'dist'),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, 'manifest.json'))) return c;
  }
  return null;
}

function osHints(extPath: string): string {
  const p = platform();
  if (p === 'win32') {
    return [
      'Open Chrome and go to: chrome://extensions',
      'Toggle "Developer mode" (top-right).',
      'Click "Load unpacked".',
      `Browse to: ${extPath}`,
      'Click "Select Folder".',
    ].join('\n  ');
  }
  if (p === 'darwin') {
    return [
      'Open Chrome and go to: chrome://extensions',
      'Toggle "Developer mode" (top-right).',
      'Click "Load unpacked".',
      `In the file picker, press ⌘⇧G and paste: ${extPath}`,
      'Press Return, then "Select".',
    ].join('\n  ');
  }
  return [
    'Open Chrome and go to: chrome://extensions',
    'Toggle "Developer mode" (top-right).',
    'Click "Load unpacked".',
    `Select the folder: ${extPath}`,
  ].join('\n  ');
}

export interface ExtensionInfo {
  path: string | null;
  hints: string;
}

export function getExtensionInfo(): ExtensionInfo {
  const path = resolveExtensionPath();
  return {
    path,
    hints: path
      ? osHints(path)
      : 'Extension assets not found. Run `npm run build:extension` (dev) or reinstall the package.',
  };
}

export function printExtensionInstructions(): void {
  const info = getExtensionInfo();
  if (!info.path) {
    console.log(info.hints);
    return;
  }
  console.log('Chrome extension assets are at:');
  console.log(`  ${info.path}`);
  console.log('');
  console.log('Install steps:');
  console.log(`  ${info.hints}`);
  console.log('');
  console.log('After loading, open the extension popup on any tab and click "Conectar" to bridge it.');
}
