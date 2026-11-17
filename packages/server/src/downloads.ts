import { randomBytes } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  constants as fsConstants,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
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
 * download a click starts, and only a download it can attribute to that click
 * (owner decision D17). The order is: the extension HOLDS the download
 * (`chrome.downloads.onDeterminingFilename` is not answered, so Chrome neither
 * prompts nor saves) and hands its URL to the same in-page fetch; this server
 * FETCHES the bytes and WRITES the file; then it tells the extension whether
 * the file was saved (`download_settle`), and only then does the extension
 * cancel and erase Chrome's own copy. If the fetch or the write fails, or the
 * answer is lost, Chrome's download is released untouched or its hold expires
 * (see the extension's `download-capture.ts`).
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

/**
 * File types Windows (and the other desktops) run, open as code or install
 * on a double-click. Chrome warns about these and SmartScreen checks them;
 * a file the server writes gets neither, so `browser.download` refuses them
 * unless the human allowed it (`config set downloads.allow-executables on`).
 * Lower case, without the dot.
 */
const EXECUTABLE_EXTENSIONS = new Set([
  // Windows programs, installers and libraries
  'exe',
  'com',
  'scr',
  'pif',
  'cpl',
  'msi',
  'msp',
  'mst',
  'msc',
  'dll',
  'ocx',
  'sys',
  'drv',
  'appx',
  'appxbundle',
  'msix',
  'msixbundle',
  'appinstaller',
  'application',
  'appref-ms',
  'xbap',
  'gadget',
  // Windows scripts and script hosts
  'bat',
  'cmd',
  'ps1',
  'psm1',
  'psd1',
  'ps1xml',
  'psc1',
  'vb',
  'vbs',
  'vbe',
  'js',
  'jse',
  'wsf',
  'wsh',
  'wsc',
  'hta',
  'sct',
  'reg',
  'inf',
  'ins',
  'isp',
  // Windows shortcuts and shell files that point at or run something
  'lnk',
  'url',
  'scf',
  'settingcontent-ms',
  'library-ms',
  'search-ms',
  'searchconnector-ms',
  // Compiled help (runs script) and disk images Windows mounts on a
  // double-click, which bypass the Mark-of-the-Web of what is inside
  'chm',
  'iso',
  'img',
  'vhd',
  'vhdx',
  // Java, Office macro add-ins
  'jar',
  'jnlp',
  'xll',
  'xlam',
  'ppam',
  // macOS and Linux
  'app',
  'command',
  'pkg',
  'dmg',
  'sh',
  'run',
  'desktop',
  'appimage',
  'deb',
  'rpm',
]);

/**
 * Is `name` a type that runs or installs on a double-click? Checks the LAST
 * extension, case-insensitively, after dropping the trailing dots and
 * spaces Windows drops when it creates the file (`setup.exe.` is
 * `setup.exe`), so a double extension (`invoice.pdf.exe`) is caught by what
 * it really is.
 */
export function isExecutableFilename(name: string): boolean {
  const trimmed = name.replace(/[.\s]+$/, '');
  const dot = trimmed.lastIndexOf('.');
  if (dot === -1) return false;
  return EXECUTABLE_EXTENSIONS.has(trimmed.slice(dot + 1).toLowerCase());
}

/** The console command that lets `browser.download` save executable types. */
export const ALLOW_EXECUTABLES_COMMAND = 'browser-link config set downloads.allow-executables on';

function executableRefusal(filename: string): string {
  return (
    `refused: "${filename}" is an executable file type (it runs or installs when opened), and ` +
    'saving those is off by default. Nothing was written. Only the human can allow it, with: ' +
    ALLOW_EXECUTABLES_COMMAND
  );
}

/** An http(s) URL, or null: what may go into a Zone.Identifier stream. A
 * `data:` URL would put the payload there, a `blob:` one an opaque id. */
function httpUrlOrNull(url: string | null | undefined): string | null {
  if (typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  } catch {
    return null;
  }
  // No line break can reach the stream: it would add a line of its own.
  return /[\r\n]/.test(url) ? null : url;
}

/**
 * The `Zone.Identifier` alternate data stream Chrome writes on a download
 * (the Mark-of-the-Web): zone 3 (Internet), so SmartScreen and Office
 * Protected View treat the file as coming from the web. `ReferrerUrl` is the
 * page, `HostUrl` the download; either is left out when it is unknown or not
 * http(s).
 */
export function zoneIdentifierContent(urls: {
  pageUrl?: string | null;
  downloadUrl?: string | null;
}): string {
  const referrer = httpUrlOrNull(urls.pageUrl);
  const host = httpUrlOrNull(urls.downloadUrl);
  return (
    '[ZoneTransfer]\r\nZoneId=3\r\n' +
    (referrer ? `ReferrerUrl=${referrer}\r\n` : '') +
    (host ? `HostUrl=${host}\r\n` : '')
  );
}

/** Write the Zone.Identifier stream of the file at `path` (NTFS only). */
function writeZoneIdentifier(path: string, content: string): void {
  writeFileSync(`${path}:Zone.Identifier`, content);
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
 * Write `data` as `filename` inside `dir`, creating `dir` if needed, so that
 * a file under the final name is always a complete one (owner decision D17:
 * nothing counts as saved until the file is).
 *
 *   1. The bytes go to a temporary file in `dir` (same file system, so step 2
 *      needs no copy), created exclusively under a random name, then fsync'd.
 *   2. The temporary file is hard-linked to the final name. `link` fails with
 *      EEXIST when the name exists, file or symlink (a symlink, even a
 *      dangling one, is never followed), so it is the same never-overwrite
 *      step the old `wx` create was: an existing name becomes
 *      `name (1).ext`, `name (2).ext`, … up to (999).
 *   3. The temporary file is removed on every path, success or failure.
 *
 * Same pattern as `installers/safe-file.ts`'s `atomicWrite` (sibling temp
 * file, fsync, cleanup on failure), but not that function: its `rename`
 * replaces an existing file, and its home-directory and symlink guards do not
 * apply here (the human chose `downloads.dir`; `link` never follows a symlink
 * at the final name).
 *
 * Returns the absolute path written. Throws, leaving nothing behind, when
 * the write fails.
 */
export function writeDownloadFile(dir: string, filename: string, data: Buffer): string {
  mkdirSync(dir, { recursive: true });
  const tmp = writeTempFile(dir, data);
  try {
    const ext = extname(filename);
    const stem = ext.length > 0 ? filename.slice(0, -ext.length) : filename;
    for (let attempt = 0; attempt < 1000; attempt++) {
      const name = attempt === 0 ? filename : `${stem} (${attempt})${ext}`;
      const path = join(dir, name);
      try {
        placeExclusive(tmp, path);
        return path;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
    }
    throw new Error(`could not find a free filename for ${filename} in ${dir}`);
  } finally {
    removeQuietly(tmp);
  }
}

/** Codes `link` answers on a file system without hard links (FAT/exFAT,
 * some network shares). */
const NO_HARD_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS']);

/**
 * Make `tmp`'s complete content appear under `path`, failing with EEXIST when
 * `path` exists. Hard link first (atomic). Where hard links are not supported
 * this falls back to an exclusive copy, which is NOT atomic: the name exists
 * while the copy runs, so a copy that fails midway is removed here.
 */
function placeExclusive(tmp: string, path: string): void {
  try {
    linkSync(tmp, path);
    return;
  } catch (err) {
    if (!NO_HARD_LINKS.has((err as NodeJS.ErrnoException).code ?? '')) throw err;
  }
  try {
    copyFileSync(tmp, path, fsConstants.COPYFILE_EXCL);
  } catch (err) {
    // EEXIST is checked before anything is created: that file is not ours.
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') removeQuietly(path);
    throw err;
  }
}

/** Write `data` to a new temporary file in `dir` and return its path. The
 * name is random and created exclusively, so it never replaces a user file,
 * and its pattern (`.browser-link-<hex>.part`) is never a candidate of the
 * `(n)` naming. On failure the temporary file is removed. */
function writeTempFile(dir: string, data: Buffer): string {
  let tmp = '';
  let fd: number | null = null;
  for (let attempt = 0; fd === null; attempt++) {
    tmp = join(dir, `.browser-link-${randomBytes(8).toString('hex')}.part`);
    try {
      fd = openSync(tmp, 'wx');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || attempt >= 9) throw err;
    }
  }
  try {
    let written = 0;
    while (written < data.length) {
      written += writeSync(fd, data, written, data.length - written);
    }
    fsyncSync(fd);
    const closing = fd;
    fd = null;
    closeSync(closing);
    return tmp;
  } catch (err) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // already on the error path
      }
    }
    removeQuietly(tmp);
    throw err;
  }
}

