/**
 * `browser.drag`: the body both the standalone tool (`tools/drag.ts`) and a
 * flow's drag step call. Moved in slice 14 from `background.ts`, where it was
 * extension-only. Both transports provide the `drag` requirement (cdp-direct
 * since 1.4.36) and bind this body for the standalone tool and a flow step.
 *
 * The endpoints are resolved in the page (`buildDragProbeJs`). A draggable
 * source is tried as an HTML5 drag first: drag interception is switched on,
 * and when Chrome reports `Input.dragIntercepted` after the press and a
 * wiggle, the drag runs through `Input.dispatchDragEvent` with the data that
 * event carried; otherwise (no interception, or no event within
 * `INTERCEPT_TIMEOUT_MS`) it runs as pointer events with the left button held.
 * Interception is always switched off again. Every CDP command, its params
 * and its order are the ones `background.ts` sent before slice 14.
 */
import { buildDragProbeJs } from '../inpage/builders.js';
import type { Clock } from '../ports/clock.js';
import type { CdpEvents, DragInput, Evaluator, Pointer } from '../ports/page-driver.js';
import type { ActionOutcome, DragStepResult } from '../support/action-results.js';

/** The params of one drag (the standalone tool's, minus `tab_id`; a flow's
 * drag step has the same shape): each endpoint is a CSS selector OR a
 * viewport coordinate pair, plus the interpolation and hold options. */
export interface DragParams {
  from_selector?: string;
  from_x?: number;
  from_y?: number;
  to_selector?: string;
  to_x?: number;
  to_y?: number;
  duration_ms?: number;
  hold_before_move_ms?: number;
  hold_before_release_ms?: number;
}

/** What a drag uses: the probe, the mouse, the drag input, the wait for
 * `Input.dragIntercepted`, and the time. */
export interface DragDeps {
  evaluator: Evaluator;
  pointer: Pointer;
  drag: DragInput;
  events: CdpEvents;
  clock: Clock;
}

/**
 * Defensive caps applied to every duration that ends up in a timer driven
 * by tool params. The MCP request payload is untrusted input, so CodeQL
 * flags unbounded user-controlled timer durations as a resource-exhaustion
 * risk. The params are clamped here AND each pause sits inside a literal
 * range check (`pause`), so the property holds even if a future call site
 * forgets to validate.
 */
export const MAX_DRAG_DURATION_MS = 60_000;
export const MAX_DRAG_HOLD_MS = 10_000;

/** Wiggle distance has to comfortably clear `kDragThreshold` (~5px on Mac,
 * 4px on Linux/Windows). 5px landed *right* at the boundary and Chrome did
 * not start the drag — 20px crosses it on every platform. */
const WIGGLE_PX = 20;

/** Time to wait for `Input.dragIntercepted` after the wiggle. 120ms was
 * enough on local-only synthetic tests but flaky in real Chrome — 250ms is
 * comfortable without dragging out the overall latency. */
const INTERCEPT_TIMEOUT_MS = 250;

/** `clock.sleep` inside a literal range check (CodeQL's range-branch
 * sanitizer for js/resource-exhaustion); out of range it sleeps 0 ms. */
function pause(clock: Clock, ms: number): Promise<void> {
  return clock.sleep(typeof ms === 'number' && ms > 0 && ms < 60_000 ? ms : 0);
}

interface DragProbe {
  err?: string;
  from?: { x: number; y: number; in_viewport: boolean };
  to?: { x: number; y: number; in_viewport: boolean };
  draggable?: boolean;
}

