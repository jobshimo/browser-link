import {
  DEFAULT_ACTIVITY_HIDE_SENSITIVE,
  DEFAULT_ALLOW_EXECUTABLE_DOWNLOADS,
  DEFAULT_DOWNLOADS_MAX_MB,
  DEFAULT_HIDE_PASSWORD_VALUES,
  MAX_CDP_DIRECT_PORT,
  MAX_DOWNLOADS_MAX_MB,
  MAX_GRANT_TTL_MINUTES,
  MAX_IDLE_TTL_MINUTES,
  MIN_CDP_DIRECT_PORT,
  MIN_DOWNLOADS_MAX_MB,
  MIN_GRANT_TTL_MINUTES,
  MIN_IDLE_TTL_MINUTES,
  activityHidesSensitive,
  allowsExecutableDownloads,
  clampCdpDirectPort,
  clampGrantTtlMinutes,
  clampIdleTtlMinutes,
  hidesPasswordValues,
  loadConfig,
  readConfig,
  restoreDefaultConfig,
  sanitizeDownloadsMaxMb,
  saveConfig,
  type BrowserLinkConfig,
  type RestoreDefaultsResult,
} from '../config.js';
import { isAbsolute } from 'node:path';
import { HandshakeError, IpcClient } from '../bridge/ipc-client.js';
import { resolveDownloadsDir } from '../downloads.js';
import { getDataDir } from '../map/paths.js';
import { readToken } from '../bridge/token.js';
import type { Language } from './welcome.js';
import { readArgs } from '../cli-args.js';

/**
 * `browser-link config` — scriptable CLI surface for settings that are also
 * editable from the extension's popup: the idle-disconnect TTL (see
 * `packages/extension/src/idle-policy.ts`) and the opt-in flow-recording
 * toggle (see `packages/extension/src/flow-recording-policy.ts`). `get`/`set`
 * are structured as `<action> <key> [value]` so each setting slots in
 * without a redesign.
 *
 *   browser-link config get                       Show every known setting.
 *   browser-link config get idle-ttl               Show just idle-ttl.
 *   browser-link config get flow-recording          Show just flow-recording.
 *   browser-link config set idle-ttl <minutes|never>
 *   browser-link config set flow-recording <on|off>
 *
 * Precedence with the popup: both editors write to ONE logical value per
 * setting — last write wins, decided by comparing `updatedAt` epoch-ms
 * timestamps (see messages.ts's SettingsUpdatePayload doc and the README's
 * "Idle disconnect" / "Recording flows by demonstration" sections). Each
 * `config set` here:
 *   1. Persists the value plus its own `*UpdatedAt: Date.now()` to
 *      config.json — this is what a NEW tab connecting later reads (see
 *      ws-bridge.ts's `tab.register` handler).
 *   2. Best-effort pushes the same value to every ALREADY connected tab
 *      right now, over the multi-agent IPC bridge (127.0.0.1:17530) — the
 *      one existing local control channel into a running primary. This
 *      requires a primary to be up AND multi-agent mode enabled (the
 *      default); when neither holds, the CLI says so plainly and the value
 *      still applies the next time a tab (re)connects.
 */

export interface ConfigI18n {
  header: string;
  idleTtlLabel: string;
  never: string;
  minutes: (n: number) => string;
  notSetViaCli: string;
  invalidValue: (raw: string) => string;
  clampedNote: (original: number, clamped: number) => string;
  setSaved: (label: string) => string;
  pushedLive: (n: number) => string;
  pushedNone: string;
  pushUnavailable: string;
  pushRejected: string;
  usage: string;
  unknownKey: (key: string) => string;
  unknownAction: (action: string) => string;
  flowRecordingLabel: string;
  flowRecordingEnabled: string;
  flowRecordingDisabled: string;
  flowRecordingNotSetViaCli: string;
  invalidFlowRecordingValue: (raw: string) => string;
  flowRecordingSetSaved: (label: string) => string;
  cdpDirectEnabledLabel: string;
  cdpDirectPortLabel: string;
  cdpDirectGrantTtlLabel: string;
  cdpDirectOn: string;
  cdpDirectOff: string;
  invalidCdpDirectEnabledValue: (raw: string) => string;
  cdpDirectEnabledSetSaved: (label: string) => string;
  invalidCdpDirectPortValue: (raw: string) => string;
  cdpDirectPortSetSaved: (port: number) => string;
  invalidGrantTtlValue: (raw: string) => string;
  grantTtlNever: string;
  cdpDirectGrantTtlSetSaved: (label: string) => string;
  downloadsDirLabel: string;
  downloadsDirDefaultNote: string;
  invalidDownloadsDirValue: (raw: string) => string;
  downloadsDirSetSaved: (dir: string) => string;
  downloadsMaxMbLabel: string;
  downloadsMaxMbValue: (mb: number) => string;
  invalidDownloadsMaxMbValue: (raw: string) => string;
  downloadsMaxMbSetSaved: (label: string) => string;
  downloadsMaxMbCeilingNote: string;
  allowExecutablesLabel: string;
  allowExecutablesOn: string;
  allowExecutablesOff: string;
  invalidAllowExecutablesValue: (raw: string) => string;
  allowExecutablesSetSaved: (label: string) => string;
  mapLearningLabel: string;
  mapLearningOn: string;
  mapLearningOff: string;
  invalidMapLearningValue: (raw: string) => string;
  mapLearningSetSaved: (label: string) => string;
  hidePasswordValuesLabel: string;
  hidePasswordValuesOn: string;
  hidePasswordValuesOff: string;
  invalidHidePasswordValuesValue: (raw: string) => string;
  hidePasswordValuesSetSaved: (label: string) => string;
  activityHideSensitiveLabel: string;
  activityHideSensitiveOn: string;
  activityHideSensitiveOff: string;
  invalidActivityHideSensitiveValue: (raw: string) => string;
  activityHideSensitiveSetSaved: (label: string) => string;
}

/** Exported so `commands/cdp.ts` can reuse `parseGrantTtlArg`'s exact
 * localized wording for `cdp allow --minutes`'s per-call override — same
 * error/clamp messages `config set cdp-direct.grant-ttl` produces. */
