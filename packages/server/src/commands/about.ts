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
import type { Language } from './welcome.js';

interface AboutI18n {
  title: string;
  whatItIs: string[];
  howItWorks: string[];
  bridgeTools: { title: string; items: string[] };
  mapTools: { title: string; items: string[] };
  privacy: string[];
  whereToGetHelp: string[];
  prompt: string;
}

export const I18N_ABOUT: Record<Language, AboutI18n> = {
  en: {
    title: 'browser-link — about',
    whatItIs: [
      `${ansi.bold}What is this?${ansi.reset}`,
      '',
      'browser-link is an MCP (Model Context Protocol) server. It lets',
      'Claude Code observe and act on the Google Chrome tabs you explicitly',
      'enable through a companion extension. It is split in two pieces:',
      '  1) This Node binary, the MCP server Claude Code spawns over stdio.',
      '  2) A small Chrome extension that you load manually. The extension',
      '     stays inert on every tab until you press "Conectar" on it. You',
      '     can enable as many tabs as you want, one by one. Tabs you do',
      '     not connect remain invisible to the agent.',
    ],
    howItWorks: [
      `${ansi.bold}How does it work?${ansi.reset}`,
      '',
      'The Node binary listens on 127.0.0.1:17529 (loopback only — never on a',
      'public interface). Each tab where you press "Conectar" opens its own',
      'WebSocket to that port and registers a tab_id. From that moment on,',
      'the agent can call tools targeting that tab_id, and the server',
      'forwards each request to the extension over the WebSocket.',
      '',
      `${ansi.bold}Process binding (zero-config defense)${ansi.reset}`,
      '',
      'Before accepting any WebSocket handshake, the server asks the OS',
      'kernel which process opened the incoming TCP connection. Connections',
      'whose owner is not a known Chromium-based browser binary (Chrome,',
      'Edge, Brave, Vivaldi, Chromium) are rejected before any application',
      'bytes are exchanged. This closes the "any local process can talk to',
      'the bridge" vector without asking you to copy or paste tokens.',
      '',
      'It does NOT defend against malware that has already injected itself',
      'inside Chrome (chrome.debugger from another extension, etc.). That',
      'attacker already controls the browser directly and the bridge adds',
      'no surface they did not already have.',
    ],
    bridgeTools: {
      title: `${ansi.bold}Tools the agent gets over the bridge${ansi.reset}`,
      items: [
        '  browser.list_tabs        list connected tabs',
        '  browser.ping             check the bridge to a tab',
        '  browser.snapshot         dump title, url, text and interactive elements',
        '  browser.navigate         change the tab URL',
        '  browser.click            click an element by CSS selector',
        '  browser.type             type into an input',
        '  browser.evaluate         run JavaScript in the page context',
        '  browser.console          recent console messages (rolling 200)',
        '  browser.network          recent network requests (rolling 200)',
        '  browser.network_body     fetch the body of a specific request',
      ],
    },
    mapTools: {
      title: `${ansi.bold}Persistent UI map (private, on your machine)${ansi.reset}`,
      items: [
        'The server keeps a small SQLite database with what the agent has',
        'learned about each app it operates: stable selectors, multi-step',
        'flows, and gotchas. Three kinds of entries (selector, flow, gotcha)',
        'indexed by app + pathname. Tools the agent uses:',
        '',
        '  browser.map.recall       what do we know about this app/route?',
        '  browser.map.save         persist a selector, flow, or gotcha',
        '  browser.map.record_use   verified / failed timestamp per entry',
        '  browser.map.forget       delete an entry or an entire app',
        '  browser.map.rename_app   fix a bad app_key from the first save',
        '  browser.map.apps         list known apps',
      ],
    },
    privacy: [
      `${ansi.bold}Where your data lives${ansi.reset}`,
      '',
      '  • The UI map is at:',
      '      Linux    $XDG_DATA_HOME/browser-link/map.db',
      '      macOS    ~/Library/Application Support/browser-link/map.db',
      '      Windows  %APPDATA%/browser-link/map.db',
      '    Override with BROWSER_LINK_DATA_DIR.',
      '  • Nothing is uploaded anywhere by this package. The bridge only',
      '    talks loopback to your local Chrome extension.',
      '  • What you save in the map is your responsibility. Never save',
      '    domain data (IDs, names, dates) — the map is for UI structure.',
    ],
    whereToGetHelp: [
      `${ansi.bold}Get help / report issues${ansi.reset}`,
      '',
      '  GitHub  https://github.com/jobshimo/browser-link',
      '  Issues  https://github.com/jobshimo/browser-link/issues',
      '',
      'Useful subcommands:',
      '  browser-link doctor      diagnose what is and is not set up',
      '  browser-link extension   show where the Chrome extension assets are',
      '  browser-link install     register browser-link in your MCP client',
      '  browser-link about       show this page',
      '  browser-link help        list every subcommand',
    ],
    prompt: 'Press any key to return.',
  },
  es: {
    title: 'browser-link — información',
    whatItIs: [
      `${ansi.bold}¿Qué es esto?${ansi.reset}`,
      '',
      'browser-link es un servidor MCP (Model Context Protocol). Permite que',
      'Claude Code observe y actúe sobre las pestañas de Google Chrome a las',
      'que vos le des acceso explícito mediante una extensión que acompaña',
      'al paquete. Tiene dos piezas:',
      '  1) Este binario de Node, el servidor MCP que Claude Code arranca',
      '     por stdio.',
      '  2) Una pequeña extensión de Chrome que cargás vos a mano. La',
      '     extensión queda inerte en cada pestaña hasta que pulsás',
      '     "Conectar" sobre ella. Podés habilitar todas las pestañas que',
      '     quieras, una por una. Las pestañas que no conectes siguen',
      '     invisibles al agente.',
    ],
    howItWorks: [
      `${ansi.bold}¿Cómo funciona?${ansi.reset}`,
      '',
      'El binario de Node escucha en 127.0.0.1:17529 (solo loopback — nunca',
      'en una interfaz pública). Cada pestaña donde pulsás "Conectar" abre',
      'su propio WebSocket contra ese puerto y se registra con un tab_id.',
      'Desde ahí, el agente puede llamar herramientas que apuntan a ese',
      'tab_id y el servidor reenvía cada petición a la extensión.',
      '',
      `${ansi.bold}Validación por proceso (sin configuración)${ansi.reset}`,
      '',
      'Antes de aceptar cualquier handshake WebSocket, el servidor le',
      'pregunta al kernel del SO qué proceso abrió la conexión TCP entrante.',
      'Conexiones cuyo dueño no es un binario conocido de un navegador',
      'Chromium-based (Chrome, Edge, Brave, Vivaldi, Chromium) se rechazan',
      'antes de intercambiar bytes de aplicación. Eso cierra el vector "cualquier',
      'proceso local puede hablar con el puente" sin pedirte copiar tokens.',
      '',
      'NO te protege contra malware que ya se inyectó dentro de Chrome',
      '(chrome.debugger desde otra extensión maliciosa, etc.). Ese atacante',
      'ya controla el navegador directamente y el puente no le suma',
      'superficie nueva.',
    ],
    bridgeTools: {
      title: `${ansi.bold}Herramientas que el agente expone vía el puente${ansi.reset}`,
      items: [
        '  browser.list_tabs        listar pestañas conectadas',
        '  browser.ping             comprobar el puente a una pestaña',
        '  browser.snapshot         volcar título, url, texto y elementos interactivos',
        '  browser.navigate         cambiar la URL de la pestaña',
        '  browser.click            hacer click en un elemento por CSS selector',
        '  browser.type             escribir en un input',
        '  browser.evaluate         ejecutar JavaScript en el contexto de la página',
        '  browser.console          mensajes recientes de consola (200 últimos)',
        '  browser.network          peticiones de red recientes (200 últimas)',
        '  browser.network_body     traer el body de una petición concreta',
      ],
    },
    mapTools: {
      title: `${ansi.bold}Mapa de UI persistente (privado, en tu máquina)${ansi.reset}`,
      items: [
        'El servidor mantiene una pequeña base SQLite con lo que el agente',
        'va aprendiendo de cada app: selectores estables, flujos de pasos y',
        'gotchas. Tres tipos de entradas (selector, flow, gotcha) indexadas',
        'por app + path. Herramientas que el agente usa:',
        '',
        '  browser.map.recall       ¿qué sabemos de esta app/ruta?',
        '  browser.map.save         guardar un selector, flujo o gotcha',
        '  browser.map.record_use   marcar verified / failed por entrada',
        '  browser.map.forget       borrar una entrada o una app entera',
        '  browser.map.rename_app   corregir un app_key mal derivado',
        '  browser.map.apps         listar apps conocidas',
      ],
    },
    privacy: [
      `${ansi.bold}Dónde vive tu información${ansi.reset}`,
      '',
      '  • El mapa de UI está en:',
      '      Linux    $XDG_DATA_HOME/browser-link/map.db',
      '      macOS    ~/Library/Application Support/browser-link/map.db',
      '      Windows  %APPDATA%/browser-link/map.db',
      '    Sobreescribilo con BROWSER_LINK_DATA_DIR.',
      '  • Este paquete no sube nada a ningún lado. El puente solo habla',
      '    loopback con la extensión local de Chrome.',
      '  • Lo que guardes en el mapa es responsabilidad tuya. No guardes',
      '    datos de dominio (IDs, nombres, fechas) — el mapa es para',
      '    estructura de UI, no para data.',
    ],
    whereToGetHelp: [
      `${ansi.bold}Ayuda / reportar bugs${ansi.reset}`,
      '',
      '  GitHub  https://github.com/jobshimo/browser-link',
      '  Issues  https://github.com/jobshimo/browser-link/issues',
      '',
      'Subcomandos útiles:',
      '  browser-link doctor      diagnóstico de qué está y qué falta',
      '  browser-link extension   ver dónde están los assets de la extensión',
      '  browser-link install     registrar browser-link en tu cliente MCP',
      '  browser-link about       mostrar esta página',
      '  browser-link help        listar todos los subcomandos',
    ],
    prompt: 'Pulsá cualquier tecla para volver.',
  },
};

