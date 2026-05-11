interface StatusResult {
  connected: boolean;
  serverTabId?: string;
}

interface ConnectResult {
  ok: boolean;
  error?: string;
  serverTabId?: string;
}

async function getCurrentTab(): Promise<chrome.tabs.Tab | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ?? null;
}

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Element not found: ${id}`);
  return el;
}

async function refresh(): Promise<void> {
  const tab = await getCurrentTab();
  const statusEl = $('status');
  const urlEl = $('url');
  const actionBtn = $('action') as HTMLButtonElement;

  if (!tab?.id) {
    statusEl.className = 'status error';
    statusEl.textContent = 'No hay pestaña activa';
    actionBtn.disabled = true;
    return;
  }

  urlEl.textContent = tab.url ?? '';

  const status = (await chrome.runtime.sendMessage({
    action: 'status',
    tabId: tab.id,
  })) as StatusResult;

  actionBtn.disabled = false;

  if (status.connected) {
    statusEl.className = 'status connected';
    statusEl.innerHTML = `Conectada · <span class="tab-id">${status.serverTabId ?? '…'}</span>`;
    actionBtn.textContent = 'Desconectar';
    actionBtn.className = 'danger';
  } else {
    statusEl.className = 'status disconnected';
    statusEl.textContent = 'No conectada';
    actionBtn.textContent = 'Conectar';
    actionBtn.className = 'primary';
  }
}

async function onAction(): Promise<void> {
  const tab = await getCurrentTab();
  if (!tab?.id) return;

  const actionBtn = $('action') as HTMLButtonElement;
  const statusEl = $('status');
  actionBtn.disabled = true;

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
      statusEl.className = 'status error';
      statusEl.textContent = result.error ?? 'Error desconocido';
      actionBtn.disabled = false;
      return;
    }
  }

  await refresh();
}

$('action').addEventListener('click', () => {
  onAction().catch((err) => {
    const statusEl = $('status');
    statusEl.className = 'status error';
    statusEl.textContent = err instanceof Error ? err.message : String(err);
  });
});

refresh().catch(() => {});
