import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  DEFAULT_BRIDGE_PORT,
  DEFAULT_IPC_PORT,
  IPC_PROTOCOL_VERSION,
  portFromEnv,
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
      { kind: 'settings.push', settings: { idleTtlMinutes: 15, updatedAt: 1_700_000_000_000 } },
      { kind: 'settings.push', settings: { idleTtlMinutes: 0, updatedAt: 1_700_000_000_000 } },
      {
        kind: 'settings.push',
        settings: { flowRecordingEnabled: true, flowRecordingUpdatedAt: 1_700_000_000_000 },
      },
      {
        kind: 'settings.push',
        settings: { flowRecordingEnabled: false, flowRecordingUpdatedAt: 1_700_000_000_000 },
      },
      {
        kind: 'settings.push',
        settings: {
          idleTtlMinutes: 15,
          updatedAt: 1_700_000_000_000,
          flowRecordingEnabled: true,
          flowRecordingUpdatedAt: 1_700_000_000_001,
        },
      },
      { kind: 'settings.push-ack', notified: 3 },
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

  test('rejects settings.push without a numeric settings.idleTtlMinutes / updatedAt', () => {
    expect(parseFrame('{"kind":"settings.push"}')).toBeNull();
    expect(parseFrame('{"kind":"settings.push","settings":{}}')).toBeNull();
    expect(
      parseFrame('{"kind":"settings.push","settings":{"idleTtlMinutes":"30","updatedAt":1}}'),
    ).toBeNull();
    expect(parseFrame('{"kind":"settings.push","settings":{"idleTtlMinutes":30}}')).toBeNull();
  });

  test('accepts a well-formed settings.push, including the 0 ("never") value', () => {
    expect(
      parseFrame(
        '{"kind":"settings.push","settings":{"idleTtlMinutes":15,"updatedAt":1700000000000}}',
      ),
    ).toEqual({
      kind: 'settings.push',
      settings: { idleTtlMinutes: 15, updatedAt: 1_700_000_000_000 },
    });
    expect(
      parseFrame(
        '{"kind":"settings.push","settings":{"idleTtlMinutes":0,"updatedAt":1700000000000}}',
      ),
    ).toEqual({
      kind: 'settings.push',
      settings: { idleTtlMinutes: 0, updatedAt: 1_700_000_000_000 },
    });
  });

  test('rejects settings.push with neither the idle-ttl nor the flow-recording pair', () => {
    expect(parseFrame('{"kind":"settings.push","settings":{}}')).toBeNull();
    expect(parseFrame('{"kind":"settings.push","settings":{"foo":1}}')).toBeNull();
  });

  test('rejects settings.push with a malformed flow-recording pair', () => {
    expect(
      parseFrame(
        '{"kind":"settings.push","settings":{"flowRecordingEnabled":"yes","flowRecordingUpdatedAt":1}}',
      ),
    ).toBeNull();
    expect(
      parseFrame('{"kind":"settings.push","settings":{"flowRecordingEnabled":true}}'),
    ).toBeNull();
  });

  test('accepts a settings.push carrying only the flow-recording pair', () => {
    expect(
      parseFrame(
        '{"kind":"settings.push","settings":{"flowRecordingEnabled":true,"flowRecordingUpdatedAt":1700000000000}}',
      ),
    ).toEqual({
      kind: 'settings.push',
      settings: { flowRecordingEnabled: true, flowRecordingUpdatedAt: 1_700_000_000_000 },
    });
  });

  test('accepts a settings.push carrying both pairs', () => {
    expect(
      parseFrame(
        '{"kind":"settings.push","settings":{"idleTtlMinutes":15,"updatedAt":1,"flowRecordingEnabled":false,"flowRecordingUpdatedAt":2}}',
      ),
    ).toEqual({
      kind: 'settings.push',
      settings: {
        idleTtlMinutes: 15,
        updatedAt: 1,
        flowRecordingEnabled: false,
        flowRecordingUpdatedAt: 2,
      },
    });
  });

  test('rejects settings.push-ack without a numeric notified', () => {
    expect(parseFrame('{"kind":"settings.push-ack"}')).toBeNull();
    expect(parseFrame('{"kind":"settings.push-ack","notified":"3"}')).toBeNull();
  });

  test('accepts a well-formed settings.push-ack', () => {
    expect(parseFrame('{"kind":"settings.push-ack","notified":2}')).toEqual({
      kind: 'settings.push-ack',
      notified: 2,
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

describe('portFromEnv (BROWSER_LINK_WS_PORT / BROWSER_LINK_IPC_PORT)', () => {
  test('a valid integer in range overrides the default, with no warning', () => {
    const warn = vi.fn();
    expect(
      portFromEnv('BROWSER_LINK_WS_PORT', 17529, { BROWSER_LINK_WS_PORT: '27529' }, warn),
    ).toBe(27529);
    expect(
      portFromEnv('BROWSER_LINK_IPC_PORT', 17530, { BROWSER_LINK_IPC_PORT: '1024' }, warn),
    ).toBe(1024);
    expect(
      portFromEnv('BROWSER_LINK_IPC_PORT', 17530, { BROWSER_LINK_IPC_PORT: '65535' }, warn),
    ).toBe(65535);
    expect(warn).not.toHaveBeenCalled();
  });

  test.each(['abc', ' ', '1023', '65536', '0', '-1', '27529.5', '1e4', '0x6b71', '27529abc'])(
    'an invalid value %j falls back to the default with exactly one warning line',
    (value) => {
      const warn = vi.fn();
      expect(
        portFromEnv('BROWSER_LINK_WS_PORT', 17529, { BROWSER_LINK_WS_PORT: value }, warn),
      ).toBe(17529);
      expect(warn).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0]?.[0]);
      expect(line).not.toContain('\n');
      expect(line).toContain('BROWSER_LINK_WS_PORT');
      expect(line).toContain('17529');
    },
  );

  test('unset or empty keeps the default, with no warning', () => {
    const warn = vi.fn();
    expect(portFromEnv('BROWSER_LINK_WS_PORT', 17529, {}, warn)).toBe(17529);
    expect(portFromEnv('BROWSER_LINK_WS_PORT', 17529, { BROWSER_LINK_WS_PORT: '' }, warn)).toBe(
      17529,
    );
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('BRIDGE_PORT / IPC_PORT resolved from the environment at load', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  test('env set: both constants resolve to the overrides', async () => {
    vi.stubEnv('BROWSER_LINK_WS_PORT', '27529');
    vi.stubEnv('BROWSER_LINK_IPC_PORT', '27530');
    vi.resetModules();
    const mod = await import('./protocol.js');
    expect(mod.BRIDGE_PORT).toBe(27529);
    expect(mod.IPC_PORT).toBe(27530);
  });

  test('invalid value: default and one warning line (console.warn, stderr)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubEnv('BROWSER_LINK_WS_PORT', 'not-a-port');
    vi.stubEnv('BROWSER_LINK_IPC_PORT', undefined);
    vi.resetModules();
    const mod = await import('./protocol.js');
    expect(mod.BRIDGE_PORT).toBe(17529);
    expect(mod.IPC_PORT).toBe(17530);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test('unset: the defaults 17529 / 17530', async () => {
    vi.stubEnv('BROWSER_LINK_WS_PORT', undefined);
    vi.stubEnv('BROWSER_LINK_IPC_PORT', undefined);
    vi.resetModules();
    const mod = await import('./protocol.js');
    expect(mod.BRIDGE_PORT).toBe(17529);
    expect(mod.IPC_PORT).toBe(17530);
    expect(DEFAULT_BRIDGE_PORT).toBe(17529);
    expect(DEFAULT_IPC_PORT).toBe(17530);
  });
});
