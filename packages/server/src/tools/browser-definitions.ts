/**
 * MCP tool definitions for the browser-bridge family. Kept separate from
 * the runtime dispatcher so the JSON schemas stay reviewable in one place
 * and the dispatch logic stays small.
 */

import type { ToolDefinition } from './types.js';

export const BROWSER_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'browser.list_tabs',
    description:
      'List Chrome tabs currently connected to browser-link. A tab is connected only after the user clicks Conectar in the extension popup. Returns tab_id, url and title for each.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'browser.ping',
    description: 'Verify the bridge to a tab. Returns its current title and url.',
    inputSchema: {
      type: 'object',
      properties: { tab_id: { type: 'string' } },
      required: ['tab_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'browser.navigate',
    description: 'Navigate the connected tab to a URL. By default waits for the load event.',
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: { type: 'string' },
        url: { type: 'string', description: 'Full URL including protocol.' },
        wait_for_load: { type: 'boolean', default: true },
      },
      required: ['tab_id', 'url'],
      additionalProperties: false,
    },
  },
  {
    name: 'browser.snapshot',
    description:
      'Snapshot of the tab: title, url, visible text (truncated) and a list of interactive elements (buttons, links, inputs, selects, textareas) with a CSS selector and labels. Use this to understand page state before clicking or typing.',
    inputSchema: {
      type: 'object',
      properties: { tab_id: { type: 'string' } },
      required: ['tab_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'browser.console',
    description:
      'Return recent console messages (log, info, warn, error) from the connected tab since it was attached. Rolling buffer (last 200).',
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: { type: 'string' },
        level: { type: 'string', enum: ['log', 'info', 'warn', 'error', 'debug'] },
      },
      required: ['tab_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'browser.network',
    description:
      'Return recent network requests from the connected tab (rolling buffer, last 200). Includes request_id, method, url, status, mime, size, timing. Use browser.network_body to fetch the body of a specific request.',
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: { type: 'string' },
        url_filter: { type: 'string', description: 'Optional substring to filter request URLs.' },
      },
      required: ['tab_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'browser.network_body',
    description:
      'Fetch the response body of a single network request by request_id (from browser.network).',
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: { type: 'string' },
        request_id: { type: 'string' },
      },
      required: ['tab_id', 'request_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'browser.click',
    description:
      'Click an element by CSS selector in the connected tab. The selector usually comes from browser.snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: { type: 'string' },
        selector: { type: 'string' },
      },
      required: ['tab_id', 'selector'],
      additionalProperties: false,
    },
  },
  {
    name: 'browser.type',
    description:
      'Focus an input by CSS selector and type text into it. If clear=true, clears the current value first.',
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: { type: 'string' },
        selector: { type: 'string' },
        text: { type: 'string' },
        clear: { type: 'boolean', default: false },
      },
      required: ['tab_id', 'selector', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'browser.evaluate',
    description:
      'Run a JavaScript expression in the page context and return its result. Use an IIFE with return if you need multi-step logic.',
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: { type: 'string' },
        expression: { type: 'string' },
      },
      required: ['tab_id', 'expression'],
      additionalProperties: false,
    },
  },
  {
    name: 'browser.events',
    description:
      'Return recent bridge lifecycle events: primary-elected (a new browser-link primary started), tab-registered / tab-disconnected (Chrome tabs joined/left), tab-renamed (the same Chrome tab got a new tab_id, usually after a primary swap). Call this when you get "Tab not connected: …" so you can pick up the new tab_id and resume work. Returns { events, latest_id } — pass latest_id back as since_id next time to get only new entries.',
    inputSchema: {
      type: 'object',
      properties: {
        since_id: {
          type: 'number',
          description: 'Only return events with id > since_id. Omit to get the most recent slice.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of events to return (default 20, max 200).',
        },
      },
      additionalProperties: false,
    },
  },
];
