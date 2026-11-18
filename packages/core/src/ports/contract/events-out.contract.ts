// What every `EventsOut` guarantees (5.3, item 5; slice 21c, revision 13):
// an event emitted for a tab whose channel to the server is open reaches it,
// in order, as it was given, and `emit` answers true; for a tab with no open
// channel `emit` answers false and nothing goes out. It runs against the
// in-memory fake under vitest in core and against the extension adapter
// (`adapters/ws-events-out.ts`) inside the real service worker (the
// extension's `contract/entry.ts`, run by the e2e; R6). The harness creates
// nothing in the browser, so there is nothing to tear down.

import type { EventsOut } from '../events-out.js';
import type { BridgeEventPayload } from '../values.js';
import { type ContractCase, equal } from './assert.js';

export interface EventsOutHarness {
  events: EventsOut;
  /** A tab whose channel to the server is open, and what reached it so far. */
  openTab: () => { tabId: number; received: () => BridgeEventPayload[] };
  /** A tab whose channel is closed, and what reached it so far. */
  closedTab: () => { tabId: number; received: () => BridgeEventPayload[] };
}

const event = (n: number): BridgeEventPayload => ({
  eventKind: 'contract-event',
  data: { n, nested: { list: [n, 'x'] } },
});

export function defineEventsOutContract(make: () => EventsOutHarness): ContractCase[] {
  return [
    {
      name: 'events emitted for an open tab reach it in order, unchanged, and emit answers true',
      run: async () => {
        const { events, openTab } = make();
        const tab = openTab();
        const answers = [events.emit(tab.tabId, event(1)), events.emit(tab.tabId, event(2))];
        equal(answers, [true, true], 'emit answers');
        equal(tab.received(), [event(1), event(2)], 'events received');
        await Promise.resolve();
      },
    },
    {
      name: 'an event for a tab with no open channel answers false and goes nowhere',
      run: async () => {
        const { events, openTab, closedTab } = make();
        const open = openTab();
        const closed = closedTab();
        equal(events.emit(closed.tabId, event(1)), false, 'emit answer');
        equal(closed.received(), [], 'events received by the closed tab');
        equal(open.received(), [], 'events received by another tab');
        await Promise.resolve();
      },
    },
  ];
}
