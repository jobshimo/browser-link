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
 *     the prompt, and "the DownloadItem will not complete until all listeners
 *     have called suggest" (chrome.downloads docs). So a listener that holds
 *     the download (returns `true`) keeps it from completing and from
 *     prompting, without cancelling it.
 *
 * Two rules the owner set (decision D17):
 *
 *   1. ATTRIBUTION. A download is touched only when it is certainly the
 *      clicked tab's. `DownloadItem` has no tab id, frame id or initiator, so
 *      it alone can never prove that; its referrer and timing only make it
 *      likely. The proof comes from the debugger session the extension already
 *      holds on the clicked tab: Chrome reports `Page.downloadWillBegin`
 *      (frameId, guid, url) on that session for a download started by one of
 *      the tab's frames. A Chrome download is the tab's when its `url` or
 *      `finalUrl` is the URL that event reported during the wait, and no
 *      extension started it (`byExtensionId`). Anything else is never held,
 *      paused, cancelled or erased: the listener returns at once and Chrome
 *      carries on as if no listener were installed. The capture then reports
 *      that a download appeared but could not be tied to the click.
 *
 *   2. NOTHING IS ERASED BEFORE THE FILE IS SAVED. The attributed download is
 *      only held while the server fetches the bytes in the page and writes
 *      them. `settle(id, saved)` decides its fate afterwards: saved → cancel,
 *      then erase, then release (a cancelled download is never prompted for);
 *      not saved → release untouched, so Chrome finishes the original download
 *      exactly as it would have without browser-link (asking where to save it
 *      when the user set Chrome to ask). A hold nobody settles (server gone,
 *      bridge dropped) is released untouched at `holdMs`.
 *
 * The listener is registered ONLY while a capture waits or a download is
 * held: an `onDeterminingFilename` listener makes Chrome wait on it for every
 * download, so leaving one installed would tax every download the user makes.
 * Chrome allows one such listener per extension, so this module owns exactly
 * one and shares it between the wait and the holds.
 */

import type { CaptureOutcome, DownloadSettleOutcome } from '@browser-link/core';

