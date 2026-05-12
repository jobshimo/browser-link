import { Box, Text, useInput } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import { Frame, Menu, type MenuItem } from './components.js';
import { I18N_WELCOME, type Language } from '../commands/welcome.js';
import { I18N_ABOUT } from '../commands/about.js';
import { INSTALLERS, type ClientId } from '../installers/index.js';
import { type InstallReport } from '../commands/install.js';
import { runDoctor, formatDoctor } from '../commands/doctor.js';
import { getExtensionInfo } from '../commands/extension.js';
import { checkUpdates, type UpdateInfo } from '../commands/updates.js';
import {
  runSelfUpdate,
  type SelfUpdateProgress,
  type SelfUpdateResult,
} from '../commands/self-update.js';
import { runFreePort, type FreePortResult } from '../commands/free-port.js';
import { PACKAGE_NAME } from '../version.js';
import { loadConfig, saveConfig } from '../config.js';
import {
  PRESETS,
  TOOL_CATALOGUE,
  sanitizeDisabledTools,
  type PresetDef,
  type ToolFamily,
  type ToolMeta,
} from '../permissions.js';

/* Every screen is a fully-controlled component: it receives the language and
 * callbacks for navigation, and renders its own content. The App is the
 * single source of truth for `screen` and `language` state. */

interface CommonProps {
  language: Language;
}

/* ── Welcome ───────────────────────────────────────────────────────────── */

interface WelcomeProps extends CommonProps {
  hideDismiss: boolean;
  onAccept: () => void;
  onDismiss: () => void;
  onSwapLang: () => void;
  onQuit: () => void;
}

export function WelcomeScreen({
  language,
  hideDismiss,
  onAccept,
  onDismiss,
  onSwapLang,
  onQuit,
}: WelcomeProps) {
  const t = I18N_WELCOME[language];
  const items: MenuItem<'accept' | 'dismiss' | 'swap' | 'quit'>[] = [
    { value: 'accept', label: t.options.accept },
  ];
  if (!hideDismiss) items.push({ value: 'dismiss', label: t.options.dismiss });
  items.push({ value: 'swap', label: t.options.swap }, { value: 'quit', label: t.options.quit });

  const [idx, setIdx] = useState(0);

  useInput((input, key) => {
    if (key.upArrow) setIdx((i) => (i - 1 + items.length) % items.length);
    else if (key.downArrow) setIdx((i) => (i + 1) % items.length);
    else if (key.return) {
      const v = items[idx]!.value;
      if (v === 'accept') onAccept();
      else if (v === 'dismiss') onDismiss();
      else if (v === 'swap') onSwapLang();
      else onQuit();
    } else if (input === 'q' || key.escape) onQuit();
    else if (input === 'l') onSwapLang();
  });

  const footer =
    language === 'es'
      ? '↑↓ moverse · ↵ elegir · l idioma · q salir'
      : '↑↓ navigate · ↵ select · l language · q quit';

  return (
    <Frame title={t.title} footer={footer}>
      <Section title={t.aboutTitle} body={t.about} />
      <Section title={t.capabilitiesTitle} body={t.capabilities} />
      <Section title={t.warningTitle} body={t.warning} warn />
      <Box marginBottom={1} flexDirection="column">
        <Text color="gray" italic>
          {t.responsibility}
        </Text>
        <Text color="gray" italic>
          {t.extensionNote}
        </Text>
      </Box>
      <Text color="white" bold>
        {t.prompt}
      </Text>
      <Box marginTop={1}>
        <Menu items={items} selectedIndex={idx} />
      </Box>
    </Frame>
  );
}

interface SectionProps {
  title: string;
  body: string;
  warn?: boolean;
}
function Section({ title, body, warn }: SectionProps) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={warn ? 'yellow' : 'cyan'} bold>
        {warn ? '⚠  ' : ''}
        {title}
      </Text>
      <Text>{body}</Text>
    </Box>
  );
}

/* ── Main menu ─────────────────────────────────────────────────────────── */

export type MenuAction =
  | 'register'
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
}

