// The in-worker contract run (design section 8, R6, primary path; slice 19).
// A test-only IIFE bundle (`build.mjs`) of the extension adapters' contracts
// against the real adapters, which the e2e evaluates in the extension's
// service worker and then calls `browserLinkContract()`. It holds the
// adapters and the contracts only, never `background.ts`, so `onFire`
// registered here is a second listener in a test script, not in the product
// bundle. Never shipped (`scripts/smoke-tarball.mjs`).

import { chromeAlarms } from '../src/adapters/chrome-alarms.js';
import { defineAlarmsContract } from './alarms.contract.js';

export interface ContractResult {
  name: string;
  ok: boolean;
  error?: string;
  ms: number;
}

const cases = defineAlarmsContract(() => ({
  alarms: chromeAlarms,
  now: () => Date.now(),
  runId: () => crypto.randomUUID(),
  until: (done, timeoutMs) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`no alarm within ${String(timeoutMs)} ms`));
      }, timeoutMs);
      void done.then(() => {
        clearTimeout(timer);
        resolve();
      });
    }),
}));

async function browserLinkContract(): Promise<ContractResult[]> {
  const results: ContractResult[] = [];
  for (const contractCase of cases) {
    const started = Date.now();
    try {
      await contractCase.run();
      results.push({ name: contractCase.name, ok: true, ms: Date.now() - started });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      results.push({ name: contractCase.name, ok: false, error, ms: Date.now() - started });
    }
  }
  return results;
}

(globalThis as { browserLinkContract?: typeof browserLinkContract }).browserLinkContract =
  browserLinkContract;
