// The contract suite against the in-memory fakes (condition 3 of R6), and
// RED probes showing each contract catches a broken subject.
import { describe, expect, it } from 'vitest';
import {
  createManualClock,
  createMemoryCdpSession,
  createMemoryPageInfo,
  defineCdpSessionContract,
  definePageInfoContract,
  type CdpSessionHarness,
  type ContractCase,
  type PageInfoHarness,
} from './index.js';

function run(cases: ContractCase[]): void {
  for (const contractCase of cases) it(contractCase.name, () => contractCase.run());
}

function caseNamed(cases: ContractCase[], name: string): ContractCase {
  const found = cases.find((c) => c.name === name);
  if (!found) throw new Error(`no contract case named ${name}`);
  return found;
}

const EVENTS = ['Page.frameNavigated', 'Runtime.consoleAPICalled', 'Page.loadEventFired'];

function fakeSession(): CdpSessionHarness {
  const session = createMemoryCdpSession({
    'Runtime.evaluate': () => ({ result: { type: 'number', value: 2 } }),
    'DOM.describeNode': () => {
      throw new Error('Could not find node with given id');
    },
  });
  return {
    session,
    answered: {
      method: 'Runtime.evaluate',
      params: { expression: '1 + 1' },
      result: { result: { type: 'number', value: 2 } },
    },
    failing: { method: 'DOM.describeNode', message: 'Could not find node with given id' },
    trigger: () => {
      for (const method of EVENTS) session.emit(method);
      return Promise.resolve(EVENTS);
    },
  };
}

function fakePage(): PageInfoHarness {
  const clock = createManualClock(1_000);
  const expected = { url: 'https://example.test/', title: 'Example' };
  const page = createMemoryPageInfo(expected, clock);
  return {
    page,
    expected,
    completeLoad: () => {
      page.completeLoad();
    },
    elapse: (ms) => clock.advance(ms),
  };
}

describe('CdpSession contract: in-memory fake', () => {
  run(defineCdpSessionContract(fakeSession));
});

describe('PageInfo contract: in-memory fake', () => {
  run(definePageInfoContract(fakePage));
});

describe('the contracts catch a broken subject (RED probes)', () => {
  it('CdpSession: an error message that is not passed through unchanged', async () => {
    const cases = defineCdpSessionContract(() => {
      const harness = fakeSession();
      const send = harness.session.send.bind(harness.session);
      harness.session.send = (method, params) =>
        send(method, params).catch(() => Promise.reject(new Error('CDP failed')));
      return harness;
    });
    await expect(
      caseNamed(cases, 'send rejects with the CDP error message unchanged').run(),
    ).rejects.toThrow(/error message/);
  });

  it('CdpSession: events delivered out of order', async () => {
    const cases = defineCdpSessionContract(() => {
      const harness = fakeSession();
      return { ...harness, trigger: () => harness.trigger().then((m) => [...m].reverse()) };
    });
    await expect(caseNamed(cases, 'events arrive in emission order').run()).rejects.toThrow(
      /event methods/,
    );
  });

  it('CdpSession: a listener that still hears events after unsubscribing', async () => {
    const cases = defineCdpSessionContract(() => {
      const harness = fakeSession();
      const onEvent = harness.session.onEvent.bind(harness.session);
      harness.session.onEvent = (listener) => {
        onEvent(listener);
        return () => undefined;
      };
      return harness;
    });
    await expect(
      caseNamed(cases, 'no event reaches a listener after it unsubscribed').run(),
    ).rejects.toThrow(/after unsubscribe/);
  });

  it('PageInfo: a waitForLoad that never times out', async () => {
    const cases = definePageInfoContract(() => ({
      ...fakePage(),
      page: {
        info: () => Promise.resolve({ url: '', title: '' }),
        waitForLoad: () => new Promise<void>(() => undefined),
      },
    }));
    await expect(
      caseNamed(cases, 'waitForLoad rejects when the timeout passes first').run(),
    ).rejects.toThrow(/without load/);
  });
});

describe('createManualClock', () => {
  it('fires timers in due order and repeats `every` until stopped', async () => {
    const clock = createManualClock(0);
    const fired: string[] = [];
    clock.after(30, () => fired.push('after30'));
    const stop = clock.every(20, () => fired.push(`every@${clock.now()}`));
    const cancel = clock.after(10, () => fired.push('cancelled'));
    cancel();
    await clock.advance(45);
    stop();
    await clock.advance(100);
    expect(fired).toEqual(['every@20', 'after30', 'every@40']);
    expect(clock.now()).toBe(145);
  });

  it('resolves sleep when time reaches it', async () => {
    const clock = createManualClock(0);
    let woke = false;
    void clock.sleep(50).then(() => (woke = true));
    await clock.advance(49);
    expect(woke).toBe(false);
    await clock.advance(1);
    expect(woke).toBe(true);
  });
});
