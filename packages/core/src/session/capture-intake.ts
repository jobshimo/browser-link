// The console and network half of a tab's CDP event intake (cdp-direct
// parity design, step 3.4 and slice P5): `Runtime.consoleAPICalled`,
// `Log.entryAdded` and the `Network.*` request events into the page's
// bounded capture buffers. One authored body for both transports, beside
// the dialog half (`session/dialog-intake.ts`). The extension calls it from
// its debugger intake (`app/tab-connection.ts`) into the `CaptureBuffers`
// its `TabSession` composes; cdp-direct does not use it yet (P5's behaviour
// PR subscribes it to the connection's `CdpSession.onEvent`).
//
// Not a port (design revisions 7, 8 and 13): `CaptureBuffers` is observed
// state read through `CaptureWatch`. The intake sends nothing toward the
// server, so it takes no sink.

import type { Clock } from '../ports/clock.js';
import type { CaptureWatch, ConsoleEntry, NetworkEntry } from './page-driver.js';

/** Console entries kept per tab; the oldest is dropped first. */
export const CONSOLE_BUFFER_MAX = 200;
/** Network entries kept per tab; the oldest request is dropped first. */
export const NETWORK_BUFFER_MAX = 200;

export interface CaptureBuffersDeps {
  /** Stamps `started_at` on a request the first time it is seen. */
  clock: Clock;
}

/**
 * The console and network buffers of one page, without the rest of a
 * `TabSession` (no driver, no idle rules), so a transport that holds no
 * `TabSession` can keep them per target. It is its own `CaptureWatch`,
 * read live on every call.
 *
 * Invariants: the console buffer holds at most `CONSOLE_BUFFER_MAX` entries
 * and the network buffer at most `NETWORK_BUFFER_MAX`, oldest dropped first;
 * `networkOrder` and `networkBuffer` always hold the same ids.
 */
export class CaptureBuffers implements CaptureWatch {
  private readonly clock: Clock;
  private readonly consoleList: ConsoleEntry[] = [];
  private readonly networkMap = new Map<string, NetworkEntry>();
  private readonly networkIds: string[] = [];

  constructor({ clock }: CaptureBuffersDeps) {
    this.clock = clock;
  }

  get consoleBuffer(): readonly ConsoleEntry[] {
    return this.consoleList;
  }

  get networkBuffer(): ReadonlyMap<string, NetworkEntry> {
    return this.networkMap;
  }

  get networkOrder(): readonly string[] {
    return this.networkIds;
  }

  pushConsole(entry: ConsoleEntry): void {
    this.consoleList.push(entry);
    if (this.consoleList.length > CONSOLE_BUFFER_MAX) this.consoleList.shift();
  }

  /** The network entry of `requestId`, created (and the oldest dropped past
   * the bound) the first time the request is seen. */
  networkEntry(requestId: string): NetworkEntry {
    let entry = this.networkMap.get(requestId);
    if (!entry) {
      entry = { request_id: requestId, url: '', method: '', started_at: this.clock.now() };
      this.networkMap.set(requestId, entry);
      this.networkIds.push(requestId);
      while (this.networkIds.length > NETWORK_BUFFER_MAX) {
        const oldId = this.networkIds.shift();
        if (oldId !== undefined) this.networkMap.delete(oldId);
      }
    }
    return entry;
  }

  /** The URLs of the requests that have finished, in the order the
   * requests were first seen. */
  *finishedUrls(): Iterable<string> {
    for (const id of this.networkIds) {
      const entry = this.networkMap.get(id);
      if (entry?.finished_at !== undefined) yield entry.url;
    }
  }

  consoleEntries(): readonly ConsoleEntry[] {
    return this.consoleList;
  }

  networkEntries(): readonly NetworkEntry[] {
    return this.networkIds
      .map((id) => this.networkMap.get(id))
      .filter((entry): entry is NetworkEntry => entry !== undefined);
  }
}

/**
 * The console vocabulary `browser.console` documents is
 * log | info | warn | error | debug. Chrome reports `warning` (both
 * Runtime.consoleAPICalled and Log.entryAdded) and `verbose` (Log.entryAdded),
 * so the stored level is normalised to the documented names; otherwise a
 * `level: 'warn'` filter can never match a warning. Other CDP types (dir,
 * table, trace, ...) are kept as Chrome names them.
 */
