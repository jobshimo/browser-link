import {
  MAX_IDLE_TTL_MINUTES,
  MIN_IDLE_TTL_MINUTES,
  clampIdleTtlMinutes,
  loadConfig,
  saveConfig,
} from '../config.js';
import { HandshakeError, IpcClient } from '../bridge/ipc-client.js';
import { readToken } from '../bridge/token.js';
import type { Language } from './welcome.js';

/**
 * `browser-link config` — scriptable CLI surface for settings that are also
 * editable from the extension's popup. Today that's just the idle-disconnect
 * TTL (see `packages/extension/src/idle-policy.ts`); `get`/`set` are
 * structured as `<action> <key> [value]` so a future second setting slots in
 * without a redesign.
 *
 *   browser-link config get                 Show every known setting.
 *   browser-link config get idle-ttl        Show just the idle-ttl setting.
 *   browser-link config set idle-ttl <minutes|never>
 *
 * Precedence with the popup: both editors write to ONE logical value —
 * last write wins, decided by comparing `updatedAt` epoch-ms timestamps
 * (see messages.ts's SettingsUpdatePayload doc and the README's "Idle
 * disconnect" section). `config set` here:
 *   1. Persists `{ idleTtlMinutes, idleTtlUpdatedAt: Date.now() }` to
 *      config.json — this is what a NEW tab connecting later reads (see
 *      ws-bridge.ts's `tab.register` handler).
 *   2. Best-effort pushes the same value to every ALREADY connected tab
 *      right now, over the multi-agent IPC bridge (127.0.0.1:17530) — the
 *      one existing local control channel into a running primary. This
 *      requires a primary to be up AND multi-agent mode enabled (the
 *      default); when neither holds, the CLI says so plainly and the value
 *      still applies the next time a tab (re)connects.
 */

interface ConfigI18n {
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
}

const CFG_I18N: Record<Language, ConfigI18n> = {
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
      'Usage: browser-link config get [idle-ttl] | browser-link config set idle-ttl <minutes|never>',
    unknownKey: (key) => `Unknown config key: ${key}. Known keys: idle-ttl.`,
    unknownAction: (action) => `Unknown config action: ${action}. Use get or set.`,
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
      'Uso: browser-link config get [idle-ttl] | browser-link config set idle-ttl <minutos|never>',
    unknownKey: (key) => `Clave de configuración desconocida: ${key}. Claves conocidas: idle-ttl.`,
    unknownAction: (action) => `Acción de config desconocida: ${action}. Usá get o set.`,
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

export function listConfig(language: Language = 'en'): string {
  const t = CFG_I18N[language];
  return [t.header, '', getIdleTtlLine(language)].join('\n');
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
 * honest reading — get `pushUnavailable`. */
async function tryPushLive(
  settings: { idleTtlMinutes: number; updatedAt: number },
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

export async function runConfigCommand(argv: string[], language: Language = 'en'): Promise<string> {
  const t = CFG_I18N[language];
  const action = argv.at(0);
  const key = argv.at(1);
  const value = argv.at(2);

  if (action === undefined || action === 'get') {
    if (key === undefined) return listConfig(language);
    if (key === 'idle-ttl') return getIdleTtlLine(language);
    throw new Error(t.unknownKey(key));
  }
  if (action === 'set') {
    if (key === undefined) throw new Error(t.usage);
    if (key !== 'idle-ttl') throw new Error(t.unknownKey(key));
    if (value === undefined) throw new Error(t.usage);
    return setIdleTtl(value, language);
  }
  throw new Error(t.unknownAction(action));
}
