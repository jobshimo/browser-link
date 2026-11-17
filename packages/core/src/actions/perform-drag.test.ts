// `performDrag` (slice 14) on an in-memory session: the CDP commands of each
// branch in order, the error texts, the interception switched off again,
// and the `drag` entry through the registry.
import { describe, expect, test } from 'vitest';
import {
  createManualClock,
  createMemoryCdpSession,
  createMemoryPageInfo,
  type ManualClock,
} from '../ports/contract/index.js';
import { createPageDriver } from '../session/page-driver.js';
import { TOOL_REGISTRY } from '../tools/catalog.js';
import { dispatchTool } from '../tools/registry.js';
import type { Requirement, ToolDeps } from '../tools/requirement.js';
import { performDrag, type DragDeps } from './perform-drag.js';

interface Probe {
  err?: string;
  from?: { x: number; y: number; in_viewport: boolean };
  to?: { x: number; y: number; in_viewport: boolean };
  draggable?: boolean;
}

const PROBE: Probe = {
  from: { x: 10, y: 10, in_viewport: true },
  to: { x: 110, y: 10, in_viewport: true },
  draggable: false,
};
const DATA = { items: [{ mimeType: 'text/plain', data: 'card' }], dragOperationsMask: 1 };

interface Page {
  probe?: Probe;
  /** Chrome reports `Input.dragIntercepted` on the first held move. */
  intercepts?: boolean;
  /** `Input.setInterceptDrags` fails. */
  noInterception?: boolean;
  /** The `Input.dispatchDragEvent` of this type fails. */
  failDragEvent?: string;
}

function page(options: Page = {}): { deps: DragDeps; sent: unknown[][]; clock: ManualClock } {
  const clock = createManualClock(1_000);
  const sent: unknown[][] = [];
  let intercepted = false;
  const session = createMemoryCdpSession({
    'Runtime.evaluate': () => ({ result: { value: options.probe ?? PROBE } }),
    'Input.setInterceptDrags': (params) => {
      sent.push(['Input.setInterceptDrags', params]);
      if (options.noInterception) throw new Error("'Input.setInterceptDrags' wasn't found");
      return {};
    },
    'Input.dispatchMouseEvent': (params) => {
      sent.push(['Input.dispatchMouseEvent', params]);
      if (options.intercepts && params.buttons === 1 && !intercepted) {
        intercepted = true;
        queueMicrotask(() => {
          session.emit('Input.dragIntercepted', { data: DATA });
        });
      }
      return {};
    },
    'Input.dispatchDragEvent': (params) => {
      sent.push(['Input.dispatchDragEvent', params]);
      if (params.type === options.failDragEvent) throw new Error('drag event refused');
      return {};
    },
  });
  const driver = createPageDriver({
    session,
    page: createMemoryPageInfo({ url: 'https://t.test/', title: 'T' }, clock),
    clock,
  });
  const { evaluator, pointer, drag, events } = driver;
  return { deps: { evaluator, pointer, drag, events, clock }, sent, clock };
}

/** Run the drag while moving the manual clock, so the intercept wait can expire. */
async function drive<T>(clock: ManualClock, work: Promise<T>): Promise<T> {
  let done = false;
  void work.finally(() => (done = true));
  for (let i = 0; i < 40 && !done; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    await clock.advance(25);
  }
  return work;
}

const mouse = (params: Record<string, unknown>): unknown[] => ['Input.dispatchMouseEvent', params];
const dragEvent = (type: string, x: number, y: number): unknown[] => [
  'Input.dispatchDragEvent',
  { type, x, y, data: DATA },
];
const intercept = (enabled: boolean): unknown[] => ['Input.setInterceptDrags', { enabled }];
const pressed = mouse({ type: 'mousePressed', x: 10, y: 10, button: 'left', clickCount: 1 });
const released = mouse({ type: 'mouseReleased', x: 110, y: 10, button: 'left', clickCount: 1 });
const held = (x: number): unknown[] =>
  mouse({ type: 'mouseMoved', x, y: 10, button: 'left', buttons: 1 });

