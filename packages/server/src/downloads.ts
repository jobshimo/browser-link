import { mkdirSync, writeFileSync } from 'node:fs';
import { extname, isAbsolute, join } from 'node:path';
import { sanitizeDownloadsMaxMb } from './config.js';

/**
 * `browser.download` support: everything the tool needs that is NOT talking
 * to Chrome — filename policy, the download directory, the file write, the
 * in-page fetch expression and the shaping of the result the agent sees.
 *
 * WHY THE BYTES COME THROUGH THE SERVER. The obvious design — tell Chrome
 * "save downloads to <dir>, never ask" with CDP `Browser.setDownloadBehavior`
 * — is not available to us: Chromium refuses it (and the tab-scoped
 * `Page.setDownloadBehavior`, which delegates to the same check) for any
 * `chrome.debugger` client, because the extension debugger host reports
 * `MayWriteLocalFiles() == false`. And `chrome.downloads.download({saveAs:
 * false})` does NOT suppress the dialog either: Chrome still prompts when the
 * user enabled "Ask where to save each file". So instead the bytes are
 * fetched IN THE PAGE (with the page's own cookies) and written here, into a
 * directory only the human configures.
 *
 * Chrome's download manager never SAVES anything. In url mode it is not
 * involved at all. In selector mode the extension uses it only to catch the
 * download a click starts: it hooks `chrome.downloads.onDeterminingFilename`,
 * which Chrome consults before prompting, cancels and erases that download
 * there, and hands its URL to the same in-page fetch (see the extension's
 * `download-capture.ts`).
 */

export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30_000;
export const MAX_DOWNLOAD_TIMEOUT_MS = 120_000;
/** Default cap on one download's size. The bytes travel base64-encoded inside
 * a CDP `Runtime.evaluate` result and then a bridge frame, so the cap also
 * bounds the memory both hops can be asked to hold. The human can change it
 * with `config set downloads.max-mb` (see `downloadMaxBytes`). */
export const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;

const BYTES_PER_MIB = 1024 * 1024;

/** The per-file cap, in bytes, `browser.download` applies for this config:
 * `downloadsMaxMb` when it is a whole number in [1, 64], else the 25 MiB
 * default (`MAX_DOWNLOAD_BYTES`). */
export function downloadMaxBytes(cfg: { downloadsMaxMb?: unknown }): number {
  return sanitizeDownloadsMaxMb(cfg.downloadsMaxMb) * BYTES_PER_MIB;
}

/** The text the in-page fetch reports when a body passes the cap. */
function capExceededMessage(maxBytes: number): string {
  if (maxBytes > 0 && maxBytes % BYTES_PER_MIB === 0) {
    return (
      `download exceeds the ${maxBytes / BYTES_PER_MIB} MiB cap (${maxBytes} bytes);` +
      ' the human can change it with: browser-link config set downloads.max-mb <1..64>'
    );
  }
  return `download exceeds the ${maxBytes} bytes cap`;
}
/** Extra bridge timeout on top of each hop's own budget (selector mode has
 * two hops: capture, then fetch), for the round trip only — the capture and
 * the in-page fetch enforce their budgets themselves and always answer, so
 * this is spent only when the bridge itself stalls. */
export const DOWNLOAD_BRIDGE_SLACK_MS = 10_000;

