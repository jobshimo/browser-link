/**
 * The CDP implementation of the `PageDriver` port (design 3.2), built once
 * per `CdpSession` and shared by both transports: the extension builds one
 * per connected tab, cdp-direct one per connection. It owns the page
 * observer's host state (`ObserverMirror`) for that session: install,
 * binding messages, action mark, changes read, teardown.
 *
 * Every CDP command, its params and its order are the ones the two
 * transports sent before slice 9 (`background.ts` and `cdp/transport.ts`
 * `evaluateInTab`, `evaluateObserverJs`, `takeObserverMark`,
 * `settleWithChanges`, `installObserver`, `handleObserverMessage`,
 * `dispatchKeyEvent`). What differs per transport stays outside: the
 * install warning text, the bridge events the extension reports for a
 * top-document message, and whether `Runtime.enable` is sent here.
 */
import { buildFrameWatchReadJs, buildFrameWatchStartJs } from '../inpage/builders.js';
import {
  OBSERVER_BINDING,
  buildObserverChangesJs,
  buildObserverInstallJs,
  buildObserverMarkJs,
  buildObserverTeardownJs,
} from '../inpage/observer.js';
import type { CdpSession } from '../ports/cdp-session.js';
import type { Clock } from '../ports/clock.js';
import type { Keyboard, PageDriver } from '../ports/page-driver.js';
import type { PageInfo } from '../ports/page-info.js';
import type {
  ObserverFailure,
  ObserverMarkResult,
  SettleParams,
  SettleReport,
} from '../ports/values.js';
import { buildKeyEventSequence, type KeyDefinition } from '../support/keymap.js';
import {
  TOP_DOCUMENT_PROBE_JS,
  applyObserverMessage,
  createObserverMirror,
  isTopDocumentMessage,
  mergeSettleChanges,
  parseObserverMessage,
  readObserverMark,
  type ObserverMessageOutcome,
  type ObserverMirror,
} from '../support/observer-host.js';
import { settleSafely } from '../support/settle.js';

/** Ceiling for one observer plumbing evaluation: a page frozen by a native
 * dialog never answers `Runtime.evaluate`, and teardown must still be able
 * to finish. */
export const OBSERVER_EVAL_TIMEOUT_MS = 2_000;

interface EvaluateResponse<T> {
  result: { value: T };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}

export interface InstallOptions {
  /** cdp-direct enables `Runtime` here (for `Runtime.bindingCalled`); the
   * extension enabled it with the other domains on connect. */
  enableRuntime: boolean;
  /** A `doc_start`, `nav` or `doc_info` message the top document sent,
   * after the mirror applied it. */
  onTopDocument?: (outcome: ObserverMessageOutcome) => void | Promise<void>;
}

export type InstallResult = { ok: true } | { ok: false; error: string };

/** A `PageDriver` plus the observer lifecycle its transport drives. */
export interface PageDriverHandle extends PageDriver {
  /** The host mirror of the page observer (`installed` false until install succeeds). */
  readonly observer: ObserverMirror;
  /** Install the page observer: the binding, then the observer as a
   * new-document script that also runs now. Never throws; on failure the
   * observer stays uninstalled and actions report `observer-unavailable`. */
  install(options: InstallOptions): Promise<InstallResult>;
  /** Best-effort removal before the session closes. The in-page teardown
   * runs only when `tearDownPage()` says so at that point. Never throws. */
  uninstall(tearDownPage: () => boolean): Promise<void>;
}

export interface PageDriverDeps {
  session: CdpSession;
  page: PageInfo;
  clock: Clock;
}

/** The changes-read failure `mergeSettleChanges` turns into `observer: reason`. */
function failure(reason: ObserverFailure): { ok: false; reason: ObserverFailure } {
  return { ok: false, reason };
}

/** Why a mark answer that is not a usable mark gives no changes: what
 * `mergeSettleChanges` reported for that answer before slice 9. */
