// The cdp-direct `ContentSettings` (parity G10): each content setting core
// writes becomes one `Browser.setPermission` on the page connection it was
// built over, for the origin, with no browserContextId.
import { describe, expect, test } from 'vitest';
import type { CdpClient } from '../client.js';
import { CDP_TEMPORARY_PERMISSION_NOTE, createCdpContentSettings } from './cdp-content-settings.js';

function fakeClient(answer: () => Promise<unknown> = () => Promise.resolve({})): {
  client: CdpClient;
  sent: [string, unknown][];
} {
  const sent: [string, unknown][] = [];
  const client = {
    send: (method: string, params?: unknown) => {
      sent.push([method, params]);
      return answer();
    },
  } as unknown as CdpClient;
  return { client, sent };
}

describe('createCdpContentSettings', () => {
  test.each([
    ['location', 'geolocation'],
    ['notifications', 'notifications'],
    ['camera', 'camera'],
    ['microphone', 'microphone'],
    ['clipboard', 'clipboard-read'],
    ['sensors', 'accelerometer'],
  ])('content setting %s is the permission descriptor %s', async (setting, descriptor) => {
    const { client, sent } = fakeClient();
    await createCdpContentSettings(client).set(setting, 'https://a.test/*', 'allow');
    expect(sent).toEqual([
      [
        'Browser.setPermission',
        { permission: { name: descriptor }, setting: 'granted', origin: 'https://a.test' },
      ],
    ]);
  });

  test.each([
    ['allow', 'granted'],
    ['block', 'denied'],
    ['ask', 'prompt'],
  ])('value %s is the permission setting %s', async (value, setting) => {
    const { client, sent } = fakeClient();
    await createCdpContentSettings(client).set('camera', 'https://a.test/*', value);
    expect(sent[0]?.[1]).toEqual({
      permission: { name: 'camera' },
      setting,
      origin: 'https://a.test',
    });
  });

  test('a setting or value it does not map goes to Chrome unchanged, and its refusal rejects unchanged', async () => {
    const { client, sent } = fakeClient(() =>
      Promise.reject(new Error('Invalid PermissionDescriptor name: midi')),
    );
    await expect(
      createCdpContentSettings(client).set('midi', 'https://a.test', 'maybe'),
    ).rejects.toThrow(new Error('Invalid PermissionDescriptor name: midi'));
    expect(sent).toEqual([
      [
        'Browser.setPermission',
        { permission: { name: 'midi' }, setting: 'maybe', origin: 'https://a.test' },
      ],
    ]);
  });

  test('carries the temporary note core answers with the result', () => {
    const { client } = fakeClient();
    expect(createCdpContentSettings(client).temporaryNote).toBe(CDP_TEMPORARY_PERMISSION_NOTE);
    expect(CDP_TEMPORARY_PERMISSION_NOTE).toBe(
      'Temporary: on a cdp: tab this permission is a DevTools override, not a saved site setting. It lasts while browser-link stays connected to the tab (the connection is dropped after 30 minutes without a tool call on the tab, 5 when nothing was captured) and another DevTools client disconnecting from the browser can clear it earlier.',
    );
  });
});
