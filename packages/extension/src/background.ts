import type {
  ExtensionToServer,
  ServerToExtension,
  ToolRequestMessage,
} from '@browser-link/shared';

const WS_URL = 'ws://127.0.0.1:17529';
const CDP_VERSION = '1.3';
const CONSOLE_BUFFER_MAX = 200;
const NETWORK_BUFFER_MAX = 200;

/* Idle TTL for a tab's WebSocket bridge.
 *
 * After this many milliseconds without a tool.request from the server,
 * the extension closes its side of the WS and detaches the debugger.
 * The popup then shows "Not connected" again and the user explicitly
 * re-presses Connect when they want to reactivate.
 *
 * This replaces the previous behaviour where the bridge implicitly
 * died together with the MCP server subprocess (parent_death_guard,
 * removed in v0.9.0). Lifecycle is now client-side: agent activity
 * keeps the tab warm, silence eventually parks it. */
const WS_IDLE_TTL_MS = 30 * 60 * 1000;
const WS_IDLE_SWEEP_MS = 60 * 1000;

interface ConsoleEntry {
  timestamp: number;
  level: string;
  text: string;
  source: 'console' | 'log';
  url?: string;
  line?: number;
}

interface NetworkEntry {
  request_id: string;
  url: string;
  method: string;
  resource_type?: string;
  status?: number;
  status_text?: string;
  mime_type?: string;
  request_headers?: Record<string, string>;
  response_headers?: Record<string, string>;
  request_post_data?: string;
  encoded_data_length?: number;
  started_at: number;
  finished_at?: number;
  failed?: string;
}

interface TabState {
  tabId: number;
  serverTabId?: string;
  ws?: WebSocket;
  debuggerAttached: boolean;
  consoleBuffer: ConsoleEntry[];
  networkBuffer: Map<string, NetworkEntry>;
  networkOrder: string[];
  debuggerListener?: (method: string, params: unknown) => void;
  /** Last time the server talked to this tab (a tool.request landed).
   * Used by the WS-idle sweeper to disconnect tabs that have been
   * silent for `WS_IDLE_TTL_MS`. Touched on every tool.request received
   * AND once at connect time. */
  lastActivityAt: number;
}

interface ConnectResult {
  ok: boolean;
  error?: string;
  serverTabId?: string;
}

interface StatusResult {
  connected: boolean;
  serverTabId?: string;
}

// === CDP types — only the fields we actually read ======================
// The real Chrome DevTools Protocol surface is huge; the chrome.debugger
// API hands us back `unknown` and leaves the typing to us. These shapes
// describe just the slices we use, so the rest of the file can drop
// `Record<string, any>` casts and `unknown` member access entirely.

interface CdpRuntimeEvaluateResponse<T = unknown> {
  result: { value: T };
  exceptionDetails?: {
    exception?: { description?: string };
    text?: string;
  };
}

interface CdpRuntimeConsoleAPICalled {
  args?: { value?: unknown; description?: string }[];
  timestamp?: number;
  type?: string;
}

interface CdpLogEntryAdded {
  entry?: {
    level?: string;
    text?: string;
    timestamp?: number;
    url?: string;
    lineNumber?: number;
  };
}

interface CdpNetworkRequestWillBeSent {
  requestId: string;
  type?: string;
  request?: {
    url?: string;
    method?: string;
    headers?: Record<string, string>;
    postData?: string;
  };
}

interface CdpNetworkResponseReceived {
  requestId: string;
  response?: {
    status?: number;
    statusText?: string;
    mimeType?: string;
    headers?: Record<string, string>;
  };
}

interface CdpNetworkLoadingFinished {
  requestId: string;
  encodedDataLength?: number;
}

interface CdpNetworkLoadingFailed {
  requestId: string;
  errorText?: string;
}

interface CdpNetworkGetResponseBody {
  body: string;
  base64Encoded: boolean;
}

interface CdpInputDragIntercepted {
  data: unknown;
}

// Runtime messages between popup.ts and this script.
type RuntimeMessage =
  | { action: 'connect'; tabId: number }
  | { action: 'disconnect'; tabId: number }
  | { action: 'status'; tabId: number };

function isRuntimeMessage(msg: unknown): msg is RuntimeMessage {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as Record<string, unknown>;
  if (typeof m.tabId !== 'number') return false;
  return m.action === 'connect' || m.action === 'disconnect' || m.action === 'status';
}

const tabStates = new Map<number, TabState>();

function send(ws: WebSocket, msg: ExtensionToServer): void {
  ws.send(JSON.stringify(msg));
}

function safeParse(raw: string): ServerToExtension | null {
  try {
    return JSON.parse(raw) as ServerToExtension;
  } catch {
    return null;
  }
}