export const CFG_I18N: Record<Language, ConfigI18n> = {
  en: {
    header: 'browser-link config',
    idleTtlLabel: 'idle-ttl',
    never: 'never (auto-disconnect disabled)',
    minutes: (n) => `${n} min`,
    notSetViaCli:
      "not set via CLI — the extension's own default/popup choice applies (30 min unless changed in the popup)",
    invalidValue: (raw) =>
      `Invalid idle-ttl value: "${raw}". Use a whole number of minutes (${MIN_IDLE_TTL_MINUTES}-${MAX_IDLE_TTL_MINUTES}) or "never".`,
    clampedNote: (original, clamped) => ` (clamped from ${original} to ${clamped})`,
    setSaved: (label) => `Idle-disconnect TTL set to ${label}.`,
    pushedLive: (n) => ` Pushed immediately to ${n} connected tab(s).`,
    pushedNone: ' No tabs are currently connected — it will apply the next time one connects.',
    pushUnavailable:
      ' Could not reach a running browser-link primary (not running, or multi-agent mode is off) — it will apply the next time a tab connects.',
    pushRejected:
      ' A running primary rejected the push (stale or mismatched multi-agent token — it may have just restarted). The value is saved and applies the next time a tab connects.',
    usage:
      'Usage: browser-link config get [idle-ttl|flow-recording|cdp-direct.enabled|cdp-direct.port|cdp-direct.grant-ttl|downloads.dir|downloads.max-mb|downloads.allow-executables|map-learning|hide-password-values|activity.hide-sensitive] | browser-link config set idle-ttl <minutes|never> | browser-link config set flow-recording <on|off> | browser-link config set cdp-direct.enabled <true|false> | browser-link config set cdp-direct.port <port> | browser-link config set cdp-direct.grant-ttl <minutes|never> | browser-link config set downloads.dir <absolute-path|default> | browser-link config set downloads.max-mb <1..64|default> | browser-link config set downloads.allow-executables <on|off> | browser-link config set map-learning <on|off> | browser-link config set hide-password-values <on|off> | browser-link config set activity.hide-sensitive <on|off> | browser-link config restore-defaults [--yes]',
    unknownKey: (key) =>
      `Unknown config key: ${key}. Known keys: idle-ttl, flow-recording, cdp-direct.enabled, cdp-direct.port, cdp-direct.grant-ttl, downloads.dir, downloads.max-mb, downloads.allow-executables, map-learning, hide-password-values, activity.hide-sensitive.`,
    unknownAction: (action) =>
      `Unknown config action: ${action}. Use get, set or restore-defaults.`,
    flowRecordingLabel: 'flow-recording',
    flowRecordingEnabled: 'enabled',
    flowRecordingDisabled: 'disabled',
    flowRecordingNotSetViaCli:
      "not set via CLI — the extension's own default/popup choice applies (off unless enabled in the popup)",
    invalidFlowRecordingValue: (raw) =>
      `Invalid flow-recording value: "${raw}". Use "on" or "off".`,
    flowRecordingSetSaved: (label) => `Flow recording set to ${label}.`,
    cdpDirectEnabledLabel: 'cdp-direct.enabled',
    cdpDirectPortLabel: 'cdp-direct.port',
    cdpDirectGrantTtlLabel: 'cdp-direct.grant-ttl',
    cdpDirectOn: 'on',
    cdpDirectOff: 'off (default)',
    invalidCdpDirectEnabledValue: (raw) =>
      `Invalid cdp-direct.enabled value: "${raw}". Use "true" or "false".`,
    cdpDirectEnabledSetSaved: (label) =>
      `cdp-direct.enabled set to ${label}. This alone does not let an agent use a cdp: tab — run \`browser-link cdp allow\` to also grant it.`,
    invalidCdpDirectPortValue: (raw) =>
      `Invalid cdp-direct.port value: "${raw}". Use a whole number (${MIN_CDP_DIRECT_PORT}-${MAX_CDP_DIRECT_PORT}).`,
    cdpDirectPortSetSaved: (port) => `cdp-direct.port set to ${port}.`,
    invalidGrantTtlValue: (raw) =>
      `Invalid cdp-direct.grant-ttl value: "${raw}". Use a whole number of minutes (${MIN_GRANT_TTL_MINUTES}-${MAX_GRANT_TTL_MINUTES}) or "never".`,
    grantTtlNever: 'never (grants never expire until revoked — reduces the security posture)',
    cdpDirectGrantTtlSetSaved: (label) =>
      `cdp-direct.grant-ttl (default for \`cdp allow\`) set to ${label}.`,
    downloadsDirLabel: 'downloads.dir',
    downloadsDirDefaultNote: ' (default)',
    invalidDownloadsDirValue: (raw) =>
      `Invalid downloads.dir value: "${raw}". Use an absolute path, or "default" for <data dir>/downloads.`,
    downloadsDirSetSaved: (dir) =>
      `downloads.dir set to ${dir}. browser.download writes files there.`,
    downloadsMaxMbLabel: 'downloads.max-mb',
    downloadsMaxMbValue: (mb) => `${mb} MiB`,
    invalidDownloadsMaxMbValue: (raw) =>
      `Invalid downloads.max-mb value: "${raw}". Use a whole number of MiB (${MIN_DOWNLOADS_MAX_MB}-${MAX_DOWNLOADS_MAX_MB}) or "default".`,
    downloadsMaxMbSetSaved: (label) =>
      `downloads.max-mb set to ${label}. Applies to the next browser.download, no restart needed.`,
    downloadsMaxMbCeilingNote: ` ${MAX_DOWNLOADS_MAX_MB} MiB is the ceiling: the file crosses the extension socket base64-encoded in one message.`,
    allowExecutablesLabel: 'downloads.allow-executables',
    allowExecutablesOn:
      'on: browser.download may save executable file types; on Windows they carry the Mark-of-the-Web',
    allowExecutablesOff:
      'off: browser.download refuses executable file types (.exe, .msi, .bat, .ps1, .lnk, .js, ...)',
    invalidAllowExecutablesValue: (raw) =>
      `Invalid downloads.allow-executables value: "${raw}". Use "on" or "off".`,
    allowExecutablesSetSaved: (label) =>
      `downloads.allow-executables set to ${label}. Applies to the next download, no restart needed.`,
    mapLearningLabel: 'map-learning',
    mapLearningOn: 'on (default)',
    mapLearningOff: 'off',
    invalidMapLearningValue: (raw) => `Invalid map-learning value: "${raw}". Use "on" or "off".`,
    mapLearningSetSaved: (label) =>
      `map-learning set to ${label}. Applies to the next browser action, no restart needed. Only selectors and semantic keys are stored, never typed values.`,
    hidePasswordValuesLabel: 'hide-password-values',
    hidePasswordValuesOn: 'on: snapshot and find show "filled, N characters" for password fields',
    hidePasswordValuesOff: 'off: snapshot and find return the values of password fields',
    invalidHidePasswordValuesValue: (raw) =>
      `Invalid hide-password-values value: "${raw}". Use "on" or "off".`,
    hidePasswordValuesSetSaved: (label) =>
      `hide-password-values set to ${label}. Applies to the next snapshot, find or flow, no restart needed.`,
    activityHideSensitiveLabel: 'activity.hide-sensitive',
    activityHideSensitiveOn: 'on: a sensitive trail row hides the typed value in every column',
    activityHideSensitiveOff: 'off: sensitive trail rows are stored like any other, nothing hidden',
    invalidActivityHideSensitiveValue: (raw) =>
      `Invalid activity.hide-sensitive value: "${raw}". Use "on" or "off".`,
    activityHideSensitiveSetSaved: (label) =>
      `activity.hide-sensitive set to ${label}. Applies when the server restarts (restart your MCP client); rows already stored are not rewritten.`,
  },
  es: {
    header: 'Configuración de browser-link',
    idleTtlLabel: 'idle-ttl',
    never: 'nunca (auto-desconexión deshabilitada)',
    minutes: (n) => `${n} min`,
    notSetViaCli:
      'no configurado por CLI — se aplica el valor por defecto o el elegido en el popup de la extensión (30 min salvo que se haya cambiado en el popup)',
    invalidValue: (raw) =>
      `Valor de idle-ttl inválido: "${raw}". Usá un número entero de minutos (${MIN_IDLE_TTL_MINUTES}-${MAX_IDLE_TTL_MINUTES}) o "never".`,
    clampedNote: (original, clamped) => ` (ajustado de ${original} a ${clamped})`,
    setSaved: (label) => `TTL de auto-desconexión configurado a ${label}.`,
    pushedLive: (n) => ` Aplicado de inmediato a ${n} pestaña(s) conectada(s).`,
    pushedNone:
      ' No hay pestañas conectadas actualmente — se aplicará la próxima vez que una se conecte.',
    pushUnavailable:
      ' No se pudo contactar a un browser-link primary en ejecución (no está corriendo, o el modo multi-agente está apagado) — se aplicará la próxima vez que una pestaña se conecte.',
    pushRejected:
      ' Un primary en ejecución rechazó el push (token multi-agente obsoleto o no coincidente — puede haberse reiniciado recién). El valor quedó guardado y se aplicará la próxima vez que una pestaña se conecte.',
    usage:
      'Uso: browser-link config get [idle-ttl|flow-recording|cdp-direct.enabled|cdp-direct.port|cdp-direct.grant-ttl|downloads.dir|downloads.max-mb|downloads.allow-executables|map-learning|hide-password-values|activity.hide-sensitive] | browser-link config set idle-ttl <minutos|never> | browser-link config set flow-recording <on|off> | browser-link config set cdp-direct.enabled <true|false> | browser-link config set cdp-direct.port <puerto> | browser-link config set cdp-direct.grant-ttl <minutos|never> | browser-link config set downloads.dir <ruta-absoluta|default> | browser-link config set downloads.max-mb <1..64|default> | browser-link config set downloads.allow-executables <on|off> | browser-link config set map-learning <on|off> | browser-link config set hide-password-values <on|off> | browser-link config set activity.hide-sensitive <on|off> | browser-link config restore-defaults [--yes]',
    unknownKey: (key) =>
      `Clave de configuración desconocida: ${key}. Claves conocidas: idle-ttl, flow-recording, cdp-direct.enabled, cdp-direct.port, cdp-direct.grant-ttl, downloads.dir, downloads.max-mb, downloads.allow-executables, map-learning, hide-password-values, activity.hide-sensitive.`,
    unknownAction: (action) =>
      `Acción de config desconocida: ${action}. Usá get, set o restore-defaults.`,
    flowRecordingLabel: 'flow-recording',
    flowRecordingEnabled: 'habilitado',
    flowRecordingDisabled: 'deshabilitado',
    flowRecordingNotSetViaCli:
      'no configurado por CLI — se aplica el valor por defecto o el elegido en el popup de la extensión (deshabilitado salvo que se haya habilitado en el popup)',
    invalidFlowRecordingValue: (raw) =>
      `Valor de flow-recording inválido: "${raw}". Usá "on" u "off".`,
    flowRecordingSetSaved: (label) => `Grabación de flows configurada a ${label}.`,
    cdpDirectEnabledLabel: 'cdp-direct.enabled',
    cdpDirectPortLabel: 'cdp-direct.port',
    cdpDirectGrantTtlLabel: 'cdp-direct.grant-ttl',
    cdpDirectOn: 'activado',
    cdpDirectOff: 'desactivado (por defecto)',
    invalidCdpDirectEnabledValue: (raw) =>
      `Valor de cdp-direct.enabled inválido: "${raw}". Usá "true" o "false".`,
    cdpDirectEnabledSetSaved: (label) =>
      `cdp-direct.enabled configurado a ${label}. Esto solo no permite que un agente use una pestaña cdp: — corré \`browser-link cdp allow\` para además otorgar el permiso.`,
    invalidCdpDirectPortValue: (raw) =>
      `Valor de cdp-direct.port inválido: "${raw}". Usá un número entero (${MIN_CDP_DIRECT_PORT}-${MAX_CDP_DIRECT_PORT}).`,
    cdpDirectPortSetSaved: (port) => `cdp-direct.port configurado a ${port}.`,
    invalidGrantTtlValue: (raw) =>
      `Valor de cdp-direct.grant-ttl inválido: "${raw}". Usá un número entero de minutos (${MIN_GRANT_TTL_MINUTES}-${MAX_GRANT_TTL_MINUTES}) o "never".`,
    grantTtlNever:
      'nunca (los permisos no expiran hasta revocarlos — reduce la postura de seguridad)',
    cdpDirectGrantTtlSetSaved: (label) =>
      `cdp-direct.grant-ttl (valor por defecto para \`cdp allow\`) configurado a ${label}.`,
    downloadsDirLabel: 'downloads.dir',
    downloadsDirDefaultNote: ' (por defecto)',
    invalidDownloadsDirValue: (raw) =>
      `Valor de downloads.dir inválido: "${raw}". Usá una ruta absoluta, o "default" para <directorio de datos>/downloads.`,
    downloadsDirSetSaved: (dir) =>
      `downloads.dir configurado a ${dir}. browser.download guarda los archivos ahí.`,
    downloadsMaxMbLabel: 'downloads.max-mb',
    downloadsMaxMbValue: (mb) => `${mb} MiB`,
    invalidDownloadsMaxMbValue: (raw) =>
      `Valor de downloads.max-mb inválido: "${raw}". Usá un número entero de MiB (${MIN_DOWNLOADS_MAX_MB}-${MAX_DOWNLOADS_MAX_MB}) o "default".`,
    downloadsMaxMbSetSaved: (label) =>
      `downloads.max-mb configurado a ${label}. Se aplica en la próxima browser.download, sin reiniciar.`,
    downloadsMaxMbCeilingNote: ` ${MAX_DOWNLOADS_MAX_MB} MiB es el máximo: el archivo cruza el socket de la extensión codificado en base64 en un solo mensaje.`,
    allowExecutablesLabel: 'downloads.allow-executables',
    allowExecutablesOn:
      'activado: browser.download puede guardar tipos de archivo ejecutables; en Windows llevan la Mark-of-the-Web',
    allowExecutablesOff:
      'desactivado: browser.download rechaza los tipos de archivo ejecutables (.exe, .msi, .bat, .ps1, .lnk, .js, ...)',
    invalidAllowExecutablesValue: (raw) =>
      `Valor de downloads.allow-executables inválido: "${raw}". Usá "on" u "off".`,
    allowExecutablesSetSaved: (label) =>
      `downloads.allow-executables configurado a ${label}. Se aplica en la próxima descarga, sin reiniciar.`,
    mapLearningLabel: 'map-learning',
    mapLearningOn: 'activado (por defecto)',
    mapLearningOff: 'desactivado',
    invalidMapLearningValue: (raw) => `Valor de map-learning inválido: "${raw}". Usá "on" u "off".`,
    mapLearningSetSaved: (label) =>
      `map-learning configurado a ${label}. Se aplica en la próxima acción del navegador, sin reiniciar. Solo se guardan selectores y claves semánticas, nunca valores escritos.`,
    hidePasswordValuesLabel: 'hide-password-values',
    hidePasswordValuesOn:
      'activado: snapshot y find muestran "filled, N characters" en los campos de contraseña',
    hidePasswordValuesOff:
      'desactivado: snapshot y find devuelven el valor de los campos de contraseña',
    invalidHidePasswordValuesValue: (raw) =>
      `Valor de hide-password-values inválido: "${raw}". Usá "on" u "off".`,
    hidePasswordValuesSetSaved: (label) =>
      `hide-password-values configurado a ${label}. Se aplica en la próxima llamada a snapshot, find o flow, sin reiniciar.`,
    activityHideSensitiveLabel: 'activity.hide-sensitive',
    activityHideSensitiveOn:
      'activado: una fila sensible del registro oculta el valor escrito en todas las columnas',
    activityHideSensitiveOff:
      'desactivado: las filas sensibles del registro se guardan como cualquier otra, sin ocultar nada',
    invalidActivityHideSensitiveValue: (raw) =>
      `Valor de activity.hide-sensitive inválido: "${raw}". Usá "on" u "off".`,
    activityHideSensitiveSetSaved: (label) =>
      `activity.hide-sensitive configurado a ${label}. Se aplica al reiniciar el servidor (reiniciá tu cliente MCP); las filas ya guardadas no se modifican.`,
  },
};

