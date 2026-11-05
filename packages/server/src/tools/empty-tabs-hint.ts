import type { BridgeEvent } from '../bridge/events.js';

/**
 * How long the extension keeps auto-reconnecting a tab after an involuntary
 * drop. MUST stay in step with `RECONNECT_WINDOW_MS` in the extension's
 * `reconnect-policy.ts` (the two packages cannot import each other); it
 * only shapes the wording of a hint, so drift degrades advice, not behaviour.
 */
export const EXTENSION_RECONNECT_WINDOW_MS = 10 * 60_000;

const MAX_LISTED_TABS = 5;

interface DroppedTab {
  tabId: string;
  origin: string | null;
  droppedAtMs: number;
}

function originOf(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s ago`;
  return `${Math.round(s / 60)}min ago`;
}

/**
 * Replay the bridge event log into the set of tabs that were connected and
 * then dropped (and have not come back). Renames move a tab to its new id.
 */
function droppedTabs(events: readonly BridgeEvent[]): DroppedTab[] {
  const known = new Map<string, { origin: string | null; droppedAtMs: number | null }>();
  for (const e of events) {
    const atMs = Date.parse(e.at);
    if (e.kind === 'tab-registered' && typeof e.data.tabId === 'string') {
      known.set(e.data.tabId, { origin: originOf(e.data.url), droppedAtMs: null });
    } else if (e.kind === 'tab-renamed' && typeof e.data.current === 'string') {
      if (typeof e.data.previous === 'string') known.delete(e.data.previous);
      known.set(e.data.current, { origin: originOf(e.data.url), droppedAtMs: null });
    } else if (e.kind === 'tab-disconnected' && typeof e.data.tabId === 'string') {
      const t = known.get(e.data.tabId);
      if (t) t.droppedAtMs = Number.isFinite(atMs) ? atMs : null;
      else
        known.set(e.data.tabId, { origin: null, droppedAtMs: Number.isFinite(atMs) ? atMs : null });
    }
  }
  const out: DroppedTab[] = [];
  for (const [tabId, t] of known) {
    if (t.droppedAtMs !== null) out.push({ tabId, origin: t.origin, droppedAtMs: t.droppedAtMs });
  }
  return out;
}

/**
 * Explain an EMPTY `browser.list_tabs` from the bridge event log, so the agent
 * can tell "nothing was ever connected" from "tabs dropped, the extension is
 * probably reconnecting" from "the bridge just restarted" instead of guessing.
 * Origins only (never full URLs — paths and queries can carry secrets).
 */
export function buildEmptyTabsHint(events: readonly BridgeEvent[], now: number): string {
  const dropped = droppedTabs(events);
  const lastElected = [...events].reverse().find((e) => e.kind === 'primary-elected');
  const electedAtMs = lastElected ? Date.parse(lastElected.at) : Number.NaN;

  if (dropped.length > 0) {
    const lastDropMs = Math.max(...dropped.map((t) => t.droppedAtMs));
    const listed = dropped
      .slice(0, MAX_LISTED_TABS)
      .map((t) => (t.origin ? `${t.tabId} (${t.origin})` : t.tabId))
      .join(', ');
    const more =
      dropped.length > MAX_LISTED_TABS ? `, and ${dropped.length - MAX_LISTED_TABS} more` : '';
    const head = `${dropped.length} tab(s) were connected and dropped (last ${ago(now - lastDropMs)}): ${listed}${more}.`;
    if (now - lastDropMs < EXTENSION_RECONNECT_WINDOW_MS) {
      return `${head} The extension auto-reconnects dropped tabs for up to 10 minutes after a drop, so wait for reconnect and call browser.list_tabs again (browser.events shows tab-registered / tab-renamed when they return); if they do not come back, ask the user to press Connect in the extension popup.`;
    }
    return `${head} That is past the extension's 10-minute auto-reconnect window: ask the user to press Connect in the extension popup on each tab.`;
  }

  if (lastElected?.data.reason === 'reset') {
    return 'No tabs are connected: browser.reset closed every tab connection and the extension does NOT auto-reconnect after a reset. Ask the user to press Connect in the extension popup.';
  }

  const sinceStart = Number.isFinite(electedAtMs) ? now - electedAtMs : Number.POSITIVE_INFINITY;
  if (sinceStart < EXTENSION_RECONNECT_WINDOW_MS) {
    return `No tab has connected to this bridge yet; it started ${ago(sinceStart)}. If the previous bridge process just died, the extension may still be reconnecting tabs it had connected: wait a little and call browser.list_tabs again, then ask the user to press Connect in the extension popup.`;
  }
  return 'No tab has connected to this bridge since it started. Tabs only appear once the user clicks Connect: ask them to press Connect in the extension popup.';
}
