import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  TabClaimRegistry,
  formatClaimConflict,
  type AgentCaller,
  type ClaimEvent,
} from './tab-claims.js';

const A: AgentCaller = { agent_id: 'sess-A', pid: 1001, binary: 'node', label: 'claude-code' };
const B: AgentCaller = { agent_id: 'sess-B', pid: 1002, binary: 'node', label: 'opencode' };

describe('TabClaimRegistry', () => {
  let now: number;
  let events: ClaimEvent[];
  let registry: TabClaimRegistry;

  beforeEach(() => {
    now = 1_000_000;
    events = [];
    registry = new TabClaimRegistry({
      defaultTtlMinutes: 10,
      maxTtlMinutes: 60,
      nowMs: () => now,
      onEvent: (e) => events.push(e),
    });
  });

  test('first claim creates the entry and emits tab-claimed', () => {
    const result = registry.claim('tab_1', A);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(true);
    expect(result.claim.agent_id).toBe('sess-A');
    expect(result.claim.label).toBe('claude-code');
    expect(events).toEqual([
      expect.objectContaining({
        kind: 'tab-claimed',
        tab_id: 'tab_1',
        agent_id: 'sess-A',
        auto: false,
      }),
    ]);
  });

  test('re-claim by the same agent refreshes activity and does NOT re-emit tab-claimed', () => {
    registry.claim('tab_1', A);
    events.length = 0;
    now += 5 * 60_000;
    const result = registry.claim('tab_1', A);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(false);
    expect(result.claim.last_activity_at).toBe(now);
    expect(events).toEqual([]);
  });

  test('claim by another agent on a held tab is rejected and emits tab-claim-rejected', () => {
    registry.claim('tab_1', A);
    events.length = 0;
    const result = registry.claim('tab_1', B);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('conflict');
    expect(result.existing.agent_id).toBe('sess-A');
    expect(events).toEqual([
      expect.objectContaining({
        kind: 'tab-claim-rejected',
        tab_id: 'tab_1',
        requester_agent_id: 'sess-B',
        existing_agent_id: 'sess-A',
      }),
    ]);
  });

  test('claim that has gone stale lets another agent take over and emits both released-by-ttl and claimed', () => {
    registry.claim('tab_1', A, { ttlMinutes: 1 });
    now += 60_001;
    events.length = 0;
    const result = registry.claim('tab_1', B);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.claim.agent_id).toBe('sess-B');
    expect(events.map((e) => e.kind)).toEqual(['tab-released', 'tab-claimed']);
    const [released, claimed] = events;
    expect(released).toMatchObject({ kind: 'tab-released', reason: 'ttl', agent_id: 'sess-A' });
    expect(claimed).toMatchObject({ kind: 'tab-claimed', agent_id: 'sess-B', auto: false });
  });

  test('ensureActionAllowed auto-claims a free tab and marks the event as auto', () => {
    const result = registry.ensureActionAllowed('tab_1', A);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(true);
    expect(events).toEqual([expect.objectContaining({ kind: 'tab-claimed', auto: true })]);
  });

  test('ensureActionAllowed refreshes the owner activity without emitting', () => {
    registry.claim('tab_1', A);
    events.length = 0;
    now += 30_000;
    const result = registry.ensureActionAllowed('tab_1', A);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.claim.last_activity_at).toBe(now);
    expect(events).toEqual([]);
  });

  test('ensureActionAllowed rejects when another agent owns the tab', () => {
    registry.claim('tab_1', A);
    events.length = 0;
    const result = registry.ensureActionAllowed('tab_1', B);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.existing.agent_id).toBe('sess-A');
  });

  test('release by the owner clears the claim', () => {
    registry.claim('tab_1', A);
    events.length = 0;
    const result = registry.release('tab_1', A);
    expect(result.ok).toBe(true);
    expect(registry.getClaim('tab_1')).toBeNull();
    expect(events).toEqual([
      expect.objectContaining({ kind: 'tab-released', reason: 'explicit', agent_id: 'sess-A' }),
    ]);
  });

  test('release by a non-owner is rejected and does NOT touch the claim', () => {
    registry.claim('tab_1', A);
    events.length = 0;
    const result = registry.release('tab_1', B);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('not-owner');
    expect(registry.getClaim('tab_1')?.agent_id).toBe('sess-A');
    expect(events).toEqual([]);
  });

  test('release on a free tab reports not-claimed', () => {
    const result = registry.release('tab_1', A);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('not-claimed');
  });

  test('myTabs returns only the caller’s claims, sorted by claimed_at', () => {
    registry.claim('tab_1', A);
    now += 1000;
    registry.claim('tab_2', B);
    now += 1000;
    registry.claim('tab_3', A);
    const mine = registry.myTabs(A);
    expect(mine.map((c) => c.tab_id)).toEqual(['tab_1', 'tab_3']);
    expect(registry.myTabs(B).map((c) => c.tab_id)).toEqual(['tab_2']);
  });

  test('onAgentDisconnect drops every claim held by the agent and emits one tab-released per claim', () => {
    registry.claim('tab_1', A);
    registry.claim('tab_2', B);
    registry.claim('tab_3', A);
    events.length = 0;
    const released = registry.onAgentDisconnect('sess-A');
    expect(released.map((c) => c.tab_id).sort()).toEqual(['tab_1', 'tab_3']);
    expect(registry.size()).toBe(1);
    expect(registry.getClaim('tab_2')?.agent_id).toBe('sess-B');
    expect(events.map((e) => e.kind)).toEqual(['tab-released', 'tab-released']);
    for (const e of events) {
      expect(e).toMatchObject({ reason: 'agent-disconnect', agent_id: 'sess-A' });
    }
  });

  test('pruneStale drops claims past their TTL', () => {
    registry.claim('tab_1', A, { ttlMinutes: 1 });
    registry.claim('tab_2', B, { ttlMinutes: 5 });
    now += 90_000;
    events.length = 0;
    const expired = registry.pruneStale();
    expect(expired.map((c) => c.tab_id)).toEqual(['tab_1']);
    expect(registry.getClaim('tab_1')).toBeNull();
    expect(registry.getClaim('tab_2')?.agent_id).toBe('sess-B');
    expect(events).toEqual([
      expect.objectContaining({ kind: 'tab-released', reason: 'ttl', agent_id: 'sess-A' }),
    ]);
  });

  test('TTL is clamped to maxTtlMinutes', () => {
    const result = registry.claim('tab_1', A, { ttlMinutes: 999 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.claim.ttl_ms).toBe(60 * 60_000);
  });

  test('label provided at claim time wins over the caller default and persists across refresh', () => {
    registry.claim('tab_1', A, { label: 'custom-label' });
    now += 10_000;
    registry.ensureActionAllowed('tab_1', A);
    expect(registry.getClaim('tab_1')?.label).toBe('custom-label');
  });
});