/** One formatted line describing the current `idleTtlMinutes` state, shared
 * by both `config get` (no key — lists everything) and `config get idle-ttl`
 * (just this one). */
export function getIdleTtlLine(language: Language = 'en'): string {
  const t = CFG_I18N[language];
  const cfg = loadConfig();
  const value =
    cfg.idleTtlMinutes === undefined
      ? t.notSetViaCli
      : cfg.idleTtlMinutes === 0
        ? t.never
        : t.minutes(cfg.idleTtlMinutes);
  return `  ${t.idleTtlLabel}   ${value}`;
}

/** One formatted line describing the current `flowRecordingEnabled` state —
 * mirrors `getIdleTtlLine` exactly, shared by `config get` (no key) and
 * `config get flow-recording`. */
export function getFlowRecordingLine(language: Language = 'en'): string {
  const t = CFG_I18N[language];
  const cfg = loadConfig();
  const value =
    cfg.flowRecordingEnabled === undefined
      ? t.flowRecordingNotSetViaCli
      : cfg.flowRecordingEnabled
        ? t.flowRecordingEnabled
        : t.flowRecordingDisabled;
  return `  ${t.flowRecordingLabel}   ${value}`;
}

/** One formatted line describing the current `cdpDirectEnabled` state. */
export function getCdpDirectEnabledLine(language: Language = 'en'): string {
  const t = CFG_I18N[language];
  const cfg = loadConfig();
  const value = cfg.cdpDirectEnabled === true ? t.cdpDirectOn : t.cdpDirectOff;
  return `  ${t.cdpDirectEnabledLabel}   ${value}`;
}

