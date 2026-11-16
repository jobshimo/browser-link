import { describe, expect, test } from 'vitest';
import { checkExtensionFrame } from './frame-check.js';

describe('checkExtensionFrame', () => {
  test.each([
    { kind: 'tab.register', payload: { url: 'https://e.test/', title: 'T' } },
    { kind: 'tab.register', payload: { url: 'u', title: 't', previousTabId: 'tab_1' } },
    { kind: 'tool.response', id: 'a', ok: true, result: null },
    { kind: 'tool.response', id: 'a', ok: false, error: 'boom', sensitive_field: true },
    { kind: 'bridge.event', eventKind: 'dialog-opened', data: {} },
    { kind: 'bridge.event', eventKind: 'dialog-opened', tabId: 'tab_1', data: {} },
    { kind: 'flow.recorded', payload: {} },
    { kind: 'activity.query', request_id: 'r' },
    { kind: 'activity.query', request_id: 'r', query: { limit: 5 } },
    { kind: 'activity.purge', request_id: 'r', dry_run: true },
    { kind: 'bridge.repair', request_id: 'r' },
    { kind: 'admin.describe', request_id: 'r', language: 'es' },
    { kind: 'admin.action', request_id: 'r', id: 'x', code: 'c' },
    // A malformed code passes the shape check on purpose: the handler
    // answers it with an error the caller sees instead of a silent drop.
    { kind: 'admin.action', request_id: 'r', id: 'x', code: 42 },
  ])('accepts the valid frame %j unchanged', (frame) => {
    expect(checkExtensionFrame(frame)).toEqual({ ok: true, msg: frame });
  });

  test.each([
    [{ kind: 'tool.response', id: 'a', ok: false }, 'tool.response'],
    [{ kind: 'activity.query', request_id: 'r', query: 'x' }, 'activity.query'],
    [{ kind: 'bridge.event', eventKind: 'k', data: [] }, 'bridge.event'],
    [{ kind: 'bridge.event', eventKind: 'k', data: {}, tabId: 4 }, 'bridge.event'],
    [{ kind: '__proto__' }, 'unknown'],
    [{ kind: 'toString' }, 'unknown'],
    ['tab.register', 'unknown'],
    [undefined, 'unknown'],
  ])('rejects %j reporting kind %s', (frame, kind) => {
    expect(checkExtensionFrame(frame)).toEqual({ ok: false, kind });
  });
});