function cdp<T = unknown>(
  tabId: number,
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  return chrome.debugger.sendCommand({ tabId }, method, params) as unknown as Promise<T>;
}

/**
 * Defensive caps applied to every duration that ends up in a setTimeout
 * driven by tool params. The MCP request payload is technically untrusted
 * input, so CodeQL flags unbounded user-controlled timer durations as a
 * resource-exhaustion risk. We clamp at the boundary (drag handler) AND
 * inside `sleep` so the property is enforced even if a future call site
 * forgets to validate.
 */
const MAX_DRAG_DURATION_MS = 60_000;
const MAX_DRAG_HOLD_MS = 10_000;

function sleep(ms: number): Promise<void> {
  // Range-branch sanitizer for CodeQL's js/resource-exhaustion: the
  // setTimeout call is INSIDE a literal-bounded range check. Caller-side
  // clamping in the drag handler is the first line of defence; this is
  // the second.
  return new Promise((resolve) => {
    if (typeof ms === 'number' && ms > 0 && ms < 60_000) {
      setTimeout(resolve, ms);
    } else {
      setTimeout(resolve, 0);
    }
  });
}

/**
 * Wait for ONE CDP event of a given method on a given tab. Adds a temporary
 * chrome.debugger.onEvent listener for the duration of the wait. Resolves
 * with the event params, or null on timeout. Always cleans up its listener.
 *
 * Used by the drag tool to capture Input.dragIntercepted while
 * Input.setInterceptDrags is enabled.
 */
function waitForCdpEvent<T = unknown>(
  tabId: number,
  method: string,
  timeoutMs: number,
): Promise<T | null> {
  return new Promise((resolve) => {
    let settled = false;
    const handler = (source: chrome.debugger.Debuggee, m: string, params?: object): void => {
      if (settled) return;
      if (source.tabId !== tabId) return;
      if (m !== method) return;
      settled = true;
      clearTimeout(timer);
      chrome.debugger.onEvent.removeListener(handler);
      resolve((params ?? null) as T | null);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      chrome.debugger.onEvent.removeListener(handler);
      resolve(null);
    }, timeoutMs);
    chrome.debugger.onEvent.addListener(handler);
  });
}

/**
 * Build the JS expression that:
 *  1. scrollIntoView(center) for any selector-based endpoint (so both are
 *     visible at the same time if possible),
 *  2. detects HTML5 native drag eligibility on the source (`element.draggable`
 *     true, or implicit via <img> / <a href>),
 *  3. reads the final centre coords AFTER both scrolls have happened,
 *  4. flags in_viewport so the caller can refuse offscreen drags instead of
 *     dispatching cursor events into nowhere.
 *
 * Returns one of:
 *  - `{ err: string }`           — selector miss or stale element
 *  - `{ from, to, draggable }`   — ready to drag
 */
function buildDragProbeExpr(params: {
  from_selector?: string;
  to_selector?: string;
  from_x?: number;
  from_y?: number;
  to_x?: number;
  to_y?: number;
}): string {
  return `
    (() => {
      const P = ${JSON.stringify(params)};
      function scrollAndProbe(sel) {
        const el = document.querySelector(sel);
        if (!el) return { err: 'not_found' };
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        return {
          draggable:
            el.draggable === true ||
            el instanceof HTMLImageElement ||
            (el instanceof HTMLAnchorElement && !!el.href),
        };
      }
      function readCenter(sel) {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          x: r.left + r.width / 2,
          y: r.top + r.height / 2,
          in_viewport:
            r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth,
        };
      }
      let fromHint = null;
      if (P.from_selector) {
        fromHint = scrollAndProbe(P.from_selector);
        if (fromHint.err) return { err: 'from_selector not found: ' + P.from_selector };
      }
      if (P.to_selector) {
        const t = scrollAndProbe(P.to_selector);
        if (t.err) return { err: 'to_selector not found: ' + P.to_selector };
      }
      const from = P.from_selector
        ? readCenter(P.from_selector)
        : { x: P.from_x, y: P.from_y, in_viewport: true };
      const to = P.to_selector
        ? readCenter(P.to_selector)
        : { x: P.to_x, y: P.to_y, in_viewport: true };
      if (!from) return { err: 'from element disappeared between probes' };
      if (!to) return { err: 'to element disappeared between probes' };
      return { from, to, draggable: fromHint ? fromHint.draggable : false };
    })()
  `;
}

// Convert an arbitrary console arg (`unknown`) into something printable
// without leaking `[object Object]`. Used by the console buffer when CDP
// hands us values we don't statically know.
function stringifyConsoleArg(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return Object.prototype.toString.call(v);
  }
}

function pushConsole(state: TabState, entry: ConsoleEntry): void {
  state.consoleBuffer.push(entry);
  if (state.consoleBuffer.length > CONSOLE_BUFFER_MAX) {
    state.consoleBuffer.shift();
  }
}

