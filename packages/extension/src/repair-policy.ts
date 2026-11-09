/**
 * "Repair connection" (popup button) decision logic. Pure: background.ts
 * gathers the facts (is a socket open, which version the server reported,
 * which tabs were connected) and carries out the step this module picks.
 *
 * - A connected server from 0.41.0 understands `bridge.repair`: it spawns the
 *   installed CLI, drops every socket uncleanly and exits, and the existing
 *   auto-reconnect (reconnect-policy.ts) brings the tabs back to the new
 *   process.
 * - An older connected server cannot do that: the user has to stop it.
 * - With no socket open, the remembered tabs are reconnected through the
 *   normal connect path; if none comes back, no server is running.
 */
import type { BridgeRepairResultMessage } from '@browser-link/shared';
import { compareSemver } from './version-status.js';

/** First server version that understands `bridge.repair`. */
export const MIN_REPAIR_VERSION = '0.41.0';

/** How long the extension waits for `bridge.repair.result`. A healthy server
 * answers at once, before it exits. */
export const REPAIR_TIMEOUT_MS = 3_000;

/**
 * `chrome.storage.session` key prefix holding the browser-link tab id a
 * Chrome tab last registered with. Written on registration, removed on an
 * explicit disconnect or tab removal, kept across an involuntary drop: the
 * set of these keys IS the set of tabs the user connected, which is what a
 * repair reconnects.
 */
export const PREV_TAB_ID_PREFIX = 'prevTabId:';

export function prevTabIdKey(chromeTabId: number): string {
  return `${PREV_TAB_ID_PREFIX}${chromeTabId}`;
}

/** Chrome tab ids remembered in a `chrome.storage.session.get(null)` dump,
 * ascending. Keys or values that are not what `storeTabId` writes are
 * skipped. */
export function rememberedTabIds(stored: Record<string, unknown>): number[] {
  const ids: number[] = [];
  for (const [key, value] of Object.entries(stored)) {
    if (!key.startsWith(PREV_TAB_ID_PREFIX) || typeof value !== 'string') continue;
    const raw = key.slice(PREV_TAB_ID_PREFIX.length);
    if (!/^\d+$/.test(raw)) continue;
    ids.push(Number(raw));
  }
  return ids.sort((a, b) => a - b);
}

const STOP_AND_RESTART = 'run `browser-link stop` and restart your agent';
const NO_SERVER_MESSAGE = 'no server is running: start browser-link from your agent or a console';

export type RepairPlan =
  | { step: 'ask-server-restart' }
  | { step: 'reconnect-only'; tabIds: number[] }
  | { step: 'manual'; reason: 'server-too-old' | 'no-server'; message: string };

export interface RepairInput {
  /** At least one extension socket is open. */
  connected: boolean;
  /** `serverVersion` from `tab.registered`; null when unknown. */
  serverVersion: string | null;
  rememberedTabIds: number[];
  minRepairVersion?: string;
}

export function planRepair(input: RepairInput): RepairPlan {
  const min = input.minRepairVersion ?? MIN_REPAIR_VERSION;
  if (input.connected) {
    if (input.serverVersion !== null && compareSemver(input.serverVersion, min) >= 0) {
      return { step: 'ask-server-restart' };
    }
    const label = input.serverVersion ?? '(unknown version)';
    return {
      step: 'manual',
      reason: 'server-too-old',
      message: `server ${label} cannot repair itself: ${STOP_AND_RESTART}`,
    };
  }
  // No socket and no remembered tab: there is nothing to reconnect through,
  // so there is no live connection to repair either.
  if (input.rememberedTabIds.length === 0) {
    return { step: 'manual', reason: 'no-server', message: NO_SERVER_MESSAGE };
  }
  return { step: 'reconnect-only', tabIds: [...input.rememberedTabIds] };
}

/** What the popup shows under the button. */
export interface RepairOutcome {
  ok: boolean;
  message: string;
}

export function describeRepairReply(reply: BridgeRepairResultMessage | 'timeout'): RepairOutcome {
  if (reply === 'timeout') {
    return {
      ok: false,
      message: `The server did not answer the repair request: ${STOP_AND_RESTART}`,
    };
  }
  if (reply.ok) {
    return {
      ok: true,
      message: 'The server is restarting; connected tabs reconnect by themselves.',
    };
  }
  return { ok: false, message: `Repair failed: ${reply.error}` };
}

export function describeReconnectResults(results: ReadonlyArray<{ ok: boolean }>): RepairOutcome {
  const reconnected = results.filter((r) => r.ok).length;
  if (reconnected === 0) return { ok: false, message: NO_SERVER_MESSAGE };
  return {
    ok: true,
    message: `Reconnected ${reconnected} of ${results.length} tab${results.length === 1 ? '' : 's'}.`,
  };
}