describe('formatClaimConflict', () => {
  test('includes the existing label, caller agent_id and approximate age', () => {
    const baseNow = 5_000_000;
    const existing = {
      tab_id: 'tab_7',
      agent_id: 'sess-X',
      pid: 4242,
      binary: 'node',
      label: 'opencode',
      claimed_at: baseNow - 3 * 60_000,
      last_activity_at: baseNow - 30_000,
      ttl_ms: 10 * 60_000,
    };
    const msg = formatClaimConflict(A, existing, baseNow);
    expect(msg).toContain('Tab tab_7 is in use by another agent (opencode');
    expect(msg).toContain('agent_id=sess-X');
    expect(msg).toContain('for 3 min');
    expect(msg).toContain('Your agent_id is sess-A');
  });

  test('falls back to pid when no label is set', () => {
    const existing = {
      tab_id: 'tab_7',
      agent_id: 'sess-X',
      pid: 4242,
      binary: 'node',
      claimed_at: 0,
      last_activity_at: 0,
      ttl_ms: 60_000,
    };
    const msg = formatClaimConflict(A, existing, 60_000);
    expect(msg).toContain('(pid 4242');
  });
});

describe('TabClaimRegistry default time source', () => {
  test('uses Date.now() when nowMs is not injected', () => {
    const spy = vi.spyOn(Date, 'now').mockReturnValue(123_456_789);
    const reg = new TabClaimRegistry();
    const r = reg.claim('tab_1', A);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.claim.claimed_at).toBe(123_456_789);
    spy.mockRestore();
  });
});
