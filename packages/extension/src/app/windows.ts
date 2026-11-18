// The Activity and Admin windows (design 6.1, slice 21): each opens once and
// is focused when the popup asks again. No `chrome`: `background.ts` passes
// in the `Windows` adapter (`adapters/chrome-windows.ts`) and the extension's
// page URLs.

/** A window's size in pixels. */
export interface WindowSize {
  width: number;
  height: number;
}

/** The browser windows the extension opens (`adapters/chrome-windows.ts`). */
export interface Windows {
  /** Open a popup-type window on `url`; answers its id, or `undefined` when
   * the browser created none. */
  open(url: string, size: WindowSize): Promise<number | undefined>;
  /** Bring the window to the front. */
  focus(windowId: number): Promise<void>;
  /** Whether the browser reports the window with an id; rejects for a
   * window it no longer knows (a closed one). */
  exists(windowId: number): Promise<boolean>;
  /** Called with the id of every window that closes. A wake listener:
   * subscribed only at the top level of `background.ts` (R1). */
  onClosed(listener: (windowId: number) => void): void;
}

export interface AppWindowDeps {
  windows: Windows;
  /** The extension's URL of a page it ships (`Runtime.pageUrl`). */
  pageUrl(path: string): string;
  /** The page the window shows, for example `activity.html`. */
  page: string;
  size: WindowSize;
}

/** One of the extension's own windows. Stateful (the id of the open window),
 * so `background.ts` builds each once. */
export interface AppWindow {
  /** Open the window, or focus it if it is already open. */
  open(): Promise<{ ok: true; windowId: number }>;
  /** A browser window closed: forget it when it is this one. */
  closed(windowId: number): void;
}

/**
 * Focus-if-open rather than always-create: the button is in a popup the user
 * will press again out of habit, and stacking five identical windows is the
 * kind of small rudeness that makes a tool feel unfinished.
 */
export function createAppWindow(deps: AppWindowDeps): AppWindow {
  let windowId: number | null = null;
  return {
    async open() {
      const known = windowId;
      if (known !== null) {
        try {
          if (await deps.windows.exists(known)) {
            await deps.windows.focus(known);
            return { ok: true, windowId: known };
          }
        } catch {
          // Closed since we last saw it — fall through and open a fresh one.
          windowId = null;
        }
      }
      // The browser may create no window (the API types the result optional
      // for exactly that case): treat it as "no window to remember" rather
      // than assuming success.
      const created = await deps.windows.open(deps.pageUrl(deps.page), deps.size);
      windowId = created ?? null;
      return { ok: true, windowId: created ?? -1 };
    },
    closed(closedId) {
      if (closedId === windowId) windowId = null;
    },
  };
}
