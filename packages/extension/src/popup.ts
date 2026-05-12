interface StatusResult {
  connected: boolean;
  serverTabId?: string;
}

interface ConnectResult {
  ok: boolean;
  error?: string;
  serverTabId?: string;
}

type CardState = 'connected' | 'idle' | 'error';

async function getCurrentTab(): Promise<chrome.tabs.Tab | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ?? null;
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
    return;
  }

  urlEl.textContent = tab.url ?? '';

  const status = (await chrome.runtime.sendMessage({
    action: 'status',
    tabId: tab.id,
  })) as StatusResult;

  if (status.connected) {
    setStatus('connected', 'Connected', status.serverTabId);
    setAction('Disconnect', 'danger');
  } else {
    setStatus('idle', 'Not connected');
    setAction('Connect', 'primary');
  }
}

async function onAction(): Promise<void> {
  const tab = await getCurrentTab();
  if (!tab?.id) return;

  setAction('Working…', 'primary', true);

  const status = (await chrome.runtime.sendMessage({
    action: 'status',
    tabId: tab.id,
  })) as StatusResult;

  if (status.connected) {
    await chrome.runtime.sendMessage({ action: 'disconnect', tabId: tab.id });
  } else {
    const result = (await chrome.runtime.sendMessage({
      action: 'connect',
      tabId: tab.id,
    })) as ConnectResult;

    if (!result.ok) {
      setStatus('error', result.error ?? 'Unknown error');
      setAction('Retry', 'primary');
      return;
    }
  }

  await refresh();
}

$('action').addEventListener('click', () => {
  onAction().catch((err) => {
    setStatus('error', err instanceof Error ? err.message : String(err));
    setAction('Retry', 'primary');
  });
});

refresh().catch((err) => {
  setStatus('error', err instanceof Error ? err.message : String(err));
});
