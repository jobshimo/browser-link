// GENERATED from packages/core/src/actions/click-landing.ts. Do not edit.
/**
 * Where a pointer click lands: the move that must be seen on the target
 * before the press is sent, and the read of where the press landed. Moved
 * in slice 10 from `background.ts` and `cdp/transport.ts` (`moveOntoTarget`,
 * `readMoveCheck`, `checkClickLanding`, `pointerPressEvents`,
 * `dispatchPointerPress`); what differed between the two copies (dialogs,
 * the bound on the move dispatch) is the `Pointer` of each transport.
 */
import {
  buildClickHitCheckJs,
  buildClickMoveCheckJs,
  CLICK_MOVE_TRIES,
  type ClickHitCheck,
  type ClickMoveCheck,
  type ClickMoveMiss,
  HIT_CHECK_DIALOG_NOTE,
  HIT_CHECK_FRAME_NOTE,
  HIT_CHECK_NO_ANSWER_NOTE,
  HIT_CHECK_REPLACED_NOTE,
  HIT_CHECK_TIMEOUT_MS,
} from '../inpage/builders.js';
import type { Clock } from '../ports/clock.js';
import type { Evaluator, Pointer } from '../ports/page-driver.js';
import type { MouseEventParams } from '../ports/values.js';

/** What the landing checks use: the page, the pointer and the time. */
export interface LandingDeps {
  evaluator: Evaluator;
  pointer: Pointer;
  clock: Clock;
}

/** The press and release of a pointer click at (x, y); the move that
 * precedes them is sent by `moveOntoTarget`. */
function pointerPressEvents(x: number, y: number): MouseEventParams[] {
  return [
    { type: 'mousePressed', x, y, button: 'left', clickCount: 1 },
    { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 },
  ];
}

/** Dispatch the press and release of a pointer click (see `Pointer.mouse`). */
export function dispatchPointerPress(
  pointer: Pointer,
  x: number,
  y: number,
): Promise<{ dialog: boolean }> {
  return pointer.mouse(pointerPressEvents(x, y));
}

/**
 * Read the move half of the click's hit watch (`buildClickMoveCheckJs`),
 * bounded by `timeoutMs`. `'dialog'` when a JavaScript dialog is open (the
 * page is paused); `'no-answer'` when the check threw, timed out or
 * answered nothing usable.
 */
async function readMoveCheck(
  { evaluator, pointer, clock }: LandingDeps,
  timeoutMs: number,
): Promise<ClickMoveCheck | 'dialog' | 'no-answer'> {
  if (pointer.dialogOpen()) return 'dialog';
  let cancel: () => void = () => undefined;
  const late = new Promise<undefined>((resolve) => {
    cancel = clock.after(timeoutMs, () => {
      resolve(undefined);
    });
  });
  let check: unknown;
  try {
    check = await Promise.race([evaluator.evaluate(buildClickMoveCheckJs()), late]);
  } catch {
    check = undefined;
  } finally {
    cancel();
  }
  if (pointer.dialogOpen()) return 'dialog';
  return check &&
    typeof check === 'object' &&
    typeof (check as { armed?: unknown }).armed === 'boolean'
    ? (check as ClickMoveCheck)
    : 'no-answer';
}

/**
 * Move the mouse to the click point and, when the target is watched, wait
 * until the move was seen on it (`buildClickMoveCheckJs`) before the press
 * is sent. Right after a scroll the browser can still route input by the
 * frame it drew before, into whatever was under that point then (another
 * frame, possibly a cross-origin one); the move shows where input goes now,
 * so it is sent again one animation frame later, up to `CLICK_MOVE_TRIES`
 * times and within `HIT_CHECK_TIMEOUT_MS` overall (moves and checks
 * together, so a slow page cannot stretch the tries to one timeout each).
 *
 * Fails closed: `miss` (see `ClickMoveMiss`) means the move was not
 * confirmed — never seen on the target, seen elsewhere, the check did not
 * answer, or the watch was gone (the document was replaced, so the aimed
 * point is stale) — and the caller sends no press. `tries` counts the moves
 * sent.
 *
 * Not checked: a frame element (`watched: false`), whose events go into the
 * document inside it, where the move cannot be watched; its press follows
 * the move as before and the click reports `hit_check: 'not_verifiable'`.
 * A JavaScript dialog opened by a move answers `dialog: true`: nothing is
 * pressed and the click reports it, as before.
 */
