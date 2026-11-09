import type Database from 'better-sqlite3';
import { getDb } from './db.js';
import { canonicalOrigin } from './origin.js';
import { confidenceOf, type Confidence, type Evidence } from './confidence.js';
import { pathPattern } from './keys.js';

export type EntryKind = 'selector' | 'flow' | 'gotcha';

export interface AppRow {
  id: number;
  origin: string;
  app_key: string;
  title: string | null;
  notes: string | null;
  created_at: string;
  last_seen_at: string;
}

export interface EntryRow {
  id: number;
  app_id: number;
  url_pattern: string;
  kind: EntryKind;
  purpose: string;
  payload: unknown;
  verified_at: string | null;
  failed_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  /** Set by `recall()` only (never stored): see `withPreference`. */
  prefer?: 'semantic_key';
}

interface RawEntryRow extends Omit<EntryRow, 'payload'> {
  payload: string;
}

function now(): string {
  return new Date().toISOString();
}

function parsePayload(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function hydrate(row: RawEntryRow): EntryRow {
  return { ...row, payload: parsePayload(row.payload) };
}

function slugify(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function deriveAppKey(origin: string, title?: string | null): string {
  if (title && title.trim().length > 0) {
    const slug = slugify(title);
    if (slug.length > 0) return slug;
  }
  // last-resort: use origin host as key
  try {
    return slugify(new URL(origin).host);
  } catch {
    return slugify(origin) || 'app';
  }
}

export interface UpsertAppInput {
  origin: string;
  app_key?: string | null;
  title?: string | null;
  notes?: string | null;
}

export function upsertApp(input: UpsertAppInput): AppRow {
  const db = getDb();
  const ts = now();
  // v0.20.0: canonicalize on EVERY write so the exact-string lookups in
  // recall/getMapHint (whose key comes from `new URL(tab.url).origin`)
  // always match what save stored — see origin.ts for the full rationale.
  const origin = canonicalOrigin(input.origin);
  const app_key =
    input.app_key && input.app_key.trim().length > 0
      ? slugify(input.app_key)
      : deriveAppKey(origin, input.title);

  const existing = db
    .prepare('SELECT * FROM apps WHERE origin = ? AND app_key = ?')
    .get(origin, app_key) as AppRow | undefined;

  if (existing) {
    db.prepare(
      `UPDATE apps SET title = COALESCE(?, title), notes = COALESCE(?, notes), last_seen_at = ? WHERE id = ?`,
    ).run(input.title ?? null, input.notes ?? null, ts, existing.id);
    return db.prepare('SELECT * FROM apps WHERE id = ?').get(existing.id) as AppRow;
  }

  const info = db
    .prepare(
      `INSERT INTO apps (origin, app_key, title, notes, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(origin, app_key, input.title ?? null, input.notes ?? null, ts, ts);

  return db.prepare('SELECT * FROM apps WHERE id = ?').get(info.lastInsertRowid) as AppRow;
}

/**
 * The app the map learner counts into for an origin, read-only on purpose.
 *
 * Picks the most recently seen app of the canonical origin with the same
 * winner rule `getMapHints` applies (last_seen_at DESC, id DESC), so learned
 * rows land in the app `list_tabs` and `recall` already show. It never
 * touches that app's `last_seen_at` or `title`: a passive learner bumping
 * freshness would reorder which app an origin resolves to. Only when the
 * origin has no app at all does it create one, keyed and titled by the
 * origin host, never by a tab title (titles change with page state, e.g.
 * "Inbox (3) - My App", and would mint a new app per title).
 */
export function resolveLearnerApp(db: Database.Database, origin: string): AppRow {
  const canonical = canonicalOrigin(origin);
  const winner = db
    .prepare('SELECT * FROM apps WHERE origin = ? ORDER BY last_seen_at DESC, id DESC LIMIT 1')
    .get(canonical) as AppRow | undefined;
  if (winner) return winner;
  let host: string;
  try {
    host = new URL(canonical).host;
  } catch {
    host = canonical;
  }
  const ts = now();
  const info = db
    .prepare(
      `INSERT INTO apps (origin, app_key, title, notes, created_at, last_seen_at)
       VALUES (?, ?, ?, NULL, ?, ?)`,
    )
    .run(canonical, deriveAppKey(canonical, null), host, ts, ts);
  return db.prepare('SELECT * FROM apps WHERE id = ?').get(info.lastInsertRowid) as AppRow;
}

export interface SaveEntryInput {
  origin: string;
  app_key?: string | null;
  title?: string | null;
  url_pattern: string;
  kind: EntryKind;
  purpose: string;
  payload: unknown;
  notes?: string | null;
}

export function saveEntry(input: SaveEntryInput): { app: AppRow; entry: EntryRow } {
  const app = upsertApp({
    origin: input.origin,
    app_key: input.app_key ?? null,
    title: input.title ?? null,
  });
  const ts = now();
  const payloadJson = JSON.stringify(input.payload);
  const db = getDb();

  const existing = db
    .prepare(
      `SELECT * FROM entries WHERE app_id = ? AND url_pattern = ? AND kind = ? AND purpose = ?`,
    )
    .get(app.id, input.url_pattern, input.kind, input.purpose) as RawEntryRow | undefined;

  if (existing) {
    db.prepare(
      `UPDATE entries
       SET payload = ?, notes = COALESCE(?, notes), verified_at = ?, failed_at = NULL, updated_at = ?
       WHERE id = ?`,
    ).run(payloadJson, input.notes ?? null, ts, ts, existing.id);
    const updated = db
      .prepare('SELECT * FROM entries WHERE id = ?')
      .get(existing.id) as RawEntryRow;
    return { app, entry: hydrate(updated) };
  }

  const info = db
    .prepare(
      `INSERT INTO entries (app_id, url_pattern, kind, purpose, payload, verified_at, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      app.id,
      input.url_pattern,
      input.kind,
      input.purpose,
      payloadJson,
      ts,
      input.notes ?? null,
      ts,
      ts,
    );
  const inserted = db
    .prepare('SELECT * FROM entries WHERE id = ?')
    .get(info.lastInsertRowid) as RawEntryRow;
  return { app, entry: hydrate(inserted) };
}

export interface RestoreEntryInput {
  origin: string;
  app_key?: string | null;
  title?: string | null;
  url_pattern: string;
  kind: EntryKind;
  purpose: string;
  payload: unknown;
  notes?: string | null;
  verified_at?: string | null;
  failed_at?: string | null;
}

/**
 * Restore-only counterpart to `saveEntry`, used by `browser-link map
 * import`. `saveEntry` models "the agent just successfully executed
 * this": it stamps `verified_at = now` and clears `failed_at` — the right
 * semantics for a live save, and the WRONG ones for a backup restore,
 * where re-stamping would silently "heal" a selector the map knew to be
 * broken. This writes `verified_at`/`failed_at`/`notes` exactly as given
 * (including null), preserving the entry's track record through an
 * export → import round trip. Same upsert key as `saveEntry`
 * ((app, url_pattern, kind, purpose)); the agent-facing
 * `browser.map.save` never calls this.
 */
export function restoreEntry(input: RestoreEntryInput): { app: AppRow; entry: EntryRow } {
  const app = upsertApp({
    origin: input.origin,
    app_key: input.app_key ?? null,
    title: input.title ?? null,
  });
  const ts = now();
  const payloadJson = JSON.stringify(input.payload);
  const db = getDb();

  const existing = db
    .prepare(
      `SELECT * FROM entries WHERE app_id = ? AND url_pattern = ? AND kind = ? AND purpose = ?`,
    )
    .get(app.id, input.url_pattern, input.kind, input.purpose) as RawEntryRow | undefined;

  if (existing) {
    db.prepare(
      `UPDATE entries
       SET payload = ?, notes = ?, verified_at = ?, failed_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      payloadJson,
      input.notes ?? null,
      input.verified_at ?? null,
      input.failed_at ?? null,
      ts,
      existing.id,
    );
    const updated = db
      .prepare('SELECT * FROM entries WHERE id = ?')
      .get(existing.id) as RawEntryRow;
    return { app, entry: hydrate(updated) };
  }

  const info = db
    .prepare(
      `INSERT INTO entries (app_id, url_pattern, kind, purpose, payload, verified_at, failed_at, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      app.id,
      input.url_pattern,
      input.kind,
      input.purpose,
      payloadJson,
      input.verified_at ?? null,
      input.failed_at ?? null,
      input.notes ?? null,
      ts,
      ts,
    );
  const inserted = db
    .prepare('SELECT * FROM entries WHERE id = ?')
    .get(info.lastInsertRowid) as RawEntryRow;
  return { app, entry: hydrate(inserted) };
}

export interface RecallInput {
  origin: string;
  app_key?: string | null;
  url?: string | null;
  /** `'path'` (default): the route view, exactly as before scopes existed.
   * `'app'`: the whole map of the app. `'all'`: the whole map of every app
   * of the origin. */
  scope?: RecallScope;
}

export type RecallScope = 'path' | 'app' | 'all';

export interface RecallResult {
  app: AppRow | null;
  /** Listed first on purpose: a pitfall is the most expensive thing to
   * rediscover, so it is the first thing an agent reads. */
  pitfalls: InsightRow[];
  mechanisms: InsightRow[];
  entries: EntryRow[];
  /** What the map learned from use (see learning.ts): failures first, then
   * most used, at most `RECALL_MAX_LEARNED`. Present only when the app has
   * learned rows, so a recall of an app with none reads exactly as before. */
  learned?: LearnedRecallItem[];
  flows: FlowRow[];
}

/** One learned target as `list_tabs`' inline map carries it. Targets only:
 * a CSS selector, or a `browser.find` semantic key as JSON. */
export interface LearnedSummary {
  target: string;
  target_kind: 'selector' | 'key';
  action: string;
  ok_n: number;
  fail_n: number;
  last_reason: string | null;
}

/** Recall's richer form: the route it was learned on and when. */
export interface LearnedRecallItem extends LearnedSummary {
  url_pattern: string;
  last_ok_at: string | null;
  last_fail_at: string | null;
}

/** At most this many learned rows in a recall. */
const RECALL_MAX_LEARNED = 50;
/** At most this many learned rows in the `list_tabs` inline map. */
const INLINE_MAX_LEARNED = 3;

/** Failures first (rows that ever failed), then the most used; oldest row
 * first on a tie so the order is stable. */
const LEARNED_ORDER = 'ORDER BY (fail_n > 0) DESC, (ok_n + fail_n) DESC, id ASC';

/** Learned rows of one app in hint order, capped at `limit`. Takes the DB
 * explicitly so the learner's tests can read through the handle they write
 * through. */
export function listLearned(
  db: Database.Database,
  app_id: number,
  limit: number,
): LearnedRecallItem[] {
  return db
    .prepare(
      `SELECT target, target_kind, action, ok_n, fail_n, last_reason, url_pattern, last_ok_at, last_fail_at
       FROM selector_outcomes WHERE app_id = ? ${LEARNED_ORDER} LIMIT ?`,
    )
    .all(app_id, limit) as LearnedRecallItem[];
}

export function recall(input: RecallInput & { scope?: 'path' }): RecallResult;
export function recall(input: RecallInput & { scope: 'app' }): AppRecallResult;
export function recall(input: RecallInput & { scope: 'all' }): AllRecallResult;
export function recall(input: RecallInput): RecallResult | AppRecallResult | AllRecallResult;
export function recall(input: RecallInput): RecallResult | AppRecallResult | AllRecallResult {
  if (input.scope === 'all') {
    // Every app of the origin, most recently seen first. Read-only: touching
    // every app would reorder which one the origin resolves to.
    const db = getDb();
    const apps = db
      .prepare('SELECT * FROM apps WHERE origin = ? ORDER BY last_seen_at DESC, id DESC')
      .all(canonicalOrigin(input.origin)) as AppRow[];
    return { scope: 'all', apps: apps.map((app) => recallWholeApp(db, app)) };
  }
  return recallOneApp(input);
}

/** The `path` and `app` scopes: one app, resolved and touched the same way. */
function recallOneApp(input: RecallInput): RecallResult | AppRecallResult {
  const db = getDb();
  // Same canonicalization as upsertApp — a recall with a trailing-slash or
  // full-URL origin must find what a canonical save stored.
  const origin = canonicalOrigin(input.origin);

  // Resolve app: prefer (origin, app_key) if provided; otherwise pick the most-recent app for this origin.
  let app: AppRow | undefined;
  if (input.app_key && input.app_key.trim().length > 0) {
    app = db
      .prepare('SELECT * FROM apps WHERE origin = ? AND app_key = ?')
      .get(origin, slugify(input.app_key)) as AppRow | undefined;
  } else {
    app = db
      .prepare('SELECT * FROM apps WHERE origin = ? ORDER BY last_seen_at DESC LIMIT 1')
      .get(origin) as AppRow | undefined;
  }

  if (!app) {
    if (input.scope === 'app') {
      return {
        scope: 'app',
        app: null,
        current_build: null,
        pitfalls: [],
        mechanisms: [],
        entries: [],
        flows: [],
        readers: [],
        outcomes: [],
        builds: [],
        learned_failures: 0,
      };
    }
    return { app: null, pitfalls: [], mechanisms: [], entries: [], flows: [] };
  }

  // Touch last_seen_at so apps that are actively used bubble up.
  db.prepare('UPDATE apps SET last_seen_at = ? WHERE id = ?').run(now(), app.id);
  if (input.scope === 'app') return recallWholeApp(db, app);

  const pathname = input.url ? extractPathname(input.url) : null;
  const rows = (
    pathname
      ? db
          .prepare(
            `SELECT * FROM entries WHERE app_id = ? AND url_pattern = ? ORDER BY updated_at DESC`,
          )
          .all(app.id, pathname)
      : db
          .prepare(`SELECT * FROM entries WHERE app_id = ? ORDER BY url_pattern, updated_at DESC`)
          .all(app.id)
  ) as RawEntryRow[];

  // Flow recipes are not url_pattern-scoped (see the schema comment in
  // db.ts) — recall always returns every flow saved for the app, regardless
  // of the optional `url` filter. Learned rows are app-wide too: each one
  // carries its own `url_pattern`.
  const learned = listLearned(db, app.id, RECALL_MAX_LEARNED);
  return {
    app,
    pitfalls: listInsights(app.id, 'pitfall'),
    mechanisms: listInsights(app.id, 'mechanism'),
    entries: rows.map((row) => withPreference(hydrate(row))),
    ...(learned.length > 0 ? { learned } : {}),
    flows: listFlows(app.id),
  };
}

/** A generated selector is a structural fallback when it had to address the
 * element by position (see `buildStructuralSelector` in the extension's
 * dom-helpers): such a selector breaks on the first list re-render. */
const STRUCTURAL_SELECTOR_MARK = ':nth-of-type(';

/**
 * "Prefers it when the selector is a structural fallback" (spec v4 §6.3): a
 * selector entry whose payload carries a `semantic_key` and whose selector
 * is structural is recalled with `prefer: 'semantic_key'`. Computed here,
 * never stored, so old rows and rows without a key read exactly as before.
 */
function withPreference(entry: EntryRow): EntryRow {
  if (entry.kind !== 'selector') return entry;
  const payload = entry.payload as { selector?: unknown; semantic_key?: unknown } | null;
  if (typeof payload !== 'object' || payload === null) return entry;
  if (typeof payload.selector !== 'string' || payload.semantic_key === undefined) return entry;
  if (!payload.selector.includes(STRUCTURAL_SELECTOR_MARK)) return entry;
  return { ...entry, prefer: 'semantic_key' };
}

function extractPathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

export interface RecordUseInput {
  entry_id: number;
  ok: boolean;
  notes?: string | null;
}

// Two prepared statements with no string interpolation. ok=true clears
// failed_at so a freshly verified entry is unambiguously healthy; ok=false
// only stamps failed_at and leaves verified_at as a historical fact so we
// can still tell whether the entry ever worked.
const RECORD_USE_OK_SQL =
  'UPDATE entries SET verified_at = ?, failed_at = NULL, notes = COALESCE(?, notes), updated_at = ? WHERE id = ?';
const RECORD_USE_FAIL_SQL =
  'UPDATE entries SET failed_at = ?, notes = COALESCE(?, notes), updated_at = ? WHERE id = ?';

export function recordUse(input: RecordUseInput): EntryRow | null {
  const db = getDb();
  const ts = now();
  const sql = input.ok ? RECORD_USE_OK_SQL : RECORD_USE_FAIL_SQL;
  db.prepare(sql).run(ts, input.notes ?? null, ts, input.entry_id);

  const row = db.prepare('SELECT * FROM entries WHERE id = ?').get(input.entry_id) as
    RawEntryRow | undefined;
  return row ? hydrate(row) : null;
}

export interface ForgetInput {
  entry_id?: number;
  app_id?: number;
  /** Delete one mechanism/pitfall, identified the way `recall` returns it. */
  insight?: { app_id: number; kind: InsightKind; key: string };
  reason?: string;
}

export interface ForgetResult {
  deleted_entries: number;
  deleted_apps: number;
  deleted_insights: number;
}

export function forget(input: ForgetInput): ForgetResult {
  const db = getDb();
  if (input.entry_id) {
    const info = db.prepare('DELETE FROM entries WHERE id = ?').run(input.entry_id);
    return { deleted_entries: info.changes, deleted_apps: 0, deleted_insights: 0 };
  }
  if (input.app_id) {
    // ON DELETE CASCADE wipes entries, flows and insights.
    const before = db
      .prepare('SELECT COUNT(*) AS n FROM entries WHERE app_id = ?')
      .get(input.app_id) as { n: number };
    const insights = db
      .prepare('SELECT COUNT(*) AS n FROM insights WHERE app_id = ?')
      .get(input.app_id) as { n: number };
    const info = db.prepare('DELETE FROM apps WHERE id = ?').run(input.app_id);
    return {
      deleted_entries: before.n,
      deleted_apps: info.changes,
      deleted_insights: info.changes > 0 ? insights.n : 0,
    };
  }
  if (input.insight) {
    const { app_id, kind, key } = input.insight;
    const info = db
      .prepare('DELETE FROM insights WHERE app_id = ? AND kind = ? AND key = ?')
      .run(app_id, kind, key);
    return { deleted_entries: 0, deleted_apps: 0, deleted_insights: info.changes };
  }
  return { deleted_entries: 0, deleted_apps: 0, deleted_insights: 0 };
}

/** Run `fn` in one SQLite transaction: either every write inside lands or
 * none does. Nests safely (better-sqlite3 uses savepoints). */
export function inTransaction<T>(fn: () => T): T {
  return getDb().transaction(fn)();
}

export function renameApp(app_id: number, new_app_key: string): AppRow | null {
  const db = getDb();
  db.prepare('UPDATE apps SET app_key = ?, last_seen_at = ? WHERE id = ?').run(
    slugify(new_app_key),
    now(),
    app_id,
  );
  const row = db.prepare('SELECT * FROM apps WHERE id = ?').get(app_id) as AppRow | undefined;
  return row ?? null;
}

export function listApps(): AppRow[] {
  return getDb().prepare('SELECT * FROM apps ORDER BY last_seen_at DESC').all() as AppRow[];
}

export interface AppSummary extends AppRow {
  /** Pitfalls + mechanisms. */
  insights: number;
  entries: number;
  flows: number;
}

/**
 * Every app with its entry and flow counts, most-recently-seen first.
 * Powers `browser-link map ls` — `listApps()` alone does not carry counts,
 * and the CLI is the only caller that needs them (the MCP-facing
 * `browser.map.apps` tool intentionally stays lean). Counts are computed
 * with correlated subqueries rather than a JOIN + GROUP BY so an app with
 * zero entries or zero flows still gets a row (a JOIN would need two LEFT
 * JOINs to avoid multiplying rows across both tables).
 */
export function listAppsWithCounts(): AppSummary[] {
  return getDb()
    .prepare(
      `SELECT a.*,
         (SELECT COUNT(*) FROM entries e WHERE e.app_id = a.id) AS entries,
         (SELECT COUNT(*) FROM flows f WHERE f.app_id = a.id) AS flows,
         (SELECT COUNT(*) FROM insights i WHERE i.app_id = a.id) AS insights
       FROM apps a
       ORDER BY a.last_seen_at DESC`,
    )
    .all() as AppSummary[];
}

/**
 * Every app matching an identifier, most-recently-seen first — by app_key
 * (exact match) first, falling back to origin (canonicalized, same rule
 * every other write/lookup path uses) when no app_key matches. app_key
 * uniqueness is per-origin, so the same key CAN match apps on several
 * origins; a caller about to DELETE something must check `length > 1`
 * and confirm with the user rather than silently trusting position 0
 * (see `browser-link map forget --flow`). Read-only callers can take
 * position 0 directly — that is exactly what `findApp` does.
 */
export function findAppCandidates(identifier: string): AppRow[] {
  // `id DESC` tiebreak: two apps touched within the same millisecond have
  // an identical ISO last_seen_at, and "most recently seen" must still be
  // deterministic — the later-created row wins the tie.
  const db = getDb();
  const byKey = db
    .prepare('SELECT * FROM apps WHERE app_key = ? ORDER BY last_seen_at DESC, id DESC')
    .all(identifier) as AppRow[];
  if (byKey.length > 0) return byKey;
  return db
    .prepare('SELECT * FROM apps WHERE origin = ? ORDER BY last_seen_at DESC, id DESC')
    .all(canonicalOrigin(identifier)) as AppRow[];
}

/**
 * Resolve one app by app_key (exact match; most-recently-seen wins if the
 * same key was used across more than one origin) OR by origin
 * (canonicalized, same rule every other write/lookup path uses). Backs
 * `browser-link map show`/`export <app>`, where a human names one app with
 * whichever identifier they remember. Returns `null` — never throws — so
 * callers can produce their own "not found, did you mean…" message with
 * the full app_key list from `listApps()`. Destructive callers must use
 * `findAppCandidates` instead, so an ambiguous identifier is detected
 * BEFORE anything is deleted.
 */
export function findApp(identifier: string): AppRow | null {
  const candidates = findAppCandidates(identifier);
  return candidates.length > 0 ? candidates[0] : null;
}

/**
 * Exact (origin, app_key) lookup — the same identity `apps`' UNIQUE
 * constraint (and `upsertApp`) matches on. Used by `browser-link map
 * import --replace` to find the existing app to wipe before writing the
 * imported data fresh; unlike `findApp`, this never falls back to a
 * fuzzier match — replace must target the exact app the export file
 * describes, not a same-named app_key on a different origin.
 */
export function findAppByOriginAndKey(origin: string, app_key: string): AppRow | null {
  const row = getDb()
    .prepare('SELECT * FROM apps WHERE origin = ? AND app_key = ?')
    .get(canonicalOrigin(origin), slugify(app_key)) as AppRow | undefined;
  return row ?? null;
}

/**
 * Every entry saved for an app, regardless of url_pattern. Unlike
 * `recall()`, this is not origin/url-scoped and — like `getMapHint` —
 * deliberately does NOT touch `last_seen_at`: a CLI read (`map show`,
 * `map export`) is passive and must not affect map freshness.
 */
export function listEntries(app_id: number): EntryRow[] {
  const rows = getDb()
    .prepare('SELECT * FROM entries WHERE app_id = ? ORDER BY url_pattern, updated_at DESC')
    .all(app_id) as RawEntryRow[];
  return rows.map(hydrate);
}

/** Compact form of an insight for the inline hint (no ids or timestamps). */
export interface InsightSummary {
  key: string;
  description: string;
  symptom?: string;
}

/** The recalled content of a SMALL map, carried inside the list_tabs hint
 * so the agent skips the `browser.map.recall` round trip. Same section
 * order as `RecallResult`: pitfalls first. */
export interface MapHintInline {
  pitfalls: InsightSummary[];
  mechanisms: InsightSummary[];
  entries: { url_pattern: string; kind: EntryKind; purpose: string; payload: unknown }[];
  flows: { name: string; description: string | null; steps: unknown }[];
  /** Up to 3 learned targets, failures first. Present only when the app has
   * learned rows and at least one fits the byte cap; never counted toward
   * `INLINE_MAX_ITEMS`. */
  learned?: LearnedSummary[];
}

export interface MapHint {
  app_key: string;
  entries: number;
  flows: number;
  mechanisms: number;
  pitfalls: number;
  /** Present only when the map is small (see `INLINE_MAX_ITEMS` /
   * `INLINE_MAX_BYTES`); otherwise the counts above are all there is. */
  inline?: MapHintInline;
  /** Learned targets of this app that have failed at least once, present
   * only when there are some and no inline map carrying them fits. */
  learned_failures?: number;
}

/** A map is inlined into the hint only when it holds at most this many
 * items in total (entries + flows + mechanisms + pitfalls)... */
const INLINE_MAX_ITEMS = 5;
/** ...and its JSON serialization stays under this many UTF-8 bytes. */
const INLINE_MAX_BYTES = 2048;

function summarizeInsight(row: InsightRow): InsightSummary {
  return row.symptom === null
    ? { key: row.key, description: row.description }
    : { key: row.key, description: row.description, symptom: row.symptom };
}

function toLearnedSummary(row: LearnedRecallItem): LearnedSummary {
  return {
    target: row.target,
    target_kind: row.target_kind,
    action: row.action,
    ok_n: row.ok_n,
    fail_n: row.fail_n,
    last_reason: row.last_reason,
  };
}

function fitsInline(inline: MapHintInline): boolean {
  return Buffer.byteLength(JSON.stringify(inline), 'utf8') <= INLINE_MAX_BYTES;
}

/** The saved map inline (or null when it does not fit), then as many of the
 * top learned rows as still fit under the same byte cap. With nothing saved,
 * the inline exists only to carry learned rows: null when none fits. */
function buildInlineWithLearned(appId: number, savedTotal: number): MapHintInline | null {
  const base: MapHintInline | null =
    savedTotal === 0
      ? { pitfalls: [], mechanisms: [], entries: [], flows: [] }
      : savedTotal <= INLINE_MAX_ITEMS
        ? buildInline(appId)
        : null;
  if (!base) return null;
  const learned = listLearned(getDb(), appId, INLINE_MAX_LEARNED).map(toLearnedSummary);
  for (let n = learned.length; n > 0; n--) {
    const candidate = { ...base, learned: learned.slice(0, n) };
    if (fitsInline(candidate)) return candidate;
  }
  return savedTotal === 0 ? null : base;
}

function buildInline(appId: number): MapHintInline | null {
  const inline: MapHintInline = {
    pitfalls: listInsights(appId, 'pitfall').map(summarizeInsight),
    mechanisms: listInsights(appId, 'mechanism').map(summarizeInsight),
    entries: listEntries(appId).map((e) => ({
      url_pattern: e.url_pattern,
      kind: e.kind,
      purpose: e.purpose,
      payload: e.payload,
    })),
    flows: listFlows(appId).map((f) => ({
      name: f.name,
      description: f.description,
      steps: f.steps,
    })),
  };
  return fitsInline(inline) ? inline : null;
}

/**
 * Lean existence-and-count lookup for a tab's origin — powers the optional
 * `map` hint `browser.list_tabs` attaches to each tab (see
 * tools/browser-dispatch.ts's `handleListTabs`), so an agent can tell
 * whether the persistent map knows anything about a page WITHOUT first
 * calling `browser.map.recall` blind. Returns `null` when there is nothing
 * to report — no app for this origin yet, or an app with zero entries and
 * zero flows — so the caller can omit the field entirely rather than
 * shipping a `{ entries: 0, flows: 0 }` no-op over the wire.
 *
 * Resolves the app the same way `recall()` does when no `app_key` is
 * given: the most-recently-seen app for the origin. Deliberately does NOT
 * touch `last_seen_at` — unlike an explicit `recall`, listing tabs is a
 * passive read and must not have side effects on map freshness.
 */
export function getMapHint(origin: string): MapHint | null {
  if (!origin) return null;
  return getMapHints([origin]).get(canonicalOrigin(origin)) ?? null;
}

/**
 * Batched counterpart to `getMapHint`, for `browser.list_tabs`: resolving
 * one hint per tab used to run `getMapHint` (3 synchronous queries: an app
 * lookup + 2 COUNTs) once per tab, so a list of N tabs cost 3N queries on a
 * tool call that runs on nearly every agent turn. This resolves every
 * DISTINCT origin in exactly 3 queries total — one `WHERE origin IN (...)`
 * app lookup, then one `WHERE app_id IN (...)` COUNT per table — regardless
 * of how many tabs/origins are requested.
 *
 * Returns a `Map` keyed by the CANONICALIZED form of each input origin
 * (same `canonicalOrigin` rule every other lookup path uses), holding only
 * origins that actually have a hint — same "omit rather than ship a zero
 * hint" contract as `getMapHint`, just batched. `getMapHint` itself is a
 * thin single-origin wrapper around this, so both paths share one query
 * shape and can never drift apart.
 */
export function getMapHints(origins: string[]): Map<string, MapHint> {
  const result = new Map<string, MapHint>();
  const canonicalOrigins = [...new Set(origins.filter((o) => o.length > 0).map(canonicalOrigin))];
  if (canonicalOrigins.length === 0) return result;

  const db = getDb();
  const originPlaceholders = canonicalOrigins.map(() => '?').join(', ');
  // One row per (origin, app) pair, most-recently-seen first — the same
  // tie-break `findAppCandidates` uses (last_seen_at DESC, id DESC), so a
  // multi-app origin resolves the same "winner" getMapHint's single-origin
  // `ORDER BY ... LIMIT 1` would pick. Picking the per-origin winner in JS
  // (first row seen per origin, below) rather than in SQL avoids a
  // top-1-per-group query shape (correlated subquery or window function)
  // for a table with, at most, tens of rows.
  const apps = db
    .prepare(
      `SELECT * FROM apps WHERE origin IN (${originPlaceholders}) ORDER BY last_seen_at DESC, id DESC`,
    )
    .all(...canonicalOrigins) as AppRow[];

  const winnerByOrigin = new Map<string, AppRow>();
  for (const app of apps) {
    if (!winnerByOrigin.has(app.origin)) winnerByOrigin.set(app.origin, app);
  }
  if (winnerByOrigin.size === 0) return result;

  const appIds = [...winnerByOrigin.values()].map((app) => app.id);
  const idPlaceholders = appIds.map(() => '?').join(', ');
  const entryCounts = db
    .prepare(
      `SELECT app_id, COUNT(*) AS n FROM entries WHERE app_id IN (${idPlaceholders}) GROUP BY app_id`,
    )
    .all(...appIds) as { app_id: number; n: number }[];
  const flowCounts = db
    .prepare(
      `SELECT app_id, COUNT(*) AS n FROM flows WHERE app_id IN (${idPlaceholders}) GROUP BY app_id`,
    )
    .all(...appIds) as { app_id: number; n: number }[];

  const insightCounts = db
    .prepare(
      `SELECT app_id, kind, COUNT(*) AS n FROM insights WHERE app_id IN (${idPlaceholders}) GROUP BY app_id, kind`,
    )
    .all(...appIds) as { app_id: number; kind: InsightKind; n: number }[];

  // What the learner recorded (see learning.ts): total rows and rows that
  // ever failed, per app, in one more grouped query.
  const learnedCounts = db
    .prepare(
      `SELECT app_id, COUNT(*) AS n, SUM(CASE WHEN fail_n > 0 THEN 1 ELSE 0 END) AS failing
       FROM selector_outcomes WHERE app_id IN (${idPlaceholders}) GROUP BY app_id`,
    )
    .all(...appIds) as { app_id: number; n: number; failing: number }[];

  const entriesByAppId = new Map(entryCounts.map((row) => [row.app_id, row.n]));
  const learnedByAppId = new Map(learnedCounts.map((row) => [row.app_id, row]));
  const flowsByAppId = new Map(flowCounts.map((row) => [row.app_id, row.n]));
  const insightCount = (appId: number, kind: InsightKind): number =>
    insightCounts.find((row) => row.app_id === appId && row.kind === kind)?.n ?? 0;

  for (const [origin, app] of winnerByOrigin) {
    const entries = entriesByAppId.get(app.id) ?? 0;
    const flows = flowsByAppId.get(app.id) ?? 0;
    const mechanisms = insightCount(app.id, 'mechanism');
    const pitfalls = insightCount(app.id, 'pitfall');
    const total = entries + flows + mechanisms + pitfalls;
    const learned = learnedByAppId.get(app.id);
    if (total === 0 && learned === undefined) continue;
    const hint: MapHint = { app_key: app.app_key, entries, flows, mechanisms, pitfalls };
    // Only small maps are expanded (extra queries run just for them), so a
    // big map costs nothing beyond the count queries above. Learned rows
    // never count toward INLINE_MAX_ITEMS; they only share the byte cap.
    const inline =
      learned === undefined
        ? total <= INLINE_MAX_ITEMS
          ? buildInline(app.id)
          : null
        : buildInlineWithLearned(app.id, total);
    if (inline) hint.inline = inline;
    const failing = learned?.failing ?? 0;
    if (failing > 0 && !inline?.learned) hint.learned_failures = failing;
    // Learned rows alone that neither fit inline nor ever failed say nothing.
    if (total === 0 && !hint.inline && hint.learned_failures === undefined) continue;
    result.set(origin, hint);
  }
  return result;
}

// === Flow recipes ==========================================================
//
// Named, replayable browser.flow step sequences per app. See the schema
// comment in db.ts for why this is a separate table from `entries` rather
// than reusing entries.kind='flow'. `steps` is validated by the CALLER
// (map/tools.ts, reusing browser-dispatch.ts's `validateFlowSteps` — the
// exact rules browser.flow itself enforces) before it ever reaches here;
// queries.ts stays a thin persistence layer, same as saveEntry/recall above.

export interface FlowRow {
  id: number;
  app_id: number;
  name: string;
  description: string | null;
  steps: unknown;
  created_at: string;
  updated_at: string;
  use_count: number;
}

interface RawFlowRow extends Omit<FlowRow, 'steps'> {
  steps_json: string;
}

function hydrateFlow(row: RawFlowRow): FlowRow {
  const { steps_json, ...rest } = row;
  return { ...rest, steps: parsePayload(steps_json) };
}

export interface SaveFlowInput {
  origin: string;
  app_key?: string | null;
  title?: string | null;
  name: string;
  description?: string | null;
  steps: unknown;
}

/** Upsert on (app, name) — saving an existing name replaces its
 * description/steps and bumps updated_at, mirroring saveEntry's upsert
 * semantics. `use_count` is left untouched on update (re-saving is not a
 * "use"). */
export function saveFlow(input: SaveFlowInput): { app: AppRow; flow: FlowRow } {
  const app = upsertApp({
    origin: input.origin,
    app_key: input.app_key ?? null,
    title: input.title ?? null,
  });
  const ts = now();
  const stepsJson = JSON.stringify(input.steps);
  const db = getDb();

  const existing = db
    .prepare('SELECT * FROM flows WHERE app_id = ? AND name = ?')
    .get(app.id, input.name) as RawFlowRow | undefined;

  if (existing) {
    db.prepare('UPDATE flows SET description = ?, steps_json = ?, updated_at = ? WHERE id = ?').run(
      input.description ?? null,
      stepsJson,
      ts,
      existing.id,
    );
    const updated = db.prepare('SELECT * FROM flows WHERE id = ?').get(existing.id) as RawFlowRow;
    return { app, flow: hydrateFlow(updated) };
  }

  const info = db
    .prepare(
      `INSERT INTO flows (app_id, name, description, steps_json, created_at, updated_at, use_count)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
    )
    .run(app.id, input.name, input.description ?? null, stepsJson, ts, ts);
  const inserted = db.prepare('SELECT * FROM flows WHERE id = ?').get(info.lastInsertRowid) as
    RawFlowRow | undefined;
  return { app, flow: hydrateFlow(inserted as RawFlowRow) };
}

export interface RestoreFlowInput extends SaveFlowInput {
  use_count?: number;
}

/**
 * Restore-only counterpart to `saveFlow`, used by `browser-link map
 * import`. `saveFlow` always inserts with `use_count = 0` — right for a
 * brand-new recipe, wrong for a backup restore, where it would erase the
 * flow's track record. On insert, the imported `use_count` is written
 * as-is; on update (merge into an app that already has this flow name),
 * the LARGER of the existing and imported counts wins, so a merge can
 * never LOWER a locally-earned track record. Only a non-negative integer
 * is accepted — anything else falls back to 0 rather than poisoning the
 * column. The agent-facing `browser.map.save` never calls this.
 */
export function restoreFlow(input: RestoreFlowInput): { app: AppRow; flow: FlowRow } {
  const app = upsertApp({
    origin: input.origin,
    app_key: input.app_key ?? null,
    title: input.title ?? null,
  });
  const ts = now();
  const stepsJson = JSON.stringify(input.steps);
  const useCount =
    typeof input.use_count === 'number' && Number.isInteger(input.use_count) && input.use_count >= 0
      ? input.use_count
      : 0;
  const db = getDb();

  const existing = db
    .prepare('SELECT * FROM flows WHERE app_id = ? AND name = ?')
    .get(app.id, input.name) as RawFlowRow | undefined;

  if (existing) {
    db.prepare(
      'UPDATE flows SET description = ?, steps_json = ?, updated_at = ?, use_count = MAX(use_count, ?) WHERE id = ?',
    ).run(input.description ?? null, stepsJson, ts, useCount, existing.id);
    const updated = db.prepare('SELECT * FROM flows WHERE id = ?').get(existing.id) as RawFlowRow;
    return { app, flow: hydrateFlow(updated) };
  }

  const info = db
    .prepare(
      `INSERT INTO flows (app_id, name, description, steps_json, created_at, updated_at, use_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(app.id, input.name, input.description ?? null, stepsJson, ts, ts, useCount);
  const inserted = db.prepare('SELECT * FROM flows WHERE id = ?').get(info.lastInsertRowid) as
    RawFlowRow | undefined;
  return { app, flow: hydrateFlow(inserted as RawFlowRow) };
}

// === Mechanisms and pitfalls ===============================================
//
// What an app does underneath (mechanism) and what does NOT work (pitfall).
// See the schema comment in db.ts for why this is its own table. Shape
// validation lives in map/tools.ts; this stays a thin persistence layer.

export type InsightKind = 'mechanism' | 'pitfall';

export interface InsightRow {
  id: number;
  app_id: number;
  kind: InsightKind;
  key: string;
  description: string;
  symptom: string | null;
  created_at: string;
  updated_at: string;
}

export interface SaveInsightInput {
  origin: string;
  app_key?: string | null;
  title?: string | null;
  kind: InsightKind;
  key: string;
  description: string;
  symptom?: string | null;
}

/** Upsert on (app, kind, key): re-saving a key replaces its description and
 * symptom and bumps updated_at. */
export function saveInsight(input: SaveInsightInput): { app: AppRow; insight: InsightRow } {
  const app = upsertApp({
    origin: input.origin,
    app_key: input.app_key ?? null,
    title: input.title ?? null,
  });
  const ts = now();
  const db = getDb();
  db.prepare(
    `INSERT INTO insights (app_id, kind, key, description, symptom, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(app_id, kind, key)
     DO UPDATE SET description = excluded.description, symptom = excluded.symptom, updated_at = excluded.updated_at`,
  ).run(app.id, input.kind, input.key, input.description, input.symptom ?? null, ts, ts);
  const insight = db
    .prepare('SELECT * FROM insights WHERE app_id = ? AND kind = ? AND key = ?')
    .get(app.id, input.kind, input.key) as InsightRow;
  return { app, insight };
}

/** Every insight of one kind saved for an app, alphabetical by key. */
export function listInsights(app_id: number, kind: InsightKind): InsightRow[] {
  return getDb()
    .prepare('SELECT * FROM insights WHERE app_id = ? AND kind = ? ORDER BY key')
    .all(app_id, kind) as InsightRow[];
}

/** Every flow recipe saved for an app, alphabetical by name. */
export function listFlows(app_id: number): FlowRow[] {
  const rows = getDb()
    .prepare('SELECT * FROM flows WHERE app_id = ? ORDER BY name')
    .all(app_id) as RawFlowRow[];
  return rows.map(hydrateFlow);
}

/**
 * Delete a single named flow recipe, leaving the app and its entries
 * untouched. Backs `browser-link map forget <app> --flow <name>` — the
 * single-flow counterpart to `forget()`'s app_id/entry_id deletion, which
 * has no notion of a flow name. Returns whether a row was actually
 * deleted, so the caller can tell "deleted" from "no such flow".
 */
export function deleteFlow(app_id: number, name: string): boolean {
  const info = getDb().prepare('DELETE FROM flows WHERE app_id = ? AND name = ?').run(app_id, name);
  return info.changes > 0;
}

// === Knowledge loop: builds, start pack, action hints, the whole map =========
//
// What the map knows comes back to the agent at the moment it acts: the
// start pack on `list_tabs`/`navigate` (`getKnowledge`), the `known` hint on
// an action (`getActionHint`) and the whole map on demand (`recall` with
// `scope`). Every item carries `confidence` and its raw evidence (see
// confidence.ts); nothing here writes except `recordAppBuild`.

/** The most recently seen app of an origin, read-only (no creation, no
 * `last_seen_at` bump): passive reads never reorder which app wins. */
function winnerApp(db: Database.Database, origin: string): AppRow | null {
  return (
    (db
      .prepare('SELECT * FROM apps WHERE origin = ? ORDER BY last_seen_at DESC, id DESC LIMIT 1')
      .get(canonicalOrigin(origin)) as AppRow | undefined) ?? null
  );
}

/**
 * Remember that an origin's app was seen running build `fingerprint`: one
 * row per (app, fingerprint), `last_seen_at` moved on every report. The app
 * is resolved by `resolveLearnerApp` (never from a tab title). An empty
 * fingerprint is ignored. One statement, so it is atomic on its own.
 */
export function recordAppBuild(origin: string, fingerprint: string): void {
  if (typeof fingerprint !== 'string' || fingerprint.length === 0) return;
  const db = getDb();
  const app = resolveLearnerApp(db, origin);
  const ts = now();
  db.prepare(
    `INSERT INTO app_builds (app_id, fingerprint, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(app_id, fingerprint) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
  ).run(app.id, fingerprint, ts, ts);
}

/** A saved pitfall or mechanism in the start pack. Saved by hand, never
 * observed, so it is `unverified` with when it was saved as evidence. */
export interface KnowledgeInsight {
  key: string;
  description: string;
  symptom?: string;
  confidence: Confidence;
  evidence: { saved_at: string };
}

/** A kept, named JS reader in the start pack. */
export interface KnowledgeReader {
  name: string;
  kind: string;
  confidence: Confidence;
  evidence: Evidence;
}

/** A saved flow recipe in the start pack (`browser.map.recall` has its steps). */
export interface KnowledgeFlow {
  name: string;
  description: string | null;
  confidence: Confidence;
  evidence: { use_count: number; saved_at: string };
}

/** A learned target in the start pack. `url_pattern` is present only when
 * the target was learned on another route (app-wide fallback). */
export interface KnowledgeSelector {
  target: string;
  target_kind: 'selector' | 'key';
  action: string;
  url_pattern?: string;
  confidence: Confidence;
  evidence: Evidence;
}

/** The start pack: what the map knows for this tab, ranked and ≤ 2 KB. */
export interface Knowledge {
  app_key: string;
  /** The path pattern the pack is scoped to. */
  path: string;
  pitfalls?: KnowledgeInsight[];
  mechanisms?: KnowledgeInsight[];
  readers?: KnowledgeReader[];
  flows?: KnowledgeFlow[];
  selectors?: KnowledgeSelector[];
  /** Present (`'app'`) only when the path had no selector and the app's
   * best ones are offered instead. */
  selectors_from?: 'app';
  /** Targets that are `failing` on the current build: offered only here. */
  warnings?: KnowledgeSelector[];
  /** Items left out to stay under the byte cap, counted from the tail. */
  dropped?: number;
}

export interface KnowledgeInput {
  origin: string;
  pathname: string;
  /** The tab's build fingerprint, when known. */
  build: string | null;
}

/** Serialized cap of the start pack, in UTF-8 bytes. */
export const KNOWLEDGE_MAX_BYTES = 2048;
/** Learned targets considered for the start pack (after ranking). */
const KNOWLEDGE_MAX_SELECTORS = 5;
const KNOWLEDGE_MAX_WARNINGS = 3;

/** An outcome row as the knowledge readers select it. */
interface OutcomeRow {
  id: number;
  url_pattern: string;
  target: string;
  target_kind: 'selector' | 'key';
  action: string;
  ok_n: number;
  fail_n: number;
  last_reason: string | null;
  last_ok_at: string | null;
  last_fail_at: string | null;
  view_sig: string | null;
  last_ok_build: string | null;
  last_fail_build: string | null;
  struct_fail_n: number;
  struct_fail_build: string | null;
}

function outcomeRows(db: Database.Database, appId: number): OutcomeRow[] {
  return db
    .prepare('SELECT * FROM selector_outcomes WHERE app_id = ? ORDER BY ok_n DESC, id ASC')
    .all(appId) as OutcomeRow[];
}

function insightItem(row: InsightRow): KnowledgeInsight {
  return {
    key: row.key,
    description: row.description,
    ...(row.symptom === null ? {} : { symptom: row.symptom }),
    confidence: 'unverified',
    evidence: { saved_at: row.updated_at },
  };
}

/** Fresh first, then unverified; most successes first within each. */
function byConfidence<T extends { confidence: Confidence; evidence: Evidence }>(
  a: T,
  b: T,
): number {
  const rank = (c: Confidence): number => (c === 'fresh' ? 0 : 1);
  return rank(a.confidence) - rank(b.confidence) || b.evidence.ok_n - a.evidence.ok_n;
}

/**
 * The start pack for a tab (knowledge-loop S5), or null when the map has
 * nothing with evidence for it.
 *
 * Scoped to the path pattern of `pathname` for learned targets, falling
 * back to the app's best targets when that path has none; pitfalls,
 * mechanisms, kept named readers and saved flows are app-wide. Ranked
 * pitfalls → `failing` warnings → `fresh` → `unverified`, and cut from the
 * tail until the JSON fits `KNOWLEDGE_MAX_BYTES`. Read-only: never creates
 * an app or touches `last_seen_at`.
 */
export function getKnowledge(input: KnowledgeInput): Knowledge | null {
  const db = getDb();
  const app = winnerApp(db, input.origin);
  if (!app) return null;
  const build = input.build ?? null;
  const path = pathPattern(input.pathname);

  const pitfalls = listInsights(app.id, 'pitfall').map(insightItem);
  const mechanisms = listInsights(app.id, 'mechanism').map(insightItem);
  const readers = (
    db
      .prepare(
        `SELECT name, kind, ok_n, fail_n, last_ok_at, last_ok_build FROM js_readers
         WHERE app_id = ? AND status = 'kept' AND name IS NOT NULL ORDER BY ok_n DESC, id ASC`,
      )
      .all(app.id) as {
      name: string;
      kind: string;
      ok_n: number;
      fail_n: number;
      last_ok_at: string | null;
      last_ok_build: string | null;
    }[]
  ).map((r): KnowledgeReader => {
    const { confidence, evidence } = confidenceOf(
      { ...r, last_reason: null, last_fail_build: null },
      build,
    );
    return { name: r.name, kind: r.kind, confidence, evidence };
  });
  const flows = listFlows(app.id).map((f): KnowledgeFlow => ({
    name: f.name,
    description: f.description,
    confidence: 'unverified',
    evidence: { use_count: f.use_count, saved_at: f.updated_at },
  }));

  const all = outcomeRows(db, app.id);
  const onPath = all.filter((r) => pathPattern(r.url_pattern) === path);
  const toSelector = (r: OutcomeRow, withPath: boolean): KnowledgeSelector => {
    const { confidence, evidence } = confidenceOf(r, build);
    return {
      target: r.target,
      target_kind: r.target_kind,
      action: r.action,
      ...(withPath ? { url_pattern: r.url_pattern } : {}),
      confidence,
      evidence,
    };
  };
  const usable = (rows: OutcomeRow[], withPath: boolean): KnowledgeSelector[] =>
    rows
      .map((r) => toSelector(r, withPath))
      .filter((s) => s.confidence !== 'failing' && s.evidence.ok_n > 0)
      .sort(byConfidence)
      .slice(0, KNOWLEDGE_MAX_SELECTORS);
  let selectors = usable(onPath, false);
  const fromApp = selectors.length === 0;
  if (fromApp) selectors = usable(all, true);
  const warnings = (fromApp ? all : onPath)
    .map((r) => toSelector(r, fromApp))
    .filter((s) => s.confidence === 'failing')
    .slice(0, KNOWLEDGE_MAX_WARNINGS);

  // One ranked list of every candidate, so the byte cap cuts the least
  // valuable items first.
  type Section = 'pitfalls' | 'mechanisms' | 'readers' | 'flows' | 'selectors' | 'warnings';
  const ranked: { section: Section; item: unknown }[] = [
    ...pitfalls.map((item) => ({ section: 'pitfalls' as const, item })),
    ...warnings.map((item) => ({ section: 'warnings' as const, item })),
    ...readers
      .filter((r) => r.confidence === 'fresh')
      .map((item) => ({ section: 'readers' as const, item })),
    ...selectors
      .filter((s) => s.confidence === 'fresh')
      .map((item) => ({ section: 'selectors' as const, item })),
    ...mechanisms.map((item) => ({ section: 'mechanisms' as const, item })),
    ...readers
      .filter((r) => r.confidence !== 'fresh')
      .map((item) => ({ section: 'readers' as const, item })),
    ...flows.map((item) => ({ section: 'flows' as const, item })),
    ...selectors
      .filter((s) => s.confidence !== 'fresh')
      .map((item) => ({ section: 'selectors' as const, item })),
  ];
  if (ranked.length === 0) return null;

  const assemble = (kept: typeof ranked, dropped: number): Knowledge => {
    const pick = <T>(section: Section): T[] =>
      kept.filter((r) => r.section === section).map((r) => r.item as T);
    const k: Knowledge = { app_key: app.app_key, path };
    const sections: Section[] = [
      'pitfalls',
      'mechanisms',
      'readers',
      'flows',
      'selectors',
      'warnings',
    ];
    for (const section of sections) {
      const items = pick<never>(section);
      if (items.length === 0) continue;
      (k as unknown as Record<string, unknown>)[section] = items;
      if (section === 'selectors' && fromApp) k.selectors_from = 'app';
    }
    if (dropped > 0) k.dropped = dropped;
    return k;
  };

  for (let n = ranked.length; n > 0; n--) {
    const candidate = assemble(ranked.slice(0, n), ranked.length - n);
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') <= KNOWLEDGE_MAX_BYTES) {
      return candidate;
    }
  }
  return null;
}

export interface ActionHintInput {
  origin: string;
  pathname: string;
  build: string | null;
  target: string;
  target_kind: 'selector' | 'key';
  action: string;
}

/** The `known` field an action result carries (knowledge-loop S6). */
export interface ActionHint {
  confidence: Confidence;
  ok_n: number;
  fail_n: number;
  last_reason: string | null;
  /** The best `fresh` target for the same action on the same path pattern,
   * present only when it is a different target. */
  alternative?: { target: string; target_kind: 'selector' | 'key'; ok_n: number };
}

/**
 * What the map knows about the target an action is about to use, or null
 * when the app has no outcome row for it. The row of the current path
 * pattern wins; otherwise the target's most used row anywhere in the app.
 * Read-only.
 */
export function getActionHint(input: ActionHintInput): ActionHint | null {
  const db = getDb();
  const app = winnerApp(db, input.origin);
  if (!app) return null;
  const build = input.build ?? null;
  const path = pathPattern(input.pathname);
  const rows = outcomeRows(db, app.id).filter((r) => r.action === input.action);
  const mine = rows.filter((r) => r.target === input.target && r.target_kind === input.target_kind);
  const row: OutcomeRow | undefined =
    mine.find((r) => pathPattern(r.url_pattern) === path) ?? mine.at(0);
  if (!row) return null;
  const { confidence } = confidenceOf(row, build);
  const hint: ActionHint = {
    confidence,
    ok_n: row.ok_n,
    fail_n: row.fail_n,
    last_reason: row.last_reason,
  };
  const best: OutcomeRow | undefined = rows
    .filter((r) => pathPattern(r.url_pattern) === path && r.ok_n > 0)
    .filter((r) => confidenceOf(r, build).confidence === 'fresh')
    .sort((a, b) => b.ok_n - a.ok_n)
    .at(0);
  if (best && !(best.target === row.target && best.target_kind === row.target_kind)) {
    hint.alternative = { target: best.target, target_kind: best.target_kind, ok_n: best.ok_n };
  }
  return hint;
}

/** A learned target in the whole-map recall: every column, plus confidence
 * against the app's most recently seen build. */
export interface OutcomeRecallItem extends Omit<OutcomeRow, 'id'> {
  confidence: Confidence;
}

/** A JS registry row in the whole-map recall (every status). */
export interface ReaderRecallItem {
  id: number;
  name: string | null;
  kind: string;
  status: string;
  flags: string;
  expression: string;
  ok_n: number;
  fail_n: number;
  last_ok_at: string | null;
  last_fail_at: string | null;
  last_ok_build: string | null;
  result_bytes_avg: number | null;
  created_at: string;
  confidence: Confidence;
}

export interface BuildRecallItem {
  fingerprint: string;
  first_seen_at: string;
  last_seen_at: string;
}

/** `recall({ scope: 'app' })`: everything the map holds for one app. */
export interface AppRecallResult {
  scope: 'app';
  app: AppRow | null;
  /** The app's most recently seen build; confidence is computed against it. */
  current_build: string | null;
  pitfalls: InsightRow[];
  mechanisms: InsightRow[];
  entries: EntryRow[];
  flows: FlowRow[];
  readers: ReaderRecallItem[];
  outcomes: OutcomeRecallItem[];
  builds: BuildRecallItem[];
  /** Learned targets that have failed at least once. */
  learned_failures: number;
}

/** `recall({ scope: 'all' })`: the whole map of every app of the origin. */
export interface AllRecallResult {
  scope: 'all';
  apps: AppRecallResult[];
}

/** The whole map of one app, for `browser-link map show`: what
 * `recall({ scope: 'app' })` returns, without touching `last_seen_at`. */
export function wholeAppMap(app: AppRow): AppRecallResult {
  return recallWholeApp(getDb(), app);
}

/** The whole map of one app. Read-only. */
function recallWholeApp(db: Database.Database, app: AppRow): AppRecallResult {
  const builds = db
    .prepare(
      `SELECT fingerprint, first_seen_at, last_seen_at FROM app_builds
       WHERE app_id = ? ORDER BY first_seen_at ASC, id ASC`,
    )
    .all(app.id) as BuildRecallItem[];
  const latest = db
    .prepare(
      'SELECT fingerprint FROM app_builds WHERE app_id = ? ORDER BY last_seen_at DESC, id DESC LIMIT 1',
    )
    .get(app.id) as { fingerprint: string } | undefined;
  const build = latest?.fingerprint ?? null;
  const outcomes = (
    db
      .prepare(`SELECT * FROM selector_outcomes WHERE app_id = ? ${LEARNED_ORDER}`)
      .all(app.id) as OutcomeRow[]
  ).map(({ id: _id, ...row }) => ({ ...row, confidence: confidenceOf(row, build).confidence }));
  const readers = (
    db
      .prepare(
        `SELECT id, name, kind, status, flags, expression, ok_n, fail_n, last_ok_at, last_fail_at,
                last_ok_build, result_bytes_avg, created_at
         FROM js_readers WHERE app_id = ? ORDER BY id ASC`,
      )
      .all(app.id) as Omit<ReaderRecallItem, 'confidence'>[]
  ).map((r) => ({
    ...r,
    confidence: confidenceOf({ ...r, last_reason: null, last_fail_build: null }, build).confidence,
  }));
  const entries = (
    db
      .prepare('SELECT * FROM entries WHERE app_id = ? ORDER BY url_pattern, updated_at DESC')
      .all(app.id) as RawEntryRow[]
  ).map((row) => withPreference(hydrate(row)));
  return {
    scope: 'app',
    app,
    current_build: build,
    pitfalls: listInsights(app.id, 'pitfall'),
    mechanisms: listInsights(app.id, 'mechanism'),
    entries,
    flows: listFlows(app.id),
    readers,
    outcomes,
    builds,
    learned_failures: outcomes.filter((o) => o.fail_n > 0).length,
  };
}
