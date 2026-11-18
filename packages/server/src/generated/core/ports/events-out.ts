// GENERATED from packages/core/src/ports/events-out.ts. Do not edit.
// Events the core emits toward the server's event log (design 3.1; slice 21c,
// revision 13). Input only: the core sends its own events; the answer says
// whether the event went out, not anything the transport observed.

import type { BridgeEventPayload } from './values.js';

export interface EventsOut {
  /** Send `event` for the browser tab `tabId`; false when it did not go out
   * (the tab has no open channel to the server), so the caller can defer it. */
  emit(tabId: number, event: BridgeEventPayload): boolean;
}
