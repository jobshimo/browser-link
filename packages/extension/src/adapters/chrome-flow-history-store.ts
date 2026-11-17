// The extension's `FlowHistoryStore` (design 3.1): `chrome.storage.session`
// under today's key per Chrome tab (`flowHistoryKey`); core's
// `parseFlowHistory` narrows what is read. Stateless, so one object serves
// the worker (design revision 10).
import { flowHistoryKey, parseFlowHistory, type FlowHistoryStore } from '@browser-link/core';

export const chromeFlowHistoryStore: FlowHistoryStore = {
  load: (tabId) =>
    chrome.storage.session
      .get(flowHistoryKey(tabId))
      .then((data) => parseFlowHistory(data[flowHistoryKey(tabId)])),
  save: (tabId, entries) => chrome.storage.session.set({ [flowHistoryKey(tabId)]: entries }),
  drop: (tabId) => chrome.storage.session.remove(flowHistoryKey(tabId)),
};
