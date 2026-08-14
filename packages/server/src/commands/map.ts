import { readFileSync, writeFileSync } from 'node:fs';
import { getDb } from '../map/db.js';
import {
  deleteFlow,
  findApp,
  findAppByOriginAndKey,
  findAppCandidates,
  forget,
  listApps,
  listAppsWithCounts,
  listEntries,
  listFlows,
  restoreEntry,
  restoreFlow,
  upsertApp,
  type AppRow,
  type EntryKind,
} from '../map/queries.js';
import { validateFlowSteps } from '../tools/browser-dispatch.js';
import type { Language } from './welcome.js';

/**
 * `browser-link map` — a scriptable, human-facing window into the
 * persistent UI map (the SQLite DB the browser.map.* MCP tools read and
 * write). Agents already have first-class access through those tools;
 * this command family is for a HUMAN to inspect, prune, back up and
 * restore that knowledge from a terminal, without an agent in the loop.
 *
 *   browser-link map                          List every known app.
 *   browser-link map show <app>                Entries + flows for one app.
 *   browser-link map forget <app> [--flow <n>] Delete a flow, or (--yes) a whole app.
 *   browser-link map export [<app>] [--out <f>] Export as JSON (stdout by default).
 *   browser-link map import <file> [--replace]  Import an export (merge by default).
 *
 * `<app>` accepts either an app_key or an origin — see `findApp` in
 * map/queries.ts for the resolution order.
 */

// === Shared helpers =========================================================

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | true>;
}

/** The flags that are pure switches and NEVER take a value. Without this
 * set, `map forget --yes my-app` would swallow "my-app" as the value of
 * `--yes` and then fail with a usage error — flag position must not
 * matter for a boolean switch. */
const BOOLEAN_FLAGS: ReadonlySet<string> = new Set(['yes', 'replace']);

/** Minimal `--flag value` / `--flag` parser — good enough for this
 * command family's small, fixed flag set (`--yes`, `--flow`, `--out`,
 * `--replace`). Flags in `BOOLEAN_FLAGS` are always switches; any other
 * flag consumes the next token as its value unless that token is itself
 * another `--flag` or there is no next token. */
function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = true;
        continue;
      }
      const hasValue = i + 1 < argv.length && !argv[i + 1].startsWith('--');
      if (hasValue) {
        flags[key] = argv[i + 1];
        i++;
      } else {
        flags[key] = true;
      }
      continue;
    }
    positionals.push(token);
  }
  return { positionals, flags };
}

/** Simple aligned table: column widths from the longest cell (header
 * included), two spaces between columns, trailing whitespace trimmed. */
function renderTable(header: string[], rows: string[][]): string {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const renderRow = (cells: string[]): string =>
    cells
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd();
  return [renderRow(header), ...rows.map(renderRow)].join('\n');
}

const ES_UNIT_PLURAL: Record<string, string> = {
  segundo: 'segundos',
  minuto: 'minutos',
  hora: 'horas',
  día: 'días',
  mes: 'meses',
  año: 'años',
};

/** Human-relative time ("3 minutes ago" / "hace 3 minutos") for
 * `last_seen_at`. Falls back to the raw ISO string for an unparsable
 * date rather than throwing — a display helper must never crash `map ls`
 * over one malformed timestamp. */
export function formatRelative(iso: string, language: Language): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return iso;
  const diffSec = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (diffSec < 10) return language === 'es' ? 'justo ahora' : 'just now';

  const steps: { limitSec: number; unitSec: number; en: string; es: string }[] = [
    { limitSec: 60, unitSec: 1, en: 'second', es: 'segundo' },
    { limitSec: 3_600, unitSec: 60, en: 'minute', es: 'minuto' },
    { limitSec: 86_400, unitSec: 3_600, en: 'hour', es: 'hora' },
    { limitSec: 2_592_000, unitSec: 86_400, en: 'day', es: 'día' },
    { limitSec: 31_536_000, unitSec: 2_592_000, en: 'month', es: 'mes' },
    { limitSec: Number.POSITIVE_INFINITY, unitSec: 31_536_000, en: 'year', es: 'año' },
  ];
  const step = steps.find((s) => diffSec < s.limitSec) ?? steps[steps.length - 1];
  const n = Math.max(1, Math.floor(diffSec / step.unitSec));
  if (language === 'es') {
    const unit = n === 1 ? step.es : (ES_UNIT_PLURAL[step.es] ?? `${step.es}s`);
    return `hace ${n} ${unit}`;
  }
  const unit = n === 1 ? step.en : `${step.en}s`;
  return `${n} ${unit} ago`;
}

