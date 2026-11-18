// The bridge events the worker sends on a tab's socket (design 6.1, slice
// 21c): the core's own events (`EventsOut`, through
// `adapters/ws-events-out.ts`) and the page observer's top-document reports.
// No `chrome`: the socket is the tab's `BridgeSocket`.

import type { BridgeEventPayload, ObserverMessageOutcome } from '@browser-link/core';
import { docInfoEvent } from '../doc-info-event.js';
import {
  registeredSocket,
  send,
  sendBridgeEvent,
  SOCKET_OPEN,
  type TabConnection,
} from './tab-connection.js';

/**
 * Send one core event on the tab's socket. Returns whether it actually went
 * out — the core defers it onto the flow's record when it did not, so an
 * audit trail is never quietly dropped just because the tab's socket
 * happened to be closed. The tab's server id goes with it once the tab is
 * registered.
 */
export function emitBridgeEvent(
  conn: TabConnection | undefined,
  event: BridgeEventPayload,
): boolean {
  if (!conn?.ws || conn.ws.readyState !== SOCKET_OPEN) return false;
  send(conn.ws, {
    kind: 'bridge.event',
    eventKind: event.eventKind,
    ...(conn.serverTabId === undefined ? {} : { tabId: conn.serverTabId }),
    data: event.data,
  });
  return true;
}

/**
 * Report a top-document page-observer message the page driver applied: a
 * `doc_info` as a `tab-doc-info` bridge event (build fingerprint and view
 * signature; before registration the mirror keeps it and the
 * `tab.registered` handler delivers it), a `doc_start` / `nav` as a
 * `tab-navigated` bridge event so the server keeps the tab's URL and title
 * current.
 */
export async function reportTopDocument(
  state: TabConnection,
  outcome: ObserverMessageOutcome,
): Promise<void> {
  if (outcome.kind === 'doc_info') {
    const open = registeredSocket(state);
    if (open) send(open.ws, docInfoEvent(open.serverTabId, outcome));
    return;
  }
  if (outcome.kind !== 'doc_start' && outcome.kind !== 'nav') return;
  let title = '';
  try {
    title = (await state.session.driver.page.info()).title;
  } catch {
    // Best effort — the tab may be closing; the URL is still worth sending.
  }
  sendBridgeEvent(state, 'tab-navigated', { url: outcome.url, title });
}
