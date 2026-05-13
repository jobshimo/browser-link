import { Box, Text, useInput } from 'ink';
import { useEffect, useState } from 'react';
import { Frame } from '../components.js';
import { COLORS, GLYPHS } from '../tokens.js';
import { FooterKeys, MenuRow, SectionHead } from '../primitives/index.js';
import type { Language } from '../../commands/welcome.js';
import { statusAll } from '../../commands/instructions.js';
import { useBackgroundUpdateCheck, type UpdateCheckState } from '../hooks/use-update-check.js';
import { VERSION } from '../../version.js';
import type { CommonProps } from './types.js';

/* Main menu — reorganized in v0.9.0 into three groups (SETUP / DIAGNOSE
 * / REFERENCE) with per-row hotkeys. Layout source:
 * `screens.jsx` → ScreenMenu.
 *
 * Hotkeys are stable across languages — they are letters the user types
 * once and remembers, not characters drawn from translated copy. The
 * cursor + Enter path still works; hotkeys are the power-user shortcut.
 *
 * The outdated-block banner + the update banner sit between the status
 * strip and the "Pick an action" title (the StateToasts layout in
 * `states.jsx`). Both can be dismissed via 'x' but here we keep them
 * passive — dismissing them is a follow-up concern not in this PR.
 */

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

type MenuGroup = 'setup' | 'diagnose' | 'reference';

interface MenuRowSpec {
  value: MenuAction;
  group: MenuGroup;
  hotkey: string;
}

/* The ordering here is the visual order on screen. Hotkeys are picked
 * so each one is unique across the full menu and reads naturally:
 *   r = register   i = instructions   p = permissions   m = multi-agent
 *   d = doctor     u = updates        f = free port
 *   e = extension  L = language       w = welcome    a = about    g = github
 *   q = quit
 */
const MENU_SPEC: MenuRowSpec[] = [
  { value: 'register', group: 'setup', hotkey: 'r' },
  { value: 'instructions', group: 'setup', hotkey: 'i' },
  { value: 'permissions', group: 'setup', hotkey: 'p' },
  { value: 'multiAgent', group: 'setup', hotkey: 'm' },
  { value: 'doctor', group: 'diagnose', hotkey: 'd' },
  { value: 'updates', group: 'diagnose', hotkey: 'u' },
  { value: 'freePort', group: 'diagnose', hotkey: 'f' },
  { value: 'extension', group: 'reference', hotkey: 'e' },
  { value: 'language', group: 'reference', hotkey: 'L' },
  { value: 'welcome', group: 'reference', hotkey: 'w' },
  { value: 'about', group: 'reference', hotkey: 'a' },
  { value: 'repo', group: 'reference', hotkey: 'g' },
  { value: 'quit', group: 'reference', hotkey: 'q' },
];

interface MenuI18n {
  title: string;
  prompt: string;
  promptHint: string;
  groupSetup: string;
  groupDiagnose: string;
  groupReference: string;
  hints: Partial<Record<MenuAction, string>>;
  options: Record<MenuAction, string>;
  /** Banner shown when at least one agent client has an outdated block.
   * `{clients}` is replaced with a comma-separated list of display names. */
  outdatedBanner: (clients: string) => string;
  /** Passive banner shown when a newer browser-link is on the registry.
   * `{latest}` is the available version. */
  updateBanner: (latest: string) => string;
  /** Bottom-strip "or press the bracketed key" footnote. */
  footerNavigate: string;
  footerSelect: string;
  footerHotkey: string;
  footerLang: string;
  footerQuit: string;
}

