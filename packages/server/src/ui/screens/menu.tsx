import { Box, Text, useInput } from 'ink';
import { useEffect, useState } from 'react';
import { Frame, Menu, type MenuItem } from '../components.js';
import type { Language } from '../../commands/welcome.js';
import { statusAll } from '../../commands/instructions.js';
import { useBackgroundUpdateCheck, type UpdateCheckState } from '../hooks/use-update-check.js';
import type { CommonProps } from './types.js';

export type MenuAction =
  | 'register'
  | 'instructions'
  | 'permissions'
  | 'multiAgent'
  | 'extension'
  | 'doctor'
  | 'updates'
  | 'freePort'
  | 'language'
  | 'welcome'
  | 'about'
  | 'repo'
  | 'quit';

interface MenuI18n {
  title: string;
  prompt: string;
  options: Record<MenuAction, string>;
  footer: string;
  /** Banner shown when at least one agent client has an outdated block.
   * `{clients}` is replaced with a comma-separated list of display names. */
  outdatedBanner: (clients: string) => string;
  /** Passive banner shown when a newer browser-link is on the registry.
   * `{latest}` is the available version. */
  updateBanner: (latest: string) => string;
}

const MENU_I18N: Record<Language, MenuI18n> = {
  en: {
    title: 'browser-link — setup',
    prompt: 'Pick an action',
    footer: '↑↓ navigate · ↵ select · i instructions · l language · q quit',
    outdatedBanner: (clients) =>
      `⚠ Outdated browser-link block in ${clients}. Press \`i\` to refresh in place.`,
    updateBanner: (latest) =>
      `⬆ v${latest} available — run \`npm install -g @jobshimo/browser-link@latest\``,
    options: {
      register: 'Register browser-link with an MCP client',
      instructions:
        'Agent instructions — drop a trigger block into Claude/OpenCode/Copilot global .md',
      permissions: 'Permissions — pick which MCP tools to expose',
      multiAgent: 'Multi-agent — let multiple MCP clients share one bridge',
      extension: 'Show Chrome extension install steps',
      doctor: 'Run doctor (diagnose current setup)',
      updates: 'Check for updates on npm',
      freePort: 'Free port — stop a stuck browser-link holding 17529',
      language: 'Language — switch between English and Español',
      welcome: 'Show the welcome screen',
      about: 'About / Help — what is this and how it works',
      repo: 'Open the GitHub repository',
      quit: 'Quit',
    },
  },
  es: {
    title: 'browser-link — configuración',
    prompt: 'Elegí una acción',
    footer: '↑↓ moverse · ↵ elegir · i instrucciones · l idioma · q salir',
    outdatedBanner: (clients) =>
      `⚠ Bloque de browser-link desactualizado en ${clients}. Apretá \`i\` para refrescar.`,
    updateBanner: (latest) =>
      `⬆ v${latest} disponible — corré \`npm install -g @jobshimo/browser-link@latest\``,
    options: {
      register: 'Registrar browser-link en un cliente MCP',
      instructions:
        'Instrucciones del agente — meter un bloque de triggers en el .md global de Claude/OpenCode/Copilot',
      permissions: 'Permisos — elegí qué tools del MCP se exponen',
      multiAgent: 'Multi-agente — varios clientes MCP comparten el mismo puente',
      extension: 'Ver pasos para instalar la extensión de Chrome',
      doctor: 'Diagnóstico (estado actual de la instalación)',
      updates: 'Buscar actualizaciones en npm',
      freePort: 'Liberar puerto — matar el browser-link colgado en 17529',
      language: 'Idioma — cambiar entre English y Español',
      welcome: 'Mostrar la pantalla de bienvenida',
      about: 'Información / ayuda — qué es esto y cómo funciona',
      repo: 'Abrir el repositorio en GitHub',
      quit: 'Salir',
    },
  },
};

interface MainMenuProps extends CommonProps {
  onSelect: (action: MenuAction) => void;
  onSwapLang: () => void;
  onQuit: () => void;
  /** Override the outdated-clients lookup. Tests inject a stub so we can
   * assert banner behaviour without depending on the real filesystem. The
   * runtime default uses `statusAll()` from commands/instructions. */
  outdatedClientNames?: () => string[];
  /** Override the background update-check hook result. Tests pass a fixed
   * value to assert the update banner renders only when isNewer is true.
   * In production this is undefined and the menu calls the real hook. */
  updateState?: UpdateCheckState;
}

/** Default implementation — read live status from the installer registry
 * and project the outdated ones to their display names. Pulled out so the
 * test seam (`outdatedClientNames` prop) has a clean default. */
function defaultOutdatedClientNames(): string[] {
  return statusAll()
    .filter((r) => r.state.kind === 'installed-outdated')
    .map((r) => r.displayName);
}

export function MainMenu({
  language,
  onSelect,
  onSwapLang,
  onQuit,
  outdatedClientNames = defaultOutdatedClientNames,
  updateState,
}: MainMenuProps) {
  const t = MENU_I18N[language];
  // The real hook drives a 6-hourly background check; tests inject a fixed
  // `updateState` instead. We call the hook unconditionally so the React
  // rules-of-hooks are satisfied (no conditional invocation), then ignore
  // its result when the prop override is present.
  const hookState = useBackgroundUpdateCheck();
  const effectiveUpdate = updateState ?? hookState;
  const items: MenuItem<MenuAction>[] = (
    [
      'register',
      'instructions',
      'permissions',
      'multiAgent',
      'extension',
      'doctor',
      'updates',
      'freePort',
      'language',
      'welcome',
      'about',
      'repo',
      'quit',
    ] as const
  ).map((a) => ({ value: a, label: t.options[a] }));

  const [idx, setIdx] = useState(0);
  // Banner state is computed on mount. The screen unmounts when the user
  // navigates away (AgentInstructionsView is a different screen), so the
  // next mount re-runs the lookup — after a successful refresh the banner
  // disappears automatically without any explicit invalidation.
  const [outdated, setOutdated] = useState<string[]>(() => outdatedClientNames());

  // Refresh the banner if the prop function changes between renders (the
  // App may re-create it across language switches or theme changes).
  useEffect(() => {
    setOutdated(outdatedClientNames());
  }, [outdatedClientNames]);

  useInput((input, key) => {
    if (key.upArrow) setIdx((i) => (i - 1 + items.length) % items.length);
    else if (key.downArrow) setIdx((i) => (i + 1) % items.length);
    else if (key.return) {
      const v = items[idx].value;
      if (v === 'quit') onQuit();
      else onSelect(v);
    } else if (input === 'q' || key.escape) onQuit();
    else if (input === 'l') onSwapLang();
    else if (input === 'i' || input === 'I') onSelect('instructions');
  });

  return (
    <Frame title={t.title} footer={t.footer}>
      {outdated.length > 0 && (
        <Box marginBottom={1}>
          <Text color="yellow">{t.outdatedBanner(outdated.join(', '))}</Text>
        </Box>
      )}
      {effectiveUpdate.isNewer && effectiveUpdate.latest !== null && (
        <Box marginBottom={1}>
          <Text color="cyan">{t.updateBanner(effectiveUpdate.latest)}</Text>
        </Box>
      )}
      <Text color="white" bold>
        {t.prompt}
      </Text>
      <Box marginTop={1}>
        <Menu items={items} selectedIndex={idx} />
      </Box>
    </Frame>
  );
}
