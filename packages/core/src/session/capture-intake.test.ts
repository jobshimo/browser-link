// The capture intake (`captureIntake`, `CaptureBuffers`) on the in-memory
// `CdpSession`: the intake subscribed to the session's events, as a
// transport wires it, filling the bounded console and network buffers that
// are themselves the `CaptureWatch`. The same mappings the extension's
// debugger intake tests pin (`app/tab-connection.test.ts`).
import { describe, expect, test } from 'vitest';
import { createManualClock, createMemoryCdpSession } from '../ports/contract/index.js';
import {
  CaptureBuffers,
  captureIntake,
  CONSOLE_BUFFER_MAX,
  NETWORK_BUFFER_MAX,
  normalizeConsoleLevel,
  stringifyConsoleArg,
} from './capture-intake.js';

function wired() {
  const clock = createManualClock(1_000);
  const cdp = createMemoryCdpSession({});
  const buffers = new CaptureBuffers({ clock });
  const intake = captureIntake(buffers, clock);
  const off = cdp.onEvent(intake);
  return { clock, cdp, buffers, intake, off };
}

describe('captureIntake: console', () => {
  test('console and log entries go into the buffer with normalised levels and every field', () => {
    const { cdp, buffers } = wired();
    cdp.emit('Runtime.consoleAPICalled', {
      type: 'warning',
      timestamp: 5,
      args: [{ value: 'a' }, { value: { b: 1 } }, { description: 'd' }],
    });
    cdp.emit('Log.entryAdded', {
      entry: { level: 'verbose', text: 't', url: 'u', lineNumber: 3 },
    });
    expect(buffers.consoleEntries()).toEqual([
      { timestamp: 5, level: 'warn', text: 'a {"b":1} d', source: 'console' },
      { timestamp: 1_000, level: 'debug', text: 't', source: 'log', url: 'u', line: 3 },
    ]);
  });

  test('a console call without type, args or timestamp is a log entry stamped now', () => {
    const { cdp, buffers } = wired();
    cdp.emit('Runtime.consoleAPICalled', {});
    cdp.emit('Log.entryAdded', {});
    expect(buffers.consoleEntries()).toEqual([
      { timestamp: 1_000, level: 'log', text: '', source: 'console' },
      {
        timestamp: 1_000,
        level: 'log',
        text: '',
        source: 'log',
        url: undefined,
        line: undefined,
      },
    ]);
  });

  test('the console keeps the last CONSOLE_BUFFER_MAX entries, oldest dropped first', () => {
    const { cdp, buffers } = wired();
    for (let i = 0; i < CONSOLE_BUFFER_MAX + 5; i++) {
      cdp.emit('Runtime.consoleAPICalled', { timestamp: i, args: [{ value: `m${i}` }] });
    }
    expect(CONSOLE_BUFFER_MAX).toBe(200);
    expect(buffers.consoleEntries()).toHaveLength(CONSOLE_BUFFER_MAX);
    expect(buffers.consoleEntries()[0]?.text).toBe('m5');
    expect(buffers.consoleEntries().at(-1)?.text).toBe(`m${CONSOLE_BUFFER_MAX + 4}`);
  });
});

describe('captureIntake: network', () => {
  test('request, response and finish fill one entry per request', async () => {
    const { clock, cdp, buffers } = wired();
    cdp.emit('Network.requestWillBeSent', {
      requestId: 'r1',
      type: 'Fetch',
      request: {
        url: 'https://x.test/a',
        method: 'POST',
        headers: { 'x-a': '1' },
        postData: 'p',
      },
    });
    cdp.emit('Network.responseReceived', {
      requestId: 'r1',
      response: {
        status: 201,
        statusText: 'Created',
        mimeType: 'application/json',
        headers: { 'x-b': '2' },
      },
    });
    await clock.advance(30);
    cdp.emit('Network.loadingFinished', { requestId: 'r1', encodedDataLength: 9 });
    expect(buffers.networkEntries()).toEqual([
      {
        request_id: 'r1',
        url: 'https://x.test/a',
        method: 'POST',
        resource_type: 'Fetch',
        request_headers: { 'x-a': '1' },
        request_post_data: 'p',
        status: 201,
        status_text: 'Created',
        mime_type: 'application/json',
        response_headers: { 'x-b': '2' },
        started_at: 1_000,
        finished_at: 1_030,
        encoded_data_length: 9,
      },
    ]);
    expect([...buffers.finishedUrls()]).toEqual(['https://x.test/a']);
  });

  test('a failed request is finished with its error text, or "failed" without one', async () => {
    const { clock, cdp, buffers } = wired();
    cdp.emit('Network.requestWillBeSent', {
      requestId: 'r1',
      request: { url: 'https://x.test/a' },
    });
    await clock.advance(10);
    cdp.emit('Network.loadingFailed', { requestId: 'r1', errorText: 'net::ERR_ABORTED' });
    cdp.emit('Network.loadingFailed', { requestId: 'r2' });
    expect(buffers.networkBuffer.get('r1')).toMatchObject({
      finished_at: 1_010,
      failed: 'net::ERR_ABORTED',
    });
    expect(buffers.networkBuffer.get('r2')).toEqual({
      request_id: 'r2',
      url: '',
      method: '',
      started_at: 1_010,
      finished_at: 1_010,
      failed: 'failed',
    });
  });

  test('a second requestWillBeSent keeps what it does not carry (a redirect)', () => {
    const { cdp, buffers } = wired();
    cdp.emit('Network.requestWillBeSent', {
      requestId: 'r1',
      type: 'Document',
      request: { url: 'https://x.test/a', method: 'GET', headers: { h: '1' } },
    });
    cdp.emit('Network.requestWillBeSent', {
      requestId: 'r1',
      request: { url: 'https://x.test/b' },
    });
    expect(buffers.networkBuffer.get('r1')).toMatchObject({
      url: 'https://x.test/b',
      method: 'GET',
      resource_type: 'Document',
      request_headers: { h: '1' },
    });
    expect(buffers.networkOrder).toEqual(['r1']);
  });

  test('the network keeps the last NETWORK_BUFFER_MAX requests; order and map hold the same ids', () => {
    const { cdp, buffers } = wired();
    for (let i = 0; i < NETWORK_BUFFER_MAX + 3; i++) {
      cdp.emit('Network.loadingFinished', { requestId: `r${i}` });
    }
    expect(NETWORK_BUFFER_MAX).toBe(200);
    expect(buffers.networkOrder).toHaveLength(NETWORK_BUFFER_MAX);
    expect(buffers.networkOrder[0]).toBe('r3');
    expect([...buffers.networkBuffer.keys()].sort()).toEqual([...buffers.networkOrder].sort());
    expect(buffers.networkBuffer.has('r2')).toBe(false);
    expect(buffers.networkEntries().map((e) => e.request_id)).toEqual(buffers.networkOrder);
  });
});

