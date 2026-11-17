// The page driver's `Pointer` (slice 10): the Pointer contract on an
// in-memory session, with and without a dialog watch, its RED probes, and
// the two dispatch behaviors each transport had before slice 10.
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
import { createPageDriver, type DialogWatch } from './page-driver.js';

type Dispatch = (event: MouseEventParams) => unknown;

function pointerOn(
  dispatch: Dispatch,
  options: { dialogs?: DialogWatch; clock?: ManualClock } = {},
): Pointer {
  const clock = options.clock ?? createManualClock();
  const session = createMemoryCdpSession({
    'Input.dispatchMouseEvent': (params) => dispatch(params as MouseEventParams),
  });
  const page = createMemoryPageInfo({ url: 'https://t.test/', title: 'T' }, clock);
  return createPageDriver({ session, page, clock, dialogs: options.dialogs }).pointer;
}

function harness(dialogs?: DialogWatch): PointerHarness {
  const received: string[] = [];
  return {
    pointer: pointerOn(
      (event) => {
        received.push(event.type);
        return {};
      },
      { dialogs },
    ),
    at: { x: 10, y: 20 },
    received: () => Promise.resolve([...received]),
  };
}

function run(cases: ContractCase[]): void {
  for (const contractCase of cases) it(contractCase.name, () => contractCase.run());
}

const closed: DialogWatch = { isOpen: () => false };
const MOVE: MouseEventParams = { type: 'mouseMoved', x: 1, y: 2 };
const PRESS: MouseEventParams = { type: 'mousePressed', x: 1, y: 2, button: 'left', clickCount: 1 };
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('Pointer contract: page driver on an in-memory session, no dialog watch (cdp-direct)', () => {
  run(definePointerContract(() => harness()));
});

describe('Pointer contract: page driver on an in-memory session, dialog watch (extension)', () => {
  run(definePointerContract(() => harness(closed)));
});

describe('the Pointer contract catches a broken pointer (RED probes)', () => {
  const caseNamed = (cases: ContractCase[], name: string): ContractCase => {
    const found = cases.find((c) => c.name === name);
    if (!found) throw new Error(`no contract case named ${name}`);
    return found;
  };

  it('events sent in the wrong order', async () => {
    const cases = definePointerContract(() => {
      const h = harness();
      return {
        ...h,
        pointer: { ...h.pointer, mouse: (events) => h.pointer.mouse([...events].reverse()) },
      };
    });
    await expect(
      caseNamed(cases, 'mouse dispatches the events in order and reports no dialog').run(),
    ).rejects.toThrow(/events/);
  });

  it('a dialog reported where none is open', async () => {
    const cases = definePointerContract(() => harness({ isOpen: () => true }));
    await expect(
      caseNamed(cases, 'no dialog is open on a page that opened none').run(),
    ).rejects.toThrow(/dialogOpen/);
  });
});

describe('with a dialog watch (the extension, as before slice 10)', () => {
  test('a dialog opened while an event waits answers dialog: true and sends nothing after it', async () => {
    const clock = createManualClock();
    let open = false;
    const sent: string[] = [];
    const pointer = pointerOn(
      (event) => {
        sent.push(event.type);
        // The page is paused: the event that opened the dialog is not answered.
        return new Promise(() => undefined);
      },
      { dialogs: { isOpen: () => open }, clock },
    );
    let answer: unknown = 'pending';
    void pointer.mouse([PRESS, { ...PRESS, type: 'mouseReleased' }]).then((a) => (answer = a));
    await tick();
    await clock.advance(100);
    expect(answer).toBe('pending');
    open = true;
    await clock.advance(50);
    await tick();
    expect(answer).toEqual({ dialog: true });
    expect(sent).toEqual(['mousePressed']);
  });

  test('a failed dispatch rejects with its error, and so does a watched move', async () => {
    const pointer = pointerOn(
      () => {
        throw new Error('Debugger is not attached');
      },
      { dialogs: closed },
    );
    await expect(pointer.mouse([MOVE])).rejects.toThrow('Debugger is not attached');
    await expect(pointer.watchedMove(MOVE, 10)).rejects.toThrow('Debugger is not attached');
  });

  test('a watched move is not bounded by its budget', async () => {
    const clock = createManualClock();
    let answer: (v: unknown) => void = () => undefined;
    const pointer = pointerOn(() => new Promise((resolve) => (answer = resolve)), {
      dialogs: closed,
      clock,
    });
    let outcome: unknown = 'pending';
    void pointer.watchedMove(MOVE, 10).then((o) => (outcome = o));
    await tick();
    await clock.advance(500);
    expect(outcome).toBe('pending');
    answer({});
    await tick();
    expect(outcome).toEqual({ dialog: false });
  });
});

describe('without a dialog watch (cdp-direct, as before slice 10)', () => {
  test('a failed dispatch rejects mouse with its error', async () => {
    const pointer = pointerOn(() => {
      throw new Error('cdp-direct: client is not connected');
    });
    await expect(pointer.mouse([MOVE])).rejects.toThrow('cdp-direct: client is not connected');
  });

  test('a watched move that fails is unanswered', async () => {
    const pointer = pointerOn(() => {
      throw new Error('Input.dispatchMouseEvent failed');
    });
    expect(await pointer.watchedMove(MOVE, 1_000)).toBe('unanswered');
  });

  test('a watched move not answered within its budget is unanswered, at the budget', async () => {
    const clock = createManualClock();
    const pointer = pointerOn(() => new Promise(() => undefined), { clock });
    let outcome: unknown = 'pending';
    void pointer.watchedMove(MOVE, 300).then((o) => (outcome = o));
    await tick();
    await clock.advance(299);
    await tick();
    expect(outcome).toBe('pending');
    await clock.advance(1);
    await tick();
    expect(outcome).toBe('unanswered');
  });

  test('dialogOpen is always false', () => {
    expect(pointerOn(() => ({})).dialogOpen()).toBe(false);
  });
});
