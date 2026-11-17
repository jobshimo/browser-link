// The lookup behind the ContentSettings adapter (slice 16): one `set` on the
// setting found by key, and the texts that name a missing one.
import { describe, expect, it } from 'vitest';
import { applyContentSetting } from './content-settings.js';

describe('applyContentSetting', () => {
  it('sets the setting found by key, with the pattern and the value', async () => {
    const calls: unknown[] = [];
    const root = {
      location: {
        set: (details: unknown) => {
          calls.push(details);
          return Promise.resolve();
        },
      },
    };
    await applyContentSetting(root, 'location', 'https://a.test/*', 'allow');
    expect(calls).toEqual([{ primaryPattern: 'https://a.test/*', setting: 'allow' }]);
  });

  it.each([
    [undefined, 'chrome.contentSettings not available in this build'],
    [{}, 'chrome.contentSettings.sensors is not exposed in this Chrome build'],
    [{ sensors: {} }, 'chrome.contentSettings.sensors is not exposed in this Chrome build'],
  ])('with %j it rejects: %s', async (root, message) => {
    await expect(applyContentSetting(root, 'sensors', 'https://a.test/*', 'allow')).rejects.toThrow(
      message,
    );
  });

  it("passes the browser's refusal through unchanged", async () => {
    const root = { clipboard: { set: () => Promise.reject(new Error('Invalid pattern')) } };
    await expect(applyContentSetting(root, 'clipboard', 'x', 'allow')).rejects.toThrow(
      'Invalid pattern',
    );
  });
});
