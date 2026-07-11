import { clampGrantTtlMinutes, loadConfig, sanitizeCdpPort, saveConfig } from '../config.js';
import {
  clearGrant,
  grantFilePath,
  isGrantLive,
  loadGrant,
  remainingMs,
  saveGrant,
} from '../cdp/grant.js';
import { isChromeDevtoolsEndpoint } from '../cdp/targets.js';
import { CFG_I18N, parseGrantTtlArg } from './config.js';
import type { Language } from './welcome.js';

/**
 * `browser-link cdp` — the human-only side of cdp-direct's permission
 * model. `browser-link config set cdp-direct.enabled <true|false>` turns
 * the FEATURE on/off; this command family manages the separate,
 * time-boxed GRANT that must ALSO be live before any tool may address a
 * `cdp:` tab (see `cdp/gate.ts`'s two-step check). An agent has no path to
 * either — both are terminal-only, by design.
 *
 *   browser-link cdp allow [--minutes N]   Record a grant.
 *   browser-link cdp revoke                Clear the current grant.
 *   browser-link cdp status                Show enabled/port/grant/reachability.
 */

interface CdpI18n {
  usage: string;
  unknownAction: (action: string) => string;
  allowSaved: (expiryLabel: string) => string;
  allowNeverNote: string;
  disabledNote: string;
  revoked: string;
  noGrantToRevoke: string;
  revokeFailedDisabled: (path: string, reason: string) => string;
  revokeFailedBoth: (path: string, reason: string, disableReason: string) => string;
  statusHeader: string;
  enabledLabel: string;
  portLabel: string;
  grantLabel: string;
  grantNone: string;
  grantNever: string;
  grantExpired: string;
  grantRemaining: (minutes: number) => string;
  reachableLabel: string;
  yes: string;
  no: string;
  never: string;
}

const CDP_I18N: Record<Language, CdpI18n> = {
  en: {
    usage: 'Usage: browser-link cdp <allow|revoke|status> [--minutes N]',
    unknownAction: (action) => `Unknown cdp action: ${action}. Use allow, revoke or status.`,
    allowSaved: (expiryLabel) =>
      `cdp-direct grant recorded — expires ${expiryLabel}. Revoke any time with \`browser-link cdp revoke\`.`,
    allowNeverNote:
      ' WARNING: this grant never expires until revoked — reduces the security posture.',
    disabledNote:
      ' Note: cdp-direct.enabled is currently off — run `browser-link config set cdp-direct.enabled true` for the grant to take effect.',
    revoked: 'cdp-direct grant revoked.',
    noGrantToRevoke: 'No cdp-direct grant was active.',
    revokeFailedDisabled: (path, reason) =>
      `Could not remove the grant file: ${path} — ${reason}. As a safeguard, cdp-direct has been DISABLED (cdp-direct.enabled=false); re-enable it with \`browser-link config set cdp-direct.enabled true\` once you have deleted the file.`,
    revokeFailedBoth: (path, reason, disableReason) =>
      `Could not remove the grant file: ${path} — ${reason}. The safeguard ALSO failed to disable cdp-direct: ${disableReason}. cdp-direct MAY STILL BE ACTIVE — delete the grant file manually and run \`browser-link config set cdp-direct.enabled false\`.`,
    statusHeader: 'cdp-direct status',
    enabledLabel: 'enabled',
    portLabel: 'port',
    grantLabel: 'grant',
    grantNone: 'none — run `browser-link cdp allow` to grant access',
    grantNever: 'active, never expires',
    grantExpired: 'expired — run `browser-link cdp allow` to grant access again',
    grantRemaining: (minutes) => `active, ${minutes} min remaining`,
    reachableLabel: 'Chrome DevTools endpoint reachable',
    yes: 'yes',
    no: 'no',
    never: 'never',
  },
  es: {
    usage: 'Uso: browser-link cdp <allow|revoke|status> [--minutes N]',
    unknownAction: (action) => `Acción de cdp desconocida: ${action}. Usá allow, revoke o status.`,
    allowSaved: (expiryLabel) =>
      `Permiso de cdp-direct registrado — expira ${expiryLabel}. Revocalo en cualquier momento con \`browser-link cdp revoke\`.`,
    allowNeverNote:
      ' ADVERTENCIA: este permiso no expira hasta que lo revoques — reduce la postura de seguridad.',
    disabledNote:
      ' Nota: cdp-direct.enabled está apagado actualmente — corré `browser-link config set cdp-direct.enabled true` para que el permiso tenga efecto.',
    revoked: 'Permiso de cdp-direct revocado.',
    noGrantToRevoke: 'No había ningún permiso de cdp-direct activo.',
    revokeFailedDisabled: (path, reason) =>
      `No se pudo eliminar el archivo de permiso: ${path} — ${reason}. Como salvaguarda, cdp-direct fue DESHABILITADO (cdp-direct.enabled=false); volvé a habilitarlo con \`browser-link config set cdp-direct.enabled true\` una vez que hayas eliminado el archivo.`,
    revokeFailedBoth: (path, reason, disableReason) =>
      `No se pudo eliminar el archivo de permiso: ${path} — ${reason}. La salvaguarda TAMBIÉN falló al deshabilitar cdp-direct: ${disableReason}. cdp-direct PUEDE SEGUIR ACTIVO — eliminá el archivo de permiso manualmente y corré \`browser-link config set cdp-direct.enabled false\`.`,
    statusHeader: 'Estado de cdp-direct',
    enabledLabel: 'habilitado',
    portLabel: 'puerto',
    grantLabel: 'permiso',
    grantNone: 'ninguno — corré `browser-link cdp allow` para otorgar acceso',
    grantNever: 'activo, nunca expira',
    grantExpired: 'expirado — corré `browser-link cdp allow` para otorgar acceso de nuevo',
    grantRemaining: (minutes) => `activo, ${minutes} min restantes`,
    reachableLabel: 'endpoint de Chrome DevTools alcanzable',
    yes: 'sí',
    no: 'no',
    never: 'nunca',
  },
};