export async function moveOntoTarget(
  deps: LandingDeps,
  x: number,
  y: number,
  watched: boolean,
): Promise<{ dialog: boolean; tries: number; miss?: ClickMoveMiss }> {
  const { pointer, clock } = deps;
  const move: MouseEventParams = { type: 'mouseMoved', x, y };
  if (!watched) return { ...(await pointer.mouse([move])), tries: 1 };
  const deadline = clock.now() + HIT_CHECK_TIMEOUT_MS;
  let last: ClickMoveMiss = { why: 'not-seen' };
  let answered = false;
  // A check that does not answer after others did ran out of the budget:
  // report what the answers said; with no answer at all, say so.
  const noAnswer = (): ClickMoveMiss => (answered ? last : { why: 'no-answer' });
  let tries = 0;
  while (tries < CLICK_MOVE_TRIES) {
    const left = deadline - clock.now();
    if (left <= 0) break;
    tries++;
    const sent = await pointer.watchedMove(move, left);
    if (sent === 'unanswered') return { dialog: false, tries, miss: noAnswer() };
    if (sent.dialog) return { dialog: true, tries };
    const check = await readMoveCheck(deps, Math.max(1, deadline - clock.now()));
    if (check === 'dialog') return { dialog: true, tries };
    if (check === 'no-answer') return { dialog: false, tries, miss: noAnswer() };
    if (!check.armed) return { dialog: false, tries, miss: { why: 'replaced' } };
    if (check.moved) return { dialog: false, tries };
    answered = true;
    last =
      typeof check.moved_on === 'string'
        ? { why: 'elsewhere', moved_on: check.moved_on }
        : { why: 'not-seen' };
  }
  return { dialog: false, tries, miss: last };
}

/**
 * Read the hit watch of a pointer click (`buildClickHitCheckJs`), bounded by
 * `HIT_CHECK_TIMEOUT_MS` (a JavaScript dialog pauses the page). Answers
 * `missed` (with `landed_on` when the press reached another element) only
 * when the watch saw the press elsewhere or saw none; otherwise `note` says
 * why the landing could not be verified, or nothing when it landed.
 */
export async function checkClickLanding(
  { evaluator, pointer, clock }: LandingDeps,
  frameElement: boolean,
): Promise<{ missed?: true; landed_on?: string; note?: string }> {
  if (frameElement) return { note: HIT_CHECK_FRAME_NOTE };
  if (pointer.dialogOpen()) return { note: HIT_CHECK_DIALOG_NOTE };
  let cancel: () => void = () => undefined;
  const late = new Promise<'timeout'>((resolve) => {
    cancel = clock.after(HIT_CHECK_TIMEOUT_MS, () => {
      resolve('timeout');
    });
  });
  let landing: unknown;
  try {
    landing = await Promise.race([evaluator.evaluate(buildClickHitCheckJs()), late]);
  } catch {
    landing = undefined;
  } finally {
    cancel();
  }
  if (pointer.dialogOpen()) return { note: HIT_CHECK_DIALOG_NOTE };
  if (landing === 'timeout') return { note: HIT_CHECK_NO_ANSWER_NOTE };
  const check = landing as Partial<ClickHitCheck> | undefined;
  if (!check || typeof check !== 'object' || check.armed !== true) {
    return { note: HIT_CHECK_REPLACED_NOTE };
  }
  if ('landed' in check && check.landed === true) return {};
  const landedOn = (check as { landed_on?: unknown }).landed_on;
  return typeof landedOn === 'string' ? { missed: true, landed_on: landedOn } : { missed: true };
}
