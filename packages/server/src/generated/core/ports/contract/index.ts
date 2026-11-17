// GENERATED from packages/core/src/ports/contract/index.ts. Do not edit.
// The port contract suite (5.3, item 5) and the in-memory fakes it runs
// against. The outcome-mapping contract speaks `ToolOutcome`, so it lives
// in `tools/` (slice 10).

export {
  check,
  type ContractCase,
  ContractViolation,
  equal,
  observe,
  type Outcome,
} from './assert.js';
export { type CdpEventsHarness, defineCdpEventsContract } from './cdp-events.contract.js';
export { type CdpSessionHarness, defineCdpSessionContract } from './cdp-session.contract.js';
export {
  type ContentSettingsHarness,
  defineContentSettingsContract,
} from './content-settings.contract.js';
export { defineDialogInputContract, type DialogInputHarness } from './dialog-input.contract.js';
export { defineDownloadsContract, type DownloadsHarness } from './downloads.contract.js';
export {
  defineDetachedFlowStoreContract,
  defineFlowHistoryStoreContract,
  type DetachedFlowStoreHarness,
  type FlowHistoryStoreHarness,
} from './flow-stores.contract.js';
export { defineDragInputContract, type DragInputHarness } from './drag-input.contract.js';
export { defineKeyboardContract, type KeyboardHarness } from './keyboard.contract.js';
export { defineNavigatorContract, type NavigatorHarness } from './navigator.contract.js';
export { definePageInfoContract, type PageInfoHarness } from './page-info.contract.js';
export { definePointerContract, type PointerHarness } from './pointer.contract.js';
export {
  defineResponseBodiesContract,
  type ResponseBodiesHarness,
} from './response-bodies.contract.js';
export {
  defineScreenCaptureContract,
  type ScreenCaptureHarness,
} from './screen-capture.contract.js';
export {
  countingSession,
  createManualClock,
  createMemoryCdpSession,
  createMemoryContentSettings,
  createMemoryDetachedFlowStore,
  createMemoryDownloads,
  createMemoryFlowHistoryStore,
  createMemoryPageInfo,
  type ManualClock,
  type MemoryCdpSession,
  type MemoryContentSettings,
  type MemoryDetachedFlowStore,
  type MemoryDownloads,
  type MemoryFlowHistoryStore,
  type MemoryPageInfo,
} from './fakes.js';
