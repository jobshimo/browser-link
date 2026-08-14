import {
  MAX_CDP_DIRECT_PORT,
  MAX_GRANT_TTL_MINUTES,
  MAX_IDLE_TTL_MINUTES,
  MIN_CDP_DIRECT_PORT,
  MIN_GRANT_TTL_MINUTES,
  MIN_IDLE_TTL_MINUTES,
  clampCdpDirectPort,
  clampGrantTtlMinutes,
  clampIdleTtlMinutes,
  loadConfig,
  saveConfig,
} from '../config.js';
import { HandshakeError, IpcClient } from '../bridge/ipc-client.js';
import { readToken } from '../bridge/token.js';
import type { Language } from './welcome.js';

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
      'Usage: browser-link config get [idle-ttl|flow-recording|cdp-direct.enabled|cdp-direct.port|cdp-direct.grant-ttl] | browser-link config set idle-ttl <minutes|never> | browser-link config set flow-recording <on|off> | browser-link config set cdp-direct.enabled <true|false> | browser-link config set cdp-direct.port <port> | browser-link config set cdp-direct.grant-ttl <minutes|never>',
    unknownKey: (key) =>
      `Unknown config key: ${key}. Known keys: idle-ttl, flow-recording, cdp-direct.enabled, cdp-direct.port, cdp-direct.grant-ttl.`,
    unknownAction: (action) => `Unknown config action: ${action}. Use get or set.`,
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
      'Uso: browser-link config get [idle-ttl|flow-recording|cdp-direct.enabled|cdp-direct.port|cdp-direct.grant-ttl] | browser-link config set idle-ttl <minutos|never> | browser-link config set flow-recording <on|off> | browser-link config set cdp-direct.enabled <true|false> | browser-link config set cdp-direct.port <puerto> | browser-link config set cdp-direct.grant-ttl <minutos|never>',
    unknownKey: (key) =>
      `Clave de configuración desconocida: ${key}. Claves conocidas: idle-ttl, flow-recording, cdp-direct.enabled, cdp-direct.port, cdp-direct.grant-ttl.`,
    unknownAction: (action) => `Acción de config desconocida: ${action}. Usá get o set.`,
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

export async function runConfigCommand(argv: string[], language: Language = 'en'): Promise<string> {
  const t = CFG_I18N[language];
  const action = argv.at(0);
  const key = argv.at(1);
  const value = argv.at(2);

  if (action === undefined || action === 'get') {
    if (key === undefined) return listConfig(language);
    if (key === 'idle-ttl') return getIdleTtlLine(language);
    if (key === 'flow-recording') return getFlowRecordingLine(language);
    if (isCdpDirectKey(key)) return getCdpDirectLine(key, language);
    throw new Error(t.unknownKey(key));
  }
  if (action === 'set') {
    if (key === undefined) throw new Error(t.usage);
    if (key === 'idle-ttl' || key === 'flow-recording') {
      if (value === undefined) throw new Error(t.usage);
      return key === 'idle-ttl' ? setIdleTtl(value, language) : setFlowRecording(value, language);
    }
    if (isCdpDirectKey(key)) {
      if (value === undefined) throw new Error(t.usage);
      return setCdpDirectKey(key, value, language);
    }
    throw new Error(t.unknownKey(key));
  }
  throw new Error(t.unknownAction(action));
}