/** Compact one-line rendering of an entry payload for `map show` — the
 * selector for a `selector` entry, the free-form body/steps otherwise,
 * truncated so one wide payload cannot blow out the terminal. Entry
 * payloads always come from `JSON.parse` (see `hydrate` in queries.ts),
 * so `JSON.stringify` here can never hit the (function/symbol/bare
 * `undefined`) inputs where it would return `undefined` instead of a
 * string. */
function payloadSnippet(payload: unknown, max = 90): string {
  const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return raw.length > max ? `${raw.slice(0, max - 1)}…` : raw;
}

// === i18n ====================================================================

interface MapI18n {
  lsEmpty: string;
  colAppKey: string;
  colOrigin: string;
  colEntries: string;
  colFlows: string;
  colLastSeen: string;
  showUsage: string;
  showHeader: (appKey: string, origin: string) => string;
  titleLabel: string;
  notesLabel: string;
  lastSeenLabel: string;
  entriesHeader: (n: number) => string;
  flowsHeader: (n: number) => string;
  none: string;
  statusVerified: string;
  statusFailed: string;
  statusUnverified: string;
  appNotFound: (identifier: string, known: string[]) => string;
  forgetUsage: string;
  flowFlagRequiresValue: string;
  flowNotFound: (flowName: string, appKey: string, origin: string) => string;
  flowForgotten: (flowName: string, appKey: string, origin: string) => string;
  flowForgetAmbiguous: (
    flowName: string,
    appKey: string,
    origin: string,
    identifier: string,
    candidateCount: number,
  ) => string;
  forgetDryRun: (appKey: string, origin: string, entries: number, flows: number) => string;
  appForgotten: (appKey: string, deletedEntries: number) => string;
  exportWritten: (path: string, appCount: number) => string;
  exportWriteFailed: (path: string, detail: string) => string;
  exportPrivacyNote: string;
  importUsage: string;
  importFileNotFound: (path: string) => string;
  importInvalidJson: string;
  importNotAnExport: string;
  importUnsupportedVersion: (found: number, supported: number) => string;
  importMalformedApp: string;
  importFlowError: (appKey: string, flowName: string, error: string) => string;
  importEntryError: (appKey: string, index: number, error: string) => string;
  importCapExceeded: (what: string, found: number, max: number) => string;
  importAborted: (errors: string[]) => string;
  importSummary: (s: ImportSummary) => string;
  unknownAction: (action: string) => string;
}

