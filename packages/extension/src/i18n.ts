/**
 * The extension's interface text, English and Spanish.
 *
 * Why not `chrome.i18n` / `_locales`: Chrome picks that language from the
 * browser UI and offers no way to switch it, while this interface has its own
 * selector (see ui-language.ts). So the dictionaries live here, as plain data:
 * `EN` is the source of truth and `ES` is typed as the same shape, so a missing
 * or extra Spanish key is a compile error.
 *
 * Static HTML binds a key by attribute (`data-i18n`, `data-i18n-title`,
 * `data-i18n-placeholder`, `data-i18n-aria-label`); those keys must hold plain
 * strings. Text built in TypeScript reads the same objects; anything with a
 * value in it is a function, so no sentence is ever glued together from
 * translated fragments.
 *
 * Not here on purpose: error strings that travel to an agent (tool results)
 * stay English, they are the tools' contract; and the product notice keeps
 * its approved copy in notice-policy.ts.
 *
 * Pure: no `chrome.*`, no DOM.
 */

export type Language = 'en' | 'es';

export const LANGUAGES: readonly Language[] = ['en', 'es'];

/** How a finished flow ended; mirrors flow-registry.ts's `FlowOutcome`
 * (kept structural so this module imports nothing). */
type FlowOutcomeWord = 'completed' | 'cancelled' | 'failed' | 'expired';

