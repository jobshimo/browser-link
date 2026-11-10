import { describe, expect, test } from 'vitest';
import { messages } from './i18n.js';
import {
  englishText,
  renderWorkerText,
  workerFailure,
  type WorkerMessage,
} from './worker-messages.js';

const EN = messages('en');
const ES = messages('es');

describe('englishText', () => {
  test('is exactly the English the service worker sent before codes existed', () => {
    const legacy: [WorkerMessage, string][] = [
      [{ code: 'tab-already-connected' }, 'This tab is already connected'],
      [{ code: 'tab-no-url' }, 'Tab has no URL or title'],
      [{ code: 'debugger-attach-failed', values: { detail: 'x' } }, 'Could not attach debugger: x'],
      [{ code: 'cdp-enable-failed', values: { detail: 'x' } }, 'Could not enable CDP: x'],
      [{ code: 'ws-connect-failed' }, 'WebSocket connection failed. Is the MCP server running?'],
      [{ code: 'ws-closed-before-registration' }, 'WebSocket closed before registration'],
      [{ code: 'recording-disabled' }, 'Flow recording is disabled. Enable it in settings first.'],
      [{ code: 'tab-not-connected' }, 'This tab is not connected.'],
      [
        { code: 'recording-in-progress' },
        'A recording is already in progress (or awaiting review).',
      ],
      [{ code: 'tab-gone' }, 'Tab no longer exists.'],
      [{ code: 'recording-start-failed', values: { detail: 'x' } }, 'Could not start recording: x'],
      [{ code: 'not-recording' }, 'Not currently recording this tab.'],
      [{ code: 'recording-discarded-while-saving' }, 'Discarded before the save finished.'],
      [{ code: 'no-reviewed-recording' }, 'No reviewed recording to save for this tab.'],
      [{ code: 'server-not-connected' }, 'Not connected to the server.'],
      [{ code: 'name-required' }, 'Name is required.'],
      [{ code: 'no-steps' }, 'No steps were captured.'],
      [{ code: 'server-timeout' }, 'Timed out waiting for the server.'],
      [
        { code: 'repair-server-too-old', values: { version: '0.40.0' } },
        'server 0.40.0 cannot repair itself: run `browser-link stop` and restart your agent',
      ],
      [
        { code: 'repair-server-too-old' },
        'server (unknown version) cannot repair itself: run `browser-link stop` and restart your agent',
      ],
      [
        { code: 'repair-no-server' },
        'no server is running: start browser-link from your agent or a console',
      ],
      [
        { code: 'repair-no-answer' },
        'The server did not answer the repair request: run `browser-link stop` and restart your agent',
      ],
      [
        { code: 'repair-restarting' },
        'The server is restarting; connected tabs reconnect by themselves.',
      ],
      [{ code: 'repair-failed', values: { detail: 'boom' } }, 'Repair failed: boom'],
      [
        { code: 'repair-reconnected', values: { reconnected: 1, total: 2 } },
        'Reconnected 1 of 2 tabs.',
      ],
      [
        { code: 'repair-reconnected', values: { reconnected: 1, total: 1 } },
        'Reconnected 1 of 1 tab.',
      ],
    ];
    for (const [message, text] of legacy) expect(englishText(message), message.code).toBe(text);
  });
});

describe('workerFailure', () => {
  test('keeps the English text and adds the code and values', () => {
    expect(workerFailure({ code: 'recording-start-failed', values: { detail: 'gone' } })).toEqual({
      ok: false,
      error: 'Could not start recording: gone',
      code: 'recording-start-failed',
      values: { detail: 'gone' },
    });
    expect(workerFailure({ code: 'name-required' })).toEqual({
      ok: false,
      error: 'Name is required.',
      code: 'name-required',
    });
  });
});

