// The ContentSettings and Downloads contracts against their in-memory fakes
// (condition 3 of R6, slice 16), and RED probes showing each contract
// catches a broken subject.
import { describe, expect, it } from 'vitest';
import {
  createManualClock,
  createMemoryContentSettings,
  createMemoryDownloads,
  defineContentSettingsContract,
  defineDownloadsContract,
  type ContentSettingsHarness,
  type ContractCase,
  type DownloadsHarness,
} from './index.js';

const notExposed = (setting: string): string =>
  `chrome.contentSettings.${setting} is not exposed in this Chrome build`;

function settingsHarness(): ContentSettingsHarness {
  const settings = createMemoryContentSettings(['location'], notExposed);
  return {
    settings,
    read: (setting, pattern) => Promise.resolve(settings.read(setting, pattern)),
    failing: { setting: 'sensors', message: notExposed('sensors') },
  };
}

function downloadsHarness(): DownloadsHarness {
  const clock = createManualClock();
  return {
    downloads: createMemoryDownloads(clock),
    elapse: async (ms) => {
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
      await clock.advance(ms);
    },
  };
}

function run(cases: ContractCase[]): void {
  for (const contractCase of cases) it(contractCase.name, () => contractCase.run());
}

function caseNamed(cases: ContractCase[], name: string): ContractCase {
  const found = cases.find((c) => c.name === name);
  if (!found) throw new Error(`no contract case named ${name}`);
  return found;
}

describe('ContentSettings contract: in-memory fake', () => {
  run(defineContentSettingsContract(settingsHarness));
});

describe('Downloads contract: in-memory fake', () => {
  run(defineDownloadsContract(downloadsHarness));

  it('holds a download started while a capture waits, settled once', async () => {
    const clock = createManualClock();
    const downloads = createMemoryDownloads(clock);
    const file = {
      download_id: 3,
      url: 'https://a.test/f',
      original_url: 'https://a.test/f',
      filename: 'f',
      mime: 'text/plain',
      total_bytes: null,
    };
    const captured = await downloads.captureAround({ timeoutMs: 10, holdMs: 20 }, () => {
      downloads.start(file);
      return Promise.resolve({ ok: true });
    });
    expect(captured).toEqual({ ok: true, outcome: { state: 'captured', download: file } });
    expect(await downloads.settle(3, true)).toBe('removed');
    expect(await downloads.settle(3, true)).toBe('not_held');
  });
});

describe('the ContentSettings and Downloads contracts catch a broken subject (RED probes)', () => {
  it('ContentSettings: a refusal that resolves', async () => {
    const cases = defineContentSettingsContract(() => ({
      ...settingsHarness(),
      settings: { set: () => Promise.resolve() },
    }));
    await expect(
      caseNamed(cases, 'a refused setting rejects with the error message unchanged').run(),
    ).rejects.toThrow(/error message/);
  });

  it('Downloads: a failed action that leaves the capture armed', async () => {
    const cases = defineDownloadsContract(() => {
      const harness = downloadsHarness();
      let armed = false;
      return {
        ...harness,
        downloads: {
          ...harness.downloads,
          captureAround: async (wait, act) => {
            if (armed) throw new Error('download: another capture is waiting');
            armed = true;
            const acted = await act();
            if (!acted.ok) return acted;
            return harness.downloads.captureAround(wait, () => Promise.resolve({ ok: true }));
          },
        },
      };
    });
    await expect(
      caseNamed(cases, 'a failed action answers its error, and the next capture can arm').run(),
    ).rejects.toThrow(/another capture is waiting/);
  });

  it('Downloads: a throwing action that leaves the capture armed', async () => {
    const cases = defineDownloadsContract(() => {
      const harness = downloadsHarness();
      let armed = false;
      return {
        ...harness,
        downloads: {
          ...harness.downloads,
          captureAround: async (wait, act) => {
            if (armed) throw new Error('download: another capture is waiting');
            armed = true;
            await act();
            armed = false;
            return harness.downloads.captureAround(wait, () => Promise.resolve({ ok: true }));
          },
        },
      };
    });
    await expect(
      caseNamed(cases, 'a throwing action disarms the capture and its rejection propagates').run(),
    ).rejects.toThrow(/another capture is waiting/);
  });

  it('Downloads: a throwing action whose rejection is swallowed', async () => {
    const cases = defineDownloadsContract(() => {
      const harness = downloadsHarness();
      return {
        ...harness,
        downloads: {
          ...harness.downloads,
          captureAround: (wait, act) =>
            harness.downloads.captureAround(wait, () =>
              act().catch((err: unknown) => ({ ok: false as const, error: String(err) })),
            ),
        },
      };
    });
    await expect(
      caseNamed(cases, 'a throwing action disarms the capture and its rejection propagates').run(),
    ).rejects.toThrow(/propagates unchanged/);
  });
});