function parseMinutesFlag(argv: string[]): string | undefined {
  const idx = argv.indexOf('--minutes');
  if (idx === -1 || idx === argv.length - 1) return undefined;
  return argv[idx + 1];
}

function formatExpiry(expiresAt: number | null, t: CdpI18n): string {
  if (expiresAt === null) return t.never;
  return new Date(expiresAt).toISOString();
}

/** `browser-link cdp allow [--minutes N]`. Records a grant whose lifetime
 * is `--minutes` when given (parsed with the SAME rules
 * `config set cdp-direct.grant-ttl` uses — see `parseGrantTtlArg`), or the
 * configured `cdp-direct.grant-ttl` default otherwise. `0`/`never` records
 * a grant that never expires. */
export function allowCdpDirect(argv: string[], language: Language = 'en'): string {
  const t = CDP_I18N[language];
  const cfg = loadConfig();
  const rawMinutes = parseMinutesFlag(argv);
  const { minutes: parsedMinutes, note } =
    rawMinutes !== undefined
      ? parseGrantTtlArg(rawMinutes, CFG_I18N[language])
      : { minutes: cfg.cdpDirectGrantTtlMinutes ?? 60, note: '' };
  const minutes = clampGrantTtlMinutes(parsedMinutes);
  const grant = saveGrant(minutes);

  let message = t.allowSaved(formatExpiry(grant.expiresAt, t)) + note;
  if (grant.expiresAt === null) message += t.allowNeverNote;
  if (cfg.cdpDirectEnabled !== true) message += t.disabledNote;
  return message;
}

/** `browser-link cdp revoke`. Idempotent — revoking with nothing active
 * says so instead of pretending something happened.
 *
 * Fails CLOSED. The realistic failure mode on Windows is a file-lock /
 * sharing-violation that blocks DELETION while the file stays READABLE — so
 * the grant file survives, `loadGrant` reads it fine, and the gate's grant
 * check would keep returning `{ ok: true }` after the user believes they
 * revoked. To make revoke genuinely fail-closed we ALSO flip
 * `cdp-direct.enabled=false` (a DIFFERENT file — config.json — unlikely to
 * share the grant file's lock) as a defense-in-depth fallback, so the
 * gate's FIRST check (enabled) denies even though the stale grant file
 * survives. If disabling ALSO fails, we surface both facts loudly. Either
 * way this THROWS — the CLI dispatcher turns the throw into a non-zero
 * exit. */
export function revokeCdpDirect(language: Language = 'en'): string {
  const t = CDP_I18N[language];
  const hadGrant = loadGrant() !== null;
  try {
    clearGrant();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // Defense in depth: the grant file may have survived (readable but
    // undeletable). Deny via the enabled flag so the gate closes anyway.
    try {
      saveConfig({ cdpDirectEnabled: false });
    } catch (disableErr) {
      const disableReason = disableErr instanceof Error ? disableErr.message : String(disableErr);
      // `reason` (the original unlink failure) is carried in the message;
      // the `cause` is this catch's own error, per preserve-caught-error.
      throw new Error(t.revokeFailedBoth(grantFilePath(), reason, disableReason), {
        cause: disableErr,
      });
    }
    throw new Error(t.revokeFailedDisabled(grantFilePath(), reason), { cause: err });
  }
  return hadGrant ? t.revoked : t.noGrantToRevoke;
}

/** `browser-link cdp status`. Reachability is checked live (a real HTTP
 * call to `/json/version` on the configured port) regardless of the
 * enabled/grant state — this is a diagnostic, not a gated action, same
 * spirit as `browser-link doctor`. */
export async function cdpDirectStatus(language: Language = 'en'): Promise<string> {
  const t = CDP_I18N[language];
  const cfg = loadConfig();
  const grant = loadGrant();
  const now = Date.now();
  const live = isGrantLive(grant, now);

  let grantLine: string;
  if (!grant) {
    grantLine = t.grantNone;
  } else if (!live) {
    grantLine = t.grantExpired;
  } else if (grant.expiresAt === null) {
    grantLine = t.grantNever;
  } else {
    grantLine = t.grantRemaining(Math.ceil((remainingMs(grant, now) ?? 0) / 60_000));
  }

  const port = sanitizeCdpPort(cfg.cdpDirectPort);
  const reachable = await isChromeDevtoolsEndpoint(port);

  return [
    t.statusHeader,
    '',
    `  ${t.enabledLabel}   ${cfg.cdpDirectEnabled === true ? t.yes : t.no}`,
    `  ${t.portLabel}       ${port}`,
    `  ${t.grantLabel}      ${grantLine}`,
    `  ${t.reachableLabel}   ${reachable ? t.yes : t.no}`,
  ].join('\n');
}

export async function runCdpCommand(argv: string[], language: Language = 'en'): Promise<string> {
  const t = CDP_I18N[language];
  const action = argv.at(0);
  const rest = argv.slice(1);
  if (action === undefined) throw new Error(t.usage);
  if (action === 'allow') return allowCdpDirect(rest, language);
  if (action === 'revoke') return revokeCdpDirect(language);
  if (action === 'status') return cdpDirectStatus(language);
  throw new Error(t.unknownAction(action));
}