describe('performDrag', () => {
  test('a source that is not draggable: pointer events with the button held', async () => {
    const { deps, sent } = page();
    const outcome = await performDrag(deps, {
      from_selector: '#card',
      to_selector: '#zone',
      duration_ms: 0,
    });
    expect(sent).toEqual([
      mouse({ type: 'mouseMoved', x: 10, y: 10 }),
      pressed,
      held(110),
      released,
    ]);
    expect(outcome).toEqual({
      ok: true,
      result: {
        from: { x: 10, y: 10, selector: '#card' },
        to: { x: 110, y: 10, selector: '#zone' },
        duration_ms_actual: 0,
        drag_mode: 'pointer',
        interception_attempted: false,
        intercept_received: false,
        events_fired: [],
      },
    });
  });

  test('a draggable source Chrome intercepts: an HTML5 drag with the intercepted data', async () => {
    const { deps, sent, clock } = page({ probe: { ...PROBE, draggable: true }, intercepts: true });
    const outcome = await drive(
      clock,
      performDrag(deps, { from_x: 10, from_y: 10, to_x: 110, to_y: 10, duration_ms: 0 }),
    );
    expect(sent).toEqual([
      intercept(true),
      mouse({ type: 'mouseMoved', x: 10, y: 10 }),
      pressed,
      held(30),
      held(110),
      dragEvent('dragOver', 110, 10),
      dragEvent('dragEnter', 110, 10),
      dragEvent('dragOver', 110, 10),
      dragEvent('drop', 110, 10),
      released,
      intercept(false),
    ]);
    expect(outcome).toMatchObject({
      ok: true,
      result: {
        from: { x: 10, y: 10, selector: null },
        drag_mode: 'html5',
        interception_attempted: true,
        intercept_received: true,
        events_fired: ['Input.dragIntercepted', 'dragOver', 'dragEnter', 'drop'],
      },
    });
  });

  test('a draggable source with no intercept in 250 ms: pointer events from the press', async () => {
    const { deps, sent, clock } = page({ probe: { ...PROBE, draggable: true } });
    const outcome = await drive(
      clock,
      performDrag(deps, { from_selector: '#a', to_selector: '#b', duration_ms: 0 }),
    );
    expect(sent).toEqual([
      intercept(true),
      mouse({ type: 'mouseMoved', x: 10, y: 10 }),
      pressed,
      held(30),
      held(110),
      released,
      intercept(false),
    ]);
    expect(outcome).toMatchObject({
      ok: true,
      result: { drag_mode: 'pointer', interception_attempted: true, intercept_received: false },
    });
  });

  test('interception that cannot be switched on falls back to pointer events', async () => {
    const { deps, sent } = page({ probe: { ...PROBE, draggable: true }, noInterception: true });
    const outcome = await performDrag(deps, {
      from_selector: '#a',
      to_selector: '#b',
      duration_ms: 0,
    });
    expect(sent[0]).toEqual(intercept(true));
    expect(sent.slice(1)).toEqual([
      mouse({ type: 'mouseMoved', x: 10, y: 10 }),
      pressed,
      held(110),
      released,
    ]);
    expect(outcome).toMatchObject({ ok: true, result: { interception_attempted: false } });
  });

  test('a failed command is the error text, and interception is switched off again', async () => {
    const { deps, sent, clock } = page({
      probe: { ...PROBE, draggable: true },
      intercepts: true,
      failDragEvent: 'drop',
    });
    const outcome = await drive(
      clock,
      performDrag(deps, { from_selector: '#a', to_selector: '#b', duration_ms: 0 }),
    );
    expect(outcome).toEqual({ ok: false, error: 'drag event refused' });
    expect(sent.at(-1)).toEqual(intercept(false));
  });

  test('the interpolation steps and holds run on the clock', async () => {
    const { deps, sent, clock } = page();
    const outcome = await drive(
      clock,
      performDrag(deps, {
        from_selector: '#a',
        to_selector: '#b',
        duration_ms: 66,
        hold_before_move_ms: 100,
        hold_before_release_ms: 100,
      }),
    );
    expect(sent.filter((c) => (c[1] as { buttons?: number }).buttons === 1)).toEqual([
      held(60),
      held(110),
    ]);
    // Two holds of 100 ms and two steps of 33 ms, measured on the clock.
    const actual = outcome.ok ? outcome.result.duration_ms_actual : -1;
    expect(actual).toBeGreaterThanOrEqual(266);
  });

  test.each([
    [{ to_selector: '#b' }, 'drag: provide from_selector or both from_x and from_y'],
    [
      { from_x: 1, from_y: -1, to_selector: '#b' },
      'drag: provide from_selector or both from_x and from_y',
    ],
    [{ from_selector: '#a', to_x: 1 }, 'drag: provide to_selector or both to_x and to_y'],
  ])('missing endpoints %j: %s, before the page is read', async (params, error) => {
    const { deps, sent } = page();
    expect(await performDrag(deps, params)).toEqual({ ok: false, error });
    expect(sent).toEqual([]);
  });

  test.each([
    [{ err: 'from_selector not found: #a' }, 'drag: from_selector not found: #a'],
    [{ from: PROBE.from }, 'drag: could not resolve coordinates'],
    [
      { ...PROBE, from: { x: 1, y: 1, in_viewport: false } },
      'drag: source point is offscreen — scroll first or pass viewport coords',
    ],
    [
      { ...PROBE, to: { x: 1, y: 1, in_viewport: false } },
      'drag: destination point is offscreen — scroll first or pass viewport coords',
    ],
  ])('a probe answering %j fails with %s', async (probe, error) => {
    const { deps, sent } = page({ probe });
    expect(await performDrag(deps, { from_selector: '#a', to_selector: '#b' })).toEqual({
      ok: false,
      error,
    });
    expect(sent).toEqual([]);
  });
});

describe('the drag entry through the registry', () => {
  const toolDeps = (deps: DragDeps): ToolDeps =>
    ({ ...deps, 'cdp-events': deps.events }) as unknown as ToolDeps;

  test('a transport that does not provide `drag` is refused before the page is read', async () => {
    const { deps, sent } = page();
    const provided = new Set<Requirement>([
      'evaluator',
      'keyboard',
      'pointer',
      'settler',
      'cdp-events',
    ]);
    expect(
      await dispatchTool(TOOL_REGISTRY, provided, toolDeps(deps), 'cdp-direct', 'drag', {
        from_selector: '#a',
        to_selector: '#b',
      }),
    ).toEqual({ ok: false, failure: { kind: 'unsupported', tool: 'drag', missing: ['drag'] } });
    expect(sent).toEqual([]);
  });

  test('a transport that provides it runs the drag with the params read by typeof', async () => {
    const { deps } = page();
    const provided = new Set<Requirement>(['evaluator', 'pointer', 'drag', 'cdp-events']);
    expect(
      await dispatchTool(TOOL_REGISTRY, provided, toolDeps(deps), 'extension', 'drag', {
        from_selector: '#a',
        to_selector: 7,
        to_x: 110,
        to_y: '10',
      }),
    ).toEqual({
      ok: false,
      failure: { kind: 'action', message: 'drag: provide to_selector or both to_x and to_y' },
    });
  });
});
