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
  /** One `Input.dispatchMouseEvent`; resolves when the page answered it,
   * rejects when the dispatch fails. Input only: what a dispatch means for
   * a JavaScript dialog is the page driver's business (design revision 8). */
  mouse(event: MouseEventParams): Promise<void>;
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
