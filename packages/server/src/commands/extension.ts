import { existsSync } from 'node:fs';
import { platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Language } from './welcome.js';

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

interface ExtensionI18n {
  openChrome: string;
  toggleDev: string;
  loadUnpacked: string;
  /** Per-OS final step describing how to pick the folder. */
  pickFolder: (extPath: string) => string;
  selectButton: string;
  pathLabel: string;
  stepsLabel: string;
  afterLoading: string;
  notFound: string;
}

const EXT_I18N: Record<Language, ExtensionI18n> = {
  en: {
    openChrome: 'Open Chrome and go to: chrome://extensions',
    toggleDev: 'Toggle "Developer mode" (top-right).',
    loadUnpacked: 'Click "Load unpacked".',
    pickFolder: (p) => `Browse to: ${p}`,
    selectButton: 'Click "Select Folder".',
    pathLabel: 'Chrome extension assets are at:',
    stepsLabel: 'Install steps:',
    afterLoading:
      'After loading, open the extension popup on any tab and click "Connect this tab" to bridge it.',
    notFound:
      'Extension assets not found. Run `npm run build:extension` (dev) or reinstall the package.',
  },
  es: {
    openChrome: 'Abrí Chrome y entrá a: chrome://extensions',
    toggleDev: 'Activá "Modo desarrollador" (arriba a la derecha).',
    loadUnpacked: 'Hacé click en "Cargar descomprimida".',
    pickFolder: (p) => `Buscá la carpeta: ${p}`,
    selectButton: 'Hacé click en "Seleccionar carpeta".',
    pathLabel: 'Los assets de la extensión están en:',
    stepsLabel: 'Pasos de instalación:',
    afterLoading:
      'Después de cargarla, abrí el popup de la extensión en cualquier pestaña y hacé click en "Connect this tab" para puentearla.',
    notFound:
      'No se encontraron los assets. Corré `npm run build:extension` (dev) o reinstalá el paquete.',
  },
};

function macFolderHint(p: string, language: Language): string {
  return language === 'es'
    ? `En el selector de archivos, apretá ⌘⇧G y pegá: ${p}`
    : `In the file picker, press ⌘⇧G and paste: ${p}`;
}

function macReturnHint(language: Language): string {
  return language === 'es' ? 'Apretá Return y "Seleccionar".' : 'Press Return, then "Select".';
}

function linuxPickHint(p: string, language: Language): string {
  return language === 'es' ? `Elegí la carpeta: ${p}` : `Select the folder: ${p}`;
}

function osHints(extPath: string, language: Language): string {
  const t = EXT_I18N[language];
  const p = platform();
  if (p === 'win32') {
    return [t.openChrome, t.toggleDev, t.loadUnpacked, t.pickFolder(extPath), t.selectButton].join(
      '\n  ',
    );
  }
  if (p === 'darwin') {
    return [
      t.openChrome,
      t.toggleDev,
      t.loadUnpacked,
      macFolderHint(extPath, language),
      macReturnHint(language),
    ].join('\n  ');
  }
  return [t.openChrome, t.toggleDev, t.loadUnpacked, linuxPickHint(extPath, language)].join('\n  ');
}

export interface ExtensionInfo {
  path: string | null;
  hints: string;
}

export function getExtensionInfo(language: Language = 'en'): ExtensionInfo {
  const t = EXT_I18N[language];
  const path = resolveExtensionPath();
  return {
    path,
    hints: path ? osHints(path, language) : t.notFound,
  };
}

export function printExtensionInstructions(language: Language = 'en'): void {
  const t = EXT_I18N[language];
  const info = getExtensionInfo(language);
  if (!info.path) {
    console.log(info.hints);
    return;
  }
  console.log(t.pathLabel);
  console.log(`  ${info.path}`);
  console.log('');
  console.log(t.stepsLabel);
  console.log(`  ${info.hints}`);
  console.log('');
  console.log(t.afterLoading);
}
