// An in-memory `TabEvents` (the contract's fake, and the tab-event tests'):
// tabs numbered from 1, `create` and `close` report to the listeners as the
// browser does, a debugger attached to a closing tab is reported detached
// first, and `update` reports a tab update.

import type { CreatedTab, TabEvents, TabInfo, TabUpdate } from '../src/app/tab-events.js';

export interface MemoryTabEvents extends TabEvents {
  /** The tabs open now: id -> what `get` answers. */
  readonly tabs: Map<number, TabInfo>;
  create(info?: TabInfo, openerTabId?: number): number;
  attachDebugger(tabId: number): void;
  close(tabId: number): void;
  update(update: TabUpdate): void;
}

export function createMemoryTabEvents(): MemoryTabEvents {
  const tabs = new Map<number, TabInfo>();
  const attached = new Set<number>();
  const updated = new Set<(update: TabUpdate) => void>();
  const removed: ((tabId: number) => void)[] = [];
  const created: ((tab: CreatedTab) => void)[] = [];
  const detached: ((tabId: number | undefined) => void)[] = [];
  let next = 1;
  return {
    tabs,
    get(tabId) {
      const tab = tabs.get(tabId);
      return tab
        ? Promise.resolve({ ...tab })
        : Promise.reject(new Error(`No tab with id: ${String(tabId)}.`));
    },
    onUpdated(listener) {
      updated.add(listener);
      return () => {
        updated.delete(listener);
      };
    },
    onRemoved(listener) {
      removed.push(listener);
    },
    onCreated(listener) {
      created.push(listener);
    },
    onDebuggerDetach(listener) {
      detached.push(listener);
    },
    create(info = {}, openerTabId) {
      const tabId = next++;
      tabs.set(tabId, info);
      for (const listener of created) listener({ tabId, openerTabId });
      return tabId;
    },
    attachDebugger(tabId) {
      attached.add(tabId);
    },
    close(tabId) {
      if (!tabs.delete(tabId)) return;
      if (attached.delete(tabId)) for (const listener of detached) listener(tabId);
      for (const listener of removed) listener(tabId);
    },
    update(update) {
      for (const listener of [...updated]) listener(update);
    },
  };
}