const MAP_I18N: Record<Language, MapI18n> = {
  en: {
    lsEmpty:
      'No apps known yet. The map fills in as an agent calls browser.map.save while working on a page.',
    colAppKey: 'APP_KEY',
    colOrigin: 'ORIGIN',
    colEntries: 'ENTRIES',
    colFlows: 'FLOWS',
    colLastSeen: 'LAST_SEEN',
    showUsage: 'Usage: browser-link map show <app>',
    showHeader: (appKey, origin) => `${appKey}  (${origin})`,
    titleLabel: 'title:',
    notesLabel: 'notes:',
    lastSeenLabel: 'last seen:',
    entriesHeader: (n) => `Entries (${n}):`,
    flowsHeader: (n) => `Flows (${n}):`,
    none: '(none)',
    statusVerified: 'verified',
    statusFailed: 'FAILED',
    statusUnverified: 'unverified',
    appNotFound: (identifier, known) =>
      known.length === 0
        ? `No app matches "${identifier}" — the map is empty.`
        : `No app matches "${identifier}" by app_key or origin. Known app_keys: ${known.join(', ')}`,
    forgetUsage: 'Usage: browser-link map forget <app> [--flow <name>] [--yes]',
    flowFlagRequiresValue:
      '--flow requires a flow name: browser-link map forget <app> --flow <name>',
    flowNotFound: (flowName, appKey, origin) =>
      `No flow named "${flowName}" on app "${appKey}" (${origin}).`,
    flowForgotten: (flowName, appKey, origin) =>
      `Deleted flow "${flowName}" from "${appKey}" (${origin}).`,
    flowForgetAmbiguous: (flowName, appKey, origin, identifier, candidateCount) =>
      `"${identifier}" matches ${candidateCount} apps (same app_key on different origins).\n` +
      `This would delete flow "${flowName}" from "${appKey}" (${origin}) — the most recently seen match.\n` +
      `Nothing was deleted. If that is the right app, re-run with --yes to confirm:\n` +
      `  browser-link map forget ${identifier} --flow "${flowName}" --yes\n` +
      `Otherwise, pass the app's origin instead of its app_key to disambiguate.`,
    forgetDryRun: (appKey, origin, entries, flows) =>
      `This would delete app "${appKey}" (${origin}) — ${entries} entr${entries === 1 ? 'y' : 'ies'} and ${flows} flow${flows === 1 ? '' : 's'}.\n` +
      `Nothing was deleted. Re-run with --yes to confirm:\n` +
      `  browser-link map forget ${appKey} --yes`,
    appForgotten: (appKey, deletedEntries) =>
      `Deleted app "${appKey}" and its ${deletedEntries} entr${deletedEntries === 1 ? 'y' : 'ies'} (flows deleted along with it).`,
    exportWritten: (path, appCount) =>
      `Wrote ${appCount} app${appCount === 1 ? '' : 's'} to ${path}.`,
    exportWriteFailed: (path, detail) => `Could not write "${path}": ${detail}`,
    exportPrivacyNote:
      'This file may contain UI structure and flow steps you saved — review it before sharing. The map only ever stores placeholders instead of real data, but it is only as clean as what was saved.',
    importUsage: 'Usage: browser-link map import <file.json> [--replace]',
    importFileNotFound: (path) => `Could not read "${path}".`,
    importInvalidJson: 'That file is not valid JSON.',
    importNotAnExport:
      'That file is not a browser-link map export (missing browser_link_map_export / apps).',
    importUnsupportedVersion: (found, supported) =>
      `Unsupported export version ${found} (this binary supports up to ${supported}). Update browser-link and retry.`,
    importMalformedApp: 'Malformed app entry in the export file (missing origin or app_key).',
    importFlowError: (appKey, flowName, error) => `${appKey} / flow "${flowName}": ${error}`,
    importEntryError: (appKey, index, error) => `${appKey} / entry #${index}: ${error}`,
    importCapExceeded: (what, found, max) => `too many ${what} in one file: ${found} (max ${max})`,
    importAborted: (errors) =>
      `Import aborted — ${errors.length} invalid item${errors.length === 1 ? '' : 's'}, nothing was written:\n` +
      errors.map((e) => `  - ${e}`).join('\n'),
    importSummary: (s) =>
      `Imported ${s.appsImported} app${s.appsImported === 1 ? '' : 's'}` +
      (s.appsReplaced > 0 ? ` (${s.appsReplaced} replaced)` : '') +
      `, ${s.entriesImported} entr${s.entriesImported === 1 ? 'y' : 'ies'}` +
      (s.entriesSkipped > 0 ? ` (${s.entriesSkipped} duplicate skipped)` : '') +
      `, ${s.flowsImported} flow${s.flowsImported === 1 ? '' : 's'}.`,
    unknownAction: (action) =>
      `Unknown map action: ${action}. Use (no arg for list) | show | forget | export | import.`,
  },
  es: {
    lsEmpty:
      'Todavía no hay apps registradas. El mapa se completa cuando un agente llama a browser.map.save mientras trabaja en una página.',
    colAppKey: 'APP_KEY',
    colOrigin: 'ORIGIN',
    colEntries: 'ENTRADAS',
    colFlows: 'FLOWS',
    colLastSeen: 'ÚLTIMA_VEZ',
    showUsage: 'Uso: browser-link map show <app>',
    showHeader: (appKey, origin) => `${appKey}  (${origin})`,
    titleLabel: 'título:',
    notesLabel: 'notas:',
    lastSeenLabel: 'última vez:',
    entriesHeader: (n) => `Entradas (${n}):`,
    flowsHeader: (n) => `Flows (${n}):`,
    none: '(ninguno)',
    statusVerified: 'verificado',
    statusFailed: 'FALLÓ',
    statusUnverified: 'sin verificar',
    appNotFound: (identifier, known) =>
      known.length === 0
        ? `Ninguna app coincide con "${identifier}" — el mapa está vacío.`
        : `Ninguna app coincide con "${identifier}" por app_key u origen. App_keys conocidas: ${known.join(', ')}`,
    forgetUsage: 'Uso: browser-link map forget <app> [--flow <nombre>] [--yes]',
    flowFlagRequiresValue:
      '--flow requiere un nombre de flow: browser-link map forget <app> --flow <nombre>',
    flowNotFound: (flowName, appKey, origin) =>
      `No hay un flow llamado "${flowName}" en la app "${appKey}" (${origin}).`,
    flowForgotten: (flowName, appKey, origin) =>
      `Se eliminó el flow "${flowName}" de "${appKey}" (${origin}).`,
    flowForgetAmbiguous: (flowName, appKey, origin, identifier, candidateCount) =>
      `"${identifier}" coincide con ${candidateCount} apps (mismo app_key en distintos orígenes).\n` +
      `Esto eliminaría el flow "${flowName}" de "${appKey}" (${origin}) — la coincidencia vista más recientemente.\n` +
      `No se eliminó nada. Si esa es la app correcta, volvé a correr con --yes para confirmar:\n` +
      `  browser-link map forget ${identifier} --flow "${flowName}" --yes\n` +
      `Si no, pasá el origin de la app en lugar de su app_key para desambiguar.`,
    forgetDryRun: (appKey, origin, entries, flows) =>
      `Esto eliminaría la app "${appKey}" (${origin}) — ${entries} entrada${entries === 1 ? '' : 's'} y ${flows} flow${flows === 1 ? '' : 's'}.\n` +
      `No se eliminó nada. Volvé a correr con --yes para confirmar:\n` +
      `  browser-link map forget ${appKey} --yes`,
    appForgotten: (appKey, deletedEntries) =>
      `Se eliminó la app "${appKey}" y sus ${deletedEntries} entrada${deletedEntries === 1 ? '' : 's'} (los flows se eliminaron junto con ella).`,
    exportWritten: (path, appCount) =>
      `Se escribieron ${appCount} app${appCount === 1 ? '' : 's'} en ${path}.`,
    exportWriteFailed: (path, detail) => `No se pudo escribir "${path}": ${detail}`,
    exportPrivacyNote:
      'Este archivo puede contener estructura de UI y pasos de flows que se guardaron — revisalo antes de compartirlo. El mapa solo guarda placeholders en vez de datos reales, pero queda tan limpio como lo que se haya guardado.',
    importUsage: 'Uso: browser-link map import <archivo.json> [--replace]',
    importFileNotFound: (path) => `No se pudo leer "${path}".`,
    importInvalidJson: 'Ese archivo no es JSON válido.',
    importNotAnExport:
      'Ese archivo no es una exportación de browser-link map (falta browser_link_map_export / apps).',
    importUnsupportedVersion: (found, supported) =>
      `Versión de exportación no soportada: ${found} (este binario soporta hasta ${supported}). Actualizá browser-link y reintentá.`,
    importMalformedApp:
      'Entrada de app inválida en el archivo de exportación (falta origin o app_key).',
    importFlowError: (appKey, flowName, error) => `${appKey} / flow "${flowName}": ${error}`,
    importEntryError: (appKey, index, error) => `${appKey} / entrada #${index}: ${error}`,
    importCapExceeded: (what, found, max) =>
      `demasiados ${what} en un solo archivo: ${found} (máximo ${max})`,
    importAborted: (errors) =>
      `Importación abortada — ${errors.length} elemento${errors.length === 1 ? '' : 's'} inválido${errors.length === 1 ? '' : 's'}, no se escribió nada:\n` +
      errors.map((e) => `  - ${e}`).join('\n'),
    importSummary: (s) =>
      `Se importaron ${s.appsImported} app${s.appsImported === 1 ? '' : 's'}` +
      (s.appsReplaced > 0
        ? ` (${s.appsReplaced} reemplazada${s.appsReplaced === 1 ? '' : 's'})`
        : '') +
      `, ${s.entriesImported} entrada${s.entriesImported === 1 ? '' : 's'}` +
      (s.entriesSkipped > 0
        ? ` (${s.entriesSkipped} duplicada${s.entriesSkipped === 1 ? '' : 's'} omitida${s.entriesSkipped === 1 ? '' : 's'})`
        : '') +
      `, ${s.flowsImported} flow${s.flowsImported === 1 ? '' : 's'}.`,
    unknownAction: (action) =>
      `Acción de map desconocida: ${action}. Usá (sin argumento para listar) | show | forget | export | import.`,
  },
};

