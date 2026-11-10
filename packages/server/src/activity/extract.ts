import type { ActivityFlag, ActivityInput, ActivityTransport } from './types.js';
import type { AgentCaller } from '../tools/tab-claims.js';
import { categorise } from '../errors/categories.js';
import { SensitiveFieldError } from './sensitive-field-error.js';

/**
 * Turn one tool dispatch into a trail row.
 *
 * This module exists so the dispatcher wrapper stays four lines. Knowing that
 * `type`'s interesting text is `args.text` while `evaluate`'s is
 * `args.expression` is knowledge about the TOOL SURFACE, and it belongs next
 * to the trail that consumes it — not smeared through a 30-arm switch whose
 * job is routing.
 */

/** Which argument carries the CSS selector, per tool. Tools absent from the
 * map simply record no selector. */
const SELECTOR_ARG: Readonly<Record<string, string | undefined>> = {
  'browser.click': 'selector',
  'browser.type': 'selector',
  'browser.press': 'selector',
  'browser.wait_for': 'selector',
  'browser.snapshot': 'within_selector',
  'browser.canvas_screenshot': 'selector',
  'browser.screenshot': 'selector',
  'browser.download': 'selector',
};

/**
 * Which argument carries the free text worth keeping, per tool.
 *
 * Only tools whose payload actually reconstructs the action appear here. A
 * `browser.snapshot`'s `max_interactive` is a knob, not a payload; recording
 * knobs would bury the three fields that matter (what was typed, what was
 * evaluated, where it navigated) under noise.
 */
const PAYLOAD_ARG: Readonly<Record<string, string | undefined>> = {
  'browser.navigate': 'url',
  'browser.type': 'text',
  'browser.find': 'text',
  'browser.evaluate': 'expression',
  'browser.press': 'key',
  'browser.download': 'url',
};

