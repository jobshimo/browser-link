/**
 * MCP tool definitions for the browser-bridge family. Kept separate from
 * the runtime dispatcher so the JSON schemas stay reviewable in one place
 * and the dispatch logic stays small.
 *
 * Each entry carries a `doc` block (`ToolDoc`) with structured human-facing
 * documentation. `buildServerInstructions()` reads those blocks to produce
 * the SERVER_INSTRUCTIONS string the MCP host receives on `initialize`. The
 * structured shape keeps the "when to use" copy beside the tool that owns
 * it instead of drifting in a single monolithic string.
 */

import type { ToolDefinition } from './types.js';

export const BROWSER_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'browser.list_tabs',
    description:
      'List Chrome tabs currently connected to browser-link. A tab is connected only after the user clicks Connect in the extension popup. Each entry includes tab_id, url, title, claimed_by (null when free, or { agent_id, pid, binary, label?, claimed_at, last_activity_at } when another agent owns it) and claimed_by_me (true when YOU hold the claim).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    doc: {
      purpose:
        'List the Chrome tabs the user has explicitly connected through the browser-link extension popup.',
      when_to_use: [
        'Before doing anything on a tab whose state you do not already own.',
        'When the user mentions a UI bug, web page, or asks "does X work" — call this FIRST.',
        'To see which tabs are claimed by other agents (claimed_by) and which are yours (claimed_by_me).',
      ],
      gotchas: [
        'Returns only tabs the user has connected manually. If the list is empty the user has not connected anything yet — ask them to open the extension popup.',
      ],
    },
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
    doc: {
      purpose:
        'Reserve a tab cooperatively so other MCP clients sharing the bridge see it is in use.',
      when_to_use: [
        'Before a multi-step flow on a tab in multi-agent mode, so other agents see you working on it.',
        'To refresh the inactivity TTL or update the display label on a tab you already hold.',
      ],
      gotchas: [
        'Action tools (click/type/navigate/evaluate) auto-claim a free tab on first use, so explicit claim_tab is only required for early reservation.',
        'On conflict the response includes the existing claim — do NOT spin-retry; pick a different tab or surface the conflict to the user.',
      ],
      example: 'browser.claim_tab({ tab_id: "tab_1", label: "claude-code", ttl_minutes: 15 })',
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
    doc: {
      purpose: 'Hand a previously claimed tab back so another agent can take it.',
      when_to_use: [
        'After you finished working on a tab and want to hand it off before the TTL expires.',
      ],
      gotchas: [
        'Claims also auto-release on agent disconnect and after the inactivity TTL (default 10 minutes) — explicit release is only for early hand-off.',
      ],
    },
  },
  {
    name: 'browser.my_tabs',
    description:
      'List the tabs YOU currently hold a claim on. Returns { claims: [{ tab_id, claimed_at, last_activity_at, ttl_ms, label? }] } sorted by claimed_at. Use this to answer the user when they ask which tabs you are working on.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    doc: {
      purpose: 'Return the tabs the current agent has claimed, with timestamps and TTL.',
      when_to_use: [
        'When the user asks which tab you are using ("¿qué pestaña tenés?", "which tab are you on?").',
        'To verify which tab is yours before performing an action in multi-agent mode.',
      ],
    },
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
    doc: {
      purpose: 'Confirm the bridge to a specific tab is healthy and read back its title/url.',
      when_to_use: ['When you suspect a tab may have been closed or disconnected between calls.'],
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
    doc: {
      purpose: 'Drive a connected tab to a new URL.',
      when_to_use: [
        'The user asks you to open a page in the browser ("abrí esto en el navegador", "navigate to X").',
        'You need to reach a specific route before snapshotting or interacting.',
      ],
      gotchas: [
        'Defaults to wait_for_load=true so the snapshot you take next reflects the loaded page.',
      ],
      example: 'browser.navigate({ tab_id: "tab_1", url: "https://example.com" })',
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
    doc: {
      purpose:
        'Inspect what is currently on the tab — title, URL, visible text, interactive elements with selectors.',
      when_to_use: [
        'Before suggesting any code change to a UI component — verify the current state, do NOT speculate.',
        'Before clicking or typing, to find a stable selector for the target element.',
        'When the user reports a layout or visual issue and you need to ground your reasoning in what is actually rendered.',
      ],
      gotchas: [
        'The snapshot is the source of truth; the persistent map is a cache, not a substitute.',
      ],
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
    doc: {
      purpose: 'Read recent console messages from the tab — log, info, warn, error, debug.',
      when_to_use: [
        'When the user says "the button does not work" or "something is broken" — check console errors first.',
        'After an action to see what the page logged in response.',
      ],
      gotchas: [
        'Rolling buffer of 200 entries — older logs are dropped. Snapshot console output early in a long session.',
      ],
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
    doc: {
      purpose: 'List recent network requests with status, mime, size and timing.',
      when_to_use: [
        'When the user reports a failed API call, slow request, or a 4xx/5xx response in the page.',
        'To verify whether a request fired after a click or form submission.',
      ],
      gotchas: [
        'Rolling buffer of 200 entries — pair with url_filter to narrow the result.',
        'Use browser.network_body with the request_id to fetch a specific response body.',
      ],
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
    doc: {
      purpose: 'Fetch the response body for one request_id returned by browser.network.',
      when_to_use: [
        'After identifying a suspicious request in browser.network, to see what the server returned.',
      ],
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
    doc: {
      purpose: 'Click an element identified by a CSS selector.',
      when_to_use: [
        'After browser.snapshot returned a selector for the element the user asked you to interact with.',
      ],
      gotchas: [
        'Never click a selector you have not just verified via browser.snapshot or browser.map.recall — speculating wastes a turn.',
        'Auto-claims the tab on first use in multi-agent mode.',
      ],
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
    doc: {
      purpose: 'Focus an input element by selector and type text into it.',
      when_to_use: [
        'After browser.snapshot returned a selector for the input the user wants filled.',
      ],
      gotchas: [
        'Pass clear:true when you need to replace the current value instead of appending to it.',
      ],
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
    doc: {
      purpose: 'Execute a JavaScript expression in the page and return its value.',
      when_to_use: [
        'When snapshot/click/type are not expressive enough — pulling a computed value, reading a JS variable, or invoking page APIs.',
      ],
      gotchas: ['Wrap multi-step logic in an IIFE that returns the value you want.'],
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
    doc: {
      purpose:
        'Inspect bridge lifecycle events — primary elections, tab registrations, tab renames.',
      when_to_use: [
        'When a tool call returns "Tab not connected: …" — look for a tab-renamed entry to find the new tab_id.',
        'To diagnose why a tab disappeared between calls.',
      ],
      gotchas: [
        'Pass latest_id from the previous call as since_id to page through new entries efficiently.',
      ],
    },
  },
  {
    name: 'browser.reset',
    description:
      'Soft-reset the bridge state. Drops every connected tab session, releases every claim, and clears the in-memory event log — but does NOT kill the MCP server itself. The user has to re-press Connect in the extension popup for each tab they want back. Use this when the bridge state looks inconsistent (stale tab_ids that browser.events does not explain, tab.click that hangs, claims you cannot release through normal means) and you are sure a clean slate is the right move.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    doc: {
      purpose:
        'Soft-reset the bridge: drop tab sessions + claims + event log, keep the MCP server alive.',
      when_to_use: [
        'Bridge state looks inconsistent (stale tab_ids, hung action tools, claims you cannot release).',
        'You explicitly want to start the bridge state from scratch without killing the MCP server.',
      ],
      gotchas: [
        'This drops every tab the user had connected — they will need to re-press Connect in the extension popup for each one.',
        'Use sparingly. Most "tab not connected" cases resolve via browser.events showing a tab-renamed entry, not via reset.',
      ],
    },
  },
];
