// Fixture servers for g9-downloads.mjs: one page origin (127.0.0.1) and one
// cross-site origin (localhost) for the cross-origin iframe. The download
// situations reuse the shapes of the e2e harness (packages/e2e/src/run.mjs,
// `serveDownloadSituation`): /post.pdf, /token.bin, /chunked.bin, /gzip.bin.
// Unlike the harness, `served` is keyed by the full request URL (path + query),
// so one-time tokens and counts are per trial.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
/** The same 2048 bytes as the e2e harness's REPORT_BYTES. */
export const REPORT_BYTES = Buffer.from(Array.from({ length: 2048 }, (_, i) => (i * 7 + 3) % 256));
export const GZIP_BYTES = gzipSync(REPORT_BYTES);
/** What /f/<name>?vary=1 answers on every even-numbered request to that URL. */
export const REVERSED_BYTES = Buffer.from(REPORT_BYTES).reverse();

/** A service worker that answers /sw-dl/<name> itself with an attachment. */
const SW_SOURCE = `
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (!u.pathname.startsWith('/sw-dl/')) return;
  const name = u.pathname.slice('/sw-dl/'.length);
  const bytes = new Uint8Array(2048).map((_, i) => (i * 7 + 3) % 256);
  e.respondWith(new Response(bytes, { headers: {
    'content-type': 'application/octet-stream',
    'content-disposition': 'attachment; filename="' + name + '"',
  } }));
});
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function startFixtures() {
  const html = readFileSync(join(HERE, 'fixture.html'));
  /** Every request, by full URL: { requests, methods }. */
  const served = {};
  const handler = async (q, r) => {
    const url = new URL(q.url, 'http://x');
    const path = url.pathname;
    const seen = (served[q.url] ??= { requests: 0, methods: [] });
    seen.requests++;
    seen.methods.push(q.method);
    q.resume();
    const attachment = (name, type, bytes, extra = {}) => {
      r.writeHead(200, {
        'content-type': type,
        'content-disposition': `attachment; filename="${name}"`,
        'content-length': bytes.length,
        ...extra,
      });
      r.end(bytes);
    };
    if (path === '/') return r.writeHead(200, { 'content-type': 'text/html' }).end(html);
    if (path === '/sw.js') {
      return r.writeHead(200, { 'content-type': 'text/javascript' }).end(SW_SOURCE);
    }
    if (path === '/iframe-child') {
      // Cross-site child: the whole frame is one link to `target` (an attachment).
      const target = url.searchParams.get('target') ?? '';
      return r
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          `<!doctype html><title>xo child</title><body style="margin:0"><a id="l" href="${target}" style="display:block;width:100vw;height:100vh;background:#cde">download from the cross-site iframe</a></body>`,
        );
    }
    if (path.startsWith('/f/')) {
      // /f/<name>[?slow=<ms>][&vary=1]: REPORT_BYTES as attachment <name>; with
      // slow, sent in 8 chunks spread over <ms>; with vary, the 2nd, 4th...
      // request to the same URL gets REVERSED_BYTES (so two downloads of one
      // URL can be told apart on disk).
      const name = path.slice(3);
      const slow = Number(url.searchParams.get('slow') ?? 0);
      const body = url.searchParams.get('vary') && seen.requests % 2 === 0 ? REVERSED_BYTES : REPORT_BYTES;
      if (!slow) return attachment(name, 'application/octet-stream', body);
      r.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename="${name}"`,
        'content-length': REPORT_BYTES.length,
      });
      for (let i = 0; i < 8; i++) {
        if (r.destroyed) return;
        r.write(body.subarray(i * 256, (i + 1) * 256));
        await sleep(slow / 8);
      }
      return r.end();
    }
    if (path === '/post.pdf') {
      if (q.method === 'POST') {
        return q.on('end', () => attachment('g9-e4-post.pdf', 'application/pdf', REPORT_BYTES));
      }
      return r.writeHead(405, { 'content-type': 'text/html', allow: 'POST' }).end('<p>Method not allowed</p>');
    }
    if (path === '/token.bin') {
      if (seen.requests === 1) {
        return attachment(`g9-e4-token-${url.searchParams.get('k')}.bin`, 'application/octet-stream', REPORT_BYTES);
      }
      return r.writeHead(200, { 'content-type': 'text/html' }).end('<p>This link has expired</p>');
    }
    if (path === '/chunked.bin') {
      r.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename="g9-e4-chunked-${url.searchParams.get('k')}.bin"`,
      });
      r.write(REPORT_BYTES.subarray(0, 1024));
      return r.end(REPORT_BYTES.subarray(1024));
    }
    if (path === '/gzip.bin') {
      return attachment(`g9-e4-gzip-${url.searchParams.get('k')}.bin`, 'application/octet-stream', GZIP_BYTES, {
        'content-encoding': 'gzip',
      });
    }
    r.writeHead(404).end();
  };
  const listen = async () => {
    const srv = createServer((q, r) => void handler(q, r));
    await new Promise((res) => srv.listen(0, '127.0.0.1', res));
    return srv;
  };
  const a = await listen();
  const x = await listen();
  return {
    origin: `http://127.0.0.1:${String(a.address().port)}`,
    /** Cross-site to `origin` (localhost vs 127.0.0.1), same server code. */
    xOrigin: `http://localhost:${String(x.address().port)}`,
    served,
    close: () => {
      a.closeAllConnections();
      x.closeAllConnections();
      a.close();
      x.close();
    },
  };
}