export function normalizeConsoleLevel(level: string | undefined): string {
  switch (level) {
    case undefined:
      return 'log';
    case 'warning':
      return 'warn';
    case 'verbose':
      return 'debug';
    default:
      return level;
  }
}

// Convert an arbitrary console arg (`unknown`) into something printable
// without leaking `[object Object]`. Used by the console buffer when CDP
// hands us values we don't statically know.
export function stringifyConsoleArg(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return Object.prototype.toString.call(v);
  }
}

// === CDP types — only the fields the intake reads ======================

interface CdpRuntimeConsoleAPICalled {
  args?: { value?: unknown; description?: string }[];
  timestamp?: number;
  type?: string;
}

interface CdpLogEntryAdded {
  entry?: {
    level?: string;
    text?: string;
    timestamp?: number;
    url?: string;
    lineNumber?: number;
  };
}

interface CdpNetworkRequestWillBeSent {
  requestId: string;
  type?: string;
  request?: {
    url?: string;
    method?: string;
    headers?: Record<string, string>;
    postData?: string;
  };
}

interface CdpNetworkResponseReceived {
  requestId: string;
  response?: {
    status?: number;
    statusText?: string;
    mimeType?: string;
    headers?: Record<string, string>;
  };
}

interface CdpNetworkLoadingFinished {
  requestId: string;
  encodedDataLength?: number;
}

interface CdpNetworkLoadingFailed {
  requestId: string;
  errorText?: string;
}

/**
 * The capture intake of one connection: a CDP event listener that maps the
 * console, log and network events into `buffers`, stamping on `clock` what
 * the event does not carry. Answers true when it handled the event, false
 * for any other method (left untouched). Headers and post data are kept as
 * Chrome reports them.
 */
export function captureIntake(
  buffers: CaptureBuffers,
  clock: Clock,
): (method: string, params: unknown) => boolean {
  return (method, params) => {
    if (method === 'Runtime.consoleAPICalled') {
      const p = params as CdpRuntimeConsoleAPICalled;
      const args = p.args ?? [];
      const text = args
        .map((a) => (a.value !== undefined ? stringifyConsoleArg(a.value) : (a.description ?? '')))
        .join(' ');
      buffers.pushConsole({
        timestamp: p.timestamp ?? clock.now(),
        level: normalizeConsoleLevel(p.type),
        text,
        source: 'console',
      });
      return true;
    }
    if (method === 'Log.entryAdded') {
      const p = params as CdpLogEntryAdded;
      const e = p.entry ?? {};
      buffers.pushConsole({
        timestamp: e.timestamp ?? clock.now(),
        level: normalizeConsoleLevel(e.level),
        text: e.text ?? '',
        source: 'log',
        url: e.url,
        line: e.lineNumber,
      });
      return true;
    }
    if (method === 'Network.requestWillBeSent') {
      const p = params as CdpNetworkRequestWillBeSent;
      const entry = buffers.networkEntry(p.requestId);
      entry.url = p.request?.url ?? entry.url;
      entry.method = p.request?.method ?? entry.method;
      entry.resource_type = p.type ?? entry.resource_type;
      entry.request_headers = p.request?.headers ?? entry.request_headers;
      entry.request_post_data = p.request?.postData ?? entry.request_post_data;
      return true;
    }
    if (method === 'Network.responseReceived') {
      const p = params as CdpNetworkResponseReceived;
      const entry = buffers.networkEntry(p.requestId);
      entry.status = p.response?.status;
      entry.status_text = p.response?.statusText;
      entry.mime_type = p.response?.mimeType;
      entry.response_headers = p.response?.headers;
      return true;
    }
    if (method === 'Network.loadingFinished') {
      const p = params as CdpNetworkLoadingFinished;
      const entry = buffers.networkEntry(p.requestId);
      entry.finished_at = clock.now();
      entry.encoded_data_length = p.encodedDataLength;
      return true;
    }
    if (method === 'Network.loadingFailed') {
      const p = params as CdpNetworkLoadingFailed;
      const entry = buffers.networkEntry(p.requestId);
      entry.finished_at = clock.now();
      entry.failed = p.errorText ?? 'failed';
      return true;
    }
    return false;
  };
}