const EN = {
  // Shared by every window.
  langSwitchLabel: 'Interface language',
  loading: 'Loading…',
  cancel: 'Cancel',
  close: 'Close',

  // Popup: static text.
  popupSubtitle: 'MCP bridge · per-tab manual',
  popupVersionMismatch: '⚠ Version mismatch',
  popupVersionExtension: 'Extension:',
  popupVersionServer: 'Server:',
  popupVersionHint: 'Reload the extension so both halves run the same code.',
  popupOpenExtensions: 'Open chrome://extensions',
  popupDialogPending: 'native dialog pending',
  popupDialogPromptPlaceholder: 'Response (only used for prompt)',
  popupDialogAccept: 'OK / Accept',
  popupIdleTtl: 'Auto-disconnect idle tabs',
  popupFlowRecording: 'Enable flow recording',
  popupRecordingIndicator: '● Recording…',
  popupRecordingNamePlaceholder: 'Name this flow (e.g. "open task detail dialog")',
  popupRecordingSave: 'Save',
  popupRecordingDiscard: 'Discard',
  popupFlowsRunning: 'Running flows',
  popupFlowsRecent: 'Recent flows',
  popupOpenActivity: 'Activity',
  popupOpenAdmin: 'Admin',
  popupFooter: 'manual · per-tab · loopback only',

  // Popup: text set from popup.ts.
  popupStatusConnected: 'Connected',
  popupStatusNotConnected: 'Not connected',
  popupStatusReconnecting: 'Reconnecting…',
  popupStatusConnecting: 'Connecting…',
  popupStatusDisconnecting: 'Disconnecting…',
  popupStatusNoTab: 'No active tab',
  popupUnknownError: 'Unknown error',
  popupConnect: 'Connect this tab',
  popupDisconnect: 'Disconnect this tab',
  popupOpenTabFirst: 'Open a tab first',
  popupRetry: 'Retry',
  popupRepair: 'Repair connection',
  popupRepairTitle:
    'Restart the browser-link server on the installed version, or reconnect the tabs you connected',
  popupRepairing: 'Repairing…',
  popupRunningInstalled: (server: string, installed: string): string =>
    `Server running ${server} · installed ${installed}`,
  popupMinutes: (minutes: number): string => `${String(minutes)} min`,
  popupMinutesCustom: (minutes: number): string => `${String(minutes)} min (custom)`,
  popupNever: 'Never',
  popupDialogEmpty: '(empty)',
  popupRecord: 'Record',
  popupStop: 'Stop',
  popupStopping: 'Stopping…',
  popupStepsCaptured: (steps: number, capped: boolean): string =>
    `${String(steps)} step(s) captured${capped ? ' — stopped: 20-step limit reached' : ''}`,
  popupSelectorAmbiguous: ' ⚠ selector may match multiple elements',
  popupCouldNotStartRecording: 'Could not start recording.',
  popupCouldNotStopRecording: 'Could not stop recording.',
  popupCouldNotSaveFlow: 'Could not save the flow.',

  // Flow rows (flow-registry.ts) and recorded steps (recording.ts).
  flowOutcome: (outcome: FlowOutcomeWord): string => outcome,
  flowTab: (tabId: number): string => `Tab ${String(tabId)}`,
  flowDetached: (rest: string): string => `detached · ${rest}`,
  flowStarting: 'starting…',
  flowStep: (step: number, steps: number): string => `step ${String(step)}/${String(steps)}`,
  flowIteration: (iteration: number, iterations: number): string =>
    `iteration ${String(iteration)}/${String(iterations)}`,
  flowStepsDone: (done: number, steps: number): string => `${String(done)}/${String(steps)} steps`,
  flowIterationsDone: (iterations: number): string => `${String(iterations)} iterations`,
  flowFailedAt: (step: number, kind: string | undefined): string =>
    `failed at step ${String(step)}${kind === undefined ? '' : ` (${kind})`}`,
  flowExpired: 'hit the 30-minute detached ceiling',
  flowWorkerTerminated: 'extension worker was terminated — not resumed',
  stepClick: (target: string): string => `Click ${target}`,
  stepImplicitTarget: '(implicit target)',
  stepType: (target: string): string => `Type into ${target}`,
  stepFocusedField: '(focused field)',
  stepPress: (key: string): string => `Press ${key}`,
  stepWaitFor: (what: string): string => `Wait for ${what}`,
  stepWaitForNetwork: (url: string): string => `Wait for network: ${url}`,
  stepWait: 'Wait',
  stepFind: (text: string): string => `Find "${text}"`,
  stepUnknown: 'Unknown step',

  // Messages the service worker returns with a code (worker-messages.ts). The
  // English entries are, word for word, what it sent before codes existed.
  workerTabAlreadyConnected: 'This tab is already connected',
  workerTabNoUrl: 'Tab has no URL or title',
  workerDebuggerAttachFailed: (detail: string): string => `Could not attach debugger: ${detail}`,
  workerCdpEnableFailed: (detail: string): string => `Could not enable CDP: ${detail}`,
  workerWsConnectFailed: 'WebSocket connection failed. Is the MCP server running?',
  workerWsClosedBeforeRegistration: 'WebSocket closed before registration',
  workerRecordingDisabled: 'Flow recording is disabled. Enable it in settings first.',
  workerTabNotConnected: 'This tab is not connected.',
  workerRecordingInProgress: 'A recording is already in progress (or awaiting review).',
  workerTabGone: 'Tab no longer exists.',
  workerRecordingStartFailed: (detail: string): string => `Could not start recording: ${detail}`,
  workerNotRecording: 'Not currently recording this tab.',
  workerRecordingDiscarded: 'Discarded before the save finished.',
  workerNoReviewedRecording: 'No reviewed recording to save for this tab.',
  workerServerNotConnected: 'Not connected to the server.',
  workerNameRequired: 'Name is required.',
  workerNoSteps: 'No steps were captured.',
  workerServerTimeout: 'Timed out waiting for the server.',
  workerHandshakeRefused: (reason: string): string =>
    `The browser-link server refused the connection: ${reason}`,
  // Since 1.0.0 the bridge accepts only the pinned extension id (and the
  // ids in allowedExtensionIds); an extension with another id gets this.
  handshakeReasonOriginNotAllowed:
    "it does not accept this extension's id. Reload the extension from the installed browser-link version.",
  handshakeReasonPeerUnidentified: 'it could not see which program opened the connection.',
  handshakeReasonPeerUnknown: 'it could not identify the program that opened the connection.',
  handshakeReasonPeerOwnerUnreadable:
    'it could not read which user runs the program that opened the connection.',
  handshakeReasonPeerOtherUser:
    'the program that opened the connection runs as another user of this computer.',
  handshakeReasonPeerNotBrowser:
    'the program that opened the connection is not a supported Chromium-based browser.',
  handshakeReasonPeerPathNotAllowed:
    "the browser's executable path is not in the server's peerExecutablePaths list.",
  handshakeReasonLookupFailed: 'checking the program that opened the connection failed.',
  handshakeReasonOther: 'this extension version does not know the reason. Update the extension.',
  repairServerTooOld: (version: string | undefined): string =>
    `server ${version ?? '(unknown version)'} cannot repair itself: run \`browser-link stop\` and restart your agent`,
  repairNoServer: 'no server is running: start browser-link from your agent or a console',
  repairNoAnswer:
    'The server did not answer the repair request: run `browser-link stop` and restart your agent',
  repairRestarting: 'The server is restarting; connected tabs reconnect by themselves.',
  repairFailed: (detail: string): string => `Repair failed: ${detail}`,
  repairReconnected: (reconnected: number, total: number): string =>
    `Reconnected ${String(reconnected)} of ${String(total)} tab${total === 1 ? '' : 's'}.`,

  // Activity window: static text.
  activityDocTitle: 'browser-link — Activity',
  activityTitle: 'Activity',
  activitySubtitle: 'Everything agents did in your browser',
  activityLive: 'Live',
  activityLiveTitle: 'Keep the newest actions streaming in',
  activityRefresh: 'Refresh',
  activityRefreshTitle: 'Reload now',
  activityExport: 'Export',
  activityExportTitle: 'Download the visible trail',
  activityUsageActions: 'actions',
  activityUsageDisk: 'on disk',
  activityUsageOldest: 'oldest entry',
  activityUsageMeterTitle: 'How full the trail is before it starts pruning its oldest entries',
  activityPurgeToggle: 'Purge…',
  activityPurgeFrom: 'From',
  activityPurgeTo: 'To',
  activityPreset30d: 'Older than 30 days',
  activityPreset7d: 'Older than 7 days',
  activityPresetAll: 'Everything',
  activityPurgeIntro: 'Pick a range. Leave both dates empty to purge the whole trail.',
  activityPurgeCheck: 'Check how many',
  activityPurgeRun: 'Delete permanently',
  activityPurgeWarningStrong: 'This cannot be undone.',
  activityPurgeWarningBefore: 'Deleted rows are gone from',
  activityPurgeWarningAfter:
    '— they are not in the recycle bin and not recoverable from an earlier export unless you already made one.',
  activityFilterAgent: 'Filter by agent',
  activityAllAgents: 'All agents',
  activityFilterTool: 'Filter by tool',
  activityAllTools: 'All tools',
  activityFailuresOnly: 'Failures only',
  activityFailuresOnlyTitle: 'Show only actions that errored',
  activityFilterText: 'Free-text filter',
  activityFilterTextPlaceholder: 'Filter selector, URL or payload…',
  activityReset: 'Reset',
  activityColWhen: 'When',
  activityColAgent: 'Agent',
  activityColTool: 'Tool',
  activityColTarget: 'Target',
  activityColResult: 'Result',
  activityFooterHint: 'Trail is stored locally in activity.db · never uploaded',

  // Activity window: text set from activity.ts.
  activityJustNow: 'just now',
  activitySecondsAgo: (seconds: number): string => `${String(seconds)}s ago`,
  activityMinutesAgo: (minutes: number): string => `${String(minutes)}m ago`,
  activityFlowTag: 'flow',
  activityAgentPid: (pid: number): string => `pid ${String(pid)}`,
  activityOutcomeOk: (ms: number): string => `ok · ${String(ms)}ms`,
  activityOutcomeError: 'error',
  activityNoActivity: 'No activity yet',
  activityNoActivityDetail: 'Actions appear here the moment an agent touches a connected tab.',
  activityNoMatch: 'Nothing matches this filter',
  activityNoMatchDetail: 'Try clearing the search box or the dropdowns.',
  activityShownOf: (shown: string, total: string): string => `${shown} of ${total} shown`,
  activityActions: (count: string): string => `${count} actions`,
  activityNoTab: 'No connected tab',
  activityNoTabDetail:
    'The trail lives in the browser-link server. Connect a tab from the popup to read it.',
  activityReadFailed: 'Could not read the trail',
  activityStatusError: (error: string): string => `error: ${error}`,
  activityRecorded: (total: string): string => `${total} actions recorded`,
  activityRangeAll: 'the entire trail',
  activityRangeBetween: (from: string, to: string): string => `${from} → ${to}`,
  activityRangeFrom: (from: string): string => `everything from ${from} onwards`,
  activityRangeTo: (to: string): string => `everything up to ${to}`,
  activityReadyToCheck: (range: string, current: { rows: string; size: string } | null): string =>
    `Ready to check: ${range}.${
      current === null ? '' : ` Currently ${current.rows} actions, ${current.size}.`
    }`,
  activityCounting: 'Counting…',
  activityCheckFailed: (error: string): string => `Could not check: ${error}`,
  activityNothingToDelete: (range: string): string => `Nothing to delete in ${range}.`,
  activityWillDelete: (removed: string, rows: string, range: string): string =>
    `This will permanently delete ${removed} of ${rows} actions (${range}).`,
  activityDeleteCount: (removed: string): string => `Delete ${removed} permanently`,
  activityConfirmDelete: (count: string, range: string): string =>
    `Permanently delete ${count} actions (${range})?\n\nThis cannot be undone.`,
  activityDeleting: 'Deleting…',
  activityDeletingDetail: 'Deleting and reclaiming disk space…',
  activityPurgeFailed: (error: string): string => `Purge failed: ${error}`,
  activityDeleted: (removed: string, left: string, size: string): string =>
    `Deleted ${removed} actions. ${left} left, ${size} on disk.`,

  // Admin window. The rows come from the server, already in this language
  // (admin.describe carries it); these are the window's own words and the
  // fallback used while no server answers.
  adminDocTitle: 'browser-link — Admin',
  adminTitle: 'Admin',
  adminSubtitle: 'browser-link server settings · same as the console',
  adminConfirm: 'Confirm',
  adminApply: 'Apply',
  adminNotConnected: 'Connect a tab to administer the server',
  adminRestartRequired: 'Restart the server to apply this change',
  adminChanged: 'Changed',
  adminOn: 'on',
  adminOff: 'off',
};