/** One formatted line describing the current `cdpDirectPort` state. */
export function getCdpDirectPortLine(language: Language = 'en'): string {
  const t = CFG_I18N[language];
  const cfg = loadConfig();
  return `  ${t.cdpDirectPortLabel}       ${cfg.cdpDirectPort}`;
}

/** One formatted line describing the current `cdpDirectGrantTtlMinutes`
 * state — the DEFAULT lifetime `browser-link cdp allow` applies when no
 * `--minutes` override is passed, not the state of any grant itself (see
 * `browser-link cdp status` for that). */
export function getCdpDirectGrantTtlLine(language: Language = 'en'): string {
  const t = CFG_I18N[language];
  const cfg = loadConfig();
  const value =
    cfg.cdpDirectGrantTtlMinutes === 0
      ? t.grantTtlNever
      : t.minutes(cfg.cdpDirectGrantTtlMinutes ?? 60);
  return `  ${t.cdpDirectGrantTtlLabel}   ${value}`;
}

export function listConfig(language: Language = 'en'): string {
  const t = CFG_I18N[language];
  return [
    t.header,
    '',
    getIdleTtlLine(language),
    getFlowRecordingLine(language),
    getCdpDirectEnabledLine(language),
    getCdpDirectPortLine(language),
    getCdpDirectGrantTtlLine(language),
    getDownloadsDirLine(language),
    getDownloadsMaxMbLine(language),
    getAllowExecutablesLine(language),
    getMapLearningLine(language),
    getHidePasswordValuesLine(language),
    getActivityHideSensitiveLine(language),
  ].join('\n');
}

/**
 * Parse the CLI's raw `<minutes|never>` argument.
 *
 * Distinct from `clampIdleTtlMinutes` (config.ts) on purpose: that function
 * is a defensive safety net for VALUES THE USER NEVER TYPED (a corrupted
 * config.json, a hand-edited file) — for those, silently falling back to
 * the 30-minute default is the safer failure mode, since there's no one to
 * tell. Here the user just typed something on a terminal RIGHT NOW: a
 * genuinely unparsable value (letters, decimals) gets a clear error instead
 * of a silent substitution, and an out-of-range integer gets clamped to the
 * boundary WITH a note explaining what happened — both are more honest
 * feedback loops for an interactive command than defaulting silently.
 */
function parseIdleTtlArg(raw: string, t: ConfigI18n): { minutes: number; note: string } {
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'never' || normalized === '0') return { minutes: 0, note: '' };
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new Error(t.invalidValue(raw));
  }
  if (parsed < MIN_IDLE_TTL_MINUTES || parsed > MAX_IDLE_TTL_MINUTES) {
    const clamped = Math.min(Math.max(parsed, MIN_IDLE_TTL_MINUTES), MAX_IDLE_TTL_MINUTES);
    return { minutes: clamped, note: t.clampedNote(parsed, clamped) };
  }
  return { minutes: parsed, note: '' };
}

/** Override the IPC endpoint the live push dials. Production callers never
 * set this (defaults to the real 127.0.0.1:17530); tests spin up an
 * ephemeral IpcServer (port: 0) and pass its bound port so the push path
 * is exercised against a real socket instead of always short-circuiting on
 * "no primary reachable". */
export interface IpcPushOptions {
  host?: string;
  port?: number;
}

/** Best-effort live push to an already-running primary over the
 * multi-agent IPC bridge. Never throws — every failure degrades to a
 * message. Failures are NOT collapsed into one diagnosis: an explicit
 * hello-reject (stale/mismatched token, version mismatch) proves a primary
 * IS running and gets `pushRejected`, while connection-refused / timeout /
 * missing-token-file — where "no primary, or multi-agent off" is the
 * honest reading — get `pushUnavailable`.
 *
 * `settings` accepts the same partial shape `SettingsPushPayload` does — an
 * idle-ttl pair, a flow-recording pair, or both — so both `setIdleTtl` and
 * `setFlowRecording` share this one push path instead of two near-copies. */
async function tryPushLive(
  settings: {
    idleTtlMinutes?: number;
    updatedAt?: number;
    flowRecordingEnabled?: boolean;
    flowRecordingUpdatedAt?: number;
  },
  t: ConfigI18n,
  ipcOptions: IpcPushOptions = {},
): Promise<string> {
  const token = readToken();
  if (!token) return t.pushUnavailable;
  const client = new IpcClient();
  try {
    await client.connect(token, {
      host: ipcOptions.host,
      port: ipcOptions.port,
      handshakeTimeoutMs: 1500,
    });
    const ack = await client.sendSettingsPush(settings);
    return ack.notified > 0 ? t.pushedLive(ack.notified) : t.pushedNone;
  } catch (err) {
    // HandshakeError message shapes (see ipc-client.ts): "Primary
    // rejected: <reason>" only when a live primary answered with an
    // explicit hello-reject — timeouts and unexpected frames use other
    // wording, and socket-level failures are not HandshakeErrors at all.
    if (err instanceof HandshakeError && /rejected/i.test(err.message)) {
      return t.pushRejected;
    }
    return t.pushUnavailable;
  } finally {
    await client.disconnect().catch(() => {
      /* best effort */
    });
  }
}

