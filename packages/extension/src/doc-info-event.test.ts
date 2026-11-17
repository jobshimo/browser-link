import { describe, expect, test } from 'vitest';
import {
  applyObserverMessage,
  createObserverMirror,
  parseObserverMessage,
} from '@browser-link/core';
import { docInfoEvent, pendingDocInfoEvent } from './doc-info-event.js';

function apply(mirror: ReturnType<typeof createObserverMirror>, payload: string): void {
  const message = parseObserverMessage(payload);
  if (!message) throw new Error('fixture did not parse');
  applyObserverMessage(mirror, message);
}

const docInfo = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    type: 'doc_info',
    doc_id: 'doc-a',
    url: 'https://a.test/x',
    build: '3f9a2b1c',
    view_sig: '0011aabb',
    title: 'Invoices',
    ...over,
  });

describe('docInfoEvent', () => {
  test('builds the tab-doc-info bridge event for the registered tab', () => {
    expect(
      docInfoEvent('t1', {
        url: 'https://a.test/x',
        build: '3f9a2b1c',
        view_sig: '0011aabb',
        title: 'Invoices',
      }),
    ).toEqual({
      kind: 'bridge.event',
      eventKind: 'tab-doc-info',
      tabId: 't1',
      data: { url: 'https://a.test/x', build: '3f9a2b1c', view_sig: '0011aabb', title: 'Invoices' },
    });
  });
});

describe('pendingDocInfoEvent (fingerprint reported before the socket registers)', () => {
  test('a doc_info applied before registration is delivered once the tab registers', () => {
    // The observer pushes doc_info as soon as it is installed on an
    // already-loaded page, before `tab.registered` assigns the server tab id.
    const mirror = createObserverMirror();
    apply(mirror, docInfo());
    expect(pendingDocInfoEvent(mirror, 't1')).toEqual({
      kind: 'bridge.event',
      eventKind: 'tab-doc-info',
      tabId: 't1',
      data: { url: 'https://a.test/x', build: '3f9a2b1c', view_sig: '0011aabb', title: 'Invoices' },
    });
  });

  test('only the latest doc_info is delivered', () => {
    const mirror = createObserverMirror();
    apply(mirror, docInfo());
    apply(mirror, docInfo({ url: 'https://a.test/y', view_sig: 'ccdd0011', title: 'Other' }));
    expect(pendingDocInfoEvent(mirror, 't1')?.data).toEqual({
      url: 'https://a.test/y',
      build: '3f9a2b1c',
      view_sig: 'ccdd0011',
      title: 'Other',
    });
  });

  test('nothing to deliver when no doc_info arrived or there is no observer', () => {
    expect(pendingDocInfoEvent(createObserverMirror(), 't1')).toBeNull();
    expect(pendingDocInfoEvent(undefined, 't1')).toBeNull();
  });
});
