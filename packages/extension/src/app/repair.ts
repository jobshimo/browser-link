// "Repair connection" (popup button) and the version summary it reads
// (design 6.1, slice 21). The decision lives in `repair-policy.ts`; this is
// the thin wiring that gathers its inputs and carries out the step. No
// `chrome`: `background.ts` passes in the session storage, the connect path
// and the extension's version.

import type { PendingReplies, TabRegistry } from '@browser-link/core';
import type { ReconnectScheduler } from '../reconnect-policy.js';
import {
  REPAIR_TIMEOUT_MS,
  describeReconnectResults,
  describeRepairReply,
  planRepair,
  rememberedTabIds,
  repairOutcome,
  type RepairOutcome,
} from '../repair-policy.js';
import { computeVersionCheck, type VersionCheck } from '../version-status.js';
import {
  anyOpenSocket,
  roundTrip,
  type ConnectResult,
  type RepairReply,
  type SessionStorage,
} from './connection.js';
import type { BridgeSocket, TabConnection } from './tab-connection.js';

/**
 * The version-mismatch summary for the popup. Picks the `serverVersion`
 * reported by ANY currently-connected tab — they all come from the same
 * primary, so the first one is enough. When no tab has registered yet (e.g.
 * user just installed and hasn't pressed Connect), `server` stays null and
 * the popup hides the banner.
 */
export function currentVersionCheck(
  tabs: TabRegistry<TabConnection>,
  extension: string,
): VersionCheck {
  let server: string | null = null;
  let installed: string | null = null;
  for (const s of tabs.values()) {
    if (typeof s.serverVersion === 'string' && s.serverVersion.length > 0) {
      server = s.serverVersion;
      installed =
        typeof s.installedVersion === 'string' && s.installedVersion.length > 0
          ? s.installedVersion
          : null;
      break;
    }
  }
  return computeVersionCheck({ extension, server, installed });
}

export interface RepairDeps {
  tabs: TabRegistry<TabConnection>;
  storage: Pick<SessionStorage, 'get'>;
  replies: PendingReplies<RepairReply>;
  scheduler: Pick<ReconnectScheduler, 'cancel'>;
  connect(tabId: number): Promise<ConnectResult>;
  /** The extension's version (`Runtime.manifestVersion`). */
  extensionVersion(): string;
}

async function readRememberedTabIds(storage: Pick<SessionStorage, 'get'>): Promise<number[]> {
  try {
    return rememberedTabIds(await storage.get(null));
  } catch {
    return [];
  }
}

/** Send `bridge.repair` on one open socket and wait for the answer. On
 * success the server drops every socket uncleanly and the existing
 * auto-reconnect scheduler brings the tabs back; nothing else to do here. */
function askServerRestart(
  replies: PendingReplies<RepairReply>,
  socket: BridgeSocket,
): Promise<RepairOutcome> {
  return roundTrip(
    replies,
    socket,
    (request_id) => ({ kind: 'bridge.repair', request_id }),
    REPAIR_TIMEOUT_MS,
    () => 'timeout' as const,
  ).then(describeRepairReply);
}

/** Carry out the repair step `planRepair` picks. */
export async function repairConnection(deps: RepairDeps): Promise<RepairOutcome> {
  const socket = anyOpenSocket(deps.tabs);
  const plan = planRepair({
    connected: socket !== undefined,
    serverVersion: currentVersionCheck(deps.tabs, deps.extensionVersion()).server,
    rememberedTabIds: await readRememberedTabIds(deps.storage),
  });
  switch (plan.step) {
    case 'ask-server-restart':
      // `planRepair` only picks this step when a socket is open.
      return socket
        ? askServerRestart(deps.replies, socket)
        : repairOutcome(false, { code: 'server-not-connected' });
    case 'reconnect-only': {
      // Same path as the popup's Connect: an explicit attempt replaces any
      // pending auto-reconnect for the tab, and connectTab's per-tab lock
      // turns a race with an in-flight retry into a benign result.
      const results = await Promise.all(
        plan.tabIds.map(async (tabId) => {
          deps.scheduler.cancel(tabId);
          try {
            return await deps.connect(tabId);
          } catch {
            return { ok: false };
          }
        }),
      );
      return describeReconnectResults(results);
    }
    case 'manual': {
      const { step: _step, reason: _reason, ...outcome } = plan;
      return { ok: false, ...outcome };
    }
  }
}