function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // already gone, or never created
  }
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
  /** The page the fetch ran in (`location.href`): the Mark-of-the-Web's
   * `ReferrerUrl`. Absent from an outcome built before this field existed. */
  page_url?: string | null;
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
  const out = { state: 'interrupted', bytes: 0, mime: null, content_disposition: null, final_url: null, page_url: null };
  try { out.page_url = String(location.href); } catch (e) { /* no location: left null */ }
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
  /** Windows only, on a saved file: whether its Zone.Identifier stream (the
   * Mark-of-the-Web) was written. Absent on other systems. */
  mark_of_the_web?: 'written' | 'failed';
  /** Why the stream could not be written; the file itself was kept. */
  mark_of_the_web_error?: string;
}

/**
 * What Chrome reported about a download it started and the extension holds
 * (selector mode). The re-fetch is checked against it before Chrome's copy
 * may be erased (owner decision D17).
 */
export interface ChromeReportedDownload {
  /** Where Chrome's bytes come from (its final URL when it knows it). */
  url: string;
  /** Chrome's MIME type; empty or absent when it did not know it. */
  mime?: string | null;
  /** Chrome's total size in bytes; null, absent or <= 0 when unknown (no
   * Content-Length). */
  totalBytes?: number | null;
}

/** `type/subtype`, lower case, without parameters; null when there is none. */
function mimeEssence(mime: string | null | undefined): string | null {
  if (typeof mime !== 'string') return null;
  const essence = mime.split(';')[0].trim().toLowerCase();
  return essence.length > 0 ? essence : null;
}

