// The extension's `DetachedFlowStore` (design 3.1): `chrome.storage.session`
// under today's key per flow id (`detachedFlowKey`); core's
// `detachedFlowRecordsIn` picks and parses the records out of the whole
// store. Stateless, so one object serves the worker (design revision 10).
import { detachedFlowKey, detachedFlowRecordsIn, type DetachedFlowStore } from '@browser-link/core';

export const chromeDetachedFlowStore: DetachedFlowStore = {
  list: () => chrome.storage.session.get(null).then(detachedFlowRecordsIn),
  put: (record) => chrome.storage.session.set({ [detachedFlowKey(record.flowId)]: record }),
  remove: (flowIds) => chrome.storage.session.remove(flowIds.map(detachedFlowKey)),
};
