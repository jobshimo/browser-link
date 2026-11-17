// What the transport knows about the page outside CDP.

import type { LoadWait } from './values.js';

export interface PageInfo {
  info(): Promise<{ url: string; title: string }>;
  /**
   * Start waiting for the page to report load complete. Armed BEFORE the
   * navigation is sent, because a fast page can finish loading before
   * `Page.navigate` answers; `cancel` releases the wait when the navigation
   * itself fails. `done` rejects when `timeoutMs` passes first.
   */
  armLoadWait(timeoutMs: number): LoadWait;
}