/** The URL without its fragment, in its normalized form when it parses. */
function comparableUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.href;
  } catch {
    return url;
  }
}

/**
 * Is the re-fetched file certainly the download Chrome started? Chrome must
 * have reported a size and the re-fetch must have exactly that size; the
 * MIME type must match when Chrome knew it, and the final URL always.
 * Returns null when all of that holds, else the reasons it does not. A size
 * Chrome did not report (no Content-Length) is a doubt, not a pass: the
 * re-fetch cannot be proven identical, and D17 erases nothing on a doubt.
 */
export function refetchMismatch(
  chrome: ChromeReportedDownload,
  outcome: FetchDownloadOutcome,
): string[] | null {
  const reasons: string[] = [];
  const chromeSize =
    typeof chrome.totalBytes === 'number' && chrome.totalBytes > 0 ? chrome.totalBytes : null;
  const chromeMime = mimeEssence(chrome.mime);
  if (chromeSize === null) {
    reasons.push('Chrome did not report the size, so the re-fetch cannot be proven identical');
  }
  if (chromeSize !== null && outcome.bytes !== chromeSize) {
    reasons.push(`Chrome reported ${chromeSize} bytes, the re-fetch got ${outcome.bytes}`);
  }
  const fetchedMime = mimeEssence(outcome.mime);
  if (chromeMime !== null && fetchedMime !== chromeMime) {
    reasons.push(
      `Chrome reported the type ${chromeMime}, the re-fetch got ${fetchedMime ?? 'no type'}`,
    );
  }
  const fetchedUrl = outcome.final_url ?? null;
  if (fetchedUrl === null || comparableUrl(fetchedUrl) !== comparableUrl(chrome.url)) {
    reasons.push(
      `Chrome's download came from ${chrome.url}, the re-fetch ended at ${fetchedUrl ?? 'an unknown URL'}`,
    );
  }
  return reasons.length > 0 ? reasons : null;
}

const USE_CHROME_COPY =
  "use Chrome's own download, in Chrome's downloads list (chrome://downloads)";

function mismatchError(reasons: string[]): string {
  return (
    `the capture failed: the file fetched again does not match the download Chrome started (${reasons.join('; ')}), ` +
    `so nothing was saved here and Chrome's own download was not erased; ${USE_CHROME_COPY}`
  );
}

/**
 * The failure text of a captured download whose request was not a GET:
 * fetching it again would send a different request (or repeat a POST), so
 * it is not fetched at all.
 */
