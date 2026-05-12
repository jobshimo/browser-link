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
});
