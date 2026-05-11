import { stdout } from 'node:process';
import { saveConfig } from '../config.js';
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
  persisted: boolean;
}

export interface WelcomeOptions {
  /** Initial language to render. */
  initial?: Language;
  /** When true, hide the "Accept and don't show again" option. Used when
   * the user explicitly asks to see the welcome from the menu. */
  hideDismiss?: boolean;
}

interface I18n {
  title: string;
  intro: string[];
  capabilities: string[];
  warning: string[];
  responsibility: string;
  extensionNote: string;
  actions: { accept: string; dismiss: string; swap: string; quit: string };
  prompt: string;
  promptNoDismiss: string;
}

export const I18N_WELCOME: Record<Language, I18n> = {
  en: {
    title: 'browser-link',
    intro: [
      'An MCP server that opens a small WebSocket bridge between Claude Code',
      'and the Google Chrome tabs you explicitly grant access to through a',
      'custom companion extension you load locally.',
    ],
    capabilities: [
      'On every tab where you press "Conectar" in the extension popup, the',
      'agent can:',
      '  • Navigate that tab to any URL',
      '  • Read its DOM, console and network traffic',
      '  • Click and type into its elements',
      '  • Execute arbitrary JavaScript in the page context',
      '',
      'Tabs you do not connect remain invisible to the agent. You can connect',
      'as many tabs as you want — each one is enabled one by one, by hand.',
      '',
      'And the server remembers what it learns about each app across sessions',
      'in a local SQLite map (selectors, flows, gotchas — never uploaded',
      'anywhere).',
    ],
    warning: [
      `${ansi.bold}${ansi.yellow}⚠  Read this before you continue${ansi.reset}`,
      '',
      'Connecting a tab gives the agent access to whatever is on it — any',
      'logged-in session, saved card, wallet, banking page, work console or',
      'admin panel the browser is currently showing on that tab.',
      '',
      'Treat the agent like a junior dev given remote control of those tabs:',
      'it can buy things, submit forms, change configurations, send messages,',
      'or follow instructions it reads on the page that you did not write.',
      '',
      'Only connect tabs where you would be comfortable letting an automated',
      'process act on your behalf. Disconnect a tab from the extension popup',
      'when you are done with it.',
    ],
    responsibility:
      'You are responsible for every action the agent performs on the tabs ' +
      'you explicitly enable. The extension stays inert on any tab where ' +
      'you have not pressed "Conectar" yourself.',
    extensionNote:
      'The Chrome extension is custom and ships inside this package. ' +
      'The setup menu after this screen will tell you where it lives so ' +
      'you can load it via chrome://extensions → Load unpacked.',
    actions: {
      accept: 'I understand, continue',
      dismiss: "Accept and don't show again",
      swap: 'Switch to español',
      quit: 'Quit',
    },
    prompt: 'Press [A] to accept, [D] to accept & hide next time, [L] for español, [Q] to quit.',
    promptNoDismiss: 'Press [A] to continue, [L] for español, [Q] to quit.',
  },
  es: {
    title: 'browser-link',
    intro: [
      'Un servidor MCP que abre un puente WebSocket entre Claude Code y las',
      'pestañas de Google Chrome a las que vos le des acceso explícito a',
      'través de una extensión que cargás vos manualmente.',
    ],
    capabilities: [
      'En cada pestaña donde pulsás "Conectar" en el popup de la extensión,',
      'el agente puede:',
      '  • Navegar esa pestaña a cualquier URL',
      '  • Leer su DOM, su consola y su tráfico de red',
      '  • Hacer click y escribir en sus elementos',
      '  • Ejecutar JavaScript arbitrario en el contexto de la página',
      '',
      'Las pestañas que NO conectes siguen invisibles para el agente. Podés',
      'conectar todas las pestañas que quieras — cada una se habilita una por',
      'una, a mano.',
      '',
      'Además el servidor guarda lo que aprende de cada app entre sesiones en',
      'un mapa SQLite local (selectores, flujos, gotchas — nunca se sube a',
      'ningún lado).',
    ],
    warning: [
      `${ansi.bold}${ansi.yellow}⚠  Leelo antes de continuar${ansi.reset}`,
      '',
      'Conectar una pestaña le da al agente acceso a todo lo que esté en esa',
      'pestaña: sesiones iniciadas, tarjetas guardadas, wallets, banca,',
      'consolas de trabajo, paneles de administración… lo que el navegador',
      'esté mostrando en ella en ese momento.',
      '',
      'Tratá al agente como a un dev junior con control remoto de esas',
      'pestañas: puede comprar cosas, enviar formularios, cambiar',
      'configuraciones, mandar mensajes, o seguir instrucciones que lea en',
      'la página y que vos no escribiste.',
      '',
      'Solo conectá pestañas donde estarías cómodo dejando que un proceso',
      'automatizado actúe en tu nombre. Desconectá la pestaña desde el popup',
      'cuando termines de usarla.',
    ],
    responsibility:
      'Sos responsable de cada acción que el agente haga en las pestañas que ' +
      'habilitás explícitamente. La extensión se mantiene inerte en cualquier ' +
      'pestaña donde no hayas apretado "Conectar" vos mismo.',
    extensionNote:
      'La extensión de Chrome es custom y viene incluida en este paquete. ' +
      'El menú que aparece después de esta pantalla te dice exactamente dónde ' +
      'está para que la cargues vía chrome://extensions → Cargar sin empaquetar.',
    actions: {
      accept: 'Entendido, continuar',
      dismiss: 'Aceptar y no volver a mostrar',
      swap: 'Cambiar a English',
      quit: 'Salir',
    },
    prompt: 'Pulsá [A] para aceptar, [D] para aceptar y ocultar la próxima vez, [L] para English, [Q] para salir.',
    promptNoDismiss: 'Pulsá [A] para continuar, [L] para English, [Q] para salir.',
  },
};