function ensureNetworkEntry(state: TabState, requestId: string): NetworkEntry {
  let entry = state.networkBuffer.get(requestId);
  if (!entry) {
    entry = { request_id: requestId, url: '', method: '', started_at: Date.now() };
    state.networkBuffer.set(requestId, entry);
    state.networkOrder.push(requestId);
    while (state.networkOrder.length > NETWORK_BUFFER_MAX) {
      const oldId = state.networkOrder.shift();
      if (oldId !== undefined) state.networkBuffer.delete(oldId);
    }
  }
  return entry;
}

function attachDebuggerListener(state: TabState): void {
  const listener = (method: string, params: unknown): void => {
    if (method === 'Runtime.consoleAPICalled') {
      const p = params as CdpRuntimeConsoleAPICalled;
      const args = p.args ?? [];
      const text = args
        .map((a) => (a.value !== undefined ? stringifyConsoleArg(a.value) : (a.description ?? '')))
        .join(' ');
      pushConsole(state, {
        timestamp: p.timestamp ?? Date.now(),
        level: p.type ?? 'log',
        text,
        source: 'console',
      });
      return;
    }
    if (method === 'Log.entryAdded') {
      const p = params as CdpLogEntryAdded;
      const e = p.entry ?? {};
      pushConsole(state, {
        timestamp: e.timestamp ?? Date.now(),
        level: e.level ?? 'log',
        text: e.text ?? '',
        source: 'log',
        url: e.url,
        line: e.lineNumber,
      });
      return;
    }
    if (method === 'Network.requestWillBeSent') {
      const p = params as CdpNetworkRequestWillBeSent;
      const entry = ensureNetworkEntry(state, p.requestId);
      entry.url = p.request?.url ?? entry.url;
      entry.method = p.request?.method ?? entry.method;
      entry.resource_type = p.type ?? entry.resource_type;
      entry.request_headers = p.request?.headers ?? entry.request_headers;
      entry.request_post_data = p.request?.postData ?? entry.request_post_data;
      return;
    }
    if (method === 'Network.responseReceived') {
      const p = params as CdpNetworkResponseReceived;
      const entry = ensureNetworkEntry(state, p.requestId);
      entry.status = p.response?.status;
      entry.status_text = p.response?.statusText;
      entry.mime_type = p.response?.mimeType;
      entry.response_headers = p.response?.headers;
      return;
    }
    if (method === 'Network.loadingFinished') {
      const p = params as CdpNetworkLoadingFinished;
      const entry = ensureNetworkEntry(state, p.requestId);
      entry.finished_at = Date.now();
      entry.encoded_data_length = p.encodedDataLength;
      return;
    }
    if (method === 'Network.loadingFailed') {
      const p = params as CdpNetworkLoadingFailed;
      const entry = ensureNetworkEntry(state, p.requestId);
      entry.finished_at = Date.now();
      entry.failed = p.errorText ?? 'failed';
      return;
    }
  };
  state.debuggerListener = listener;
}

const SNAPSHOT_JS = `
(() => {
  function isVisible(el) {
    if (!(el instanceof HTMLElement)) return true;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    if (el.offsetParent === null && style.position !== 'fixed') return false;
    return true;
  }
  function shortText(el) {
    const t = (el.innerText || el.textContent || '').trim();
    return t.length > 120 ? t.slice(0, 120) + '...' : t;
  }
  function safeCss(s) {
    return s.replace(/"/g, '\\\\"');
  }
  function genSelector(el) {
    if (el.id && !/^[\\d]/.test(el.id) && !/\\s/.test(el.id)) {
      try { if (document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) return '#' + CSS.escape(el.id); } catch (_) {}
    }
    const tid = el.getAttribute('data-testid');
    if (tid) return '[data-testid="' + safeCss(tid) + '"]';
    const al = el.getAttribute('aria-label');
    if (al && al.length < 60) return el.tagName.toLowerCase() + '[aria-label="' + safeCss(al) + '"]';
    const name = el.getAttribute('name');
    if (name && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA')) {
      return el.tagName.toLowerCase() + '[name="' + safeCss(name) + '"]';
    }
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.body && parts.length < 6) {
      let part = cur.tagName.toLowerCase();
      const parent = cur.parentElement;
      if (parent) {
        const sib = Array.from(parent.children).filter(s => s.tagName === cur.tagName);
        if (sib.length > 1) {
          part += ':nth-of-type(' + (sib.indexOf(cur) + 1) + ')';
        }
      }
      parts.unshift(part);
      cur = parent;
    }
    return parts.join(' > ');
  }
  const sel = 'a[href], button, input, select, textarea, [role=button], [role=link], [role=checkbox], [role=tab], [role=menuitem], [contenteditable=true]';
  const interactive = [];
  document.querySelectorAll(sel).forEach((el) => {
    if (!isVisible(el)) return;
    interactive.push({
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || el.tagName.toLowerCase(),
      text: shortText(el),
      value: 'value' in el ? (el.value || '') : '',
      placeholder: el.getAttribute('placeholder') || '',
      aria_label: el.getAttribute('aria-label') || '',
      name: el.getAttribute('name') || '',
      type: el.getAttribute('type') || '',
      href: el.getAttribute('href') || '',
      disabled: 'disabled' in el ? !!el.disabled : false,
      selector: genSelector(el),
    });
  });
  const headings = [];
  document.querySelectorAll('h1, h2, h3').forEach((h) => {
    if (!isVisible(h)) return;
    headings.push({ level: h.tagName, text: shortText(h) });
  });
  const visibleText = (document.body && document.body.innerText) ? document.body.innerText.slice(0, 4000) : '';
  return {
    title: document.title,
    url: location.href,
    headings: headings.slice(0, 30),
    text: visibleText,
    interactive: interactive.slice(0, 120),
  };
})()
`;

