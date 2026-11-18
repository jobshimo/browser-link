// What every `Alarms` guarantees (design 3.1; slice 19): an alarm set for a
// time fires its name through `onFire`, and a cleared one never fires. It
// runs against the in-memory fake under vitest (`src/app/alarms.test.ts`)
// and against the real `chrome.alarms` adapter inside the service worker
// (`entry.ts`, run by the e2e; R6). The names start with
// `CONTRACT_ALARM_PREFIX`, which `tabIdFromReconnectKey` rejects, so the
// product's own alarm listener ignores them.

import { type ContractCase, equal } from '@browser-link/core';
import type { Alarms } from '../src/app/connection.js';

export const CONTRACT_ALARM_PREFIX = 'browser-link-contract:';

/** How far ahead the cleared alarm is set; the kept one is set twice as far. */
export const CONTRACT_ALARM_DELAY_MS = 500;

export interface AlarmsHarness {
  alarms: Alarms;
  /** The subject's current time, ms since the epoch. */
  now(): number;
  /** Let time pass until `done` resolves; reject when it has not after `timeoutMs`. */
  until(done: Promise<void>, timeoutMs: number): Promise<void>;
  /** A name unique to this run. */
  runId(): string;
}

/** How long the contract waits for the kept alarm. */
export const CONTRACT_ALARM_TIMEOUT_MS = 90_000;

export function defineAlarmsContract(make: () => AlarmsHarness): ContractCase[] {
  return [
    {
      name: 'an alarm fires its name through onFire, and a cleared one never fires',
      run: async () => {
        const { alarms, now, until, runId } = make();
        const prefix = `${CONTRACT_ALARM_PREFIX}${runId()}:`;
        const cleared = `${prefix}cleared`;
        const kept = `${prefix}kept`;
        const fired: string[] = [];
        let keptFired = (): void => undefined;
        const done = new Promise<void>((resolve) => {
          keptFired = resolve;
        });
        alarms.onFire((name) => {
          if (!name.startsWith(prefix)) return;
          fired.push(name);
          if (name === kept) keptFired();
        });
        const start = now();
        await alarms.set(cleared, start + CONTRACT_ALARM_DELAY_MS);
        await alarms.clear(cleared);
        await alarms.set(kept, start + 2 * CONTRACT_ALARM_DELAY_MS);
        await until(done, CONTRACT_ALARM_TIMEOUT_MS);
        // Had `clear` not removed it, the earlier alarm would have fired first.
        equal(fired, [kept], 'alarms fired');
      },
    },
  ];
}