const MENU_I18N: Record<Language, MenuI18n> = {
  en: {
    title: 'browser-link — setup',
    prompt: 'Pick an action',
    promptHint: 'or press the bracketed key',
    groupSetup: 'SETUP',
    groupDiagnose: 'DIAGNOSE',
    groupReference: 'REFERENCE',
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
    hints: {
      instructions: 'trigger block in global .md',
      permissions: 'which browser.* tools to expose',
      multiAgent: 'share one bridge between clients',
      doctor: 'report current setup state',
      freePort: 'kill stuck bridge',
      language: 'EN / ES',
    },
    footerNavigate: 'navigate',
    footerSelect: 'select',
    footerHotkey: 'hotkey',
    footerLang: 'lang',
    footerQuit: 'quit',
  },
  es: {
    title: 'browser-link — configuración',
    prompt: 'Elegí una acción',
    promptHint: 'o apretá la letra entre corchetes',
    groupSetup: 'SETUP',
    groupDiagnose: 'DIAGNÓSTICO',
    groupReference: 'REFERENCIA',
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
    hints: {
      instructions: 'bloque en el .md global',
      permissions: 'qué tools browser.* exponer',
      multiAgent: 'compartí el puente entre clientes',
      doctor: 'estado actual del setup',
      freePort: 'matá el puente colgado',
      language: 'EN / ES',
    },
    footerNavigate: 'moverse',
    footerSelect: 'elegir',
    footerHotkey: 'hotkey',
    footerLang: 'idioma',
    footerQuit: 'salir',
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

  /* The real hook drives a 6-hourly background check; tests inject a fixed
   * `updateState` instead. We call the hook unconditionally so the React
   * rules-of-hooks are satisfied (no conditional invocation), then ignore
   * its result when the prop override is present. */
  const hookState = useBackgroundUpdateCheck();
  const effectiveUpdate = updateState ?? hookState;

  const [idx, setIdx] = useState(0);
  const [outdated, setOutdated] = useState<string[]>(() => outdatedClientNames());

  useEffect(() => {
    setOutdated(outdatedClientNames());
  }, [outdatedClientNames]);

  const handleAction = (value: MenuAction): void => {
    if (value === 'quit') onQuit();
    else onSelect(value);
  };

  useInput((input, key) => {
    if (key.upArrow) setIdx((i) => (i - 1 + MENU_SPEC.length) % MENU_SPEC.length);
    else if (key.downArrow) setIdx((i) => (i + 1) % MENU_SPEC.length);
    else if (key.return) handleAction(MENU_SPEC[idx].value);
    else if (input === 'q' || key.escape) onQuit();
    else if (input === 'l') onSwapLang();
    else {
      /* Hotkey dispatch. Compare case-insensitively so `L` (language) and
       * `i` (instructions) both fire regardless of caps-lock state.
       * Instructions also has the legacy `I`/`i` shortcut so existing
       * users keep their muscle memory; new bindings use the same path. */
      const lower = input.toLowerCase();
      const target = MENU_SPEC.find((m) => m.hotkey.toLowerCase() === lower);
      if (target) handleAction(target.value);
    }
  });

  const groups: { id: MenuGroup; head: string }[] = [
    { id: 'setup', head: t.groupSetup },
    { id: 'diagnose', head: t.groupDiagnose },
    { id: 'reference', head: t.groupReference },
  ];

  return (
    <Frame
      title={t.title}
      badge={
        <Text color={COLORS.muted} dimColor>
          v{VERSION}
        </Text>
      }
      footer={
        <FooterKeys
          items={[
            { k: `${GLYPHS.up}${GLYPHS.down}`, label: t.footerNavigate },
            { k: GLYPHS.enter, label: t.footerSelect },
            { k: 'a-z', label: t.footerHotkey },
            { k: 'l', label: t.footerLang },
            { k: 'q', label: t.footerQuit },
          ]}
        />
      }
    >
      {outdated.length > 0 && (
        <Box marginBottom={1}>
          <Text color={COLORS.warn}>{t.outdatedBanner(outdated.join(', '))}</Text>
        </Box>
      )}
      {effectiveUpdate.isNewer && effectiveUpdate.latest !== null && (
        <Box marginBottom={1}>
          <Text color={COLORS.primary}>{t.updateBanner(effectiveUpdate.latest)}</Text>
        </Box>
      )}
      <Box>
        <Text color="white" bold>
          {t.prompt}
        </Text>
        <Text color={COLORS.muted} dimColor italic>
          {'  '}
          {GLYPHS.dot} {t.promptHint}
        </Text>
      </Box>

      {groups.map((g) => (
        <Box key={g.id} flexDirection="column">
          <SectionHead>{g.head}</SectionHead>
          {MENU_SPEC.filter((m) => m.group === g.id).map((spec) => {
            const globalIndex = MENU_SPEC.indexOf(spec);
            return (
              <MenuRow
                key={spec.value}
                selected={globalIndex === idx}
                hotkey={spec.hotkey}
                label={t.options[spec.value]}
                hint={t.hints[spec.value]}
              />
            );
          })}
        </Box>
      ))}
    </Frame>
  );
}
