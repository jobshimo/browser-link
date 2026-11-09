import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Language } from './welcome.js';
import { formatRelative } from './map.js';
import {
  clear,
  countInRange,
  exportAll,
  listAgents,
  purgeRange,
  query,
  redact,
  stats,
} from '../activity/queries.js';
import { summarizeActivity, type ActivitySummaryFilters } from '../activity/summary.js';
import type { ActivityQuery, ActivityRecord } from '../activity/types.js';

/**
 * `browser-link activity` — read, export and clear the agent activity trail.
 *
 * The CLI is the trail's answer to "give it to another agent". The extension
 * window is for watching; a file on disk is for handing over, diffing and
 * grepping — no browser in the loop.
 */

const I18N = {
  en: {
    empty: 'No activity recorded yet.',
    disabledHint: "If this is unexpected, check that `activity.enabled` isn't set to false.",
    showing: (shown: number, total: number) => `Showing ${shown} of ${total} recorded actions.`,
    header: ['WHEN', 'AGENT', 'TOOL', 'TARGET', 'RESULT'],
    exported: (n: number, path: string) => `Exported ${n} actions to ${path}`,
    exportedRedacted: 'Payloads, titles and query strings were redacted.',
    cleared: (n: number) => `Removed ${n} actions from the trail.`,
    clearedNone: 'Nothing to remove.',
    confirmClear:
      'This deletes the activity trail. Re-run with --yes to confirm, or pass --older-than to keep recent history.',
    agents: 'Agents seen:',
    statRows: 'Actions stored',
    statSize: 'Size on disk',
    statOldest: 'Oldest entry',
    statNewest: 'Newest entry',
    confirmRange: (n: number) =>
      `This will permanently delete ${n.toLocaleString()} actions. It cannot be undone. Re-run with --yes to confirm.`,
    badFormat: (v: string) => `Unknown format "${v}". Use json, ndjson or csv.`,
    badOlderThan: (v: string) =>
      `Could not read "${v}" as a duration. Use forms like 30m, 12h, 7d.`,
    badSince: (v: string) =>
      `Could not read "${v}" as a duration or a date. Use forms like 30m, 12h, 7d or 2026-11-09.`,
    reportTitle: (records: number, errors: number, timeouts: number, evaluate: number) =>
      `Friction report: ${records} actions, ${errors} errors, ${timeouts} timeouts, ${evaluate} evaluate calls`,
    reportFlags: 'Flags',
    reportToolErrors: 'Errors by tool',
    reportTargets: 'Top failing targets',
    reportTargetsHeader: ['TARGET', 'TOOL', 'COUNT', 'LAST FLAG'],
    reportSessions: 'Sessions',
    reportSessionsHeader: ['SESSION', 'AGENT', 'ACTIONS', 'ERRORS', 'FLAGS'],
    reportUsage: 'Cost and map usage',
    reportUsageLabels: {
      bytes: 'result bytes',
      evaluateShare: 'evaluate share',
      listTabs: 'list_tabs calls',
      mapRecall: 'map.recall calls',
      readers: 'readers run',
    },
    reportBytesByTool: 'Result bytes by tool',
    usage: [
      'browser-link activity [filters]            Recent actions (newest first)',
      'browser-link activity report [options]     Friction report: what failed, per session, and what results cost',
      'browser-link activity export [options]     Write the trail to a file',
      'browser-link activity stats                How big the trail is right now',
      'browser-link activity clear [options]      Delete trail entries',
      '',
      'Filters:',
      '  --tab <id>          Only this browser-link tab id',
      '  --agent <label>     Only this agent ("claude-code", "opencode", …)',
      '  --tool <name>       Only this tool ("browser.click")',
      '  --flow <id>         Only steps belonging to this flow',
      '  --failed            Only actions that errored',
      '  --limit <n>         Rows to show (default 50, max 500)',
      '',
      'report options:',
      '  --since <when>      Only since 30m / 12h / 7d ago, or an ISO date/time',
      '  --agent <id>        Only this session id ("primary" or an IPC session uuid)',
      '',
      'export options:',
      '  --out <file>        Destination (default activity.json in the cwd)',
      '  --format <fmt>      json | ndjson | csv (default json)',
      '  --redact            Strip payloads, titles and URL query strings',
      '',
      'clear options:',
      '  --older-than <dur>  Only entries older than 30m / 12h / 7d',
      '  --from <YYYY-MM-DD> Start of an inclusive date range',
      '  --to <YYYY-MM-DD>   End of an inclusive date range (reclaims disk space)',
      '  --yes               Skip the confirmation prompt',
    ].join('\n'),
  },
  es: {
    empty: 'Todavía no hay actividad registrada.',
    disabledHint: 'Si no lo esperabas, comprueba que `activity.enabled` no esté en false.',
    showing: (shown: number, total: number) =>
      `Mostrando ${shown} de ${total} acciones registradas.`,
    header: ['CUÁNDO', 'AGENTE', 'HERRAMIENTA', 'OBJETIVO', 'RESULTADO'],
    exported: (n: number, path: string) => `Exportadas ${n} acciones a ${path}`,
    exportedRedacted: 'Se han ocultado los payloads, los títulos y las query strings.',
    cleared: (n: number) => `Eliminadas ${n} acciones del rastro.`,
    clearedNone: 'No hay nada que eliminar.',
    confirmClear:
      'Esto borra el rastro de actividad. Vuelve a ejecutarlo con --yes para confirmar, o usa --older-than para conservar lo reciente.',
    agents: 'Agentes vistos:',
    statRows: 'Acciones guardadas',
    statSize: 'Tamaño en disco',
    statOldest: 'Entrada más antigua',
    statNewest: 'Entrada más reciente',
    confirmRange: (n: number) =>
      `Esto borrará permanentemente ${n.toLocaleString()} acciones. No se puede deshacer. Vuelve a ejecutarlo con --yes para confirmar.`,
    badFormat: (v: string) => `Formato "${v}" desconocido. Usa json, ndjson o csv.`,
    badOlderThan: (v: string) =>
      `No se ha podido interpretar "${v}" como duración. Usa formas como 30m, 12h, 7d.`,
    badSince: (v: string) =>
      `No se ha podido interpretar "${v}" como duración ni como fecha. Usa formas como 30m, 12h, 7d o 2026-11-09.`,
    reportTitle: (records: number, errors: number, timeouts: number, evaluate: number) =>
      `Informe de fricción: ${records} acciones, ${errors} errores, ${timeouts} timeouts, ${evaluate} llamadas a evaluate`,
    reportFlags: 'Señales',
    reportToolErrors: 'Errores por herramienta',
    reportTargets: 'Objetivos que más fallan',
    reportTargetsHeader: ['OBJETIVO', 'HERRAMIENTA', 'VECES', 'ÚLTIMA SEÑAL'],
    reportSessions: 'Sesiones',
    reportSessionsHeader: ['SESIÓN', 'AGENTE', 'ACCIONES', 'ERRORES', 'SEÑALES'],
    reportUsage: 'Coste y uso del mapa',
    reportUsageLabels: {
      bytes: 'bytes de resultados',
      evaluateShare: 'cuota de evaluate',
      listTabs: 'llamadas a list_tabs',
      mapRecall: 'llamadas a map.recall',
      readers: 'lectores ejecutados',
    },
    reportBytesByTool: 'Bytes de resultados por herramienta',
    usage: [
      'browser-link activity [filtros]            Acciones recientes (más nuevas primero)',
      'browser-link activity report [opciones]    Informe de fricción: qué falló, por sesión, y cuánto ocuparon los resultados',
      'browser-link activity export [opciones]    Escribe el rastro en un fichero',
      'browser-link activity stats                Cuánto ocupa el rastro ahora mismo',
      'browser-link activity clear [opciones]     Borra entradas del rastro',
      '',
      'Filtros:',
      '  --tab <id>          Sólo esta pestaña de browser-link',
      '  --agent <label>     Sólo este agente ("claude-code", "opencode", …)',
      '  --tool <nombre>     Sólo esta herramienta ("browser.click")',
      '  --flow <id>         Sólo los pasos de este flow',
      '  --failed            Sólo las acciones que fallaron',
      '  --limit <n>         Filas a mostrar (por defecto 50, máximo 500)',
      '',
      'opciones de report:',
      '  --since <cuándo>    Sólo desde hace 30m / 12h / 7d, o una fecha/hora ISO',
      '  --agent <id>        Sólo esta sesión ("primary" o el uuid de una sesión IPC)',
      '',
      'opciones de export:',
      '  --out <fichero>     Destino (por defecto activity.json en el cwd)',
      '  --format <fmt>      json | ndjson | csv (por defecto json)',
      '  --redact            Quita payloads, títulos y query strings de las URLs',
      '',
      'opciones de clear:',
      '  --older-than <dur>  Sólo entradas más viejas que 30m / 12h / 7d',
      '  --from <YYYY-MM-DD> Inicio de un rango de fechas inclusivo',
      '  --to <YYYY-MM-DD>   Fin del rango (además recupera espacio en disco)',
      '  --yes               Salta la confirmación',
    ].join('\n'),
  },
} as const;

