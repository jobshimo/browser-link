import type { Language } from '../commands/welcome.js';
import type { InstructionsState } from '../agent-instructions/index.js';
import type { AdminUiStrings } from '../messages.js';

/**
 * Every string the admin descriptor and actions send, for `en` and `es`.
 * The server localises here so the popup renders the state dumbly; the
 * console keeps its own per-screen tables for everything else.
 */
export interface AdminI18n {
  ui: Omit<AdminUiStrings, 'language'>;
  sections: { status: string; setup: string; diagnose: string; reference: string };
  on: string;
  off: string;
  unknown: string;
  // status
  server: string;
  serverRunning: (version: string) => string;
  serverNotRunning: string;
  serverNotRunningHint: string;
  installed: string;
  installedOutdated: (installed: string) => string;
  pid: string;
  uptime: string;
  tabs: string;
  tabsUnknownHint: string;
  ports: string;
  multiAgentStatus: string;
  extension: string;
  extensionAligned: (version: string) => string;
  extensionMismatch: (ext: string, server: string) => string;
  extensionNotConnected: string;
  instructionsFor: (client: string) => string;
  instructionsState: (state: InstructionsState) => string;
  cdpDirect: string;
  cdpDirectGranted: (minutes: number | null) => string;
  cdpDirectNoGrant: string;
  update: string;
  updateAvailable: (latest: string) => string;
  upToDate: string;
  activity: string;
  // setup
  language: string;
  tool: (name: string) => string;
  multiAgent: string;
  autoReelect: string;
  instructionsAutoRefresh: string;
  cdpDirectEnabled: string;
  cdpDirectPort: string;
  cdpDirectGrantTtl: string;
  minutes: (n: number) => string;
  never: string;
  activityEnabled: string;
  activityRecordPayloads: string;
  downloadsDir: string;
  idleTtl: string;
  idleTtlHint: string;
  flowRecording: string;
  flowRecordingHint: string;
  popupDefault: string;
  // diagnose
  doctor: string;
  updatesCheck: string;
  instructionsInstall: (client: string) => string;
  instructionsUninstall: (client: string) => string;
  register: (client: string) => string;
  registered: string;
  notRegistered: string;
  stop: string;
  stopDescription: string;
  selfUpdate: string;
  selfUpdateDescription: string;
  // reference
  about: string;
  aboutText: string;
  repo: string;
  extensionPath: string;
  extensionNotFound: string;
  // actions
  unknownAction: (id: string) => string;
  notAnAction: (id: string) => string;
  invalidValue: (id: string) => string;
  previewToolOn: (name: string) => string;
  previewToolOff: (name: string) => string;
  previewToggle: (label: string, on: boolean) => string;
  previewSelect: (label: string, option: string) => string;
  previewInstall: (client: string) => string;
  previewUninstall: (client: string) => string;
  previewRegister: (client: string) => string;
}

const v = (version: string | null): string => (version === null ? 'unversioned' : `v${version}`);

