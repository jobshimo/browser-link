import { loadConfig, saveConfig } from '../config.js';
import { PRESETS, TOOL_CATALOGUE, getPreset, isKnownTool, type PresetId } from '../permissions.js';
import type { Language } from './welcome.js';

/* The scriptable surface of the tool-permissions feature. Mirrors what the
 * Permissions screen does in the Ink UI:
 *   - `browser-link tools`               list current state
 *   - `browser-link tools enable <name>` add to allow (remove from disabled)
 *   - `browser-link tools disable <name>` add to disabled
 *   - `browser-link tools preset <id>`   replace disabled list with preset */

const VALID_PRESETS: PresetId[] = PRESETS.map((p) => p.id);

interface ToolsCliI18n {
  header: (state: string) => string;
  allEnabled: string;
  someDisabled: (n: number) => string;
  bridgeHeader: string;
  mapHeader: string;
  presetsHeader: string;
  restartNote: string;
  usageEnable: string;
  usageDisable: string;
  unknownTool: (name: string) => string;
  noChangeAlreadyEnabled: (names: string) => string;
  noChangeAlreadyDisabled: (names: string) => string;
  enabledN: (n: number, names: string) => string;
  disabledN: (n: number, names: string) => string;
  allToolsEnabled: string;
  unknownPreset: (id: string, valid: string) => string;
  unknownAction: (action: string) => string;
  appliedPreset: (id: string, follow: string) => string;
  presetUsage: (ids: string) => string;
}

const TOOLS_I18N: Record<Language, ToolsCliI18n> = {
  en: {
    header: (state) => `Tool permissions — ${state}`,
    allEnabled: 'all enabled',
    someDisabled: (n) => `${n} disabled`,
    bridgeHeader: 'Browser bridge:',
    mapHeader: 'Persistent UI map:',
    presetsHeader: 'Presets:',
    restartNote: 'Changes take effect the next time your MCP client starts the server.',
    usageEnable: 'Usage: browser-link tools enable <name> [<name>…]',
    usageDisable: 'Usage: browser-link tools disable <name> [<name>…]',
    unknownTool: (n) => `Unknown tool: ${n}`,
    noChangeAlreadyEnabled: (names) => `No change — none of [${names}] were disabled.`,
    noChangeAlreadyDisabled: (names) => `No change — [${names}] already disabled.`,
    enabledN: (n, names) => `Enabled ${n}: ${names}`,
    disabledN: (n, names) => `Disabled ${n}: ${names}`,
    allToolsEnabled: 'All tools enabled.',
    unknownPreset: (id, valid) => `Unknown preset: ${id}. Valid: ${valid}`,
    unknownAction: (action) =>
      `Unknown tools action: ${action}. Use list | enable | disable | preset.`,
    appliedPreset: (id, follow) => `Applied preset "${id}" — ${follow}`,
    presetUsage: (ids) => `Usage: browser-link tools preset <${ids}>`,
  },
  es: {
    header: (state) => `Permisos de tools — ${state}`,
    allEnabled: 'todo habilitado',
    someDisabled: (n) => `${n} deshabilitada${n === 1 ? '' : 's'}`,
    bridgeHeader: 'Bridge del browser:',
    mapHeader: 'Mapa persistente:',
    presetsHeader: 'Presets:',
    restartNote:
      'Los cambios tienen efecto la próxima vez que el cliente MCP arranque el servidor.',
    usageEnable: 'Uso: browser-link tools enable <nombre> [<nombre>…]',
    usageDisable: 'Uso: browser-link tools disable <nombre> [<nombre>…]',
    unknownTool: (n) => `Tool desconocida: ${n}`,
    noChangeAlreadyEnabled: (names) => `Sin cambios — ninguna de [${names}] estaba deshabilitada.`,
    noChangeAlreadyDisabled: (names) => `Sin cambios — [${names}] ya estaba deshabilitada.`,
    enabledN: (n, names) => `Habilitadas (${n}): ${names}`,
    disabledN: (n, names) => `Deshabilitadas (${n}): ${names}`,
    allToolsEnabled: 'Todas las tools habilitadas.',
    unknownPreset: (id, valid) => `Preset desconocido: ${id}. Válidos: ${valid}`,
    unknownAction: (action) =>
      `Acción desconocida: ${action}. Usá list | enable | disable | preset.`,
    appliedPreset: (id, follow) => `Preset "${id}" aplicado — ${follow}`,
    presetUsage: (ids) => `Uso: browser-link tools preset <${ids}>`,
  },
};

