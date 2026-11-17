// The page driver's drag input and CDP event wait (slice 14): the
// DragInput and CdpEvents contracts on an in-memory session, and their RED
// probes.
import { describe, expect, it } from 'vitest';
import {
  createManualClock,
  createMemoryCdpSession,
  createMemoryPageInfo,
  countingSession,
  defineCdpEventsContract,
  defineDragInputContract,
  type CdpEventsHarness,
  type ContractCase,
  type DragInputHarness,
} from '../ports/contract/index.js';
import type { CdpEvents, DragInput } from '../ports/page-driver.js';
import type { DragEventParams } from '../ports/values.js';
import { createPageDriver } from './page-driver.js';

/** What Chrome answers for params of the wrong type. */
const INVALID = 'Invalid parameters';

function driverOn(handlers: Parameters<typeof createMemoryCdpSession>[0]) {
  const clock = createManualClock();
  const session = createMemoryCdpSession(handlers);
  const page = createMemoryPageInfo({ url: 'https://t.test/', title: 'T' }, clock);
  return { clock, session, driver: createPageDriver({ session, page, clock }) };
}

function dragHarness(): DragInputHarness & { sent: [string, unknown][] } {
  const sent: [string, unknown][] = [];
  const { driver } = driverOn({
    'Input.setInterceptDrags': (params) => {
      sent.push(['Input.setInterceptDrags', params]);
      if (typeof params.enabled !== 'boolean') throw new Error(INVALID);
      return {};
    },
    'Input.dispatchDragEvent': (params) => {
      sent.push(['Input.dispatchDragEvent', params]);
      if (typeof params.x !== 'number') throw new Error(INVALID);
      return {};
    },
  });
  return {
    drag: driver.drag,
    failing: {
      event: { type: 'drop', x: 'far' as unknown as number, y: 1, data: {} },
      message: INVALID,
    },
    failingIntercept: { enabled: 'yes' as unknown as boolean, message: INVALID },
    sent,
  };
}

function eventsHarness(): CdpEventsHarness {
  const clock = createManualClock();
  const session = createMemoryCdpSession({});
  const counted = countingSession(session);
  const page = createMemoryPageInfo({ url: 'https://t.test/', title: 'T' }, clock);
  const driver = createPageDriver({ session: counted, page, clock });
  return {
    events: driver.events,
    listening: () => counted.listening(),
    method: 'Input.dragIntercepted',
    emit: () => {
      session.emit('Input.dragIntercepted', { data: { items: [], dragOperationsMask: 1 } });
      return Promise.resolve();
    },
    elapse: (ms) => clock.advance(ms),
  };
}

function run(cases: ContractCase[]): void {
  for (const contractCase of cases) it(contractCase.name, () => contractCase.run());
}

function caseNamed(cases: ContractCase[], name: string): ContractCase {
  const found = cases.find((c) => c.name === name);
  if (!found) throw new Error(`no contract case named ${name}`);
  return found;
}

describe('DragInput contract: page driver on an in-memory session', () => {
  run(defineDragInputContract(dragHarness));

  it('each call sends one CDP command with the params as given', async () => {
    const h = dragHarness();
    const event: DragEventParams = { type: 'dragOver', x: 3, y: 4, data: { items: [] } };
    await h.drag.interceptDrags(true);
    await h.drag.dragEvent(event);
    expect(h.sent).toEqual([
      ['Input.setInterceptDrags', { enabled: true }],
      ['Input.dispatchDragEvent', event],
    ]);
  });
});

describe('CdpEvents contract: page driver on an in-memory session', () => {
  run(defineCdpEventsContract(eventsHarness));

  it('an event of another method does not settle the wait', async () => {
    const { clock, session, driver } = driverOn({});
    const waiting = driver.events.waitFor('Input.dragIntercepted', 100);
    session.emit('Page.loadEventFired', {});
    await clock.advance(100);
    expect(await waiting).toBeNull();
  });

  it('an event that arrived before the call is not seen', async () => {
    const { clock, session, driver } = driverOn({});
    session.emit('Input.dragIntercepted', { data: {} });
    const waiting = driver.events.waitFor('Input.dragIntercepted', 100);
    await clock.advance(100);
    expect(await waiting).toBeNull();
  });
});

describe('the DragInput and CdpEvents contracts catch a broken port (RED probes)', () => {
  it('a drag input that swallows a failed drag event', async () => {
    const cases = defineDragInputContract(() => {
      const h = dragHarness();
      const drag: DragInput = {
        ...h.drag,
        dragEvent: (event) => h.drag.dragEvent(event).catch(() => undefined),
      };
      return { ...h, drag };
    });
    await expect(
      caseNamed(cases, 'a failed drag event rejects with the CDP error message unchanged').run(),
    ).rejects.toThrow(/error message/);
  });

  it('a drag input that rewrites the error of a failed switch', async () => {
    const cases = defineDragInputContract(() => {
      const h = dragHarness();
      const drag: DragInput = {
        ...h.drag,
        interceptDrags: (enabled) =>
          h.drag.interceptDrags(enabled).catch(() => Promise.reject(new Error('CDP failed'))),
      };
      return { ...h, drag };
    });
    await expect(
      caseNamed(
        cases,
        'a failed interceptDrags rejects with the CDP error message unchanged',
      ).run(),
    ).rejects.toThrow(/error message/);
  });

  it('an event wait that settles on any event', async () => {
    const cases = defineCdpEventsContract(() => {
      const h = eventsHarness();
      const events: CdpEvents = {
        waitFor: (_method, timeoutMs) => h.events.waitFor(h.method, timeoutMs),
      };
      return { ...h, events };
    });
    await expect(
      caseNamed(cases, 'an event of another method does not settle the wait').run(),
    ).rejects.toThrow(/another method/);
  });

  it('an event wait that never times out', async () => {
    const cases = defineCdpEventsContract(() => {
      const h = eventsHarness();
      const events: CdpEvents = {
        waitFor: (method) => h.events.waitFor(method, Number.MAX_SAFE_INTEGER),
      };
      return { ...h, events };
    });
    const pending = caseNamed(cases, 'waitFor resolves null when no such event arrives in time');
    const outcome = await Promise.race([
      pending.run().then(() => 'passed'),
      new Promise((resolve) => setTimeout(() => resolve('still waiting'), 50)),
    ]);
    expect(outcome).toBe('still waiting');
  });

  it('an event wait that keeps listening after it settled', async () => {
    const cases = defineCdpEventsContract(() => {
      const h = eventsHarness();
      const events: CdpEvents = {
        waitFor: (method, timeoutMs) => {
          // A second, never-settling wait left subscribed alongside the real one.
          void h.events.waitFor('Contract.leaked', Number.MAX_SAFE_INTEGER);
          return h.events.waitFor(method, timeoutMs);
        },
      };
      return { ...h, events };
    });
    await expect(
      caseNamed(cases, 'once settled the wait stops listening, by event or by timeout').run(),
    ).rejects.toThrow(/listeners after the wait settled/);
  });
});
