/**
 * Capture the download a click starts BEFORE Chrome can show its native
 * "Save as" dialog — the dialog nothing in CDP or the page can press.
 *
 * Why this shape, and not "tell Chrome to save without asking":
 *   - CDP `Browser.setDownloadBehavior` / `Page.setDownloadBehavior` answer
 *     "Not allowed" to any `chrome.debugger` client (Chromium gates them on
 *     `MayWriteLocalFiles()`, which the extension debugger host hard-codes to
 *     false).
 *   - `chrome.downloads.download({ saveAs: false })` still prompts when the
 *     user enabled "Ask where to save each file" — that preference is checked
 *     independently of the flag.
 *   - But Chrome asks every `onDeterminingFilename` listener BEFORE it gets to
 *     the prompt, and only prompts a download that is still in progress. So a
 *     listener that holds the download (returns `true`), cancels it, and only
 *     then releases `suggest()` makes the prompt unreachable.
 *
 * The cancelled download's URL goes back to the server, which fetches the
 * bytes in the page and writes them itself (see the server's `downloads.ts`).
 *
 * The listener is registered ONLY while a capture is armed: an
 * `onDeterminingFilename` listener makes Chrome wait on it for every
 * download, so leaving one installed would tax every download the user makes.
 */

/** The `DownloadItem` fields the capture reads. */
export interface DeterminingItem {
  id: number;
  url: string;
  finalUrl?: string;
  filename: string;
  mime?: string;
  /** The page that started the download — empty when the page sent none. */
  referrer?: string;
}

export type DeterminingListener = (
  item: DeterminingItem,
  suggest: (suggestion?: { filename: string }) => void,
) => boolean | undefined;

/** The slice of `chrome.downloads` used here — injected so tests use fakes. */
export interface DownloadsApi {
  onDeterminingFilename: {
    addListener(fn: DeterminingListener): void;
    removeListener(fn: DeterminingListener): void;
  };
  cancel(id: number): Promise<void>;
  erase(query: { id: number }): Promise<number[]>;
}

export interface CapturedDownload {
  /** Where the bytes actually come from (after redirects when Chrome knows). */
  url: string;
  original_url: string;
  /** Chrome's suggested name — the server sanitizes it to a basename. */
  filename: string;
  mime: string;
}

export interface ArmedCapture {
  /** The captured download, or null on timeout / disarm. */
  result: Promise<CapturedDownload | null>;
  disarm(): void;
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Could this download have come from a page on `origin`? `DownloadItem` has
 * no tab id, so this is the cheapest narrowing available: a download whose
 * referrer (or, for a `blob:` URL, whose own origin) points at ANOTHER origin
 * is certainly not the clicked tab's and is left alone. A download with no
 * such evidence (a `no-referrer` page, a `data:` URL) is still taken —
 * refusing it would turn a working capture into a timeout.
 */
export function mayComeFrom(item: DeterminingItem, origin: string): boolean {
  if (item.referrer) return originOf(item.referrer) === origin;
  if (item.url.startsWith('blob:')) return originOf(item.url.slice('blob:'.length)) === origin;
  return true;
}

export interface DownloadCapture {
  /** `origin`, when given, narrows the capture with `mayComeFrom`. */
  arm(timeoutMs: number, origin?: string): ArmedCapture;
}

export function createDownloadCapture(api: DownloadsApi): DownloadCapture {
  let armed = false;

  return {
    arm(timeoutMs: number, origin?: string): ArmedCapture {
      if (armed) {
        throw new Error('download: another browser.download is already waiting for a download');
      }
      armed = true;
      let settle!: (value: CapturedDownload | null) => void;
      const result = new Promise<CapturedDownload | null>((resolve) => {
        settle = resolve;
      });

      const done = (value: CapturedDownload | null): void => {
        if (!armed) return;
        armed = false;
        clearTimeout(timer);
        api.onDeterminingFilename.removeListener(listener);
        settle(value);
      };

      const listener: DeterminingListener = (item, suggest) => {
        // Not ours: return without holding it, so Chrome carries on exactly
        // as if no listener were installed.
        if (!armed) return undefined;
        if (origin !== undefined && !mayComeFrom(item, origin)) return undefined;
        done({
          url: item.finalUrl || item.url,
          original_url: item.url,
          filename: item.filename,
          mime: item.mime ?? '',
        });
        // Hold Chrome (return true) until the cancel has landed; only then
        // release it. A cancelled download is never prompted for.
        void api
          .cancel(item.id)
          .then(() => api.erase({ id: item.id }))
          .catch(() => undefined)
          .finally(() => {
            try {
              suggest();
            } catch {
              // The download is already gone — nothing left to release.
            }
          });
        return true;
      };

      const timer = setTimeout(() => {
        done(null);
      }, timeoutMs);
      api.onDeterminingFilename.addListener(listener);

      return {
        result,
        disarm: () => {
          done(null);
        },
      };
    },
  };
}

/**
 * Arm `capture`, run `click`, then wait for the download it starts. The
 * capture is ALWAYS disarmed when the click fails or throws, so a broken
 * click can never leave the worker-wide listener eating the user's next
 * download (or refusing every later `browser.download` as "already waiting").
 */
export async function captureAround(
  capture: DownloadCapture,
  opts: { timeoutMs: number; origin?: string },
  click: () => Promise<{ ok: true } | { ok: false; error: string }>,
): Promise<{ ok: true; captured: CapturedDownload | null } | { ok: false; error: string }> {
  const armed = capture.arm(opts.timeoutMs, opts.origin);
  let clicked = false;
  try {
    const outcome = await click();
    if (!outcome.ok) return outcome;
    clicked = true;
  } finally {
    if (!clicked) armed.disarm();
  }
  return { ok: true, captured: await armed.result };
}
