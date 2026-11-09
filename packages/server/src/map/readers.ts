import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { loadConfig } from '../config.js';
import { serializedBytes } from '../activity/extract.js';
import { getDb } from './db.js';
import { resolveLearnerApp } from './queries.js';

/**
 * The JS registry: every `browser.evaluate` an agent runs, recorded by the
 * tool, append-only.
 *
 * WHY
 * ---
 * Two thirds of what agents dispatch is `browser.evaluate`, and until now
 * every one of those expressions died with its result. The next session on
 * the same app wrote the same reader again from scratch. This module keeps
 * each distinct expression once per app (`sha256(expression)` is the
 * identity), with ok/fail counters, build stamps and the average size of its
 * result, so a later curation step can keep the useful ones under a name.
 *
 * RULES THIS MODULE ENFORCES
 * --------------------------
 *   - Append-only. Nothing rewrites `expression`; a repeat run only moves
 *     counters, stamps and the running average, and flags only ever grow.
 *     `status`/`name` change only through `setReaderStatus` (curation).
 *   - Privacy, server-side. An expression with a secret shape (JWT, long hex,
 *     credential/storage words) is never stored, and neither is one that
 *     contains a value the agent typed in this process. The agent is never
 *     trusted to have left those out.
 *   - Bounded. At most `MAX_READERS_PER_APP` rows per app; making room
 *     evicts `dropped` rows first, then the oldest `pending` row that never
 *     worked, never a `kept` one, inside the same transaction as the insert.
 *   - One transaction per write, so a crash leaves the old state or the new
 *     one.
 *   - Gated by the `mapLearningEnabled` switch, read per call. The trail's
 *     `activityRecordPayloads` switch does not apply: this stores code, not
 *     the values it returned.
 */

export const READER_FLAGS = ['literal_data', 'secret_shape'] as const;
export type ReaderFlag = (typeof READER_FLAGS)[number];
export type ReaderKind = 'reader' | 'mutation';
export type ReaderStatus = 'pending' | 'kept' | 'dropped';

/** Rows kept per app. See the eviction order above. */
export const MAX_READERS_PER_APP = 300;

/** Typed values remembered per process for the privacy checks. */
export const MAX_TYPED_VALUES = 50;

/** Typed values shorter than this are not matched: a one-character value
 * appears in almost any expression and would only add noise. */
const MIN_TYPED_MATCH = 2;

export interface ReaderRow {
  id: number;
  app_id: number;
  hash: string;
  expression: string;
  kind: ReaderKind;
  name: string | null;
  ok_n: number;
  fail_n: number;
  last_ok_at: string | null;
  last_fail_at: string | null;
  last_ok_build: string | null;
  result_bytes_avg: number | null;
  flags: ReaderFlag[];
  status: ReaderStatus;
  created_at: string;
  /** `<PLACEHOLDER>` form of `expression`, set only by curation (S10 rule
   * 2). `browser.read` runs it with the placeholders filled. */
  template?: string | null;
}

type StoredReaderRow = Omit<ReaderRow, 'flags'> & { flags: string };

/* --------------------------------------------------- typed values ------ */

const typed: string[] = [];

/** Remember a string the agent sent through `browser.type`. Non-strings and
 * empty strings are ignored. Keeps the last `MAX_TYPED_VALUES`. In memory
 * only: the values are never written anywhere. */
export function rememberTypedValue(text: unknown): void {
  if (typeof text !== 'string' || text.length === 0) return;
  typed.push(text);
  if (typed.length > MAX_TYPED_VALUES) typed.splice(0, typed.length - MAX_TYPED_VALUES);
}

/** Remember every value a `browser.flow` call types or fills in: its `type`
 * steps' text (inner `repeat` steps included) and its `values`. */
export function rememberTypedValuesFromFlow(args: unknown): void {
  for (const text of typedTextsOf(args)) rememberTypedValue(text);
}

/**
 * Every value a call types or fills in: `browser.type`'s `text`, each
 * `type` step's text of a `browser.flow` (inner `repeat` steps included),
 * and every string/number/boolean of a `values` object (`browser.flow`,
 * `browser.read` placeholders). Non-empty strings only.
 */
