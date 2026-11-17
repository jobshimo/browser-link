import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as paths from '../map/paths.js';
import { saveConfig } from '../config.js';
import {
  TabClaimRegistry,
  followFlowFinishedEvents,
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

describe('TabClaimRegistry flow holds (owner decision D1)', () => {
  const MIN = 60_000;
  let now: number;
  let events: ClaimEvent[];
  let registry: TabClaimRegistry;

  beforeEach(() => {
    now = 1_000_000;
    events = [];
    registry = new TabClaimRegistry({
      defaultTtlMinutes: 10,
      nowMs: () => now,
      onEvent: (e) => events.push(e),
    });
  });

  test('pruneStale keeps a claim a running flow holds, and drops it once the clock runs out after the release', () => {
    registry.claim('tab_1', A);
    registry.holdForFlow('tab_1', A.agent_id, 'f1', 30 * MIN);
    now += 20 * MIN;
    expect(registry.pruneStale()).toEqual([]);
    registry.releaseFlowHold('f1');
    now += 10 * MIN - 1;
    expect(registry.pruneStale()).toEqual([]);
    now += 1;
    expect(registry.pruneStale().map((c) => c.tab_id)).toEqual(['tab_1']);
    expect(events.at(-1)).toMatchObject({ kind: 'tab-released', reason: 'ttl' });
  });

  test("a hold covers only its own agent's claim", () => {
    registry.claim('tab_1', A);
    registry.holdForFlow('tab_1', B.agent_id, 'f1', 30 * MIN);
    now += 10 * MIN;
    expect(registry.getClaim('tab_1')).toBeNull();
    expect(registry.ensureActionAllowed('tab_1', B).ok).toBe(true);
  });

  test('another agent is refused while the hold lasts and allowed once the claim really expires', () => {
    registry.claim('tab_1', A);
    registry.holdForFlow('tab_1', A.agent_id, 'f1', 30 * MIN);
    now += 15 * MIN;
    expect(registry.ensureActionAllowed('tab_1', B)).toMatchObject({
      ok: false,
      reason: 'conflict',
    });
    registry.releaseFlowHold('f1');
    now += 10 * MIN;
    expect(registry.ensureActionAllowed('tab_1', B)).toMatchObject({ ok: true, created: true });
  });

  test('a late release dates the last step from the flow start, never later than now', () => {
    registry.claim('tab_1', A);
    registry.holdForFlow('tab_1', A.agent_id, 'f1', 30 * MIN);
    now += 25 * MIN;
    registry.releaseFlowHold('f1', 18 * MIN);
    expect(registry.getClaim('tab_1')?.last_activity_at).toBe(1_000_000 + 18 * MIN);
    registry.claim('tab_2', A);
    registry.holdForFlow('tab_2', A.agent_id, 'f2', 30 * MIN);
    registry.releaseFlowHold('f2', 99 * MIN);
    expect(registry.getClaim('tab_2')?.last_activity_at).toBe(now);
  });

  test('a release never moves the clock backwards', () => {
    registry.claim('tab_1', A);
    registry.holdForFlow('tab_1', A.agent_id, 'f1', 30 * MIN);
    now += 5 * MIN;
    registry.ensureActionAllowed('tab_1', A);
    registry.releaseFlowHold('f1', 1 * MIN);
    expect(registry.getClaim('tab_1')?.last_activity_at).toBe(now);
  });

  test('past its bound a hold stops holding and the clock counts from the bound', () => {
    registry.claim('tab_1', A);
    registry.holdForFlow('tab_1', A.agent_id, 'f1', 30 * MIN);
    now += 30 * MIN;
    expect(registry.getClaim('tab_1')?.last_activity_at).toBe(1_000_000 + 30 * MIN);
    now += 10 * MIN;
    expect(registry.getClaim('tab_1')).toBeNull();
    // A summary arriving after the bound changes nothing.
    registry.releaseFlowHold('f1', 35 * MIN);
    expect(registry.getClaim('tab_1')).toBeNull();
  });

  test('releasing an unknown flow is a no-op', () => {
    registry.claim('tab_1', A);
    now += 5 * MIN;
    registry.releaseFlowHold('nope');
    expect(registry.getClaim('tab_1')?.last_activity_at).toBe(1_000_000);
  });

  test('a hold registered before the claim exists covers the claim the flow then makes', () => {
    registry.holdForFlow('tab_1', A.agent_id, 'f1', 30 * MIN);
    registry.ensureActionAllowed('tab_1', A);
    now += 20 * MIN;
    expect(registry.getClaim('tab_1')?.agent_id).toBe(A.agent_id);
  });
});

describe('followFlowFinishedEvents', () => {
  test('releases the hold named by a flow-finished event, dated by its duration, and nothing else', () => {
    let now = 1_000_000;
    const registry = new TabClaimRegistry({ defaultTtlMinutes: 10, nowMs: () => now });
    let listener: ((e: { kind: string; data: Record<string, unknown> }) => void) | undefined;
    const unsubscribe = vi.fn();
    const off = followFlowFinishedEvents(registry, (fn) => {
      listener = fn;
      return unsubscribe;
    });
    registry.claim('tab_1', A);
    registry.holdForFlow('tab_1', A.agent_id, 'f1', 30 * 60_000);
    now += 20 * 60_000;
    listener!({ kind: 'tab-created', data: { flow_id: 'f1' } });
    listener!({ kind: 'flow-finished', data: { flow_id: 42 } });
    expect(registry.getClaim('tab_1')?.last_activity_at).toBe(1_000_000);
    listener!({ kind: 'flow-finished', data: { flow_id: 'f1', duration_ms: 12 * 60_000 } });
    expect(registry.getClaim('tab_1')?.last_activity_at).toBe(1_000_000 + 12 * 60_000);
    off();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});

describe('TabClaimRegistry — the claim expiry is a console setting (S3)', () => {
  const MIN = 60_000;
  let now: number;

  beforeEach(() => {
    now = 1_000_000;
  });

  test('0 ("never"): a claim made without ttl_minutes never expires by inactivity, and says so with ttl_ms null', () => {
    const registry = new TabClaimRegistry({ defaultTtlMinutes: 0, nowMs: () => now });
    const made = registry.ensureActionAllowed('tab_1', A);
    expect(made.ok && made.claim.ttl_ms).toBeNull();
    now += 7 * 24 * 60 * MIN;
    expect(registry.pruneStale()).toEqual([]);
    expect(registry.getClaim('tab_1')?.agent_id).toBe(A.agent_id);
    expect(registry.claim('tab_1', B)).toMatchObject({ ok: false, reason: 'conflict' });
  });

  test('"never" still lets the owner release, a disconnect drop and a reset clear the claim', () => {
    const registry = new TabClaimRegistry({ defaultTtlMinutes: 0, nowMs: () => now });
    registry.claim('tab_1', A);
    registry.claim('tab_2', A);
    registry.claim('tab_3', B);
    expect(registry.release('tab_1', A)).toEqual({ ok: true });
    expect(registry.onAgentDisconnect(A.agent_id).map((c) => c.tab_id)).toEqual(['tab_2']);
    expect(registry.releaseAll().map((c) => c.tab_id)).toEqual(['tab_3']);
  });

  test('the configured value is read live: a change applies to every claim that did not ask for its own ttl', () => {
    let configured = 10;
    const registry = new TabClaimRegistry({
      defaultTtlMinutes: () => configured,
      nowMs: () => now,
    });
    registry.ensureActionAllowed('tab_1', A);
    registry.claim('tab_2', B, { ttlMinutes: 5 });
    configured = 30;
    now += 20 * MIN;
    expect(registry.getClaim('tab_1')).toMatchObject({ agent_id: A.agent_id, ttl_ms: 30 * MIN });
    // An agent's own ttl_minutes is its choice and is kept.
    expect(registry.getClaim('tab_2')).toBeNull();
    configured = 0;
    now += 60 * MIN;
    expect(registry.pruneStale()).toEqual([]);
    expect(registry.getClaim('tab_1')?.ttl_ms).toBeNull();
  });

  test('a configured value above the 60-minute cap applies: the cap bounds what an agent asks, not the console', () => {
    const registry = new TabClaimRegistry({ defaultTtlMinutes: 120, nowMs: () => now });
    registry.ensureActionAllowed('tab_1', A);
    now += 119 * MIN;
    expect(registry.pruneStale()).toEqual([]);
    now += MIN;
    expect(registry.pruneStale().map((c) => c.tab_id)).toEqual(['tab_1']);
  });
});

describe('TabClaimRegistry — without an explicit default it reads claim-ttl from config.json (S3)', () => {
  let dataDir: string;
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'browser-link-claim-ttl-'));
    spy = vi.spyOn(paths, 'getDataDir').mockReturnValue(dataDir);
  });

  afterEach(() => {
    spy.mockRestore();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test('no setting: 10 minutes; `config set claim-ttl never` applies to the next check', () => {
    let now = 1_000_000;
    const registry = new TabClaimRegistry({ nowMs: () => now });
    const made = registry.ensureActionAllowed('tab_1', A);
    expect(made.ok && made.claim.ttl_ms).toBe(10 * 60_000);
    saveConfig({ claimTtlMinutes: 0 });
    now += 11 * 60_000;
    expect(registry.pruneStale()).toEqual([]);
    saveConfig({ claimTtlMinutes: 3 });
    expect(registry.pruneStale().map((c) => c.tab_id)).toEqual(['tab_1']);
  });

  test('a hand-edited value out of range reads as the 10-minute default', () => {
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ claimTtlMinutes: 'soon' }));
    const registry = new TabClaimRegistry({ nowMs: () => 1_000_000 });
    const made = registry.ensureActionAllowed('tab_1', A);
    expect(made.ok && made.claim.ttl_ms).toBe(10 * 60_000);
  });
});
