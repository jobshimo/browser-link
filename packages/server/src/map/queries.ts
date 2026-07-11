import { getDb } from './db.js';

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
  const app_key =
    input.app_key && input.app_key.trim().length > 0
      ? slugify(input.app_key)
      : deriveAppKey(input.origin, input.title);

  const existing = db
    .prepare('SELECT * FROM apps WHERE origin = ? AND app_key = ?')
    .get(input.origin, app_key) as AppRow | undefined;

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
    .run(input.origin, app_key, input.title ?? null, input.notes ?? null, ts, ts);

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

  // Resolve app: prefer (origin, app_key) if provided; otherwise pick the most-recent app for this origin.
  let app: AppRow | undefined;
  if (input.app_key && input.app_key.trim().length > 0) {
    app = db
      .prepare('SELECT * FROM apps WHERE origin = ? AND app_key = ?')
      .get(input.origin, slugify(input.app_key)) as AppRow | undefined;
  } else {
    app = db
      .prepare('SELECT * FROM apps WHERE origin = ? ORDER BY last_seen_at DESC LIMIT 1')
      .get(input.origin) as AppRow | undefined;
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

/** Every flow recipe saved for an app, alphabetical by name. */
export function listFlows(app_id: number): FlowRow[] {
  const rows = getDb()
    .prepare('SELECT * FROM flows WHERE app_id = ? ORDER BY name')
    .all(app_id) as RawFlowRow[];
  return rows.map(hydrateFlow);
}
