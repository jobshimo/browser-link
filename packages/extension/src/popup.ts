// idle-policy.ts IS shared with popup.ts (unlike the runtime-message shapes
// mirrored below) — both entrypoints compile to sibling files under dist/,
// so a plain relative import works the same way background.ts already
// imports settle.js/keymap.js.
import {
  IDLE_TTL_STORAGE_KEY,
  IDLE_TTL_UPDATED_AT_STORAGE_KEY,
  clampIdleTtlMinutes,
} from './idle-policy.js';
import {
  FLOW_RECORDING_STORAGE_KEY,
  FLOW_RECORDING_UPDATED_AT_STORAGE_KEY,
  normalizeFlowRecordingEnabled,
} from './flow-recording-policy.js';
import { describeFlowStep } from './recording.js';
import { CONNECT_IN_PROGRESS_ERROR } from './reconnect-policy.js';
import type { FlowStep } from './flow.js';

// Local mirrors of the runtime message return shapes that background.ts
// produces. Kept in sync by hand because there's no shared workspace
// dep between the two extension entrypoints today — and these types
// are tiny.
interface ConnectResult {
  ok: boolean;
  error?: string;
  serverTabId?: string;
}

interface RecordingActionResult {
  ok: boolean;
  error?: string;
}

interface StopRecordingResult {
  ok: boolean;
  steps?: FlowStep[];
  capped?: boolean;
  error?: string;
}

interface RecordingStatusResult {
  active: boolean;
  reviewing: boolean;
  stepCount: number;
  capped: boolean;
  steps?: FlowStep[];
  /** 0-based indices of steps whose recorded selector may match multiple
   * elements (see background.ts's RecordingState.ambiguousStepIndices) —
   * the review list flags each with a caution so the safety signal is
   * surfaced, not silently dropped. */
  ambiguousStepIndices?: number[];
}