/** Read `--flag value` out of argv. Returns undefined when absent, so a
 * missing flag and an empty one stay distinguishable. */
function flagValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  // `.at()` rather than `[]` for the same reason cli.ts uses it: it types the
  // missing-argument case as `undefined` instead of lying about it under the
  // project's loose index access.
  const value = argv.at(index + 1);
  return value !== undefined && !value.startsWith('--') ? value : undefined;
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

/* ------------------------------------------------------------- time ------
 *
 * SAME ONE RULE as the extension's Activity window:
 *
 *   The trail stores UTC. The operator only ever sees, and only ever types,
 *   their own local time.
 *
 * `--from 2026-07-31` means "July 31st where I am", not "July 31st in UTC" —
 * anything else would make the same flag select different rows in the terminal
 * than it does in the window, which is a bug nobody would ever think to look
 * for. Exports keep raw UTC: a file handed to another machine must not carry
 * this machine's timezone baked into it.
 */

/** A local calendar day widened to the UTC instant at its local start or end.
 * Mirrors `localDayToUtc` in the extension's `activity.ts`; duplicated rather
 * than shared for the same reason the wire types are — the two packages do not
 * depend on each other's build. */
export function localDayToUtc(day: string, edge: 'start' | 'end'): string {
  // No `Z` and no offset: the runtime parses this as LOCAL time.
  const suffix = edge === 'start' ? 'T00:00:00.000' : 'T23:59:59.999';
  return new Date(`${day}${suffix}`).toISOString();
}

