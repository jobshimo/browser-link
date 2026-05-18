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

interface PendingDialogInfo {
  type: string;
  message: string;
  default_prompt?: string;
  url?: string;
}

interface PendingDialogResult {
  pending: PendingDialogInfo | null;
}

interface VersionCheckResult {
  extension: string;
  server: string | null;
  aligned: boolean | null;
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

function renderVersionBanner(check: VersionCheckResult): void {
  const banner = $('version-banner') as HTMLDivElement;
  // Hide while we have no server version yet (no tab has registered) or
  // when both halves are aligned. The banner is purely informational —
  // the agent flow keeps working either way, this is just a heads-up.
  if (check.server === null || check.aligned !== false) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  $('version-extension').textContent = check.extension;
  $('version-server').textContent = check.server;
}

async function refreshVersionBanner(): Promise<void> {
  const check = await send<VersionCheckResult>({ action: 'versionCheck' });
  renderVersionBanner(check);
}

function renderPendingDialog(pending: PendingDialogInfo | null): void {
  const box = $('dialog-box') as HTMLDivElement;
  if (pending === null) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  $('dialog-type').textContent = pending.type;
  $('dialog-message').textContent = pending.message || '(empty)';
  const promptInput = $('dialog-prompt-input') as HTMLInputElement;
  if (pending.type === 'prompt') {
    promptInput.hidden = false;
    promptInput.value = pending.default_prompt ?? '';
  } else {
    promptInput.hidden = true;
    promptInput.value = '';
  }
}

async function refreshPendingDialog(tabId: number): Promise<void> {
  const result = await send<PendingDialogResult>({ action: 'pendingDialog', tabId });
  renderPendingDialog(result.pending);
}

async function refresh(): Promise<void> {
  // Always refresh the version banner — it has no dependency on the active
  // tab, only on whether ANY tab has registered with the server.
  await refreshVersionBanner();
  const tab = await getCurrentTab();
  const urlEl = $('url');

  if (!tab?.id) {
    setStatus('error', 'No active tab');
    setAction('Open a tab first', 'primary', true);
    urlEl.textContent = '';
    setExplanation(null);
    renderPendingDialog(null);
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
    await refreshPendingDialog(tab.id);
  } else {
    setStatus('idle', 'Not connected');
    setAction('Connect this tab', 'primary');
    renderPendingDialog(null);
  }
}

async function respondToDialog(accept: boolean): Promise<void> {
  const tab = await getCurrentTab();
  if (!tab?.id) return;
  const promptInput = $('dialog-prompt-input') as HTMLInputElement;
  const payload: { action: 'respondDialog'; tabId: number; accept: boolean; promptText?: string } =
    {
      action: 'respondDialog',
      tabId: tab.id,
      accept,
    };
  if (!promptInput.hidden) payload.promptText = promptInput.value;
  await send<{ ok: boolean; error?: string }>(payload);
  await refreshPendingDialog(tab.id);
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

$('dialog-accept').addEventListener('click', () => {
  respondToDialog(true).catch(() => {
    // Best effort — the dialog handler shape includes ok/error so the
    // refresh will re-render either way.
  });
});

$('dialog-dismiss').addEventListener('click', () => {
  respondToDialog(false).catch(() => {
    // Best effort.
  });
});

$('version-open-extensions').addEventListener('click', () => {
  // Open the extension's own card in chrome://extensions. From there
  // the user clicks the circular refresh icon and Chrome re-reads the
  // unpacked dist/. Two clicks total, no programmatic alternative for
  // unpacked extensions (chrome.runtime.reload() only restarts the SW,
  // it does NOT re-read the filesystem).
  void chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
});

// Poll for pending dialogs AND version drift while the popup is open.
// Cheap (one round trip per concern, fast paths return null/aligned) and
// only runs while the popup window is visible — Chrome unloads the popup
// on close.
setInterval(() => {
  void (async () => {
    await refreshVersionBanner();
    const tab = await getCurrentTab();
    if (!tab?.id) return;
    await refreshPendingDialog(tab.id);
  })();
}, 800);

refresh().catch((err: unknown) => {
  setStatus('error', err instanceof Error ? err.message : String(err));
});