function readString(args: unknown, key: string): string | null {
  if (typeof args !== 'object' || args === null) return null;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** `browser.flow` has no single payload argument — its substance is the step
 * list. Its row stores the step KINDS only (`"5 steps: find → click → type"`):
 * the steps run inside the flow runner and get no rows of their own, so
 * nothing a `type` step typed reaches the trail. */
function summariseFlow(args: unknown): string | null {
  if (typeof args !== 'object' || args === null) return null;
  const steps = (args as { steps?: unknown }).steps;
  if (!Array.isArray(steps)) return null;
  const kinds = steps
    .map((step) =>
      typeof step === 'object' && step !== null ? Object.keys(step as object)[0] : null,
    )
    .filter((k): k is string => typeof k === 'string');
  if (kinds.length === 0) return `${steps.length} steps`;
  return `${steps.length} steps: ${kinds.join(' → ')}`;
}

/**
 * What the trail stores in `payload` instead of the typed text or key of a
 * `browser.type` / `browser.press` whose executor reported
 * `sensitive_field: true` (a password field, or an `autocomplete` token
 * the page uses for passwords, one-time codes or card numbers). Fixed, so a
 * reader can tell "redacted at record time" from "payloads were off" (null).
 */
export const SENSITIVE_PAYLOAD_MARKER = '[sensitive field]';

/** The tools whose result can carry `sensitive_field`. */
const FIELD_INPUT_TOOLS: ReadonlySet<string> = new Set(['browser.type', 'browser.press']);

export function extractSelector(tool: string, args: unknown): string | null {
  const key = SELECTOR_ARG[tool];
  return key === undefined ? null : readString(args, key);
}

export function extractPayload(tool: string, args: unknown): string | null {
  if (tool === 'browser.flow') return summariseFlow(args);
  const key = PAYLOAD_ARG[tool];
  return key === undefined ? null : readString(args, key);
}

/** The browser-link tab id the call targeted, when it takes one. */
export function extractTabId(args: unknown): string | null {
  return readString(args, 'tab_id');
}

/** Flow id, for the tools that address an existing flow by id
 * (`flow_status`, `flow_cancel`). */
export function extractFlowId(args: unknown): string | null {
  return readString(args, 'flow_id');
}

/** `cdp:`-prefixed ids are the cdp-direct transport; everything else reached
 * the page through the extension. Mirrors `isCdpTabId` without importing it,
 * so the trail keeps working if that predicate ever gains transport-selection
 * side effects. */
export function transportFor(tabId: string | null): ActivityTransport | null {
  if (tabId === null) return null;
  return tabId.startsWith('cdp:') ? 'cdp' : 'extension';
}

/** Self-declared label first, binary as the fallback. `agent_id` alone is a
 * uuid nobody can read; the point of this column is that a human scanning an
 * exported trail can tell Claude Code from OpenCode at a glance. */
export function agentNameFor(caller: AgentCaller | undefined): string | null {
  if (!caller) return null;
  if (caller.label && caller.label.length > 0) return caller.label;
  return caller.binary && caller.binary.length > 0 ? caller.binary : null;
}

export interface BuildRowInput {
  tool: string;
  args: unknown;
  caller?: AgentCaller;
  durationMs: number;
  error?: unknown;
  /** False when `activity.record-payloads` is off: the row is still written,
   * with its shape intact, minus the free text. A sensitive field stores
   * `SENSITIVE_PAYLOAD_MARKER` either way. */
  recordPayloads: boolean;
  /** The resolved tool response, when the call did not throw. Read only to
   * classify `flag`, to measure `resultBytes` and to see whether a
   * `type` / `press` acted on a sensitive field; never stored. */
  result?: unknown;
  /** IPC session uuid of the caller; `'primary'` when absent. */
  agentId?: string | null;
}

/* ---------------------------------------------------------- flags ------
 *
 * A trail of bare `ok`/`error` loses the most useful evidence: calls that
 * RESOLVED but did not do what was asked (`wait_for` matched nothing, a flow
 * ran out of time, a click landed on another element). `classifyFlag` names
 * that friction, and the well-known thrown failures, with a closed enum so a
 * report can GROUP BY it instead of regexing error text.
 */

/** Tools whose resolved result is worth parsing. Everything else (snapshots,
 * screenshots, list_tabs) can be large and never carries a friction signal,
 * so it is not JSON-parsed on the hot path. */
const RESULT_TOOLS: ReadonlySet<string> = new Set([
  'browser.click',
  'browser.type',
  'browser.press',
  'browser.drag',
  'browser.find',
  'browser.wait_for',
  'browser.flow',
  'browser.download',
]);

/** The data object of a resolved result: the raw object, or the JSON in the
 * first text block of a non-error MCP envelope. Null for anything else. */
function resultData(result: unknown): unknown {
  if (!isMcpResponse(result)) return result;
  if ((result as { isError?: unknown }).isError === true) return null;
  const text = firstText(result);
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** True only when a `type` / `press` executor said the field it acted on is
 * one the page declares sensitive: `sensitive_field: true` on its result, or
 * a `SensitiveFieldError` when it failed after acting on that field. An
 * executor that reports nothing (an older extension, a failed probe, a plain
 * error) is false: the row is stored as before. */
export function reportsSensitiveField(tool: string, result: unknown, error?: unknown): boolean {
  if (!FIELD_INPUT_TOOLS.has(tool)) return false;
  if (error instanceof SensitiveFieldError) return true;
  const data = resultData(result);
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { sensitive_field?: unknown }).sensitive_field === true
  );
}

/** Thrown (or `isError`) messages, through the default rules of the shared
 * error-category table (`errors/categories.ts`, the same table the map
 * learner reads with its own overrides). */
function flagFromMessage(message: string): ActivityFlag | null {
  return categorise(message);
}

/** The first text block of an MCP response, or null when it is not one. */
function firstText(result: unknown): string | null {
  if (typeof result !== 'object' || result === null) return null;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  const block: unknown = content[0];
  if (typeof block !== 'object' || block === null) return null;
  const text = (block as { text?: unknown }).text;
  return typeof text === 'string' ? text : null;
}

function isMcpResponse(result: unknown): boolean {
  return (
    typeof result === 'object' &&
    result !== null &&
    Array.isArray((result as { content?: unknown }).content)
  );
}

