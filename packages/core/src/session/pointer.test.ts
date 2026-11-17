// The page driver's mouse (slice 10, design revision 8): the input-only
// Pointer contract on an in-memory session and its RED probes, and the
// driver-level operations that race each event against the dialog watch or
// bound a watched move by its budget, on a manual clock.
import { describe, expect, it, test } from 'vitest';
import {
  createManualClock,
  createMemoryCdpSession,
  createMemoryPageInfo,
  definePointerContract,
  type ContractCase,
  type ManualClock,
  type PointerHarness,
} from '../ports/contract/index.js';
import type { Pointer } from '../ports/page-driver.js';
import type { MouseEventParams } from '../ports/values.js';
import {
  createPageDriver,
  dialogOpen,
  dispatchMouseEvents,
  dispatchWatchedMove,
  type DialogWatch,
  type MouseDeps,
} from './page-driver.js';

type Dispatch = (event: MouseEventParams) => unknown;

/** A driver's mouse deps over an in-memory session answering `dispatch`. */
function mouseOn(
  dispatch: Dispatch,
  options: { dialogs?: DialogWatch; clock?: ManualClock } = {},
): MouseDeps {
  const clock = options.clock ?? createManualClock();
  const session = createMemoryCdpSession({
    'Input.dispatchMouseEvent': (params) => dispatch(params as MouseEventParams),
  });
  const page = createMemoryPageInfo({ url: 'https://t.test/', title: 'T' }, clock);
  const driver = createPageDriver({ session, page, clock, dialogs: options.dialogs });
  return { pointer: driver.pointer, clock, dialogs: driver.dialogs };
}

const WHEEL_REFUSED = "'deltaX' and 'deltaY' are expected for mouseWheel event";

function harness(): PointerHarness {
  const received: string[] = [];
  const { pointer } = mouseOn((event) => {
    if ((event.type as string) === 'mouseWheel') throw new Error(WHEEL_REFUSED);
    received.push(event.type);
    return {};
  });
  return {
    pointer,
    at: { x: 10, y: 20 },
    received: () => Promise.resolve([...received]),
    failing: {
      event: { type: 'mouseWheel', x: 10, y: 20 } as unknown as MouseEventParams,
      message: WHEEL_REFUSED,
    },
  };
}

function run(cases: ContractCase[]): void {
  for (const contractCase of cases) it(contractCase.name, () => contractCase.run());
}

const closed: DialogWatch = { isOpen: () => false };
const MOVE: MouseEventParams = { type: 'mouseMoved', x: 1, y: 2 };
const PRESS: MouseEventParams = { type: 'mousePressed', x: 1, y: 2, button: 'left', clickCount: 1 };
const RELEASE: MouseEventParams = { ...PRESS, type: 'mouseReleased' };
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('Pointer contract: page driver on an in-memory session', () => {
  run(definePointerContract(harness));
});

describe('the Pointer contract catches a broken pointer (RED probes)', () => {
  const caseNamed = (cases: ContractCase[], name: string): ContractCase => {
    const found = cases.find((c) => c.name === name);
    if (!found) throw new Error(`no contract case named ${name}`);
    return found;
  };

  it('a pointer that resolves before the event was dispatched', async () => {
    const cases = definePointerContract(() => {
      const h = harness();
      const pointer: Pointer = {
        mouse: (event) => {
          setTimeout(() => void h.pointer.mouse(event), 5);
          return Promise.resolve();
        },
      };
      return { ...h, pointer };
    });
    await expect(
      caseNamed(cases, 'mouse resolves once the page received the event').run(),
    ).rejects.toThrow(/events/);
  });

  it('a pointer that swallows a failed dispatch', async () => {
    const cases = definePointerContract(() => {
      const h = harness();
      const pointer: Pointer = { mouse: (event) => h.pointer.mouse(event).catch(() => undefined) };
      return { ...h, pointer };
    });
    await expect(
      caseNamed(cases, 'a failed dispatch rejects with the CDP error message unchanged').run(),
    ).rejects.toThrow(/error message/);
  });
});

