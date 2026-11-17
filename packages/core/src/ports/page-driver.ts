// Narrow page capabilities (design 3.2), built once per `CdpSession` by
// `session/page-driver.ts`. Handlers require them one by one. Ports
// describe what is used: the pointer, `insertText` and CDP event waits join
// with the slices that move the handlers using them (10, 11, 14).

import type { PageInfo } from './page-info.js';
import type { KeyEvent, ObserverMarkResult, SettleParams, SettleReport } from './values.js';

export interface Evaluator {
  /** `Runtime.evaluate` with the user-gesture flag, awaiting a promise
   * result; rejects with the page's exception text. */
  evaluate<T = unknown>(expression: string): Promise<T>;
}

export interface Keyboard {
  /** One `Input.dispatchKeyEvent`. */
  key(event: KeyEvent): Promise<void>;
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
  settler: Settler;
  page: PageInfo;
}