export function notRefetchableError(method: string): string {
  return (
    `the capture failed: Chrome's download came from a ${method} request, which cannot be fetched again safely, ` +
    `so nothing was fetched or saved here and Chrome's own download was not erased; ${USE_CHROME_COPY}`
  );
}

export interface ShapeDownloadOptions {
  /** Selector mode with a held Chrome download: the file is saved only when
   * the re-fetch matches it (`refetchMismatch`). */
  expected?: ChromeReportedDownload;
  /** The MIME type to report when the response carried none (Chrome's). */
  fallbackMime?: string | null;
  /** `config set downloads.allow-executables on`: save executable types. */
  allowExecutables?: boolean;
  /** Write the Mark-of-the-Web on a saved file when `platform` is win32.
   * `write` defaults to writing the `:Zone.Identifier` stream. */
  markOfTheWeb?: {
    platform: NodeJS.Platform;
    write?: (path: string, content: string) => void;
  };
}

/**
 * Turn the in-page fetch outcome into the agent-facing result, writing the
 * file on `complete`. A failed write downgrades to `interrupted` with the
 * error — the agent must never be told a file exists when it does not.
 *
 * Before the write, in this order: a re-fetch that does not match what
 * Chrome reported (`options.expected`) is not saved; an executable type is
 * refused unless `options.allowExecutables`. After it, on Windows, the
 * Zone.Identifier stream is written; a stream that cannot be written keeps
 * the file and says so (`mark_of_the_web: 'failed'`).
 */
export function shapeDownloadResult(
  outcome: FetchDownloadOutcome,
  sources: FilenameSources & { url: string },
  save: (filename: string, data: Buffer) => string,
  options: ShapeDownloadOptions = {},
): DownloadResult {
  const filename = pickFilename({
    ...sources,
    contentDisposition: outcome.content_disposition,
    url: outcome.final_url ?? sources.url,
  });
  const base = {
    filename,
    mime: outcome.mime || options.fallbackMime || null,
    url: outcome.final_url ?? sources.url,
  };
  if (outcome.state === 'complete' && typeof outcome.data_b64 === 'string') {
    const data = Buffer.from(outcome.data_b64, 'base64');
    const refused = (error: string): DownloadResult => ({
      ok: false,
      state: 'interrupted',
      path: null,
      bytes: data.length,
      ...base,
      error,
    });
    const mismatch = options.expected ? refetchMismatch(options.expected, outcome) : null;
    if (mismatch) return refused(mismatchError(mismatch));
    if (!options.allowExecutables && isExecutableFilename(filename)) {
      return refused(executableRefusal(filename));
    }
    try {
      const path = save(filename, data);
      return {
        ok: true,
        state: 'complete',
        path,
        bytes: data.length,
        ...base,
        ...markSavedFile(path, outcome, base.url, options.markOfTheWeb),
      };
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
    error: options.expected
      ? refetchFailedError(outcome.error ?? 'download did not complete')
      : (outcome.error ?? 'download did not complete'),
  };
}

/** The failure text of a held Chrome download (selector mode) whose re-fetch
 * did not complete (an HTTP error, such as a POST answer fetched with GET, or
 * no time left): a capture failure like the others, Chrome's copy kept. */
function refetchFailedError(why: string): string {
  return (
    `the capture failed: fetching the file again failed (${why}), ` +
    `so nothing was saved here and Chrome's own download was not erased; ${USE_CHROME_COPY}`
  );
}

/** Write the Mark-of-the-Web on the file just saved at `path`, on Windows
 * only. Never throws: the file is kept either way, and a failure is
 * reported. */
function markSavedFile(
  path: string,
  outcome: FetchDownloadOutcome,
  downloadUrl: string,
  mark: ShapeDownloadOptions['markOfTheWeb'],
): Pick<DownloadResult, 'mark_of_the_web' | 'mark_of_the_web_error'> {
  if (!mark || mark.platform !== 'win32') return {};
  const content = zoneIdentifierContent({ pageUrl: outcome.page_url, downloadUrl });
  try {
    (mark.write ?? writeZoneIdentifier)(path, content);
    return { mark_of_the_web: 'written' };
  } catch (err) {
    return {
      mark_of_the_web: 'failed',
      mark_of_the_web_error:
        `the file was saved, but its Mark-of-the-Web (Zone.Identifier stream) could not be written, ` +
        `so Windows will not treat it as coming from the web: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