describe('with a dialog watch (the extension, as before slice 10)', () => {
  test('a dialog opened while an event waits answers dialog: true and sends nothing after it', async () => {
    const clock = createManualClock();
    let open = false;
    const sent: string[] = [];
    const deps = mouseOn(
      (event) => {
        sent.push(event.type);
        // The page is paused: the event that opened the dialog is not answered.
        return new Promise(() => undefined);
      },
      { dialogs: { isOpen: () => open }, clock },
    );
    let answer: unknown = 'pending';
    void dispatchMouseEvents(deps, [PRESS, RELEASE]).then((a) => (answer = a));
    await tick();
    await clock.advance(100);
    expect(answer).toBe('pending');
    open = true;
    // The watch is polled every 50 ms of the clock.
    await clock.advance(50);
    await tick();
    expect(answer).toEqual({ dialog: true });
    expect(sent).toEqual(['mousePressed']);
    expect(dialogOpen(deps)).toBe(true);
  });

  test('events answered in turn report whether a dialog is open after them', async () => {
    const sent: string[] = [];
    const deps = mouseOn(
      (event) => {
        sent.push(event.type);
        return {};
      },
      { dialogs: closed },
    );
    expect(await dispatchMouseEvents(deps, [MOVE, PRESS, RELEASE])).toEqual({ dialog: false });
    expect(sent).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);
  });

  test('a failed dispatch rejects with its error, and so does a watched move', async () => {
    const deps = mouseOn(
      () => {
        throw new Error('Debugger is not attached');
      },
      { dialogs: closed },
    );
    await expect(dispatchMouseEvents(deps, [MOVE])).rejects.toThrow('Debugger is not attached');
    await expect(dispatchWatchedMove(deps, MOVE, 10)).rejects.toThrow('Debugger is not attached');
  });

  test('a watched move is not bounded by its budget', async () => {
    const clock = createManualClock();
    let answer: (v: unknown) => void = () => undefined;
    const deps = mouseOn(() => new Promise((resolve) => (answer = resolve)), {
      dialogs: closed,
      clock,
    });
    let outcome: unknown = 'pending';
    void dispatchWatchedMove(deps, MOVE, 10).then((o) => (outcome = o));
    await tick();
    await clock.advance(500);
    expect(outcome).toBe('pending');
    answer({});
    await tick();
    expect(outcome).toEqual({ dialog: false });
  });
});

describe('without a dialog watch (cdp-direct, as before slice 10)', () => {
  test('events are awaited in turn; a failed dispatch rejects with its error', async () => {
    const sent: string[] = [];
    const deps = mouseOn((event) => {
      sent.push(event.type);
      if (event.type === 'mouseReleased') throw new Error('cdp-direct: client is not connected');
      return {};
    });
    await expect(dispatchMouseEvents(deps, [MOVE, PRESS, RELEASE])).rejects.toThrow(
      'cdp-direct: client is not connected',
    );
    expect(sent).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);
    expect(
      await dispatchMouseEvents(
        mouseOn(() => ({})),
        [MOVE],
      ),
    ).toEqual({ dialog: false });
  });

  test('a watched move that fails is unanswered', async () => {
    const deps = mouseOn(() => {
      throw new Error('Input.dispatchMouseEvent failed');
    });
    expect(await dispatchWatchedMove(deps, MOVE, 1_000)).toBe('unanswered');
  });

  test('a watched move not answered within its budget is unanswered, at the budget', async () => {
    const clock = createManualClock();
    const deps = mouseOn(() => new Promise(() => undefined), { clock });
    let outcome: unknown = 'pending';
    void dispatchWatchedMove(deps, MOVE, 300).then((o) => (outcome = o));
    await tick();
    await clock.advance(299);
    await tick();
    expect(outcome).toBe('pending');
    await clock.advance(1);
    await tick();
    expect(outcome).toBe('unanswered');
  });

  test('a watched move answered within its budget reports no dialog', async () => {
    expect(
      await dispatchWatchedMove(
        mouseOn(() => ({})),
        MOVE,
        300,
      ),
    ).toEqual({ dialog: false });
  });

  test('no dialog is ever open', () => {
    expect(dialogOpen(mouseOn(() => ({})))).toBe(false);
  });
});