function markFailure(answer: unknown): ObserverFailure {
  if (answer === null || answer === undefined) return 'observer-unavailable';
  const { ok, reason } = answer as { ok?: unknown; reason?: unknown };
  if (ok === false && (reason === 'observer-unavailable' || reason === 'doc-changed')) {
    return reason;
  }
  return 'changes-error';
}

export function createPageDriver({ session, page, clock }: PageDriverDeps): PageDriverHandle {
  const observer = createObserverMirror();
  let scriptId: string | undefined;

  /** Race a CDP call against `OBSERVER_EVAL_TIMEOUT_MS`; rejects on timeout. */
  const withObserverTimeout = <T>(work: Promise<T>): Promise<T> => {
    let cancel: () => void = () => {};
    const timeout = new Promise<never>((_resolve, reject) => {
      cancel = clock.after(OBSERVER_EVAL_TIMEOUT_MS, () => {
        reject(new Error(`observer evaluation timed out after ${OBSERVER_EVAL_TIMEOUT_MS}ms`));
      });
    });
    return Promise.race([work, timeout]).finally(() => {
      cancel();
    });
  };

  const unwrap = <T>(response: EvaluateResponse<T>): T => {
    if (response.exceptionDetails) {
      const ex = response.exceptionDetails;
      throw new Error(ex.exception?.description ?? ex.text ?? 'Evaluation failed');
    }
    return response.result.value;
  };

  const evaluate = async <T = unknown>(expression: string): Promise<T> =>
    unwrap(
      await session.send<EvaluateResponse<T>>('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      }),
    );

  /** `Runtime.evaluate` for observer plumbing (mark, changes, probes,
   * teardown): no `userGesture` (these reads must never hand the page
   * transient user activation it did not earn), bounded by the timeout. */
  const evaluateObserverJs = async (expression: string): Promise<unknown> =>
    unwrap(
      await withObserverTimeout(
        session.send<EvaluateResponse<unknown>>('Runtime.evaluate', {
          expression,
          returnByValue: true,
        }),
      ),
    );

  /** Arm the frame watch with the action mark (`buildFrameWatchStartJs`):
   * changes an action makes inside same-origin frames before the settle
   * wait starts (owner decision D5). Never throws. */
  const startFrameWatch = async (): Promise<void> => {
    try {
      await evaluate(buildFrameWatchStartJs());
    } catch {
      // nothing armed, nothing counted
    }
  };

  /** Read and stop the frame watch right before the settle wait starts: the
   * records it saw, 0 when there is none. Never throws. */
  const readFrameWatch = async (): Promise<number> => {
    try {
      const read = await evaluate<{ ok: boolean; records?: unknown }>(buildFrameWatchReadJs());
      return read.ok && typeof read.records === 'number' && read.records > 0 ? read.records : 0;
    } catch {
      return 0;
    }
  };

  /** One binding message: summaries only update the mirror; `doc_start`,
   * `nav` and `doc_info` are first checked against the top document (the
   * install script also runs in same-process child frames, and the binding
   * is page-visible), then applied and handed to `onTopDocument`. */
  const handleObserverMessage = async (
    payload: string,
    onTopDocument: InstallOptions['onTopDocument'],
  ): Promise<void> => {
    const message = parseObserverMessage(payload);
    if (!message) return;
    if (message.type === 'summary') {
      applyObserverMessage(observer, message);
      return;
    }
    let probe: unknown;
    try {
      probe = await evaluateObserverJs(TOP_DOCUMENT_PROBE_JS);
    } catch {
      return;
    }
    if (!isTopDocumentMessage(probe, message.doc_id)) return;
    const outcome = applyObserverMessage(observer, message);
    await onTopDocument?.(outcome);
  };

  const keyboard: Keyboard = {
    key: async (event) => {
      await session.send('Input.dispatchKeyEvent', event);
    },
  };

  return {
    observer,
    page,
    keyboard,
    evaluator: { evaluate },
    settler: {
      async mark(settle: SettleParams | null): Promise<ObserverMarkResult> {
        if (!settle) return { kind: 'none' };
        await startFrameWatch();
        if (!observer.installed) return { kind: 'unavailable', reason: 'observer-unavailable' };
        let answer: unknown;
        try {
          answer = await evaluateObserverJs(buildObserverMarkJs());
        } catch {
          return { kind: 'unavailable', reason: 'observer-unavailable' };
        }
        const mark = readObserverMark(answer);
        return mark
          ? { kind: 'marked', mark }
          : { kind: 'unavailable', reason: markFailure(answer) };
      },

      async settle(
        settle: SettleParams | null,
        mark: ObserverMarkResult,
      ): Promise<SettleReport | undefined> {
        const early = settle ? await readFrameWatch() : 0;
        const settleResult = await settleSafely((expression) => evaluate(expression), settle);
        if (!settleResult) return undefined;
        if (early > 0) {
          // Frame records seen before the wait, added the way the wait
          // reports its own (`frame_mutation_count`, already in `mutation_count`).
          const before =
            typeof settleResult.frame_mutation_count === 'number'
              ? settleResult.frame_mutation_count
              : 0;
          settleResult.frame_mutation_count = before + early;
          if (typeof settleResult.mutation_count === 'number') settleResult.mutation_count += early;
        }
        let changes: unknown;
        if (mark.kind === 'marked') {
          try {
            changes = await evaluateObserverJs(
              buildObserverChangesJs(mark.mark.mark, mark.mark.doc_id),
            );
          } catch {
            // Typically the action navigated and destroyed the context.
            changes = failure('doc-changed');
          }
        } else {
          changes = failure(mark.kind === 'none' ? 'observer-unavailable' : mark.reason);
        }
        return mergeSettleChanges(settleResult, changes) ?? undefined;
      },
    },

    async install({ enableRuntime, onTopDocument }: InstallOptions): Promise<InstallResult> {
      session.onEvent((method, params) => {
        if (method !== 'Runtime.bindingCalled') return;
        const p = (params ?? {}) as { name?: unknown; payload?: unknown };
        if (p.name !== OBSERVER_BINDING) return;
        void handleObserverMessage(typeof p.payload === 'string' ? p.payload : '', onTopDocument);
      });
      try {
        if (enableRuntime) await session.send('Runtime.enable');
        await session.send('Runtime.addBinding', { name: OBSERVER_BINDING });
        const added = await session.send<{ identifier?: unknown } | undefined>(
          'Page.addScriptToEvaluateOnNewDocument',
          { source: buildObserverInstallJs(), runImmediately: true },
        );
        if (typeof added?.identifier === 'string') scriptId = added.identifier;
        observer.installed = true;
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    async uninstall(tearDownPage: () => boolean): Promise<void> {
      if (!observer.installed) return;
      observer.installed = false;
      if (scriptId !== undefined) {
        try {
          await withObserverTimeout(
            session.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: scriptId }),
          );
        } catch {
          // Best effort: the page may already be gone.
        }
        scriptId = undefined;
      }
      if (!tearDownPage()) return;
      try {
        await evaluateObserverJs(buildObserverTeardownJs());
      } catch {
        // Best effort: the page may already be gone.
      }
    },
  };
}

/** Dispatch the `Input.dispatchKeyEvent` sequence of one resolved key
 * (`buildKeyEventSequence`), in order. The only path that produces
 * `isTrusted: true` keyboard events: runtimes such as Qt-WASM discard
 * synthetic KeyboardEvents dispatched by `browser.evaluate`. */
export async function pressKey(
  keyboard: Keyboard,
  def: KeyDefinition,
  modifiers: number,
): Promise<void> {
  for (const event of buildKeyEventSequence(def, modifiers)) {
    await keyboard.key(event);
  }
}
