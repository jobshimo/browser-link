import type {
  ExtensionToServer,
  ServerToExtension,
  ToolRequestMessage,
} from '@browser-link/shared';

const WS_URL = 'ws://127.0.0.1:17529';
const CDP_VERSION = '1.3';
const CONSOLE_BUFFER_MAX = 200;
const NETWORK_BUFFER_MAX = 200;

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
        // so by elimination this branch handles the tool.request case.
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
