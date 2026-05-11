import { stdout } from 'node:process';
import { claudeInstaller } from '../installers/claude.js';
import { installFor } from './install.js';
import { formatDoctor, runDoctor } from './doctor.js';
import { printExtensionInstructions } from './extension.js';
import type { Language } from './welcome.js';
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
  options: { register: string; extension: string; doctor: string; quit: string };
  statusRegistered: string;
  statusNotRegistered: string;
  statusClientMissing: string;
  registerSuccessHint: string;
}

const I18N: Record<Language, MenuI18n> = {
  en: {
    title: 'browser-link — setup',
    prompt: '↑/↓ to move, Enter to select, q to quit',
    pressEnter: 'Press Enter to return to the menu…',
    options: {
      register: 'Register browser-link in Claude Code',
      extension: 'Show Chrome extension install steps',
      doctor: 'Run doctor (diagnose current setup)',
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
      quit: 'Salir',
    },
    statusRegistered: 'ya registrado',
    statusNotRegistered: 'no registrado',
    statusClientMissing: 'config de Claude no encontrada',
    registerSuccessHint: 'Reiniciá Claude Code para que tome el nuevo MCP.',
  },
};

function claudeStatus(t: MenuI18n): string {
  const d = claudeInstaller.detect();
  if (!d.installed) return t.statusClientMissing;
  return d.registered ? t.statusRegistered : t.statusNotRegistered;
}

function renderMenu(t: MenuI18n, selectedIndex: number, options: string[]): string {
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

async function runOption(t: MenuI18n, index: number): Promise<boolean> {
  // returns true to keep looping, false to exit
  switch (index) {
    case 0: {
      clearScreen();
      const report = installFor('claude');
      const mark = report.installedClient ? `${ansi.green}✓${ansi.reset}` : `${ansi.gray}·${ansi.reset}`;
      console.log(`${mark} ${ansi.bold}${report.displayName}${ansi.reset}: ${report.message}`);
      if (report.installedClient) console.log(`  ${ansi.cyan}→${ansi.reset} ${t.registerSuccessHint}`);
      await pressEnter(t);
      return true;
    }
    case 1: {
      clearScreen();
      printExtensionInstructions();
      await pressEnter(t);
      return true;
    }
    case 2: {
      clearScreen();
      const r = await runDoctor();
      console.log(formatDoctor(r));
      await pressEnter(t);
      return true;
    }
    case 3:
      return false;
    default:
      return true;
  }
}

export async function runMenu(language: Language = 'en'): Promise<void> {
  const t = I18N[language];
  let selected = 0;

  hideCursor();
  try {
    while (true) {
      const opts = [
        `${t.options.register}   ${ansi.dim}(${claudeStatus(t)})${ansi.reset}`,
        t.options.extension,
        t.options.doctor,
        t.options.quit,
      ];
      clearScreen();
      stdout.write(renderMenu(t, selected, opts));
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
        const keepGoing = await runOption(t, selected);
        if (!keepGoing) return;
        hideCursor();
      }
      // ignore other keys
    }
  } finally {
    showCursor();
    stdout.write('\n');
  }
}
