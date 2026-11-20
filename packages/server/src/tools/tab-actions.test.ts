import { afterEach, describe, expect, test } from 'vitest';
import { noteTabAction, resetTabActionsForTest, tabActedSince } from './tab-actions.js';

afterEach(() => {
  resetTabActionsForTest();
});

describe('tab actions (wait_for_tab on a cdp: opener)', () => {
  test('a tab that never acted has not acted since any time', () => {
    expect(tabActedSince('cdp:A', 0)).toBe(false);
  });

  test('an action at or after the bound counts; one before it does not', () => {
    noteTabAction('cdp:A', 1_000);
    expect(tabActedSince('cdp:A', 1_000)).toBe(true);
    expect(tabActedSince('cdp:A', 999)).toBe(true);
    expect(tabActedSince('cdp:A', 1_001)).toBe(false);
    expect(tabActedSince('cdp:B', 0)).toBe(false);
  });

  test('the latest note wins', () => {
    noteTabAction('cdp:A', 1_000);
    noteTabAction('cdp:A', 5_000);
    expect(tabActedSince('cdp:A', 4_000)).toBe(true);
  });
});
