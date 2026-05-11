import { Box, Text, useInput } from 'ink';
import { useEffect, useState } from 'react';
import { Frame, Menu, type MenuItem } from './components.js';
import { I18N_WELCOME, type Language } from '../commands/welcome.js';
import { I18N_ABOUT } from '../commands/about.js';
import { INSTALLERS, type ClientId } from '../installers/index.js';
import { installFor, type InstallReport } from '../commands/install.js';
import { runDoctor, formatDoctor } from '../commands/doctor.js';
import { getExtensionInfo } from '../commands/extension.js';
import { checkUpdates, type UpdateInfo } from '../commands/updates.js';
import { PACKAGE_NAME } from '../version.js';

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
  | 'extension'
  | 'doctor'
  | 'updates'
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
      extension: 'Show Chrome extension install steps',
      doctor: 'Run doctor (diagnose current setup)',
      updates: 'Check for updates on npm',
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
      extension: 'Ver pasos para instalar la extensión de Chrome',
      doctor: 'Diagnóstico (estado actual de la instalación)',
      updates: 'Buscar actualizaciones en npm',
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
    ['register', 'extension', 'doctor', 'updates', 'welcome', 'about', 'repo', 'quit'] as const
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