/** The `DownloadItem` fields the capture reads. */
export interface DeterminingItem {
  id: number;
  url: string;
  finalUrl?: string;
  filename: string;
  mime?: string;
  /** Size from Content-Length; 0 or -1 when Chrome does not know it. */
  totalBytes?: number;
  /** Set only when an extension started the download (`chrome.downloads.download`). */
  byExtensionId?: string;
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

/**
 * The clicked tab's own report of the downloads it starts: the URL of every
 * `Page.downloadWillBegin` its debugger session receives. Returns an
 * unsubscribe.
 */
export interface TabDownloadSignals {
  subscribe(onDownloadWillBegin: (url: string) => void): () => void;
}

/** The download, the wait's outcome and the settle answer are the
 * `Downloads` port's values (core `ports/values.ts`, slice 16). */
export type { CapturedDownload, CaptureOutcome, DownloadSettleOutcome } from '@browser-link/core';

export interface ArmedCapture {
  result: Promise<CaptureOutcome>;
  disarm(): void;
}

export interface ArmOptions {
  /** How long to wait for the click's download. */
  timeoutMs: number;
  /** How long a captured download may stay held before it is released untouched. */
  holdMs: number;
  tab: TabDownloadSignals;
}

export interface DownloadCapture {
  arm(opts: ArmOptions): ArmedCapture;
  settle(downloadId: number, saved: boolean): Promise<DownloadSettleOutcome>;
}

/** The URLs a Chrome download is known by. */
function urlsOf(item: DeterminingItem): string[] {
  return item.finalUrl ? [item.url, item.finalUrl] : [item.url];
}

/**
 * Is `item` the download the clicked tab reported? Only when an extension did
 * not start it and the tab's debugger session reported one of its URLs. Returns
 * the index of the matching report, or -1.
 */
export function attributedSignal(item: DeterminingItem, tabSignals: readonly string[]): number {
  if (item.byExtensionId) return -1;
  const urls = urlsOf(item);
  return tabSignals.findIndex((signal) => urls.includes(signal));
}

interface Hold {
  release: () => void;
  timer: ReturnType<typeof setTimeout>;
  urls: string[];
  /** Another Chrome download with the same URL appeared while held: the two
   * cannot be told apart, so this one is never cancelled. */
  ambiguous: boolean;
}

export function createDownloadCapture(api: DownloadsApi): DownloadCapture {
  /** The waiting capture's handler, or null when nothing waits. */
  let waiting: ((item: DeterminingItem, suggest: () => void) => boolean) | null = null;
  const holds = new Map<number, Hold>();
  let listening = false;

  const syncListener = (): void => {
    const needed = waiting !== null || holds.size > 0;
    if (needed && !listening) api.onDeterminingFilename.addListener(listener);
    if (!needed && listening) api.onDeterminingFilename.removeListener(listener);
    listening = needed;
  };

  const releaseSafely = (suggest: () => void): void => {
    try {
      suggest();
    } catch {
      // The download is already gone — nothing left to release.
    }
  };

  /** Stop holding `id`. The caller releases it, then calls `syncListener`. */
  const takeHold = (id: number): Hold | undefined => {
    const hold = holds.get(id);
    if (!hold) return undefined;
    holds.delete(id);
    clearTimeout(hold.timer);
    return hold;
  };

  function listener(item: DeterminingItem, suggest: () => void): boolean | undefined {
    // A second download with a held download's URL: leave it alone, and mark
    // the held one so it is never cancelled.
    const itemUrls = urlsOf(item);
    for (const hold of holds.values()) {
      if (hold.urls.some((u) => itemUrls.includes(u))) hold.ambiguous = true;
    }
    if (waiting && waiting(item, suggest)) return true;
    // Not the tab's: return without holding it, so Chrome carries on exactly
    // as if no listener were installed.
    return undefined;
  }

  const hold = (item: DeterminingItem, suggest: () => void, holdMs: number): void => {
    const timer = setTimeout(() => {
      const expired = takeHold(item.id);
      if (!expired) return;
      releaseSafely(expired.release);
      syncListener();
    }, holdMs);
    holds.set(item.id, { release: suggest, timer, urls: urlsOf(item), ambiguous: false });
  };

  return {
    arm({ timeoutMs, holdMs, tab }: ArmOptions): ArmedCapture {
      if (waiting) {
        throw new Error('download: another browser.download is already waiting for a download');
      }
      let settleResult!: (value: CaptureOutcome) => void;
      const result = new Promise<CaptureOutcome>((resolve) => {
        settleResult = resolve;
      });
      const signals: string[] = [];
      /** URLs of downloads already let go during this wait. */
      const letGo: string[] = [];
      let finished = false;

      const done = (value: CaptureOutcome): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        unsubscribe();
        waiting = null;
        syncListener();
        settleResult(value);
      };

      const onItem = (item: DeterminingItem, suggest: () => void): boolean => {
        const match = attributedSignal(item, signals);
        // A download whose URL was already seen this wait is ambiguous: the
        // tab's report could belong to the first one.
        if (match === -1 || urlsOf(item).some((u) => letGo.includes(u))) {
          letGo.push(...urlsOf(item));
          return false;
        }
        signals.splice(match, 1);
        hold(item, suggest, holdMs);
        done({
          state: 'captured',
          download: {
            download_id: item.id,
            url: item.finalUrl || item.url,
            original_url: item.url,
            filename: item.filename,
            mime: item.mime ?? '',
            total_bytes:
              typeof item.totalBytes === 'number' && item.totalBytes > 0 ? item.totalBytes : null,
          },
        });
        return true;
      };

      const unsubscribe = tab.subscribe((url) => {
        // The tab reported a download Chrome already showed us and we let go
        // (the two reports crossed): it cannot be taken back, so the capture
        // fails now instead of waiting for nothing.
        if (letGo.includes(url)) {
          done({ state: 'unattributed' });
          return;
        }
        signals.push(url);
      });

      const timer = setTimeout(() => {
        done(letGo.length > 0 ? { state: 'unattributed' } : { state: 'timeout' });
      }, timeoutMs);
      waiting = onItem;
      syncListener();

      return {
        result,
        disarm: () => {
          done({ state: 'timeout' });
        },
      };
    },

    async settle(downloadId: number, saved: boolean): Promise<DownloadSettleOutcome> {
      const held = takeHold(downloadId);
      // Not held: an unknown id, one already settled, or a hold that expired
      // and was released. What became of Chrome's download is not known here,
      // so this does not claim it was left in Chrome.
      if (!held) return 'not_held';
      if (!saved || held.ambiguous) {
        releaseSafely(held.release);
        syncListener();
        return 'left_in_chrome';
      }
      // Cancel first: a cancelled download is never prompted for. Erase only
      // after a cancel that landed; release Chrome in every case.
      let outcome: DownloadSettleOutcome = 'left_in_chrome';
      try {
        await api.cancel(downloadId);
        outcome = 'cancelled';
        await api.erase({ id: downloadId });
        outcome = 'removed';
      } catch {
        // `outcome` says how far it got.
      } finally {
        releaseSafely(held.release);
        syncListener();
      }
      return outcome;
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
  opts: ArmOptions,
  click: () => Promise<{ ok: true } | { ok: false; error: string }>,
): Promise<{ ok: true; outcome: CaptureOutcome } | { ok: false; error: string }> {
  const armed = capture.arm(opts);
  let clicked = false;
  try {
    const outcome = await click();
    if (!outcome.ok) return outcome;
    clicked = true;
  } finally {
    if (!clicked) armed.disarm();
  }
  return { ok: true, outcome: await armed.result };
}
