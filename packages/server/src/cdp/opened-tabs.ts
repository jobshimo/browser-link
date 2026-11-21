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
 *   existing target. A page of that listing the opener opened is returned
 *   only when the opener ran an action within the extension's 1.5 s replay
 *   window before the wait started (or during it); several such pages are an
 *   error naming them, never a pick by listing order. A target a wait already
 *   returned is not reported again (`markOpenedTabReturned`); one only
 *   announced to a wait that did not match it still is.
 * - **A dropped socket** ends the wait with `BROWSER_SOCKET_LOST_ERROR`.
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
  /** `onAnswer` runs synchronously on the answer's frame, before any later
   * frame is handled. */
  send(method: string, params?: Record<string, unknown>, onAnswer?: () => void): Promise<unknown>;
  onAny(handler: (method: string, params: unknown) => void): () => void;
  /** Runs once when the socket closes, whoever closed it. */
  onClose(handler: () => void): () => void;
  close(): void;
}

/** The error a `wait_for_tab` on a `cdp:` opener ends with when the browser
 * drops its browser-level socket before the wait settled. */
export const BROWSER_SOCKET_LOST_ERROR =
  'cdp-direct: the browser closed the browser-level DevTools connection browser.wait_for_tab was watching; no new tab can be seen on it. Retry the call.';

/** `raw` with its `send` limited to `BROWSER_SOCKET_COMMANDS`: any other
 * method is refused (a rejected promise) and never reaches the socket. */
