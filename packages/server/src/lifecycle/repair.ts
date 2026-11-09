import type { BridgeRepairMessage, ServerToExtension } from '../messages.js';

/**
 * Popup "Repair connection", server side (S4).
 *
 * On `bridge.repair` the bridge answers first, then this process restarts
 * itself on the installed code: spawn the installed CLI detached, terminate
 * every extension socket uncleanly (`ws.terminate()`, which the extension's
 * auto-reconnect treats as involuntary), stop IPC (proxies get
 * `primary-closing`) and exit 0. The child wins the port through the
 * election's bind retries, and the extension reconnects to it by itself.
 *
 * The policy is pure; `server.ts` injects the real spawn/terminate/exit.
 */

export interface RepairDeps {
  /** `process.execPath`. */
  execPath: string;
  /** The installed `dist/cli.js` (same file the process started from). */
  cliPath: string;
  spawn: (
    command: string,
    args: string[],
    options: { detached: true; stdio: 'ignore'; windowsHide: true },
  ) => { unref(): void };
  terminateSockets: () => void;
  stopIpc: () => Promise<void>;
  exit: (code: number) => void;
  /** Waits long enough for the ack frame to be flushed to the socket. */
  delay: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
}

/** Time given to the `bridge.repair.result` frame before sockets die. */
export const REPAIR_FLUSH_DELAY_MS = 150;

export interface RepairController {
  /** Start the restart (once). Returns whether it is (now) in progress. */
  start(): boolean;
  /** Settles when the current restart attempt finished (tests). */
  readonly done: Promise<void>;
}

export function createRepairController(deps: RepairDeps): RepairController {
  let inProgress = false;
  let done: Promise<void> = Promise.resolve();

  const run = async (): Promise<void> => {
    await deps.delay(REPAIR_FLUSH_DELAY_MS);
    try {
      deps
        .spawn(deps.execPath, [deps.cliPath], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        })
        .unref();
    } catch (err) {
      // Without a successor, exiting would leave no server at all: keep
      // serving and let the user fall back to `browser-link stop`.
      inProgress = false;
      deps.log?.(
        `Repair: could not start the installed server (${err instanceof Error ? err.message : String(err)}); still serving.`,
      );
      return;
    }
    deps.log?.('Repair: installed server started; handing over the port.');
    deps.terminateSockets();
    try {
      await deps.stopIpc();
    } catch {
      /* already closed; exiting anyway */
    }
    deps.exit(0);
  };

  return {
    start() {
      if (inProgress) return true;
      inProgress = true;
      done = run();
      return true;
    },
    get done() {
      return done;
    },
  };
}

/**
 * Answer one `bridge.repair` frame: the ack goes out BEFORE the repair
 * starts, so the popup learns the outcome even though its socket is about to
 * be terminated. `startRepair` is undefined in a process that cannot repair
 * itself (tests, a bridge started without the wiring).
 */
export function answerRepairRequest(
  msg: BridgeRepairMessage,
  send: (reply: ServerToExtension) => void,
  startRepair: (() => boolean) | undefined,
): void {
  const requestId = typeof msg.request_id === 'string' ? msg.request_id : '';
  if (!startRepair) {
    send({
      kind: 'bridge.repair.result',
      request_id: requestId,
      ok: false,
      error: 'repair is not available in this server process',
    });
    return;
  }
  send({ kind: 'bridge.repair.result', request_id: requestId, ok: true, action: 'restarting' });
  startRepair();
}