/** A stored UTC instant rendered in the operator's local time. */
function formatLocal(iso: string | null): string {
  if (iso === null) return '—';
  return new Date(iso).toLocaleString();
}

/** Parse `30m` / `12h` / `7d` into milliseconds. Deliberately a tiny closed
 * grammar rather than a date parser: `--older-than 7d` is unambiguous in every
 * locale, `--older-than 03/04` is not. */
export function parseDuration(value: string): number | null {
  const match = /^(\d+)([mhd])$/.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as 'm' | 'h' | 'd'];
  return amount * unit;
}

function buildQuery(argv: string[]): ActivityQuery {
  const limitRaw = flagValue(argv, 'limit');
  const parsedLimit = limitRaw === undefined ? undefined : Number.parseInt(limitRaw, 10);
  return {
    ...(flagValue(argv, 'tab') !== undefined ? { tabId: flagValue(argv, 'tab') } : {}),
    ...(flagValue(argv, 'agent') !== undefined ? { agent: flagValue(argv, 'agent') } : {}),
    ...(flagValue(argv, 'tool') !== undefined ? { tool: flagValue(argv, 'tool') } : {}),
    ...(flagValue(argv, 'flow') !== undefined ? { flowId: flagValue(argv, 'flow') } : {}),
    ...(hasFlag(argv, 'failed') ? { outcome: 'error' as const } : {}),
    ...(parsedLimit !== undefined && Number.isFinite(parsedLimit) ? { limit: parsedLimit } : {}),
  };
}

/** The single most useful thing to show per row after the tool name: what it
 * acted on. Selector when there is one, else the payload, else the URL. */
function targetOf(record: ActivityRecord): string {
  if (record.selector !== null) return record.selector;
  if (record.payload !== null) return record.payload;
  if (record.url !== null) return record.url;
  return '—';
}

function pad(value: string, width: number): string {
  const clipped = value.length > width ? `${value.slice(0, width - 1)}…` : value;
  return clipped.padEnd(width);
}

function renderTable(records: ActivityRecord[], language: Language): string {
  const t = I18N[language];
  const lines = [
    [
      pad(t.header[0], 14),
      pad(t.header[1], 14),
      pad(t.header[2], 24),
      pad(t.header[3], 34),
      t.header[4],
    ].join('  '),
  ];
  for (const row of records) {
    lines.push(
      [
        pad(formatRelative(row.at, language), 14),
        pad(row.agent ?? '—', 14),
        pad(row.tool, 24),
        pad(targetOf(row), 34),
        row.outcome === 'ok' ? `ok ${row.durationMs}ms` : `error: ${row.error ?? ''}`,
      ].join('  '),
    );
  }
  return lines.join('\n');
}

