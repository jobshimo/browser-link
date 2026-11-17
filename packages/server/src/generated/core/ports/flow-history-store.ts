// GENERATED from packages/core/src/ports/flow-history-store.ts. Do not edit.
// A tab's flow history, as a typed repository (design 3.1; slice 17).
// Extension only: the adapter keeps today's `chrome.storage.session` key per
// Chrome tab id; core's `flow/flow-history.ts` parses, bounds and serializes
// the writes.

import type { FlowHistoryEntry } from './values.js';

export interface FlowHistoryStore {
  /** The tab's stored entries, newest first; `[]` when it has none. Rejects
   * when the store cannot be read. */
  load(tabId: number): Promise<FlowHistoryEntry[]>;
  /** Replace the tab's entries; rejects when the store refuses the write. */
  save(tabId: number, entries: readonly FlowHistoryEntry[]): Promise<void>;
  /** Forget the tab's entries; dropping a tab with none is a no-op. */
  drop(tabId: number): Promise<void>;
}
