// The value types the ports speak, declared here so `ports` imports nothing
// in core (5.2). They were copied as they were from the extension's
// settle.ts (`SettleParams`, `EvaluateFn`) and observer-host.ts
// (`ObserverMark`); slice 7 deleted those originals and re-pointed
// `support/` at these. Slice 9 added the values the page driver and
// `PageInfo` speak (design revision 7), below `ObserverMark`.

import type { SettleChanges } from '@browser-link/shared';

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
