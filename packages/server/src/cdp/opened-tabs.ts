/**
 * `browser.wait_for_tab` on a `cdp:` opener (parity program P7, G11): the
 * tabs a `cdp:` tab opens, seen on a browser-level DevTools socket and
 * announced as `tab-created` in the bridge event log, as the extension
 * announces the tabs a connected tab opens (`extension/src/app/tab-events.ts`).
 *
 * Experiment X3 (`packages/plan/lab/2026-11-20-cdp-direct-browser-socket/`):
 * `/json/list` has no opener field, so the opener can only be read on the
 * browser socket, where `Target.targetCreated` carries `openerId` for a
 * `window.open` from a script or a click and for a `target=_blank` link (with
 * or without `noopener`), on Chrome 118 and 157. Its first event has an empty
 * url; the url arrives in the following `Target.targetInfoChanged`.
 *
 * Choices:
 * - **Per-call socket.** `watchOpenedTabs` opens the browser socket for one
 *   `wait_for_tab` call and the returned stop closes it; the dispatcher calls
 *   it on every way the call ends (match, timeout, a failed start). The socket
 *   is never cached, so the 5-minute idle sweep of page sockets and any
 *   future close of cdp-direct (gate A) have nothing to do with it.
 * - **Discovery only.** The socket sends `Target.setDiscoverTargets` and
 *   nothing else (`BROWSER_SOCKET_COMMANDS`): no `Browser.setPermission` or
 *   `grantPermissions`. X3 found that closing a DevTools session that SET a
 *   permission override clears every override of that browser context, other
 *   clients' included; a socket that sets nothing cannot do that.
 * - **Only the opener's own pages.** Discovery reports every target of the
 *   browser instance, the user's own tabs and windows included. A target is
 *   reported only when it is a drivable page (`isDrivablePageTarget`) whose
 *   `openerId` is the waiting `cdp:` tab, and that tab is itself a drivable
 *   page while cdp-direct's gate (enabled + live grant) is open; everything
 *   else is ignored.
 * - **Keyed sink.** The event is raised for a target cdp-direct never dialed,
 *   so it cannot use a connection-bound sink (the dialogs' `DialogEventSink`).
 *   `CdpTabCreatedSink` takes the new `cdp:` id with the payload, and
 *   `server.ts` installs it over `BridgeEventLog`, as it installs the flow and
 *   dialog sinks.
 * - **A page opened just before the wait.** Discovery first lists every
 *   existing target; a page the opener opened before the socket was up (the
 *   click landed first) is reported from that listing. A target this process
 *   already reported is not reported again (`reported`).
 *
 * The browser-context ids differ between Chrome 118 and 157 (X3 section 2);
 * discovery does not use them.
 */
import { loadConfig, sanitizeCdpPort } from '../config.js';
import { CdpClient } from './client.js';
import { checkCdpDirectGate, type CdpDirectGate } from './gate.js';
import {
  browserSocketUrl,
  CDP_TAB_ID_PREFIX,
  cdpTargetIdFromTabId,
  isDrivablePageTarget,
} from './targets.js';

/** Every command the browser-level socket may send: discovery only. */
export const BROWSER_SOCKET_COMMANDS: ReadonlySet<string> = new Set(['Target.setDiscoverTargets']);

/** What the watch needs of a browser-level socket. */
export interface BrowserSocket {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  onAny(handler: (method: string, params: unknown) => void): () => void;
  close(): void;
}

/** A page the opener opened: its target id and url. */
export interface OpenedTab {
  targetId: string;
  url: string;
}

/** Where a `tab-created` of a `cdp:` opener goes, keyed by the new tab's
 * `cdp:` id; the payload is the extension's (`opened_from`, `url`). */
export type CdpTabCreatedSink = (tabId: string, data: { opened_from: string; url: string }) => void;

let tabCreatedSink: CdpTabCreatedSink | null = null;

/** Installed by `server.ts` over the bridge event log; a build or test that
 * never installs it emits nothing. */
export function setCdpTabCreatedSink(sink: CdpTabCreatedSink | null): void {
  tabCreatedSink = sink;
}

/** The targets this process already reported, oldest first, bounded. */
const REPORTED_LIMIT = 256;
const reportedTargets = new Set<string>();

function remember(reported: Set<string>, targetId: string): void {
  reported.add(targetId);
  if (reported.size > REPORTED_LIMIT) {
    const oldest = reported.values().next().value;
    if (oldest !== undefined) reported.delete(oldest);
  }
}

interface TargetFacts {
  type?: string;
  url?: string;
  openerId?: string;
}

function targetInfoOf(params: unknown): (TargetFacts & { targetId: string }) | null {
  if (typeof params !== 'object' || params === null) return null;
  const info = (params as { targetInfo?: unknown }).targetInfo;
  if (typeof info !== 'object' || info === null) return null;
  const { targetId, type, url, openerId } = info as Record<string, unknown>;
  if (typeof targetId !== 'string' || targetId.length === 0) return null;
  return {
    targetId,
    type: typeof type === 'string' ? type : undefined,
    url: typeof url === 'string' ? url : undefined,
    openerId: typeof openerId === 'string' ? openerId : undefined,
  };
}