export function listToolsStatus(language: Language = 'en'): string {
  const t = TOOLS_I18N[language];
  const cfg = loadConfig();
  const disabled = new Set(cfg.disabledTools ?? []);
  const lines: string[] = [];
  lines.push(t.header(disabled.size === 0 ? t.allEnabled : t.someDisabled(disabled.size)));
  lines.push('');

  let lastFamily: string | null = null;
  for (const tool of TOOL_CATALOGUE) {
    if (tool.family !== lastFamily) {
      if (lastFamily !== null) lines.push('');
      lines.push(tool.family === 'bridge' ? t.bridgeHeader : t.mapHeader);
      lastFamily = tool.family;
    }
    const mark = disabled.has(tool.name) ? '✗' : '✓';
    lines.push(`  ${mark} ${tool.name.padEnd(28)} ${tool.summary}`);
  }

  lines.push('');
  lines.push(t.presetsHeader);
  for (const p of PRESETS) {
    lines.push(`  ${p.id.padEnd(10)} ${p.label}`);
  }
  lines.push('');
  lines.push(t.restartNote);
  return lines.join('\n');
}

function applyDisabled(disabled: string[], language: Language): string {
  const t = TOOLS_I18N[language];
  saveConfig({ disabledTools: disabled });
  if (disabled.length === 0) return t.allToolsEnabled;
  return t.disabledN(disabled.length, disabled.join(', '));
}

export function enableTools(names: string[], language: Language = 'en'): string {
  const t = TOOLS_I18N[language];
  if (names.length === 0) throw new Error(t.usageEnable);
  for (const n of names) {
    if (!isKnownTool(n)) throw new Error(t.unknownTool(n));
  }
  const cfg = loadConfig();
  const before = new Set(cfg.disabledTools ?? []);
  const removed: string[] = [];
  for (const n of names) {
    if (before.delete(n)) removed.push(n);
  }
  const next = [...before].sort();
  saveConfig({ disabledTools: next });
  if (removed.length === 0) return t.noChangeAlreadyEnabled(names.join(', '));
  return t.enabledN(removed.length, removed.join(', '));
}

export function disableTools(names: string[], language: Language = 'en'): string {
  const t = TOOLS_I18N[language];
  if (names.length === 0) throw new Error(t.usageDisable);
  for (const n of names) {
    if (!isKnownTool(n)) throw new Error(t.unknownTool(n));
  }
  const cfg = loadConfig();
  const before = new Set(cfg.disabledTools ?? []);
  const added: string[] = [];
  for (const n of names) {
    if (!before.has(n)) {
      before.add(n);
      added.push(n);
    }
  }
  const next = [...before].sort();
  saveConfig({ disabledTools: next });
  if (added.length === 0) return t.noChangeAlreadyDisabled(names.join(', '));
  return t.disabledN(added.length, added.join(', '));
}

export function applyPreset(id: string, language: Language = 'en'): string {
  const t = TOOLS_I18N[language];
  if (!VALID_PRESETS.includes(id as PresetId)) {
    throw new Error(t.unknownPreset(id, VALID_PRESETS.join(', ')));
  }
  const preset = getPreset(id as PresetId);
  return t.appliedPreset(preset.id, applyDisabled([...preset.disabled], language));
}

export interface ToolsArgs {
  action: 'list' | 'enable' | 'disable' | 'preset';
  names: string[];
}

export function parseToolsArgs(argv: string[], language: Language = 'en'): ToolsArgs {
  const t = TOOLS_I18N[language];
  const [action, ...rest] = argv;
  if (!action || action === 'list') return { action: 'list', names: [] };
  if (action === 'enable' || action === 'disable' || action === 'preset') {
    return { action, names: rest };
  }
  throw new Error(t.unknownAction(action));
}

export function runToolsCommand(argv: string[], language: Language = 'en'): string {
  const t = TOOLS_I18N[language];
  const { action, names } = parseToolsArgs(argv, language);
  switch (action) {
    case 'list':
      return listToolsStatus(language);
    case 'enable':
      return enableTools(names, language);
    case 'disable':
      return disableTools(names, language);
    case 'preset': {
      const [presetId] = names;
      if (!presetId) throw new Error(t.presetUsage(VALID_PRESETS.join('|')));
      return applyPreset(presetId, language);
    }
  }
}
