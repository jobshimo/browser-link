import type { ActivityInput, ActivityTransport } from './types.js';
import type { AgentCaller } from '../tools/tab-claims.js';

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
};

function readString(args: unknown, key: string): string | null {
  if (typeof args !== 'object' || args === null) return null;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** `browser.flow` has no single payload argument — its substance is the step
 * list. Summarising it as `"5 steps: find → click → type"` keeps one trail row
 * readable where inlining the whole JSON would not, and the per-step detail is
 * already recorded by the steps' own rows. */
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

/** Flow id, for the two tools that address an existing flow by id. Steps
 * dispatched INSIDE a flow are stamped by the flow runner, not here. */
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
   * with its shape intact, minus the free text. */
  recordPayloads: boolean;
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
    payload: recordPayloads ? extractPayload(tool, args) : null,
    outcome: error === undefined ? 'ok' : 'error',
    error: error === undefined ? null : errorMessage(error),
    durationMs,
    flowId: extractFlowId(args),
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}
