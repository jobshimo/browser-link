/**
 * The Admin window.
 *
 * A dedicated extension page rather than a collapsible section of the popup:
 * the popup closes the moment it loses focus and is 320px wide, which made a
 * form of server settings awkward to read and easy to lose mid-change. Opened
 * by background.ts's `openAdminWindow` from the popup's Admin button.
 *
 * Everything shown here comes from the server (AdminState via background.ts's
 * `adminDescribe`, over any connected tab's socket); admin-view.ts turns it
 * into rows and owns the confirm flow, so this file is only DOM wiring. Text
 * always goes in through textContent: labels arrive off a socket.
 *
 * Language: the window follows the interface language (header selector,
 * ui-language.ts) and sends it with every request, so the server renders the
 * rows, previews and errors in it. A server older than 0.51.0 ignores the
 * field and answers in its own configured language.
 */
import type {
  AdminActionResult,
  AdminActionResultMessage,
  AdminStateMessage,
  AdminUiStrings,
} from '@browser-link/shared';
import {
  adminUi,
  fallbackAdminUi,
  buildAdminRows,
  describeAdminError,
  initialConfirmState,
  reduceConfirm,
  type AdminRequest,
  type AdminRow,
  type ConfirmState,
} from './admin-view.js';
import { startUiLanguage } from './ui-language.js';

const lang = await startUiLanguage();