export function buildWelcomeScreen(t: I18n, hideDismiss: boolean): string {
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

  const acceptLine = `  ${ansi.green}[A]${ansi.reset} ${t.actions.accept}`;
  const dismissLine = hideDismiss
    ? ''
    : `  ${ansi.green}[D]${ansi.reset} ${t.actions.dismiss}`;
  const langLine = `  ${ansi.cyan}[L]${ansi.reset} ${t.actions.swap}`;
  const quitLine = `  ${ansi.red}[Q]${ansi.reset} ${t.actions.quit}`;

  if (hideDismiss) {
    lines.push(`${acceptLine}     ${langLine}     ${quitLine}`);
  } else {
    lines.push(acceptLine);
    lines.push(dismissLine);
    lines.push(`${langLine}     ${quitLine}`);
  }
  return renderBox(lines, { borderColor: ansi.gray });
}

export async function runWelcome(opts: WelcomeOptions = {}): Promise<WelcomeResult> {
  let lang: Language = opts.initial ?? 'en';
  const hideDismiss = opts.hideDismiss === true;
  hideCursor();
  try {
    while (true) {
      const t = I18N_WELCOME[lang];
      clearScreen();
      stdout.write(buildWelcomeScreen(t, hideDismiss));
      stdout.write('\n\n');
      stdout.write(`${ansi.dim}${hideDismiss ? t.promptNoDismiss : t.prompt}${ansi.reset} `);

      const key = classifyKey(await readKey());

      if (key === 'a') return { action: 'continue', language: lang, persisted: false };
      if (key === 'd' && !hideDismiss) {
        saveConfig({ skipWelcome: true, language: lang });
        return { action: 'continue', language: lang, persisted: true };
      }
      if (key === 'l') {
        lang = lang === 'en' ? 'es' : 'en';
        continue;
      }
      if (key === 'q' || key === 'esc' || key === 'ctrl-c') {
        return { action: 'quit', language: lang, persisted: false };
      }
      // ignore other keys
    }
  } finally {
    showCursor();
    stdout.write('\n');
  }
}
