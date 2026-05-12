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
      'List Chrome tabs currently connected to browser-link. A tab is connected only after the user clicks Connect in the extension popup. Each entry includes tab_id, url, title, claimed_by (null when free, or { agent_id, pid, binary, label?, claimed_at, last_activity_at } when another agent owns it) and claimed_by_me (true when YOU hold the claim).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'browser.claim_tab',
    description:
      'Claim a tab so other agents stop touching it. Returns ok:true with your claim, or ok:false reason:"conflict" with the existing claim. Pass an optional label (eg "claude-code") that other agents will see in browser.list_tabs. Pass ttl_minutes (default 10, max 60) — the claim auto-expires after that many minutes of inactivity. Action tools (click/type/navigate/evaluate) auto-claim free tabs, so an explicit claim_tab is only needed when you want to reserve a tab before you start, or to refresh the label/TTL.',
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: { type: 'string' },
        ttl_minutes: {
          type: 'number',
          description: 'Inactivity timeout for the claim, in minutes. Default 10, capped at 60.',
        },
        label: {
          type: 'string',
          description:
            'Optional self-declared display label (eg "claude-code", "opencode"). Visible to other agents in browser.list_tabs. Display only — not used for enforcement.',
        },
      },
      required: ['tab_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'browser.release_tab',
    description:
      'Release a tab claim you hold. Returns ok:true on success, ok:false reason:"not-owner" if another agent holds it, or ok:false reason:"not-claimed" if the tab is free. Releasing is also automatic on agent disconnect and when the inactivity TTL elapses, so calling this explicitly is only needed for early hand-off.',
    inputSchema: {
      type: 'object',
      properties: { tab_id: { type: 'string' } },
      required: ['tab_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'browser.my_tabs',
    description:
      'List the tabs YOU currently hold a claim on. Returns { claims: [{ tab_id, claimed_at, last_activity_at, ttl_ms, label? }] } sorted by claimed_at. Use this to answer the user when they ask which tabs you are working on.',
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
