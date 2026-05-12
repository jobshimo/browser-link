import { Box, Text, useInput } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import { Frame, Menu, type MenuItem } from './components.js';
import { I18N_WELCOME, type Language } from '../commands/welcome.js';
import { I18N_ABOUT } from '../commands/about.js';
import { INSTALLERS, type ClientId } from '../installers/index.js';
import { installFor, type InstallReport } from '../commands/install.js';
import { runDoctor, formatDoctor } from '../commands/doctor.js';
import { getExtensionInfo } from '../commands/extension.js';
import { checkUpdates, type UpdateInfo } from '../commands/updates.js';
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
  | 'extension'
  | 'doctor'
  | 'updates'
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
      extension: 'Show Chrome extension install steps',
      doctor: 'Run doctor (diagnose current setup)',
      updates: 'Check for updates on npm',
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
      extension: 'Ver pasos para instalar la extensión de Chrome',
      doctor: 'Diagnóstico (estado actual de la instalación)',
      updates: 'Buscar actualizaciones en npm',
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
      'extension',
      'doctor',
      'updates',
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
    error: string;
    footer: string;
  }
> = {
  en: {
    title: 'Check for updates',
    checking: 'Checking the npm registry…',
    current: 'Current version',
    latest: 'Latest on npm  ',
    upToDate: '✓ You are on the latest published version.',
    available: '⚠ A newer version is available.',
    upgradeCmd: 'To upgrade, run:',
    error: 'Could not check the registry',
    footer: 'r retry · ↵ / Esc back to menu',
  },
  es: {
    title: 'Buscar actualizaciones',
    checking: 'Consultando el registry de npm…',
    current: 'Versión instalada',
    latest: 'Última en npm    ',
    upToDate: '✓ Estás en la última versión publicada.',
    available: '⚠ Hay una versión más nueva disponible.',
    upgradeCmd: 'Para actualizar, corré:',
    error: 'No se pudo consultar el registry',
    footer: 'r reintentar · ↵ / Esc volver al menú',
  },
};

interface UpdatesViewProps extends CommonProps {
  onBack: () => void;
}

export function UpdatesView({ language, onBack }: UpdatesViewProps) {
  const t = UPDATES_I18N[language];
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setInfo(null);
    checkUpdates().then((r) => {
      if (!cancelled) setInfo(r);
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
    <Frame title={t.title} footer={t.footer}>
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
          {info.newer && (
            <Box flexDirection="column" marginTop={1}>
              <Text color="gray">{t.upgradeCmd}</Text>
              <Text color="cyan">{`npm install -g ${PACKAGE_NAME}@latest`}</Text>
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