export function typedTextsOf(args: unknown): string[] {
  const out: string[] = [];
  const push = (v: unknown): void => {
    if (typeof v === 'string' && v.length > 0) out.push(v);
    else if (typeof v === 'number' || typeof v === 'boolean') out.push(String(v));
  };
  const visit = (steps: unknown): void => {
    if (!Array.isArray(steps)) return;
    for (const step of steps) {
      if (typeof step !== 'object' || step === null) continue;
      const s = step as { type?: unknown; repeat?: unknown };
      if (typeof s.type === 'object' && s.type !== null) {
        const text = (s.type as { text?: unknown }).text;
        if (typeof text === 'string' && text.length > 0) out.push(text);
      }
      if (typeof s.repeat === 'object' && s.repeat !== null) {
        visit((s.repeat as { steps?: unknown }).steps);
      }
    }
  };
  if (typeof args !== 'object' || args === null) return out;
  const a = args as { steps?: unknown; values?: unknown };
  visit(a.steps);
  if (typeof a.values === 'object' && a.values !== null && !Array.isArray(a.values)) {
    Object.values(a.values).forEach(push);
  }
  return out;
}

/** A copy of the remembered typed values, oldest first. */
export function typedValues(): string[] {
  return [...typed];
}

/** Forget every remembered typed value. Used by tests. */
export function clearTypedValues(): void {
  typed.length = 0;
}

/* ------------------------------------------------ static analysis ------ */

/** Quoted string literals ('…', "…", `…`), escapes honoured. Template
 * literals are taken whole, `${…}` included: over-matching only flags more. */
