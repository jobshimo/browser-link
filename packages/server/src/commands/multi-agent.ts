import { loadConfig, saveConfig } from '../config.js';
import type { Language } from './welcome.js';

/* Scriptable surface of the multi-agent feature. Mirrors what the
 * Multi-agent screen does in the Ink UI:
 *   - `browser-link multi-agent`                show current state
 *   - `browser-link multi-agent enable|disable`
 *   - `browser-link multi-agent auto-reelect enable|disable`
 *
 * Phase 1: these only flip flags in config.json. The flags are not yet
 * consulted by server.ts — that wiring lands in phase 2+. */

interface MultiAgentI18n {
  header: string;
  multiAgentLabel: string;
  autoReelectLabel: string;
  on: string;
  off: string;
  restartNote: string;
  enabledMulti: string;
  disabledMulti: string;
  enabledReelect: string;
  disabledReelect: string;
  noChange: string;
  autoReelectRequiresMulti: string;
  unknownAction: (action: string) => string;
  unknownReelectAction: (action: string) => string;
  usage: string;
}

const MA_I18N: Record<Language, MultiAgentI18n> = {
  en: {
    header: 'Multi-agent settings',
    multiAgentLabel: 'Multi-agent mode',
    autoReelectLabel: 'Auto-reelect on primary close',
    on: 'on',
    off: 'off',
    restartNote: 'Restart every MCP client for these changes to take effect.',
    enabledMulti: 'Multi-agent mode enabled.',
    disabledMulti: 'Multi-agent mode disabled.',
    enabledReelect: 'Auto-reelect enabled.',
    disabledReelect: 'Auto-reelect disabled.',
    noChange: 'No change.',
    autoReelectRequiresMulti:
      'Cannot enable auto-reelect while multi-agent mode is off. Enable multi-agent first.',
    unknownAction: (action) =>
      `Unknown multi-agent action: ${action}. Use enable | disable | auto-reelect | list.`,
    unknownReelectAction: (action) =>
      `Unknown auto-reelect action: ${action}. Use enable | disable.`,
    usage: 'Usage: browser-link multi-agent <enable|disable|auto-reelect|list>',
  },
  es: {
    header: 'Configuración multi-agente',
    multiAgentLabel: 'Modo multi-agente',
    autoReelectLabel: 'Re-elección automática al cerrar el primary',
    on: 'activado',
    off: 'desactivado',
    restartNote: 'Reiniciá cada cliente MCP para que los cambios tengan efecto.',
    enabledMulti: 'Modo multi-agente activado.',
    disabledMulti: 'Modo multi-agente desactivado.',
    enabledReelect: 'Re-elección automática activada.',
    disabledReelect: 'Re-elección automática desactivada.',
    noChange: 'Sin cambios.',
    autoReelectRequiresMulti:
      'No se puede activar la re-elección automática con el modo multi-agente apagado. Activá primero multi-agente.',
    unknownAction: (action) =>
      `Acción multi-agente desconocida: ${action}. Usá enable | disable | auto-reelect | list.`,
    unknownReelectAction: (action) =>
      `Acción de auto-reelect desconocida: ${action}. Usá enable | disable.`,
    usage: 'Uso: browser-link multi-agent <enable|disable|auto-reelect|list>',
  },
};

export function listMultiAgentStatus(language: Language = 'en'): string {
  const t = MA_I18N[language];
  const cfg = loadConfig();
  const multi = cfg.multiAgent === true;
  const reelect = cfg.autoReelect === true;
  const lines: string[] = [];
  lines.push(t.header);
  lines.push('');
  lines.push(`  ${t.multiAgentLabel}             ${multi ? t.on : t.off}`);
  lines.push(`  ${t.autoReelectLabel}  ${reelect ? t.on : t.off}`);
  lines.push('');
  lines.push(t.restartNote);
  return lines.join('\n');
}

export function enableMultiAgent(language: Language = 'en'): string {
  const t = MA_I18N[language];
  const cfg = loadConfig();
  if (cfg.multiAgent === true) return t.noChange;
  saveConfig({ multiAgent: true });
  return t.enabledMulti;
}

export function disableMultiAgent(language: Language = 'en'): string {
  const t = MA_I18N[language];
  const cfg = loadConfig();
  if (cfg.multiAgent !== true) return t.noChange;
  // Turning multi-agent off also clears autoReelect — the normalise step
  // in config.ts drops it because it only makes sense when multi-agent is on.
  saveConfig({ multiAgent: false, autoReelect: false });
  return t.disabledMulti;
}

export function enableAutoReelect(language: Language = 'en'): string {
  const t = MA_I18N[language];
  const cfg = loadConfig();
  if (cfg.multiAgent !== true) throw new Error(t.autoReelectRequiresMulti);
  if (cfg.autoReelect === true) return t.noChange;
  saveConfig({ autoReelect: true });
  return t.enabledReelect;
}

export function disableAutoReelect(language: Language = 'en'): string {
  const t = MA_I18N[language];
  const cfg = loadConfig();
  if (cfg.autoReelect !== true) return t.noChange;
  saveConfig({ autoReelect: false });
  return t.disabledReelect;
}

export function runMultiAgentCommand(argv: string[], language: Language = 'en'): string {
  const t = MA_I18N[language];
  const [action, ...rest] = argv;
  if (!action || action === 'list') return listMultiAgentStatus(language);
  if (action === 'enable') return enableMultiAgent(language);
  if (action === 'disable') return disableMultiAgent(language);
  if (action === 'auto-reelect') {
    const [sub] = rest;
    if (sub === 'enable') return enableAutoReelect(language);
    if (sub === 'disable') return disableAutoReelect(language);
    if (!sub) return listMultiAgentStatus(language); // bare `auto-reelect` is a no-op listing
    throw new Error(t.unknownReelectAction(sub));
  }
  throw new Error(t.unknownAction(action));
}