export function guardBrowserSocket(raw: BrowserSocket): BrowserSocket {
  return {
    send: (method, params, onAnswer) =>
      BROWSER_SOCKET_COMMANDS.has(method)
        ? raw.send(method, params, onAnswer)
        : Promise.reject(new Error(`cdp-direct: ${method} is not sent on the browser socket`)),
    onAny: (handler) => raw.onAny(handler),
    onClose: (handler) => raw.onClose(handler),
    close: () => {
      raw.close();
    },
  };
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

/** The targets a `wait_for_tab` already returned (matched), oldest first,
 * bounded. A target only announced (`tab-created`) to a wait that did not
 * match it, for example because of its `url_substring`, is not here, so a
 * later wait on the same opener still sees it. */
const REPORTED_LIMIT = 256;
const reportedTargets = new Set<string>();

/** Record that a wait returned the `cdp:` tab `tabId` (the dispatcher calls
 * it on a match); later watches do not announce it again. Any other id is
 * ignored. */
export function markOpenedTabReturned(
  tabId: string,
  reported: Set<string> = reportedTargets,
): void {
  const targetId = cdpTargetIdFromTabId(tabId);
  if (targetId === null) return;
  reported.delete(targetId);
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
  /** Called once with the error that ended the watch before `stop`:
   * `BROWSER_SOCKET_LOST_ERROR` when the browser drops the socket, or the
   * ambiguity error when a first-listing candidate whose url came late
   * matches as well as another. */
  onLost?: (err: Error) => void;
  /** Read once, when discovery's first listing is complete: whether the
   * opener ran an action within the replay window before the wait started
   * (or during it). Only then may a page of the first listing be returned.
   * Default: never. */
  openerActedRecently?: () => boolean;
  /** Whether a page url can match the wait (its `url_substring`); a page of
   * the first listing that cannot is not a candidate. Default: every url. */
  accepts?: (url: string) => boolean;
}

/** Export for tests: open the guarded browser socket at a loopback url. */
export async function openBrowserSocket(url: string): Promise<BrowserSocket> {
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
  return guardBrowserSocket({
    send: (method, params, onAnswer) => client.send(method, params, undefined, onAnswer),
    onAny: (handler) => client.onAny(handler),
    onClose: (handler) => client.onClose(handler),
    close: () => {
      client.close();
    },
  });
}

function defaultDeps(): OpenedTabsDeps {
  return {
    gate: () => checkCdpDirectGate(),
    socketUrl: () => browserSocketUrl(sanitizeCdpPort(loadConfig().cdpDirectPort)),
    openSocket: openBrowserSocket,
  };
}

/** The text of the error a wait gets when several pages of the first listing
 * could be the one its opener's last action opened. Sorted by url, then id,
 * never by Chrome's listing order. */
export function ambiguousOpenedTabsMessage(
  openerTabId: string,
  pages: readonly OpenedTab[],
): string {
  const named = [...pages]
    .sort((a, b) => (a.url === b.url ? (a.targetId < b.targetId ? -1 : 1) : a.url < b.url ? -1 : 1))
    .map((p) => `${CDP_TAB_ID_PREFIX}${p.targetId} (${p.url === '' ? 'no url yet' : p.url})`)
    .join(', ');
  return (
    `cdp-direct: browser.wait_for_tab cannot tell which tab ${openerTabId} opened: ` +
    `${String(pages.length)} tabs it opened were already open when the wait started, ` +
    `within 1.5 s of its last action: ${named}. Call browser.list_tabs and pick one.`
  );
}

/**
 * Watch the pages the `cdp:` tab `openerTabId` opens, for one
 * `wait_for_tab` call: open the browser socket, subscribe, turn discovery
 * on, and add a `tab-created { tab_id, opened_from, url }` through the sink
 * for each page reported.
 *
 * Discovery first lists every existing target, before it answers
 * `Target.setDiscoverTargets`; those events are buffered and classified when
 * the answer's frame arrives (`onAnswer`, synchronous, so an event behind it
 * in the same chunk is not taken for the listing). A page of that first
 * listing that the opener opened is a candidate only when
 * `openerActedRecently()` holds and `accepts` its url: no candidate, nothing;
 * one, it is reported; several, the watch rejects with
 * `ambiguousOpenedTabsMessage`. A candidate whose url is not known yet is
 * judged when its url arrives: until every such candidate is judged (or
 * destroyed) nothing of the listing is reported; then one match is reported
 * and several end the watch through `onLost` with the same message. Every
 * other page of the listing is ignored for the whole watch. Pages created
 * afterwards are reported as they come.
 *
 * Resolves to the stop function (idempotent: it unsubscribes and closes the
 * socket); rejects, with nothing left open, when the gate is closed, the
 * opener id is malformed, the browser endpoint is missing, discovery cannot
 * start, or the first listing is ambiguous. A socket the browser drops
 * afterwards ends the watch and calls `onLost` with
 * `BROWSER_SOCKET_LOST_ERROR`. `overrides` replace the production
 * dependencies.
 */
export async function watchOpenedTabs(
  openerTabId: string,
  overrides: Partial<OpenedTabsDeps> = {},
): Promise<() => void> {
  const deps: OpenedTabsDeps = { ...defaultDeps(), ...overrides };
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
  const socket = guardBrowserSocket(await deps.openSocket(url));
  const reported = deps.reported ?? reportedTargets;
  const accepts = deps.accepts ?? (() => true);
  // Pages of the first listing that may not be reported, for the whole watch.
  const ignored = new Set<string>();
  const filter = createOpenedTabFilter(openerTargetId, (id) => reported.has(id) || ignored.has(id));
  const emit = (opened: OpenedTab): void => {
    // The grant can lapse during the wait: nothing is announced then.
    if (!deps.gate().ok) return;
    (deps.sink ?? tabCreatedSink)?.(`${CDP_TAB_ID_PREFIX}${opened.targetId}`, {
      opened_from: openerTabId,
      url: opened.url,
    });
  };

  let stopped = false;
  let listing: [string, unknown][] | null = [];
  // Set by endListing (a closure, so a holder rather than a let).
  const listingOutcome: { ambiguous: Error | null } = { ambiguous: null };
  // A first listing with candidates whose url was not known yet: judged when
  // every one of them has a url (or is gone). `matches` are the candidates
  // `accepts` took so far.
  let undecided: { matches: OpenedTab[]; waiting: Set<string> } | null = null;

  /** Judge the listing's waiting candidates with this live event; true when
   * the judgment ended the watch (several matches). */
  const judge = (method: string, params: unknown): boolean => {
    if (!undecided) return false;
    if (method === 'Target.targetDestroyed') {
      const id = (params as { targetId?: unknown } | null)?.targetId;
      if (typeof id === 'string') undecided.waiting.delete(id);
    } else if (method === 'Target.targetCreated' || method === 'Target.targetInfoChanged') {
      const info = targetInfoOf(params);
      if (info && undecided.waiting.has(info.targetId) && info.url) {
        undecided.waiting.delete(info.targetId);
        if (isDrivablePageTarget(info.type, info.url) && accepts(info.url)) {
          undecided.matches.push({ targetId: info.targetId, url: info.url });
        }
      }
    }
    if (undecided.waiting.size > 0) return false;
    const { matches } = undecided;
    undecided = null;
    if (matches.length > 1) {
      stop();
      deps.onLost?.(new Error(ambiguousOpenedTabsMessage(openerTabId, matches)));
      return true;
    }
    if (matches.length === 1) ignored.delete(matches[0].targetId);
    return false;
  };

  const unsubscribe = socket.onAny((method, params) => {
    if (stopped) return;
    if (listing) {
      listing.push([method, params]);
      return;
    }
    if (judge(method, params)) return;
    for (const opened of filter(method, params)) emit(opened);
  });

  /** Classify the first listing; runs on the answer's frame. */
  const endListing = (): void => {
    if (!listing) return;
    const events = listing;
    listing = null;
    const facts = new Map<string, { type?: string; url?: string; openerId?: string }>();
    for (const [method, params] of events) {
      if (method === 'Target.targetDestroyed') {
        const id = (params as { targetId?: unknown } | null)?.targetId;
        if (typeof id === 'string') facts.delete(id);
        continue;
      }
      if (method !== 'Target.targetCreated' && method !== 'Target.targetInfoChanged') continue;
      const info = targetInfoOf(params);
      if (info) facts.set(info.targetId, info);
    }
    const opener = facts.get(openerTargetId);
    const openerOk = opener !== undefined && isDrivablePageTarget(opener.type, opener.url);
    const candidates: OpenedTab[] = [];
    const unknownUrl: string[] = [];
    for (const [targetId, f] of facts) {
      if (targetId === openerTargetId) continue;
      ignored.add(targetId);
      if (!openerOk || f.type !== 'page' || f.openerId !== openerTargetId) continue;
      if (reported.has(targetId)) continue;
      const pageUrl = f.url ?? '';
      // No url yet: `accepts` cannot judge it until the url arrives.
      if (pageUrl === '') {
        unknownUrl.push(targetId);
        continue;
      }
      if (!isDrivablePageTarget(f.type, pageUrl) || !accepts(pageUrl)) continue;
      candidates.push({ targetId, url: pageUrl });
    }
    const allowed =
      candidates.length + unknownUrl.length > 0 && (deps.openerActedRecently?.() ?? false);
    if (allowed && candidates.length > 1) {
      listingOutcome.ambiguous = new Error(ambiguousOpenedTabsMessage(openerTabId, candidates));
    } else if (allowed && unknownUrl.length > 0) {
      undecided = { matches: candidates, waiting: new Set(unknownUrl) };
    } else if (allowed) {
      ignored.delete(candidates[0].targetId);
    }
    // Feed the listing to the filter: it learns the opener and every target;
    // only the allowed candidate can come out of it.
    for (const [method, params] of events) {
      for (const opened of filter(method, params)) if (!listingOutcome.ambiguous) emit(opened);
    }
  };

  const release = (): void => {
    stopped = true;
    unsubscribe();
    unsubscribeClose();
  };
  const unsubscribeClose = socket.onClose(() => {
    if (stopped) return;
    release();
    deps.onLost?.(new Error(BROWSER_SOCKET_LOST_ERROR));
  });
  const stop = (): void => {
    if (stopped) return;
    release();
    socket.close();
  };
  try {
    await socket.send('Target.setDiscoverTargets', { discover: true }, endListing);
    // A socket that answered without calling back still ends the listing.
    endListing();
  } catch (err) {
    stop();
    throw err;
  }
  if (listingOutcome.ambiguous) {
    stop();
    throw listingOutcome.ambiguous;
  }
  return stop;
}
