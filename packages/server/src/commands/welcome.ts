/* Welcome screen strings (English / Spanish) shared by the interactive Ink
 * Welcome view and any future non-interactive caller. No runtime logic here
 * — every screen consumes this as a pure data module. */

export type Language = 'en' | 'es';

export interface WelcomeResult {
  action: 'continue' | 'quit';
  language: Language;
  /** True when the user opted "Accept and don't show again" — the App
   * persists `skipWelcome: true` in config when this is set. */
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
  aboutTitle: string;
  about: string;
  capabilitiesTitle: string;
  capabilities: string;
  warningTitle: string;
  warning: string;
  responsibility: string;
  extensionNote: string;
  prompt: string;
  options: { accept: string; dismiss: string; swap: string; quit: string };
}

export const I18N_WELCOME: Record<Language, I18n> = {
  en: {
    title: 'browser-link',
    aboutTitle: 'What this is',
    about: [
      'An MCP server that opens a small WebSocket bridge between an MCP',
      'client (Claude Code, OpenCode, GitHub Copilot CLI…) and the Google',
      'Chrome tabs you explicitly grant access to through a custom companion',
      'extension you load locally.',
    ].join('\n'),
    capabilitiesTitle: 'What the agent can do on a connected tab',
    capabilities: [
      '• Navigate that tab to any URL',
      '• Read its DOM, console and network traffic',
      '• Click and type into its elements',
      '• Execute arbitrary JavaScript in the page context',
      '',
      'Tabs you do not connect remain invisible to the agent. Each one is',
      'enabled one by one, by hand. The server also remembers what it learns',
      'about each app across sessions in a local SQLite map (selectors,',
      'flows, gotchas — never uploaded anywhere).',
    ].join('\n'),
    warningTitle: 'Read this before you continue',
    warning: [
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
    ].join('\n'),
    responsibility:
      'You are responsible for every action the agent performs on the tabs you explicitly enable. The extension stays inert on any tab where you have not pressed "Conectar" yourself.',
    extensionNote:
      'The Chrome extension is custom and ships inside this package. The setup menu after this screen will tell you where it lives so you can load it via chrome://extensions → Load unpacked.',
    prompt: 'How do you want to proceed?',
    options: {
      accept: 'I understand, continue',
      dismiss: "Accept and don't show again",
      swap: 'Switch to español',
      quit: 'Quit',
    },
  },
  es: {
    title: 'browser-link',
    aboutTitle: 'Qué es esto',
    about: [
      'Un servidor MCP que abre un puente WebSocket entre un cliente MCP',
      '(Claude Code, OpenCode, GitHub Copilot CLI…) y las pestañas de Google',
      'Chrome a las que vos le des acceso explícito a través de una extensión',
      'que cargás vos manualmente.',
    ].join('\n'),
    capabilitiesTitle: 'Qué puede hacer el agente en una pestaña conectada',
    capabilities: [
      '• Navegar esa pestaña a cualquier URL',
      '• Leer su DOM, su consola y su tráfico de red',
      '• Hacer click y escribir en sus elementos',
      '• Ejecutar JavaScript arbitrario en el contexto de la página',
      '',
      'Las pestañas que NO conectes siguen invisibles para el agente. Cada',
      'una se habilita una por una, a mano. El servidor además guarda lo que',
      'aprende de cada app entre sesiones en un mapa SQLite local (selectores,',
      'flujos, gotchas — nunca se sube a ningún lado).',
    ].join('\n'),
    warningTitle: 'Leelo antes de continuar',
    warning: [
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
    ].join('\n'),
    responsibility:
      'Sos responsable de cada acción que el agente haga en las pestañas que habilitás explícitamente. La extensión se mantiene inerte en cualquier pestaña donde no hayas apretado "Conectar" vos mismo.',
    extensionNote:
      'La extensión de Chrome es custom y viene incluida en este paquete. El menú que aparece después de esta pantalla te dice exactamente dónde está para que la cargues vía chrome://extensions → Cargar sin empaquetar.',
    prompt: '¿Cómo querés seguir?',
    options: {
      accept: 'Entendido, continuar',
      dismiss: 'Aceptar y no volver a mostrar',
      swap: 'Cambiar a English',
      quit: 'Salir',
    },
  },
};