const MAX_FILENAME_LENGTH = 200;
// Characters no filename may carry on any OS we run on (Windows is the
// strictest) — plus the two path separators.
// eslint-disable-next-line no-control-regex
const RESERVED_CHARS = /[<>:"/\\|?*\u0000-\u001f]/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/**
 * Validate a filename the AGENT asked for. Strict on purpose: the agent may
 * name the file but never choose where it lands, so anything that could be
 * read as a path (separators, `..`, a drive prefix) is rejected outright
 * rather than quietly cleaned up.
 */
export function validateRequestedFilename(name: unknown): string {
  const fail = (why: string): never => {
    throw new Error(`browser.download: filename ${why} — pass a plain basename like "report.pdf"`);
  };
  if (typeof name !== 'string') return fail('must be a string');
  if (name.trim().length === 0) return fail('must not be empty');
  if (name.length > MAX_FILENAME_LENGTH)
    return fail(`must be at most ${MAX_FILENAME_LENGTH} characters`);
  if (name === '.' || name === '..') return fail('must not be "." or ".."');
  if (RESERVED_CHARS.test(name))
    return fail('must not contain path separators or reserved characters');
  if (/[.\s]$/.test(name)) return fail('must not end with a dot or a space');
  if (WINDOWS_DEVICE_NAME.test(name)) {
    return fail('must not be a Windows device name (CON, PRN, AUX, NUL, COM1-9, LPT1-9)');
  }
  return name;
}

/**
 * Windows device names — `NUL`, `con.txt`, `LPT1.log`: with or without an
 * extension, any case. Writing to one on Windows hits the device (or a
 * normalized name), so the server would report a file that does not exist.
 */
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * Make a filename that came from the PAGE (Chrome's suggestion, a
 * Content-Disposition header, a URL) safe to write: keep the last path
 * segment, replace reserved characters, drop control characters and leading
 * or trailing dots/spaces, and defuse Windows device names with a `_`
 * prefix. Cleaned up rather than rejected: the page, not the agent, chose
 * it. Returns null when nothing usable is left.
 */
export function sanitizeDerivedFilename(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const lastSegment = raw.split(/[/\\]/).pop() ?? '';
  const cleaned = lastSegment
    .replace(CONTROL_CHARS, '')
    .replace(/[<>:"|?*]/g, '_')
    .replace(/^[.\s]+/, '')
    .slice(0, MAX_FILENAME_LENGTH - 1)
    .replace(/[.\s]+$/, '');
  if (cleaned.length === 0) return null;
  return WINDOWS_DEVICE_NAME.test(cleaned) ? `_${cleaned}` : cleaned;
}

/** Extract the filename from a Content-Disposition header, preferring the
 * RFC 5987 `filename*=` form (it carries non-ASCII names correctly). */
export function filenameFromContentDisposition(header: string | null | undefined): string | null {
  if (typeof header !== 'string') return null;
  const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[2].trim().replace(/^"|"$/g, ''));
    } catch {
      // Malformed percent-encoding — fall through to the plain form.
    }
  }
  const plain = /filename\s*=\s*("[^"]*"|[^;]+)/i.exec(header);
  if (!plain) return null;
  const value = plain[1].trim().replace(/^"|"$/g, '');
  return value.length > 0 ? value : null;
}

/** Last path segment of an http(s) URL, decoded. Null for `blob:`/`data:`
 * URLs (their "path" is an opaque id or the payload itself). */
export function filenameFromUrl(url: string | null | undefined): string | null {
  if (typeof url !== 'string') return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const segment = parsed.pathname.split('/').pop() ?? '';
  if (segment.length === 0) return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export interface FilenameSources {
  /** Already validated by `validateRequestedFilename`. */
  requested?: string;
  /** Chrome's own suggestion for a captured download. */
  suggested?: string | null;
  contentDisposition?: string | null;
  url?: string | null;
}

/** requested → Chrome's suggestion → Content-Disposition → URL → "download". */
export function pickFilename(sources: FilenameSources): string {
  if (sources.requested !== undefined) return sources.requested;
  return (
    sanitizeDerivedFilename(sources.suggested) ??
    sanitizeDerivedFilename(filenameFromContentDisposition(sources.contentDisposition)) ??
    sanitizeDerivedFilename(filenameFromUrl(sources.url)) ??
    'download'
  );
}

export function clampDownloadTimeoutMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_DOWNLOAD_TIMEOUT_MS;
  }
  return Math.min(Math.floor(value), MAX_DOWNLOAD_TIMEOUT_MS);
}

/**
 * Where downloads land: the human-configured `downloads.dir` when it is an
 * absolute path, otherwise `<dataDir>/downloads`. config.json is untrusted
 * (hand-edited, corrupted), so a relative or non-string value falls back to
 * the default instead of resolving against whatever the cwd happens to be.
 */
export function resolveDownloadsDir(cfg: { downloadsDir?: unknown }, dataDir: string): string {
  const configured = cfg.downloadsDir;
  if (typeof configured === 'string' && configured.length > 0 && isAbsolute(configured)) {
    return configured;
  }
  return join(dataDir, 'downloads');
}

/**
 * Write `data` as `filename` inside `dir`, creating `dir` if needed. Never
 * overwrites: an existing name becomes `name (1).ext`, `name (2).ext`, …
 * (the `wx` flag makes the existence check and the create one atomic step).
 * Returns the absolute path written.
 */