describe('a refused handshake (ws-handshake-refused): refused, and why, in both languages', () => {
  const refused = (reason: string): WorkerMessage =>
    ({ code: 'ws-handshake-refused', values: { reason } }) as WorkerMessage;

  test.each([
    [
      'origin-not-allowed',
      "The browser-link server refused the connection: it does not accept this extension's id. Reload the extension from the installed browser-link version.",
      'El servidor de browser-link rechazó la conexión: no acepta el id de esta extensión. Vuelva a cargar la extensión desde la versión de browser-link instalada.',
    ],
    [
      'peer-unidentified',
      'The browser-link server refused the connection: it could not see which program opened the connection.',
      'El servidor de browser-link rechazó la conexión: no pudo ver qué programa abrió la conexión.',
    ],
    [
      'peer-unknown',
      'The browser-link server refused the connection: it could not identify the program that opened the connection.',
      'El servidor de browser-link rechazó la conexión: no pudo identificar el programa que abrió la conexión.',
    ],
    [
      'peer-not-browser',
      'The browser-link server refused the connection: the program that opened the connection is not a supported Chromium-based browser.',
      'El servidor de browser-link rechazó la conexión: el programa que abrió la conexión no es un navegador compatible basado en Chromium.',
    ],
    [
      'process-lookup-failed',
      'The browser-link server refused the connection: checking the program that opened the connection failed.',
      'El servidor de browser-link rechazó la conexión: falló la comprobación del programa que abrió la conexión.',
    ],
    [
      'other',
      'The browser-link server refused the connection: this extension version does not know the reason. Update the extension.',
      'El servidor de browser-link rechazó la conexión: esta versión de la extensión no conoce el motivo. Actualice la extensión.',
    ],
  ])('%s', (reason, en, es) => {
    const failure = workerFailure(refused(reason));
    expect(failure).toEqual({
      ok: false,
      error: en,
      code: 'ws-handshake-refused',
      values: { reason },
    });
    expect(
      renderWorkerText(EN, { text: failure.error, code: failure.code, values: failure.values }),
    ).toBe(en);
    expect(
      renderWorkerText(ES, { text: failure.error, code: failure.code, values: failure.values }),
    ).toBe(es);
  });

  test('a reason code a newer worker sends renders as the unknown reason', () => {
    expect(
      renderWorkerText(ES, {
        text: 'x',
        code: 'ws-handshake-refused',
        values: { reason: 'from-the-future' },
      }),
    ).toBe(
      'El servidor de browser-link rechazó la conexión: esta versión de la extensión no conoce el motivo. Actualice la extensión.',
    );
  });

  test('without a reason value it falls back to the carried text', () => {
    expect(renderWorkerText(ES, { text: 'carried', code: 'ws-handshake-refused' })).toBe('carried');
  });
});

describe('renderWorkerText', () => {
  test('a coded message renders in the window language', () => {
    expect(renderWorkerText(ES, { text: 'Name is required.', code: 'name-required' })).toBe(
      'El nombre es obligatorio.',
    );
    expect(
      renderWorkerText(ES, {
        text: 'Reconnected 2 of 3 tabs.',
        code: 'repair-reconnected',
        values: { reconnected: 2, total: 3 },
      }),
    ).toBe('Se reconectaron 2 de 3 pestañas.');
    expect(renderWorkerText(EN, { text: 'ignored', code: 'tab-gone' })).toBe(
      'Tab no longer exists.',
    );
  });

  test('an older-shaped message (text only, no code) still renders its text', () => {
    expect(renderWorkerText(ES, { text: 'Some message from an older worker' })).toBe(
      'Some message from an older worker',
    );
  });

  test('an unknown code or unusable values fall back to the carried text', () => {
    expect(renderWorkerText(ES, { text: 'from the future', code: 'not-a-code' })).toBe(
      'from the future',
    );
    expect(
      renderWorkerText(ES, {
        text: 'Could not start recording: x',
        code: 'recording-start-failed',
      }),
    ).toBe('Could not start recording: x');
    expect(renderWorkerText(ES, { text: 't', code: 'repair-failed', values: { detail: 42 } })).toBe(
      't',
    );
  });
});
