// The Activity and Admin windows' questions to the server (design 6.1, slice
// 21): trail reads and purges, the console's description and actions, each a
// correlated round trip over any connected tab's socket (`app/connection.ts`
// `roundTrip`). No `chrome`.

import type { AdminRequestLanguage, ExtensionToServer } from '@browser-link/shared';
import type { TabRegistry } from '@browser-link/core';
import {
  anyOpenSocket,
  roundTrip,
  type ActivityReply,
  type AdminReply,
  type BridgeReplies,
} from './connection.js';
import type { TabConnection } from './tab-connection.js';

/** How long a trail READ waits before giving up. Short: this is a local
 * SQLite read over a loopback socket. If it has not answered in two seconds
 * the bridge is wedged, and the window should say so rather than spin. */
export const ACTIVITY_QUERY_TIMEOUT_MS = 2_000;

/** A purge gets far longer. Deleting rows is quick; the VACUUM that follows
 * rewrites the whole file, and on a trail that grew to hundreds of megabytes
 * — precisely the case the user is purging to fix — that is not a two-second
 * operation. Timing out early would leave the window claiming failure over
 * work that actually succeeded. */
export const ACTIVITY_PURGE_TIMEOUT_MS = 60_000;

/** Describing and most actions are local config reads and writes. */
export const ADMIN_TIMEOUT_MS = 5_000;
/** `doctor` probes ports and processes server-side and is slow by nature. */
export const ADMIN_DOCTOR_TIMEOUT_MS = 20_000;

export interface ActivityAdminDeps {
  tabs: TabRegistry<TabConnection>;
  replies: Pick<BridgeReplies, 'activity' | 'admin'>;
}

export interface PurgeInput {
  from?: string;
  to?: string;
  dryRun?: boolean;
}

export interface AdminActionInput {
  id: string;
  value?: string | number | boolean;
  code?: string;
  language?: unknown;
}

export interface ActivityAdmin {
  queryActivity(query: Record<string, unknown>): Promise<ActivityReply>;
  purgeActivity(input: PurgeInput): Promise<ActivityReply>;
  adminDescribe(language: unknown): Promise<AdminReply>;
  adminAction(input: AdminActionInput): Promise<AdminReply>;
}

/** The window's language when it is one the server speaks; otherwise
 * nothing, and the server uses its configured language. */
function adminLanguageField(language: unknown): { language?: AdminRequestLanguage } {
  return language === 'en' || language === 'es' ? { language } : {};
}

/** Stateless: the waiting requests live in the `replies` it is given. */
export function createActivityAdmin(deps: ActivityAdminDeps): ActivityAdmin {
  /**
   * One correlated round trip to the server over any connected tab's socket.
   *
   * The trail is server-side and global, so which tab carries the question is
   * irrelevant — but at least one tab must be connected, because the WS is the
   * only channel the extension has. That is why the window renders an explicit
   * "connect a tab" state rather than an empty list: empty and unreachable are
   * different facts and must not look the same.
   */
  async function activityRoundTrip(
    frame: (requestId: string) => ExtensionToServer,
    timeoutMs: number,
  ): Promise<ActivityReply> {
    const socket = anyOpenSocket(deps.tabs);
    if (!socket) {
      return { kind: 'activity.result', request_id: '', ok: false, error: 'not-connected' };
    }
    return roundTrip(deps.replies.activity, socket, frame, timeoutMs, (request_id) => ({
      kind: 'activity.result',
      request_id,
      ok: false,
      error: 'timeout',
    }));
  }

  /**
   * One correlated admin round trip over any connected tab's socket — the same
   * shape as `activityRoundTrip`. `onFailure` builds the reply kind the caller
   * expects, so `not-connected` and `timeout` reach the popup in the same
   * envelope a real answer would.
   */
  async function adminRoundTrip(
    frame: (requestId: string) => ExtensionToServer,
    timeoutMs: number,
    onFailure: (requestId: string, error: string) => AdminReply,
  ): Promise<AdminReply> {
    const socket = anyOpenSocket(deps.tabs);
    if (!socket) return onFailure('', 'not-connected');
    return roundTrip(deps.replies.admin, socket, frame, timeoutMs, (requestId) =>
      onFailure(requestId, 'timeout'),
    );
  }

  return {
    queryActivity: (query) =>
      activityRoundTrip(
        (request_id) => ({ kind: 'activity.query', request_id, query }),
        ACTIVITY_QUERY_TIMEOUT_MS,
      ),
    purgeActivity: (input) =>
      activityRoundTrip(
        (request_id) => ({
          kind: 'activity.purge',
          request_id,
          ...(input.from !== undefined ? { from: input.from } : {}),
          ...(input.to !== undefined ? { to: input.to } : {}),
          ...(input.dryRun === true ? { dry_run: true } : {}),
        }),
        // A dry run only counts — no VACUUM, so it gets the short budget.
        input.dryRun === true ? ACTIVITY_QUERY_TIMEOUT_MS : ACTIVITY_PURGE_TIMEOUT_MS,
      ),
    adminDescribe: (language) =>
      adminRoundTrip(
        (request_id) => ({ kind: 'admin.describe', request_id, ...adminLanguageField(language) }),
        ADMIN_TIMEOUT_MS,
        (request_id, error) => ({ kind: 'admin.state', request_id, ok: false, error }),
      ),
    adminAction: (input) =>
      adminRoundTrip(
        (request_id) => ({
          kind: 'admin.action',
          request_id,
          id: input.id,
          ...(input.value !== undefined ? { value: input.value } : {}),
          ...(input.code !== undefined ? { code: input.code } : {}),
          ...adminLanguageField(input.language),
        }),
        input.id === 'doctor' ? ADMIN_DOCTOR_TIMEOUT_MS : ADMIN_TIMEOUT_MS,
        (request_id, error) => ({
          kind: 'admin.action.result',
          request_id,
          result: { ok: false, error },
        }),
      ),
  };
}