export function writeDownloadFile(dir: string, filename: string, data: Buffer): string {
  mkdirSync(dir, { recursive: true });
  const ext = extname(filename);
  const stem = ext.length > 0 ? filename.slice(0, -ext.length) : filename;
  for (let attempt = 0; attempt < 1000; attempt++) {
    const name = attempt === 0 ? filename : `${stem} (${attempt})${ext}`;
    const path = join(dir, name);
    try {
      writeFileSync(path, data, { flag: 'wx' });
      return path;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  throw new Error(`could not find a free filename for ${filename} in ${dir}`);
}

/** What the in-page fetch expression resolves to. */
export interface FetchDownloadOutcome {
  state: 'complete' | 'interrupted' | 'timeout';
  status?: number;
  mime?: string | null;
  content_disposition?: string | null;
  final_url?: string | null;
  /** Bytes received — the full size on `complete`, partial otherwise. */
  bytes: number;
  /** Present only on `complete`. */
  data_b64?: string;
  error?: string;
}

/**
 * Build the expression `Runtime.evaluate` runs in the page: fetch `url` with
 * the page's credentials, stream the body (so `maxBytes` is enforced while
 * reading, not after buffering everything), and base64 it. Every exit path
 * resolves to a `FetchDownloadOutcome` — a timeout or an error reports how
 * far it got rather than throwing, so the agent always gets partial info.
 */
export function buildFetchDownloadJs(opts: {
  url: string;
  timeoutMs: number;
  maxBytes: number;
}): string {
  const url = JSON.stringify(opts.url);
  const timeoutMs = Math.floor(opts.timeoutMs);
  const maxBytes = Math.floor(opts.maxBytes);
  const capError = JSON.stringify(capExceededMessage(maxBytes));
  return `(async () => {
  const url = ${url};
  const timeoutMs = ${timeoutMs};
  const maxBytes = ${maxBytes};
  const capError = ${capError};
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
  const out = { state: 'interrupted', bytes: 0, mime: null, content_disposition: null, final_url: null };
  try {
    const res = await fetch(url, { credentials: 'include', signal: ctrl.signal });
    out.status = res.status;
    out.mime = res.headers.get('content-type');
    out.content_disposition = res.headers.get('content-disposition');
    out.final_url = res.url || url;
    if (!res.ok) {
      out.error = 'HTTP ' + res.status;
      return out;
    }
    const chunks = [];
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const step = await reader.read();
        if (step.done) break;
        out.bytes += step.value.byteLength;
        if (out.bytes > maxBytes) {
          ctrl.abort();
          out.error = capError;
          return out;
        }
        chunks.push(step.value);
      }
    }
    let binary = '';
    for (const chunk of chunks) {
      for (let i = 0; i < chunk.length; i += 0x8000) {
        binary += String.fromCharCode.apply(null, chunk.subarray(i, i + 0x8000));
      }
    }
    out.data_b64 = btoa(binary);
    out.state = 'complete';
    return out;
  } catch (err) {
    if (timedOut) {
      out.state = 'timeout';
      out.error = 'timed out after ' + timeoutMs + 'ms';
    } else {
      out.error = err && err.message ? err.message : String(err);
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
})()`;
}

/** The result `browser.download` returns to the agent. */
export interface DownloadResult {
  ok: boolean;
  state: 'complete' | 'interrupted' | 'timeout';
  path: string | null;
  filename: string | null;
  bytes: number;
  mime: string | null;
  url: string | null;
  error?: string;
}

/**
 * Turn the in-page fetch outcome into the agent-facing result, writing the
 * file on `complete`. A failed write downgrades to `interrupted` with the
 * error — the agent must never be told a file exists when it does not.
 */
export function shapeDownloadResult(
  outcome: FetchDownloadOutcome,
  sources: FilenameSources & { url: string },
  save: (filename: string, data: Buffer) => string,
): DownloadResult {
  const filename = pickFilename({
    ...sources,
    contentDisposition: outcome.content_disposition,
    url: outcome.final_url ?? sources.url,
  });
  const base = {
    filename,
    mime: outcome.mime ?? null,
    url: outcome.final_url ?? sources.url,
  };
  if (outcome.state === 'complete' && typeof outcome.data_b64 === 'string') {
    const data = Buffer.from(outcome.data_b64, 'base64');
    try {
      const path = save(filename, data);
      return { ok: true, state: 'complete', path, bytes: data.length, ...base };
    } catch (err) {
      return {
        ok: false,
        state: 'interrupted',
        path: null,
        bytes: data.length,
        ...base,
        error: `could not write the file: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  return {
    ok: false,
    state: outcome.state === 'timeout' ? 'timeout' : 'interrupted',
    path: null,
    bytes: outcome.bytes,
    ...base,
    error: outcome.error ?? 'download did not complete',
  };
}
