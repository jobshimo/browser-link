/**
 * The `tab-doc-info` bridge event (knowledge-loop S1): the page's build
 * fingerprint and view signature as the server stores them on the tab
 * session and `list_tabs` reports them. Pure, no `chrome.*`.
 */
import type { BridgeEventMessage, TabId } from '@browser-link/shared';
import type { ObserverDocInfo, ObserverMirror } from './observer-host.js';

export function docInfoEvent(tabId: TabId, info: ObserverDocInfo): BridgeEventMessage {
  return {
    kind: 'bridge.event',
    eventKind: 'tab-doc-info',
    tabId,
    data: { url: info.url, build: info.build, view_sig: info.view_sig, title: info.title },
  };
}

/** Event to send right after `tab.registered`: the observer installed on an
 * already-loaded page pushes its doc_info before the socket is registered,
 * so the latest one kept on the mirror is delivered then. */
export function pendingDocInfoEvent(
  mirror: ObserverMirror | undefined,
  tabId: TabId,
): BridgeEventMessage | null {
  return mirror?.doc_info ? docInfoEvent(tabId, mirror.doc_info) : null;
}
