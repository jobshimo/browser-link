// Local mirrors of the runtime message return shapes that background.ts
// produces. Kept in sync by hand because there's no shared workspace
// dep between the two extension entrypoints today — and these types
// are tiny.
interface ConnectResult {
  ok: boolean;
  error?: string;
  serverTabId?: string;
}

interface StatusResult {
  connected: boolean;
  serverTabId?: string;
}

// 'connecting' is a transient client-side state while a connect/disconnect
// round-trip is in flight; 'portCollision' is reserved for a future
// background message that distinguishes "server unreachable, just retry"
// from "another browser-link is already holding 127.0.0.1:17529". The
// CSS already styles both — keeping the type ready avoids a refactor
// when the message surface grows.
type CardState = 'idle' | 'connecting' | 'connected' | 'error' | 'portCollision';

async function getCurrentTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// chrome.runtime.sendMessage returns `Promise<any>` in the @types/chrome
// surface — wrap it so each caller declares the expected result shape
// once and keeps that type info downstream. The local `: unknown`
// re-binding strips the inbound `any` so the final `as T` is a real,
// auditable narrowing.
async function send<T>(payload: unknown): Promise<T> {
  const raw: unknown = await chrome.runtime.sendMessage(payload);
  return raw as T;
}

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Element not found: ${id}`);
  return el;
}

function setCardState(state: CardState): void {
  $('card').dataset.state = state;
}

function setStatus(state: CardState, label: string, tabId?: string): void {
  setCardState(state);
  $('status-label').textContent = label;
  const tabIdEl = $('tab-id');
  if (tabId) {
    tabIdEl.textContent = tabId;
    tabIdEl.hidden = false;
  } else {
    tabIdEl.hidden = true;
    tabIdEl.textContent = '';
  }
}

// Optional explanation row, shown under the URL on portCollision (and
// reserved for any future state that wants to teach the user what to do
// next inside the popup). Pass null to hide.
function setExplanation(html: string | null): void {
  const el = $('explanation');
  if (html === null) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  el.hidden = false;
  el.innerHTML = html;
}

function setAction(label: string, variant: 'primary' | 'danger', disabled = false): void {
  const btn = $('action') as HTMLButtonElement;
  btn.textContent = label;
  btn.className = variant;
  btn.disabled = disabled;
}

async function refresh(): Promise<void> {
  const tab = await getCurrentTab();
  const urlEl = $('url');

  if (!tab?.id) {
    setStatus('error', 'No active tab');
    setAction('Open a tab first', 'primary', true);
    urlEl.textContent = '';
    setExplanation(null);
    return;
  }

  urlEl.textContent = tab.url ?? '';
  setExplanation(null);

  const status = await send<StatusResult>({
    action: 'status',
    tabId: tab.id,
  });

  if (status.connected) {
    setStatus('connected', 'Connected', status.serverTabId);
    setAction('Disconnect this tab', 'danger');
  } else {
    setStatus('idle', 'Not connected');
    setAction('Connect this tab', 'primary');
  }
}

async function onAction(): Promise<void> {
  const tab = await getCurrentTab();
  if (!tab?.id) return;

  const status = await send<StatusResult>({
    action: 'status',
    tabId: tab.id,
  });

  // Transient "connecting" state — the card flips to the blue palette so
  // the user sees something is happening even if the round-trip to the
  // server takes a beat.
  setStatus('connecting', status.connected ? 'Disconnecting…' : 'Connecting…');
  setAction(status.connected ? 'Disconnecting…' : 'Connecting…', 'primary', true);

  if (status.connected) {
    await send<{ ok: boolean }>({ action: 'disconnect', tabId: tab.id });
  } else {
    const result = await send<ConnectResult>({
      action: 'connect',
      tabId: tab.id,
    });

    if (!result.ok) {
      setStatus('error', result.error ?? 'Unknown error');
      setAction('Retry', 'primary');
      return;
    }
  }

  await refresh();
}

$('action').addEventListener('click', () => {
  onAction().catch((err: unknown) => {
    setStatus('error', err instanceof Error ? err.message : String(err));
    setAction('Retry', 'primary');
  });
});

refresh().catch((err: unknown) => {
  setStatus('error', err instanceof Error ? err.message : String(err));
});