function resolveAppOrThrow(identifier: string, t: MapI18n): AppRow {
  const app = findApp(identifier);
  if (app) return app;
  throw new Error(
    t.appNotFound(
      identifier,
      listApps().map((a) => a.app_key),
    ),
  );
}

// === map ls ==================================================================

function runLs(language: Language): string {
  const t = MAP_I18N[language];
  const apps = listAppsWithCounts();
  if (apps.length === 0) return t.lsEmpty;
  const header = [t.colAppKey, t.colOrigin, t.colEntries, t.colFlows, t.colLastSeen];
  const rows = apps.map((a) => [
    a.app_key,
    a.origin,
    String(a.entries),
    String(a.flows),
    formatRelative(a.last_seen_at, language),
  ]);
  return renderTable(header, rows);
}

// === map show ================================================================

function runShow(argv: string[], language: Language): string {
  const t = MAP_I18N[language];
  const identifier = argv[0];
  if (!identifier) throw new Error(t.showUsage);
  const app = resolveAppOrThrow(identifier, t);
  const entries = listEntries(app.id);
  const flows = listFlows(app.id);

  const lines: string[] = [];
  lines.push(t.showHeader(app.app_key, app.origin));
  if (app.title) lines.push(`  ${t.titleLabel} ${app.title}`);
  if (app.notes) lines.push(`  ${t.notesLabel} ${app.notes}`);
  lines.push(`  ${t.lastSeenLabel} ${formatRelative(app.last_seen_at, language)}`);
  lines.push('');
  lines.push(t.entriesHeader(entries.length));
  if (entries.length === 0) {
    lines.push(`  ${t.none}`);
  } else {
    for (const e of entries) {
      const failedIsNewer =
        e.failed_at !== null && (e.verified_at === null || e.failed_at > e.verified_at);
      const status = failedIsNewer
        ? t.statusFailed
        : e.verified_at
          ? t.statusVerified
          : t.statusUnverified;
      lines.push(`  [${e.kind}] ${e.url_pattern} — ${e.purpose} (${status})`);
      lines.push(`      ${payloadSnippet(e.payload)}`);
      if (e.notes) lines.push(`      ${t.notesLabel} ${e.notes}`);
    }
  }
  lines.push('');
  lines.push(t.flowsHeader(flows.length));
  if (flows.length === 0) {
    lines.push(`  ${t.none}`);
  } else {
    for (const f of flows) {
      const stepCount = Array.isArray(f.steps) ? f.steps.length : 0;
      const desc = f.description ? ` — ${f.description}` : '';
      lines.push(`  ${f.name} (${stepCount} steps, used ${f.use_count}×)${desc}`);
    }
  }
  return lines.join('\n');
}