interface StatusResult {
  connected: boolean;
  serverTabId?: string;
  /** True while background.ts's auto-reconnect scheduler has a retry
   * pending for this tab (involuntary WS drop, e.g. primary restart). */
  reconnecting?: boolean;
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

/** Card label shown while background.ts's auto-reconnect scheduler is
 * retrying a dropped tab. Doubles as the sentinel `syncReconnectCard`
 * matches on, so the poll only ever rewrites the card into or out of THIS
 * state and can never clobber onAction's transient "Connecting…"/
 * "Disconnecting…" labels. */
const RECONNECTING_LABEL = 'Reconnecting…';

/**
 * Keep the connection card truthful across reconnect transitions while the
 * popup stays open. The 800ms poll deliberately does not re-render the
 * whole card (that would fight onAction's transient states) — this only
 * flips the card INTO "Reconnecting…" from the steady idle/connected
 * states, and OUT of it once the cycle ends (Connected on success, Not
 * connected on exhaustion). Everything else is left alone.
 */
function syncReconnectCard(status: StatusResult): void {
  const showingReconnect = $('status-label').textContent === RECONNECTING_LABEL;
  const shouldShowReconnect = !status.connected && status.reconnecting === true;
  if (shouldShowReconnect === showingReconnect) return;
  if (shouldShowReconnect) {
    // Only take over the steady states — a transient onAction label means
    // a user-driven round-trip is mid-flight and owns the card.
    const cardState = $('card').dataset.state;
    if (cardState !== 'idle' && cardState !== 'connected') return;
    setStatus('connecting', RECONNECTING_LABEL);
    setAction('Connect this tab', 'primary');
    return;
  }
  if (status.connected) {
    setStatus('connected', 'Connected', status.serverTabId);
    setAction('Disconnect this tab', 'danger');
  } else {
    setStatus('idle', 'Not connected');
    setAction('Connect this tab', 'primary');
  }
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

/**
 * Flow-recording opt-in toggle. Reads/writes `chrome.storage.local`
 * directly, same pattern as `refreshIdleTtlSetting`/`onIdleTtlChange` —
 * background.ts independently reacts to the same key via
 * `chrome.storage.onChanged`.
 */
async function refreshFlowRecordingToggle(): Promise<void> {
  const checkbox = $('flow-recording-toggle') as HTMLInputElement;
  // Same "don't yank a live edit" guard idle-ttl's select uses.
  if (document.activeElement === checkbox) return;
  const data = await chrome.storage.local.get(FLOW_RECORDING_STORAGE_KEY);
  checkbox.checked = normalizeFlowRecordingEnabled(data[FLOW_RECORDING_STORAGE_KEY]);
}

async function onFlowRecordingToggleChange(): Promise<void> {
  const checkbox = $('flow-recording-toggle') as HTMLInputElement;
  await chrome.storage.local.set({
    [FLOW_RECORDING_STORAGE_KEY]: checkbox.checked,
    [FLOW_RECORDING_UPDATED_AT_STORAGE_KEY]: Date.now(),
  });
  // Turning the toggle off mid-recording is handled entirely on the
  // background.ts side (chrome.storage.onChanged force-stops + discards) —
  // this just re-renders the popup's own controls to match.
  const tab = await getCurrentTab();
  if (!tab?.id) return;
  const status = await send<StatusResult>({ action: 'status', tabId: tab.id });
  await refreshRecordingUi(tab.id, status.connected);
}

/** Render the step-review panel: count (with a cap notice when the 20-step
 * limit auto-stopped the recording), one line per step via the SAME
 * `describeFlowStep` background.ts's `recording.ts` module exports — the
 * popup never re-derives its own description logic. Steps whose selector
 * was flagged ambiguous get an inline "may match multiple elements"
 * caution appended, so the computed safety signal is surfaced to the user
 * before they save (it also travels into the saved recipe's description —
 * see background.ts's saveRecording). Does not touch the name input, so
 * repeated calls (the 800ms poll) never interrupt typing. */
function renderRecordingReview(
  steps: FlowStep[],
  capped: boolean,
  ambiguousIndices: number[],
): void {
  $('recording-review').hidden = false;
  const capNotice = capped ? ' — stopped: 20-step limit reached' : '';
  $('recording-step-count').textContent = `${steps.length}${capNotice}`;
  const ambiguous = new Set(ambiguousIndices);
  const list = $('recording-step-list');
  list.innerHTML = '';
  steps.forEach((step, i) => {
    const li = document.createElement('li');
    li.textContent = describeFlowStep(step);
    if (ambiguous.has(i)) {
      const warn = document.createElement('span');
      warn.textContent = ' ⚠ selector may match multiple elements';
      warn.style.color = 'var(--idle-fg)';
      li.appendChild(warn);
    }
    list.appendChild(li);
  });
}

function setRecordingError(message: string | null): void {
  const el = $('recording-error');
  if (message === null) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.textContent = message;
}

/**
 * Show/hide and populate the Record/Stop/review controls for `tabId`.
 * Hidden entirely unless flow recording is enabled AND the tab is
 * connected — "ALL recording UI is hidden ... when disabled" from the
 * privacy contract is enforced right here, not just by the recorder never
 * being injected.
 */
async function refreshRecordingUi(tabId: number, connected: boolean): Promise<void> {
  const recordingRow = $('recording-row');
  const data = await chrome.storage.local.get(FLOW_RECORDING_STORAGE_KEY);
  const enabled = normalizeFlowRecordingEnabled(data[FLOW_RECORDING_STORAGE_KEY]);

  if (!enabled || !connected) {
    recordingRow.hidden = true;
    $('recording-review').hidden = true;
    return;
  }

  const status = await send<RecordingStatusResult>({ action: 'recordingStatus', tabId });
  recordingRow.hidden = false;
  const indicator = $('recording-indicator');
  const actionBtn = $('recording-action') as HTMLButtonElement;

  if (status.reviewing) {
    indicator.hidden = true;
    actionBtn.hidden = true;
    renderRecordingReview(status.steps ?? [], status.capped, status.ambiguousStepIndices ?? []);
    return;
  }

  actionBtn.hidden = false;
  $('recording-review').hidden = true;
  if (status.active) {
    indicator.hidden = false;
    actionBtn.textContent = 'Stop';
    actionBtn.className = 'danger';
  } else {
    indicator.hidden = true;
    actionBtn.textContent = 'Record';
    actionBtn.className = 'primary';
  }
}

async function onRecordingAction(): Promise<void> {
  const tab = await getCurrentTab();
  if (!tab?.id) return;
  setRecordingError(null);
  const status = await send<RecordingStatusResult>({ action: 'recordingStatus', tabId: tab.id });
  if (status.active) {
    const result = await send<StopRecordingResult>({ action: 'stopRecording', tabId: tab.id });
    if (!result.ok) setRecordingError(result.error ?? 'Could not stop recording.');
  } else {
    const result = await send<RecordingActionResult>({ action: 'startRecording', tabId: tab.id });
    if (!result.ok) setRecordingError(result.error ?? 'Could not start recording.');
  }
  await refreshRecordingUi(tab.id, true);
}

async function onSaveRecording(): Promise<void> {
  const tab = await getCurrentTab();
  if (!tab?.id) return;
  const nameInput = $('recording-name-input') as HTMLInputElement;
  const saveBtn = $('recording-save') as HTMLButtonElement;
  setRecordingError(null);
  saveBtn.disabled = true;
  try {
    const result = await send<RecordingActionResult>({
      action: 'saveRecording',
      tabId: tab.id,
      name: nameInput.value,
    });
    if (!result.ok) {
      setRecordingError(result.error ?? 'Could not save the flow.');
      return;
    }
    nameInput.value = '';
    await refreshRecordingUi(tab.id, true);
  } finally {
    saveBtn.disabled = false;
  }
}

async function onDiscardRecording(): Promise<void> {
  const tab = await getCurrentTab();
  if (!tab?.id) return;
  await send<{ ok: boolean }>({ action: 'discardRecording', tabId: tab.id });
  ($('recording-name-input') as HTMLInputElement).value = '';
  setRecordingError(null);
  await refreshRecordingUi(tab.id, true);
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
    $('recording-row').hidden = true;
    $('recording-review').hidden = true;
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
  } else if (status.reconnecting) {
    // Auto-reconnect is retrying after an involuntary drop (e.g. the
    // primary restarted) — show the truthful in-between state. Connect
    // stays available: pressing it cancels any FUTURE retries, and if an
    // attempt is already mid-flight the background's per-tab lock answers
    // with a benign already-in-progress result that keeps this same card.
    setStatus('connecting', RECONNECTING_LABEL);
    setAction('Connect this tab', 'primary');
    renderPendingDialog(null);
  } else {
    setStatus('idle', 'Not connected');
    setAction('Connect this tab', 'primary');
    renderPendingDialog(null);
  }
  await refreshRecordingUi(tab.id, status.connected);
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
      if (result.error === CONNECT_IN_PROGRESS_ERROR) {
        // Lost the per-tab race against an attempt already mid-flight —
        // benign: that attempt is doing exactly what the click asked for.
        // Show the reconnect card; the 800ms poll flips it to Connected
        // (or Not connected) once the in-flight attempt lands.
        setStatus('connecting', RECONNECTING_LABEL);
        setAction('Connect this tab', 'primary');
        return;
      }
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

$('flow-recording-toggle').addEventListener('change', () => {
  onFlowRecordingToggleChange().catch(() => {
    // Best effort — the next poll tick re-syncs the checkbox.
  });
});

$('recording-action').addEventListener('click', () => {
  onRecordingAction().catch((err: unknown) => {
    setRecordingError(err instanceof Error ? err.message : String(err));
  });
});

$('recording-save').addEventListener('click', () => {
  onSaveRecording().catch((err: unknown) => {
    setRecordingError(err instanceof Error ? err.message : String(err));
  });
});

$('recording-discard').addEventListener('click', () => {
  onDiscardRecording().catch(() => {
    // Best effort.
  });
});

// Poll for pending dialogs, version drift, the idle-ttl setting, AND the
// flow-recording setting/status while the popup is open. Cheap (one round
// trip per concern, fast paths return null/aligned/unchanged) and only
// runs while the popup window is visible — Chrome unloads the popup on
// close. The recording poll is what surfaces a background.ts-side
// auto-stop (the 20-step cap) without the user having to reopen the popup.
setInterval(() => {
  void (async () => {
    await refreshVersionBanner();
    await refreshIdleTtlSetting();
    await refreshFlowRecordingToggle();
    const tab = await getCurrentTab();
    if (!tab?.id) return;
    await refreshPendingDialog(tab.id);
    const status = await send<StatusResult>({ action: 'status', tabId: tab.id });
    syncReconnectCard(status);
    await refreshRecordingUi(tab.id, status.connected);
  })();
}, 800);

refresh().catch((err: unknown) => {
  setStatus('error', err instanceof Error ? err.message : String(err));
});
refreshIdleTtlSetting().catch(() => {
  // Best effort — the periodic timer above retries every 800ms regardless.
});
refreshFlowRecordingToggle().catch(() => {
  // Best effort — same rationale as refreshIdleTtlSetting above.
});
