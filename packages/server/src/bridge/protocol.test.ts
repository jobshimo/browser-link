import { describe, expect, test } from 'vitest';
import {
  IPC_PROTOCOL_VERSION,
  encodeFrame,
  isCompatibleVersion,
  parseFrame,
  type Frame,
} from './protocol.js';

describe('encodeFrame', () => {
  test('ends with newline (NDJSON contract)', () => {
    const wire = encodeFrame({ kind: 'ping' });
    expect(wire.endsWith('\n')).toBe(true);
  });

  test('is round-trippable', () => {
    const frames: Frame[] = [
      { kind: 'hello', version: '1', token: 'abc' },
      { kind: 'hello-ack', version: '1', sessionId: 'sess-1' },
      { kind: 'hello-reject', reason: 'bad token' },
      { kind: 'mcp.request', requestId: 7, payload: { method: 'tools/list' } },
      { kind: 'mcp.response', requestId: 7, payload: { result: { tools: [] } } },
      { kind: 'mcp.notification', payload: { method: 'notifications/initialized' } },
      { kind: 'ping' },
      { kind: 'pong' },
      { kind: 'primary-closing', reason: 'shutdown' },
      { kind: 'primary-closing' },
    ];
    for (const f of frames) {
      const wire = encodeFrame(f).trimEnd();
      const back = parseFrame(wire);
      expect(back).toEqual(f);
    }
  });
});

describe('parseFrame', () => {
  test('returns null on invalid JSON', () => {
    expect(parseFrame('not json')).toBeNull();
    expect(parseFrame('')).toBeNull();
    expect(parseFrame('{')).toBeNull();
  });

  test('returns null when kind is missing or not a string', () => {
    expect(parseFrame('{"version":"1"}')).toBeNull();
    expect(parseFrame('{"kind":7}')).toBeNull();
    expect(parseFrame('null')).toBeNull();
    expect(parseFrame('[]')).toBeNull();
  });

  test('returns null on unknown kind', () => {
    expect(parseFrame('{"kind":"bogus"}')).toBeNull();
  });

  test('rejects hello without version or token', () => {
    expect(parseFrame('{"kind":"hello"}')).toBeNull();
    expect(parseFrame('{"kind":"hello","version":"1"}')).toBeNull();
    expect(parseFrame('{"kind":"hello","token":"abc"}')).toBeNull();
  });

  test('rejects mcp.request without requestId or payload', () => {
    expect(parseFrame('{"kind":"mcp.request"}')).toBeNull();
    expect(parseFrame('{"kind":"mcp.request","requestId":"not-a-number","payload":{}}')).toBeNull();
    expect(parseFrame('{"kind":"mcp.request","requestId":1}')).toBeNull();
  });

  test('accepts ping/pong with no extra fields', () => {
    expect(parseFrame('{"kind":"ping"}')).toEqual({ kind: 'ping' });
    expect(parseFrame('{"kind":"pong"}')).toEqual({ kind: 'pong' });
  });

  test('primary-closing reason is optional', () => {
    expect(parseFrame('{"kind":"primary-closing"}')).toEqual({
      kind: 'primary-closing',
      reason: undefined,
    });
    expect(parseFrame('{"kind":"primary-closing","reason":"x"}')).toEqual({
      kind: 'primary-closing',
      reason: 'x',
    });
  });
});

describe('isCompatibleVersion', () => {
  test('matches the current protocol version exactly', () => {
    expect(isCompatibleVersion(IPC_PROTOCOL_VERSION)).toBe(true);
  });

  test('rejects different versions', () => {
    expect(isCompatibleVersion('999')).toBe(false);
    expect(isCompatibleVersion('')).toBe(false);
  });
});
