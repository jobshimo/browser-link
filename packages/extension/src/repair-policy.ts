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
import {
  codeFields,
  englishText,
  type WorkerMessage,
  type WorkerMessageCode,
  type WorkerMessageValues,
} from './worker-messages.js';

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

/** The English text the popup always received, plus the code and values a
 * window renders in its own language (worker-messages.ts). */
interface CodedText {
  message: string;
  code: WorkerMessageCode;
  values?: WorkerMessageValues;
}

function coded(message: WorkerMessage): CodedText {
  return { message: englishText(message), ...codeFields(message) };
}

const NO_SERVER: WorkerMessage = { code: 'repair-no-server' };

export type RepairPlan =
  | { step: 'ask-server-restart' }
  | { step: 'reconnect-only'; tabIds: number[] }
  | ({ step: 'manual'; reason: 'server-too-old' | 'no-server' } & CodedText);

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
    return {
      step: 'manual',
      reason: 'server-too-old',
      ...coded(
        input.serverVersion === null
          ? { code: 'repair-server-too-old' }
          : { code: 'repair-server-too-old', values: { version: input.serverVersion } },
      ),
    };
  }
  // No socket and no remembered tab: there is nothing to reconnect through,
  // so there is no live connection to repair either.
  if (input.rememberedTabIds.length === 0) {
    return { step: 'manual', reason: 'no-server', ...coded(NO_SERVER) };
  }
  return { step: 'reconnect-only', tabIds: [...input.rememberedTabIds] };
}

/** What the popup shows under the button. */
export type RepairOutcome = { ok: boolean } & CodedText;

export function repairOutcome(ok: boolean, message: WorkerMessage): RepairOutcome {
  return { ok, ...coded(message) };
}

export function describeRepairReply(reply: BridgeRepairResultMessage | 'timeout'): RepairOutcome {
  if (reply === 'timeout') return repairOutcome(false, { code: 'repair-no-answer' });
  if (reply.ok) return repairOutcome(true, { code: 'repair-restarting' });
  return repairOutcome(false, { code: 'repair-failed', values: { detail: reply.error } });
}

export function describeReconnectResults(results: ReadonlyArray<{ ok: boolean }>): RepairOutcome {
  const reconnected = results.filter((r) => r.ok).length;
  if (reconnected === 0) return repairOutcome(false, NO_SERVER);
  return repairOutcome(true, {
    code: 'repair-reconnected',
    values: { reconnected, total: results.length },
  });
}