async function evaluateInTab<T = unknown>(tabId: number, expression: string): Promise<T> {
  const result = await cdp<CdpRuntimeEvaluateResponse<T>>(tabId, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    const ex = result.exceptionDetails;
    throw new Error(ex.exception?.description ?? ex.text ?? 'Evaluation failed');
  }
  return result.result.value;
}

async function waitForLoad(tabId: number, timeoutMs = 20_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(handler);
      reject(new Error('navigation timed out'));
    }, timeoutMs);
    const handler: Parameters<typeof chrome.tabs.onUpdated.addListener>[0] = (updatedId, info) => {
      if (updatedId === tabId && info.status === 'complete') {
        clearTimeout(t);
        chrome.tabs.onUpdated.removeListener(handler);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(handler);
  });
}

async function handleTool(state: TabState, msg: ToolRequestMessage): Promise<ExtensionToServer> {
  const tabId = state.tabId;
  // Params come over the wire as JSON: each field is unknown until we
  // narrow it. The local helpers below give one-line, type-safe reads
  // for the shapes we accept.
  const p = (msg.params ?? {}) as Record<string, unknown>;
  const str = (key: string): string => (typeof p[key] === 'string' ? p[key] : String(p[key]));
  const optStr = (key: string): string | undefined =>
    typeof p[key] === 'string' ? p[key] : undefined;
  try {
    switch (msg.tool) {
      case 'ping': {
        const tab = await chrome.tabs.get(tabId);
        return {
          kind: 'tool.response',
          id: msg.id,
          ok: true,
          result: { title: tab.title ?? '', url: tab.url ?? '' },
        };
      }

      case 'navigate': {
        const url = str('url');
        const waitForLoadFlag = p.wait_for_load !== false;
        await cdp(tabId, 'Page.navigate', { url });
        if (waitForLoadFlag) await waitForLoad(tabId);
        const tab = await chrome.tabs.get(tabId);
        return {
          kind: 'tool.response',
          id: msg.id,
          ok: true,
          result: { url: tab.url ?? '', title: tab.title ?? '' },
        };
      }

      case 'snapshot': {
        const value = await evaluateInTab(tabId, SNAPSHOT_JS);
        return { kind: 'tool.response', id: msg.id, ok: true, result: value };
      }

      case 'console': {
        const level = optStr('level');
        const entries = level
          ? state.consoleBuffer.filter((e) => e.level === level)
          : state.consoleBuffer;
        return { kind: 'tool.response', id: msg.id, ok: true, result: entries };
      }

      case 'network': {
        const filter = optStr('url_filter')?.toLowerCase();
        const list = state.networkOrder
          .map((id) => state.networkBuffer.get(id))
          .filter((e): e is NetworkEntry => e !== undefined)
          .filter((e) => (filter ? e.url.toLowerCase().includes(filter) : true));
        return { kind: 'tool.response', id: msg.id, ok: true, result: list };
      }

      case 'network_body': {
        const requestId = str('request_id');
        const body = await cdp<CdpNetworkGetResponseBody>(tabId, 'Network.getResponseBody', {
          requestId,
        });
        return { kind: 'tool.response', id: msg.id, ok: true, result: body };
      }

      case 'click': {
        const selector = str('selector');
        const expr = `
          (() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return null;
            el.scrollIntoView({ block: 'center', inline: 'center' });
            const r = el.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2, tag: el.tagName.toLowerCase() };
          })()`;
        const coords = await evaluateInTab<{ x: number; y: number; tag: string } | null>(
          tabId,
          expr,
        );
        if (!coords) {
          return {
            kind: 'tool.response',
            id: msg.id,
            ok: false,
            error: `Element not found: ${selector}`,
          };
        }
        await cdp(tabId, 'Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: coords.x,
          y: coords.y,
        });
        await cdp(tabId, 'Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: coords.x,
          y: coords.y,
          button: 'left',
          clickCount: 1,
        });
        await cdp(tabId, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: coords.x,
          y: coords.y,
          button: 'left',
          clickCount: 1,
        });
        return {
          kind: 'tool.response',
          id: msg.id,
          ok: true,
          result: { clicked: selector, tag: coords.tag },
        };
      }

      case 'type': {
        const selector = str('selector');
        const text = str('text');
        const clear = p.clear === true;
        const focusExpr = `
          (() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return false;
            el.focus();
            ${clear ? "if ('value' in el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }" : ''}
            return true;
          })()`;
        const focused = await evaluateInTab<boolean>(tabId, focusExpr);
        if (!focused) {
          return {
            kind: 'tool.response',
            id: msg.id,
            ok: false,
            error: `Element not found: ${selector}`,
          };
        }
        await cdp(tabId, 'Input.insertText', { text });
        return {
          kind: 'tool.response',
          id: msg.id,
          ok: true,
          result: { typed: text.length, selector },
        };
      }

      case 'drag': {
        const optNum = (key: string): number | undefined => {
          const v = p[key];
          return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
        };
        const clamp = (v: number, max: number): number => Math.min(v, max);
        const fromSelector = optStr('from_selector');
        const toSelector = optStr('to_selector');
        const fromXRaw = optNum('from_x');
        const fromYRaw = optNum('from_y');
        const toXRaw = optNum('to_x');
        const toYRaw = optNum('to_y');
        // Cap every duration that ends up in a setTimeout to keep CodeQL's
        // "user-controlled timer duration" check happy and to prevent a
        // misbehaving agent from parking the bridge for hours on a typo.
        const durationMs = clamp(optNum('duration_ms') ?? 1500, MAX_DRAG_DURATION_MS);
        const holdBeforeMoveMs = clamp(optNum('hold_before_move_ms') ?? 0, MAX_DRAG_HOLD_MS);
        const holdBeforeReleaseMs = clamp(optNum('hold_before_release_ms') ?? 0, MAX_DRAG_HOLD_MS);

        const hasFromCoords = fromXRaw !== undefined && fromYRaw !== undefined;
        const hasToCoords = toXRaw !== undefined && toYRaw !== undefined;
        if (!fromSelector && !hasFromCoords) {
          return {
            kind: 'tool.response',
            id: msg.id,
            ok: false,
            error: 'drag: provide from_selector or both from_x and from_y',
          };
        }
        if (!toSelector && !hasToCoords) {
          return {
            kind: 'tool.response',
            id: msg.id,
            ok: false,
            error: 'drag: provide to_selector or both to_x and to_y',
          };
        }

        const probeExpr = buildDragProbeExpr({
          from_selector: fromSelector,
          to_selector: toSelector,
          from_x: fromXRaw,
          from_y: fromYRaw,
          to_x: toXRaw,
          to_y: toYRaw,
        });
        const probe = await evaluateInTab<{
          err?: string;
          from?: { x: number; y: number; in_viewport: boolean };
          to?: { x: number; y: number; in_viewport: boolean };
          draggable?: boolean;
        }>(tabId, probeExpr);
        if (probe.err) {
          return { kind: 'tool.response', id: msg.id, ok: false, error: `drag: ${probe.err}` };
        }
        if (!probe.from || !probe.to) {
          return {
            kind: 'tool.response',
            id: msg.id,
            ok: false,
            error: 'drag: could not resolve coordinates',
          };
        }
        if (!probe.from.in_viewport) {
          return {
            kind: 'tool.response',
            id: msg.id,
            ok: false,
            error: 'drag: source point is offscreen — scroll first or pass viewport coords',
          };
        }
        if (!probe.to.in_viewport) {
          return {
            kind: 'tool.response',
            id: msg.id,
            ok: false,
            error: 'drag: destination point is offscreen — scroll first or pass viewport coords',
          };
        }

        const fromX = probe.from.x;
        const fromY = probe.from.y;
        const toX = probe.to.x;
        const toY = probe.to.y;
        const isDraggable = !!probe.draggable;

        // ~30fps interpolation; minimum 2 steps so the path actually has a midpoint.
        const steps = durationMs > 0 ? Math.max(2, Math.round(durationMs / 33)) : 1;
        const stepDelayMs = steps > 0 ? durationMs / steps : 0;
        const eventsFired: string[] = [];
        let dragMode: 'html5' | 'pointer' = 'pointer';
        let interceptReceived = false;
        const dragStart = Date.now();
        let interceptionEnabled = false;

        const interpolate = (t: number): { x: number; y: number } => ({
          x: fromX + (toX - fromX) * t,
          y: fromY + (toY - fromY) * t,
        });

        // Mouse move WITH the left button held down. Chrome's HTML5 drag
        // system only treats movement as a drag when the button state is
        // signalled on every move after mousePressed; omitting it makes
        // Blink ignore the move for drag-detection purposes.
        const moveHeld = (x: number, y: number): Promise<unknown> =>
          cdp(tabId, 'Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x,
            y,
            button: 'left',
            buttons: 1,
          });

        // Wiggle distance has to comfortably clear `kDragThreshold` (~5px on
        // Mac, 4px on Linux/Windows). 5px landed *right* at the boundary and
        // Chrome did not start the drag — 20px crosses it on every platform.
        const WIGGLE_PX = 20;
        // Time to wait for Input.dragIntercepted after the wiggle. 120ms was
        // enough on local-only synthetic tests but flaky in real Chrome —
        // 250ms is comfortable without dragging out the overall latency.
        const INTERCEPT_TIMEOUT_MS = 250;

        try {
          if (isDraggable) {
            try {
              await cdp(tabId, 'Input.setInterceptDrags', { enabled: true });
              interceptionEnabled = true;
            } catch {
              // setInterceptDrags is experimental — fall back to pointer mode silently.
            }
          }

          if (interceptionEnabled) {
            // Arm the listener BEFORE the press+wiggle that may trigger it.
            const interceptPromise = waitForCdpEvent<CdpInputDragIntercepted>(
              tabId,
              'Input.dragIntercepted',
              INTERCEPT_TIMEOUT_MS,
            );
            await cdp(tabId, 'Input.dispatchMouseEvent', {
              type: 'mouseMoved',
              x: fromX,
              y: fromY,
            });
            await cdp(tabId, 'Input.dispatchMouseEvent', {
              type: 'mousePressed',
              x: fromX,
              y: fromY,
              button: 'left',
              clickCount: 1,
            });
            if (holdBeforeMoveMs > 0) await sleep(holdBeforeMoveMs);
            // Wiggle toward the destination so Chrome's native drag system
            // crosses its activation threshold. Direction matters for libs
            // that have direction-sensitive activation constraints.
            const dx = toX - fromX;
            const dy = toY - fromY;
            const len = Math.hypot(dx, dy) || 1;
            const wx = fromX + (dx / len) * WIGGLE_PX;
            const wy = fromY + (dy / len) * WIGGLE_PX;
            await moveHeld(wx, wy);

            const intercepted = await interceptPromise;
            if (intercepted) {
              dragMode = 'html5';
              interceptReceived = true;
              eventsFired.push('Input.dragIntercepted');
              const dragData = intercepted.data as Record<string, unknown>;
              for (let i = 1; i <= steps; i++) {
                const t = i / steps;
                const { x, y } = interpolate(t);
                await moveHeld(x, y);
                await cdp(tabId, 'Input.dispatchDragEvent', {
                  type: 'dragOver',
                  x,
                  y,
                  data: dragData,
                });
                if (i === 1) eventsFired.push('dragOver');
                if (stepDelayMs > 0) await sleep(stepDelayMs);
              }
              await cdp(tabId, 'Input.dispatchDragEvent', {
                type: 'dragEnter',
                x: toX,
                y: toY,
                data: dragData,
              });
              eventsFired.push('dragEnter');
              await cdp(tabId, 'Input.dispatchDragEvent', {
                type: 'dragOver',
                x: toX,
                y: toY,
                data: dragData,
              });
              if (holdBeforeReleaseMs > 0) await sleep(holdBeforeReleaseMs);
              await cdp(tabId, 'Input.dispatchDragEvent', {
                type: 'drop',
                x: toX,
                y: toY,
                data: dragData,
              });
              eventsFired.push('drop');
              await cdp(tabId, 'Input.dispatchMouseEvent', {
                type: 'mouseReleased',
                x: toX,
                y: toY,
                button: 'left',
                clickCount: 1,
              });
            } else {
              // Element was tagged draggable but no native drag fired — the page
              // either preventDefault'd dragstart or wires its own pointer logic.
              // Continue with pointer-only events from where we already pressed.
              dragMode = 'pointer';
              for (let i = 1; i <= steps; i++) {
                const t = i / steps;
                const { x, y } = interpolate(t);
                await moveHeld(x, y);
                if (stepDelayMs > 0) await sleep(stepDelayMs);
              }
              if (holdBeforeReleaseMs > 0) await sleep(holdBeforeReleaseMs);
              await cdp(tabId, 'Input.dispatchMouseEvent', {
                type: 'mouseReleased',
                x: toX,
                y: toY,
                button: 'left',
                clickCount: 1,
              });
            }
          } else {
            // Pointer-only branch: no native drag involvement at all.
            dragMode = 'pointer';
            await cdp(tabId, 'Input.dispatchMouseEvent', {
              type: 'mouseMoved',
              x: fromX,
              y: fromY,
            });
            await cdp(tabId, 'Input.dispatchMouseEvent', {
              type: 'mousePressed',
              x: fromX,
              y: fromY,
              button: 'left',
              clickCount: 1,
            });
            if (holdBeforeMoveMs > 0) await sleep(holdBeforeMoveMs);
            for (let i = 1; i <= steps; i++) {
              const t = i / steps;
              const { x, y } = interpolate(t);
              await moveHeld(x, y);
              if (stepDelayMs > 0) await sleep(stepDelayMs);
            }
            if (holdBeforeReleaseMs > 0) await sleep(holdBeforeReleaseMs);
            await cdp(tabId, 'Input.dispatchMouseEvent', {
              type: 'mouseReleased',
              x: toX,
              y: toY,
              button: 'left',
              clickCount: 1,
            });
          }
        } finally {
          // Critical: leaving interception on would block the human user from
          // dragging anything in this tab. Best-effort cleanup, swallow errors.
          if (interceptionEnabled) {
            try {
              await cdp(tabId, 'Input.setInterceptDrags', { enabled: false });
            } catch {
              // ignore
            }
          }
        }

        return {
          kind: 'tool.response',
          id: msg.id,
          ok: true,
          result: {
            from: { x: fromX, y: fromY, selector: fromSelector ?? null },
            to: { x: toX, y: toY, selector: toSelector ?? null },
            duration_ms_actual: Date.now() - dragStart,
            drag_mode: dragMode,
            interception_attempted: interceptionEnabled,
            intercept_received: interceptReceived,
            events_fired: eventsFired,
          },
        };
      }

      case 'evaluate': {
        const expression = str('expression');
        const value = await evaluateInTab(tabId, expression);
        return { kind: 'tool.response', id: msg.id, ok: true, result: value };
      }

      default:
        return { kind: 'tool.response', id: msg.id, ok: false, error: `Unknown tool: ${msg.tool}` };
    }
  } catch (err) {
    return {
      kind: 'tool.response',
      id: msg.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function cleanup(tabId: number): Promise<void> {
  const state = tabStates.get(tabId);
  if (!state) return;
  if (state.ws && state.ws.readyState !== WebSocket.CLOSED) {
    try {
      state.ws.close();
    } catch {
      // Best effort — the resource may already be detached/closed.
    }
  }
  if (state.debuggerAttached) {
    try {
      await chrome.debugger.detach({ tabId });
    } catch {
      // Best effort — the resource may already be detached/closed.
    }
  }
  tabStates.delete(tabId);
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId === undefined) return;
  const state = tabStates.get(source.tabId);
  if (!state?.debuggerListener) return;
  state.debuggerListener(method, params);
});