/**
 * The filter over the browser socket's target events: fed every event in
 * order, it answers the pages `openerTargetId` opened that became
 * reportable with that event (each at most once). A page is reportable when
 * its type is `page`, its `openerId` is the opener, its url is known (not
 * empty) and drivable, the opener itself is known as a drivable page, and
 * `alreadyReported` does not hold it.
 */
export function createOpenedTabFilter(
  openerTargetId: string,
  alreadyReported: (targetId: string) => boolean = () => false,
): (method: string, params: unknown) => OpenedTab[] {
  const targets = new Map<string, TargetFacts>();
  const done = new Set<string>();

  const openerDrivable = (): boolean => {
    const opener = targets.get(openerTargetId);
    return opener !== undefined && isDrivablePageTarget(opener.type, opener.url);
  };

  const reportable = (targetId: string, facts: TargetFacts): boolean =>
    targetId !== openerTargetId &&
    !done.has(targetId) &&
    facts.type === 'page' &&
    facts.openerId === openerTargetId &&
    typeof facts.url === 'string' &&
    facts.url.length > 0 &&
    isDrivablePageTarget(facts.type, facts.url) &&
    !alreadyReported(targetId);

  const drain = (): OpenedTab[] => {
    if (!openerDrivable()) return [];
    const out: OpenedTab[] = [];
    for (const [targetId, facts] of targets) {
      if (!reportable(targetId, facts)) continue;
      done.add(targetId);
      out.push({ targetId, url: facts.url as string });
    }
    return out;
  };

  return (method, params) => {
    if (method === 'Target.targetDestroyed') {
      const id = (params as { targetId?: unknown } | null)?.targetId;
      if (typeof id === 'string') targets.delete(id);
      return [];
    }
    if (method !== 'Target.targetCreated' && method !== 'Target.targetInfoChanged') return [];
    const info = targetInfoOf(params);
    if (!info) return [];
    const { targetId, ...facts } = info;
    targets.set(targetId, facts);
    return drain();
  };
}

/** What `watchOpenedTabs` uses; every field has a production default. */
export interface OpenedTabsDeps {
  gate(): CdpDirectGate;
  socketUrl(): Promise<string | null>;
  openSocket(url: string): Promise<BrowserSocket>;
  sink?: CdpTabCreatedSink;
  reported?: Set<string>;
}

async function openBrowserSocket(url: string): Promise<BrowserSocket> {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error('cdp-direct: could not parse the browser-level ws url');
  }
  if (host !== '127.0.0.1') {
    throw new Error('cdp-direct: refusing a non-loopback browser-level ws url');
  }
  const client = new CdpClient(url);
  await client.connect();
  return {
    send: (method, params) => client.send(method, params),
    onAny: (handler) => client.onAny(handler),
    close: () => {
      client.close();
    },
  };
}

function defaultDeps(): OpenedTabsDeps {
  return {
    gate: () => checkCdpDirectGate(),
    socketUrl: () => browserSocketUrl(sanitizeCdpPort(loadConfig().cdpDirectPort)),
    openSocket: openBrowserSocket,
  };
}

/**
 * Watch the pages the `cdp:` tab `openerTabId` opens, for one
 * `wait_for_tab` call: open the browser socket, subscribe, turn discovery
 * on, and add a `tab-created { tab_id, opened_from, url }` through the sink
 * for each page reported. Resolves to the stop function (idempotent: it
 * unsubscribes and closes the socket); rejects, with nothing left open, when
 * the gate is closed, the opener id is malformed, the browser endpoint is
 * missing or discovery cannot start.
 */
export async function watchOpenedTabs(
  openerTabId: string,
  deps: OpenedTabsDeps = defaultDeps(),
): Promise<() => void> {
  const gate = deps.gate();
  if (!gate.ok) throw new Error(gate.error);
  const openerTargetId = cdpTargetIdFromTabId(openerTabId);
  if (openerTargetId === null) {
    throw new Error(`cdp-direct: malformed cdp: tab id ${JSON.stringify(openerTabId)}`);
  }
  const url = await deps.socketUrl();
  if (url === null) {
    throw new Error(
      'cdp-direct: no browser-level DevTools endpoint on the configured port (/json/version has no webSocketDebuggerUrl)',
    );
  }
  const socket = await deps.openSocket(url);
  const reported = deps.reported ?? reportedTargets;
  const filter = createOpenedTabFilter(openerTargetId, (id) => reported.has(id));
  let stopped = false;
  const unsubscribe = socket.onAny((method, params) => {
    if (stopped) return;
    for (const opened of filter(method, params)) {
      // The grant can lapse during the wait: nothing is announced then.
      if (!deps.gate().ok) continue;
      if (reported.has(opened.targetId)) continue;
      remember(reported, opened.targetId);
      (deps.sink ?? tabCreatedSink)?.(`${CDP_TAB_ID_PREFIX}${opened.targetId}`, {
        opened_from: openerTabId,
        url: opened.url,
      });
    }
  });
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    unsubscribe();
    socket.close();
  };
  try {
    await sendDiscovery(socket, 'Target.setDiscoverTargets', { discover: true });
  } catch (err) {
    stop();
    throw err;
  }
  return stop;
}

/** The only way this module sends on the browser socket. */
function sendDiscovery(
  socket: BrowserSocket,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  if (!BROWSER_SOCKET_COMMANDS.has(method)) {
    return Promise.reject(new Error(`cdp-direct: ${method} is not sent on the browser socket`));
  }
  return socket.send(method, params);
}
