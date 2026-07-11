// idle-policy.ts IS shared with popup.ts (unlike the runtime-message shapes
// mirrored below) — both entrypoints compile to sibling files under dist/,
// so a plain relative import works the same way background.ts already
// imports settle.js/keymap.js.
import {
  IDLE_TTL_STORAGE_KEY,
  IDLE_TTL_UPDATED_AT_STORAGE_KEY,
  clampIdleTtlMinutes,
} from './idle-policy.js';

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

/**
 * Idle-disconnect TTL control. Reads/writes `chrome.storage.local`
 * directly — no round trip through background.ts's runtime-message
 * protocol is needed, since the popup already holds the "storage"
 * permission and background.ts independently reacts to the same key via
 * `chrome.storage.onChanged` (see background.ts's `idleTtlMinutesCache`).
 *
 * Refreshed on the same periodic timer as the version banner / pending
 * dialog (see the `setInterval` near the bottom of this file), so a value
 * pushed by the server (`browser-link config set idle-ttl` while this
 * popup happens to be open) shows up within one tick instead of only on
 * the next popup open.
 */
/** DOM id of the synthetic <option> injected for out-of-preset values. */
const IDLE_TTL_CUSTOM_OPTION_ID = 'idle-ttl-custom';

/**
 * Make sure the select can actually DISPLAY `minutes`. The popup only
 * ships a curated preset list (5/15/30/60/120/Never), but the CLI accepts
 * any 1-1440 — so `browser-link config set idle-ttl 45` is a perfectly
 * valid effective value with no matching <option>, which would otherwise
 * leave the control rendering BLANK (selectedIndex -1) while the policy
 * correctly enforces 45. Inject a synthetic "45 min (custom)" option in
 * that case (kept just before "Never" so the preset order stays intact),
 * and remove it again once the effective value is back on a preset.
 */
function ensureIdleTtlOption(select: HTMLSelectElement, minutes: number): void {
  const value = String(minutes);
  const custom = document.getElementById(IDLE_TTL_CUSTOM_OPTION_ID) as HTMLOptionElement | null;
  const hasPreset = Array.from(select.options).some(
    (opt) => opt.id !== IDLE_TTL_CUSTOM_OPTION_ID && opt.value === value,
  );
  if (hasPreset) {
    custom?.remove();
    return;
  }
  const option = custom ?? document.createElement('option');
  option.id = IDLE_TTL_CUSTOM_OPTION_ID;
  option.value = value;
  option.textContent = `${minutes} min (custom)`;
  if (!custom) {
    const neverOption = Array.from(select.options).find((opt) => opt.value === '0') ?? null;
    select.insertBefore(option, neverOption);
  }
}

async function refreshIdleTtlSetting(): Promise<void> {
  const select = $('idle-ttl-select') as HTMLSelectElement;
  // Never clobber a selection while the user has the dropdown focused —
  // an incoming settings.update mid-edit should not yank the control out
  // from under them.
  if (document.activeElement === select) return;
  const data = await chrome.storage.local.get(IDLE_TTL_STORAGE_KEY);
  const minutes = clampIdleTtlMinutes(data[IDLE_TTL_STORAGE_KEY]);
  ensureIdleTtlOption(select, minutes);
  select.value = String(minutes);
}

async function onIdleTtlChange(): Promise<void> {
  const select = $('idle-ttl-select') as HTMLSelectElement;
  const minutes = clampIdleTtlMinutes(Number(select.value));
  // Reflect the clamped value back into the control immediately in case
  // Number(select.value) ever disagreed with it (it won't, in practice —
  // every <option> is a safe preset or a clamped CLI value the synthetic
  // custom entry mirrors — but this keeps the displayed value truthful to
  // what was actually persisted).
  select.value = String(minutes);
  await chrome.storage.local.set({
    [IDLE_TTL_STORAGE_KEY]: minutes,
    [IDLE_TTL_UPDATED_AT_STORAGE_KEY]: Date.now(),
  });
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

$('idle-ttl-select').addEventListener('change', () => {
  onIdleTtlChange().catch(() => {
    // Best effort — the next refreshIdleTtlSetting tick re-syncs the
    // control to whatever actually made it into storage.
  });
});

// Poll for pending dialogs, version drift, AND the idle-ttl setting while
// the popup is open. Cheap (one round trip per concern, fast paths return
// null/aligned/unchanged) and only runs while the popup window is visible
// — Chrome unloads the popup on close.
setInterval(() => {
  void (async () => {
    await refreshVersionBanner();
    await refreshIdleTtlSetting();
    const tab = await getCurrentTab();
    if (!tab?.id) return;
    await refreshPendingDialog(tab.id);
  })();
}, 800);

refresh().catch((err: unknown) => {
  setStatus('error', err instanceof Error ? err.message : String(err));
});
refreshIdleTtlSetting().catch(() => {
  // Best effort — the periodic timer above retries every 800ms regardless.
});
