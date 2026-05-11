import { stdout } from 'node:process';
import {
  ansi,
  classifyKey,
  clearScreen,
  hideCursor,
  readKey,
  renderBox,
  showCursor,
} from './tty.js';

export type Language = 'en' | 'es';

export interface WelcomeResult {
  action: 'continue' | 'quit';
  language: Language;
}

interface I18n {
  title: string;
  intro: string[];
  capabilities: string[];
  warning: string[];
  responsibility: string;
  extensionNote: string;
  actions: { accept: string; swap: string; quit: string };
  prompt: string;
}

const I18N: Record<Language, I18n> = {
  en: {
    title: 'browser-link',
    intro: [
      'An MCP server that opens a small WebSocket bridge between your AI agent',
      '(Claude Code, OpenCode, …) and a single tab in Google Chrome, gated by',
      'a custom companion extension you load locally.',
    ],
    capabilities: [
      'Once you connect a tab from the extension popup, the agent can:',
      '  • Navigate the tab to any URL',
      '  • Read its DOM, console and network traffic',
      '  • Click and type into elements',
      '  • Execute arbitrary JavaScript in the page context',
      '',
      'And it remembers what it learns about each app across sessions in a',
      'local SQLite map (selectors, flows, gotchas — never uploaded anywhere).',
    ],
    warning: [
      `${ansi.bold}${ansi.yellow}⚠  Read this before you continue${ansi.reset}`,
      '',
      'Connecting a tab gives the agent access to whatever is on that tab —',
      'including any logged-in session, saved card, wallet, banking page, work',
      'console or admin panel the browser is currently showing.',
      '',
      'Treat the agent like a junior dev given remote control of your browser:',
      'it can buy things, submit forms, change configurations, send messages,',
      'or follow instructions it reads on the page that you did not write.',
      '',
      'Do NOT connect tabs where you would not be comfortable letting an',
      'automated process act on your behalf.',
    ],
    responsibility:
      'You are responsible for every action the agent performs on the tabs ' +
      'you explicitly connect via the extension popup. The extension only ' +
      'becomes active on tabs where you press "Conectar" manually.',
    extensionNote:
      'The Chrome extension is custom and ships inside this package. ' +
      'The setup menu after this screen will tell you where it lives so ' +
      'you can load it via chrome://extensions → Load unpacked.',
    actions: { accept: 'I understand, continue', swap: 'Switch to español', quit: 'Quit' },
    prompt: 'Press [A] to accept, [L] for español, [Q] to quit.',
  },
  es: {
    title: 'browser-link',
    intro: [
      'Un servidor MCP que abre un puente WebSocket entre tu agente de IA',
      '(Claude Code, OpenCode, …) y una única pestaña de Google Chrome, con',
      'control de acceso a través de una extensión que cargás vos manualmente.',
    ],
    capabilities: [
      'Cuando conectás una pestaña desde el popup de la extensión, el agente',
      'puede:',
      '  • Navegar la pestaña a cualquier URL',
      '  • Leer el DOM, la consola y el tráfico de red',
      '  • Hacer click y escribir en elementos',
      '  • Ejecutar JavaScript arbitrario en el contexto de la página',
      '',
      'Además guarda lo que aprende de cada app entre sesiones en un mapa',
      'SQLite local (selectores, flujos, gotchas — nunca se sube a ningún lado).',
    ],
    warning: [
      `${ansi.bold}${ansi.yellow}⚠  Leelo antes de continuar${ansi.reset}`,
      '',
      'Conectar una pestaña le da al agente acceso a todo lo que está en esa',
      'pestaña: sesiones iniciadas, tarjetas guardadas, wallets, banca,',
      'consolas de trabajo, paneles de administración… lo que el navegador',
      'esté mostrando ahí en ese momento.',
      '',
      'Tratá al agente como a un dev junior con control remoto de tu navegador:',
      'puede comprar cosas, enviar formularios, cambiar configuraciones, mandar',
      'mensajes, o seguir instrucciones que lea en la página y que vos no',
      'escribiste.',
      '',
      'NO conectes pestañas donde no estarías cómodo dejando que un proceso',
      'automatizado actúe en tu nombre.',
    ],
    responsibility:
      'Sos responsable de cada acción que el agente haga en las pestañas que ' +
      'conectes explícitamente a través del popup de la extensión. La ' +
      'extensión solo se activa en pestañas donde apretás "Conectar" a mano.',
    extensionNote:
      'La extensión de Chrome es custom y viene incluida en este paquete. ' +
      'El menú que aparece después de esta pantalla te dice exactamente dónde ' +
      'está para que la cargues vía chrome://extensions → Cargar sin empaquetar.',
    actions: { accept: 'Entendido, continuar', swap: 'Cambiar a English', quit: 'Salir' },
    prompt: 'Pulsá [A] para aceptar, [L] para English, [Q] para salir.',
  },
};

function buildScreen(t: I18n): string {
  const lines: string[] = [];
  lines.push(`${ansi.bold}${ansi.cyan}${t.title}${ansi.reset}`);
  lines.push('');
  for (const l of t.intro) lines.push(l);
  lines.push('');
  for (const l of t.capabilities) lines.push(l);
  lines.push('');
  for (const l of t.warning) lines.push(l);
  lines.push('');
  lines.push(`${ansi.dim}${t.responsibility}${ansi.reset}`);
  lines.push('');
  lines.push(`${ansi.dim}${t.extensionNote}${ansi.reset}`);
  lines.push('');
  lines.push(
    `  ${ansi.green}[A]${ansi.reset} ${t.actions.accept}     ` +
      `${ansi.cyan}[L]${ansi.reset} ${t.actions.swap}     ` +
      `${ansi.red}[Q]${ansi.reset} ${t.actions.quit}`,
  );
  return renderBox(lines, { borderColor: ansi.gray });
}

export async function runWelcome(initial: Language = 'en'): Promise<WelcomeResult> {
  let lang: Language = initial;
  hideCursor();
  try {
    while (true) {
      clearScreen();
      stdout.write(buildScreen(I18N[lang]));
      stdout.write('\n\n');
      stdout.write(`${ansi.dim}${I18N[lang].prompt}${ansi.reset} `);

      const raw = await readKey();
      const key = classifyKey(raw);

      if (key === 'a') return { action: 'continue', language: lang };
      if (key === 'l') {
        lang = lang === 'en' ? 'es' : 'en';
        continue;
      }
      if (key === 'q' || key === 'esc' || key === 'ctrl-c') {
        return { action: 'quit', language: lang };
      }
      // ignore anything else and re-render
    }
  } finally {
    showCursor();
    stdout.write('\n');
  }
}
