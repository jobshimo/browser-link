/**
 * The activity trail: one row per browser tool an agent dispatched.
 *
 * WHY THIS LIVES ON THE SERVER, NOT IN THE EXTENSION
 * --------------------------------------------------
 * The extension's flow history (`flow-registry.ts`) is a "what just happened
 * on this tab" panel: `chrome.storage.session`, 20 entries per tab, gone when
 * the browser closes. That is the right shape for the 320px popup and the
 * wrong shape for an audit trail.
 *
 * The server already sees EVERY action — `handleBrowserTool` is the single
 * funnel both transports pass through, extension and cdp-direct alike — and
 * it has a real filesystem. Recording here means one hook instead of one per
 * transport, no `chrome.storage` quota, and a trail that outlives the
 * browser AND the server process.
 *
 * PRIVACY CONTRACT
 * ----------------
 * This is deliberately a DIFFERENT contract from the popup's.
 *
 * `flow-registry.ts` keeps counts and fixed enums only, because it renders
 * into a UI the user did not ask for and cannot clear. This trail is the
 * opposite: the user asked for it explicitly, it is theirs, it lives in
 * their own data dir, and it is worthless for auditing an agent if it omits
 * what the agent actually typed or evaluated.
 *
 * So `payload` DOES carry page-derived and agent-supplied text — the string
 * that was typed, the expression that was evaluated, the URL navigated to.
 * Three properties keep that honest:
 *
 *   1. It never leaves the machine on its own. Nothing uploads it.
 *   2. Recording it is a config switch (`activity.record-payloads`), so a
 *      user who wants the shape of the trail without its contents can have
 *      exactly that.
 *   3. Redaction happens on the way OUT (`activity export --redact`), not on
 *      the way in. The owner keeps the full trail; what they hand to someone
 *      else is a decision made at export time, once, deliberately — rather
 *      than a decision made silently at record time and impossible to undo.
 */

/** Outcome of a dispatched tool. `error` is the failure branch of the same
 * call, not a separate kind of event: an agent's failed click is exactly as
 * interesting as a successful one when you are reconstructing what happened. */
export type ActivityOutcome = 'ok' | 'error';

/** Which wire the call travelled over. `null` for tools that never touch a
 * tab (`browser.list_tabs`, `browser.my_tabs`), so the column can be read as
 * "how this reached the page" rather than being forced to lie. */
export type ActivityTransport = 'extension' | 'cdp';

/**
 * Why a call deserves a second look, beyond its bare `ok`/`error` outcome.
 *
 * Most of these are failures that RESOLVE: a `wait_for` with `matched: false`,
 * a flow that ran out of time, a click whose settle window never went quiet.
 * They come back `ok`, so without this column the trail would record them as
 * successes and the evidence of friction would vanish. The rest name the
 * well-known thrown failures, so a report can count them without regexing
 * error text.
 *
 * Closed on purpose, and enforced in code rather than with a CHECK: `record`
 * stores an unknown value as null so the report never grows a bucket per typo,
 * and growing the list later needs no table rebuild (SQLite cannot alter a
 * CHECK on an existing column).
 */
export const ACTIVITY_FLAGS = [
  'retargeted',
  'ref-stale',
  'expect-failed',
  'timeout',
  'unmatched',
  'not-found',
  'multiple-matches',
  'flow-timeout',
  'download-timeout',
  'unsettled',
  'hit-mismatch',
] as const;

export type ActivityFlag = (typeof ACTIVITY_FLAGS)[number];

export function isActivityFlag(value: unknown): value is ActivityFlag {
  return typeof value === 'string' && (ACTIVITY_FLAGS as readonly string[]).includes(value);
}

/** One dispatched tool call, as stored. Field order mirrors the table. */
export interface ActivityRecord {
  /** Monotonic rowid. Also the pagination cursor — see `queries.ts`. */
  id: number;
  /** ISO-8601, UTC. */
  at: string;
  /** Full MCP tool name, e.g. `browser.click`. Never abbreviated: the trail
   * is read by humans and by other agents, and `click` alone is ambiguous
   * once flows and map tools are in the same list. */
  tool: string;
  /** browser-link tab id (`tab_1`, `cdp:TARGET-1`), or null for tabless tools. */
  tabId: string | null;
  transport: ActivityTransport | null;
  /** Tab URL at dispatch time. The single most useful column when reading
   * the trail back weeks later — a selector without a page is noise. */
  url: string | null;
  title: string | null;
  /** Self-declared agent label from the claim layer ("claude-code",
   * "opencode"), falling back to the caller's binary. What makes an exported
   * trail useful across agents: it answers "which of them did this". */
  agent: string | null;
  /** The agent's process id. Disambiguates two runs of the same binary. */
  agentPid: number | null;
  /** CSS selector the call targeted, when the tool takes one. */
  selector: string | null;
  /** Agent-supplied or page-derived text: typed string, evaluate expression,
   * navigate URL. Null when the tool has none, or when payload recording is
   * off. See the PRIVACY CONTRACT above. */
  payload: string | null;
  outcome: ActivityOutcome;
  /** Error message when `outcome` is `error`. Truncated, never a stack. */
  error: string | null;
  /** Wall-clock duration of the dispatch, milliseconds. */
  durationMs: number;
  /** Set when this call was a step inside a `browser.flow`, so the window can
   * group a 40-step flow under one heading instead of flooding the timeline. */
  flowId: string | null;
  /** Friction classification (see `ActivityFlag`), or null for a clean call
   * and for every row recorded before the column existed. Optional so a
   * caller built against the previous shape still compiles. */
  flag?: ActivityFlag | null;
  /** The IPC session uuid of the calling agent, or `'primary'` for the stdio
   * agent. Unlike `agent` (a label two runs can share) it tells two sessions
   * apart, which is what the per-session report groups by. Null for rows
   * recorded before the column existed. */
  agentId?: string | null;
}

/** What the recorder is handed. `id` and `at` are assigned on write — a
 * caller that could choose its own id could also rewrite history. */
export type ActivityInput = Omit<ActivityRecord, 'id' | 'at'>;

/** Filters for reading the trail back. Every field is optional and ANDed;
 * the default is "the most recent page of everything". */
export interface ActivityQuery {
  /** Return rows with `id` strictly greater than this. The cursor for the
   * live-tailing panel: it keeps the last id it rendered and asks for more,
   * exactly like `browser.events`' `since_id`. */
  sinceId?: number;
  /** Return rows with `id` strictly less than this — paging BACKWARDS through
   * history, which is what the window's "load older" does. */
  beforeId?: number;
  tabId?: string;
  agent?: string;
  tool?: string;
  flowId?: string;
  outcome?: ActivityOutcome;
  flag?: ActivityFlag;
  /** Exact session id (`ActivityRecord.agentId`), not the agent label. */
  agentId?: string;
  /** Rows at or after this ISO timestamp. */
  since?: string;
  /** Hard cap on rows returned. Clamped by the query layer — an unbounded
   * read of a table with no ceiling is how a panel freezes a browser. */
  limit?: number;
}

/** A page of the trail plus the cursor needed to ask for the next one. */
export interface ActivityPage {
  records: ActivityRecord[];
  /** Highest id in this page, or the request's `sinceId` when empty. Feed it
   * back as `sinceId` to tail without re-reading what you already have. */
  latestId: number;
  /** Total rows matching the filter, ignoring `limit`. Lets the window say
   * "showing 200 of 4813" instead of silently truncating. */
  total: number;
}
