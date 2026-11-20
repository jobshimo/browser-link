/**
 * What browser-link's cdp-direct transport supports — the SINGLE source of
 * truth `tools/browser-dispatch.ts`'s routing layer reads to decide whether a
 * tool may address a `cdp:` tab, instead of scattered per-tool `if` checks.
 * Kept apart from the transport so the dispatcher can import the table
 * without pulling in the CDP client and its WebSocket connections.
 *
 * Keyed by the WIRE-LEVEL tool name (what `callBrowserTool`/`callCdpTool`
 * receive — `'click'`, not `'browser.click'`).
 *
 * `list_tabs`, `claim_tab`, `release_tab`, `my_tabs`, `events`, `reset` and
 * `wait_for_tab` are dispatcher-only (they never reach a per-tab transport)
 * and deliberately absent — see `tools/browser-dispatch.ts` for how each is
 * handled (`wait_for_tab` on a `cdp:` opener uses `./opened-tabs.ts` since
 * 1.4.41, parity P7).
 *
 * Still refused (see the README's cdp-direct tool-support table and
 * `docs/design/cdp-direct-parity.md` for the order they are taken in):
 * `console`, `network`, `network_body`, `set_permission`, and `download`
 * (`browser.download`'s selector mode).
 * `drag` and `canvas_screenshot` joined cdp-direct in 1.4.36, `dialog_respond` in
 * 1.4.39, `wait_for_tab` in 1.4.41.
 */
import { TOOL_REGISTRY } from '../generated/core/tools/catalog.js';
import { cdpToolSupport } from '../generated/core/tools/registry.js';
import type { Requirement } from '../generated/core/tools/requirement.js';

/** What cdp-direct provides to the tool registry (design 3.3): the page
 * ports, the CDP event wait, the drag input (`drag`), the canvas screenshot
 * (`canvas`, through the evaluator), the dialog input (`dialog-input`, for a
 * dialog the connection saw open: parity P3) and its own flow model
 * (`flows`, and `flow-cancel`, which only cdp-direct provides). It does not
 * provide `capture-buffers`: it never enables the Network domain or keeps
 * console messages, so a `network_url` wait, `browser.console` and
 * `browser.network` are refused; nor `response-bodies`, so
 * `browser.network_body` is refused; nor `downloads` or `content-settings`,
 * so `browser.set_permission` and `browser.download` are refused (v1 scope;
 * changing any is a behavior change). */
export const CDP_DIRECT_PROVIDES: ReadonlySet<Requirement> = new Set<Requirement>([
  'evaluator',
  'keyboard',
  'pointer',
  'settler',
  'cdp-events',
  'page',
  'navigator',
  'screen-capture',
  'flows',
  'flow-cancel',
  'canvas',
  'drag',
  'dialog-input',
]);

/**
 * Derived (design 3.3): each listed registry entry is supported when
 * `CDP_DIRECT_PROVIDES` holds every requirement it `requires`. No row is
 * hand-declared since parity P7 removed `wait_for_tab`'s (it is
 * dispatcher-only and works on both transports). Its order is not a
 * contract: callers only `.get` a tool.
 *
 * A real Map (not a plain object/Record) so a tool name absent from the
 * table types as genuinely `undefined` at `.get()`: this tsconfig leaves
 * `noUncheckedIndexedAccess` off, so a `Record<string, boolean>`'s index
 * access would type as always-`boolean`. `download` is `browser.download`'s
 * selector mode: capturing a click-started download needs the extension's
 * `chrome.downloads` hook; its url mode never sends this wire tool — it rides
 * `evaluate` — so it works on cdp-direct too.
 */
export const CDP_TOOL_SUPPORT: ReadonlyMap<string, boolean> = new Map(
  cdpToolSupport(TOOL_REGISTRY, CDP_DIRECT_PROVIDES),
);

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
