// Narrow page capabilities (design 3.2), built once per `CdpSession` by
// `session/page-driver.ts`. Handlers require them one by one. Ports
// describe what is used: the pointer joined with click (slice 10),
// `insertText` with type (slice 11), the drag input and the CDP event wait
// with drag (slice 14), the navigator, the screen capture and the response
// bodies with navigate, screenshot and network_body (slice 15), the dialog
// input with dialog_respond (slice 16). A port may
// answer the page's reply to the core's own command; it never reports state
// the transport observes on its own (design revision 9).

import type { PageInfo } from './page-info.js';
import type {
  CaptureParams,
  DragEventParams,
  KeyEvent,
  LayoutMetrics,
  MouseEventParams,
  ObserverMarkResult,
  ResponseBody,
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
  /** One `Input.insertText` into whatever has focus; resolves when the page
   * answered it, rejects when the dispatch fails. Input only: what the
   * focused field is, an action reads through the evaluator. */
  insertText(text: string): Promise<void>;
}

export interface Pointer {
  /** One `Input.dispatchMouseEvent`; resolves when the page answered it,
   * rejects when the dispatch fails. Input only: what a dispatch means for
   * a JavaScript dialog is the page driver's business (design revision 8). */
  mouse(event: MouseEventParams): Promise<void>;
}

export interface DragInput {
  /** One `Input.setInterceptDrags`; resolves when the page answered it,
   * rejects when the dispatch fails. */
  interceptDrags(enabled: boolean): Promise<void>;
  /** One `Input.dispatchDragEvent`; resolves when the page answered it,
   * rejects when the dispatch fails. Input only, as `Pointer`. */
  dragEvent(event: DragEventParams): Promise<void>;
}

export interface CdpEvents {
  /** Wait for one event of the session: resolves with the params of the
   * first event named `method` that arrives after the call; with null when
   * none arrives within `timeoutMs` (or when that event carries no params).
   * Never rejects; it stops listening once it settles. A wait the core asks
   * for, as `PageInfo.armLoadWait`: no state the transport keeps is read
   * through it. No predicate until a caller needs one (design revision 9). */
  waitFor(method: string, timeoutMs: number): Promise<unknown>;
}

export interface Navigator {
  /** One `Page.navigate` to `url`; resolves when the page answered it,
   * rejects when the command fails. Input only: waiting for the load is
   * `PageInfo.armLoadWait`. */
  navigate(url: string): Promise<void>;
}

export interface DialogInput {
  /** One `Page.handleJavaScriptDialog`: accept or dismiss the dialog the page
   * shows, with `promptText` only when given; resolves when the page answered
   * it, rejects with the page's error when no dialog is showing. Input only:
   * which dialog is pending is the transport's state (`DialogWatch`). */
  respond(accept: boolean, promptText?: string): Promise<void>;
}

export interface ScreenCapture {
  /** One `Page.getLayoutMetrics`: the page's answer, typed to the fields the
   * screenshot plan reads. A failed command rejects. */
  layoutMetrics(): Promise<LayoutMetrics>;
  /** One `Page.captureScreenshot`: the image the page answers, base64. A
   * failed command rejects. */
  capture(params: CaptureParams): Promise<string>;
}

export interface ResponseBodies {
  /** One `Network.getResponseBody`: the body the page answers for
   * `requestId`; rejects with the page's error when it has none. */
  body(requestId: string): Promise<ResponseBody>;
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
  drag: DragInput;
  events: CdpEvents;
  navigator: Navigator;
  dialog: DialogInput;
  screen: ScreenCapture;
  responses: ResponseBodies;
  settler: Settler;
  page: PageInfo;
}
