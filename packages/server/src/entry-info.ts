import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Absolute filesystem path of the MCP server entry file (`dist/index.js`
 * after build).
 *
 * Resolved relative to *this* module's own location at runtime, so the
 * value is correct regardless of where the package is installed and
 * regardless of where in the dist tree future refactors place individual
 * commands. The only assumption is that `entry-info.js` and `index.js`
 * ship as siblings under `dist/` — they live next to each other in `src/`
 * and `tsc` preserves that relationship.
 */
export const SERVER_ENTRY_PATH = join(dirname(fileURLToPath(import.meta.url)), 'index.js');
