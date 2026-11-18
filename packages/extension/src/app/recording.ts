// Flow recording by demonstration (design 6.1, slice 20): the orchestration
// of one tab's recording, moved out of `background.ts`. STRICTLY OPT-IN and
// per-tab: nothing here runs unless the user enabled the setting AND pressed
// Record on a connected tab. Lifecycle:
//
//   start -> [navigation]* -> stop -> save | discard
//
// `Runtime.addBinding` (CDP) is added ONCE at start and left in place for the
// whole session: per the CDP spec it is re-installed automatically on every
// new execution context, navigations included, so it survives document swaps
// on its own. The in-page LISTENERS (`inpage/recorder.ts`, injected with
// `Runtime.evaluate`) do NOT survive a navigation (a document swap tears down
// every JS global the previous document set up), so `handleNavigation`
// re-injects the recorder script (not the binding) after every navigation
// observed while recording, from the tab's `complete` update.
//
// No `chrome`: `background.ts` passes in the CDP send, the page evaluate, the
// tab events adapter and the setting's cache. The decisions about what the
// step array holds next stay in the pure `../recording.ts`.

import type { Clock, FlowStep, TabRegistry } from '@browser-link/core';
import { buildRecorderJs, buildStopRecorderJs } from '../inpage/recorder.js';
import {
  DISCARDED_WHILE_SAVING,
  appendRecordingStep,
  buildAmbiguousNote,
  buildNavigationWaitForStep,
  generateRecordingSession,
  isNavigationForRecording,
  isSameRecordingSession,
} from '../recording.js';
import { workerFailure } from '../worker-messages.js';
import { SOCKET_OPEN, send, type TabConnection } from './tab-connection.js';

/** One `chrome.tabs.onUpdated` report, as `TabEvents.onUpdated` hands it on. */
export interface TabUpdate {
  tabId: number;
  /** The tab's load status of the update (`complete` ends a load). */
  status?: string;
  /** The tab's URL after the update. */
  url?: string;
}

/**
 * The tab events the extension uses (design 3.1 `TabEvents`, `chrome-tab-
 * events.ts`): what recording needs today, `get` and `onUpdated`. Slice 21
 * adds `onRemoved`, `onCreated` and `onDebuggerDetach` for the tab-event
 * listeners it moves.
 */
export interface TabEvents {
  /** The tab's current URL; rejects for a closed tab. */
  get(tabId: number): Promise<{ url?: string }>;
  /** Report every tab update; returns the function that stops the reports. */
  onUpdated(listener: (update: TabUpdate) => void): () => void;
}

/** How long a save waits for the server's `flow.recorded.result`. */
const SAVE_TIMEOUT_MS = 10_000;

