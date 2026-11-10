/**
 * Messages the service worker returns to the extension's windows (connect
 * and recording errors, repair outcomes) as a stable code plus the values to
 * interpolate, so each window renders them in its own interface language.
 *
 * The worker never translates: it keeps sending the English text it always
 * sent (`error` / `message`, built here from the English dictionary) and adds
 * `code` and `values` next to it. A window renders the code through its
 * dictionary; a message without a code (an older worker) or with an unknown
 * code or unusable values shows the text it carried.
 *
 * Not for tool errors: what travels to the MCP server for an agent stays the
 * plain English string of the tools' contract.
 *
 * Pure: no `chrome.*`, no DOM.
 */
import type { HandshakeRefusalReason } from './handshake-diagnosis.js';
import { messages, type Messages } from './i18n.js';

export type WorkerMessageValues = Readonly<Record<string, string | number>>;

export type WorkerMessage =
  | {
      code:
        | 'tab-already-connected'
        | 'tab-no-url'
        | 'ws-connect-failed'
        | 'ws-closed-before-registration'
        | 'recording-disabled'
        | 'tab-not-connected'
        | 'recording-in-progress'
        | 'tab-gone'
        | 'not-recording'
        | 'recording-discarded-while-saving'
        | 'no-reviewed-recording'
        | 'server-not-connected'
        | 'name-required'
        | 'no-steps'
        | 'server-timeout'
        | 'repair-no-server'
        | 'repair-no-answer'
        | 'repair-restarting';
      values?: undefined;
    }
  | {
      code:
        'debugger-attach-failed' | 'cdp-enable-failed' | 'recording-start-failed' | 'repair-failed';
      values: { detail: string };
    }
  | { code: 'ws-handshake-refused'; values: { reason: HandshakeRefusalReason } }
  | { code: 'repair-server-too-old'; values?: { version: string } }
  | { code: 'repair-reconnected'; values: { reconnected: number; total: number } };

export type WorkerMessageCode = WorkerMessage['code'];

/** What a window receives: the text the worker sent, and its code and values
 * when the worker sent them. Loosely typed on purpose: it arrived over
 * `chrome.runtime` messaging and may come from an older or newer worker. */
export interface CarriedMessage {
  text: string;
  code?: unknown;
  values?: unknown;
}

function valuesOf(values: unknown): Readonly<Record<string, unknown>> {
  return typeof values === 'object' && values !== null ? (values as Record<string, unknown>) : {};
}

/** Why the bridge refused a handshake, in `t`'s language; a code this
 * version does not know reads as the unknown reason. */
function refusalReason(t: Messages, reason: string): string {
  switch (reason) {
    case 'origin-not-allowed':
      return t.handshakeReasonOriginNotAllowed;
    case 'peer-unidentified':
      return t.handshakeReasonPeerUnidentified;
    case 'peer-unknown':
      return t.handshakeReasonPeerUnknown;
    case 'peer-not-browser':
      return t.handshakeReasonPeerNotBrowser;
    case 'process-lookup-failed':
      return t.handshakeReasonLookupFailed;
    default:
      return t.handshakeReasonOther;
  }
}

/** The message in `t`'s language, or undefined when the code is unknown or a
 * value it needs is missing or of the wrong type. */
function render(t: Messages, code: unknown, rawValues: unknown): string | undefined {
  const values = valuesOf(rawValues);
  const text = (key: string): string | undefined =>
    typeof values[key] === 'string' ? values[key] : undefined;
  const count = (key: string): number | undefined =>
    typeof values[key] === 'number' ? values[key] : undefined;
  const withDetail = (fn: (detail: string) => string): string | undefined => {
    const detail = text('detail');
    return detail === undefined ? undefined : fn(detail);
  };
  switch (code) {
    case 'tab-already-connected':
      return t.workerTabAlreadyConnected;
    case 'tab-no-url':
      return t.workerTabNoUrl;
    case 'debugger-attach-failed':
      return withDetail(t.workerDebuggerAttachFailed);
    case 'cdp-enable-failed':
      return withDetail(t.workerCdpEnableFailed);
    case 'ws-connect-failed':
      return t.workerWsConnectFailed;
    case 'ws-closed-before-registration':
      return t.workerWsClosedBeforeRegistration;
    case 'ws-handshake-refused': {
      const reason = text('reason');
      return reason === undefined ? undefined : t.workerHandshakeRefused(refusalReason(t, reason));
    }
    case 'recording-disabled':
      return t.workerRecordingDisabled;
    case 'tab-not-connected':
      return t.workerTabNotConnected;
    case 'recording-in-progress':
      return t.workerRecordingInProgress;
    case 'tab-gone':
      return t.workerTabGone;
    case 'recording-start-failed':
      return withDetail(t.workerRecordingStartFailed);
    case 'not-recording':
      return t.workerNotRecording;
    case 'recording-discarded-while-saving':
      return t.workerRecordingDiscarded;
    case 'no-reviewed-recording':
      return t.workerNoReviewedRecording;
    case 'server-not-connected':
      return t.workerServerNotConnected;
    case 'name-required':
      return t.workerNameRequired;
    case 'no-steps':
      return t.workerNoSteps;
    case 'server-timeout':
      return t.workerServerTimeout;
    case 'repair-server-too-old':
      return t.repairServerTooOld(text('version'));
    case 'repair-no-server':
      return t.repairNoServer;
    case 'repair-no-answer':
      return t.repairNoAnswer;
    case 'repair-restarting':
      return t.repairRestarting;
    case 'repair-failed':
      return withDetail(t.repairFailed);
    case 'repair-reconnected': {
      const reconnected = count('reconnected');
      const total = count('total');
      return reconnected === undefined || total === undefined
        ? undefined
        : t.repairReconnected(reconnected, total);
    }
    default:
      return undefined;
  }
}

/** The English text the worker sends alongside the code. */
export function englishText(message: WorkerMessage): string {
  return render(messages('en'), message.code, message.values) ?? message.code;
}

/** The code and values as they travel, without an empty `values`. */
export function codeFields(message: WorkerMessage): {
  code: WorkerMessageCode;
  values?: WorkerMessageValues;
} {
  return message.values === undefined
    ? { code: message.code }
    : { code: message.code, values: message.values };
}

/** A failed result for a window: the English `error` it always carried, plus
 * the code to render it in the window's language. */
export function workerFailure(message: WorkerMessage): {
  ok: false;
  error: string;
  code: WorkerMessageCode;
  values?: WorkerMessageValues;
} {
  return { ok: false, error: englishText(message), ...codeFields(message) };
}

/** What a window shows: the coded message in `t`'s language, else the text. */
export function renderWorkerText(t: Messages, carried: CarriedMessage): string {
  return render(t, carried.code, carried.values) ?? carried.text;
}
