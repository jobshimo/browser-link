import { request } from 'node:http';
import { platform } from 'node:os';
import { BRIDGE_PORT } from '../bridge/protocol.js';
import { compareSemver } from '../utils/semver.js';
import { LOOKUP_FAILURE_TEXT, type PortHolder } from './port-holder.js';
import {
  defaultExecFile,
  listProcesses as listProcessesReal,
  selfAndAncestors,
  type ExecFileLike,
  type ProcessEntry,
} from './processes.js';

/**
 * Version-aware primary election.
 *
 * Without this, the primary is simply whoever bound 127.0.0.1:BRIDGE_PORT first,
 * so an old server kept serving after an update until somebody killed it.
 * When a starting process finds the port taken it probes the running
 * primary's `GET /version` (see `version-endpoint.ts`) and decides:
 *
 *   (a) remote version known and older than ours           → take over;
 *   (b) remote answers HTTP but has no `/version` (a primary older than
 *       0.41.0) and its process started before the installed code was last
 *       written: it is necessarily running stale code       → take over;
 *   (c) same version and `repairing: true` (the primary is handing
 *       the port over to a successor it spawned, i.e. this process)
 *                                                           → await the
 *       hand-off: keep retrying the bind, never step it down;
 *   (d) anything else (same or newer version, unknown start
 *       time, nothing answering HTTP)                       → defer.
 *
 * Deferring is the existing behaviour: proxy mode with multi-agent on, the
 * existing error otherwise. Taking over = step the owner down (a kill: old
 * primaries understand no step-down frame), then bind with retries. The kill
 * happens only when the operating system confirms that the process really
 * holds the port and is a browser-link server (`port-holder.ts`, owner
 * decision D14); otherwise nothing is killed and the reason names the holder
 * and the command that stops it. The hard
 * kill closes the extension sockets uncleanly, which is exactly what the
 * extension's auto-reconnect waits for.
 *
 * Every effect is injected so the decision is testable without killing or
 * binding anything real; `server.ts` only wires the real implementations.
 */

export interface VersionInfo {
  name: string;
  version: string;
  pid: number;
  startedAt: string;
  installedVersion: string | null;
  /** Since 0.44.0: a popup repair is handing the port over. Absent on older
   * primaries. */
  repairing?: boolean;
  /** Agent sessions using this primary: its own MCP client plus the
   * authenticated proxies. Absent on older primaries, and when the primary
   * could not tell. Display only: the election never reads it. */
  sessions?: number;
}

export type VersionProbe =
  /** The primary answered `/version`. */
  | { kind: 'version'; info: VersionInfo }
  /** Something answered HTTP on the port, but not a valid `/version`. */
  | { kind: 'no-endpoint' }
  /** Nothing answered HTTP (refused, timeout, not an HTTP server). */
  | { kind: 'unreachable' };

export type ElectionDecision = 'take-over' | 'await-handoff' | 'defer';

export interface ElectionOutcome {
  decision: ElectionDecision;
  /** The process stepped down (take-over) or that would have been. */
  pid: number | null;
  reason: string;
}

export interface DecideInput {
  local: string;
  probe: VersionProbe;
  ownerPid: number | null;
  ownerStartedAt: number | null;
  installedCodeMtime: number | null;
}

/** The pure decision table (a)–(d) above. */
export function decideElection(input: DecideInput): ElectionOutcome {
  const { probe } = input;
  if (probe.kind === 'version') {
    const remote = probe.info.version;
    if (compareSemver(remote, input.local) < 0) {
      return {
        decision: 'take-over',
        pid: probe.info.pid,
        reason: `running primary ${remote} is older than ${input.local}`,
      };
    }
    if (probe.info.repairing === true && compareSemver(remote, input.local) === 0) {
      return {
        decision: 'await-handoff',
        pid: probe.info.pid,
        reason: `running primary ${remote} is handing the port over (repair)`,
      };
    }
    return {
      decision: 'defer',
      pid: probe.info.pid,
      reason: `running primary ${remote} is not older than ${input.local}`,
    };
  }
  if (probe.kind === 'unreachable') {
    return { decision: 'defer', pid: input.ownerPid, reason: 'port holder does not answer HTTP' };
  }
  const { ownerPid, ownerStartedAt, installedCodeMtime } = input;
  if (ownerPid === null || ownerStartedAt === null || installedCodeMtime === null) {
    return {
      decision: 'defer',
      pid: ownerPid,
      reason: 'primary has no /version and its start time cannot be compared',
    };
  }
  if (ownerStartedAt < installedCodeMtime) {
    return {
      decision: 'take-over',
      pid: ownerPid,
      reason: 'primary has no /version and started before the installed code was written',
    };
  }
  return {
    decision: 'defer',
    pid: ownerPid,
    reason: 'primary has no /version but started after the installed code was written',
  };
}