export async function setIdleTtl(
  rawValue: string,
  language: Language = 'en',
  ipcOptions: IpcPushOptions = {},
): Promise<string> {
  const t = CFG_I18N[language];
  // Defensive final pass: parseIdleTtlArg already guarantees an in-range
  // value or 0, so this is a no-op in practice — but it keeps ONE function
  // as the single source of truth for "what counts as a safe stored value",
  // matching the extension side's clampIdleTtlMinutes.
  const { minutes: parsedMinutes, note } = parseIdleTtlArg(rawValue, t);
  const minutes = clampIdleTtlMinutes(parsedMinutes);
  const updatedAt = Date.now();
  saveConfig({ idleTtlMinutes: minutes, idleTtlUpdatedAt: updatedAt });

  const label = (minutes === 0 ? t.never : t.minutes(minutes)) + note;
  const pushMessage = await tryPushLive({ idleTtlMinutes: minutes, updatedAt }, t, ipcOptions);
  return t.setSaved(label) + pushMessage;
}

/**
 * Parse the CLI's raw `<on|off>` argument for `config set flow-recording`.
 * Mirrors `parseIdleTtlArg`'s "tell the user, don't guess" philosophy: a
 * handful of common truthy/falsy spellings are accepted, anything else is a
 * clear error instead of a silent default.
 */
function parseFlowRecordingArg(raw: string, t: ConfigI18n): boolean {
  const normalized = raw.trim().toLowerCase();
  if (['on', 'true', 'enabled', 'enable', '1'].includes(normalized)) return true;
  if (['off', 'false', 'disabled', 'disable', '0'].includes(normalized)) return false;
  throw new Error(t.invalidFlowRecordingValue(raw));
}

export async function setFlowRecording(
  rawValue: string,
  language: Language = 'en',
  ipcOptions: IpcPushOptions = {},
): Promise<string> {
  const t = CFG_I18N[language];
  const enabled = parseFlowRecordingArg(rawValue, t);
  const updatedAt = Date.now();
  saveConfig({ flowRecordingEnabled: enabled, flowRecordingUpdatedAt: updatedAt });

  const label = enabled ? t.flowRecordingEnabled : t.flowRecordingDisabled;
  const pushMessage = await tryPushLive(
    { flowRecordingEnabled: enabled, flowRecordingUpdatedAt: updatedAt },
    t,
    ipcOptions,
  );
  return t.flowRecordingSetSaved(label) + pushMessage;
}

/**
 * Parse the CLI's raw `<true|false>` argument for
 * `config set cdp-direct.enabled`. No IPC live-push counterpart — unlike
 * idle-ttl/flow-recording, cdp-direct has no popup-side value to race
 * against, so this only ever writes config.json.
 */
function parseCdpDirectEnabledArg(raw: string, t: ConfigI18n): boolean {
  const normalized = raw.trim().toLowerCase();
  if (['true', 'on', '1'].includes(normalized)) return true;
  if (['false', 'off', '0'].includes(normalized)) return false;
  throw new Error(t.invalidCdpDirectEnabledValue(raw));
}

export function setCdpDirectEnabled(rawValue: string, language: Language = 'en'): string {
  const t = CFG_I18N[language];
  const enabled = parseCdpDirectEnabledArg(rawValue, t);
  saveConfig({ cdpDirectEnabled: enabled });
  return t.cdpDirectEnabledSetSaved(enabled ? t.cdpDirectOn : t.cdpDirectOff);
}

/** Parse the CLI's raw `<port>` argument for `config set cdp-direct.port`.
 * Same "tell the user, don't guess" philosophy as `parseIdleTtlArg`: a
 * genuinely unparsable value is rejected outright, an out-of-range integer
 * is clamped to the boundary with a note. */
function parseCdpDirectPortArg(raw: string, t: ConfigI18n): { port: number; note: string } {
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new Error(t.invalidCdpDirectPortValue(raw));
  }
  if (parsed < MIN_CDP_DIRECT_PORT || parsed > MAX_CDP_DIRECT_PORT) {
    const clamped = Math.min(Math.max(parsed, MIN_CDP_DIRECT_PORT), MAX_CDP_DIRECT_PORT);
    return { port: clamped, note: t.clampedNote(parsed, clamped) };
  }
  return { port: parsed, note: '' };
}

export function setCdpDirectPort(rawValue: string, language: Language = 'en'): string {
  const t = CFG_I18N[language];
  const { port: parsedPort, note } = parseCdpDirectPortArg(rawValue, t);
  const port = clampCdpDirectPort(parsedPort);
  saveConfig({ cdpDirectPort: port });
  return t.cdpDirectPortSetSaved(port) + note;
}

/**
 * Parse the CLI's raw `<minutes|never>` argument for
 * `config set cdp-direct.grant-ttl` — mirrors `parseIdleTtlArg` exactly,
 * with the grant's own bounds/wording. Exported so `commands/cdp.ts` can
 * reuse the SAME parsing for `cdp allow --minutes`'s per-call override —
 * one implementation of "what counts as a valid TTL argument", not two
 * that could drift.
 */
export function parseGrantTtlArg(raw: string, t: ConfigI18n): { minutes: number; note: string } {
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'never' || normalized === '0') return { minutes: 0, note: '' };
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new Error(t.invalidGrantTtlValue(raw));
  }
  if (parsed < MIN_GRANT_TTL_MINUTES || parsed > MAX_GRANT_TTL_MINUTES) {
    const clamped = Math.min(Math.max(parsed, MIN_GRANT_TTL_MINUTES), MAX_GRANT_TTL_MINUTES);
    return { minutes: clamped, note: t.clampedNote(parsed, clamped) };
  }
  return { minutes: parsed, note: '' };
}

export function setCdpDirectGrantTtl(rawValue: string, language: Language = 'en'): string {
  const t = CFG_I18N[language];
  const { minutes: parsedMinutes, note } = parseGrantTtlArg(rawValue, t);
  const minutes = clampGrantTtlMinutes(parsedMinutes);
  saveConfig({ cdpDirectGrantTtlMinutes: minutes });
  const label = (minutes === 0 ? t.grantTtlNever : t.minutes(minutes)) + note;
  return t.cdpDirectGrantTtlSetSaved(label);
}

/** Config keys `cdp-direct.*` this module knows — shared by `get`/`set`
 * dispatch below so the branching stays a lookup, not repeated equality
 * chains. */
const CDP_DIRECT_KEYS = ['cdp-direct.enabled', 'cdp-direct.port', 'cdp-direct.grant-ttl'] as const;
type CdpDirectKey = (typeof CDP_DIRECT_KEYS)[number];

function isCdpDirectKey(key: string): key is CdpDirectKey {
  return (CDP_DIRECT_KEYS as readonly string[]).includes(key);
}

