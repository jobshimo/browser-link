// GENERATED from packages/core/src/ports/values.ts. Specifiers rewritten. Do not edit.
// The value types the ports speak, declared here so `ports` imports nothing
// in core (5.2). They were copied as they were from the extension's
// settle.ts (`SettleParams`, `EvaluateFn`) and observer-host.ts
// (`ObserverMark`); slice 7 deleted those originals and re-pointed
// `support/` at these. Slice 9 added the values the page driver and
// `PageInfo` speak (design revision 7), below `ObserverMark`.

import type { SettleChanges } from '../../shared/index.js';

export interface SettleParams {
  settleMs: number;
  settleTimeoutMs: number;
}

/** Evaluate-in-page function shape settleSafely needs — the caller passes
 * a closure over its own evaluate primitive: `(expr) =>
 * evaluateInTab(tabId, expr)` in the extension, `(expr) =>
 * evaluateInTab(client, expr)` on the server. */
export type EvaluateFn = (expression: string) => Promise<unknown>;

/** The part of an action mark (`buildObserverMarkJs`) the changes read needs. */
export interface ObserverMark {
  mark: number;
  doc_id: string;
}

/** Why an action reports no observer changes (`settle.observer`): the
 * observer was never installed or gave no mark, the document changed under
 * the action, or the changes read answered something unusable. */
export type ObserverFailure = 'observer-unavailable' | 'doc-changed' | 'changes-error';

/** The page observer's action mark, taken before an action dispatches
 * (`Settler.mark`): `none` when settle is off for the call, `unavailable`
 * with the reason the observer gave no usable mark, or `marked`. */
export type ObserverMarkResult =
  | { kind: 'none' }
  | { kind: 'unavailable'; reason: ObserverFailure }
  | { kind: 'marked'; mark: ObserverMark };

/** What one settle wait reports, as it reaches the wire under `settle`: the
 * fields the in-page wait answers (`inpage/builders.ts` `buildSettleJs`, or
 * the degraded `{ settled: false, reason }` of `settleSafely`), plus the
 * observer's `changes` or the `observer` failure. Absent fields stay absent.
 * A type alias (not an interface), so it is assignable to the plain object
 * the results carry. */
export type SettleReport = {
  settled?: boolean;
  reason?: 'context-destroyed' | 'settle-error';
  duration_ms?: number;
  mutation_count?: number;
  url_changed?: string;
  focus_moved?: true;
  unobserved?: { cross_origin_frames?: number; shadow_roots?: 'open-only'; hint?: string };
  changes?: SettleChanges | null;
  observer?: ObserverFailure;
};

/** One CDP `Input.dispatchKeyEvent` payload (`Keyboard.key`); the support
 * module `keymap.ts` builds them (`CdpKeyEvent`, the same shape). */
export type KeyEvent = {
  type: 'keyDown' | 'rawKeyDown' | 'char' | 'keyUp';
  modifiers: number;
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  nativeVirtualKeyCode: number;
  text?: string;
  unmodifiedText?: string;
};

/** One CDP `Input.dispatchMouseEvent` payload (`Pointer.mouse`): the move,
 * press and release of a click (slice 10) and of a drag, whose moves hold
 * the left button (`buttons: 1`, slice 14). A type alias, so it is
 * assignable to the plain params object `CdpSession.send` takes. */
export type MouseEventParams = {
  type: 'mouseMoved' | 'mousePressed' | 'mouseReleased';
  x: number;
  y: number;
  button?: 'left';
  buttons?: number;
  clickCount?: number;
};

/** One CDP `Input.dispatchDragEvent` payload (`DragInput.dragEvent`, slice
 * 14). `data` is the `DragData` of the `Input.dragIntercepted` event, passed
 * through unchanged. */
export type DragEventParams = {
  type: 'dragEnter' | 'dragOver' | 'drop';
  x: number;
  y: number;
  data: unknown;
};

/** A load wait armed before the navigation is sent (`PageInfo.armLoadWait`):
 * `done` resolves when the page reports load complete and rejects when the
 * timeout passes first; `cancel` releases the wait, after which `done`
 * never settles. */
