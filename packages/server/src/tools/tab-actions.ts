/**
 * When an action last ran on each tab (parity P7, G11): `runAction` in
 * `browser-dispatch.ts` notes the start and the end of every action tool
 * (click, type, press, evaluate, navigate, drag, flow, ...), and
 * `browser.wait_for_tab` on a `cdp:` opener reads it to decide whether a
 * page that was already open when its watch started may be returned: only
 * when the opener ran an action within the extension's 1.5 s replay window
 * (`REPLAY_WITHIN_MS`) before the wait started, or during it. Process-local,
 * bounded, never persisted.
 */
const LIMIT = 512;
const lastActionAt = new Map<string, number>();

/** Note that an action on `tabId` started or ended at `at`. */
export function noteTabAction(tabId: string, at: number = Date.now()): void {
  lastActionAt.delete(tabId);
  lastActionAt.set(tabId, at);
  if (lastActionAt.size > LIMIT) {
    const oldest = lastActionAt.keys().next().value;
    if (oldest !== undefined) lastActionAt.delete(oldest);
  }
}

/** Whether an action on `tabId` started or ended at or after `since`. */
export function tabActedSince(tabId: string, since: number): boolean {
  const at = lastActionAt.get(tabId);
  return at !== undefined && at >= since;
}

/** Tests only. */
export function resetTabActionsForTest(): void {
  lastActionAt.clear();
}
