// GENERATED from packages/core/src/ports/contract/index.ts. Do not edit.
// The port contract suite (5.3, item 5) and the in-memory fakes it runs
// against. The store and outcome-mapping contracts land with slices 17
// and 10.

export {
  check,
  type ContractCase,
  ContractViolation,
  equal,
  observe,
  type Outcome,
} from './assert.js';
export { type CdpSessionHarness, defineCdpSessionContract } from './cdp-session.contract.js';
export { definePageInfoContract, type PageInfoHarness } from './page-info.contract.js';
export {
  createManualClock,
  createMemoryCdpSession,
  createMemoryPageInfo,
  type ManualClock,
  type MemoryCdpSession,
  type MemoryPageInfo,
} from './fakes.js';