export interface ElectionDeps {
  localVersion: string;
  probe: () => Promise<VersionProbe>;
  /** The holder of the bridge port as the operating system reports it
   * (`port-holder.ts`). A take-over steps down only this process, and only
   * when it is a browser-link server (owner decision D14). */
  inspectHolder: () => Promise<PortHolder>;
  processStartTime: (pid: number) => number | null;
  installedCodeMtime: () => number | null;
  stepDown: (pid: number) => Promise<void>;
}

const BRIDGE_ADDRESS = `127.0.0.1:${BRIDGE_PORT}`;

/**
 * Why a take-over of `target` must not kill anything, or null when the OS
 * confirms `target` holds the bridge port and is a browser-link server.
 * `claimed` is the pid the holder reported in its `/version` body (null
 * when it has none): it is only compared, never trusted.
 */
export function takeOverRefusal(
  target: number,
  claimed: number | null,
  holder: PortHolder,
): string | null {
  const nothing = 'Nothing was stopped.';
  const claim =
    claimed === null ? '' : ` The server answering there says it is PID ${claimed}, unverified.`;
  if (holder.kind === 'free') {
    return `take-over refused: the operating system lists no process listening on ${BRIDGE_ADDRESS}. ${nothing}`;
  }
  if (holder.kind === 'unknown') {
    return (
      `take-over refused: could not verify through the operating system which process holds ` +
      `${BRIDGE_ADDRESS} (${LOOKUP_FAILURE_TEXT[holder.reason]}).${claim} ${nothing} ` +
      `Run \`browser-link stop\` to look again.`
    );
  }
  const { pid, imageName } = holder.process;
  const who = `PID ${pid} (${imageName ?? 'name unknown'})`;
  const command = `To stop it: browser-link stop --pid ${pid}`;
  if (pid !== target) {
    return (
      `take-over refused: the server answering on ${BRIDGE_ADDRESS} says it is PID ${target}, ` +
      `but the operating system says ${who} holds the port. ${nothing} ${command}`
    );
  }
  if (!holder.isBrowserLink) {
    return (
      `take-over refused: ${who} holds ${BRIDGE_ADDRESS}, but the operating system does not ` +
      `show it as a browser-link server. ${nothing} ${command}`
    );
  }
  return null;
}

/** Probe, decide and, on take-over, step the owner down once the OS
 * verified it. The caller binds afterwards (see `retryBind`). A refused or
 * failed step-down turns into `defer`. */
export async function runElection(deps: ElectionDeps): Promise<ElectionOutcome> {
  const probe = await deps.probe();
  let holder: PortHolder | null = null;
  let ownerPid: number | null = null;
  let ownerStartedAt: number | null = null;
  let installedCodeMtime: number | null = null;
  if (probe.kind === 'no-endpoint') {
    holder = await deps.inspectHolder();
    ownerPid = holder.kind === 'process' ? holder.process.pid : null;
    ownerStartedAt = ownerPid === null ? null : deps.processStartTime(ownerPid);
    installedCodeMtime = deps.installedCodeMtime();
  }
  const outcome = decideElection({
    local: deps.localVersion,
    probe,
    ownerPid,
    ownerStartedAt,
    installedCodeMtime,
  });
  if (outcome.decision !== 'take-over' || outcome.pid === null) return outcome;
  holder ??= await deps.inspectHolder();
  const claimed = probe.kind === 'version' ? probe.info.pid : null;
  const refusal = takeOverRefusal(outcome.pid, claimed, holder);
  if (refusal !== null) return { decision: 'defer', pid: outcome.pid, reason: refusal };
  try {
    await deps.stepDown(outcome.pid);
    return outcome;
  } catch (err) {
    return {
      decision: 'defer',
      pid: outcome.pid,
      reason: `step-down of PID ${outcome.pid} failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function isVersionInfo(v: unknown): v is VersionInfo {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.name === 'string' &&
    typeof o.version === 'string' &&
    typeof o.pid === 'number' &&
    Number.isInteger(o.pid) &&
    o.pid > 0 &&
    typeof o.startedAt === 'string' &&
    (o.installedVersion === null || typeof o.installedVersion === 'string') &&
    (o.repairing === undefined || typeof o.repairing === 'boolean')
  );
}

/** The body as `VersionInfo`: `sessions` is kept only when it is a
 * non-negative integer, otherwise the field is absent (never an invalid body). */
function readVersionInfo(body: VersionInfo): VersionInfo {
  const { sessions, ...rest } = body as VersionInfo & { sessions?: unknown };
  return typeof sessions === 'number' && Number.isInteger(sessions) && sessions >= 0
    ? { ...rest, sessions }
    : rest;
}

/** `GET http://<host>:<port>/version`. Never rejects. */
export function probeVersion(
  port: number,
  timeoutMs = 1000,
  host = '127.0.0.1',
): Promise<VersionProbe> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (probe: VersionProbe): void => {
      if (settled) return;
      settled = true;
      resolve(probe);
    };
    const req = request(
      { host, port, path: '/version', method: 'GET', timeout: timeoutMs },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            done({ kind: 'no-endpoint' });
            return;
          }
          try {
            const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            done(
              isVersionInfo(body)
                ? { kind: 'version', info: readVersionInfo(body) }
                : { kind: 'no-endpoint' },
            );
          } catch {
            done({ kind: 'no-endpoint' });
          }
        });
        res.on('error', () => {
          done({ kind: 'no-endpoint' });
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      done({ kind: 'unreachable' });
    });
    req.on('error', () => {
      done({ kind: 'unreachable' });
    });
    req.end();
  });
}

