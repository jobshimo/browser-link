// The records of detached flows, as a typed repository (design 3.1; slice
// 17). Extension only: the adapter keeps today's `chrome.storage.session`
// key per flow id; core's `flow/flow-history.ts` parses, bounds (record cap,
// manifest bytes) and serializes the writes.

import type { DetachedFlowRecord } from './values.js';

export interface DetachedFlowStore {
  /** Every stored record, in no particular order. Rejects when the store
   * cannot be read. */
  list(): Promise<DetachedFlowRecord[]>;
  /** Store the record under its flow id, replacing any earlier one; rejects
   * when the store refuses the write. */
  put(record: DetachedFlowRecord): Promise<void>;
  /** Forget the records of these flow ids; an unknown id is a no-op. */
  remove(flowIds: readonly string[]): Promise<void>;
}