function getCdpDirectLine(key: CdpDirectKey, language: Language): string {
  if (key === 'cdp-direct.enabled') return getCdpDirectEnabledLine(language);
  if (key === 'cdp-direct.port') return getCdpDirectPortLine(language);
  return getCdpDirectGrantTtlLine(language);
}

function setCdpDirectKey(key: CdpDirectKey, value: string, language: Language): string {
  if (key === 'cdp-direct.enabled') return setCdpDirectEnabled(value, language);
  if (key === 'cdp-direct.port') return setCdpDirectPort(value, language);
  return setCdpDirectGrantTtl(value, language);
}

/** One formatted line describing where `browser.download` writes files. */
export function getDownloadsDirLine(language: Language = 'en'): string {
  const t = CFG_I18N[language];
  const cfg = loadConfig();
  const dir = resolveDownloadsDir(cfg, getDataDir());
  const note = cfg.downloadsDir === undefined ? t.downloadsDirDefaultNote : '';
  return `  ${t.downloadsDirLabel}   ${dir}${note}`;
}

/**
 * `config set downloads.dir <absolute-path|default>`. Absolute only: a
 * relative path would silently resolve against whatever directory the MCP
 * server happened to be launched from. `default` clears the override.
 */
export function setDownloadsDir(rawValue: string, language: Language = 'en'): string {
  const t = CFG_I18N[language];
  const value = rawValue.trim();
  if (value.toLowerCase() === 'default') {
    saveConfig({ downloadsDir: undefined });
    return t.downloadsDirSetSaved(resolveDownloadsDir({}, getDataDir()));
  }
  if (value.length === 0 || !isAbsolute(value)) {
    throw new Error(t.invalidDownloadsDirValue(rawValue));
  }
  saveConfig({ downloadsDir: value });
  return t.downloadsDirSetSaved(value);
}

/** One formatted line describing `browser.download`'s per-file size cap. */
export function getDownloadsMaxMbLine(language: Language = 'en'): string {
  const t = CFG_I18N[language];
  const cfg = loadConfig();
  const mb = sanitizeDownloadsMaxMb(cfg.downloadsMaxMb);
  const note = cfg.downloadsMaxMb === undefined ? t.downloadsDirDefaultNote : '';
  return `  ${t.downloadsMaxMbLabel}   ${t.downloadsMaxMbValue(mb)}${note}`;
}

/**
 * `config set downloads.max-mb <1..64|default>`. Same "tell the user,
 * don't guess" rule as `parseIdleTtlArg`: a value that is not a whole
 * number is refused, an out-of-range one is clamped to [1, 64] with a note
 * (64 MiB is a hard ceiling, see MAX_DOWNLOADS_MAX_MB). `default` removes the key (25 MiB). No live
 * push: the server reads config.json on every download.
 */
export function setDownloadsMaxMb(rawValue: string, language: Language = 'en'): string {
  const t = CFG_I18N[language];
  const value = rawValue.trim();
  if (value.toLowerCase() === 'default') {
    saveConfig({ downloadsMaxMb: undefined });
    return t.downloadsMaxMbSetSaved(
      t.downloadsMaxMbValue(DEFAULT_DOWNLOADS_MAX_MB) + t.downloadsDirDefaultNote,
    );
  }
  const parsed = Number(value);
  if (value.length === 0 || !Number.isInteger(parsed)) {
    throw new Error(t.invalidDownloadsMaxMbValue(rawValue));
  }
  const mb = Math.min(Math.max(parsed, MIN_DOWNLOADS_MAX_MB), MAX_DOWNLOADS_MAX_MB);
  const note = mb === parsed ? '' : t.clampedNote(parsed, mb);
  saveConfig({ downloadsMaxMb: mb });
  const ceiling = parsed > MAX_DOWNLOADS_MAX_MB ? t.downloadsMaxMbCeilingNote : '';
  return t.downloadsMaxMbSetSaved(t.downloadsMaxMbValue(mb) + note) + ceiling;
}

/** One formatted line describing whether browser.download saves executable types. */
export function getAllowExecutablesLine(language: Language = 'en'): string {
  const t = CFG_I18N[language];
  const value = onOffLabel(
    allowsExecutableDownloads(loadConfig()),
    DEFAULT_ALLOW_EXECUTABLE_DOWNLOADS,
    t.allowExecutablesOn,
    t.allowExecutablesOff,
    t,
  );
  return `  ${t.allowExecutablesLabel}   ${value}`;
}

/**
 * `config set downloads.allow-executables <on|off>`. Console only: it widens
 * what an agent may do (see admin/descriptor.ts). "on" writes `true`; "off"
 * removes the key (off is the default). No live push: the server reads
 * config.json on every download.
 */
export function setAllowExecutables(rawValue: string, language: Language = 'en'): string {
  const t = CFG_I18N[language];
  const allow = parseOnOff(rawValue, t.invalidAllowExecutablesValue);
  saveConfig({ allowExecutableDownloads: allow ? true : undefined });
  return t.allowExecutablesSetSaved(
    onOffLabel(
      allow,
      DEFAULT_ALLOW_EXECUTABLE_DOWNLOADS,
      t.allowExecutablesOn,
      t.allowExecutablesOff,
      t,
    ),
  );
}

/** One formatted line describing the `mapLearningEnabled` state. Only an
 * explicit `false` is off, same rule the learner applies. */
export function getMapLearningLine(language: Language = 'en'): string {
  const t = CFG_I18N[language];
  const value = loadConfig().mapLearningEnabled === false ? t.mapLearningOff : t.mapLearningOn;
  return `  ${t.mapLearningLabel}   ${value}`;
}

function parseMapLearningArg(raw: string, t: ConfigI18n): boolean {
  const normalized = raw.trim().toLowerCase();
  if (['on', 'true', '1'].includes(normalized)) return true;
  if (['off', 'false', '0'].includes(normalized)) return false;
  throw new Error(t.invalidMapLearningValue(raw));
}

/**
 * `config set map-learning <on|off>`. "on" clears the key (on is the
 * default, so config.json stays minimal); "off" writes `false`. No live
 * push: the learner reads config.json on every call.
 */
export function setMapLearning(rawValue: string, language: Language = 'en'): string {
  const t = CFG_I18N[language];
  const enabled = parseMapLearningArg(rawValue, t);
  saveConfig({ mapLearningEnabled: enabled ? undefined : false });
  return t.mapLearningSetSaved(enabled ? t.mapLearningOn : t.mapLearningOff);
}

/** `on` / `off` of the two hide switches, the spellings map-learning takes. */
function parseOnOff(raw: string, invalid: (raw: string) => string): boolean {
  const normalized = raw.trim().toLowerCase();
  if (['on', 'true', '1'].includes(normalized)) return true;
  if (['off', 'false', '0'].includes(normalized)) return false;
  throw new Error(invalid(raw));
}

/** The label of one hide switch, with the default note when it is the default. */
function onOffLabel(
  value: boolean,
  fallback: boolean,
  on: string,
  off: string,
  t: ConfigI18n,
): string {
  return (value ? on : off) + (value === fallback ? t.downloadsDirDefaultNote : '');
}

