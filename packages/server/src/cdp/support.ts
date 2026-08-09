/**
 * Declarative v1 support table for browser-link's cdp-direct transport —
 * the SINGLE source of truth `tools/browser-dispatch.ts`'s routing layer
 * reads to decide whether a tool may address a `cdp:` tab, instead of
 * scattered per-tool `if` checks. Kept in its own zero-dependency module so
 * the dispatcher can import just the table without pulling in the whole
 * transport (CDP client, WebSocket connections, in-page builders, …).
 *
 * Keyed by the WIRE-LEVEL tool name (what `callBrowserTool`/`callCdpTool`
 * receive — `'click'`, not `'browser.click'`).
 *
 * `list_tabs`, `claim_tab`, `release_tab`, `my_tabs`, `events`, `reset` are
 * dispatcher-only (they never reach a per-tab transport) and deliberately
 * absent — see `tools/browser-dispatch.ts` for how each is handled.
 *
 * Kept out of scope for v1 (see the README's cdp-direct tool-support table
 * and the CHANGELOG's Internal section for the future-work list): `drag`,
 * `console`, `network`, `network_body`, `canvas_screenshot`,
 * `dialog_respond`, `set_permission`, `wait_for_tab`.
 */
// A real Map (not a plain object/Record) so a tool name absent from the
// table types as genuinely `undefined` at `.get()` — the same reason
// keymap.ts's NAMED_KEYS_LOWER is a Map, not a Record: this tsconfig leaves
// `noUncheckedIndexedAccess` off, so a `Record<string, boolean>`'s index
// access would type as always-`boolean` (never `undefined`), which is
// wrong for an unknown tool name and fights the linter either way you try
// to guard it.
export const CDP_TOOL_SUPPORT: ReadonlyMap<string, boolean> = new Map([
  ['ping', true],
  ['navigate', true],
  ['snapshot', true],
  ['find', true],
  ['state', true],
  ['click', true],
  ['type', true],
  ['press', true],
  ['evaluate', true],
  ['wait_for', true],
  ['flow', true],
  ['flow_status', true],
  ['flow_cancel', true],
  ['drag', false],
  ['console', false],
  ['network', false],
  ['network_body', false],
  ['canvas_screenshot', false],
  ['dialog_respond', false],
  ['set_permission', false],
  ['wait_for_tab', false],
]);

export function isCdpToolSupported(tool: string): boolean {
  return CDP_TOOL_SUPPORT.get(tool) === true;
}

/** Error a caller gets for a tool that is valid in general but explicitly
 * not implemented over cdp-direct in v1 — names the limitation and points
 * at the fallback transport. */
export function cdpUnsupportedToolError(tool: string): Error {
  return new Error(
    `browser.${tool} is not supported over cdp-direct in v1. Use a tab connected through the Chrome extension instead.`,
  );
}
