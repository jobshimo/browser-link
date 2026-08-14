/**
 * Cooperative tab-ownership registry for multi-agent mode.
 *
 * Several MCP clients can share a single browser-link primary. Without
 * coordination they end up racing on the same Chrome tab — clicking,
 * navigating, evaluating in interleaved order. This module tracks who
 * "owns" each tab and lets the dispatcher refuse cross-agent action.
 *
 * Identity model:
 *   - `agent_id` is the IPC session id for proxies (UUID minted after the
 *     hello/token handshake) and the literal string `"primary"` for the
 *     primary's own MCP client.
 *   - The auth that the agent passed (peerLookup + Node binary allowlist +
 *     rotated token) is the trust anchor. This registry never re-validates
 *     identity — it consumes the `AgentCaller` the bridge layer supplies.
 *   - Self-declared `label` (eg `"claude-code"`) is display-only and is
 *     never used for ownership comparisons.
 *
 * TTL model:
 *   - Claims expire after `ttl_minutes` of inactivity. Every action on the
 *     tab refreshes `last_activity_at`. Stale claims are dropped by
 *     `pruneStale()` (called periodically by the primary).
 *   - Sessions ending (proxy disconnect) drop the agent's claims
 *     immediately via `onAgentDisconnect()`.
 */

export interface AgentCaller {
  agent_id: string;
  pid: number;
  binary: string;
  label?: string;
}

export interface TabClaim {
  tab_id: string;
  agent_id: string;
  pid: number;
  binary: string;
  label?: string;
  claimed_at: number;
  last_activity_at: number;
  ttl_ms: number;
}

export type ClaimEvent =
  | {
      kind: 'tab-claimed';
      tab_id: string;
      agent_id: string;
      pid: number;
      binary: string;
      label?: string;
      ttl_ms: number;
      auto: boolean;
    }
  | {
      kind: 'tab-released';
      tab_id: string;
      agent_id: string;
      reason: 'explicit' | 'agent-disconnect' | 'ttl' | 'reset';
    }
  | {
      kind: 'tab-claim-rejected';
      tab_id: string;
      requester_agent_id: string;
      existing_agent_id: string;
    };

export type ClaimOutcome =
  | { ok: true; claim: TabClaim; created: boolean }
  | { ok: false; reason: 'conflict'; existing: TabClaim };

export interface TabClaimRegistryOptions {
  /** Default TTL when a claim does not specify one. Defaults to 10 minutes. */
  defaultTtlMinutes?: number;
  /** Upper bound on TTL a caller may request. Defaults to 60 minutes. */
  maxTtlMinutes?: number;
  /** Time source. Tests inject a fake clock to make TTL assertions deterministic. */
  nowMs?: () => number;
  /** Event callback. The primary wires this to its `BridgeEventLog`. */
  onEvent?: (event: ClaimEvent) => void;
}

const MS_PER_MINUTE = 60_000;

export class TabClaimRegistry {
  private claims = new Map<string, TabClaim>();
  private readonly defaultTtlMs: number;
  private readonly maxTtlMs: number;
  private readonly now: () => number;
  private readonly onEvent: (event: ClaimEvent) => void;

  constructor(opts: TabClaimRegistryOptions = {}) {
    this.defaultTtlMs = (opts.defaultTtlMinutes ?? 10) * MS_PER_MINUTE;
    this.maxTtlMs = (opts.maxTtlMinutes ?? 60) * MS_PER_MINUTE;
    this.now = opts.nowMs ?? (() => Date.now());
    this.onEvent = opts.onEvent ?? (() => {});
  }

  /** Snapshot of the current claim for a tab, or null when free or expired. */
  getClaim(tab_id: string): TabClaim | null {
    const claim = this.claims.get(tab_id);
    if (!claim) return null;
    if (this.isExpired(claim)) {
      this.claims.delete(tab_id);
      this.onEvent({
        kind: 'tab-released',
        tab_id,
        agent_id: claim.agent_id,
        reason: 'ttl',
      });
      return null;
    }
    return claim;
  }

  /** Explicit claim. Returns conflict if another agent owns the tab. Same-agent re-claims refresh activity and update the label/TTL. */
  claim(
    tab_id: string,
    caller: AgentCaller,
    opts: { ttlMinutes?: number; label?: string } = {},
  ): ClaimOutcome {
    return this.claimInternal(tab_id, caller, opts, { auto: false });
  }

  /** For action tools. Auto-claims a free tab for the caller, refreshes when the caller already owns it, conflicts otherwise. */
  ensureActionAllowed(tab_id: string, caller: AgentCaller): ClaimOutcome {
    return this.claimInternal(tab_id, caller, {}, { auto: true });
  }

