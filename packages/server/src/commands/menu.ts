import { stdout } from 'node:process';
import { claudeInstaller } from '../installers/claude.js';
import { installFor } from './install.js';
import { formatDoctor, runDoctor } from './doctor.js';
import { printExtensionInstructions } from './extension.js';
import { runWelcome, type Language } from './welcome.js';
import { runAbout } from './about.js';
import {
  ansi,
  classifyKey,
  clearScreen,
  hideCursor,
  readKey,
  renderBox,
  showCursor,
} from './tty.js';

interface MenuI18n {
  title: string;
  prompt: string;
  pressEnter: string;
  options: {
    register: string;
    extension: string;
    doctor: string;
    welcome: string;
    about: string;
    quit: string;
  };
  statusRegistered: string;
  statusNotRegistered: string;
  statusClientMissing: string;
  registerSuccessHint: string;
}

export const I18N_MENU: Record<Language, MenuI18n> = {
  en: {
    title: 'browser-link — setup',
    prompt: '↑/↓ to move, Enter to select, q to quit',
    pressEnter: 'Press Enter to return to the menu…',
    options: {
      register: 'Register browser-link in Claude Code',
      extension: 'Show Chrome extension install steps',
      doctor: 'Run doctor (diagnose current setup)',
      welcome: 'Show welcome screen',
      about: 'About / Help — what is this and how it works',
      quit: 'Quit',
    },
    statusRegistered: 'already registered',
    statusNotRegistered: 'not registered',
    statusClientMissing: 'Claude config not found',
    registerSuccessHint: 'Restart Claude Code so it picks up the new MCP entry.',
  },
  es: {
    title: 'browser-link — configuración',
    prompt: '↑/↓ para moverte, Enter para elegir, q para salir',
    pressEnter: 'Pulsá Enter para volver al menú…',
    options: {
      register: 'Registrar browser-link en Claude Code',
      extension: 'Ver pasos para instalar la extensión de Chrome',
      doctor: 'Diagnóstico (estado actual de la instalación)',
      welcome: 'Mostrar pantalla de bienvenida',
      about: 'Información / ayuda — qué es esto y cómo funciona',
      quit: 'Salir',
    },
    statusRegistered: 'ya registrado',
    statusNotRegistered: 'no registrado',
    statusClientMissing: 'config de Claude no encontrada',
    registerSuccessHint: 'Reiniciá Claude Code para que tome el nuevo MCP.',
  },
};

export function claudeStatus(t: MenuI18n): string {
  const d = claudeInstaller.detect();
  if (!d.installed) return t.statusClientMissing;
  return d.registered ? t.statusRegistered : t.statusNotRegistered;
}

export function renderMenuScreen(t: MenuI18n, selectedIndex: number, options: string[]): string {
  const lines: string[] = [];
  lines.push(`${ansi.bold}${ansi.cyan}${t.title}${ansi.reset}`);
  lines.push('');
  options.forEach((label, i) => {
    const isSel = i === selectedIndex;
    const cursor = isSel ? `${ansi.cyan}❯${ansi.reset}` : ' ';
    const body = isSel ? `${ansi.bold}${label}${ansi.reset}` : `${ansi.gray}${label}${ansi.reset}`;
    lines.push(`  ${cursor} ${body}`);
  });
  lines.push('');
  lines.push(`${ansi.dim}${t.prompt}${ansi.reset}`);
  return renderBox(lines, { borderColor: ansi.gray });
}

async function pressEnter(t: MenuI18n): Promise<void> {
  stdout.write('\n' + ansi.dim + t.pressEnter + ansi.reset + ' ');
  while (true) {
    const k = classifyKey(await readKey());
    if (k === 'enter' || k === 'ctrl-c' || k === 'esc' || k === 'q') break;
  }
}

async function runOption(
  t: MenuI18n,
  index: number,
  language: Language,
): Promise<{ keep: boolean; language: Language }> {
  let lang = language;
  switch (index) {
    case 0: {
      clearScreen();
      const report = installFor('claude');
      const mark = report.installedClient ? `${ansi.green}✓${ansi.reset}` : `${ansi.gray}·${ansi.reset}`;
      console.log(`${mark} ${ansi.bold}${report.displayName}${ansi.reset}: ${report.message}`);
      if (report.installedClient) console.log(`  ${ansi.cyan}→${ansi.reset} ${t.registerSuccessHint}`);
      await pressEnter(t);
      return { keep: true, language: lang };
    }
    case 1: {
      clearScreen();
      printExtensionInstructions();
      await pressEnter(t);
      return { keep: true, language: lang };
    }
    case 2: {
      clearScreen();
      const r = await runDoctor();
      console.log(formatDoctor(r));
      await pressEnter(t);
      return { keep: true, language: lang };
    }
    case 3: {
      // Show welcome again (forced; hides "Don't show again" because the
      // user explicitly asked to see it).
      const result = await runWelcome({ initial: lang, hideDismiss: true });
      if (result.action === 'quit') return { keep: false, language: lang };
      lang = result.language;
      return { keep: true, language: lang };
    }
    case 4: {
      await runAbout(lang);
      return { keep: true, language: lang };
    }
    case 5:
      return { keep: false, language: lang };
    default:
      return { keep: true, language: lang };
  }
}

export async function runMenu(initialLanguage: Language = 'en'): Promise<void> {
  let language = initialLanguage;
  let selected = 0;

  hideCursor();
  try {
    while (true) {
      const t = I18N_MENU[language];
      const opts = [
        `${t.options.register}   ${ansi.dim}(${claudeStatus(t)})${ansi.reset}`,
        t.options.extension,
        t.options.doctor,
        t.options.welcome,
        t.options.about,
        t.options.quit,
      ];
      clearScreen();
      stdout.write(renderMenuScreen(t, selected, opts));
      stdout.write('\n');

      const key = classifyKey(await readKey());
      if (key === 'ctrl-c' || key === 'esc' || key === 'q') return;
      if (key === 'up') {
        selected = (selected - 1 + opts.length) % opts.length;
        continue;
      }
      if (key === 'down') {
        selected = (selected + 1) % opts.length;
        continue;
      }
      if (key === 'enter') {
        showCursor();
        const result = await runOption(t, selected, language);
        if (!result.keep) return;
        language = result.language;
        hideCursor();
      }
    }
  } finally {
    showCursor();
    stdout.write('\n');
  }
}