/** One formatted line describing the hide-password-values setting (D12). */
export function getHidePasswordValuesLine(language: Language = 'en'): string {
  const t = CFG_I18N[language];
  const value = onOffLabel(
    hidesPasswordValues(loadConfig()),
    DEFAULT_HIDE_PASSWORD_VALUES,
    t.hidePasswordValuesOn,
    t.hidePasswordValuesOff,
    t,
  );
  return `  ${t.hidePasswordValuesLabel}   ${value}`;
}

/**
 * `config set hide-password-values <on|off>` (owner decision D12). Writes
 * the boolean; no live push: the server reads it on every snapshot, find and
 * flow, so it applies to the next call.
 */
export function setHidePasswordValues(rawValue: string, language: Language = 'en'): string {
  const t = CFG_I18N[language];
  const hide = parseOnOff(rawValue, t.invalidHidePasswordValuesValue);
  saveConfig({ hidePasswordValues: hide });
  return t.hidePasswordValuesSetSaved(
    onOffLabel(
      hide,
      DEFAULT_HIDE_PASSWORD_VALUES,
      t.hidePasswordValuesOn,
      t.hidePasswordValuesOff,
      t,
    ),
  );
}

/** One formatted line describing the activity.hide-sensitive setting (D13). */
export function getActivityHideSensitiveLine(language: Language = 'en'): string {
  const t = CFG_I18N[language];
  const value = onOffLabel(
    activityHidesSensitive(loadConfig()),
    DEFAULT_ACTIVITY_HIDE_SENSITIVE,
    t.activityHideSensitiveOn,
    t.activityHideSensitiveOff,
    t,
  );
  return `  ${t.activityHideSensitiveLabel}   ${value}`;
}

/**
 * `config set activity.hide-sensitive <on|off>` (owner decision D13). Read
 * once when the primary wires the trail, so it applies after a restart; rows
 * already stored are never rewritten.
 */
export function setActivityHideSensitive(rawValue: string, language: Language = 'en'): string {
  const t = CFG_I18N[language];
  const hide = parseOnOff(rawValue, t.invalidActivityHideSensitiveValue);
  saveConfig({ activityHideSensitive: hide });
  return t.activityHideSensitiveSetSaved(
    onOffLabel(
      hide,
      DEFAULT_ACTIVITY_HIDE_SENSITIVE,
      t.activityHideSensitiveOn,
      t.activityHideSensitiveOff,
      t,
    ),
  );
}

interface RestoreI18n {
  restored: string;
  unreadable: (path: string) => string;
  error: string;
  copyKept: string;
  lostHeader: string;
  inEffectHeader: string;
  notSet: string;
  worksAgain: string;
  preview: string;
  previewConfirm: string;
  readable: (path: string) => string;
  missing: (path: string) => string;
  keys: Record<keyof BrowserLinkConfig, string>;
}

/** Exported for the console's config screen, which shows the same text. */
export const RESTORE_I18N: Record<Language, RestoreI18n> = {
  en: {
    restored: 'Restored the default settings.',
    unreadable: (path) => `config.json could not be read: ${path}`,
    error: 'error:',
    copyKept: 'The unreadable file was kept, byte for byte, at:',
    lostHeader:
      'The custom settings of the old file are no longer in effect. Re-enter the ones you want from that copy, in config.json or with the commands that set them:',
    inEffectHeader: 'In effect now (the defaults):',
    notSet: 'not set',
    worksAgain:
      'browser-link works again with these settings. A browser-link server that started while the file was unreadable keeps refusing until you restart your MCP client.',
    preview:
      'Restoring keeps a copy of it next to it (config.json.unreadable-<date and time>), then writes the default settings; the custom settings in it stop applying until you re-enter them.',
    previewConfirm: 'Nothing was changed. Re-run with --yes to confirm:',
    readable: (path) =>
      `config.json can be read (${path}): there is nothing to restore. Nothing was changed.`,
    missing: (path) =>
      `There is no config.json (${path}): the default settings are already in effect. Nothing was changed.`,
    keys: {
      peerExecutablePaths:
        'strict mode: the browser executable paths allowed to connect (not set: off)',
      allowedExtensionIds: 'extra extension ids allowed to connect (the pinned id always is)',
      disabledTools: 'MCP tools you disabled (browser-link tools)',
      multiAgent: 'multi-agent mode (browser-link multi-agent)',
      autoReelect: 'auto-reelect (browser-link multi-agent auto-reelect)',
      cdpDirectEnabled: 'cdp-direct mode (config set cdp-direct.enabled)',
      cdpDirectPort: 'cdp-direct port (config set cdp-direct.port)',
      cdpDirectGrantTtlMinutes:
        'default lifetime of a cdp-direct grant, in minutes (config set cdp-direct.grant-ttl)',
      idleTtlMinutes:
        "idle-disconnect TTL, in minutes (config set idle-ttl; not set: the extension's own choice)",
      idleTtlUpdatedAt: 'when idle-ttl was last set from the CLI',
      language: 'console language',
      flowRecordingEnabled:
        "flow recording (config set flow-recording; not set: the extension's own choice)",
      flowRecordingUpdatedAt: 'when flow-recording was last set from the CLI',
      activityEnabled: 'activity trail recording',
      activityRecordPayloads: 'whether the activity trail keeps the text an action moved',
      mapLearningEnabled: 'map learning (config set map-learning)',
      hidePasswordValues:
        'snapshot and find hide the values of password fields (config set hide-password-values)',
      activityHideSensitive:
        'a sensitive trail row hides the typed value in every column (config set activity.hide-sensitive)',
      downloadsDir:
        'folder browser.download writes into (config set downloads.dir; not set: <data dir>/downloads)',
      downloadsMaxMb: 'per-file size cap of browser.download, in MiB (config set downloads.max-mb)',
      allowExecutableDownloads:
        'browser.download may save executable file types (config set downloads.allow-executables)',
      instructionsAutoRefresh: 'refresh of the agent-instructions blocks at server start',
      skipWelcome: 'the console skips its welcome screen',
      noticeAcknowledged: 'you confirmed the product notice in the console',
    },
  },
  es: {
    restored: 'Se restauró la configuración por defecto.',
    unreadable: (path) => `No se pudo leer config.json: ${path}`,
    error: 'error:',
    copyKept: 'El archivo ilegible se guardó, byte a byte, en:',
    lostHeader:
      'La configuración personalizada del archivo viejo ya no está en efecto. Volvé a cargar la que quieras desde esa copia, en config.json o con los comandos que la configuran:',
    inEffectHeader: 'En efecto ahora (los valores por defecto):',
    notSet: 'sin valor',
    worksAgain:
      'browser-link vuelve a funcionar con esta configuración. Un servidor de browser-link que arrancó mientras el archivo era ilegible sigue rechazando hasta que reinicies tu cliente MCP.',
    preview:
      'Restaurar guarda una copia al lado (config.json.unreadable-<fecha y hora>) y después escribe la configuración por defecto; la configuración personalizada que tenía deja de aplicarse hasta que la vuelvas a cargar.',
    previewConfirm: 'No se cambió nada. Volvé a correrlo con --yes para confirmar:',
    readable: (path) =>
      `config.json se puede leer (${path}): no hay nada que restaurar. No se cambió nada.`,
    missing: (path) =>
      `No hay config.json (${path}): ya está en efecto la configuración por defecto. No se cambió nada.`,
    keys: {
      peerExecutablePaths:
        'modo estricto: rutas de los ejecutables de navegador que pueden conectarse (sin valor: desactivado)',
      allowedExtensionIds:
        'ids de extensión extra que pueden conectarse (el id fijado siempre puede)',
      disabledTools: 'tools MCP que deshabilitaste (browser-link tools)',
      multiAgent: 'modo multi-agente (browser-link multi-agent)',
      autoReelect: 're-elección automática (browser-link multi-agent auto-reelect)',
      cdpDirectEnabled: 'modo cdp-direct (config set cdp-direct.enabled)',
      cdpDirectPort: 'puerto de cdp-direct (config set cdp-direct.port)',
      cdpDirectGrantTtlMinutes:
        'duración por defecto de un permiso de cdp-direct, en minutos (config set cdp-direct.grant-ttl)',
      idleTtlMinutes:
        'TTL de auto-desconexión, en minutos (config set idle-ttl; sin valor: lo que elija la extensión)',
      idleTtlUpdatedAt: 'cuándo se configuró idle-ttl por última vez desde la CLI',
      language: 'idioma de la consola',
      flowRecordingEnabled:
        'grabación de flows (config set flow-recording; sin valor: lo que elija la extensión)',
      flowRecordingUpdatedAt: 'cuándo se configuró flow-recording por última vez desde la CLI',
      activityEnabled: 'registro del rastro de actividad',
      activityRecordPayloads: 'si el rastro de actividad guarda el texto que movió cada acción',
      mapLearningEnabled: 'aprendizaje del mapa (config set map-learning)',
      hidePasswordValues:
        'snapshot y find ocultan el valor de los campos de contraseña (config set hide-password-values)',
      activityHideSensitive:
        'una fila sensible del rastro de actividad oculta el valor escrito en todas las columnas (config set activity.hide-sensitive)',
      downloadsDir:
        'carpeta donde browser.download guarda los archivos (config set downloads.dir; sin valor: <directorio de datos>/downloads)',
      downloadsMaxMb:
        'tamaño máximo por archivo de browser.download, en MiB (config set downloads.max-mb)',
      allowExecutableDownloads:
        'browser.download puede guardar tipos de archivo ejecutables (config set downloads.allow-executables)',
      instructionsAutoRefresh: 'refresco de los bloques de instrucciones al arrancar el servidor',
      skipWelcome: 'la consola salta su pantalla de bienvenida',
      noticeAcknowledged: 'confirmaste el aviso del producto en la consola',
    },
  },
};