// chrome.runtime.sendMessage returns `Promise<any>`; re-bind through
// `unknown` so the final `as T` is an explicit, auditable narrowing.
async function send<T>(payload: unknown): Promise<T> {
  const raw: unknown = await chrome.runtime.sendMessage(payload);
  return raw as T;
}

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Element not found: ${id}`);
  return el;
}

let adminConfirm: ConfirmState = initialConfirmState();
let adminStrings: AdminUiStrings = fallbackAdminUi(lang.language);
let adminBusy = false;

function renderAdminEmpty(message: string): void {
  const body = $('admin-body');
  body.replaceChildren();
  const empty = document.createElement('div');
  empty.className = 'admin-note';
  empty.textContent = message;
  body.appendChild(empty);
}

function adminControlFor(row: AdminRow): HTMLElement {
  switch (row.control) {
    case 'toggle': {
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = row.checked === true;
      input.disabled = row.disabled === true || adminBusy;
      input.setAttribute('aria-label', row.label);
      input.addEventListener('change', () => {
        void runAdminAction({ id: row.itemId, value: input.checked });
      });
      return input;
    }
    case 'select': {
      const select = document.createElement('select');
      select.setAttribute('aria-label', row.label);
      for (const option of row.options ?? []) {
        const el = document.createElement('option');
        el.value = option.value;
        el.textContent = option.label;
        select.appendChild(el);
      }
      select.value = row.selected ?? '';
      select.disabled = row.disabled === true || adminBusy;
      select.addEventListener('change', () => {
        void runAdminAction({ id: row.itemId, value: select.value });
      });
      return select;
    }
    case 'button': {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = row.label;
      button.disabled = row.disabled === true || adminBusy;
      button.addEventListener('click', () => {
        void runAdminAction({ id: row.itemId });
      });
      return button;
    }
    case 'link': {
      // admin-view.ts only sets `control: 'link'` for an http(s) URL.
      const link = document.createElement('a');
      link.href = row.href ?? '';
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.className = 'admin-row-value';
      link.textContent = row.valueText;
      return link;
    }
    default: {
      const value = document.createElement('span');
      value.className = 'admin-row-value';
      value.textContent = row.valueText;
      return value;
    }
  }
}

function renderAdminRows(rows: AdminRow[]): void {
  const body = $('admin-body');
  body.replaceChildren();
  let section: string | null = null;
  for (const row of rows) {
    if (row.sectionId !== section) {
      section = row.sectionId;
      const title = document.createElement('div');
      title.className = 'flows-title admin-section-title';
      title.textContent = row.sectionTitle;
      body.appendChild(title);
    }
    const line = document.createElement('div');
    line.className = 'admin-row';
    // A button's label is its own text; every other kind gets a label span.
    if (row.control !== 'button') {
      const label = document.createElement('span');
      label.className = 'admin-row-label';
      label.textContent = row.label;
      line.appendChild(label);
    }
    line.appendChild(adminControlFor(row));
    body.appendChild(line);
    // Description, console hint and restart flag stay visible under the row
    // rather than in a tooltip: hover discovery hides what a setting does.
    const notes = [
      row.description,
      row.hint,
      row.requiresRestart === true ? adminStrings.restartRequired : undefined,
    ].filter((note): note is string => typeof note === 'string' && note !== '');
    for (const note of notes) {
      const el = document.createElement('div');
      el.className = 'admin-note';
      el.textContent = note;
      body.appendChild(el);
    }
  }
}

function renderAdminConfirm(): void {
  const confirmBox = $('admin-confirm');
  const status = $('admin-status');
  const output = $('admin-output');
  confirmBox.hidden = adminConfirm.phase !== 'confirming';
  status.hidden = true;
  output.hidden = true;
  if (adminConfirm.phase === 'confirming') {
    $('admin-confirm-preview').textContent = adminConfirm.preview;
    $('admin-confirm-yes').textContent = adminStrings.confirm;
    $('admin-confirm-no').textContent = adminStrings.cancel;
  } else if (adminConfirm.phase === 'applied' || adminConfirm.phase === 'error') {
    status.hidden = false;
    status.dataset.kind = adminConfirm.phase;
    status.textContent = adminConfirm.message;
    if (adminConfirm.phase === 'applied' && adminConfirm.output) {
      output.hidden = false;
      output.textContent = adminConfirm.output.join('\n');
    }
  }
}

/** Describe the server and render it. Called when the window loads and after
 * every action that is not waiting for a confirmation. */
async function refreshAdmin(): Promise<void> {
  let reply: AdminStateMessage | undefined;
  try {
    reply = await send<AdminStateMessage | undefined>({
      action: 'adminDescribe',
      language: lang.language,
    });
  } catch {
    // Service worker asleep or mid-restart: same empty state as no socket.
    renderAdminEmpty(adminStrings.notConnected);
    return;
  }
  if (!reply) {
    renderAdminEmpty(adminStrings.notConnected);
    return;
  }
  if (!reply.ok) {
    renderAdminEmpty(describeAdminError(reply.error, adminStrings, lang.t));
    return;
  }
  adminStrings = adminUi(reply.state, lang.language);
  renderAdminRows(buildAdminRows(reply.state, lang.t));
  renderAdminConfirm();
}

async function runAdminAction(request: AdminRequest): Promise<void> {
  if (adminBusy) return;
  adminBusy = true;
  const status = $('admin-status');
  status.hidden = false;
  status.dataset.kind = 'busy';
  status.textContent = '…';
  $('admin-confirm').hidden = true;
  $('admin-output').hidden = true;
  let result: AdminActionResult;
  try {
    const reply = await send<AdminActionResultMessage | undefined>({
      action: 'adminAction',
      ...request,
      language: lang.language,
    });
    result = reply?.result ?? { ok: false, error: 'not-connected' };
  } catch (err) {
    result = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  adminBusy = false;
  adminConfirm = reduceConfirm(adminConfirm, {
    type: 'result',
    request,
    result,
    ui: adminStrings,
    t: lang.t,
  });
  renderAdminConfirm();
  // A confirming toggle or select already shows the new value; leave it until
  // the human decides. Every other outcome re-describes, so an applied change
  // shows the server's new truth and a failed one snaps the control back.
  if (adminConfirm.phase !== 'confirming') await refreshAdmin();
}

document.getElementById('admin-confirm-yes')?.addEventListener('click', () => {
  if (adminConfirm.phase !== 'confirming') return;
  void runAdminAction(adminConfirm.pendingRequest);
});

document.getElementById('admin-confirm-no')?.addEventListener('click', () => {
  adminConfirm = reduceConfirm(adminConfirm, { type: 'cancel' });
  renderAdminConfirm();
  void refreshAdmin();
});

// A switch asks the server again, in the new language: the rows are the
// server's text. Until it answers, the fallback words are in that language too.
lang.onChange(() => {
  adminStrings = fallbackAdminUi(lang.language);
  refreshAdmin().catch(() => {
    renderAdminEmpty(adminStrings.notConnected);
  });
});

refreshAdmin().catch(() => {
  renderAdminEmpty(adminStrings.notConnected);
});
