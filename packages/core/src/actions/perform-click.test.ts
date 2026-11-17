// performFind and performClick on fakes (slice 10): the error texts both
// transports report, and the order of the pointer steps of a click.
import { describe, expect, test } from 'vitest';
import {
  buildClickAimJs,
  buildClickHitCheckJs,
  buildClickMoveCheckJs,
  buildClickResolveJs,
  buildFindJs,
  buildProgrammaticClickJs,
  HIT_CHECK_DIALOG_NOTE,
  HIT_CHECK_FRAME_NOTE,
} from '../inpage/builders.js';
import { createManualClock } from '../ports/contract/index.js';
import type { Pointer, Settler } from '../ports/page-driver.js';
import type { MouseEventParams } from '../ports/values.js';
import { PROGRAMMATIC_CLICK_NOTE } from '../support/action-results.js';
import { performClick, type ClickDeps } from './perform-click.js';
import { performFind } from './perform-find.js';

const RESOLVE = buildClickResolveJs({ selector: '#go', force: false });
const AIM = buildClickAimJs({ selector: '#go', force: false });
const AIMED = { ok: true, x: 5, y: 6, tag: 'button' };

interface Fake {
  deps: ClickDeps;
  log: string[];
  open: { dialog: boolean };
}

/** A click's world: `answers` per expression; the pointer logs its events. */
function fake(answers: Record<string, unknown>, pressOpensDialog = false): Fake {
  const log: string[] = [];
  const open = { dialog: false };
  const evaluate = <T>(expression: string): Promise<T> => {
    if (expression === buildClickMoveCheckJs()) log.push('move-check');
    if (expression === buildClickHitCheckJs()) log.push('hit-check');
    if (!Object.hasOwn(answers, expression)) return Promise.resolve(true as T);
    const answer = answers[expression];
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer as T);
  };
  const mouse = (events: readonly MouseEventParams[]): Promise<{ dialog: boolean }> => {
    for (const event of events) {
      log.push(event.type);
      if (pressOpensDialog && event.type === 'mousePressed') {
        open.dialog = true;
        return Promise.resolve({ dialog: true });
      }
    }
    return Promise.resolve({ dialog: open.dialog });
  };
  const pointer: Pointer = {
    mouse,
    watchedMove: (event) => mouse([event]),
    dialogOpen: () => open.dialog,
  };
  const settler: Settler = {
    mark: () => Promise.resolve({ kind: 'none' }),
    settle: (settle) => {
      log.push('settle');
      return Promise.resolve(settle ? { settled: true } : undefined);
    },
  };
  return {
    deps: { evaluator: { evaluate }, pointer, settler, clock: createManualClock() },
    log,
    open,
  };
}

