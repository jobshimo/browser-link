import {
  INSTRUCTIONS_INSTALLERS,
  getInstructionsInstaller,
  type ClientId,
  type InstructionsState,
} from '../agent-instructions/index.js';
import type { Language } from './welcome.js';

/**
 * Public API for the `browser-link instructions` subcommand and the
 * matching Ink screen. Mirrors the shape of `commands/install.ts` so the UI
 * and CLI layers can swap them interchangeably.
 */

export interface InstructionsReport {
  client: ClientId;
  displayName: string;
  filePath: string;
  state: InstructionsState;
  /** Set after install/uninstall — the one-line description of what changed. */
  message?: string;
  ok: boolean;
}

function stateOnly(client: ClientId): InstructionsReport {
  const inst = getInstructionsInstaller(client);
  const d = inst.detect();
  return {
    client,
    displayName: inst.displayName,
    filePath: d.filePath,
    state: d.state,
    ok: true,
  };
}

export function statusFor(client: ClientId): InstructionsReport {
  return stateOnly(client);
}

export function statusAll(): InstructionsReport[] {
  return INSTRUCTIONS_INSTALLERS.map((i) => stateOnly(i.id));
}

export function installInstructionsFor(client: ClientId): InstructionsReport {
  const inst = getInstructionsInstaller(client);
  const message = inst.install();
  const d = inst.detect();
  return {
    client,
    displayName: inst.displayName,
    filePath: d.filePath,
    state: d.state,
    message,
    ok: true,
  };
}

export function installInstructionsAll(): InstructionsReport[] {
  return INSTRUCTIONS_INSTALLERS.map((i) => installInstructionsFor(i.id));
}

export function uninstallInstructionsFor(client: ClientId): InstructionsReport {
  const inst = getInstructionsInstaller(client);
  const message = inst.uninstall();
  const d = inst.detect();
  return {
    client,
    displayName: inst.displayName,
    filePath: d.filePath,
    state: d.state,
    message,
    ok: true,
  };
}

export function uninstallInstructionsAll(): InstructionsReport[] {
  return INSTRUCTIONS_INSTALLERS.map((i) => uninstallInstructionsFor(i.id));
}

interface I18n {
  header: string;
  installed: (version: string) => string;
  installedOutdated: (version: string) => string;
  notInstalled: string;
  noFile: string;
  filePath: string;
}

const I18N: Record<Language, I18n> = {
  en: {
    header: 'Agent instructions — browser-link awareness in global agent .md files',
    installed: (v) => `✓ installed (v${v})`,
    installedOutdated: (v) =>
      `⚠ installed but outdated (v${v}) — run \`browser-link instructions install\` to refresh.`,
    notInstalled: '· not installed (file exists, no browser-link block)',
    noFile: '· file does not exist yet (will be created on install)',
    filePath: '  file:',
  },
  es: {
    header: 'Instrucciones del agente — browser-link en los .md globales de cada cliente',
    installed: (v) => `✓ instalado (v${v})`,
    installedOutdated: (v) =>
      `⚠ instalado pero desactualizado (v${v}) — corré \`browser-link instructions install\` para refrescar.`,
    notInstalled: '· no instalado (el archivo existe, sin bloque de browser-link)',
    noFile: '· el archivo aún no existe (se va a crear al instalar)',
    filePath: '  archivo:',
  },
};

/** Render the status of a single report as a one-line label. */
export function describeState(state: InstructionsState, language: Language = 'en'): string {
  const t = I18N[language];
  switch (state.kind) {
    case 'installed':
      return t.installed(state.version);
    case 'installed-outdated':
      return t.installedOutdated(state.version);
    case 'not-installed':
      return t.notInstalled;
    case 'no-file':
      return t.noFile;
  }
}

/** Format a list of reports as the body of `browser-link instructions`
 * (status). Used by the CLI; the UI consumes the raw report shape. */
export function formatStatus(reports: InstructionsReport[], language: Language = 'en'): string {
  const t = I18N[language];
  const lines: string[] = [t.header, ''];
  for (const r of reports) {
    lines.push(`  ${r.displayName.padEnd(22)} ${describeState(r.state, language)}`);
    lines.push(`${t.filePath} ${r.filePath}`);
  }
  return lines.join('\n');
}