const MENU_I18N: Record<Language, MenuI18n> = {
  en: {
    title: 'browser-link — setup',
    prompt: 'Pick an action',
    footer: '↑↓ navigate · ↵ select · l language · q quit',
    options: {
      register: 'Register browser-link with an MCP client',
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
    footer: '↑↓ moverse · ↵ elegir · l idioma · q salir',
    options: {
      register: 'Registrar browser-link en un cliente MCP',
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
}

export function MainMenu({ language, onSelect, onSwapLang, onQuit }: MainMenuProps) {
  const t = MENU_I18N[language];
  const items: MenuItem<MenuAction>[] = (
    [
      'register',
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

  useInput((input, key) => {
    if (key.upArrow) setIdx((i) => (i - 1 + items.length) % items.length);
    else if (key.downArrow) setIdx((i) => (i + 1) % items.length);
    else if (key.return) {
      const v = items[idx]!.value;
      if (v === 'quit') onQuit();
      else onSelect(v);
    } else if (input === 'q' || key.escape) onQuit();
    else if (input === 'l') onSwapLang();
  });

  return (
    <Frame title={t.title} footer={t.footer}>
      <Text color="white" bold>
        {t.prompt}
      </Text>
      <Box marginTop={1}>
        <Menu items={items} selectedIndex={idx} />
      </Box>
    </Frame>
  );
}

/* ── Client picker (sub-screen for Register) ───────────────────────────── */

interface ClientPickerProps extends CommonProps {
  onPick: (id: ClientId) => void;
  onBack: () => void;
}

const PICKER_I18N: Record<Language, { title: string; prompt: string; footer: string }> = {
  en: {
    title: 'Register browser-link in…',
    prompt: 'Which MCP client?',
    footer: '↑↓ navigate · ↵ register · Esc back',
  },
  es: {
    title: 'Registrar browser-link en…',
    prompt: '¿Qué cliente MCP?',
    footer: '↑↓ moverse · ↵ registrar · Esc volver',
  },
};

export function ClientPicker({ language, onPick, onBack }: ClientPickerProps) {
  const t = PICKER_I18N[language];
  const STATUS: Record<
    Language,
    { registered: string; notRegistered: string; notDetected: string }
  > = {
    en: { registered: 'registered', notRegistered: 'not registered', notDetected: 'not detected' },
    es: { registered: 'registrado', notRegistered: 'no registrado', notDetected: 'no detectado' },
  };
  const s = STATUS[language];
  const items: MenuItem<ClientId>[] = INSTALLERS.map((inst) => {
    const d = inst.detect();
    const hint = !d.installed ? s.notDetected : d.registered ? s.registered : s.notRegistered;
    return { value: inst.id, label: inst.displayName, hint };
  });

  const [idx, setIdx] = useState(0);

  useInput((input, key) => {
    if (key.upArrow) setIdx((i) => (i - 1 + items.length) % items.length);
    else if (key.downArrow) setIdx((i) => (i + 1) % items.length);
    else if (key.return) onPick(items[idx]!.value);
    else if (input === 'q' || key.escape) onBack();
  });

  return (
    <Frame title={t.title} footer={t.footer}>
      <Text color="white" bold>
        {t.prompt}
      </Text>
      <Box marginTop={1}>
        <Menu items={items} selectedIndex={idx} />
      </Box>
    </Frame>
  );
}

/* ── Install result ────────────────────────────────────────────────────── */

interface InstallResultProps extends CommonProps {
  report: InstallReport;
  onBack: () => void;
}

const RESULT_I18N: Record<Language, { ok: string; warn: string; hint: string; footer: string }> = {
  en: {
    ok: 'Registered',
    warn: 'Not registered',
    hint: 'Restart the MCP client so it picks up the new entry.',
    footer: '↵ / Esc back to menu',
  },
  es: {
    ok: 'Registrado',
    warn: 'No registrado',
    hint: 'Reiniciá el cliente MCP para que tome la nueva entrada.',
    footer: '↵ / Esc volver al menú',
  },
};

export function InstallResultView({ language, report, onBack }: InstallResultProps) {
  const t = RESULT_I18N[language];
  useInput((_input, key) => {
    if (key.return || key.escape) onBack();
  });
  const ok = report.installedClient;
  return (
    <Frame title={`${report.displayName} — ${ok ? t.ok : t.warn}`} footer={t.footer}>
      <Text color={ok ? 'green' : 'yellow'}>
        {ok ? '✓ ' : '⚠ '}
        {report.message}
      </Text>
      {ok && (
        <Box marginTop={1}>
          <Text color="cyan">→ {t.hint}</Text>
        </Box>
      )}
    </Frame>
  );
}

/* ── Extension info ────────────────────────────────────────────────────── */

const EXT_I18N: Record<
  Language,
  {
    title: string;
    pathLabel: string;
    stepsLabel: string;
    footer: string;
    afterLoading: string;
    notFound: string;
  }
> = {
  en: {
    title: 'Chrome extension — install steps',
    pathLabel: 'Extension assets are at:',
    stepsLabel: 'Install steps:',
    afterLoading:
      'After loading, open the extension popup on any tab and click "Conectar" to bridge it.',
    notFound:
      'Extension assets not found. Run `npm run build:extension` (dev) or reinstall the package.',
    footer: '↵ / Esc back to menu',
  },
  es: {
    title: 'Extensión de Chrome — pasos de instalación',
    pathLabel: 'Los assets de la extensión están en:',
    stepsLabel: 'Pasos:',
    afterLoading:
      'Después de cargarla, abrí el popup de la extensión en cualquier pestaña y hacé click en "Conectar" para puentearla.',
    notFound:
      'No se encontraron los assets. Corré `npm run build:extension` (dev) o reinstalá el paquete.',
    footer: '↵ / Esc volver al menú',
  },
};

interface ExtensionViewProps extends CommonProps {
  onBack: () => void;
}

export function ExtensionView({ language, onBack }: ExtensionViewProps) {
  const t = EXT_I18N[language];
  const info = getExtensionInfo();
  useInput((_input, key) => {
    if (key.return || key.escape) onBack();
  });
  return (
    <Frame title={t.title} footer={t.footer}>
      {info.path ? (
        <>
          <Text bold>{t.pathLabel}</Text>
          <Text color="cyan">{info.path}</Text>
          <Box marginTop={1} flexDirection="column">
            <Text bold>{t.stepsLabel}</Text>
            <Text>{info.hints}</Text>
          </Box>
          <Box marginTop={1}>
            <Text color="gray" italic>
              {t.afterLoading}
            </Text>
          </Box>
        </>
      ) : (
        <Text color="yellow">{t.notFound}</Text>
      )}
    </Frame>
  );
}

/* ── Doctor ────────────────────────────────────────────────────────────── */

const DOCTOR_I18N: Record<
  Language,
  { title: string; loading: string; footer: string; refresh: string }
> = {
  en: {
    title: 'Doctor — diagnose current setup',
    loading: 'Diagnosing…',
    refresh: 'r refresh · ↵ / Esc back to menu',
    footer: '↵ / Esc back to menu',
  },
  es: {
    title: 'Diagnóstico — estado actual de la instalación',
    loading: 'Diagnosticando…',
    refresh: 'r refrescar · ↵ / Esc volver al menú',
    footer: '↵ / Esc volver al menú',
  },
};

interface DoctorViewProps extends CommonProps {
  onBack: () => void;
}

export function DoctorView({ language, onBack }: DoctorViewProps) {
  const t = DOCTOR_I18N[language];
  const [output, setOutput] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setOutput(null);
    runDoctor().then((r) => {
      if (!cancelled) setOutput(formatDoctor(r));
    });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  useInput((input, key) => {
    if (key.return || key.escape) onBack();
    else if (input === 'r') setRefreshKey((k) => k + 1);
  });

  return (
    <Frame title={t.title} footer={t.refresh}>
      {output === null ? <Text color="gray">{t.loading}</Text> : <Text>{output}</Text>}
    </Frame>
  );
}

/* ── About ─────────────────────────────────────────────────────────────── */

interface AboutViewProps extends CommonProps {
  onBack: () => void;
}

export function AboutView({ language, onBack }: AboutViewProps) {
  const t = I18N_ABOUT[language];
  useInput((_input, key) => {
    if (key.return || key.escape) onBack();
  });
  const footer = language === 'es' ? '↵ / Esc volver al menú' : '↵ / Esc back to menu';
  return (
    <Frame title={t.title} footer={footer}>
      <AboutSection title={t.whatTitle} body={t.what} />
      <AboutSection title={t.howTitle} body={t.how} />
      <AboutSection title={t.bindingTitle} body={t.binding} />
      <AboutSection title={t.bridgeToolsTitle} body={t.bridgeTools} />
      <AboutSection title={t.mapToolsTitle} body={t.mapTools} />
      <AboutSection title={t.privacyTitle} body={t.privacy} />
      <AboutSection title={t.helpTitle} body={t.help} />
    </Frame>
  );
}

function AboutSection({ title, body }: { title: string; body: string }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color="cyan" bold>
        {title}
      </Text>
      <Text>{body}</Text>
    </Box>
  );
}

/* ── Permissions ───────────────────────────────────────────────────────── */

const PERM_I18N: Record<
  Language,
  {
    title: string;
    intro: string;
    presetsHeader: string;
    bridgeHeader: string;
    mapHeader: string;
    applyPrefix: string;
    unsaved: string;
    saved: string;
    restart: string;
    footer: string;
  }
> = {
  en: {
    title: 'Permissions — pick which MCP tools to expose',
    intro: 'Apply a preset (↵) or toggle individual tools (Space). Press s to save.',
    presetsHeader: 'Presets',
    bridgeHeader: 'Browser bridge',
    mapHeader: 'Persistent UI map',
    applyPrefix: 'Apply: ',
    unsaved: '* Unsaved changes — press s to save',
    saved: '✓ Saved.',
    restart: 'Changes take effect the next time your MCP client starts the server.',
    footer: '↑↓ navigate · Space toggle · ↵ apply preset · s save · Esc back',
  },
  es: {
    title: 'Permisos — elegí qué tools del MCP se exponen',
    intro: 'Aplicá un preset (↵) o cambiá tools individuales (Espacio). Apretá s para guardar.',
    presetsHeader: 'Presets',
    bridgeHeader: 'Bridge del browser',
    mapHeader: 'Mapa persistente',
    applyPrefix: 'Aplicar: ',
    unsaved: '* Cambios sin guardar — apretá s para guardar',
    saved: '✓ Guardado.',
    restart: 'Los cambios tienen efecto la próxima vez que el cliente MCP arranque el servidor.',
    footer: '↑↓ moverse · Espacio cambiar · ↵ aplicar preset · s guardar · Esc volver',
  },
};

type PermRow =
  | { kind: 'preset'; preset: PresetDef }
  | { kind: 'tool'; tool: ToolMeta }
  | { kind: 'header'; family: ToolFamily };

interface PermissionsViewProps extends CommonProps {
  onBack: () => void;
}

function setsDiffer(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return true;
  for (const x of a) if (!b.has(x)) return true;
  return false;
}

export function PermissionsView({ language, onBack }: PermissionsViewProps) {
  const t = PERM_I18N[language];

  const rows: PermRow[] = useMemo(() => {
    const r: PermRow[] = [];
    for (const preset of PRESETS) r.push({ kind: 'preset', preset });
    r.push({ kind: 'header', family: 'bridge' });
    for (const tool of TOOL_CATALOGUE) {
      if (tool.family === 'bridge') r.push({ kind: 'tool', tool });
    }
    r.push({ kind: 'header', family: 'map' });
    for (const tool of TOOL_CATALOGUE) {
      if (tool.family === 'map') r.push({ kind: 'tool', tool });
    }
    return r;
  }, []);

  const initial = useMemo(() => new Set(loadConfig().disabledTools ?? []), []);
  const [savedDisabled, setSavedDisabled] = useState<Set<string>>(initial);
  const [disabled, setDisabled] = useState<Set<string>>(initial);
  const firstNonHeader = rows.findIndex((r) => r.kind !== 'header');
  const [cursor, setCursor] = useState(firstNonHeader);
  const [justSaved, setJustSaved] = useState(false);

  const move = (dir: 1 | -1) => {
    setCursor((idx) => {
      let i = idx;
      for (let n = 0; n < rows.length; n++) {
        i = (i + dir + rows.length) % rows.length;
        if (rows[i]!.kind !== 'header') return i;
      }
      return idx;
    });
  };

  const toggleTool = (name: string) => {
    setDisabled((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
    setJustSaved(false);
  };

  const applyPreset = (preset: PresetDef) => {
    setDisabled(new Set(preset.disabled));
    setJustSaved(false);
  };

  const save = () => {
    const list = sanitizeDisabledTools([...disabled]);
    saveConfig({ disabledTools: list });
    setSavedDisabled(new Set(list));
    setJustSaved(true);
  };

  useInput((input, key) => {
    if (key.upArrow) move(-1);
    else if (key.downArrow) move(1);
    else if (input === ' ') {
      const row = rows[cursor];
      if (row?.kind === 'tool') toggleTool(row.tool.name);
    } else if (key.return) {
      const row = rows[cursor];
      if (row?.kind === 'preset') applyPreset(row.preset);
    } else if (input === 's' || input === 'S') {
      save();
    } else if (input === 'q' || key.escape) onBack();
  });

  const unsaved = setsDiffer(disabled, savedDisabled);

  return (
    <Frame title={t.title} footer={t.footer}>
      <Box marginBottom={1}>
        <Text color="white">{t.intro}</Text>
      </Box>
      <Box flexDirection="column">
        {rows.map((row, i) => {
          if (row.kind === 'header') {
            const label = row.family === 'bridge' ? t.bridgeHeader : t.mapHeader;
            return (
              <Box key={`h-${i}`} marginTop={1}>
                <Text color="cyan" bold>
                  {label}:
                </Text>
              </Box>
            );
          }
          const isCursor = i === cursor;
          const cursorMark = isCursor ? '❯' : ' ';
          if (row.kind === 'preset') {
            return (
              <Box key={`p-${row.preset.id}`}>
                <Text color={isCursor ? 'cyan' : 'gray'}>{cursorMark} </Text>
                <Text color={isCursor ? 'white' : 'gray'} bold={isCursor}>
                  {t.applyPrefix}
                  {row.preset.label}
                </Text>
              </Box>
            );
          }
          const isDisabled = disabled.has(row.tool.name);
          const checkbox = isDisabled ? '[ ]' : '[x]';
          const checkboxColor = isDisabled ? 'red' : 'green';
          return (
            <Box key={`t-${row.tool.name}`}>
              <Text color={isCursor ? 'cyan' : 'gray'}>{cursorMark} </Text>
              <Text color={checkboxColor}>{checkbox} </Text>
              <Text color={isCursor ? 'white' : isDisabled ? 'gray' : 'white'} bold={isCursor}>
                {row.tool.name.padEnd(28)}
              </Text>
              <Text color="gray" dimColor>
                {' '}
                {row.tool.summary}
              </Text>
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1} flexDirection="column">
        {unsaved ? (
          <Text color="yellow">{t.unsaved}</Text>
        ) : justSaved ? (
          <Text color="green">{t.saved}</Text>
        ) : null}
        <Text color="gray" italic>
          {t.restart}
        </Text>
      </Box>
    </Frame>
  );
}

/* ── Updates ───────────────────────────────────────────────────────────── */

const UPDATES_I18N: Record<
  Language,
  {
    title: string;
    checking: string;
    current: string;
    latest: string;
    upToDate: string;
    available: string;
    upgradeCmd: string;
    updateKeyHint: string;
    updateRunning: string;
    error: string;
    footerIdle: string;
    footerWithUpdate: string;
    footerUpdating: string;
    footerDone: string;
    footerFailed: string;
  }
> = {
  en: {
    title: 'Check for updates',
    checking: 'Checking the npm registry…',
    current: 'Current version',
    latest: 'Latest on npm  ',
    upToDate: '✓ You are on the latest published version.',
    available: '⚠ A newer version is available.',
    upgradeCmd: 'Or, to upgrade manually, run:',
    updateKeyHint: 'Press u to update now (stops any running primary, then installs).',
    updateRunning: 'Updating…',
    error: 'Could not check the registry',
    footerIdle: 'r retry · ↵ / Esc back to menu',
    footerWithUpdate: 'u update · r retry · ↵ / Esc back to menu',
    footerUpdating: 'updating — please wait…',
    footerDone: '↵ / Esc back to menu — restart your MCP client to pick up the new version',
    footerFailed: 'r retry check · ↵ / Esc back to menu',
  },
  es: {
    title: 'Buscar actualizaciones',
    checking: 'Consultando el registry de npm…',
    current: 'Versión instalada',
    latest: 'Última en npm    ',
    upToDate: '✓ Estás en la última versión publicada.',
    available: '⚠ Hay una versión más nueva disponible.',
    upgradeCmd: 'O, para actualizar a mano, corré:',
    updateKeyHint: 'Tocá u para actualizar ahora (corta el primary en uso e instala).',
    updateRunning: 'Actualizando…',
    error: 'No se pudo consultar el registry',
    footerIdle: 'r reintentar · ↵ / Esc volver al menú',
    footerWithUpdate: 'u actualizar · r reintentar · ↵ / Esc volver al menú',
    footerUpdating: 'actualizando — esperá…',
    footerDone: '↵ / Esc volver al menú — reiniciá tu cliente MCP para que tome la nueva versión',
    footerFailed: 'r reintentar el chequeo · ↵ / Esc volver al menú',
  },
};

interface UpdatesViewProps extends CommonProps {
  onBack: () => void;
}

/** Local UI state for an in-flight self-update. Drives both the body and
 * the footer so the user sees one consistent stage label. */
type UpdatePhase =
  | { kind: 'idle' }
  | { kind: 'running'; stage: SelfUpdateProgress['stage']; message: string }
  | { kind: 'done'; message: string }
  | { kind: 'failed'; message: string };

export function UpdatesView({ language, onBack }: UpdatesViewProps) {
  const t = UPDATES_I18N[language];
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [update, setUpdate] = useState<UpdatePhase>({ kind: 'idle' });

  useEffect(() => {
    let cancelled = false;
    setInfo(null);
    setUpdate({ kind: 'idle' });
    checkUpdates().then((r) => {
      if (!cancelled) setInfo(r);
    });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const isUpdating = update.kind === 'running';
  const canUpdate = info !== null && info.newer === true && info.latest !== null && !isUpdating;

  const startUpdate = (): void => {
    if (!canUpdate || info === null || info.latest === null) return;
    const target = info.latest;
    setUpdate({ kind: 'running', stage: 'preflight', message: t.updateRunning });
    runSelfUpdate(target, language, (event) => {
      setUpdate({ kind: 'running', stage: event.stage, message: event.message });
    })
      .then((result: SelfUpdateResult) => {
        setUpdate({
          kind: result.ok ? 'done' : 'failed',
          message: result.message,
        });
      })
      .catch((err: unknown) => {
        setUpdate({
          kind: 'failed',
          message: err instanceof Error ? err.message : String(err),
        });
      });
  };

  useInput((input, key) => {
    if (isUpdating) return; // ignore keys while the install is in flight
    if (key.return || key.escape) onBack();
    else if (input === 'r' && update.kind !== 'done') setRefreshKey((k) => k + 1);
    else if (input === 'u') startUpdate();
  });

  const footer =
    update.kind === 'running'
      ? t.footerUpdating
      : update.kind === 'done'
        ? t.footerDone
        : update.kind === 'failed'
          ? t.footerFailed
          : canUpdate
            ? t.footerWithUpdate
            : t.footerIdle;

  return (
    <Frame title={t.title} footer={footer}>
      {info === null ? (
        <Text color="gray">{t.checking}</Text>
      ) : info.error || info.latest === null ? (
        <Box flexDirection="column">
          <Text>
            <Text color="white">{t.current}: </Text>
            <Text bold>{info.current}</Text>
          </Text>
          <Box marginTop={1}>
            <Text color="red">
              {t.error}: {info.error ?? 'unknown error'}
            </Text>
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column">
          <Text>
            <Text color="white">{t.current}: </Text>
            <Text bold>{info.current}</Text>
          </Text>
          <Text>
            <Text color="white">{t.latest}: </Text>
            <Text bold color={info.newer ? 'yellow' : 'green'}>
              {info.latest}
            </Text>
          </Text>
          <Box marginTop={1}>
            <Text color={info.newer ? 'yellow' : 'green'}>
              {info.newer ? t.available : t.upToDate}
            </Text>
          </Box>
          {info.newer && update.kind === 'idle' && (
            <Box flexDirection="column" marginTop={1}>
              <Text color="cyan">{t.updateKeyHint}</Text>
              <Box marginTop={1} flexDirection="column">
                <Text color="gray">{t.upgradeCmd}</Text>
                <Text color="cyan">{`npm install -g ${PACKAGE_NAME}@latest`}</Text>
              </Box>
            </Box>
          )}
          {update.kind === 'running' && (
            <Box flexDirection="column" marginTop={1}>
              <Text color="cyan">{t.updateRunning}</Text>
              <Text color="gray">{update.message}</Text>
            </Box>
          )}
          {update.kind === 'done' && (
            <Box marginTop={1}>
              <Text color="green">{update.message}</Text>
            </Box>
          )}
          {update.kind === 'failed' && (
            <Box marginTop={1}>
              <Text color="red">{update.message}</Text>
            </Box>
          )}
        </Box>
      )}
    </Frame>
  );
}

/* ── Language ──────────────────────────────────────────────────────────── */

const LANG_I18N: Record<
  Language,
  { title: string; prompt: string; saved: string; footer: string }
> = {
  en: {
    title: 'Language — switch between English and Español',
    prompt: 'Pick a language',
    saved: '✓ Saved. All output will now use the selected language.',
    footer: '↑↓ navigate · ↵ pick · Esc back',
  },
  es: {
    title: 'Idioma — cambiar entre English y Español',
    prompt: 'Elegí un idioma',
    saved: '✓ Guardado. Todo el output va a usar el idioma elegido.',
    footer: '↑↓ moverse · ↵ elegir · Esc volver',
  },
};

interface LanguageViewProps extends CommonProps {
  onPick: (next: Language) => void;
  onBack: () => void;
}

export function LanguageView({ language, onPick, onBack }: LanguageViewProps) {
  const t = LANG_I18N[language];
  const items: MenuItem<Language>[] = [
    { value: 'en', label: 'English' },
    { value: 'es', label: 'Español' },
  ];
  const [idx, setIdx] = useState<number>(language === 'es' ? 1 : 0);
  const [saved, setSaved] = useState(false);

  useInput((_input, key) => {
    if (key.upArrow) setIdx((i) => (i - 1 + items.length) % items.length);
    else if (key.downArrow) setIdx((i) => (i + 1) % items.length);
    else if (key.return) {
      const next = items[idx]!.value;
      onPick(next);
      setSaved(true);
    } else if (key.escape) onBack();
  });

  return (
    <Frame title={t.title} footer={t.footer}>
      <Text color="white" bold>
        {t.prompt}
      </Text>
      <Box marginTop={1}>
        <Menu items={items} selectedIndex={idx} />
      </Box>
      {saved && (
        <Box marginTop={1}>
          <Text color="green">{t.saved}</Text>
        </Box>
      )}
    </Frame>
  );
}

/* ── Multi-agent ───────────────────────────────────────────────────────── */

interface MultiAgentI18n {
  title: string;
  multiHeader: string;
  multiBody: string;
  multiToggle: string;
  reelectHeader: string;
  reelectBody: string;
  reelectToggle: string;
  reelectDisabled: string;
  unsaved: string;
  saved: string;
  restart: string;
  footer: string;
}

const MULTI_AGENT_I18N: Record<Language, MultiAgentI18n> = {
  en: {
    title: 'Multi-agent — let multiple MCP clients share one browser-link',
    multiHeader: 'Multi-agent mode',
    multiBody: [
      'browser-link normally binds 127.0.0.1:17529 from the first MCP',
      'client that starts it. Other clients (Claude + Copilot + OpenCode at',
      'the same time) crash with "port in use".',
      '',
      'When multi-agent is ON, the second instance becomes a proxy that',
      'forwards MCP requests to the first one over an internal port',
      '(127.0.0.1:17530, kernel-validated like the main one). All agents',
      'end up sharing the same connected Chrome tabs and the same',
      'persistent UI map.',
    ].join('\n'),
    multiToggle: 'Enable multi-agent mode',
    reelectHeader: 'Auto-reelect on primary close (advanced)',
    reelectBody: [
      'When the primary client closes, secondary clients lose the bridge.',
      'With auto-reelect ON, one of them takes over the primary role',
      'automatically (race on bind). With it OFF, you relaunch your MCP',
      'client manually to reconnect.',
    ].join('\n'),
    reelectToggle: 'Auto-reelect when primary closes',
    reelectDisabled: '(enable multi-agent first)',
    unsaved: '* Unsaved changes — press s to save',
    saved: '✓ Saved.',
    restart: 'Restart every MCP client for these changes to take effect.',
    footer: '↑↓ navigate · Space toggle · s save · Esc back',
  },
  es: {
    title: 'Multi-agente — varios clientes MCP comparten el mismo puente',
    multiHeader: 'Modo multi-agente',
    multiBody: [
      'browser-link normalmente bindea 127.0.0.1:17529 desde el primer',
      'cliente MCP que lo arranca. Otros clientes (Claude + Copilot +',
      'OpenCode al mismo tiempo) caen con "port in use".',
      '',
      'Con multi-agente activado, el segundo proceso se vuelve un proxy',
      'que reenvía los pedidos MCP al primero por un puerto interno',
      '(127.0.0.1:17530, validado por kernel igual que el principal).',
      'Todos los agentes terminan viendo las mismas pestañas conectadas',
      'y el mismo mapa persistente.',
    ].join('\n'),
    multiToggle: 'Activar modo multi-agente',
    reelectHeader: 'Re-elección automática al cerrar el primary (avanzado)',
    reelectBody: [
      'Cuando el cliente primary cierra, los secundarios pierden el',
      'puente. Con re-elección automática activada, uno de ellos toma el',
      'rol de primary automáticamente (race en el bind). Con ella',
      'desactivada, tenés que relanzar el cliente MCP a mano para',
      'reconectar.',
    ].join('\n'),
    reelectToggle: 'Re-elegir automáticamente al cerrar el primary',
    reelectDisabled: '(activá primero multi-agente)',
    unsaved: '* Cambios sin guardar — apretá s para guardar',
    saved: '✓ Guardado.',
    restart: 'Reiniciá cada cliente MCP para que los cambios tengan efecto.',
    footer: '↑↓ moverse · Espacio cambiar · s guardar · Esc volver',
  },
};

interface MultiAgentViewProps extends CommonProps {
  onBack: () => void;
}

export function MultiAgentView({ language, onBack }: MultiAgentViewProps) {
  const t = MULTI_AGENT_I18N[language];

  const initialCfg = useMemo(() => loadConfig(), []);
  const [savedMulti, setSavedMulti] = useState<boolean>(initialCfg.multiAgent === true);
  const [savedReelect, setSavedReelect] = useState<boolean>(initialCfg.autoReelect === true);
  const [multi, setMulti] = useState<boolean>(savedMulti);
  const [reelect, setReelect] = useState<boolean>(savedReelect);
  const [justSaved, setJustSaved] = useState(false);

  // Only the two toggles are navigable.
  const [cursor, setCursor] = useState<'multi' | 'reelect'>('multi');

  const move = (dir: 1 | -1) => {
    setCursor((c) => {
      if (dir === 1) return c === 'multi' ? 'reelect' : 'multi';
      return c === 'reelect' ? 'multi' : 'reelect';
    });
  };

  const toggle = () => {
    if (cursor === 'multi') {
      setMulti((m) => {
        const next = !m;
        // Turning multi off also clears the working reelect state, matching
        // the config normalisation rule (autoReelect implies multiAgent).
        if (!next) setReelect(false);
        return next;
      });
    } else {
      // Auto-reelect can only be turned on when multi is on.
      if (!multi) return;
      setReelect((r) => !r);
    }
    setJustSaved(false);
  };

  const save = () => {
    saveConfig({ multiAgent: multi, autoReelect: multi ? reelect : false });
    setSavedMulti(multi);
    setSavedReelect(multi ? reelect : false);
    setJustSaved(true);
  };

  useInput((input, key) => {
    if (key.upArrow) move(-1);
    else if (key.downArrow) move(1);
    else if (input === ' ') toggle();
    else if (input === 's' || input === 'S') save();
    else if (input === 'q' || key.escape) onBack();
  });

  const unsaved = multi !== savedMulti || reelect !== savedReelect;

  const checkbox = (on: boolean, dim: boolean): { mark: string; color: string } => {
    if (dim) return { mark: '[ ]', color: 'gray' };
    return on ? { mark: '[x]', color: 'green' } : { mark: '[ ]', color: 'red' };
  };

  const multiBox = checkbox(multi, false);
  const reelectBox = checkbox(multi ? reelect : false, !multi);

  return (
    <Frame title={t.title} footer={t.footer}>
      <Box flexDirection="column" marginBottom={1}>
        <Text color="cyan" bold>
          {t.multiHeader}
        </Text>
        <Text>{t.multiBody}</Text>
      </Box>
      <Box marginBottom={1}>
        <Text color={cursor === 'multi' ? 'cyan' : 'gray'}>{cursor === 'multi' ? '❯ ' : '  '}</Text>
        <Text color={multiBox.color}>{multiBox.mark} </Text>
        <Text color={cursor === 'multi' ? 'white' : 'gray'} bold={cursor === 'multi'}>
          {t.multiToggle}
        </Text>
      </Box>
      <Box flexDirection="column" marginBottom={1}>
        <Text color="cyan" bold>
          {t.reelectHeader}
        </Text>
        <Text>{t.reelectBody}</Text>
      </Box>
      <Box marginBottom={1}>
        <Text color={cursor === 'reelect' ? 'cyan' : 'gray'}>
          {cursor === 'reelect' ? '❯ ' : '  '}
        </Text>
        <Text color={reelectBox.color}>{reelectBox.mark} </Text>
        <Text
          color={!multi ? 'gray' : cursor === 'reelect' ? 'white' : 'gray'}
          bold={cursor === 'reelect' && multi}
        >
          {t.reelectToggle}
          {!multi && (
            <Text color="gray" dimColor>
              {' '}
              {t.reelectDisabled}
            </Text>
          )}
        </Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {unsaved ? (
          <Text color="yellow">{t.unsaved}</Text>
        ) : justSaved ? (
          <Text color="green">{t.saved}</Text>
        ) : null}
        <Text color="gray" italic>
          {t.restart}
        </Text>
      </Box>
    </Frame>
  );
}

/* ── Free port ─────────────────────────────────────────────────────────── */

interface FreePortI18n {
  title: string;
  intro: string;
  confirmPrompt: string;
  confirmYes: string;
  confirmNo: string;
  running: string;
  footer: string;
  doneFooter: string;
}

const FREE_PORT_I18N: Record<Language, FreePortI18n> = {
  en: {
    title: 'Free port 17529',
    intro: [
      'If an MCP client (Claude / OpenCode / Copilot) was closed without',
      'shutting down browser-link cleanly, the next client crashes with',
      '"port already in use". This screen finds the process holding',
      '127.0.0.1:17529 and stops it.',
      '',
      'Safety: only processes whose image starts with "node" are killed.',
      'Anything else is left alone with an explanation.',
    ].join('\n'),
    confirmPrompt: 'Stop the process holding port 17529?',
    confirmYes: 'Yes — kill it',
    confirmNo: 'No — back to menu',
    running: 'Stopping…',
    footer: '↑↓ navigate · ↵ select · Esc back',
    doneFooter: '↵ / Esc back to menu',
  },
  es: {
    title: 'Liberar puerto 17529',
    intro: [
      'Si un cliente MCP (Claude / OpenCode / Copilot) cerró sin bajar',
      'browser-link de forma limpia, el próximo cliente crashea con',
      '"port already in use". Esta pantalla busca el proceso que tiene',
      '127.0.0.1:17529 y lo para.',
      '',
      'Seguridad: sólo se matan procesos cuyo nombre empieza con "node".',
      'Cualquier otro se deja vivo con una explicación.',
    ].join('\n'),
    confirmPrompt: '¿Parar el proceso que tiene el puerto 17529?',
    confirmYes: 'Sí — matalo',
    confirmNo: 'No — volver al menú',
    running: 'Parando…',
    footer: '↑↓ moverse · ↵ elegir · Esc volver',
    doneFooter: '↵ / Esc volver al menú',
  },
};

interface FreePortViewProps extends CommonProps {
  onBack: () => void;
}

export function FreePortView({ language, onBack }: FreePortViewProps) {
  const t = FREE_PORT_I18N[language];
  const [phase, setPhase] = useState<'confirm' | 'running' | 'done'>('confirm');
  const [result, setResult] = useState<FreePortResult | null>(null);
  const items: MenuItem<'yes' | 'no'>[] = [
    { value: 'yes', label: t.confirmYes },
    { value: 'no', label: t.confirmNo },
  ];
  const [idx, setIdx] = useState(1);

  useInput((_input, key) => {
    if (phase === 'confirm') {
      if (key.upArrow) setIdx((i) => (i - 1 + items.length) % items.length);
      else if (key.downArrow) setIdx((i) => (i + 1) % items.length);
      else if (key.return) {
        const v = items[idx]!.value;
        if (v === 'no') onBack();
        else {
          setPhase('running');
          // Defer the synchronous kill so Ink renders the "running" state.
          setTimeout(() => {
            const r = runFreePort(language);
            setResult(r);
            setPhase('done');
          }, 0);
        }
      } else if (key.escape) onBack();
    } else if (phase === 'done') {
      if (key.return || key.escape) onBack();
    }
  });

  return (
    <Frame title={t.title} footer={phase === 'done' ? t.doneFooter : t.footer}>
      <Box marginBottom={1}>
        <Text>{t.intro}</Text>
      </Box>
      {phase === 'confirm' && (
        <>
          <Text color="white" bold>
            {t.confirmPrompt}
          </Text>
          <Box marginTop={1}>
            <Menu items={items} selectedIndex={idx} />
          </Box>
        </>
      )}
      {phase === 'running' && <Text color="gray">{t.running}</Text>}
      {phase === 'done' && result && (
        <Text color={result.ok ? 'green' : 'yellow'}>{result.message}</Text>
      )}
    </Frame>
  );
}
