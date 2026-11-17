// Narrow page capabilities (design 3.2), built once per `CdpSession` by
// `session/page-driver.ts`. Handlers require them one by one. Ports
// describe what is used: the pointer joined with click (slice 10);
// `insertText` and CDP event waits join with the slices that move the
// handlers using them (11, 14).

import type { PageInfo } from './page-info.js';
import type {
  KeyEvent,
  MouseEventParams,
  ObserverMarkResult,
  SettleParams,
  SettleReport,
} from './values.js';

export interface Evaluator {
  /** `Runtime.evaluate` with the user-gesture flag, awaiting a promise
   * result; rejects with the page's exception text. */
  evaluate<T = unknown>(expression: string): Promise<T>;
}

export interface Keyboard {
  /** One `Input.dispatchKeyEvent`. */
  key(event: KeyEvent): Promise<void>;
}

export interface Pointer {
  /** `Input.dispatchMouseEvent` for each event, in order; rejects when one
   * fails. `dialog: true` when a JavaScript dialog is open after them, or
   * opened by one: the page is paused, the event that opened it is answered
   * only once it closes, so nothing after it is sent. */
  mouse(events: readonly MouseEventParams[]): Promise<{ dialog: boolean }>;
  /** The move of a click whose landing is watched, within `budgetMs`.
   * `unanswered` when the transport counts the dispatch as not answered
   * (cdp-direct: it failed or ran past the budget); otherwise as `mouse`. */
  watchedMove(
    event: MouseEventParams,
    budgetMs: number,
  ): Promise<{ dialog: boolean } | 'unanswered'>;
  /** Whether a JavaScript dialog is open now; always false where the
   * transport does not track dialogs (cdp-direct). */
  dialogOpen(): boolean;
}

export interface Settler {
  /** Take the page observer's action mark before an action dispatches;
   * `none` when `settle` is null (settle off for this call). Never throws. */
  mark(settle: SettleParams | null): Promise<ObserverMarkResult>;
  /** Run the settle wait and fold in what the observer saw since `mark`;
   * `undefined` when `settle` is null. Never throws. */
  settle(settle: SettleParams | null, mark: ObserverMarkResult): Promise<SettleReport | undefined>;
}

export interface PageDriver {
  evaluator: Evaluator;
  keyboard: Keyboard;
  pointer: Pointer;
  settler: Settler;
  page: PageInfo;
}