function flagFromData(tool: string, data: unknown): ActivityFlag | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  if (tool === 'browser.flow' && d.stopped_by === 'timeout') return 'flow-timeout';
  if (tool === 'browser.download' && (d.state === 'timeout' || d.state === 'interrupted')) {
    return 'download-timeout';
  }
  if (d.matched === false) {
    if (d.reason === 'not-found') return 'not-found';
    if (d.reason === 'multiple-matches') return 'multiple-matches';
    if (d.reason === 'ref-stale') return 'ref-stale';
    return 'unmatched';
  }
  // The click builder reports `hit_element` ONLY when the click lands on an
  // element that is neither the target nor inside it (`buildClickResolveJs`),
  // so its presence on a resolved call is the mismatch itself.
  if (typeof d.hit_element === 'string' && d.hit_element.length > 0) return 'hit-mismatch';
  const settle = d.settle;
  if (typeof settle === 'object' && settle !== null) {
    if ((settle as { settled?: unknown }).settled === false) return 'unsettled';
  }
  return null;
}

/**
 * Classify one call. `error` is the thrown value (undefined on success);
 * `result` is the resolved response — an MCP `{ content: [...] }` envelope as
 * `dispatchBrowserTool` returns it, or a raw result object. Total and
 * throw-free: anything unreadable is simply "no flag".
 */
export function classifyFlag(
  tool: string,
  _args: unknown,
  result: unknown,
  error: unknown,
): ActivityFlag | null {
  try {
    if (error !== undefined) return flagFromMessage(errorMessage(error));
    if (isMcpResponse(result)) {
      const text = firstText(result);
      if (text === null) return null;
      if ((result as { isError?: unknown }).isError === true) return flagFromMessage(text);
      if (!RESULT_TOOLS.has(tool)) return null;
      return flagFromData(tool, JSON.parse(text) as unknown);
    }
    return flagFromData(tool, result);
  } catch {
    return null;
  }
}

/** Assemble the row. Deliberately total — every branch returns something
 * storable, because a tool call that produced a row we could not describe is
 * still a tool call that happened. */
export function buildRow({
  tool,
  args,
  caller,
  durationMs,
  error,
  recordPayloads,
  result,
  agentId,
}: BuildRowInput): ActivityInput {
  const tabId = extractTabId(args);
  return {
    tool,
    tabId,
    transport: transportFor(tabId),
    // Filled in by the dispatcher wrapper, which is the only caller that can
    // see the tab table. Null here keeps this module free of bridge deps.
    url: null,
    title: null,
    agent: agentNameFor(caller),
    agentPid: caller?.pid ?? null,
    selector: extractSelector(tool, args),
    payload: reportsSensitiveField(tool, result, error)
      ? SENSITIVE_PAYLOAD_MARKER
      : recordPayloads
        ? extractPayload(tool, args)
        : null,
    outcome: error === undefined ? 'ok' : 'error',
    error: error === undefined ? null : errorMessage(error),
    durationMs,
    flowId: extractFlowId(args),
    flag: classifyFlag(tool, args, result, error),
    agentId: agentId ?? 'primary',
    resultBytes: error === undefined ? serializedBytes(result) : null,
  };
}

/**
 * Size in bytes of `value` serialised as JSON (UTF-8): what a result costs on
 * the wire before the MCP envelope. `undefined` (a tool that returned
 * nothing) is 0; a value JSON cannot serialise (a cycle, a BigInt) is null,
 * because a guessed size would be worse than none. Never throws.
 */
export function serializedBytes(value: unknown): number | null {
  try {
    const text = JSON.stringify(value) as string | undefined;
    return text === undefined ? 0 : Buffer.byteLength(text, 'utf8');
  } catch {
    return null;
  }
}

/** `buildRow` with the arguments split out — the signature the dispatcher's
 * `writeTrail` calls. `meta` is `BuildRowInput` minus `args`, so a caller on
 * the previous shape (no `result`, no `agentId`) keeps compiling. */
export function buildActivityRow(args: unknown, meta: Omit<BuildRowInput, 'args'>): ActivityInput {
  return buildRow({ ...meta, args });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}
