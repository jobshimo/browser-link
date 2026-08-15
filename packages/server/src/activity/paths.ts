import { join } from 'node:path';
// The data dir resolver is shared, not map-specific — it predates this module
// and simply happens to live under map/. Imported rather than duplicated so
// $BROWSER_LINK_DATA_DIR keeps meaning one thing for the whole process.
import { getDataDir } from '../map/paths.js';

/**
 * The activity trail gets its OWN SQLite file, next to `map.db` rather than
 * inside it.
 *
 * The two have opposite lifecycles. `map.db` is small, slow-growing and
 * precious — it holds what the agent learned about the user's apps, and losing
 * it means relearning every selector. The trail is append-only, high-churn and
 * disposable: thousands of rows a session, cleared whenever the user feels like
 * it.
 *
 * Putting them in one file would mean the trail's WAL growth and its
 * `activity clear` VACUUM both operate on the file holding the map, and it
 * would make "back up my map" ambiguous. Two files, two retention policies,
 * no shared blast radius.
 */
export function getActivityDbPath(): string {
  return join(getDataDir(), 'activity.db');
}
