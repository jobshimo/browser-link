import type { Language } from './welcome.js';

export interface AboutI18n {
  title: string;
  whatTitle: string;
  what: string;
  howTitle: string;
  how: string;
  bindingTitle: string;
  binding: string;
  bridgeToolsTitle: string;
  bridgeTools: string;
  mapToolsTitle: string;
  mapTools: string;
  privacyTitle: string;
  privacy: string;
  helpTitle: string;
  help: string;
}

export const I18N_ABOUT: Record<Language, AboutI18n> = {
  en: {
    title: 'browser-link — about',
    whatTitle: 'What is this?',
    what: [
      'browser-link is an MCP (Model Context Protocol) server. It lets an',
      'MCP client (Claude Code, OpenCode, …) observe and act on the Google',
      'Chrome tabs you explicitly enable through a companion extension.',
      '',
      'It is split in two pieces:',
      '  1) This Node binary, the MCP server the client spawns over stdio.',
      '  2) A small Chrome extension that you load manually. The extension',
      '     stays inert on every tab until you press "Conectar" on it. You',
      '     can enable as many tabs as you want, one by one. Tabs you do not',
      '     connect remain invisible to the agent.',
    ].join('\n'),
    howTitle: 'How does it work?',
    how: [
      'The Node binary listens on 127.0.0.1:17529 (loopback only — never on',
      'a public interface). Each tab where you press "Conectar" opens its',
      'own WebSocket to that port and registers a tab_id. From that moment',
      'on, the agent can call tools targeting that tab_id, and the server',
      'forwards each request to the extension over the WebSocket.',
    ].join('\n'),
    bindingTitle: 'Process binding (zero-config defense)',
    binding: [
      'Before accepting any WebSocket handshake, the server asks the OS',
      'kernel which process opened the incoming TCP connection. Connections',
      'whose owner is not a known Chromium-based browser binary (Chrome,',
      'Edge, Brave, Vivaldi, Chromium) are rejected before any application',
      'bytes are exchanged. This closes the "any local process can talk to',
      'the bridge" vector without asking you to copy or paste tokens.',
      '',
      'It does NOT defend against malware that has already injected itself',
      'inside Chrome. That attacker already controls the browser directly',
      'and the bridge adds no surface they did not already have.',
    ].join('\n'),
    bridgeToolsTitle: 'Tools the agent gets over the bridge',
    bridgeTools: [
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
    ].join('\n'),
    mapToolsTitle: 'Persistent UI map (private, on your machine)',
    mapTools: [
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
    ].join('\n'),
    privacyTitle: 'Where your data lives',
    privacy: [
      '• The UI map is at:',
      '    Linux    $XDG_DATA_HOME/browser-link/map.db',
      '    macOS    ~/Library/Application Support/browser-link/map.db',
      '    Windows  %APPDATA%/browser-link/map.db',
      '  Override with BROWSER_LINK_DATA_DIR.',
      '• Nothing is uploaded anywhere by this package. The bridge only',
      '  talks loopback to your local Chrome extension.',
      '• What you save in the map is your responsibility. Never save',
      '  domain data (IDs, names, dates) — the map is for UI structure.',
    ].join('\n'),
    helpTitle: 'Get help / report issues',
    help: [
      '  GitHub  https://github.com/jobshimo/browser-link',
      '  Issues  https://github.com/jobshimo/browser-link/issues',
      '',
      'Useful subcommands:',
      '  browser-link doctor      diagnose what is and is not set up',
      '  browser-link extension   show where the Chrome extension assets are',
      '  browser-link install     register browser-link in your MCP client',
      '  browser-link about       show this page',
      '  browser-link help        list every subcommand',
    ].join('\n'),
  },
  es: {
    title: 'browser-link — información',
    whatTitle: '¿Qué es esto?',
    what: [
      'browser-link es un servidor MCP (Model Context Protocol). Permite',
      'que un cliente MCP (Claude Code, OpenCode, …) observe y actúe sobre',
      'las pestañas de Google Chrome a las que vos le des acceso explícito',
      'mediante una extensión que acompaña al paquete.',
      '',
      'Tiene dos piezas:',
      '  1) Este binario de Node, el servidor MCP que el cliente arranca',
      '     por stdio.',
      '  2) Una pequeña extensión de Chrome que cargás vos a mano. La',
      '     extensión queda inerte en cada pestaña hasta que pulsás',
      '     "Conectar" sobre ella. Podés habilitar todas las pestañas que',
      '     quieras, una por una. Las pestañas que no conectes siguen',
      '     invisibles al agente.',
    ].join('\n'),
    howTitle: '¿Cómo funciona?',
    how: [
      'El binario de Node escucha en 127.0.0.1:17529 (solo loopback — nunca',
      'en una interfaz pública). Cada pestaña donde pulsás "Conectar" abre',
      'su propio WebSocket contra ese puerto y se registra con un tab_id.',
      'Desde ahí, el agente puede llamar herramientas que apuntan a ese',
      'tab_id y el servidor reenvía cada petición a la extensión.',
    ].join('\n'),
    bindingTitle: 'Validación por proceso (sin configuración)',
    binding: [
      'Antes de aceptar cualquier handshake WebSocket, el servidor le',
      'pregunta al kernel del SO qué proceso abrió la conexión TCP entrante.',
      'Conexiones cuyo dueño no es un binario conocido de un navegador',
      'Chromium-based (Chrome, Edge, Brave, Vivaldi, Chromium) se rechazan',
      'antes de intercambiar bytes de aplicación. Eso cierra el vector',
      '"cualquier proceso local puede hablar con el puente" sin pedirte',
      'copiar tokens.',
      '',
      'NO te protege contra malware que ya se inyectó dentro de Chrome.',
      'Ese atacante ya controla el navegador directamente y el puente no',
      'le suma superficie nueva.',
    ].join('\n'),
    bridgeToolsTitle: 'Herramientas que el agente expone vía el puente',
    bridgeTools: [
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
    ].join('\n'),
    mapToolsTitle: 'Mapa de UI persistente (privado, en tu máquina)',
    mapTools: [
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
    ].join('\n'),
    privacyTitle: 'Dónde vive tu información',
    privacy: [
      '• El mapa de UI está en:',
      '    Linux    $XDG_DATA_HOME/browser-link/map.db',
      '    macOS    ~/Library/Application Support/browser-link/map.db',
      '    Windows  %APPDATA%/browser-link/map.db',
      '  Sobreescribilo con BROWSER_LINK_DATA_DIR.',
      '• Este paquete no sube nada a ningún lado. El puente solo habla',
      '  loopback con la extensión local de Chrome.',
      '• Lo que guardes en el mapa es responsabilidad tuya. No guardes',
      '  datos de dominio (IDs, nombres, fechas) — el mapa es para',
      '  estructura de UI, no para data.',
    ].join('\n'),
    helpTitle: 'Ayuda / reportar bugs',
    help: [
      '  GitHub  https://github.com/jobshimo/browser-link',
      '  Issues  https://github.com/jobshimo/browser-link/issues',
      '',
      'Subcomandos útiles:',
      '  browser-link doctor      diagnóstico de qué está y qué falta',
      '  browser-link extension   ver dónde están los assets de la extensión',
      '  browser-link install     registrar browser-link en tu cliente MCP',
      '  browser-link about       mostrar esta página',
      '  browser-link help        listar todos los subcomandos',
    ].join('\n'),
  },
};

/** Non-interactive about — `browser-link about`. Plain output, no prompts.
 * The interactive version lives in the Ink UI (`ui/screens.tsx`). */
export function printAbout(language: Language = 'en'): void {
  const t = I18N_ABOUT[language];
  const sections: { title: string; body: string }[] = [
    { title: t.whatTitle, body: t.what },
    { title: t.howTitle, body: t.how },
    { title: t.bindingTitle, body: t.binding },
    { title: t.bridgeToolsTitle, body: t.bridgeTools },
    { title: t.mapToolsTitle, body: t.mapTools },
    { title: t.privacyTitle, body: t.privacy },
    { title: t.helpTitle, body: t.help },
  ];
  console.log(t.title);
  console.log('='.repeat(t.title.length));
  console.log('');
  for (const { title, body } of sections) {
    console.log(title);
    console.log('-'.repeat(title.length));
    console.log(body);
    console.log('');
  }
}