// === map forget ==============================================================

function runForget(argv: string[], language: Language): string {
  const t = MAP_I18N[language];
  const { positionals, flags } = parseArgs(argv);
  const identifier = positionals[0];
  if (!identifier) throw new Error(t.forgetUsage);

  // A valueless `--flow` parses as boolean `true` (see parseArgs) — reading
  // that as "no --flow given" would silently widen scope to the whole-app
  // path below, so a user who forgot the flow name gets a whole-app dry-run
  // instead of a clear error. Reject it here, before any DB lookup, so a
  // mistyped `--flow` never even resolves an app or touches the database.
  if (flags.flow === true) throw new Error(t.flowFlagRequiresValue);
  const flowName = typeof flags.flow === 'string' ? flags.flow : undefined;

  // Destructive command — resolve through findAppCandidates, not findApp,
  // so an ambiguous identifier (same app_key saved on two origins) is
  // DETECTED instead of silently resolving to the most-recently-seen app
  // and deleting the wrong origin's data.
  const candidates = findAppCandidates(identifier);
  if (candidates.length === 0) {
    throw new Error(
      t.appNotFound(
        identifier,
        listApps().map((a) => a.app_key),
      ),
    );
  }
  const app = candidates[0];

  if (flowName !== undefined) {
    // Check existence BEFORE the ambiguity gate so a typo'd flow name gets
    // its clear not-found error (naming the resolved origin) either way.
    const exists = listFlows(app.id).some((f) => f.name === flowName);
    if (!exists) throw new Error(t.flowNotFound(flowName, app.app_key, app.origin));
    if (candidates.length > 1 && flags.yes !== true) {
      return t.flowForgetAmbiguous(
        flowName,
        app.app_key,
        app.origin,
        identifier,
        candidates.length,
      );
    }
    deleteFlow(app.id, flowName);
    return t.flowForgotten(flowName, app.app_key, app.origin);
  }

  if (flags.yes !== true) {
    const summary = listAppsWithCounts().find((a) => a.id === app.id);
    return t.forgetDryRun(app.app_key, app.origin, summary?.entries ?? 0, summary?.flows ?? 0);
  }

  const result = forget({ app_id: app.id });
  return t.appForgotten(app.app_key, result.deleted_entries);
}

// === map export ===============================================================

interface MapExportEntry {
  url_pattern: string;
  kind: EntryKind;
  purpose: string;
  payload: unknown;
  notes: string | null;
  verified_at: string | null;
  failed_at: string | null;
}

interface MapExportFlow {
  name: string;
  description: string | null;
  steps: unknown;
  use_count: number;
}

interface MapExportApp {
  origin: string;
  app_key: string;
  title: string | null;
  notes: string | null;
  entries: MapExportEntry[];
  flows: MapExportFlow[];
}

interface MapExportFile {
  browser_link_map_export: number;
  exported_at: string;
  apps: MapExportApp[];
}

const MAP_EXPORT_VERSION = 1;

function buildExport(appFilter: string | undefined, t: MapI18n): MapExportFile {
  const apps = appFilter ? [resolveAppOrThrow(appFilter, t)] : listApps();
  return {
    browser_link_map_export: MAP_EXPORT_VERSION,
    exported_at: new Date().toISOString(),
    apps: apps.map((app) => ({
      origin: app.origin,
      app_key: app.app_key,
      title: app.title,
      notes: app.notes,
      entries: listEntries(app.id).map((e) => ({
        url_pattern: e.url_pattern,
        kind: e.kind,
        purpose: e.purpose,
        payload: e.payload,
        notes: e.notes,
        verified_at: e.verified_at,
        failed_at: e.failed_at,
      })),
      flows: listFlows(app.id).map((f) => ({
        name: f.name,
        description: f.description,
        steps: f.steps,
        use_count: f.use_count,
      })),
    })),
  };
}