export interface LoadWait {
  done: Promise<void>;
  cancel(): void;
}

/** The `Page.getLayoutMetrics` answer, only the fields the screenshot plan
 * reads (`ScreenCapture.layoutMetrics`, slice 15): content size and visual
 * viewport in CSS and device pixels, and the layout viewport width in both,
 * whose ratio is the device pixel ratio. */
export interface LayoutMetrics {
  cssContentSize?: { width: number; height: number };
  contentSize?: { width: number; height: number };
  cssVisualViewport?: { pageX: number; pageY: number; clientWidth: number; clientHeight: number };
  visualViewport?: { pageX: number; pageY: number; clientWidth: number; clientHeight: number };
  layoutViewport?: { clientWidth: number };
  cssLayoutViewport?: { clientWidth: number };
}

/** One `Page.captureScreenshot` request (`ScreenCapture.capture`, slice 15):
 * the clip in CSS pixels with its scale, and `quality` for a jpeg only. A
 * type alias, so it is assignable to the plain params object
 * `CdpSession.send` takes. */
export type CaptureParams = {
  format: 'png' | 'jpeg';
  captureBeyondViewport: boolean;
  clip: { x: number; y: number; width: number; height: number; scale: number };
  quality?: number;
};

/** The body of one captured response (`ResponseBodies.body`, slice 15), as
 * the page answers it: base64 when `base64Encoded`. */
export type ResponseBody = {
  body: string;
  base64Encoded: boolean;
};

/** A download a capture holds (`Downloads.captureAround`, slice 16), as the
 * transport's download capture reports it; the `download` tool hands every
 * field to the server, which fetches the bytes and settles the hold. */
export interface CapturedDownload {
  /** The browser's id of the held download: the server hands it back to `settle`. */
  download_id: number;
  /** Where the bytes actually come from (after redirects, when the browser knows). */
  url: string;
  original_url: string;
  /** The browser's suggested name: the server sanitizes it to a basename. */
  filename: string;
  mime: string;
  /** The browser's total size, or null when it does not know it. The server
   * compares its re-fetch with this, the type and the URL before the
   * browser's copy may be erased (D17). No request method is reported, so
   * none is sent; the server reads a missing method as unknown. */
  total_bytes: number | null;
}

/**
 * How a capture's wait ended:
 *   - `captured`: the tab's download, held until `settle`.
 *   - `unattributed`: at least one download appeared in the browser during
 *     the wait but none could be tied to the tab with certainty; all were left
 *     alone.
 *   - `timeout`: no download appeared in the browser during the wait.
 */
export type CaptureOutcome =
  | { state: 'captured'; download: CapturedDownload }
  | { state: 'unattributed' }
  | { state: 'timeout' };

/**
 * What happened to the browser's own download after `Downloads.settle` (the
 * `download_settle` result field keeps its published name, `chrome_download`,
 * and its values):
 *   - `removed`: cancelled and erased from the browser's list (only after the
 *     file was saved).
 *   - `cancelled`: cancelled, but the erase failed: the browser's list shows
 *     it as cancelled.
 *   - `left_in_chrome`: the capture held it and released it untouched
 *     (nothing saved, the cancel failed, or an identical download appeared);
 *     the browser carries on with it.
 *   - `not_held`: the capture holds no such download (unknown id, already
 *     settled, or its hold expired and it was released). What became of the
 *     browser's copy is not known there. An older server reads the value as
 *     unknown, which is the same answer.
 */
export type DownloadSettleOutcome = 'removed' | 'cancelled' | 'left_in_chrome' | 'not_held';

/** What the action run inside a capture answered: a failed action ends the
 * capture with its error text. */
export type CaptureActOutcome = { ok: true } | { ok: false; error: string };

/** A capture's answer: how its wait ended, or the failed action's error. */
export type CaptureAroundResult =
  { ok: true; outcome: CaptureOutcome } | { ok: false; error: string };