export async function performDrag(
  { evaluator, pointer, drag, events, clock }: DragDeps,
  params: DragParams,
): Promise<ActionOutcome<DragStepResult>> {
  try {
    // Anything non-finite or negative is treated as absent, so flow drag
    // steps get the same protection as the standalone tool.
    const num = (v: number | undefined): number | undefined =>
      typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
    const clamp = (v: number, max: number): number => Math.min(v, max);
    const fromSelector = params.from_selector;
    const toSelector = params.to_selector;
    const fromXRaw = num(params.from_x);
    const fromYRaw = num(params.from_y);
    const toXRaw = num(params.to_x);
    const toYRaw = num(params.to_y);
    // Cap every duration that ends up in a timer, so a misbehaving agent
    // cannot park the bridge for hours on a typo.
    const durationMs = clamp(num(params.duration_ms) ?? 1500, MAX_DRAG_DURATION_MS);
    const holdBeforeMoveMs = clamp(num(params.hold_before_move_ms) ?? 0, MAX_DRAG_HOLD_MS);
    const holdBeforeReleaseMs = clamp(num(params.hold_before_release_ms) ?? 0, MAX_DRAG_HOLD_MS);

    const hasFromCoords = fromXRaw !== undefined && fromYRaw !== undefined;
    const hasToCoords = toXRaw !== undefined && toYRaw !== undefined;
    if (!fromSelector && !hasFromCoords) {
      return { ok: false, error: 'drag: provide from_selector or both from_x and from_y' };
    }
    if (!toSelector && !hasToCoords) {
      return { ok: false, error: 'drag: provide to_selector or both to_x and to_y' };
    }

    const probe = await evaluator.evaluate<DragProbe>(
      buildDragProbeJs({
        from_selector: fromSelector,
        to_selector: toSelector,
        from_x: fromXRaw,
        from_y: fromYRaw,
        to_x: toXRaw,
        to_y: toYRaw,
      }),
    );
    if (probe.err) {
      return { ok: false, error: `drag: ${probe.err}` };
    }
    if (!probe.from || !probe.to) {
      return { ok: false, error: 'drag: could not resolve coordinates' };
    }
    if (!probe.from.in_viewport) {
      return {
        ok: false,
        error: 'drag: source point is offscreen — scroll first or pass viewport coords',
      };
    }
    if (!probe.to.in_viewport) {
      return {
        ok: false,
        error: 'drag: destination point is offscreen — scroll first or pass viewport coords',
      };
    }

    const fromX = probe.from.x;
    const fromY = probe.from.y;
    const toX = probe.to.x;
    const toY = probe.to.y;
    const isDraggable = !!probe.draggable;

    // ~30fps interpolation; minimum 2 steps so the path actually has a midpoint.
    const steps = durationMs > 0 ? Math.max(2, Math.round(durationMs / 33)) : 1;
    const stepDelayMs = steps > 0 ? durationMs / steps : 0;
    const eventsFired: string[] = [];
    // Every branch below reassigns `dragMode` before the final `return` reads it.
    let dragMode: 'html5' | 'pointer' = 'pointer';
    let interceptReceived = false;
    const dragStart = clock.now();
    let interceptionEnabled = false;

    const interpolate = (t: number): { x: number; y: number } => ({
      x: fromX + (toX - fromX) * t,
      y: fromY + (toY - fromY) * t,
    });

    // Mouse move WITH the left button held down. Chrome's HTML5 drag
    // system only treats movement as a drag when the button state is
    // signalled on every move after mousePressed; omitting it makes
    // Blink ignore the move for drag-detection purposes.
    const moveHeld = (x: number, y: number): Promise<void> =>
      pointer.mouse({ type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
    const press = (): Promise<void> =>
      pointer.mouse({ type: 'mousePressed', x: fromX, y: fromY, button: 'left', clickCount: 1 });
    const release = (): Promise<void> =>
      pointer.mouse({ type: 'mouseReleased', x: toX, y: toY, button: 'left', clickCount: 1 });

    try {
      if (isDraggable) {
        try {
          await drag.interceptDrags(true);
          interceptionEnabled = true;
        } catch {
          // setInterceptDrags is experimental — fall back to pointer mode silently.
        }
      }

      if (interceptionEnabled) {
        // Arm the wait BEFORE the press+wiggle that may trigger it.
        const interceptPromise = events.waitFor('Input.dragIntercepted', INTERCEPT_TIMEOUT_MS);
        await pointer.mouse({ type: 'mouseMoved', x: fromX, y: fromY });
        await press();
        if (holdBeforeMoveMs > 0) await pause(clock, holdBeforeMoveMs);
        // Wiggle toward the destination so Chrome's native drag system
        // crosses its activation threshold. Direction matters for libs
        // that have direction-sensitive activation constraints.
        const dx = toX - fromX;
        const dy = toY - fromY;
        const len = Math.hypot(dx, dy) || 1;
        const wx = fromX + (dx / len) * WIGGLE_PX;
        const wy = fromY + (dy / len) * WIGGLE_PX;
        await moveHeld(wx, wy);

        const intercepted = (await interceptPromise) as { data: unknown } | null;
        if (intercepted) {
          dragMode = 'html5';
          interceptReceived = true;
          eventsFired.push('Input.dragIntercepted');
          const dragData = intercepted.data;
          for (let i = 1; i <= steps; i++) {
            const t = i / steps;
            const { x, y } = interpolate(t);
            await moveHeld(x, y);
            await drag.dragEvent({ type: 'dragOver', x, y, data: dragData });
            if (i === 1) eventsFired.push('dragOver');
            if (stepDelayMs > 0) await pause(clock, stepDelayMs);
          }
          await drag.dragEvent({ type: 'dragEnter', x: toX, y: toY, data: dragData });
          eventsFired.push('dragEnter');
          await drag.dragEvent({ type: 'dragOver', x: toX, y: toY, data: dragData });
          if (holdBeforeReleaseMs > 0) await pause(clock, holdBeforeReleaseMs);
          await drag.dragEvent({ type: 'drop', x: toX, y: toY, data: dragData });
          eventsFired.push('drop');
          await release();
        } else {
          // Element was tagged draggable but no native drag fired — the page
          // either preventDefault'd dragstart or wires its own pointer logic.
          // Continue with pointer-only events from where we already pressed.
          dragMode = 'pointer';
          for (let i = 1; i <= steps; i++) {
            const t = i / steps;
            const { x, y } = interpolate(t);
            await moveHeld(x, y);
            if (stepDelayMs > 0) await pause(clock, stepDelayMs);
          }
          if (holdBeforeReleaseMs > 0) await pause(clock, holdBeforeReleaseMs);
          await release();
        }
      } else {
        // Pointer-only branch: no native drag involvement at all.
        dragMode = 'pointer';
        await pointer.mouse({ type: 'mouseMoved', x: fromX, y: fromY });
        await press();
        if (holdBeforeMoveMs > 0) await pause(clock, holdBeforeMoveMs);
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          const { x, y } = interpolate(t);
          await moveHeld(x, y);
          if (stepDelayMs > 0) await pause(clock, stepDelayMs);
        }
        if (holdBeforeReleaseMs > 0) await pause(clock, holdBeforeReleaseMs);
        await release();
      }
    } finally {
      // Critical: leaving interception on would block the human user from
      // dragging anything in this tab. Best-effort cleanup, swallow errors.
      if (interceptionEnabled) {
        try {
          await drag.interceptDrags(false);
        } catch {
          // ignore
        }
      }
    }

    return {
      ok: true,
      result: {
        from: { x: fromX, y: fromY, selector: fromSelector ?? null },
        to: { x: toX, y: toY, selector: toSelector ?? null },
        duration_ms_actual: clock.now() - dragStart,
        drag_mode: dragMode,
        interception_attempted: interceptionEnabled,
        intercept_received: interceptReceived,
        events_fired: eventsFired,
      },
    };
  } catch (err) {
    // A thrown error (a failed CDP command, a probe exception) is the
    // action's error text: the standalone tool reported this exact
    // `err.message` before it had a perform* function.
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
