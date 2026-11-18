// The `Alarms` contract against the in-memory fake (R6 condition 3), and RED
// probes showing it catches a broken subject. The same contract runs against
// `adapters/chrome-alarms.ts` inside the real service worker (contract/entry.ts).
import { describe, expect, it } from 'vitest';
import { createManualClock, type ContractCase } from '@browser-link/core';
import {
  CONTRACT_ALARM_PREFIX,
  defineAlarmsContract,
  type AlarmsHarness,
} from '../../contract/alarms.contract.js';
import { createMemoryAlarms } from '../../contract/memory-alarms.js';
import { tabIdFromReconnectKey } from '../reconnect-policy.js';
import type { Alarms } from './connection.js';

function harness(wrap: (alarms: Alarms) => Alarms = (a) => a): AlarmsHarness {
  const clock = createManualClock(1_700_000_000_000);
  let run = 0;
  return {
    alarms: wrap(createMemoryAlarms(clock)),
    now: () => clock.now(),
    runId: () => `run-${String(++run)}`,
    until: async (done, timeoutMs) => {
      let resolved = false;
      void done.then(() => {
        resolved = true;
      });
      await clock.advance(timeoutMs);
      await Promise.resolve();
      if (!resolved) throw new Error(`no alarm within ${String(timeoutMs)} ms`);
    },
  };
}

function run(cases: ContractCase[]): void {
  for (const contractCase of cases) it(contractCase.name, () => contractCase.run());
}

describe('Alarms contract: in-memory fake', () => {
  run(defineAlarmsContract(() => harness()));
});

describe('Alarms contract: RED probes', () => {
  it('fails a subject whose clear does nothing', async () => {
    const [contractCase] = defineAlarmsContract(() =>
      harness((alarms) => ({ ...alarms, clear: () => Promise.resolve() })),
    );
    await expect(contractCase!.run()).rejects.toThrow(/alarms fired/);
  });

  it('fails a subject whose alarms never fire', async () => {
    const [contractCase] = defineAlarmsContract(() =>
      harness((alarms) => ({ ...alarms, onFire: () => undefined })),
    );
    await expect(contractCase!.run()).rejects.toThrow(/no alarm within/);
  });

  it('fails a subject that fires a different name', async () => {
    const [contractCase] = defineAlarmsContract(() =>
      harness((alarms) => ({
        ...alarms,
        onFire: (listener) => {
          alarms.onFire((name) => {
            listener(`${name}-renamed`);
          });
        },
      })),
    );
    await expect(contractCase!.run()).rejects.toThrow(/no alarm within/);
  });
});

describe('Alarms contract: names', () => {
  it('uses names the reconnect alarm listener rejects', () => {
    expect(tabIdFromReconnectKey(`${CONTRACT_ALARM_PREFIX}x:kept`)).toBeNull();
    expect(tabIdFromReconnectKey(`${CONTRACT_ALARM_PREFIX}x:cleared`)).toBeNull();
  });
});