export const ADMIN_I18N: Record<Language, AdminI18n> = {
  en: {
    ui: {
      confirm: 'Confirm',
      cancel: 'Cancel',
      apply: 'Apply',
      notConnected: 'Connect a tab to manage browser-link from here.',
      restartRequired: 'Restart your MCP client for this change to take effect.',
      changed: 'Saved.',
    },
    sections: { status: 'Status', setup: 'Setup', diagnose: 'Diagnose', reference: 'Reference' },
    on: 'on',
    off: 'off',
    unknown: 'unknown',
    server: 'Server',
    serverRunning: (version) => `running v${version}`,
    serverNotRunning: 'not running',
    serverNotRunningHint: 'Your MCP client starts it; open a session that uses browser-link.',
    installed: 'Installed version',
    installedOutdated: (installed) => `${installed} (outdated: restart needed)`,
    pid: 'PID',
    uptime: 'Uptime',
    tabs: 'Tabs connected',
    tabsUnknownHint: 'Only the running server knows; open the extension popup.',
    ports: 'Ports',
    multiAgentStatus: 'Multi-agent',
    extension: 'Extension',
    extensionAligned: (version) => `v${version} (aligned)`,
    extensionMismatch: (ext, server) => `v${ext} (server v${server}: reload or update one)`,
    extensionNotConnected: 'no tab connected',
    instructionsFor: (client) => `Instructions — ${client}`,
    instructionsState: (state) => {
      switch (state.kind) {
        case 'installed':
          return `installed ${v(state.version)}`;
        case 'installed-outdated':
          return `outdated ${v(state.version)}`;
        case 'not-installed':
          return 'not installed';
        case 'no-file':
          return 'no instructions file';
        case 'corrupt':
          return 'corrupt (fix it by hand)';
      }
    },
    cdpDirect: 'cdp-direct',
    cdpDirectGranted: (minutes) =>
      minutes === null ? 'on, granted (no expiry)' : `on, granted (${minutes} min left)`,
    cdpDirectNoGrant: 'on, no active grant (browser-link cdp allow)',
    update: 'Updates',
    updateAvailable: (latest) => `v${latest} available`,
    upToDate: 'up to date',
    activity: 'Activity trail',
    language: 'Language',
    tool: (name) => `Tool ${name}`,
    multiAgent: 'Multi-agent mode',
    autoReelect: 'Auto-reelect on primary close',
    instructionsAutoRefresh: 'Refresh the instructions block at server start',
    cdpDirectEnabled: 'cdp-direct enabled',
    cdpDirectPort: 'cdp-direct port',
    cdpDirectGrantTtl: 'cdp-direct grant lifetime',
    minutes: (n) => `${n} min`,
    never: 'never expires',
    activityEnabled: 'Record the activity trail',
    activityRecordPayloads: 'Record tool payloads in the trail',
    downloadsDir: 'Downloads folder',
    idleTtl: 'Idle disconnect',
    idleTtlHint:
      "Change it in the popup's Idle disconnect control or with browser-link config set idle-ttl",
    flowRecording: 'Flow recording',
    flowRecordingHint:
      "Change it in the popup's flow recording control or with browser-link config set flow-recording",
    popupDefault: 'popup choice',
    doctor: 'Run doctor',
    updatesCheck: 'Check for updates',
    instructionsInstall: (client) => `Install instructions block — ${client}`,
    instructionsUninstall: (client) => `Remove instructions block — ${client}`,
    register: (client) => `Register with ${client}`,
    registered: 'registered',
    notRegistered: 'not registered',
    stop: 'Stop the server / free the port',
    stopDescription: 'Ends the running server, so it is only available from a terminal.',
    selfUpdate: 'Update browser-link',
    selfUpdateDescription: 'Replaces the running server, so it is only available from a terminal.',
    about: 'About',
    aboutText:
      'browser-link is an MCP server that lets agents observe and act on the Chrome tabs you connect.',
    repo: 'GitHub repository',
    extensionPath: 'Extension folder',
    extensionNotFound: 'not found next to the server',
    unknownAction: (id) => `Unknown admin action: ${id}`,
    notAnAction: (id) => `${id} is read-only`,
    invalidValue: (id) => `Invalid value for ${id}`,
    previewToolOn: (name) => `Enable tool ${name} for every agent`,
    previewToolOff: (name) => `Disable tool ${name} for every agent`,
    previewToggle: (label, on) => `Turn ${on ? 'on' : 'off'}: ${label}`,
    previewSelect: (label, option) => `Set ${label} to ${option}`,
    previewInstall: (client) => `Write the browser-link instructions block into ${client}'s file`,
    previewUninstall: (client) =>
      `Remove the browser-link instructions block from ${client}'s file`,
    previewRegister: (client) => `Register browser-link in ${client}'s MCP config`,
  },
  es: {
    ui: {
      confirm: 'Confirmar',
      cancel: 'Cancelar',
      apply: 'Aplicar',
      notConnected: 'Conectá una pestaña para administrar browser-link desde acá.',
      restartRequired: 'Reiniciá tu cliente MCP para que el cambio tenga efecto.',
      changed: 'Guardado.',
    },
    sections: {
      status: 'Estado',
      setup: 'Configuración',
      diagnose: 'Diagnóstico',
      reference: 'Referencia',
    },
    on: 'activado',
    off: 'desactivado',
    unknown: 'desconocido',
    server: 'Servidor',
    serverRunning: (version) => `en marcha v${version}`,
    serverNotRunning: 'detenido',
    serverNotRunningHint: 'Lo arranca tu cliente MCP; abrí una sesión que use browser-link.',
    installed: 'Versión instalada',
    installedOutdated: (installed) => `${installed} (desactualizado: hace falta reiniciar)`,
    pid: 'PID',
    uptime: 'Tiempo en marcha',
    tabs: 'Pestañas conectadas',
    tabsUnknownHint: 'Solo lo sabe el servidor en marcha; abrí el popup de la extensión.',
    ports: 'Puertos',
    multiAgentStatus: 'Multi-agente',
    extension: 'Extensión',
    extensionAligned: (version) => `v${version} (alineada)`,
    extensionMismatch: (ext, server) =>
      `v${ext} (servidor v${server}: recargá o actualizá uno de los dos)`,
    extensionNotConnected: 'ninguna pestaña conectada',
    instructionsFor: (client) => `Instrucciones — ${client}`,
    instructionsState: (state) => {
      switch (state.kind) {
        case 'installed':
          return `instalado ${state.version === null ? 'sin versión' : `v${state.version}`}`;
        case 'installed-outdated':
          return `desactualizado ${state.version === null ? 'sin versión' : `v${state.version}`}`;
        case 'not-installed':
          return 'no instalado';
        case 'no-file':
          return 'sin archivo de instrucciones';
        case 'corrupt':
          return 'corrupto (arreglalo a mano)';
      }
    },
    cdpDirect: 'cdp-direct',
    cdpDirectGranted: (minutes) =>
      minutes === null
        ? 'activado, con permiso (sin vencimiento)'
        : `activado, con permiso (quedan ${minutes} min)`,
    cdpDirectNoGrant: 'activado, sin permiso vigente (browser-link cdp allow)',
    update: 'Actualizaciones',
    updateAvailable: (latest) => `v${latest} disponible`,
    upToDate: 'al día',
    activity: 'Registro de actividad',
    language: 'Idioma',
    tool: (name) => `Tool ${name}`,
    multiAgent: 'Modo multi-agente',
    autoReelect: 'Re-elección automática al cerrar el primary',
    instructionsAutoRefresh: 'Refrescar el bloque de instrucciones al arrancar el servidor',
    cdpDirectEnabled: 'cdp-direct activado',
    cdpDirectPort: 'Puerto de cdp-direct',
    cdpDirectGrantTtl: 'Duración del permiso de cdp-direct',
    minutes: (n) => `${n} min`,
    never: 'no vence',
    activityEnabled: 'Guardar el registro de actividad',
    activityRecordPayloads: 'Guardar los payloads de las tools en el registro',
    downloadsDir: 'Carpeta de descargas',
    idleTtl: 'Desconexión por inactividad',
    idleTtlHint:
      'Se cambia desde el popup (Desconexión por inactividad) o con browser-link config set idle-ttl',
    flowRecording: 'Grabación de flows',
    flowRecordingHint:
      'Se cambia desde el popup (grabación de flows) o con browser-link config set flow-recording',
    popupDefault: 'lo elegido en el popup',
    doctor: 'Ejecutar doctor',
    updatesCheck: 'Buscar actualizaciones',
    instructionsInstall: (client) => `Instalar el bloque de instrucciones — ${client}`,
    instructionsUninstall: (client) => `Quitar el bloque de instrucciones — ${client}`,
    register: (client) => `Registrar en ${client}`,
    registered: 'registrado',
    notRegistered: 'sin registrar',
    stop: 'Detener el servidor / liberar el puerto',
    stopDescription: 'Termina el servidor en marcha, por eso solo se hace desde una terminal.',
    selfUpdate: 'Actualizar browser-link',
    selfUpdateDescription:
      'Reemplaza el servidor en marcha, por eso solo se hace desde una terminal.',
    about: 'Acerca de',
    aboutText:
      'browser-link es un servidor MCP que deja a los agentes ver y actuar sobre las pestañas de Chrome que conectás.',
    repo: 'Repositorio en GitHub',
    extensionPath: 'Carpeta de la extensión',
    extensionNotFound: 'no se encontró junto al servidor',
    unknownAction: (id) => `Acción de administración desconocida: ${id}`,
    notAnAction: (id) => `${id} es de solo lectura`,
    invalidValue: (id) => `Valor inválido para ${id}`,
    previewToolOn: (name) => `Habilitar la tool ${name} para todos los agentes`,
    previewToolOff: (name) => `Deshabilitar la tool ${name} para todos los agentes`,
    previewToggle: (label, on) => `${on ? 'Activar' : 'Desactivar'}: ${label}`,
    previewSelect: (label, option) => `Cambiar ${label} a ${option}`,
    previewInstall: (client) =>
      `Escribir el bloque de instrucciones de browser-link en el archivo de ${client}`,
    previewUninstall: (client) =>
      `Quitar el bloque de instrucciones de browser-link del archivo de ${client}`,
    previewRegister: (client) => `Registrar browser-link en la configuración MCP de ${client}`,
  },
};
