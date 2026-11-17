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
  sections: { status: string; setup: string; console: string; diagnose: string; reference: string };
  /** S4: shown once at the top of the console section, says why its settings
   * are not changed from the Admin window. */
  consoleNotice: string;
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
  /** Prose around a pasteable example command carrying the current value. */
  cdpDirectPortHint: (command: string) => string;
  cdpDirectGrantTtlHint: (command: string) => string;
  minutes: (n: number) => string;
  never: string;
  activityEnabled: string;
  activityRecordPayloads: string;
  /** Owner decision D12 (setup and status readouts, console-only). */
  hidePasswordValues: string;
  passwordValuesStatus: string;
  passwordValuesHidden: string;
  passwordValuesShown: string;
  /** Owner decision D13 (setup and status readouts, console-only). */
  activityHideSensitive: string;
  activitySensitiveStatus: string;
  activitySensitiveHidden: string;
  activitySensitiveStored: string;
  downloadsDir: string;
  /** Console-only: whether browser.download may save executable types. */
  allowExecutableDownloads: string;
  executablesAllowed: string;
  executablesRefused: string;
  idleTtl: string;
  idleTtlNever: string;
  /** S3: how long a claim between agents lasts without activity. */
  claimTtl: string;
  claimTtlNever: string;
  flowRecording: string;
  flowRecordingHint: string;
  popupDefault: string;
  // diagnose
  doctor: string;
  updatesCheck: string;
  instructionsInstall: (client: string) => string;
  instructionsUninstall: (client: string) => string;
  registration: (client: string) => string;
  registered: string;
  notRegistered: string;
  registeredHint: (command: string) => string;
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
  previewToggle: (label: string, on: boolean) => string;
  previewSelect: (label: string, option: string) => string;
  previewInstall: (client: string) => string;
  previewUninstall: (client: string) => string;
  previewUpdatesCheck: string;
  /** A write sent with a code that is unknown, spent, expired or issued for
   * another action or value (D11). */
  confirmationInvalid: string;
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
    sections: {
      status: 'Status',
      setup: 'Setup',
      console: 'Console settings',
      diagnose: 'Diagnose',
      reference: 'Reference',
    },
    consoleNotice:
      'These settings change only from the console, in a terminal. Each one widens what an agent may do or see, so anything that can reach the bridge, an agent included, could grant it if it could be changed here. Copy the command next to a setting and run it in a terminal; this window shows the new value once it applies.',
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
    language: 'Console language',
    tool: (name) => `Tool ${name}`,
    multiAgent: 'Multi-agent mode',
    autoReelect: 'Auto-reelect on primary close',
    instructionsAutoRefresh: 'Refresh the instructions block at server start',
    cdpDirectEnabled: 'cdp-direct enabled',
    cdpDirectPort: 'cdp-direct port',
    cdpDirectGrantTtl: 'cdp-direct grant lifetime',
    cdpDirectPortHint: (command) => `A port number, for example: ${command}`,
    cdpDirectGrantTtlHint: (command) =>
      `A whole number of minutes or never, for example: ${command}`,
    minutes: (n) => `${n} min`,
    never: 'never expires',
    activityEnabled: 'Record the activity trail',
    activityRecordPayloads: 'Record tool payloads in the trail',
    hidePasswordValues: 'Hide password values from agents',
    passwordValuesStatus: 'Password values',
    passwordValuesHidden: 'hidden',
    passwordValuesShown: 'returned',
    activityHideSensitive: 'Hide sensitive values in the activity trail',
    activitySensitiveStatus: 'Sensitive rows',
    activitySensitiveHidden: 'hidden',
    activitySensitiveStored: 'stored unhidden',
    downloadsDir: 'Downloads folder',
    allowExecutableDownloads: 'Save executable downloads (.exe, .msi, .bat, .ps1, ...)',
    executablesAllowed: 'allowed',
    executablesRefused: 'refused',
    idleTtl: 'Idle disconnect',
    idleTtlNever: 'never (stays connected)',
    claimTtl: 'Claim expiry between agents',
    claimTtlNever: 'never (until its agent releases it or disconnects)',
    flowRecording: 'Flow recording',
    flowRecordingHint:
      "Change it in the popup's flow recording control or with browser-link config set flow-recording",
    popupDefault: 'popup choice',
    doctor: 'Run doctor',
    updatesCheck: 'Check for updates',
    instructionsInstall: (client) => `Install instructions block — ${client}`,
    instructionsUninstall: (client) => `Remove instructions block — ${client}`,
    registration: (client) => `MCP registration — ${client}`,
    registered: 'registered',
    notRegistered: 'not registered',
    registeredHint: (command) => `Already registered; to remove it: ${command}`,
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
    previewToggle: (label, on) => `Turn ${on ? 'on' : 'off'}: ${label}`,
    previewSelect: (label, option) => `Set ${label} to ${option}`,
    previewInstall: (client) => `Write the browser-link instructions block into ${client}'s file`,
    previewUninstall: (client) =>
      `Remove the browser-link instructions block from ${client}'s file`,
    previewUpdatesCheck:
      'Ask the npm registry for the latest version now and save the answer in update-check.json',
    confirmationInvalid:
      'This confirmation is no longer valid: it expired, was already used or was for a different change. Nothing was changed; try again.',
  },
  es: {
    ui: {
      confirm: 'Confirmar',
      cancel: 'Cancelar',
      apply: 'Aplicar',
      notConnected: 'Conecte una pestaña para administrar browser-link desde aquí.',
      restartRequired: 'Reinicie su cliente MCP para que el cambio surta efecto.',
      changed: 'Guardado.',
    },
    sections: {
      status: 'Estado',
      setup: 'Configuración',
      console: 'Ajustes de la consola',
      diagnose: 'Diagnóstico',
      reference: 'Referencia',
    },
    consoleNotice:
      'Estos ajustes solo se cambian desde la consola, en una terminal. Cada uno amplía lo que un agente puede hacer o ver, así que cualquier cosa que llegue al puente, un agente incluido, podría concederlo si se pudiera cambiar aquí. Copie el comando junto al ajuste y ejecútelo en una terminal; esta ventana muestra el valor nuevo cuando se aplica.',
    on: 'activado',
    off: 'desactivado',
    unknown: 'desconocido',
    server: 'Servidor',
    serverRunning: (version) => `en marcha v${version}`,
    serverNotRunning: 'detenido',
    serverNotRunningHint: 'Lo inicia su cliente MCP; abra una sesión que use browser-link.',
    installed: 'Versión instalada',
    installedOutdated: (installed) => `${installed} (desactualizado: hace falta reiniciar)`,
    pid: 'PID',
    uptime: 'Tiempo en marcha',
    tabs: 'Pestañas conectadas',
    tabsUnknownHint: 'Solo lo sabe el servidor en marcha; abra el popup de la extensión.',
    ports: 'Puertos',
    multiAgentStatus: 'Multi-agente',
    extension: 'Extensión',
    extensionAligned: (version) => `v${version} (alineada)`,
    extensionMismatch: (ext, server) =>
      `v${ext} (servidor v${server}: recargue o actualice uno de los dos)`,
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
          return 'corrupto (corríjalo a mano)';
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
    language: 'Idioma de la consola',
    tool: (name) => `Tool ${name}`,
    multiAgent: 'Modo multi-agente',
    autoReelect: 'Re-elección automática al cerrar el primary',
    instructionsAutoRefresh: 'Refrescar el bloque de instrucciones al arrancar el servidor',
    cdpDirectEnabled: 'cdp-direct activado',
    cdpDirectPort: 'Puerto de cdp-direct',
    cdpDirectGrantTtl: 'Duración del permiso de cdp-direct',
    cdpDirectPortHint: (command) => `Un número de puerto, por ejemplo: ${command}`,
    cdpDirectGrantTtlHint: (command) =>
      `Un número entero de minutos o never, por ejemplo: ${command}`,
    minutes: (n) => `${n} min`,
    never: 'no vence',
    activityEnabled: 'Guardar el registro de actividad',
    activityRecordPayloads: 'Guardar los payloads de las tools en el registro',
    hidePasswordValues: 'Ocultar a los agentes el valor de las contraseñas',
    passwordValuesStatus: 'Contraseñas',
    passwordValuesHidden: 'ocultas',
    passwordValuesShown: 'visibles',
    activityHideSensitive: 'Ocultar los valores sensibles en el registro de actividad',
    activitySensitiveStatus: 'Filas sensibles',
    activitySensitiveHidden: 'ocultas',
    activitySensitiveStored: 'sin ocultar',
    downloadsDir: 'Carpeta de descargas',
    allowExecutableDownloads: 'Guardar descargas ejecutables (.exe, .msi, .bat, .ps1, ...)',
    executablesAllowed: 'permitidas',
    executablesRefused: 'rechazadas',
    idleTtl: 'Desconexión por inactividad',
    idleTtlNever: 'nunca (sigue conectada)',
    claimTtl: 'Vencimiento de la reserva entre agentes',
    claimTtlNever: 'nunca (hasta que su agente la libere o se desconecte)',
    flowRecording: 'Grabación de flows',
    flowRecordingHint:
      'Se cambia desde el popup (grabación de flows) o con browser-link config set flow-recording',
    popupDefault: 'lo elegido en el popup',
    doctor: 'Ejecutar doctor',
    updatesCheck: 'Buscar actualizaciones',
    instructionsInstall: (client) => `Instalar el bloque de instrucciones — ${client}`,
    instructionsUninstall: (client) => `Quitar el bloque de instrucciones — ${client}`,
    registration: (client) => `Registro MCP — ${client}`,
    registered: 'registrado',
    notRegistered: 'sin registrar',
    registeredHint: (command) => `Ya está registrado; para quitarlo: ${command}`,
    stop: 'Detener el servidor / liberar el puerto',
    stopDescription: 'Termina el servidor en marcha, por eso solo se hace desde una terminal.',
    selfUpdate: 'Actualizar browser-link',
    selfUpdateDescription:
      'Reemplaza el servidor en marcha, por eso solo se hace desde una terminal.',
    about: 'Acerca de',
    aboutText:
      'browser-link es un servidor MCP que deja a los agentes ver y actuar sobre las pestañas de Chrome que usted conecte.',
    repo: 'Repositorio en GitHub',
    extensionPath: 'Carpeta de la extensión',
    extensionNotFound: 'no se encontró junto al servidor',
    unknownAction: (id) => `Acción de administración desconocida: ${id}`,
    notAnAction: (id) => `${id} es de solo lectura`,
    invalidValue: (id) => `Valor inválido para ${id}`,
    previewToggle: (label, on) => `${on ? 'Activar' : 'Desactivar'}: ${label}`,
    previewSelect: (label, option) => `Cambiar ${label} a ${option}`,
    previewInstall: (client) =>
      `Escribir el bloque de instrucciones de browser-link en el archivo de ${client}`,
    previewUninstall: (client) =>
      `Quitar el bloque de instrucciones de browser-link del archivo de ${client}`,
    previewUpdatesCheck:
      'Consultar ahora en el registro de npm la versión más reciente y guardar la respuesta en update-check.json',
    confirmationInvalid:
      'Esta confirmación ya no es válida: caducó, ya se usó o correspondía a otro cambio. No se cambió nada; vuelva a intentarlo.',
  },
};
