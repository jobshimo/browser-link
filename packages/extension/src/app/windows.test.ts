// The Activity and Admin windows (design 6.1, slice 21) on the in-memory
// `Windows`: open once, focus when asked again, open afresh once closed.
import { describe, expect, it } from 'vitest';
import { createMemoryWindows } from '../../contract/memory-windows.js';
import { createAppWindow, type Windows } from './windows.js';

const SIZE = { width: 1100, height: 760 };

function harness(wrap: (w: Windows) => Windows = (w) => w) {
  const windows = createMemoryWindows();
  const appWindow = createAppWindow({
    windows: wrap(windows),
    pageUrl: (path) => `chrome-extension://id/${path}`,
    page: 'activity.html',
    size: SIZE,
  });
  windows.onClosed((id) => {
    appWindow.closed(id);
  });
  return { windows, appWindow };
}

describe('app windows', () => {
  it('opens the page in a window of its size', async () => {
    const { windows, appWindow } = harness();
    expect(await appWindow.open()).toEqual({ ok: true, windowId: 1 });
    expect([...windows.opened]).toEqual([
      [1, { url: 'chrome-extension://id/activity.html', size: SIZE }],
    ]);
    expect(windows.focused).toEqual([]);
  });

  it('focuses the open window instead of opening another', async () => {
    const { windows, appWindow } = harness();
    await appWindow.open();
    expect(await appWindow.open()).toEqual({ ok: true, windowId: 1 });
    expect(windows.opened.size).toBe(1);
    expect(windows.focused).toEqual([1]);
  });

  it('opens a fresh window once the open one closed', async () => {
    const { windows, appWindow } = harness();
    await appWindow.open();
    await windows.close(1);
    expect(await appWindow.open()).toEqual({ ok: true, windowId: 2 });
    expect(windows.focused).toEqual([]);
  });

  it('a close it never heard of: exists rejects, so it opens a fresh one', async () => {
    const { windows, appWindow } = harness((w) => ({ ...w, onClosed: () => undefined }));
    await appWindow.open();
    // Closed without the report reaching it (the subscription is a no-op here).
    await windows.close(1);
    expect(await appWindow.open()).toEqual({ ok: true, windowId: 2 });
  });

  it('a failed focus forgets the window and opens a fresh one', async () => {
    const { appWindow } = harness((w) => ({
      ...w,
      focus: () => Promise.reject(new Error('focus failed')),
    }));
    await appWindow.open();
    expect(await appWindow.open()).toEqual({ ok: true, windowId: 2 });
  });

  it('another window closing changes nothing', async () => {
    const { windows, appWindow } = harness();
    await appWindow.open();
    appWindow.closed(99);
    expect(await appWindow.open()).toEqual({ ok: true, windowId: 1 });
    expect(windows.focused).toEqual([1]);
  });

  it('no window created: answers -1 and remembers none', async () => {
    const { windows, appWindow } = harness((w) => ({
      ...w,
      open: () => Promise.resolve(undefined),
    }));
    expect(await appWindow.open()).toEqual({ ok: true, windowId: -1 });
    expect(await appWindow.open()).toEqual({ ok: true, windowId: -1 });
    expect(windows.focused).toEqual([]);
  });
});
