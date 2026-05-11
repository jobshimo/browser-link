/**
 * Dispatcher for browser.* tools. Mirrors the shape of the map dispatcher
 * (`handleMapTool` / `isMapTool`) so both families look the same from
 * runServer().
 *
 * The handlers do not own state: they receive a `BrowserToolDeps` object
 * with the live tab map and the call function. This makes the dispatcher
 * unit-testable with a fake `callBrowserTool`.
 */

import { requireTabId } from './responses.js';

export interface TabSnapshot {
  tab_id: string;
  url: string;
  title: string;
}

export interface BrowserToolDeps {
  listTabs(): TabSnapshot[];
  callBrowserTool(
    tabId: string,
    tool: string,
    params: unknown,
    timeoutMs?: number,
  ): Promise<unknown>;
}

export function isBrowserTool(name: string): boolean {
  return name === 'browser.list_tabs' || BROWSER_TOOL_HANDLERS.has(name);
}

type Handler = (args: unknown, deps: BrowserToolDeps) => Promise<unknown> | unknown;

const NAVIGATE_TIMEOUT_MS = 30_000;

const BROWSER_TOOL_HANDLERS: ReadonlyMap<string, Handler> = new Map<string, Handler>([
  ['browser.list_tabs', (_args, deps) => deps.listTabs()],
  ['browser.ping', (args, deps) => deps.callBrowserTool(requireTabId(args), 'ping', {})],
  [
    'browser.navigate',
    (args, deps) => {
      const { url, wait_for_load = true } = args as { url: string; wait_for_load?: boolean };
      return deps.callBrowserTool(
        requireTabId(args),
        'navigate',
        { url, wait_for_load },
        NAVIGATE_TIMEOUT_MS,
      );
    },
  ],
  ['browser.snapshot', (args, deps) => deps.callBrowserTool(requireTabId(args), 'snapshot', {})],
  [
    'browser.console',
    (args, deps) => {
      const { level } = (args as { level?: string }) ?? {};
      return deps.callBrowserTool(requireTabId(args), 'console', { level });
    },
  ],
  [
    'browser.network',
    (args, deps) => {
      const { url_filter } = (args as { url_filter?: string }) ?? {};
      return deps.callBrowserTool(requireTabId(args), 'network', { url_filter });
    },
  ],
  [
    'browser.network_body',
    (args, deps) => {
      const { request_id } = args as { request_id: string };
      return deps.callBrowserTool(requireTabId(args), 'network_body', { request_id });
    },
  ],
  [
    'browser.click',
    (args, deps) => {
      const { selector } = args as { selector: string };
      return deps.callBrowserTool(requireTabId(args), 'click', { selector });
    },
  ],
  [
    'browser.type',
    (args, deps) => {
      const {
        selector,
        text,
        clear = false,
      } = args as {
        selector: string;
        text: string;
        clear?: boolean;
      };
      return deps.callBrowserTool(requireTabId(args), 'type', { selector, text, clear });
    },
  ],
  [
    'browser.evaluate',
    (args, deps) => {
      const { expression } = args as { expression: string };
      return deps.callBrowserTool(requireTabId(args), 'evaluate', { expression });
    },
  ],
]);

export async function handleBrowserTool(
  name: string,
  args: unknown,
  deps: BrowserToolDeps,
): Promise<unknown> {
  const handler = BROWSER_TOOL_HANDLERS.get(name);
  if (!handler) throw new Error(`Unknown browser tool: ${name}`);
  return handler(args, deps);
}
