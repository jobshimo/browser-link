// The Activity and Admin round trips (design 6.1, slice 21) on fakes: the
// frame each sends, `not-connected` without a socket, and the timeout each
// waits, answered in the envelope its window expects.
import { describe, expect, it } from 'vitest';
import type { ExtensionToServer } from '@browser-link/shared';
import {
  createManualClock,
  PendingReplies,
  TabRegistry,
  TabSession,
  type PageDriverHandle,
} from '@browser-link/core';
import {
  ACTIVITY_PURGE_TIMEOUT_MS,
  ACTIVITY_QUERY_TIMEOUT_MS,
  ADMIN_DOCTOR_TIMEOUT_MS,
  ADMIN_TIMEOUT_MS,
  createActivityAdmin,
} from './activity-admin.js';
import { newTabConnection, SOCKET_OPEN, type BridgeSocket } from './tab-connection.js';
import type { TabConnection } from './tab-connection.js';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function harness({ connected = true } = {}) {
  const clock = createManualClock(1_000);
  const tabs = new TabRegistry<TabConnection>();
  const sent: ExtensionToServer[] = [];
  if (connected) {
    const driver = { observer: undefined } as unknown as PageDriverHandle;
    const state = newTabConnection(1, new TabSession({ clock, driver }), new Set());
    state.ws = {
      readyState: SOCKET_OPEN,
      send: (data: string) => {
        sent.push(JSON.parse(data) as ExtensionToServer);
      },
    } as unknown as BridgeSocket;
    tabs.commit(tabs.reserve(1)!, state);
  }
  const replies = { activity: new PendingReplies(clock), admin: new PendingReplies(clock) };
  const api = createActivityAdmin({ tabs, replies: replies as never });
  /** The answer once `ms` passed with no reply; pending before it. */
  const timesOutAfter = async (answer: Promise<unknown>, ms: number): Promise<unknown> => {
    let settled = false;
    void answer.then(() => {
      settled = true;
    });
    await flush();
    await clock.advance(ms - 1);
    await flush();
    expect(settled).toBe(false);
    await clock.advance(1);
    return answer;
  };
  return { api, sent, timesOutAfter };
}

const id = expect.any(String) as string;

describe('activity and admin round trips', () => {
  it('not connected: each answers not-connected in its own envelope', async () => {
    const { api } = harness({ connected: false });
    const activity = { kind: 'activity.result', request_id: '', ok: false, error: 'not-connected' };
    expect(await api.queryActivity({})).toEqual(activity);
    expect(await api.purgeActivity({})).toEqual(activity);
    expect(await api.adminDescribe('en')).toEqual({
      kind: 'admin.state',
      request_id: '',
      ok: false,
      error: 'not-connected',
    });
    expect(await api.adminAction({ id: 'x' })).toEqual({
      kind: 'admin.action.result',
      request_id: '',
      result: { ok: false, error: 'not-connected' },
    });
  });

  it('a trail read sends its query and times out after the short budget', async () => {
    const { api, sent, timesOutAfter } = harness();
    const answer = await timesOutAfter(api.queryActivity({ limit: 3 }), ACTIVITY_QUERY_TIMEOUT_MS);
    expect(sent).toEqual([{ kind: 'activity.query', request_id: id, query: { limit: 3 } }]);
    expect(answer).toEqual({
      kind: 'activity.result',
      request_id: id,
      ok: false,
      error: 'timeout',
    });
  });

  it('a purge sends only the bounds given and waits the long budget', async () => {
    const { api, sent, timesOutAfter } = harness();
    await timesOutAfter(api.purgeActivity({ from: 'a' }), ACTIVITY_PURGE_TIMEOUT_MS);
    expect(sent).toEqual([{ kind: 'activity.purge', request_id: id, from: 'a' }]);
  });

  it('a dry-run purge says so and waits the short budget', async () => {
    const { api, sent, timesOutAfter } = harness();
    await timesOutAfter(
      api.purgeActivity({ from: 'a', to: 'b', dryRun: true }),
      ACTIVITY_QUERY_TIMEOUT_MS,
    );
    expect(sent).toEqual([
      { kind: 'activity.purge', request_id: id, from: 'a', to: 'b', dry_run: true },
    ]);
  });

  it('describe forwards a language the server speaks, and no other', async () => {
    const { api, sent, timesOutAfter } = harness();
    const answer = await timesOutAfter(api.adminDescribe('es'), ADMIN_TIMEOUT_MS);
    await timesOutAfter(api.adminDescribe('fr'), ADMIN_TIMEOUT_MS);
    expect(sent).toEqual([
      { kind: 'admin.describe', request_id: id, language: 'es' },
      { kind: 'admin.describe', request_id: id },
    ]);
    expect(answer).toEqual({ kind: 'admin.state', request_id: id, ok: false, error: 'timeout' });
  });

  it('an action sends its fields; doctor waits the long budget', async () => {
    const { api, sent, timesOutAfter } = harness();
    const answer = await timesOutAfter(
      api.adminAction({ id: 'idle-ttl', value: 0, code: '42', language: 'en' }),
      ADMIN_TIMEOUT_MS,
    );
    await timesOutAfter(api.adminAction({ id: 'doctor' }), ADMIN_DOCTOR_TIMEOUT_MS);
    expect(sent).toEqual([
      {
        kind: 'admin.action',
        request_id: id,
        id: 'idle-ttl',
        value: 0,
        code: '42',
        language: 'en',
      },
      { kind: 'admin.action', request_id: id, id: 'doctor' },
    ]);
    expect(answer).toEqual({
      kind: 'admin.action.result',
      request_id: id,
      result: { ok: false, error: 'timeout' },
    });
  });
});
