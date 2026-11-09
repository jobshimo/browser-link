import { request } from 'node:http';
import { platform } from 'node:os';
import { compareSemver } from '../utils/semver.js';
import { defaultExecFile, type ExecFileLike } from './processes.js';

/**
 * Version-aware primary election.
 *
 * Without this, the primary is simply whoever bound 127.0.0.1:17529 first,
 * so an old server kept serving after an update until somebody killed it.
 * When a starting process finds the port taken it probes the running
 * primary's `GET /version` (see `version-endpoint.ts`) and decides:
 *
 *   (a) remote version known and older than ours           → take over;
 *   (b) remote answers HTTP but has no `/version` (a primary older than
 *       0.41.0) and its process started before the installed code was last
 *       written: it is necessarily running stale code       → take over;
 *   (c) anything else (same or newer version, unknown start
 *       time, nothing answering HTTP)                       → defer.
 *
 * Deferring is the existing behaviour: proxy mode with multi-agent on, the
 * existing error otherwise. Taking over = step the owner down (a kill: old
 * primaries understand no step-down frame), then bind with retries. The hard
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
}

export type VersionProbe =
  /** The primary answered `/version`. */
  | { kind: 'version'; info: VersionInfo }
  /** Something answered HTTP on the port, but not a valid `/version`. */
  | { kind: 'no-endpoint' }
  /** Nothing answered HTTP (refused, timeout, not an HTTP server). */
  | { kind: 'unreachable' };

export type ElectionDecision = 'take-over' | 'defer';

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

/** The pure decision table (a)/(b)/(c) above. */
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
  /** Pid listening on the bridge port; used only when `/version` is absent. */
  findOwnerPid: () => number | null;
  processStartTime: (pid: number) => number | null;
  installedCodeMtime: () => number | null;
  stepDown: (pid: number) => Promise<void>;
}

/** Probe, decide and, on take-over, step the owner down. The caller binds
 * afterwards (see `retryBind`). A step-down that fails turns into `defer`. */
export async function runElection(deps: ElectionDeps): Promise<ElectionOutcome> {
  const probe = await deps.probe();
  let ownerPid: number | null = null;
  let ownerStartedAt: number | null = null;
  let installedCodeMtime: number | null = null;
  if (probe.kind === 'no-endpoint') {
    ownerPid = deps.findOwnerPid();
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
    (o.installedVersion === null || typeof o.installedVersion === 'string')
  );
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
            done(isVersionInfo(body) ? { kind: 'version', info: body } : { kind: 'no-endpoint' });
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
 * 3 s for it to exit, then `SIGKILL`. Throws when the kill itself fails.
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
  } = {},
): Promise<void> {
  const os = deps.os ?? platform();
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