  /** Explicit release. Only the owner may release. */
  release(
    tab_id: string,
    caller: AgentCaller,
  ): { ok: true } | { ok: false; reason: 'not-claimed' | 'not-owner'; existing?: TabClaim } {
    const claim = this.getClaim(tab_id);
    if (!claim) return { ok: false, reason: 'not-claimed' };
    if (claim.agent_id !== caller.agent_id) {
      return { ok: false, reason: 'not-owner', existing: claim };
    }
    this.claims.delete(tab_id);
    this.onEvent({
      kind: 'tab-released',
      tab_id,
      agent_id: claim.agent_id,
      reason: 'explicit',
    });
    return { ok: true };
  }

  /** Claims owned by this caller, sorted by `claimed_at`. */
  myTabs(caller: AgentCaller): TabClaim[] {
    const owned: TabClaim[] = [];
    for (const tabId of this.claims.keys()) {
      const claim = this.getClaim(tabId);
      if (claim && claim.agent_id === caller.agent_id) owned.push(claim);
    }
    return owned.sort((a, b) => a.claimed_at - b.claimed_at);
  }

  /** Drop every claim held by `agent_id` (called when a proxy disconnects). */
  onAgentDisconnect(agent_id: string): TabClaim[] {
    const released: TabClaim[] = [];
    for (const [tabId, claim] of this.claims) {
      if (claim.agent_id === agent_id) {
        released.push(claim);
        this.claims.delete(tabId);
        this.onEvent({
          kind: 'tab-released',
          tab_id: tabId,
          agent_id,
          reason: 'agent-disconnect',
        });
      }
    }
    return released;
  }

  /** Sweep claims past their TTL. Returns the dropped claims. */
  pruneStale(): TabClaim[] {
    const expired: TabClaim[] = [];
    for (const [tabId, claim] of this.claims) {
      if (this.isExpired(claim)) {
        expired.push(claim);
        this.claims.delete(tabId);
        this.onEvent({
          kind: 'tab-released',
          tab_id: tabId,
          agent_id: claim.agent_id,
          reason: 'ttl',
        });
      }
    }
    return expired;
  }

  /** Test helper. Production callers should not need this. */
  size(): number {
    return this.claims.size;
  }

  /** Drop every claim, emitting one `tab-released` event per dropped claim
   * (reason: 'reset'). Used by `browser.reset` to wipe ownership in one
   * step without iterating from the caller side. */
  releaseAll(): TabClaim[] {
    const released: TabClaim[] = [];
    for (const [tabId, claim] of this.claims) {
      released.push(claim);
      this.onEvent({
        kind: 'tab-released',
        tab_id: tabId,
        agent_id: claim.agent_id,
        reason: 'reset',
      });
    }
    this.claims.clear();
    return released;
  }

  private isExpired(claim: TabClaim): boolean {
    return this.now() - claim.last_activity_at >= claim.ttl_ms;
  }

  private claimInternal(
    tab_id: string,
    caller: AgentCaller,
    opts: { ttlMinutes?: number; label?: string },
    flags: { auto: boolean },
  ): ClaimOutcome {
    const existing = this.getClaim(tab_id);
    if (existing && existing.agent_id !== caller.agent_id) {
      this.onEvent({
        kind: 'tab-claim-rejected',
        tab_id,
        requester_agent_id: caller.agent_id,
        existing_agent_id: existing.agent_id,
      });
      return { ok: false, reason: 'conflict', existing };
    }

    const now = this.now();
    const requestedTtlMs = opts.ttlMinutes != null ? opts.ttlMinutes * MS_PER_MINUTE : undefined;
    const ttlMs = clamp(requestedTtlMs ?? existing?.ttl_ms ?? this.defaultTtlMs, 1, this.maxTtlMs);

    const label = opts.label ?? existing?.label ?? caller.label;

    const claim: TabClaim = {
      tab_id,
      agent_id: caller.agent_id,
      pid: caller.pid,
      binary: caller.binary,
      label,
      claimed_at: existing?.claimed_at ?? now,
      last_activity_at: now,
      ttl_ms: ttlMs,
    };

    const created = !existing;
    this.claims.set(tab_id, claim);

    if (created) {
      this.onEvent({
        kind: 'tab-claimed',
        tab_id,
        agent_id: caller.agent_id,
        pid: caller.pid,
        binary: caller.binary,
        label,
        ttl_ms: ttlMs,
        auto: flags.auto,
      });
    }
    return { ok: true, claim, created };
  }
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), hi);
}

/** User-facing error string for action tools when another agent holds the tab. Kept here so the wording is consistent across handlers. */
export function formatClaimConflict(
  caller: AgentCaller,
  existing: TabClaim,
  nowMs: number = Date.now(),
): string {
  const labelOrPid = existing.label ?? `pid ${existing.pid}`;
  const ageMin = Math.max(1, Math.round((nowMs - existing.claimed_at) / MS_PER_MINUTE));
  return (
    `Tab ${existing.tab_id} is in use by another agent (${labelOrPid}, agent_id=${existing.agent_id}) ` +
    `for ${ageMin} min. Your agent_id is ${caller.agent_id}. ` +
    `Call browser.list_tabs to see what's free, browser.my_tabs to see what you already own, ` +
    `or ask the user whose tab this should be.`
  );
}