/**
 * Look up the previous browser-link tab_id this Chrome tab had, if any.
 * Stored in chrome.storage.session (cleared when the browser restarts).
 * Used to ask the primary to keep the same tab_id across primary swaps
 * — a key piece of the v0.4 multi-agent UX so the agent does not see
 * stale tab_ids after a re-election.
 */
async function readPreviousTabId(chromeTabId: number): Promise<string | undefined> {
  const key = `prevTabId:${chromeTabId}`;
  try {
    const data = await chrome.storage.session.get(key);
    const v = data[key];
    return typeof v === 'string' ? v : undefined;
  } catch {
    return undefined;
  }
}

async function storeTabId(chromeTabId: number, serverTabId: string): Promise<void> {
  const key = `prevTabId:${chromeTabId}`;
  try {
    await chrome.storage.session.set({ [key]: serverTabId });
  } catch {
    /* storage failure is non-fatal — worst case the next reconnect gets a fresh id */
  }
}

async function forgetTabId(chromeTabId: number): Promise<void> {
  const key = `prevTabId:${chromeTabId}`;
  try {
    await chrome.storage.session.remove(key);
  } catch {
    /* ignore */
  }
}

async function connectTab(tabId: number): Promise<ConnectResult> {
  if (tabStates.has(tabId)) {
    return { ok: false, error: 'This tab is already connected' };
  }

  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || !tab.title) {
    return { ok: false, error: 'Tab has no URL or title' };
  }

  const previousTabId = await readPreviousTabId(tabId);

  try {
    await chrome.debugger.attach({ tabId }, CDP_VERSION);
  } catch (err) {
    return {
      ok: false,
      error: `Could not attach debugger: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const state: TabState = {
    tabId,
    debuggerAttached: true,
    consoleBuffer: [],
    networkBuffer: new Map(),
    networkOrder: [],
    lastActivityAt: Date.now(),
  };
  tabStates.set(tabId, state);
  attachDebuggerListener(state);

  try {
    await cdp(tabId, 'Page.enable');
    await cdp(tabId, 'Runtime.enable');
    await cdp(tabId, 'Log.enable');
    await cdp(tabId, 'Network.enable');
    await cdp(tabId, 'DOM.enable');
  } catch (err) {
    await cleanup(tabId);
    return {
      ok: false,
      error: `Could not enable CDP: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const ws = new WebSocket(WS_URL);
  state.ws = ws;

  // Capture the fields we'll send over the wire NOW that we've already
  // null-checked them above. This avoids `!` non-null assertions in the
  // event handler closure where TS can't re-prove the narrowing.
  const registerUrl = tab.url;
  const registerTitle = tab.title;

  return new Promise<ConnectResult>((resolve) => {
    let settled = false;
    const settle = (result: ConnectResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    ws.addEventListener('open', () => {
      send(ws, {
        kind: 'tab.register',
        payload: { url: registerUrl, title: registerTitle, previousTabId },
      });
    });

    ws.addEventListener('message', (ev: MessageEvent) => {
      void (async () => {
        const msg = safeParse(typeof ev.data === 'string' ? ev.data : '');
        if (!msg) return;
        if (msg.kind === 'tab.registered') {
          state.serverTabId = msg.payload.tabId;
          // Remember this id so the next reconnect (after a primary swap)
          // asks the new primary to honour it. The primary emits
          // `tab-renamed` in the bridge event log if it can't.
          void storeTabId(tabId, msg.payload.tabId);
          settle({ ok: true, serverTabId: msg.payload.tabId });
          return;
        }
        // ServerToExtension is the union { tab.registered | tool.request },
        // so by elimination this branch handles the tool.request case. Touch
        // the activity timestamp so the WS-idle sweeper keeps this tab warm.
        state.lastActivityAt = Date.now();
        const response = await handleTool(state, msg);
        if (ws.readyState === WebSocket.OPEN) send(ws, response);
      })();
    });

    ws.addEventListener('error', () => {
      void cleanup(tabId).catch(() => {
        // Best effort — already-detached state is fine.
      });
      settle({ ok: false, error: 'WebSocket connection failed. Is the MCP server running?' });
    });

    ws.addEventListener('close', () => {
      void cleanup(tabId).catch(() => {
        // Best effort — already-detached state is fine.
      });
      settle({ ok: false, error: 'WebSocket closed before registration' });
    });
  });
}

async function disconnectTab(tabId: number): Promise<{ ok: boolean }> {
  await cleanup(tabId);
  // Explicit user-driven disconnect → forget the previous tab id so the
  // next "Connect" starts from a clean slate (vs. an involuntary
  // reconnect where we WANT to keep the id for continuity).
  await forgetTabId(tabId);
  return { ok: true };
}

function getTabStatus(tabId: number): StatusResult {
  const state = tabStates.get(tabId);
  if (!state) return { connected: false };
  return { connected: true, serverTabId: state.serverTabId };
}

chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
  if (!isRuntimeMessage(msg)) return false;
  if (msg.action === 'connect') {
    void connectTab(msg.tabId).then(sendResponse);
    return true;
  }
  if (msg.action === 'disconnect') {
    void disconnectTab(msg.tabId).then(sendResponse);
    return true;
  }
  // 'status'
  sendResponse(getTabStatus(msg.tabId));
  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void cleanup(tabId).catch(() => {
    // Best effort.
  });
  // The Chrome tab is gone — drop any cached browser-link id for it.
  void forgetTabId(tabId);
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId === undefined) return;
  const state = tabStates.get(source.tabId);
  if (!state) return;
  state.debuggerAttached = false;
  void cleanup(source.tabId).catch(() => {
    // Best effort.
  });
});

/* WS-idle sweeper.
 *
 * Every WS_IDLE_SWEEP_MS, walk every connected tab. Any tab whose last
 * tool.request landed more than WS_IDLE_TTL_MS ago gets disconnected:
 * the WS closes, the debugger detaches, the popup goes back to "Not
 * connected". The user explicitly re-presses Connect to bring it back.
 *
 * This is the replacement for the parent_death_guard that used to kill
 * the entire MCP server on stdio close — now the server stays alive and
 * the bridge is parked tab-by-tab from the client side. */
setInterval(() => {
  const now = Date.now();
  for (const [tabId, state] of tabStates) {
    if (now - state.lastActivityAt < WS_IDLE_TTL_MS) continue;
    void cleanup(tabId).catch(() => {
      // Best effort.
    });
  }
}, WS_IDLE_SWEEP_MS);