const sleepReal = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Run `bind` until it succeeds, retrying only errors `isRetryable` accepts
 * (a busy port), at most `attempts` times with `delayMs` between tries. */
export async function retryBind<T>(
  bind: () => Promise<T>,
  opts: {
    attempts: number;
    delayMs: number;
    isRetryable: (err: unknown) => boolean;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<T> {
  const sleep = opts.sleep ?? sleepReal;
  for (let attempt = 1; ; attempt++) {
    try {
      return await bind();
    } catch (err) {
      if (!opts.isRetryable(err) || attempt >= opts.attempts) throw err;
      await sleep(opts.delayMs);
    }
  }
}

/** Unix grace period between SIGTERM and SIGKILL. */
export const STEP_DOWN_GRACE_MS = 3000;
const STEP_DOWN_POLL_MS = 100;

/** How long a SIGTERM/SIGINT'd primary waits for its IPC server to close.
 * Kept below STEP_DOWN_GRACE_MS so a stepped-down primary finishes on its
 * own before the SIGKILL that follows the grace period. */
export const SHUTDOWN_IPC_DEADLINE_MS = 2000;

/**
 * The primary's SIGTERM/SIGINT path: let the IPC server tell its proxies
 * `primary-closing` and close (bounded by SHUTDOWN_IPC_DEADLINE_MS), then
 * close the DB and exit 0. A failed or slow close never blocks the exit.
 * Windows step-down is a `taskkill /F`, which no handler sees; nothing here
 * changes that path.
 */
export async function shutdownOnSignal(deps: {
  stopIpc: (() => Promise<void>) | null;
  closeDb: () => void;
  exit: (code: number) => void;
}): Promise<void> {
  if (deps.stopIpc) {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, SHUTDOWN_IPC_DEADLINE_MS);
    });
    const closed = deps.stopIpc().catch(() => {
      /* shutting down; a failed close must not block the exit */
    });
    await Promise.race([closed, deadline]);
    clearTimeout(timer);
  }
  deps.closeDb();
  deps.exit(0);
}

function isAliveReal(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Stop a process: Windows `taskkill /PID n /F`; Unix `SIGTERM`, wait up to
 * 3 s for it to exit, then `SIGKILL`. Throws when the kill itself fails, and
 * before killing anything when `pid` is this process or one of its
 * ancestors (the shell or MCP client that launched it).
 */
export async function stepDownProcess(
  pid: number,
  deps: {
    os?: NodeJS.Platform;
    execFile?: ExecFileLike;
    kill?: (pid: number, signal: NodeJS.Signals) => void;
    isAlive?: (pid: number) => boolean;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    selfPid?: number;
    listProcesses?: () => ProcessEntry[];
  } = {},
): Promise<void> {
  const os = deps.os ?? platform();
  const selfPid = deps.selfPid ?? process.pid;
  // The direct checks need no process scan; the ancestor chain does.
  if (
    pid === selfPid ||
    (deps.selfPid === undefined && pid === process.ppid) ||
    selfAndAncestors(
      (deps.listProcesses ?? (() => listProcessesReal(os, deps.execFile ?? defaultExecFile)))(),
      selfPid,
    ).has(pid)
  ) {
    throw new Error(`refusing to step down PID ${pid}: it is this process or one of its ancestors`);
  }
  if (os === 'win32') {
    (deps.execFile ?? defaultExecFile)('taskkill', ['/PID', String(pid), '/F'], {
      timeout: 5000,
    });
    return;
  }
  const kill = deps.kill ?? ((p: number, s: NodeJS.Signals) => void process.kill(p, s));
  const isAlive = deps.isAlive ?? isAliveReal;
  const sleep = deps.sleep ?? sleepReal;
  const now = deps.now ?? Date.now;
  kill(pid, 'SIGTERM');
  const deadline = now() + STEP_DOWN_GRACE_MS;
  while (isAlive(pid)) {
    if (now() >= deadline) {
      kill(pid, 'SIGKILL');
      return;
    }
    await sleep(STEP_DOWN_POLL_MS);
  }
}
