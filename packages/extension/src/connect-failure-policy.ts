/**
 * How a bridge connect that fails before registration is settled. A
 * WebSocket `error` is always followed by a `close`, and the WebSocket API
 * hides why an upgrade was refused, so an `error` starts one diagnosis (the
 * bridge's `GET /handshake-check`, handshake-diagnosis.ts) and the attempt is
 * settled with its answer; the `close` that follows leaves the settling to it
 * while it is pending. A `close` with no `error` before it settles as before,
 * with `ws-closed-before-registration`.
 *
 * background.ts wires the socket's events to this tracker; its `settle` is
 * the connect attempt's own once-only settle, `isSettled` says whether that
 * already happened (a post-registration drop needs no diagnosis).
 */
import type { WorkerMessage } from './worker-messages.js';

export interface ConnectFailureDeps {
  isSettled: () => boolean;
  settle: (message: WorkerMessage) => void;
  /** Asks the bridge why; never meant to fail, but a rejection or a
   * synchronous throw reads as the generic connect failure. */
  diagnose: () => Promise<WorkerMessage>;
}

export interface ConnectFailureTracker {
  onError: () => void;
  onClose: () => void;
}

export function createConnectFailureTracker(deps: ConnectFailureDeps): ConnectFailureTracker {
  let diagnosis: 'none' | 'pending' | 'done' = 'none';
  return {
    onError: () => {
      if (deps.isSettled() || diagnosis !== 'none') return;
      diagnosis = 'pending';
      // A synchronous throw becomes a rejection, so the attempt still settles.
      void new Promise<WorkerMessage>((resolve) => {
        resolve(deps.diagnose());
      })
        .catch((): WorkerMessage => ({ code: 'ws-connect-failed' }))
        .then((message) => {
          diagnosis = 'done';
          deps.settle(message);
        });
    },
    onClose: () => {
      if (diagnosis === 'pending') return;
      deps.settle({ code: 'ws-closed-before-registration' });
    },
  };
}
