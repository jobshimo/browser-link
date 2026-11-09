/**
 * Per-agent session state for the knowledge loop (knowledge-loop S9, S13).
 *
 * An "agent session" is one MCP client connection, identified by
 * `AgentCaller.agent_id` (the IPC session uuid, or `'primary'`). This module
 * remembers, in memory only, what the wrap-up step needs to know about it:
 *
 *   - `firstCallDone`: whether the rules block has been delivered (S13);
 *   - `pendingWrapUp`: successful `evaluate`/`flow` runs since the last
 *     `browser.wrap_up` commit (the `pending_wrap_up` reminder, S9);
 *   - `origins`: the origins of the tabs this session used;
 *   - `typedValues`: what the agent typed, for curation rule 7 (never
 *     written anywhere);
 *   - `flows`: the flows it ran, with their template steps, so `wrap_up`
 *     can offer them for saving.
 *
 * Bounded: at most `MAX_SESSIONS` sessions (least recently used evicted
 * first), each with capped lists. Nothing here touches a database, so a
 * restart simply starts every session fresh.
 */

export const MAX_SESSIONS = 200;
export const MAX_SESSION_FLOWS = 50;
export const MAX_SESSION_TYPED = 50;

export interface SessionFlowInput {
  /** Origin of the tab the flow ran on, when known. */
  origin: string | null;
  /** `name` the agent gave an inline-steps run (a pending candidate). */
  name: string | null;
  /** Name of the saved flow this run replayed, when it was run by name. */
  saved_name: string | null;
  /** The steps as the agent sent them (placeholders not filled). */
  steps: unknown[];
  /** `stopped_by` of the result, when present. */
  stopped_by: string | null;
  /** Whether the run succeeded (`ok: true` and not stopped by a failure). */
  ok: boolean;
}

export interface SessionFlowRecord extends SessionFlowInput {
  /** Stable index within the session, never reused. */
  session_index: number;
  /** Set once `wrap_up` saved it, to the name it was saved under. */
  kept: string | null;
}

export interface AgentSession {
  startedAt: string;
  firstCallDone: boolean;
  pendingWrapUp: number;
  origins: Set<string>;
  typedValues: string[];
  flows: SessionFlowRecord[];
  /** Next `session_index` to hand out. */
  nextFlowIndex: number;
}

const sessions = new Map<string, AgentSession>();

function fresh(): AgentSession {
  return {
    startedAt: new Date().toISOString(),
    firstCallDone: false,
    pendingWrapUp: 0,
    origins: new Set(),
    typedValues: [],
    flows: [],
    nextFlowIndex: 0,
  };
}

/** The session of `agentId`, created on first use and marked most recently
 * used. Creating one past the cap evicts the least recently used. */
export function sessionFor(agentId: string): AgentSession {
  const existing = sessions.get(agentId);
  if (existing) {
    sessions.delete(agentId);
    sessions.set(agentId, existing);
    return existing;
  }
  const created = fresh();
  sessions.set(agentId, created);
  while (sessions.size > MAX_SESSIONS) {
    const oldest = sessions.keys().next().value;
    if (oldest === undefined) break;
    sessions.delete(oldest);
  }
  return created;
}

/** The session of `agentId` if it exists. Never creates or reorders. */
export function peekSession(agentId: string): AgentSession | undefined {
  return sessions.get(agentId);
}

/** Mark a browser tool call. True only for the first call of the session,
 * which is the one that carries the rules block. */
export function beginToolCall(agentId: string): boolean {
  const s = sessionFor(agentId);
  if (s.firstCallDone) return false;
  s.firstCallDone = true;
  return true;
}

/** Treat the rules as already delivered to this session. */
export function markRulesDelivered(agentId: string): void {
  sessionFor(agentId).firstCallDone = true;
}

/** One more successful `evaluate`/`flow` waiting for `wrap_up`. */
export function notePendingWork(agentId: string): void {
  sessionFor(agentId).pendingWrapUp += 1;
}

/** `wrap_up` committed: nothing is pending any more. */
export function resetPendingWork(agentId: string): void {
  sessionFor(agentId).pendingWrapUp = 0;
}

export function noteOrigin(agentId: string, origin: string | null | undefined): void {
  if (typeof origin !== 'string' || origin.length === 0 || origin === 'null') return;
  sessionFor(agentId).origins.add(origin);
}

/** Remember a value the agent typed (or passed as a placeholder value). */
export function noteTypedValue(agentId: string, value: unknown): void {
  if (typeof value !== 'string' || value.length === 0) return;
  const list = sessionFor(agentId).typedValues;
  list.push(value);
  if (list.length > MAX_SESSION_TYPED) list.splice(0, list.length - MAX_SESSION_TYPED);
}

/** Record one flow run and return its record. */
export function recordSessionFlow(agentId: string, input: SessionFlowInput): SessionFlowRecord {
  const s = sessionFor(agentId);
  const record: SessionFlowRecord = { ...input, session_index: s.nextFlowIndex, kept: null };
  s.nextFlowIndex += 1;
  s.flows.push(record);
  if (s.flows.length > MAX_SESSION_FLOWS) s.flows.splice(0, s.flows.length - MAX_SESSION_FLOWS);
  return record;
}

/** Forget every session. Used by tests. */
export function resetSessions(): void {
  sessions.clear();
}
