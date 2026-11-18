// The extension's `EventsOut` (design 3.1, slice 21c, revision 13): the
// core's events as `bridge.event` frames on the tab's WebSocket, through
// `app/events.ts` `emitBridgeEvent`, which holds the open-socket check.
// Stateless (the sockets live in the registry it is given), and
// `createFlowHistory` takes it once, so `background.ts` builds it once; the
// in-worker contract run (`contract/`) reaches the factory, which the e2e's
// coverage cannot see run at module load (R6).
import type { EventsOut, TabRegistry } from '@browser-link/core';
import { emitBridgeEvent } from '../app/events.js';
import type { TabConnection } from '../app/tab-connection.js';

export function createWsEventsOut(tabs: TabRegistry<TabConnection>): EventsOut {
  return {
    emit: (tabId, event) => emitBridgeEvent(tabs.get(tabId), event),
  };
}