function runExport(argv: string[], language: Language): string {
  const t = MAP_I18N[language];
  const { positionals, flags } = parseArgs(argv);
  const file = buildExport(positionals[0], t);
  const json = JSON.stringify(file, null, 2);

  const outPath = typeof flags.out === 'string' ? flags.out : undefined;
  if (!outPath) return json;

  try {
    writeFileSync(outPath, `${json}\n`, 'utf8');
  } catch (err) {
    throw new Error(
      t.exportWriteFailed(outPath, err instanceof Error ? err.message : String(err)),
      { cause: err },
    );
  }
  return `${t.exportWritten(outPath, file.apps.length)}\n${t.exportPrivacyNote}`;
}

// === map import ================================================================

interface ImportSummary {
  appsImported: number;
  appsReplaced: number;
  entriesImported: number;
  entriesSkipped: number;
  flowsImported: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** Sanity caps on what a single import file may contain. These exist so a
 * corrupted or hostile file fails with a clean, aggregated abort message
 * instead of grinding through millions of SQLite writes (or one giant
 * string) inside the import transaction. Generous compared to any real
 * map: 500 apps / 5000 entries / 1000 flows per FILE, and 1 MiB per
 * serialized payload or steps array. */
const MAX_IMPORT_APPS = 500;
const MAX_IMPORT_ENTRIES = 5_000;
const MAX_IMPORT_FLOWS = 1_000;
const MAX_IMPORT_ITEM_BYTES = 1_048_576; // 1 MiB

const ENTRY_KINDS: ReadonlySet<string> = new Set(['selector', 'flow', 'gotcha']);

/** Intermediate parse result: container + app identity are proven, but
 * entry/flow ITEMS are still `unknown` — they get their per-item
 * validation (with aggregated errors) in `validateImportFile`, not a
 * throw-on-first-problem here. */
interface RawExportApp {
  origin: string;
  app_key: string;
  title: string | null;
  notes: string | null;
  entries: unknown[];
  flows: unknown[];
}

/** Parse + container-shape checks. Throws (single error, no aggregation)
 * only for problems where a per-item report makes no sense: not JSON, not
 * an export file at all, a newer export version than this binary knows
 * how to read, or an app object missing its identity. */
function parseExportFile(raw: string, t: MapI18n): RawExportApp[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(t.importInvalidJson);
  }
  if (!isRecord(data) || !('browser_link_map_export' in data) || !Array.isArray(data.apps)) {
    throw new Error(t.importNotAnExport);
  }
  const version = data.browser_link_map_export;
  if (typeof version !== 'number') throw new Error(t.importNotAnExport);
  if (version > MAP_EXPORT_VERSION) {
    throw new Error(t.importUnsupportedVersion(version, MAP_EXPORT_VERSION));
  }
  return data.apps.map((app: unknown) => {
    if (!isRecord(app) || typeof app.origin !== 'string' || typeof app.app_key !== 'string') {
      throw new Error(t.importMalformedApp);
    }
    return {
      origin: app.origin,
      app_key: app.app_key,
      title: typeof app.title === 'string' ? app.title : null,
      notes: typeof app.notes === 'string' ? app.notes : null,
      entries: Array.isArray(app.entries) ? app.entries : [],
      flows: Array.isArray(app.flows) ? app.flows : [],
    };
  });
}

/** `undefined`, `null` or a string — the shape every nullable text column
 * accepts on restore. */
function isNullableString(v: unknown): v is string | null | undefined {
  return v === undefined || v === null || typeof v === 'string';
}

/**
 * Item-level validation for an import — EVERY problem across EVERY app is
 * collected into one aggregated error list, so the user fixes the file
 * once instead of replaying one crash per problem. Nothing may reach the
 * write phase unvalidated: every field a DB constraint would reject
 * (NOT NULL name/url_pattern/purpose/payload, the kind CHECK) is caught
 * here with a readable per-item message instead of a raw SqliteError —
 * the transaction in `writeImport` would roll back either way, but the
 * promised clean abort report must come from THIS pass. Flow `steps` are
 * validated with the exact `validateFlowSteps` rules `browser.flow`
 * enforces, and flow `name` with the same non-empty rule
 * `browser.map.save` applies (see map/tools.ts). Detailed rule text stays
 * in English on purpose, matching how `validateFlowSteps` errors already
 * pass through untranslated; the surrounding report is localized.
 *
 * Returns the typed apps (only meaningful when `errors` is empty).
 */