export function buildAboutScreen(t: AboutI18n): string {
  const lines: string[] = [];
  lines.push(`${ansi.bold}${ansi.cyan}${t.title}${ansi.reset}`);
  lines.push('');
  for (const l of t.whatItIs) lines.push(l);
  lines.push('');
  for (const l of t.howItWorks) lines.push(l);
  lines.push('');
  lines.push(t.bridgeTools.title);
  lines.push('');
  for (const l of t.bridgeTools.items) lines.push(l);
  lines.push('');
  lines.push(t.mapTools.title);
  lines.push('');
  for (const l of t.mapTools.items) lines.push(l);
  lines.push('');
  for (const l of t.privacy) lines.push(l);
  lines.push('');
  for (const l of t.whereToGetHelp) lines.push(l);
  return renderBox(lines, { borderColor: ansi.gray });
}

export async function runAbout(language: Language = 'en'): Promise<void> {
  const t = I18N_ABOUT[language];
  hideCursor();
  try {
    clearScreen();
    stdout.write(buildAboutScreen(t));
    stdout.write('\n\n');
    stdout.write(`${ansi.dim}${t.prompt}${ansi.reset} `);
    await readKey();
  } finally {
    showCursor();
    stdout.write('\n');
  }
}

/** Plain-text render of About for non-interactive output (browser-link about). */
export function printAbout(language: Language = 'en'): void {
  const t = I18N_ABOUT[language];
  console.log(buildAboutScreen(t));
}
