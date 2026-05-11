import * as p from '@clack/prompts';
import { INSTALLERS, type ClientId } from '../installers/index.js';
import { installFor } from './install.js';
import { formatDoctor, runDoctor } from './doctor.js';
import { printExtensionInstructions } from './extension.js';
import { runWelcome, type Language } from './welcome.js';
import { runAbout } from './about.js';
import { openUrl } from '../utils/open-url.js';

const REPO_URL = 'https://github.com/jobshimo/browser-link';

interface MenuI18n {
  title: string;
  outro: string;
  prompt: string;
  options: {
    register: string;
    extension: string;
    doctor: string;
    welcome: string;
    about: string;
    repo: string;
    quit: string;
  };
  statusRegistered: string;
  statusNotRegistered: string;
  statusClientMissing: string;
  registerSuccessHint: string;
  repoOpened: string;
  repoFallback: string;
  pickClient: string;
}

export const I18N_MENU: Record<Language, MenuI18n> = {
  en: {
    title: 'browser-link — setup',
    outro: 'See you around. Run `browser-link` any time to come back.',
    prompt: 'Pick an action',
    options: {
      register: 'Register browser-link with an MCP client',
      extension: 'Show Chrome extension install steps',
      doctor: 'Run doctor (diagnose current setup)',
      welcome: 'Show the welcome screen',
      about: 'About / Help — what is this and how it works',
      repo: 'Open the GitHub repository',
      quit: 'Quit',
    },
    statusRegistered: 'registered',
    statusNotRegistered: 'not registered',
    statusClientMissing: 'not detected',
    registerSuccessHint: 'Restart the MCP client so it picks up the new entry.',
    repoOpened: 'Opening the repository in your browser…',
    repoFallback: 'Could not open a browser automatically. Visit:',
    pickClient: 'Which MCP client do you want to register?',
  },
  es: {
    title: 'browser-link — configuración',
    outro: 'Hasta luego. Ejecutá `browser-link` cuando quieras volver.',
    prompt: 'Elegí una acción',
    options: {
      register: 'Registrar browser-link en un cliente MCP',
      extension: 'Ver pasos para instalar la extensión de Chrome',
      doctor: 'Diagnóstico (estado actual de la instalación)',
      welcome: 'Mostrar la pantalla de bienvenida',
      about: 'Información / ayuda — qué es esto y cómo funciona',
      repo: 'Abrir el repositorio en GitHub',
      quit: 'Salir',
    },
    statusRegistered: 'registrado',
    statusNotRegistered: 'no registrado',
    statusClientMissing: 'no detectado',
    registerSuccessHint: 'Reiniciá el cliente MCP para que tome la nueva entrada.',
    repoOpened: 'Abriendo el repositorio en tu navegador…',
    repoFallback: 'No se pudo abrir el navegador automáticamente. Visitá:',
    pickClient: '¿En qué cliente MCP querés registrar browser-link?',
  },
};

type Action = 'register' | 'extension' | 'doctor' | 'welcome' | 'about' | 'repo' | 'quit';

function clientStatusLine(t: MenuI18n): string {
  return INSTALLERS.map((inst) => {
    const d = inst.detect();
    const status = !d.installed
      ? t.statusClientMissing
      : d.registered
        ? t.statusRegistered
        : t.statusNotRegistered;
    return `${inst.displayName.padEnd(10)} ${status}`;
  }).join('\n');
}

async function pickClient(t: MenuI18n): Promise<ClientId | null> {
  // When only one installer is wired, skip the picker.
  if (INSTALLERS.length === 1) return INSTALLERS[0]!.id;

  const choice = (await p.select({
    message: t.pickClient,
    options: INSTALLERS.map((inst) => {
      const d = inst.detect();
      const hint = !d.installed
        ? t.statusClientMissing
        : d.registered
          ? t.statusRegistered
          : t.statusNotRegistered;
      return { value: inst.id, label: inst.displayName, hint };
    }),
  })) as ClientId | symbol;

  if (p.isCancel(choice)) return null;
  return choice;
}

async function runAction(
  t: MenuI18n,
  action: Action,
  language: Language,
): Promise<{ keep: boolean; language: Language }> {
  switch (action) {
    case 'register': {
      const client = await pickClient(t);
      if (!client) return { keep: true, language };
      const report = installFor(client);
      if (report.installedClient) {
        p.log.success(`${report.displayName}: ${report.message}`);
        p.log.info(t.registerSuccessHint);
      } else {
        p.log.warn(`${report.displayName}: ${report.message}`);
      }
      return { keep: true, language };
    }
    case 'extension': {
      printExtensionInstructions();
      return { keep: true, language };
    }
    case 'doctor': {
      const report = await runDoctor();
      // Plain print — the doctor output has its own structure and is wide.
      console.log('');
      console.log(formatDoctor(report));
      console.log('');
      return { keep: true, language };
    }
    case 'welcome': {
      const result = await runWelcome({ initial: language, hideDismiss: true });
      if (result.action === 'quit') return { keep: false, language };
      return { keep: true, language: result.language };
    }
    case 'about': {
      await runAbout(language);
      return { keep: true, language };
    }
    case 'repo': {
      const ok = openUrl(REPO_URL);
      if (ok) {
        p.log.info(`${t.repoOpened}\n  ${REPO_URL}`);
      } else {
        p.log.warn(`${t.repoFallback}\n  ${REPO_URL}`);
      }
      return { keep: true, language };
    }
    case 'quit':
      return { keep: false, language };
  }
}

export async function runMenu(initialLanguage: Language = 'en'): Promise<void> {
  let language = initialLanguage;
  p.intro(I18N_MENU[language].title);

  while (true) {
    const t = I18N_MENU[language];
    p.note(clientStatusLine(t), 'MCP clients');

    const action = (await p.select({
      message: t.prompt,
      options: [
        { value: 'register', label: t.options.register },
        { value: 'extension', label: t.options.extension },
        { value: 'doctor', label: t.options.doctor },
        { value: 'welcome', label: t.options.welcome },
        { value: 'about', label: t.options.about },
        { value: 'repo', label: t.options.repo },
        { value: 'quit', label: t.options.quit },
      ],
    })) as Action | symbol;

    if (p.isCancel(action)) {
      p.outro(t.outro);
      return;
    }

    const result = await runAction(t, action, language);
    if (!result.keep) {
      p.outro(I18N_MENU[result.language].outro);
      return;
    }
    language = result.language;
  }
}