describe('captureIntake: other events', () => {
  test('answers true for the six capture events and false for anything else, untouched', () => {
    const { intake, buffers } = wired();
    expect(intake('Runtime.consoleAPICalled', {})).toBe(true);
    expect(intake('Log.entryAdded', {})).toBe(true);
    expect(intake('Network.requestWillBeSent', { requestId: 'a' })).toBe(true);
    expect(intake('Network.responseReceived', { requestId: 'a' })).toBe(true);
    expect(intake('Network.loadingFinished', { requestId: 'a' })).toBe(true);
    expect(intake('Network.loadingFailed', { requestId: 'a' })).toBe(true);
    const consoleBefore = buffers.consoleEntries().length;
    const networkBefore = buffers.networkOrder.length;
    expect(intake('Page.javascriptDialogOpening', { message: 'm' })).toBe(false);
    expect(intake('Runtime.bindingCalled', { name: 'x' })).toBe(false);
    expect(intake('Network.dataReceived', { requestId: 'b' })).toBe(false);
    expect(buffers.consoleEntries()).toHaveLength(consoleBefore);
    expect(buffers.networkOrder).toHaveLength(networkBefore);
  });

  test('unsubscribed, the intake writes nothing more', () => {
    const { cdp, buffers, off } = wired();
    off();
    cdp.emit('Runtime.consoleAPICalled', { args: [{ value: 'x' }] });
    expect(buffers.consoleEntries()).toEqual([]);
  });
});

describe('CaptureBuffers as a CaptureWatch', () => {
  test('reads the buffers live, in buffer order', () => {
    const clock = createManualClock(0);
    const buffers = new CaptureBuffers({ clock });
    expect(buffers.consoleEntries()).toEqual([]);
    expect(buffers.networkEntries()).toEqual([]);
    buffers.pushConsole({ timestamp: 1, level: 'warn', text: 'a', source: 'console' });
    buffers.networkEntry('r1').url = 'https://x.test/one';
    buffers.networkEntry('r2').url = 'https://x.test/two';
    buffers.networkEntry('r1').finished_at = 5;
    expect(buffers.consoleEntries().map((e) => e.text)).toEqual(['a']);
    expect(buffers.networkEntries().map((e) => e.request_id)).toEqual(['r1', 'r2']);
    expect([...buffers.finishedUrls()]).toEqual(['https://x.test/one']);
  });
});

describe('normalizeConsoleLevel and stringifyConsoleArg', () => {
  test('levels map to the documented vocabulary; other CDP types are kept', () => {
    expect(normalizeConsoleLevel(undefined)).toBe('log');
    expect(normalizeConsoleLevel('warning')).toBe('warn');
    expect(normalizeConsoleLevel('verbose')).toBe('debug');
    expect(normalizeConsoleLevel('table')).toBe('table');
  });

  test('args print without [object Object]', () => {
    expect(stringifyConsoleArg('s')).toBe('s');
    expect(stringifyConsoleArg(null)).toBe('null');
    expect(stringifyConsoleArg(undefined)).toBe('undefined');
    expect(stringifyConsoleArg(3)).toBe('3');
    expect(stringifyConsoleArg(10n)).toBe('10');
    expect(stringifyConsoleArg({ a: [1] })).toBe('{"a":[1]}');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(stringifyConsoleArg(cyclic)).toBe('[object Object]');
  });
});