function toCsv(records: Iterable<ActivityRecord>): string {
  // Every column of an ActivityRecord is a string, a number or null — narrowed
  // explicitly rather than leaning on String(), which would silently turn an
  // unexpected object into "[object Object]" in the middle of an export.
  const escape = (value: string | number | null): string => {
    if (value === null) return '';
    const text = typeof value === 'number' ? String(value) : value;
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const columns: (keyof ActivityRecord)[] = [
    'id',
    'at',
    'tool',
    'tabId',
    'transport',
    'url',
    'title',
    'agent',
    'agentPid',
    'selector',
    'payload',
    'outcome',
    'error',
    'durationMs',
    'flowId',
  ];
  const lines = [columns.join(',')];
  for (const row of records) lines.push(columns.map((c) => escape(row[c] ?? null)).join(','));
  return lines.join('\n');
}

function runExport(argv: string[], language: Language): string {
  const t = I18N[language];
  const format = flagValue(argv, 'format') ?? 'json';
  if (format !== 'json' && format !== 'ndjson' && format !== 'csv') return t.badFormat(format);

  const shouldRedact = hasFlag(argv, 'redact');
  const filter = buildQuery(argv);
  // `limit` is a display concern; an export takes everything matching.
  delete filter.limit;

  const rows: ActivityRecord[] = [];
  for (const row of exportAll(filter)) rows.push(shouldRedact ? redact(row) : row);

  const defaultName = `activity.${format === 'csv' ? 'csv' : format === 'ndjson' ? 'ndjson' : 'json'}`;
  const out = resolve(flagValue(argv, 'out') ?? defaultName);

  const body =
    format === 'csv'
      ? toCsv(rows)
      : format === 'ndjson'
        ? rows.map((r) => JSON.stringify(r)).join('\n')
        : JSON.stringify(rows, null, 2);
  writeFileSync(out, `${body}\n`, 'utf8');

  return [t.exported(rows.length, out), ...(shouldRedact ? [t.exportedRedacted] : [])].join('\n');
}

/** `browser-link activity stats` — the same figures the extension's usage
 * strip shows, for people who live in a terminal. */
function runStats(language: Language): string {
  const t = I18N[language];
  const s = stats();
  if (s.rows === 0) return t.empty;
  return [
    `${t.statRows}: ${s.rows.toLocaleString()} / ${s.maxRows.toLocaleString()}`,
    `${t.statSize}: ${formatBytes(s.bytes)}`,
    `${t.statOldest}: ${formatLocal(s.oldestAt)}`,
    `${t.statNewest}: ${formatLocal(s.newestAt)}`,
  ].join('\n');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function runClear(argv: string[], language: Language): string {
  const t = I18N[language];
  const olderThan = flagValue(argv, 'older-than');
  const from = flagValue(argv, 'from');
  const to = flagValue(argv, 'to');

  // Explicit range takes precedence and mirrors the extension's purge panel,
  // including its VACUUM — the point of purging is that the file shrinks.
  if (from !== undefined || to !== undefined) {
    const range = {
      ...(from !== undefined ? { from: localDayToUtc(from, 'start') } : {}),
      ...(to !== undefined ? { to: localDayToUtc(to, 'end') } : {}),
    };
    const willRemove = countInRange(range);
    if (willRemove === 0) return t.clearedNone;
    if (!hasFlag(argv, 'yes')) return t.confirmRange(willRemove);
    return t.cleared(purgeRange(range));
  }

  if (olderThan !== undefined) {
    const ms = parseDuration(olderThan);
    if (ms === null) return t.badOlderThan(olderThan);
    const removed = clear(new Date(Date.now() - ms).toISOString());
    return removed === 0 ? t.clearedNone : t.cleared(removed);
  }

  // Wiping the whole trail is the one destructive path here, and unlike
  // `--older-than` it cannot be partially undone by waiting. Confirmation is
  // required rather than offered.
  if (!hasFlag(argv, 'yes')) return t.confirmClear;
  const removed = clear();
  return removed === 0 ? t.clearedNone : t.cleared(removed);
}

/** `--since` for the report: a duration back from now (`30m`, `12h`, `7d`),
 * a bare local calendar day (same rule as `--from`), or any ISO date-time.
 * Null when it is none of those, so a typo is refused instead of silently
 * widening the report to the whole trail. */
export function parseSince(value: string, now = Date.now()): string | null {
  const ms = parseDuration(value);
  if (ms !== null) return new Date(now - ms).toISOString();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return localDayToUtc(value, 'start');
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function countList(counts: Record<string, number | undefined>): string {
  const parts = Object.entries(counts)
    .filter((entry): entry is [string, number] => entry[1] !== undefined)
    .map(([name, n]) => `${name} ${n}`);
  return parts.length > 0 ? parts.join(', ') : '—';
}

/** `browser-link activity report` — the same summary `browser.activity`
 * returns with `summary: true`, laid out for a terminal. */
function runReport(argv: string[], language: Language): string {
  const t = I18N[language];
  const sinceRaw = flagValue(argv, 'since');
  const agentId = flagValue(argv, 'agent');
  const filters: ActivitySummaryFilters = {};
  if (sinceRaw !== undefined) {
    const since = parseSince(sinceRaw);
    if (since === null) return t.badSince(sinceRaw);
    filters.since = since;
  }
  if (agentId !== undefined) filters.agentId = agentId;

  const s = summarizeActivity(undefined, filters);
  if (s.records === 0) return `${t.empty}\n${t.disabledHint}`;

  const lines = [t.reportTitle(s.records, s.errors, s.timeouts, s.evaluate_calls)];
  const counted = (title: string, counts: Record<string, number | undefined>): void => {
    const entries = Object.entries(counts).filter(
      (entry): entry is [string, number] => entry[1] !== undefined,
    );
    if (entries.length === 0) return;
    lines.push('', title, ...entries.map(([name, n]) => `  ${pad(name, 18)}  ${n}`));
  };
  counted(t.reportFlags, s.by_flag);
  counted(t.reportToolErrors, s.by_tool_errors);

  if (s.top_failing_targets.length > 0) {
    const [target, tool, count, lastFlag] = t.reportTargetsHeader;
    lines.push(
      '',
      t.reportTargets,
      `  ${[pad(target, 30), pad(tool, 24), pad(count, 6), lastFlag].join('  ')}`,
      ...s.top_failing_targets.map(
        (f) =>
          `  ${[pad(f.selector, 30), pad(f.tool, 24), pad(String(f.n), 6), f.last_flag ?? '—'].join('  ')}`,
      ),
    );
  }

  const [session, agent, actions, errors, flags] = t.reportSessionsHeader;
  lines.push(
    '',
    t.reportSessions,
    `  ${[pad(session, 36), pad(agent, 14), pad(actions, 8), pad(errors, 7), flags].join('  ')}`,
    ...s.sessions.map(
      (x) =>
        `  ${[
          pad(x.agent_id ?? '—', 36),
          pad(x.agent ?? '—', 14),
          pad(String(x.records), 8),
          pad(String(x.errors), 7),
          countList(x.flags),
        ].join('  ')}`,
    ),
  );

  // Cost and map usage: what the results weighed and how much the map and
  // the readers were used, so one release can be compared with the next.
  const u = t.reportUsageLabels;
  const usageLine = (label: string, value: string): string => `  ${pad(label, 22)}  ${value}`;
  lines.push(
    '',
    t.reportUsage,
    usageLine(u.bytes, formatBytes(s.bytes_total)),
    usageLine(u.evaluateShare, `${Math.round(s.evaluate_share * 100)}%`),
    usageLine(u.listTabs, String(s.list_tabs_calls)),
    usageLine(u.mapRecall, String(s.map_recall_calls)),
    usageLine(u.readers, String(s.readers_run)),
  );
  const byTool = Object.entries(s.bytes_by_tool);
  if (byTool.length > 0) {
    lines.push(
      '',
      t.reportBytesByTool,
      ...byTool.map(([tool, n]) => `  ${pad(tool, 22)}  ${formatBytes(n)}`),
    );
  }
  return lines.join('\n');
}

export function runActivityCommand(argv: string[], language: Language = 'en'): string {
  const t = I18N[language];
  const sub = argv[0];

  if (sub === 'help' || hasFlag(argv, 'help')) return t.usage;
  if (sub === 'stats') return runStats(language);
  if (sub === 'report') return runReport(argv.slice(1), language);
  if (sub === 'export') return runExport(argv.slice(1), language);
  if (sub === 'clear') return runClear(argv.slice(1), language);

  const page = query(
    buildQuery(argv).limit === undefined ? { ...buildQuery(argv), limit: 50 } : buildQuery(argv),
  );
  if (page.records.length === 0) return `${t.empty}\n${t.disabledHint}`;

  const agents = listAgents();
  return [
    renderTable(page.records, language),
    '',
    t.showing(page.records.length, page.total),
    agents.length > 0
      ? `${t.agents} ${agents.map((a) => `${a.agent} (${a.count})`).join(', ')}`
      : '',
  ]
    .filter((line) => line !== '')
    .join('\n');
}
