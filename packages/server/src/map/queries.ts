import { getDb } from './db.js';
import { canonicalOrigin } from './origin.js';

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
}

export interface RecallResult {
  app: AppRow | null;
  entries: EntryRow[];
  flows: FlowRow[];
}

export function recall(input: RecallInput): RecallResult {
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

  if (!app) return { app: null, entries: [], flows: [] };

  // Touch last_seen_at so apps that are actively used bubble up.
  db.prepare('UPDATE apps SET last_seen_at = ? WHERE id = ?').run(now(), app.id);

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
  // of the optional `url` filter.
  return { app, entries: rows.map(hydrate), flows: listFlows(app.id) };
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
  reason?: string;
}

export interface ForgetResult {
  deleted_entries: number;
  deleted_apps: number;
}

export function forget(input: ForgetInput): ForgetResult {
  const db = getDb();
  if (input.entry_id) {
    const info = db.prepare('DELETE FROM entries WHERE id = ?').run(input.entry_id);
    return { deleted_entries: info.changes, deleted_apps: 0 };
  }
  if (input.app_id) {
    // ON DELETE CASCADE wipes entries.
    const before = db
      .prepare('SELECT COUNT(*) AS n FROM entries WHERE app_id = ?')
      .get(input.app_id) as { n: number };
    const info = db.prepare('DELETE FROM apps WHERE id = ?').run(input.app_id);
    return { deleted_entries: before.n, deleted_apps: info.changes };
  }
  return { deleted_entries: 0, deleted_apps: 0 };
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
         (SELECT COUNT(*) FROM flows f WHERE f.app_id = a.id) AS flows
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

export interface MapHint {
  app_key: string;
  entries: number;
  flows: number;
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

  const entriesByAppId = new Map(entryCounts.map((row) => [row.app_id, row.n]));
  const flowsByAppId = new Map(flowCounts.map((row) => [row.app_id, row.n]));

  for (const [origin, app] of winnerByOrigin) {
    const entries = entriesByAppId.get(app.id) ?? 0;
    const flows = flowsByAppId.get(app.id) ?? 0;
    if (entries === 0 && flows === 0) continue;
    result.set(origin, { app_key: app.app_key, entries, flows });
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
