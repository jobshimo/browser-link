/**
 * Canonicalize a free-text origin to `new URL(origin).origin` form.
 *
 * `browser.map.save`'s `origin` parameter is free text from the agent —
 * "https://myapp.example.com/" (trailing slash), "HTTPS://App.Example.com",
 * or a full URL with a path all denote the same origin, but the map's
 * lookups (`apps.origin = ?`) are exact string matches. Meanwhile
 * `browser.list_tabs`' map-hint join computes its key with
 * `new URL(tab.url).origin` (canonical: lowercased scheme/host, default
 * port dropped, no trailing slash, no path). Without one canonical form on
 * BOTH sides, a save with a trailing slash silently never matches the hint
 * lookup — a permanent no-op indistinguishable from an empty map.
 *
 * Rules:
 *  - Parseable URL with a real origin → `URL.origin` (the canonical form).
 *  - Parseable URL whose origin is opaque (`'null'` — file:, data:,
 *    about:blank, …) → the RAW input. Collapsing every opaque-origin
 *    value into the literal string "null" would merge unrelated apps.
 *  - Unparseable input → the RAW input, unchanged. The map has always
 *    accepted free-text origins; canonicalization must never reject or
 *    mangle what it cannot understand.
 *
 * Shared by `queries.ts` (every write and lookup path) and `db.ts` (the
 * one-time normalization of rows written before v0.20.0). Lives in its own
 * module because db.ts cannot import queries.ts (queries.ts imports getDb
 * from db.ts — a cycle).
 */
export function canonicalOrigin(origin: string): string {
  try {
    const canonical = new URL(origin).origin;
    return canonical === 'null' ? origin : canonical;
  } catch {
    return origin;
  }
}