function validateImportFile(
  rawApps: RawExportApp[],
  t: MapI18n,
): { errors: string[]; apps: MapExportApp[] } {
  const errors: string[] = [];
  const apps: MapExportApp[] = [];

  if (rawApps.length > MAX_IMPORT_APPS) {
    errors.push(t.importCapExceeded('apps', rawApps.length, MAX_IMPORT_APPS));
  }
  let totalEntries = 0;
  let totalFlows = 0;

  for (const rawApp of rawApps) {
    totalEntries += rawApp.entries.length;
    totalFlows += rawApp.flows.length;

    const entries: MapExportEntry[] = [];
    rawApp.entries.forEach((item, index) => {
      if (!isRecord(item)) {
        errors.push(t.importEntryError(rawApp.app_key, index, 'must be an object'));
        return;
      }
      const problems: string[] = [];
      if (typeof item.url_pattern !== 'string' || item.url_pattern.length === 0) {
        problems.push('url_pattern must be a non-empty string');
      }
      if (typeof item.kind !== 'string' || !ENTRY_KINDS.has(item.kind)) {
        problems.push('kind must be one of selector | flow | gotcha');
      }
      if (typeof item.purpose !== 'string' || item.purpose.length === 0) {
        problems.push('purpose must be a non-empty string');
      }
      if (item.payload === undefined) {
        problems.push('payload is required');
      } else if (JSON.stringify(item.payload).length > MAX_IMPORT_ITEM_BYTES) {
        problems.push(`payload exceeds ${MAX_IMPORT_ITEM_BYTES} bytes when serialized`);
      }
      if (!isNullableString(item.notes)) problems.push('notes must be a string or null');
      if (!isNullableString(item.verified_at))
        problems.push('verified_at must be a string or null');
      if (!isNullableString(item.failed_at)) problems.push('failed_at must be a string or null');

      if (problems.length > 0) {
        for (const p of problems) errors.push(t.importEntryError(rawApp.app_key, index, p));
        return;
      }
      entries.push({
        url_pattern: item.url_pattern as string,
        kind: item.kind as EntryKind,
        purpose: item.purpose as string,
        payload: item.payload,
        notes: (item.notes as string | null | undefined) ?? null,
        verified_at: (item.verified_at as string | null | undefined) ?? null,
        failed_at: (item.failed_at as string | null | undefined) ?? null,
      });
    });

    const flows: MapExportFlow[] = [];
    rawApp.flows.forEach((item, index) => {
      if (!isRecord(item)) {
        errors.push(t.importFlowError(rawApp.app_key, `#${index}`, 'must be an object'));
        return;
      }
      const name = typeof item.name === 'string' && item.name.trim().length > 0 ? item.name : null;
      const label = name ?? `#${index}`;
      const problems: string[] = [];
      if (name === null) problems.push('name must be a non-empty string');
      if (!isNullableString(item.description))
        problems.push('description must be a string or null');
      const validated = validateFlowSteps(item.steps);
      if (!validated.ok) {
        problems.push(validated.error);
      } else if (JSON.stringify(validated.steps).length > MAX_IMPORT_ITEM_BYTES) {
        problems.push(`steps exceed ${MAX_IMPORT_ITEM_BYTES} bytes when serialized`);
      }

      if (problems.length > 0 || name === null || !validated.ok) {
        for (const p of problems) errors.push(t.importFlowError(rawApp.app_key, label, p));
        return;
      }
      flows.push({
        name,
        description: (item.description as string | null | undefined) ?? null,
        steps: validated.steps,
        use_count:
          typeof item.use_count === 'number' &&
          Number.isInteger(item.use_count) &&
          item.use_count >= 0
            ? item.use_count
            : 0,
      });
    });

    apps.push({
      origin: rawApp.origin,
      app_key: rawApp.app_key,
      title: rawApp.title,
      notes: rawApp.notes,
      entries,
      flows,
    });
  }

  if (totalEntries > MAX_IMPORT_ENTRIES) {
    errors.push(t.importCapExceeded('entries', totalEntries, MAX_IMPORT_ENTRIES));
  }
  if (totalFlows > MAX_IMPORT_FLOWS) {
    errors.push(t.importCapExceeded('flows', totalFlows, MAX_IMPORT_FLOWS));
  }

  return { errors, apps };
}