function settingValue(value: unknown, t: RestoreI18n): string {
  return value === undefined ? t.notSet : JSON.stringify(value);
}

/** What `config restore-defaults` did, in `language`: the copy, every
 * setting that stopped applying, and every value in effect now. The keys
 * come from `RESTORE_I18N.keys` (every persisted key, checked by the type)
 * and the values from `result.inEffect` (`defaultSettings`). */
export function formatRestoreResult(result: RestoreDefaultsResult, language: Language): string {
  const t = RESTORE_I18N[language];
  if (!result.restored) {
    return result.state === 'ok' ? t.readable(result.path) : t.missing(result.path);
  }
  const keys = Object.keys(t.keys) as (keyof BrowserLinkConfig)[];
  const width = Math.max(...keys.map((k) => k.length)) + 2;
  return [
    t.restored,
    '',
    t.unreadable(result.path),
    `  ${t.error} ${result.error}`,
    t.copyKept,
    `  ${result.backupPath}`,
    '',
    t.lostHeader,
    ...keys.map((k) => `  ${k.padEnd(width)}${t.keys[k]}`),
    '',
    t.inEffectHeader,
    ...keys.map((k) => `  ${k.padEnd(width)}${settingValue(result.inEffect[k], t)}`),
    '',
    t.worksAgain,
  ].join('\n');
}

/** `browser-link config restore-defaults [--yes]`. Without `--yes`, like the
 * other destructive commands, it only says what it would do. */
export function restoreDefaults(argv: string[], language: Language = 'en'): string {
  const t = RESTORE_I18N[language];
  const yes = readArgs('config restore-defaults', argv, language).has('yes');
  const read = readConfig();
  if (read.state === 'unreadable' && !yes) {
    return [
      t.unreadable(read.path),
      `  ${t.error} ${read.error}`,
      t.preview,
      t.previewConfirm,
      '  browser-link config restore-defaults --yes',
    ].join('\n');
  }
  return formatRestoreResult(restoreDefaultConfig(), language);
}

export async function runConfigCommand(argv: string[], language: Language = 'en'): Promise<string> {
  const t = CFG_I18N[language];
  const action = argv.at(0);
  if (action === 'restore-defaults') return restoreDefaults(argv.slice(1), language);
  if (action !== undefined && action !== 'get' && action !== 'set') {
    throw new Error(t.unknownAction(action));
  }
  // `get` and `set` take plain words only; an option or an extra word is
  // refused before anything is read or written.
  const words =
    action === undefined ? [] : readArgs(`config ${action}`, argv.slice(1), language).positionals;
  const key = words.at(0);
  const value = words.at(1);

  if (action === undefined || action === 'get') {
    if (key === undefined) return listConfig(language);
    if (key === 'idle-ttl') return getIdleTtlLine(language);
    if (key === 'flow-recording') return getFlowRecordingLine(language);
    if (isCdpDirectKey(key)) return getCdpDirectLine(key, language);
    if (key === 'downloads.dir') return getDownloadsDirLine(language);
    if (key === 'downloads.max-mb') return getDownloadsMaxMbLine(language);
    if (key === 'downloads.allow-executables') return getAllowExecutablesLine(language);
    if (key === 'map-learning') return getMapLearningLine(language);
    if (key === 'hide-password-values') return getHidePasswordValuesLine(language);
    if (key === 'activity.hide-sensitive') return getActivityHideSensitiveLine(language);
    throw new Error(t.unknownKey(key));
  }
  // `set` is the only action left.
  if (key === undefined) throw new Error(t.usage);
  if (key === 'idle-ttl' || key === 'flow-recording') {
    if (value === undefined) throw new Error(t.usage);
    return key === 'idle-ttl' ? setIdleTtl(value, language) : setFlowRecording(value, language);
  }
  if (isCdpDirectKey(key)) {
    if (value === undefined) throw new Error(t.usage);
    return setCdpDirectKey(key, value, language);
  }
  if (key === 'downloads.dir') {
    if (value === undefined) throw new Error(t.usage);
    return setDownloadsDir(value, language);
  }
  if (key === 'downloads.max-mb') {
    if (value === undefined) throw new Error(t.usage);
    return setDownloadsMaxMb(value, language);
  }
  if (key === 'downloads.allow-executables') {
    if (value === undefined) throw new Error(t.usage);
    return setAllowExecutables(value, language);
  }
  if (key === 'map-learning') {
    if (value === undefined) throw new Error(t.usage);
    return setMapLearning(value, language);
  }
  if (key === 'hide-password-values') {
    if (value === undefined) throw new Error(t.usage);
    return setHidePasswordValues(value, language);
  }
  if (key === 'activity.hide-sensitive') {
    if (value === undefined) throw new Error(t.usage);
    return setActivityHideSensitive(value, language);
  }
  throw new Error(t.unknownKey(key));
}