/** The shape every language must provide, key for key. */
export type Messages = typeof EN;

const ES: Messages = {
  langSwitchLabel: 'Idioma de la interfaz',
  loading: 'Cargando…',
  cancel: 'Cancelar',
  close: 'Cerrar',

  popupSubtitle: 'Puente MCP · manual por pestaña',
  popupVersionMismatch: '⚠ Versiones distintas',
  popupVersionExtension: 'Extensión:',
  popupVersionServer: 'Servidor:',
  popupVersionHint: 'Recargue la extensión para que ambas partes ejecuten el mismo código.',
  popupOpenExtensions: 'Abrir chrome://extensions',
  popupDialogPending: 'diálogo nativo pendiente',
  popupDialogPromptPlaceholder: 'Respuesta (solo para prompt)',
  popupDialogAccept: 'Aceptar',
  popupIdleTtl: 'Desconectar pestañas inactivas',
  popupFlowRecording: 'Activar la grabación de flujos',
  popupRecordingIndicator: '● Grabando…',
  popupRecordingNamePlaceholder: 'Nombre del flujo (p. ej., "abrir el detalle de la tarea")',
  popupRecordingSave: 'Guardar',
  popupRecordingDiscard: 'Descartar',
  popupFlowsRunning: 'Flujos en curso',
  popupFlowsRecent: 'Flujos recientes',
  popupOpenActivity: 'Actividad',
  popupOpenAdmin: 'Administración',
  popupFooter: 'manual · por pestaña · solo loopback',

  popupStatusConnected: 'Conectada',
  popupStatusNotConnected: 'No conectada',
  popupStatusReconnecting: 'Reconectando…',
  popupStatusConnecting: 'Conectando…',
  popupStatusDisconnecting: 'Desconectando…',
  popupStatusNoTab: 'No hay ninguna pestaña activa',
  popupUnknownError: 'Error desconocido',
  popupConnect: 'Conectar esta pestaña',
  popupDisconnect: 'Desconectar esta pestaña',
  popupOpenTabFirst: 'Abra una pestaña primero',
  popupRetry: 'Reintentar',
  popupRepair: 'Reparar la conexión',
  popupRepairTitle:
    'Reiniciar el servidor de browser-link con la versión instalada, o reconectar las pestañas que conectó',
  popupRepairing: 'Reparando…',
  popupRunningInstalled: (server: string, installed: string): string =>
    `Servidor en ejecución ${server} · instalado ${installed}`,
  popupMinutes: (minutes: number): string => `${String(minutes)} min`,
  popupMinutesCustom: (minutes: number): string => `${String(minutes)} min (personalizado)`,
  popupNever: 'Nunca',
  popupDialogEmpty: '(vacío)',
  popupRecord: 'Grabar',
  popupStop: 'Detener',
  popupStopping: 'Deteniendo…',
  popupStepsCaptured: (steps: number, capped: boolean): string =>
    `${String(steps)} ${steps === 1 ? 'paso capturado' : 'pasos capturados'}${
      capped ? ' — detenida: se alcanzó el límite de 20 pasos' : ''
    }`,
  popupSelectorAmbiguous: ' ⚠ el selector puede coincidir con varios elementos',
  popupCouldNotStartRecording: 'No se pudo iniciar la grabación.',
  popupCouldNotStopRecording: 'No se pudo detener la grabación.',
  popupCouldNotSaveFlow: 'No se pudo guardar el flujo.',

  flowOutcome: (outcome: FlowOutcomeWord): string =>
    ({
      completed: 'completado',
      cancelled: 'cancelado',
      failed: 'fallido',
      expired: 'caducado',
    })[outcome],
  flowTab: (tabId: number): string => `Pestaña ${String(tabId)}`,
  flowDetached: (rest: string): string => `desacoplado · ${rest}`,
  flowStarting: 'iniciando…',
  flowStep: (step: number, steps: number): string => `paso ${String(step)}/${String(steps)}`,
  flowIteration: (iteration: number, iterations: number): string =>
    `iteración ${String(iteration)}/${String(iterations)}`,
  flowStepsDone: (done: number, steps: number): string => `${String(done)}/${String(steps)} pasos`,
  flowIterationsDone: (iterations: number): string => `${String(iterations)} iteraciones`,
  flowFailedAt: (step: number, kind: string | undefined): string =>
    `falló en el paso ${String(step)}${kind === undefined ? '' : ` (${kind})`}`,
  flowExpired: 'alcanzó el límite de 30 minutos en modo desacoplado',
  flowWorkerTerminated: 'el proceso de la extensión se cerró; no se reanudó',
  stepClick: (target: string): string => `Clic en ${target}`,
  stepImplicitTarget: '(destino implícito)',
  stepType: (target: string): string => `Escribir en ${target}`,
  stepFocusedField: '(campo con el foco)',
  stepPress: (key: string): string => `Pulsar ${key}`,
  stepWaitFor: (what: string): string => `Esperar a ${what}`,
  stepWaitForNetwork: (url: string): string => `Esperar a la red: ${url}`,
  stepWait: 'Esperar',
  stepFind: (text: string): string => `Buscar "${text}"`,
  stepUnknown: 'Paso desconocido',

  workerTabAlreadyConnected: 'Esta pestaña ya está conectada',
  workerTabNoUrl: 'La pestaña no tiene URL ni título',
  workerDebuggerAttachFailed: (detail: string): string =>
    `No se pudo conectar el depurador: ${detail}`,
  workerCdpEnableFailed: (detail: string): string => `No se pudo activar CDP: ${detail}`,
  workerWsConnectFailed: 'Falló la conexión WebSocket. ¿Está en marcha el servidor MCP?',
  workerWsClosedBeforeRegistration: 'El WebSocket se cerró antes del registro',
  workerRecordingDisabled:
    'La grabación de flujos está desactivada. Actívela antes en los ajustes.',
  workerTabNotConnected: 'Esta pestaña no está conectada.',
  workerRecordingInProgress: 'Ya hay una grabación en curso (o pendiente de revisión).',
  workerTabGone: 'La pestaña ya no existe.',
  workerRecordingStartFailed: (detail: string): string =>
    `No se pudo iniciar la grabación: ${detail}`,
  workerNotRecording: 'Esta pestaña no se está grabando.',
  workerRecordingDiscarded: 'Se descartó antes de que terminara el guardado.',
  workerNoReviewedRecording: 'No hay ninguna grabación revisada que guardar en esta pestaña.',
  workerServerNotConnected: 'No hay conexión con el servidor.',
  workerNameRequired: 'El nombre es obligatorio.',
  workerNoSteps: 'No se capturó ningún paso.',
  workerServerTimeout: 'Se agotó el tiempo de espera del servidor.',
  workerHandshakeRefused: (reason: string): string =>
    `El servidor de browser-link rechazó la conexión: ${reason}`,
  handshakeReasonOriginNotAllowed:
    'no acepta el id de esta extensión. Vuelva a cargar la extensión desde la versión de browser-link instalada.',
  handshakeReasonPeerUnidentified: 'no pudo ver qué programa abrió la conexión.',
  handshakeReasonPeerUnknown: 'no pudo identificar el programa que abrió la conexión.',
  handshakeReasonPeerOwnerUnreadable:
    'no pudo leer con qué usuario se ejecuta el programa que abrió la conexión.',
  handshakeReasonPeerOtherUser:
    'el programa que abrió la conexión se ejecuta con otro usuario de este equipo.',
  handshakeReasonPeerNotBrowser:
    'el programa que abrió la conexión no es un navegador compatible basado en Chromium.',
  handshakeReasonPeerPathNotAllowed:
    'la ruta del ejecutable del navegador no está en la lista peerExecutablePaths del servidor.',
  handshakeReasonLookupFailed: 'falló la comprobación del programa que abrió la conexión.',
  handshakeReasonOther: 'esta versión de la extensión no conoce el motivo. Actualice la extensión.',
  repairServerTooOld: (version: string | undefined): string =>
    `el servidor ${version ?? '(versión desconocida)'} no puede repararse solo: ejecute \`browser-link stop\` y reinicie su agente`,
  repairNoServer:
    'no hay ningún servidor en marcha: inicie browser-link desde su agente o una consola',
  repairNoAnswer:
    'El servidor no respondió a la solicitud de reparación: ejecute `browser-link stop` y reinicie su agente',
  repairRestarting: 'El servidor se está reiniciando; las pestañas conectadas se reconectan solas.',
  repairFailed: (detail: string): string => `La reparación falló: ${detail}`,
  repairReconnected: (reconnected: number, total: number): string =>
    `${reconnected === 1 ? 'Se reconectó' : 'Se reconectaron'} ${String(reconnected)} de ${String(total)} ${total === 1 ? 'pestaña' : 'pestañas'}.`,

  activityDocTitle: 'browser-link — Actividad',
  activityTitle: 'Actividad',
  activitySubtitle: 'Todo lo que hicieron los agentes en su navegador',
  activityLive: 'En vivo',
  activityLiveTitle: 'Seguir recibiendo las acciones más recientes',
  activityRefresh: 'Actualizar',
  activityRefreshTitle: 'Recargar ahora',
  activityExport: 'Exportar',
  activityExportTitle: 'Descargar el registro visible',
  activityUsageActions: 'acciones',
  activityUsageDisk: 'en disco',
  activityUsageOldest: 'entrada más antigua',
  activityUsageMeterTitle:
    'Cuánto se ha llenado el registro antes de empezar a eliminar sus entradas más antiguas',
  activityPurgeToggle: 'Purgar…',
  activityPurgeFrom: 'Desde',
  activityPurgeTo: 'Hasta',
  activityPreset30d: 'Anteriores a 30 días',
  activityPreset7d: 'Anteriores a 7 días',
  activityPresetAll: 'Todo',
  activityPurgeIntro: 'Elija un rango. Deje ambas fechas vacías para purgar todo el registro.',
  activityPurgeCheck: 'Comprobar cuántas',
  activityPurgeRun: 'Eliminar definitivamente',
  activityPurgeWarningStrong: 'Esto no se puede deshacer.',
  activityPurgeWarningBefore: 'Las filas eliminadas desaparecen de',
  activityPurgeWarningAfter:
    '— no pasan a la papelera ni se pueden recuperar, salvo desde una exportación que ya tenga.',
  activityFilterAgent: 'Filtrar por agente',
  activityAllAgents: 'Todos los agentes',
  activityFilterTool: 'Filtrar por herramienta',
  activityAllTools: 'Todas las herramientas',
  activityFailuresOnly: 'Solo fallos',
  activityFailuresOnlyTitle: 'Mostrar solo las acciones que fallaron',
  activityFilterText: 'Filtro de texto libre',
  activityFilterTextPlaceholder: 'Filtrar por selector, URL o contenido…',
  activityReset: 'Restablecer',
  activityColWhen: 'Cuándo',
  activityColAgent: 'Agente',
  activityColTool: 'Herramienta',
  activityColTarget: 'Objetivo',
  activityColResult: 'Resultado',
  activityFooterHint: 'El registro se guarda localmente en activity.db · nunca se sube',

  activityJustNow: 'ahora mismo',
  activitySecondsAgo: (seconds: number): string => `hace ${String(seconds)} s`,
  activityMinutesAgo: (minutes: number): string => `hace ${String(minutes)} min`,
  activityFlowTag: 'flujo',
  activityAgentPid: (pid: number): string => `PID ${String(pid)}`,
  activityOutcomeOk: (ms: number): string => `ok · ${String(ms)} ms`,
  activityOutcomeError: 'error',
  activityNoActivity: 'Todavía no hay actividad',
  activityNoActivityDetail:
    'Las acciones aparecen aquí en cuanto un agente usa una pestaña conectada.',
  activityNoMatch: 'Nada coincide con este filtro',
  activityNoMatchDetail: 'Pruebe a vaciar el cuadro de búsqueda o los desplegables.',
  activityShownOf: (shown: string, total: string): string => `${shown} de ${total} visibles`,
  activityActions: (count: string): string => `${count} acciones`,
  activityNoTab: 'No hay ninguna pestaña conectada',
  activityNoTabDetail:
    'El registro está en el servidor de browser-link. Conecte una pestaña desde la ventana emergente de la extensión para leerlo.',
  activityReadFailed: 'No se pudo leer el registro',
  activityStatusError: (error: string): string => `error: ${error}`,
  activityRecorded: (total: string): string => `${total} acciones registradas`,
  activityRangeAll: 'todo el registro',
  activityRangeBetween: (from: string, to: string): string => `${from} → ${to}`,
  activityRangeFrom: (from: string): string => `todo desde ${from} en adelante`,
  activityRangeTo: (to: string): string => `todo hasta ${to}`,
  activityReadyToCheck: (range: string, current: { rows: string; size: string } | null): string =>
    `Listo para comprobar: ${range}.${
      current === null ? '' : ` Ahora hay ${current.rows} acciones, ${current.size}.`
    }`,
  activityCounting: 'Contando…',
  activityCheckFailed: (error: string): string => `No se pudo comprobar: ${error}`,
  activityNothingToDelete: (range: string): string => `No hay nada que eliminar en ${range}.`,
  activityWillDelete: (removed: string, rows: string, range: string): string =>
    `Se eliminarán definitivamente ${removed} de ${rows} acciones (${range}).`,
  activityDeleteCount: (removed: string): string => `Eliminar ${removed} definitivamente`,
  activityConfirmDelete: (count: string, range: string): string =>
    `¿Eliminar definitivamente ${count} acciones (${range})?\n\nEsto no se puede deshacer.`,
  activityDeleting: 'Eliminando…',
  activityDeletingDetail: 'Eliminando y liberando espacio en disco…',
  activityPurgeFailed: (error: string): string => `La purga falló: ${error}`,
  activityDeleted: (removed: string, left: string, size: string): string =>
    `Se eliminaron ${removed} acciones. Quedan ${left}, ${size} en disco.`,

  adminDocTitle: 'browser-link — Administración',
  adminTitle: 'Administración',
  adminSubtitle: 'Ajustes del servidor de browser-link · los mismos que en la consola',
  adminConfirm: 'Confirmar',
  adminApply: 'Aplicar',
  adminNotConnected: 'Conecte una pestaña para administrar el servidor',
  adminRestartRequired: 'Reinicie el servidor para aplicar este cambio',
  adminChanged: 'Cambio aplicado',
  adminOn: 'activado',
  adminOff: 'desactivado',
};

