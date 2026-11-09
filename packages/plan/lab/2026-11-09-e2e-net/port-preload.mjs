// Lab-only isolation, loaded with `node --import ./port-preload.mjs cli.js`.
// The server hard-codes its ports (WS bridge 17529, IPC/election 17530). When
// the owner's own browser-link primary already holds them, a lab server would
// become its proxy, or, if older, take it over (election.ts). This hook rewrites
// the two port literals in packages/server/dist/** at load time, so the lab
// server never touches 17529/17530. No file on disk is changed.
import { registerHooks } from 'node:module';

const WS = process.env.LAB_WS_PORT;
const IPC = process.env.LAB_IPC_PORT;
if (!WS || !IPC) throw new Error('port-preload: set LAB_WS_PORT and LAB_IPC_PORT');

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!url.includes('/packages/server/dist/') || result.source == null) return result;
    const src = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8');
    if (!src.includes('17529') && !src.includes('17530')) return result;
    return { ...result, source: src.replaceAll('17529', WS).replaceAll('17530', IPC) };
  },
});