describe('performClick', () => {
  test('the press follows the move seen on the target; the landing is read, then settle', async () => {
    const { deps, log } = fake({
      [RESOLVE]: AIMED,
      [AIM]: AIMED,
      [buildClickMoveCheckJs()]: { armed: true, moved: true },
      [buildClickHitCheckJs()]: { armed: true, landed: true },
    });
    expect(await performClick(deps, { selector: '#go', settle_ms: 0 })).toEqual({
      ok: true,
      result: { clicked: '#go', tag: 'button' },
    });
    expect(log).toEqual([
      'mouseMoved',
      'move-check',
      'mousePressed',
      'mouseReleased',
      'hit-check',
      'settle',
    ]);
  });

  test('a press that opens a dialog reports it and skips the landing read and settle', async () => {
    const { deps, log } = fake(
      {
        [RESOLVE]: AIMED,
        [AIM]: AIMED,
        [buildClickMoveCheckJs()]: { armed: true, moved: true },
      },
      true,
    );
    expect(await performClick(deps, { selector: '#go' })).toEqual({
      ok: true,
      result: {
        clicked: '#go',
        tag: 'button',
        hit_check: 'not_verifiable',
        hit_check_note: HIT_CHECK_DIALOG_NOTE,
      },
    });
    expect(log).toEqual(['mouseMoved', 'move-check', 'mousePressed']);
  });

  test('a frame element is clicked without a move check and reported not verifiable', async () => {
    const frame = { ...AIMED, tag: 'iframe', hit_check: 'not_verifiable' };
    const { deps, log } = fake({ [RESOLVE]: frame, [AIM]: frame });
    const outcome = await performClick(deps, { selector: '#go', settle_ms: 0 });
    expect(outcome).toEqual({
      ok: true,
      result: {
        clicked: '#go',
        tag: 'iframe',
        hit_check: 'not_verifiable',
        hit_check_note: HIT_CHECK_FRAME_NOTE,
      },
    });
    expect(log).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased', 'settle']);
  });

  test.each([
    [
      { ok: false, reason: 'not-found', not_walked: 'depth guard' },
      'Element not found: #go (depth guard)',
    ],
    [
      { ok: false, reason: 'occluded', blocker: 'div#modal' },
      'Element covered by div#modal — click the covering element or dismiss it first',
    ],
    [{ ok: false, reason: 'invalid-selector', error: 'bad' }, 'Invalid selector "#go": bad'],
  ])('a resolve failure %j is the error %s, and nothing is dispatched', async (answer, error) => {
    const { deps, log } = fake({ [RESOLVE]: answer });
    expect(await performClick(deps, { selector: '#go' })).toEqual({ ok: false, error });
    expect(log).toEqual([]);
  });

  test('a stale ref reports the ref-stale text', async () => {
    const resolve = buildClickResolveJs({ ref: 'd1:e2', force: false });
    const { deps } = fake({
      [resolve]: { ok: false, reason: 'ref-stale', ref: 'd1:e2', doc_id: 'd1' },
    });
    expect(await performClick(deps, { ref: 'd1:e2' })).toEqual({
      ok: false,
      error: 'ref-stale: d1:e2 not found in document d1: the element is gone, take a new snapshot',
    });
  });

  test('a forced click on a target with no box calls its own click(), no pointer', async () => {
    const resolve = buildClickResolveJs({ selector: '#go', force: true });
    const { deps, log } = fake({
      [resolve]: { ok: true, no_box: true, tag: 'option' },
      [buildProgrammaticClickJs({ selector: '#go' })]: { ok: true },
    });
    expect(await performClick(deps, { selector: '#go', force: true, settle_ms: 0 })).toEqual({
      ok: true,
      result: { clicked: '#go', tag: 'option', programmatic_click: PROGRAMMATIC_CLICK_NOTE },
    });
    expect(log).toEqual(['settle']);
  });

  test('a press seen elsewhere fails the click', async () => {
    const { deps } = fake({
      [RESOLVE]: AIMED,
      [AIM]: AIMED,
      [buildClickMoveCheckJs()]: { armed: true, moved: true },
      [buildClickHitCheckJs()]: { armed: true, landed: false, landed_on: 'div#other' },
    });
    const outcome = await performClick(deps, { selector: '#go' });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? '' : outcome.error).toMatch(/^Click on #go/);
  });

  test('an evaluation that throws is the error text', async () => {
    const { deps } = fake({ [RESOLVE]: new Error('Cannot find context with specified id') });
    expect(await performClick(deps, { selector: '#go' })).toEqual({
      ok: false,
      error: 'Cannot find context with specified id',
    });
  });
});

describe('performFind', () => {
  const evaluator = (answers: Record<string, unknown>) => ({
    evaluator: {
      evaluate: <T>(expression: string): Promise<T> => {
        const answer = answers[expression];
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer as T);
      },
    },
  });

  test('no text, no ref, no key: "find: text required"', async () => {
    expect(await performFind(evaluator({}), { text: '' })).toEqual({
      ok: false,
      error: 'find: text required',
    });
  });

  test('a find by text answers the page result', async () => {
    const js = buildFindJs({ text: 'Go', exact: false, hide_password_values: false });
    expect(
      await performFind(evaluator({ [js]: { matched: true, selector: '#go' } }), { text: 'Go' }),
    ).toEqual({
      ok: true,
      result: { matched: true, selector: '#go' },
    });
  });

  test('a find by a ref the observer cannot resolve reports the observer text', async () => {
    const js = buildFindJs({ ref: 'd1:e2', hide_password_values: false });
    expect(
      await performFind(evaluator({ [js]: { matched: false, reason: 'observer-unavailable' } }), {
        ref: 'd1:e2',
      }),
    ).toEqual({
      ok: false,
      error: 'observer-unavailable: ref d1:e2 cannot be resolved without the page observer',
    });
  });

  test('an evaluation that throws is the error text', async () => {
    const js = buildFindJs({ text: 'Go', exact: false, hide_password_values: false });
    expect(await performFind(evaluator({ [js]: new Error('boom') }), { text: 'Go' })).toEqual({
      ok: false,
      error: 'boom',
    });
  });
});