const DICTIONARIES: Readonly<Record<Language, Messages>> = { en: EN, es: ES };

/** Every text of `language`. */
export function messages(language: Language): Messages {
  return DICTIONARIES[language];
}

export function isLanguage(value: unknown): value is Language {
  return value === 'en' || value === 'es';
}

/** First run, before the user ever touched the selector: Spanish when the
 * browser language starts with `es`, English otherwise (including when the
 * browser reports none). */
export function defaultLanguage(navigatorLanguage: string | undefined): Language {
  return navigatorLanguage?.toLowerCase().startsWith('es') ? 'es' : 'en';
}

/** The stored choice when it is a valid one; otherwise the first-run default.
 * A corrupted stored value never breaks the interface. */
export function resolveLanguage(stored: unknown, navigatorLanguage: string | undefined): Language {
  return isLanguage(stored) ? stored : defaultLanguage(navigatorLanguage);
}

/** Keys whose value is a plain string: the only ones an HTML attribute may
 * bind, since markup cannot call a function. */
export type StaticKey = {
  [K in keyof Messages]: Messages[K] extends string ? K : never;
}[keyof Messages];

/** A key read from markup: present and holding a plain string. */
export function isStaticKey(key: string): key is StaticKey {
  return Object.hasOwn(EN, key) && typeof EN[key as keyof Messages] === 'string';
}

/** Every key, for the guard test that keeps dictionaries and usage in step. */
export function dictionaryKeys(): (keyof Messages)[] {
  return Object.keys(EN) as (keyof Messages)[];
}
