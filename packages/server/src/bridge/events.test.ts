import { describe, expect, test } from 'vitest';
import { BridgeEventLog, isExtensionEventKind } from './events.js';

describe('BridgeEventLog', () => {
  test('assigns monotonic ids starting at 1', () => {
    const log = new BridgeEventLog();
    const a = log.add('primary-elected', { reason: 'startup' });
    const b = log.add('tab-registered', { tabId: 'tab_1', url: 'https://x' });
    expect(a.id).toBe(1);
    expect(b.id).toBe(2);
  });

  test('records timestamp as ISO 8601', () => {
    const log = new BridgeEventLog();
    const e = log.add('primary-elected');
    expect(e.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('recent() respects sinceId cursor', () => {
    const log = new BridgeEventLog();
    for (let i = 0; i < 5; i++) log.add('tab-registered', { tabId: `tab_${i}` });
    const r = log.recent({ sinceId: 2 });
    expect(r.map((e) => e.id)).toEqual([3, 4, 5]);
  });

  test('recent() respects limit', () => {
    const log = new BridgeEventLog();
    for (let i = 0; i < 50; i++) log.add('tab-registered', { tabId: `tab_${i}` });
    const r = log.recent({ limit: 5 });
    expect(r.length).toBe(5);
    expect(r[r.length - 1]!.id).toBe(50);
  });

  test('drops oldest when buffer exceeds 200', () => {
    const log = new BridgeEventLog();
    for (let i = 0; i < 250; i++) log.add('tab-registered', { tabId: `tab_${i}` });
    expect(log.size()).toBe(200);
    expect(log.latestId()).toBe(250);
    const r = log.recent({ limit: 200 });
    // The first 50 (ids 1..50) were evicted.
    expect(r[0]!.id).toBe(51);
    expect(r[r.length - 1]!.id).toBe(250);
  });

  test('latestId returns 0 on an empty log', () => {
    expect(new BridgeEventLog().latestId()).toBe(0);
  });

  test('different kinds round-trip', () => {
    const log = new BridgeEventLog();
    log.add('primary-elected');
    log.add('tab-registered', { tabId: 'tab_1' });
    log.add('tab-disconnected', { tabId: 'tab_1' });
    log.add('tab-renamed', { previous: 'tab_1', current: 'tab_2' });
    expect(log.recent().map((e) => e.kind)).toEqual([
      'primary-elected',
      'tab-registered',
      'tab-disconnected',
      'tab-renamed',
    ]);
  });

  test('subscribe receives events added after registration', () => {
    const log = new BridgeEventLog();
    const seen: number[] = [];
    const unsub = log.subscribe((e) => seen.push(e.id));
    log.add('tab-registered', { tabId: 'tab_1' });
    log.add('tab-registered', { tabId: 'tab_2' });
    unsub();
    log.add('tab-registered', { tabId: 'tab_3' }); // after unsubscribe — ignored
    expect(seen).toEqual([1, 2]);
  });

  test('subscribe replays recent events when replayWithinMs is set', () => {
    const log = new BridgeEventLog();
    // Backdate two events: one inside the window, one outside.
    log.add('tab-created', { tab_id: 'tab_old', opened_from: 'tab_X' });
    log.add('tab-created', { tab_id: 'tab_fresh', opened_from: 'tab_X' });
    // Tamper with `at` so we exercise the replay cutoff deterministically.
    const fresh = log.recent({ limit: 1 })[0]!;
    const ageOldMs = 5_000;
    const ageFreshMs = 200;
    const now = Date.now();
    // Mutate timestamps on the buffer entries via recent() — they share refs.
    const all = log.recent({ limit: 200 });
    all[0]!.at = new Date(now - ageOldMs).toISOString();
    all[1]!.at = new Date(now - ageFreshMs).toISOString();

    const seenIds: number[] = [];
    const unsub = log.subscribe((e) => seenIds.push(e.id), { replayWithinMs: 1500 });
    unsub();
    // Only the fresh one is within 1500 ms.
    expect(seenIds).toEqual([fresh.id]);
  });

  test('subscribe with replayWithinMs does not double-fire on subsequent adds', () => {
    const log = new BridgeEventLog();
    log.add('tab-created', { tab_id: 'tab_old', opened_from: 'tab_X' });
    const seen: number[] = [];
    const unsub = log.subscribe((e) => seen.push(e.id), { replayWithinMs: 60_000 });
    log.add('tab-created', { tab_id: 'tab_new', opened_from: 'tab_X' });
    unsub();
    // Replay delivered id=1, live delivery delivered id=2 — no duplicates.
    expect(seen).toEqual([1, 2]);
  });

  test('a listener throwing does not prevent siblings from firing', () => {
    const log = new BridgeEventLog();
    const seen: number[] = [];
    const unsubBad = log.subscribe(() => {
      throw new Error('listener boom');
    });
    const unsubGood = log.subscribe((e) => seen.push(e.id));
    log.add('tab-registered', { tabId: 'tab_1' });
    unsubBad();
    unsubGood();
    expect(seen).toEqual([1]);
  });
});

/*
 * The audit half of detached execution. `flow-finished` is the ONE event a
 * detached flow emits, and the reason it is one rather than one per
 * iteration is right here: the buffer holds 200 entries, so a single
 * 200-iteration run emitting per-iteration events would silently evict
 * every other event in the log — turning the thing meant to make bulk work
 * auditable into the thing that destroys the audit trail.
 */
describe('flow-finished — the one-per-flow audit event', () => {
  test('the extension may push it (unlike the server-owned kinds)', () => {
    expect(isExtensionEventKind('flow-finished')).toBe(true);
    // Still closed against everything a renderer must not be able to
    // fabricate.
    expect(isExtensionEventKind('flow-recorded')).toBe(false);
    expect(isExtensionEventKind('primary-elected')).toBe(false);
    expect(isExtensionEventKind('tab-registered')).toBe(false);
  });

  test('a 200-iteration detached flow evicts nothing — it is ONE entry', () => {
    const log = new BridgeEventLog();
    for (let i = 0; i < 20; i++) log.add('tab-registered', { tabId: `tab_${i}` });

    log.add('flow-finished', {
      flow_id: 'flow_bulk',
      state: 'completed',
      detached: true,
      steps: 1,
      steps_completed: 1,
      iterations_completed: 200,
      duration_ms: 240_000,
    });

    expect(log.size()).toBe(21);
    // Every unrelated entry is still readable, ids intact.
    const all = log.recent({ limit: 200 });
    expect(all).toHaveLength(21);
    expect(all[0].kind).toBe('tab-registered');
    expect(all[0].id).toBe(1);
    expect(all[20].kind).toBe('flow-finished');
  });

  test('for contrast: one event per iteration WOULD wipe the log', () => {
    // Not a behaviour we ship — a guard on the reasoning, so a future
    // "richer progress events" idea meets this test before it meets a user.
    const log = new BridgeEventLog();
    log.add('tab-registered', { tabId: 'tab_1' });
    for (let i = 0; i < 200; i++) log.add('flow-finished', { iteration: i });

    expect(log.size()).toBe(200);
    expect(log.recent({ limit: 200 }).some((e) => e.kind === 'tab-registered')).toBe(false);
  });
});
