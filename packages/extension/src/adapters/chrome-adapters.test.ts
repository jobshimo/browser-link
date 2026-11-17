// The ContentSettings and Downloads contracts (design 5.3, item 5; slice 16)
// against the extension adapters, over stand-ins for `chrome.contentSettings`,
// `chrome.downloads` and `chrome.debugger.onEvent`. In the real service
// worker the e2e reaches every adapter function (R6, condition 1).
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import {
  defineContentSettingsContract,
  defineDownloadsContract,
  type ContractCase,
} from '@browser-link/core';
import { createDownloadCapture, type DownloadsApi } from '../download-capture.js';
import { createChromeContentSettings } from './chrome-content-settings.js';
import { createChromeDownloads } from './chrome-downloads.js';

const values = new Map<string, string>();

function contentSetting(key: string) {
  return {
    set: ({ primaryPattern, setting }: { primaryPattern: string; setting: string }) => {
      values.set(`${key} ${primaryPattern}`, setting);
      return Promise.resolve();
    },
  };
}

const downloadsApi: DownloadsApi = {
  onDeterminingFilename: { addListener: () => undefined, removeListener: () => undefined },
  cancel: () => Promise.resolve(),
  erase: () => Promise.resolve([]),
};

beforeEach(() => {
  values.clear();
  vi.stubGlobal('chrome', {
    contentSettings: { location: contentSetting('location') },
    debugger: { onEvent: { addListener: () => undefined, removeListener: () => undefined } },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function run(cases: ContractCase[]): void {
  for (const contractCase of cases) it(contractCase.name, () => contractCase.run());
}

describe('ContentSettings contract: the chrome.contentSettings adapter', () => {
  run(
    defineContentSettingsContract(() => ({
      settings: createChromeContentSettings(),
      read: (setting, pattern) => Promise.resolve(values.get(`${setting} ${pattern}`)),
      failing: {
        setting: 'sensors',
        message: 'chrome.contentSettings.sensors is not exposed in this Chrome build',
      },
    })),
  );
});

describe('Downloads contract: the chrome.downloads adapter', () => {
  run(
    defineDownloadsContract(() => ({
      downloads: createChromeDownloads(createDownloadCapture(downloadsApi), 4),
      elapse: (ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms + 5);
        }),
    })),
  );
});