/** Structural equality good enough for JSON-shaped values (objects,
 * arrays, primitives) — used to detect an "exact duplicate" entry on
 * merge import, where key order between the stored payload and the
 * freshly parsed import payload is not guaranteed to match, so a plain
 * `JSON.stringify` comparison would false-negative. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  const aRec = a as Record<string, unknown>;
  const bRec = b as Record<string, unknown>;
  const aKeys = Object.keys(aRec);
  const bKeys = Object.keys(bRec);
  return aKeys.length === bKeys.length && aKeys.every((k) => deepEqual(aRec[k], bRec[k]));
}

/**
 * Write an already-validated import to the DB inside one transaction —
 * either everything lands or (on an unexpected DB error) nothing does.
 * All item-level validation happens BEFORE this is called (see
 * `validateImportFile`), so this function only ever writes flows already
 * proven to pass `validateFlowSteps` and entries whose DB-constrained
 * fields are known-good.
 *
 * Entries and flows are written through the restore-only
 * `restoreEntry`/`restoreFlow` helpers, NOT the agent-facing
 * `saveEntry`/`saveFlow`: a restore must preserve each entry's
 * `verified_at`/`failed_at` and each flow's `use_count` instead of
 * re-stamping "freshly verified, never failed, never used" — a backup
 * restore that silently healed known-broken selectors would lie to the
 * next agent session.
 *
 * Merge semantics (default, `replace = false`):
 *  - apps: upserted via `upsertApp` (same (origin, app_key) identity the
 *    DB's UNIQUE constraint uses).
 *  - flows: upserted by (app, name); an existing flow's `use_count` is
 *    never lowered (see `restoreFlow`).
 *  - entries: appended, EXCEPT an entry whose (url_pattern, kind,
 *    purpose) already exists with a structurally-equal payload — that
 *    one is skipped so a re-import of the same export is a no-op. An
 *    entry that shares the key but NOT the payload overwrites, carrying
 *    the imported verified_at/failed_at with it.
 *
 * Replace semantics (`replace = true`): each imported app's EXISTING
 * data (found by exact (origin, app_key)) is deleted first via
 * `forget()`, then every entry/flow in the file is written fresh — no
 * duplicate check needed since the slate is clean.
 */
function writeImport(apps: MapExportApp[], replace: boolean): ImportSummary {
  const summary: ImportSummary = {
    appsImported: 0,
    appsReplaced: 0,
    entriesImported: 0,
    entriesSkipped: 0,
    flowsImported: 0,
  };

  const runTxn = getDb().transaction((toImport: MapExportApp[]) => {
    for (const appData of toImport) {
      if (replace) {
        const existing = findAppByOriginAndKey(appData.origin, appData.app_key);
        if (existing) {
          forget({ app_id: existing.id });
          summary.appsReplaced++;
        }
      }

      const app = upsertApp({
        origin: appData.origin,
        app_key: appData.app_key,
        title: appData.title,
        notes: appData.notes,
      });
      summary.appsImported++;

      const known = replace ? [] : listEntries(app.id);
      for (const entryData of appData.entries) {
        const idx = known.findIndex(
          (e) =>
            e.url_pattern === entryData.url_pattern &&
            e.kind === entryData.kind &&
            e.purpose === entryData.purpose,
        );
        if (idx !== -1 && deepEqual(known[idx]?.payload, entryData.payload)) {
          summary.entriesSkipped++;
          continue;
        }
        const { entry } = restoreEntry({
          origin: app.origin,
          app_key: app.app_key,
          url_pattern: entryData.url_pattern,
          kind: entryData.kind,
          purpose: entryData.purpose,
          payload: entryData.payload,
          notes: entryData.notes,
          verified_at: entryData.verified_at,
          failed_at: entryData.failed_at,
        });
        if (idx !== -1) known[idx] = entry;
        else known.push(entry);
        summary.entriesImported++;
      }

      for (const flowData of appData.flows) {
        restoreFlow({
          origin: app.origin,
          app_key: app.app_key,
          name: flowData.name,
          description: flowData.description,
          steps: flowData.steps,
          use_count: flowData.use_count,
        });
        summary.flowsImported++;
      }
    }
  });

  runTxn(apps);
  return summary;
}

function runImport(argv: string[], language: Language): string {
  const t = MAP_I18N[language];
  const { positionals, flags } = parseArgs(argv);
  const filePath = positionals[0];
  if (!filePath) throw new Error(t.importUsage);

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    throw new Error(t.importFileNotFound(filePath));
  }
  const rawApps = parseExportFile(raw, t);

  // Validate EVERYTHING, across EVERY app, before writing anything — one
  // aggregated report, never a raw SqliteError, never a partial write.
  const { errors, apps } = validateImportFile(rawApps, t);
  if (errors.length > 0) throw new Error(t.importAborted(errors));

  const summary = writeImport(apps, flags.replace === true);
  return t.importSummary(summary);
}

// === dispatch ================================================================

export function runMapCommand(argv: string[], language: Language = 'en'): string {
  const t = MAP_I18N[language];
  const action = argv[0] ?? 'ls';
  const rest = argv.slice(1);
  switch (action) {
    case 'ls':
      return runLs(language);
    case 'show':
      return runShow(rest, language);
    case 'forget':
      return runForget(rest, language);
    case 'export':
      return runExport(rest, language);
    case 'import':
      return runImport(rest, language);
    default:
      throw new Error(t.unknownAction(action));
  }
}