export interface RecordingDeps {
  tabs: TabRegistry<TabConnection>;
  tabEvents: TabEvents;
  clock: Clock;
  /** The flow-recording setting, read live. */
  enabled(): boolean;
  /** Send one CDP command on the tab's debugger session. */
  cdp(tabId: number, method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** Evaluate an expression in the tab's page. */
  evaluate(tabId: number, expression: string): Promise<unknown>;
}

export type RecordingResult = { ok: boolean; error?: string };

export interface RecordingStatus {
  active: boolean;
  reviewing: boolean;
  stepCount: number;
  capped: boolean;
  steps?: FlowStep[];
  ambiguousStepIndices?: number[];
}

/** The recording operations over the worker's tabs. Stateful (the tabs'
 * navigation subscriptions), so built once and handed in. */
export interface Recording {
  /** Start recording on an already-connected tab. Refuses when the opt-in
   * setting is off, the tab is not connected, or a recording (recording OR
   * under review) is already in progress for it. */
  start(tabId: number): Promise<RecordingResult>;
  /** Stop the active recording; the steps stay on the tab for review. */
  stop(
    tabId: number,
  ): Promise<{ ok: boolean; steps?: FlowStep[]; capped?: boolean; error?: string }>;
  /** Shared tail of stop: also the step-cap auto-stop (`debuggerIntake`'s
   * `onRecordingCapped`, and a navigation step that hits the cap). */
  finish(tabId: number): Promise<void>;
  /** Discard a recording without saving, active or under review. */
  discard(tabId: number): Promise<{ ok: boolean }>;
  /** Stop (if still active) AND discard: the privacy-critical path used when
   * the setting flips off while a recording is in progress. */
  forceStopAndDiscard(tabId: number): Promise<void>;
  /** Send the reviewed recording to the server for validation and
   * persistence; clears the recording on success only. */
  save(tabId: number, name: string, description: string | undefined): Promise<RecordingResult>;
  /** What the popup shows for the tab. */
  status(tabId: number): RecordingStatus;
  /** Remove the tab's navigation subscription (the tab's teardown). */
  removeNavListener(tabId: number): void;
  /** Best-effort in-page teardown of the installed recorder. */
  teardownRecorder(tabId: number, stopFn: string): Promise<void>;
}

function originOfUrl(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

export function createRecording(deps: RecordingDeps): Recording {
  const { tabs, tabEvents, clock } = deps;

  /** The function that stops each recording tab's `onUpdated` reports, so
   * `finish`/`clear`/teardown remove EXACTLY the subscription that belongs
   * to the tab. Kept out of `TabConnection` only because the teardown must
   * reach it even in the split second before a connection exists. */
  const navSubscriptions = new Map<number, () => void>();

  function removeNavListener(tabId: number): void {
    const unsubscribe = navSubscriptions.get(tabId);
    if (unsubscribe) {
      unsubscribe();
      navSubscriptions.delete(tabId);
    }
  }

  async function injectRecorder(
    tabId: number,
    session: { bindingName: string; activeFlag: string; stopFn: string; nonce: string },
  ): Promise<void> {
    await deps.evaluate(
      tabId,
      buildRecorderJs({
        bindingName: session.bindingName,
        activeFlag: session.activeFlag,
        stopFn: session.stopFn,
        nonce: session.nonce,
      }),
    );
  }

  /** Best-effort in-page teardown: calls the installed recorder's own stop
   * function (named by the session's random `stopFn` global) so its
   * listeners are removed even before the CDP binding subscription is
   * dropped. A no-op when the tab already navigated away (nothing installed
   * on the new document), which is itself the correct end state. Runs on
   * EVERY exit path: Stop, Discard, setting-off force-stop, and the tab's
   * teardown (disconnect / tab removal / idle sweep), because
   * `chrome.debugger.detach` alone only drops the CDP binding subscription,
   * NOT the plain `window.addEventListener` listeners the recorder
   * installed; those must be removed in-page. */
  async function teardownRecorder(tabId: number, stopFn: string): Promise<void> {
    try {
      await deps.evaluate(tabId, buildStopRecorderJs(stopFn));
    } catch {
      // Tab closed/navigated/detached mid-teardown — nothing left to tear down.
    }
  }

  async function finish(tabId: number): Promise<void> {
    const state = tabs.get(tabId);
    if (!state?.recording || state.recording.status !== 'recording') return;
    removeNavListener(tabId);
    state.recording.status = 'reviewing';
    try {
      await deps.cdp(tabId, 'Runtime.removeBinding', { name: state.recording.bindingName });
    } catch {
      // Best effort — tab may already be detached.
    }
    await teardownRecorder(tabId, state.recording.stopFn);
  }

  async function handleNavigation(tabId: number, newUrl: string): Promise<void> {
    const state = tabs.get(tabId);
    const recording = state?.recording;
    if (!recording || recording.status !== 'recording') return;
    if (!isNavigationForRecording(recording.lastUrl, newUrl)) return;

    recording.lastUrl = newUrl;
    const result = appendRecordingStep(recording.steps, buildNavigationWaitForStep());
    recording.steps = result.steps;
    if (result.capped) {
      recording.capped = true;
      await finish(tabId);
      return;
    }
    // Re-inject only — the CDP binding itself persists across navigations
    // automatically (see the module doc). Same session identity: the
    // nonce/binding name rotate per recording START, not per document.
    await injectRecorder(tabId, recording);
  }

  async function start(tabId: number): Promise<RecordingResult> {
    if (!deps.enabled()) {
      return workerFailure({ code: 'recording-disabled' });
    }
    const state = tabs.get(tabId);
    if (!state) return workerFailure({ code: 'tab-not-connected' });
    if (state.recording) {
      return workerFailure({ code: 'recording-in-progress' });
    }

    let tab: { url?: string };
    try {
      tab = await tabEvents.get(tabId);
    } catch {
      return workerFailure({ code: 'tab-gone' });
    }

    // Fresh per-session identity: randomized binding name (no stable global
    // for a page to probe) + nonce (the shared secret authenticating every
    // payload). Rotated on EVERY recording start — see recorder.ts's THREAT
    // MODEL doc.
    const session = generateRecordingSession();
    try {
      await deps.cdp(tabId, 'Runtime.addBinding', { name: session.bindingName });
    } catch (err) {
      return workerFailure({
        code: 'recording-start-failed',
        values: { detail: err instanceof Error ? err.message : String(err) },
      });
    }
    try {
      await injectRecorder(tabId, session);
    } catch (err) {
      // The binding registered above is now orphaned — nothing else will
      // ever call Runtime.removeBinding for a session that never reached
      // `state.recording` (`finish`, the normal binding-removal path, only
      // runs for a recording that actually started). Without this rollback,
      // every retried Record click after a failed injection (e.g. a page CSP
      // blocking the injected script) leaks another binding on the same
      // debugger session. Best-effort: a rollback failure must not mask the
      // original injection error the caller needs to see.
      try {
        await deps.cdp(tabId, 'Runtime.removeBinding', { name: session.bindingName });
      } catch {
        // Tab likely already detached — nothing left to roll back.
      }
      return workerFailure({
        code: 'recording-start-failed',
        values: { detail: err instanceof Error ? err.message : String(err) },
      });
    }

    state.recording = {
      status: 'recording',
      steps: [],
      lastUrl: tab.url ?? '',
      capped: false,
      bindingName: session.bindingName,
      activeFlag: session.activeFlag,
      stopFn: session.stopFn,
      nonce: session.nonce,
      ambiguousStepIndices: [],
    };

    navSubscriptions.set(
      tabId,
      tabEvents.onUpdated((update) => {
        if (update.tabId !== tabId) return;
        if (update.status !== 'complete') return;
        void handleNavigation(tabId, update.url ?? '');
      }),
    );

    return { ok: true };
  }

  async function stop(
    tabId: number,
  ): Promise<{ ok: boolean; steps?: FlowStep[]; capped?: boolean; error?: string }> {
    const state = tabs.get(tabId);
    if (!state?.recording || state.recording.status !== 'recording') {
      return workerFailure({ code: 'not-recording' });
    }
    await finish(tabId);
    return { ok: true, steps: state.recording.steps, capped: state.recording.capped };
  }

  /** Full teardown, dropping any captured-but-unsaved steps. Used by
   * Discard, by the "setting turned off mid-recording" force-stop, and by
   * a successful save.
   *
   * Also settles a `save` call still in flight for this tab, as a failure —
   * without this, `state.pendingFlowSave` would keep waiting for the real
   * `flow.recorded.result` (or the 10s timeout) after the recording it
   * belongs to is already gone, and its success continuation would run
   * LATER, re-clearing whatever recording state exists by then (see
   * `isSameRecordingSession` in recording.ts for the other half of this fix
   * — belt-and-braces against that same class of stale-continuation bug).
   * This is what makes Discard-while-saving actually inert on the extension
   * side instead of merely racing the real response.
   *
   * See `DISCARDED_WHILE_SAVING`'s doc for the honest limitation: this
   * cannot retract a `flow.recorded` request the server already received
   * and persisted before this ran. */
  function clear(tabId: number): void {
    removeNavListener(tabId);
    const state = tabs.get(tabId);
    if (!state) return;
    state.recording = undefined;
    const pending = state.pendingFlowSave;
    if (pending) {
      state.pendingFlowSave = undefined;
      pending(workerFailure(DISCARDED_WHILE_SAVING));
    }
  }

  async function forceStopAndDiscard(tabId: number): Promise<void> {
    const state = tabs.get(tabId);
    if (!state?.recording) return;
    if (state.recording.status === 'recording') {
      await finish(tabId);
    }
    clear(tabId);
  }

  /** The popup only exposes Discard from the review panel (recorder already
   * torn down by `finish`), but routing through `forceStopAndDiscard` makes
   * it correct even if called while a recording is still ACTIVE — it tears
   * the recorder down in-page first rather than orphaning its page
   * listeners. */
  async function discard(tabId: number): Promise<{ ok: boolean }> {
    await forceStopAndDiscard(tabId);
    return { ok: true };
  }

  function status(tabId: number): RecordingStatus {
    const recording = tabs.get(tabId)?.recording;
    if (!recording) return { active: false, reviewing: false, stepCount: 0, capped: false };
    return {
      active: recording.status === 'recording',
      reviewing: recording.status === 'reviewing',
      stepCount: recording.steps.length,
      capped: recording.capped,
      steps: recording.status === 'reviewing' ? recording.steps : undefined,
      ambiguousStepIndices:
        recording.status === 'reviewing' ? recording.ambiguousStepIndices : undefined,
    };
  }

  /** Send the reviewed recording to the server for validation + persistence
   * (`flow.recorded` -> `flow.recorded.result`, see messages.ts). Clears the
   * recording state on success only — a validation failure (e.g. an
   * over-budget wait_for) leaves the steps in place so the user can edit the
   * name/description and retry rather than losing the capture. */
  async function save(
    tabId: number,
    name: string,
    description: string | undefined,
  ): Promise<RecordingResult> {
    const state = tabs.get(tabId);
    const recording = state?.recording;
    if (!state || !recording || recording.status !== 'reviewing') {
      return workerFailure({ code: 'no-reviewed-recording' });
    }
    if (!state.ws || state.ws.readyState !== SOCKET_OPEN || !state.serverTabId) {
      return workerFailure({ code: 'server-not-connected' });
    }
    const trimmedName = name.trim();
    if (trimmedName.length === 0) return workerFailure({ code: 'name-required' });
    if (recording.steps.length === 0) return workerFailure({ code: 'no-steps' });

    // Fold the ambiguous-selector warning into the saved recipe's
    // description so the computed safety signal travels WITH the recipe, not
    // just in the transient popup review — an agent (or a human) that later
    // recalls this flow sees the caution too.
    const ambiguousNote = buildAmbiguousNote(recording.ambiguousStepIndices);
    const userDescription = description?.trim() ? description.trim() : undefined;
    const finalDescription =
      ambiguousNote && userDescription
        ? `${userDescription}\n\n${ambiguousNote}`
        : (ambiguousNote ?? userDescription);

    const ws = state.ws;
    const serverTabId = state.serverTabId;
    // Captured before the await below so the continuation can tell THIS
    // session apart from whatever `state.recording` holds once the server
    // round trip resolves — see `isSameRecordingSession`'s doc in
    // recording.ts.
    const sessionNonce = recording.nonce;
    const result = await new Promise<RecordingResult>((resolve) => {
      let settled = false;
      const settle = (r: RecordingResult): void => {
        if (settled) return;
        settled = true;
        state.pendingFlowSave = undefined;
        resolve(r);
      };
      state.pendingFlowSave = settle;
      send(ws, {
        kind: 'flow.recorded',
        payload: {
          tab_id: serverTabId,
          origin: originOfUrl(recording.lastUrl),
          name: trimmedName,
          description: finalDescription,
          steps: recording.steps,
        },
      });
      // Best-effort timeout so the popup never hangs forever if the WS drops
      // mid-request without a clean close event.
      clock.after(SAVE_TIMEOUT_MS, () => {
        settle(workerFailure({ code: 'server-timeout' }));
      });
    });

    // The identity check guards against a Discard-then-Record race: Discard
    // already settles `pendingFlowSave` synchronously (see `clear`), so
    // `result.ok` alone would normally be enough — this check is
    // belt-and-braces for the same class of bug in case a NEW recording
    // session is now live on this tab by the time the real response lands.
    if (result.ok && isSameRecordingSession(state.recording?.nonce, sessionNonce)) {
      clear(tabId);
    }
    return result;
  }

  return {
    start,
    stop,
    finish,
    discard,
    forceStopAndDiscard,
    save,
    status,
    removeNavListener,
    teardownRecorder,
  };
}
