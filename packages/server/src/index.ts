// Backwards-compatible entry: MCP clients that registered
// `node /path/to/dist/index.js` will keep working.
// New installs should use the `browser-link` bin (dist/cli.js).
import { runServer } from './server.js';

await runServer();
