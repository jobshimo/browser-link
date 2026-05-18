import { describe, expect, test } from 'vitest';
import { BridgeEventLog } from './events.js';

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