const STRING_LITERAL = /(['"`])((?:\\[\s\S]|(?!\1)[^\\])*)\1/g;

/** Assignment to a property: `.name =`, `] =`, compound forms included;
 * `==`, `===`, `!=`, `<=`, `>=` and `=>` are not assignments. */
const PROPERTY_ASSIGNMENT =
  /(?:\.\s*[A-Za-z_$][\w$]*|\])\s*(?:\*\*|<<|>>>|>>|&&|\|\||\?\?|[-+*/%&|^])?=(?![=>])/;

const MUTATION_CALLS: readonly RegExp[] = [
  /\.click\s*\(/,
  /\bdispatchEvent\s*\(/,
  /\.value\s*=(?!=)/,
  /\.submit\s*\(/,
  /\.requestSubmit\s*\(/,
  /\.focus\s*\(/,
  /\.remove\s*\(/,
  /\.setAttribute\s*\(/,
  /\.removeAttribute\s*\(/,
  /\.innerHTML\s*=(?!=)/,
  /\.outerHTML\s*=(?!=)/,
  /\.textContent\s*=(?!=)/,
  /\.insertAdjacentHTML\s*\(/,
  /\.append(?:Child)?\s*\(/,
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
  /\bsendBeacon\s*\(/,
];

const SECRET_SHAPES: readonly RegExp[] = [
  /eyJ[A-Za-z0-9_-]{10,}\./,
  /[0-9a-fA-F]{32,}/,
  /password|passwd|token|secret|cookie|localStorage|sessionStorage|authorization/i,
];

function stringLiterals(expression: string): string[] {
  return [...expression.matchAll(STRING_LITERAL)].map((m) => m[2]);
}

function usableTyped(values: readonly string[]): string[] {
  return values.filter((v) => v.length >= MIN_TYPED_MATCH);
}

function isLiteralData(literal: string, typedList: readonly string[]): boolean {
  if (/\s/.test(literal) || literal.includes('@') || /\d{6,}/.test(literal)) return true;
  return typedList.some((v) => literal.includes(v));
}

/**
 * Classify an expression statically. Pure.
 *
 * `kind` is `mutation` when the code assigns to a property or calls something
 * that changes the page or talks to the network; anything else is `reader`.
 * String literals are blanked first, so `"a.b = c"` inside a string does not
 * count. Erring towards `mutation` is the safe side: a mutation is never kept
 * as a reader.
 *
 * Flags: `literal_data` when a string literal looks like data (a space, `@`,
 * six digits in a row, or a value the agent typed); `secret_shape` when the
 * code carries a JWT, a long hex string or a credential/storage word.
 */
export function analyzeExpression(
  expression: string,
  typedValuesList: readonly string[],
): { kind: ReaderKind; flags: ReaderFlag[] } {
  const code = expression.replace(STRING_LITERAL, '""');
  const mutation =
    PROPERTY_ASSIGNMENT.test(code) || MUTATION_CALLS.some((pattern) => pattern.test(code));
  const typedList = usableTyped(typedValuesList);
  const flags: ReaderFlag[] = [];
  if (stringLiterals(expression).some((lit) => isLiteralData(lit, typedList))) {
    flags.push('literal_data');
  }
  if (SECRET_SHAPES.some((pattern) => pattern.test(expression))) flags.push('secret_shape');
  return { kind: mutation ? 'mutation' : 'reader', flags };
}

/** The string literals of `expression` that look like data (see
 * `analyzeExpression`): what curation rule 2 requires a template to replace. */
export function dataLiterals(expression: string, typedValuesList: readonly string[]): string[] {
  const typedList = usableTyped(typedValuesList);
  return [...new Set(stringLiterals(expression).filter((lit) => isLiteralData(lit, typedList)))];
}

/** The code of `expression` with every string literal blanked: two
 * expressions with the same skeleton differ only inside string literals. */
export function codeSkeleton(expression: string): string {
  return expression.replace(STRING_LITERAL, '""');
}

/** Whether `expression` has a secret shape (JWT, long hex, credential or
 * storage words). */
export function hasSecretShape(expression: string): boolean {
  return SECRET_SHAPES.some((pattern) => pattern.test(expression));
}

/** Whether `text` carries a secret-looking VALUE (a JWT or a long hex
 * string). Unlike `hasSecretShape`, credential words alone do not count:
 * prose about a tool may name them. */
export function hasSecretValue(text: string): boolean {
  return SECRET_SHAPES.slice(0, 2).some((pattern) => pattern.test(text));
}

/** Reader names (curation rule 4): kebab-case, at most `MAX_READER_NAME`
 * characters, first word not one of `NAME_VERBS` (names say what is
 * returned, not what is done). */
export const READER_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const MAX_READER_NAME = 40;
export const NAME_VERBS = ['get', 'set', 'do', 'run', 'make'] as const;

/** Why `name` breaks rule 4, or null when it is a valid reader name. */
export function readerNameProblem(name: unknown): string | null {
  if (typeof name !== 'string' || name.length === 0) return 'a name is required';
  if (name.length > MAX_READER_NAME) return `longer than ${MAX_READER_NAME} characters`;
  if (!READER_NAME.test(name)) return 'not kebab-case (a-z, 0-9, single dashes)';
  const first = name.split('-')[0];
  if ((NAME_VERBS as readonly string[]).includes(first)) {
    return `starts with the verb "${first}": name what is returned`;
  }
  return null;
}

/** Whether `expression` contains, anywhere, a value the agent typed. */
export function containsTypedValue(
  expression: string,
  typedValuesList: readonly string[],
): boolean {
  return usableTyped(typedValuesList).some((v) => expression.includes(v));
}

/** Why an expression must not be stored, or null when it may be. */
function refusal(expression: string, typedValuesList: readonly string[]): string | null {
  if (analyzeExpression(expression, typedValuesList).flags.includes('secret_shape')) {
    return 'secret shape';
  }
  if (containsTypedValue(expression, typedValuesList)) return 'contains a typed value';
  return null;
}

function logSkip(reason: string): void {
  console.error(`[browser-link] js registry: expression not stored (${reason})`);
}

/* ------------------------------------------------------- storage ------ */

export interface UpsertReaderInput {
  appId: number;
  expression: string;
  /** Whether this run worked (resolved without throwing). */
  ok: boolean;
  /** Build fingerprint of the page at the time, when known. */
  build?: string | null;
  /** `serializedBytes(result)` of an ok run. */
  resultBytes?: number | null;
  /** Typed values to check against. Defaults to this process's ring. */
  typedValues?: readonly string[];
}

function parseFlags(raw: string): ReaderFlag[] {
  return raw
    .split(',')
    .filter((f): f is ReaderFlag => (READER_FLAGS as readonly string[]).includes(f));
}

function toReader(row: StoredReaderRow): ReaderRow {
  return { ...row, flags: parseFlags(row.flags) };
}

function mergeFlags(stored: string, added: readonly ReaderFlag[]): string {
  const set = new Set<string>(parseFlags(stored));
  for (const f of added) set.add(f);
  return READER_FLAGS.filter((f) => set.has(f)).join(',');
}

/** Make room for one row, or report that none can be made. */
function evictOne(db: Database.Database, appId: number): boolean {
  const victim = (db
    .prepare(
      `SELECT id FROM js_readers WHERE app_id = ? AND status = 'dropped'
       ORDER BY created_at ASC, id ASC LIMIT 1`,
    )
    .get(appId) ??
    db
      .prepare(
        `SELECT id FROM js_readers WHERE app_id = ? AND status = 'pending' AND ok_n = 0
         ORDER BY created_at ASC, id ASC LIMIT 1`,
      )
      .get(appId)) as { id: number } | undefined;
  if (!victim) return false;
  db.prepare('DELETE FROM js_readers WHERE id = ?').run(victim.id);
  return true;
}

/**
 * Record one run of `expression` on an app. Identical expression = same row:
 * counters up, stamps set, running average of the result size updated, flags
 * merged (they only grow). A new expression is inserted, making room under
 * the cap first. One transaction.
 *
 * Returns the row as stored, or null when the expression was refused (secret
 * shape, typed value) or the cap left no evictable row. Refusals log one line.
 */
export function upsertReader(db: Database.Database, input: UpsertReaderInput): ReaderRow | null {
  const typedList = input.typedValues ?? typed;
  const refused = refusal(input.expression, typedList);
  if (refused) {
    logSkip(refused);
    return null;
  }
  const { kind, flags } = analyzeExpression(input.expression, typedList);
  const hash = createHash('sha256').update(input.expression).digest('hex');
  const at = new Date().toISOString();
  const bytes =
    input.ok && typeof input.resultBytes === 'number' && Number.isFinite(input.resultBytes)
      ? Math.max(0, Math.round(input.resultBytes))
      : null;

  const write = db.transaction((): ReaderRow | null => {
    const existing = db
      .prepare('SELECT * FROM js_readers WHERE app_id = ? AND hash = ?')
      .get(input.appId, hash) as StoredReaderRow | undefined;
    if (existing) {
      const avg =
        bytes === null
          ? existing.result_bytes_avg
          : existing.result_bytes_avg === null || existing.ok_n === 0
            ? bytes
            : Math.round((existing.result_bytes_avg * existing.ok_n + bytes) / (existing.ok_n + 1));
      if (input.ok) {
        db.prepare(
          `UPDATE js_readers SET ok_n = ok_n + 1, last_ok_at = ?, last_ok_build = ?,
             result_bytes_avg = ?, flags = ? WHERE id = ?`,
        ).run(at, input.build ?? null, avg, mergeFlags(existing.flags, flags), existing.id);
      } else {
        db.prepare(
          `UPDATE js_readers SET fail_n = fail_n + 1, last_fail_at = ?, flags = ? WHERE id = ?`,
        ).run(at, mergeFlags(existing.flags, flags), existing.id);
      }
      return toReader(
        db.prepare('SELECT * FROM js_readers WHERE id = ?').get(existing.id) as StoredReaderRow,
      );
    }
    const { n } = db
      .prepare('SELECT COUNT(*) AS n FROM js_readers WHERE app_id = ?')
      .get(input.appId) as { n: number };
    for (let excess = n - MAX_READERS_PER_APP + 1; excess > 0; excess -= 1) {
      if (!evictOne(db, input.appId)) return null;
    }
    const info = db
      .prepare(
        `INSERT INTO js_readers
           (app_id, hash, expression, kind, ok_n, fail_n, last_ok_at, last_fail_at,
            last_ok_build, result_bytes_avg, flags, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        input.appId,
        hash,
        input.expression,
        kind,
        input.ok ? 1 : 0,
        input.ok ? 0 : 1,
        input.ok ? at : null,
        input.ok ? null : at,
        input.ok ? (input.build ?? null) : null,
        bytes,
        mergeFlags('', flags),
        at,
      );
    return toReader(
      db
        .prepare('SELECT * FROM js_readers WHERE id = ?')
        .get(info.lastInsertRowid) as StoredReaderRow,
    );
  });
  const row = write();
  if (row === null) logSkip(`cap of ${MAX_READERS_PER_APP} rows reached`);
  return row;
}

export interface ListReadersOptions {
  status?: ReaderStatus;
  limit?: number;
}

/** An app's readers, oldest first, optionally narrowed by status. */
export function listReaders(
  db: Database.Database,
  appId: number,
  opts: ListReadersOptions = {},
): ReaderRow[] {
  const clauses = ['app_id = ?'];
  const params: unknown[] = [appId];
  if (opts.status !== undefined) {
    clauses.push('status = ?');
    params.push(opts.status);
  }
  const limit = opts.limit !== undefined ? ' LIMIT ?' : '';
  if (opts.limit !== undefined) params.push(Math.max(0, Math.floor(opts.limit)));
  const rows = db
    .prepare(`SELECT * FROM js_readers WHERE ${clauses.join(' AND ')} ORDER BY id ASC${limit}`)
    .all(...params) as StoredReaderRow[];
  return rows.map(toReader);
}

/** Curation: set a row's status and, optionally, its name. The only write
 * path to those two columns; `expression` is never touched. Returns whether
 * a row was changed. */
export function setReaderStatus(
  db: Database.Database,
  id: number,
  status: ReaderStatus,
  name?: string | null,
): boolean {
  const info =
    name === undefined
      ? db.prepare('UPDATE js_readers SET status = ? WHERE id = ?').run(status, id)
      : db.prepare('UPDATE js_readers SET status = ?, name = ? WHERE id = ?').run(status, name, id);
  return info.changes > 0;
}

/** Curation: store the `<PLACEHOLDER>` template of a kept reader. The
 * expression itself is never touched. */
export function setReaderTemplate(
  db: Database.Database,
  id: number,
  template: string | null,
): void {
  db.prepare('UPDATE js_readers SET template = ? WHERE id = ?').run(template, id);
}

/** One reader by id, any app and status, or null. */
export function getReader(db: Database.Database, id: number): ReaderRow | null {
  const row = db.prepare('SELECT * FROM js_readers WHERE id = ?').get(id) as
    StoredReaderRow | undefined;
  return row ? toReader(row) : null;
}

/** A kept reader of an app, by id or (most recent) name, or null. */
export function findKeptReader(
  db: Database.Database,
  appId: number,
  ref: { name?: string; id?: number },
): ReaderRow | null {
  const row = (
    ref.id !== undefined
      ? db
          .prepare(`SELECT * FROM js_readers WHERE app_id = ? AND id = ? AND status = 'kept'`)
          .get(appId, ref.id)
      : db
          .prepare(
            `SELECT * FROM js_readers WHERE app_id = ? AND name = ? AND status = 'kept'
             ORDER BY id DESC LIMIT 1`,
          )
          .get(appId, ref.name ?? null)
  ) as StoredReaderRow | undefined;
  return row ? toReader(row) : null;
}

/* -------------------------------------------------- dispatch glue ------ */

export interface ReaderDispatchContext {
  tool: string;
  args: unknown;
  result?: unknown;
  error?: unknown;
  /** The tab's URL after the call. */
  url?: string | null;
  /** The page's build fingerprint, when known. */
  build?: string | null;
}

function isErrorEnvelope(result: unknown): boolean {
  return (
    typeof result === 'object' &&
    result !== null &&
    Array.isArray((result as { content?: unknown }).content) &&
    (result as { isError?: unknown }).isError === true
  );
}

/**
 * Called by the map learner for every settled tool call. A no-op unless the
 * tool is `browser.evaluate` with a string expression on a tab with a real
 * origin and map learning is on. Never throws: a failure logs one line.
 */
export function recordReaderFromDispatch(ctx: ReaderDispatchContext): void {
  try {
    if (ctx.tool !== 'browser.evaluate') return;
    const args = ctx.args;
    if (typeof args !== 'object' || args === null) return;
    const expression = (args as { expression?: unknown }).expression;
    if (typeof expression !== 'string' || expression.trim().length === 0) return;
    if (!ctx.url) return;
    let origin: string;
    try {
      origin = new URL(ctx.url).origin;
    } catch {
      return;
    }
    if (origin === 'null') return;
    if (loadConfig().mapLearningEnabled === false) return;
    // Refuse before touching the DB, so a refused expression does not even
    // create the app row.
    const refused = refusal(expression, typed);
    if (refused) {
      logSkip(refused);
      return;
    }
    const ok = ctx.error === undefined && !isErrorEnvelope(ctx.result);
    const db = getDb();
    // `as` (S11) names the row at write time; it stays `pending` until
    // `browser.wrap_up` decides. The dispatcher already refused a bad name.
    const as = (args as { as?: unknown }).as;
    const name = typeof as === 'string' && readerNameProblem(as) === null ? as : null;
    db.transaction(() => {
      const app = resolveLearnerApp(db, origin);
      const row = upsertReader(db, {
        appId: app.id,
        expression,
        ok,
        build: ctx.build ?? null,
        resultBytes: ok ? serializedBytes(ctx.result) : null,
      });
      if (row && name !== null && row.status === 'pending') {
        setReaderStatus(db, row.id, 'pending', name);
      }
    })();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[browser-link] js registry failed: ${message}`);
  }
}
