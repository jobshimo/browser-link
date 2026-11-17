// The filter behind the Downloads adapter (slice 16): only the clicked
// tab's `Page.downloadWillBegin` reports with a string URL reach the
// capture, and unsubscribing removes the listener it added.
import { describe, expect, it } from 'vitest';
import { tabDownloadSignals, type DebuggerEventListener } from './download-signals.js';

function events() {
  const listeners = new Set<DebuggerEventListener>();
  return {
    source: {
      add: (listener: DebuggerEventListener) => {
        listeners.add(listener);
      },
      remove: (listener: DebuggerEventListener) => {
        listeners.delete(listener);
      },
    },
    fire: (tabId: number | undefined, method: string, params?: object) => {
      for (const listener of [...listeners]) listener({ tabId }, method, params);
    },
    count: () => listeners.size,
  };
}

describe('tabDownloadSignals', () => {
  it("reports the tab's own download URLs, and nothing else", () => {
    const bus = events();
    const urls: string[] = [];
    const off = tabDownloadSignals(4, bus.source).subscribe((url) => urls.push(url));
    bus.fire(4, 'Page.downloadWillBegin', { url: 'https://a.test/f' });
    bus.fire(5, 'Page.downloadWillBegin', { url: 'https://a.test/other-tab' });
    bus.fire(4, 'Page.frameNavigated', { url: 'https://a.test/nav' });
    bus.fire(4, 'Page.downloadWillBegin', { url: 7 });
    bus.fire(4, 'Page.downloadWillBegin');
    bus.fire(undefined, 'Page.downloadWillBegin', { url: 'https://a.test/no-tab' });
    expect(urls).toEqual(['https://a.test/f']);
    expect(bus.count()).toBe(1);
    off();
    expect(bus.count()).toBe(0);
    bus.fire(4, 'Page.downloadWillBegin', { url: 'https://a.test/late' });
    expect(urls).toEqual(['https://a.test/f']);
  });
});
