/**
 * Render model for the Admin window.
 *
 * The server describes its administration state and actions as data, with
 * every label already localised (`AdminState`). This module turns that data
 * into flat view rows the popup can render without knowing what any item
 * means, and owns the confirm flow for disk-writing actions as a tiny state
 * machine. Pure: no DOM, no chrome.* — so it is tested, unlike popup.ts.
 */
import type {
  AdminActionResult,
  AdminItem,
  AdminItemKind,
  AdminOption,
  AdminSection,
  AdminState,
  AdminUiStrings,
} from '@browser-link/shared';
import { messages, type Language, type Messages } from './i18n.js';

/** Used when the server sent no `ui` block, or when no server answered at all
 * (no tab connected), so the window still has words to show, in the
 * interface language. */
export function fallbackAdminUi(language: Language): AdminUiStrings {
  const t = messages(language);
  return {
    language,
    confirm: t.adminConfirm,
    cancel: t.cancel,
    apply: t.adminApply,
    notConnected: t.adminNotConnected,
    restartRequired: t.adminRestartRequired,
    changed: t.adminChanged,
  };
}

export type AdminControl = 'none' | 'toggle' | 'select' | 'button' | 'link';

export interface AdminRow {
  sectionId: AdminSection['id'];
  sectionTitle: string;
  itemId: string;
  kind: AdminItemKind;
  label: string;
  description?: string;
  /** Human-readable current value; empty for buttons. */
  valueText: string;
  control: AdminControl;
  /** Toggle only: the current state. */
  checked?: boolean;
  /** Select only: the current option value. */
  selected?: string;
  options?: AdminOption[];
  /** Link only: an http(s) URL, never anything else. */
  href?: string;
  disabled?: boolean;
  hint?: string;
  requiresRestart?: boolean;
}

/** What an admin request carries, minus the wire envelope. */
export interface AdminRequest {
  id: string;
  value?: string | number | boolean;
  confirm?: boolean;
}

const EMPTY_VALUE = '—';

function stringifyValue(value: AdminItem['value'], t: Messages): string {
  if (value === undefined || value === null || value === '') return EMPTY_VALUE;
  if (typeof value === 'boolean') return value ? t.adminOn : t.adminOff;
  return String(value);
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function rowFor(section: AdminSection, item: AdminItem, t: Messages): AdminRow {
  const row: AdminRow = {
    sectionId: section.id,
    sectionTitle: section.title,
    itemId: item.id,
    kind: item.kind,
    label: item.label,
    valueText: stringifyValue(item.value, t),
    control: 'none',
  };
  if (item.description !== undefined) row.description = item.description;

  switch (item.kind) {
    case 'toggle': {
      row.control = 'toggle';
      if (typeof item.value === 'boolean') {
        row.checked = item.value;
      } else {
        row.checked = false;
        row.disabled = true;
      }
      break;
    }
    case 'select': {
      row.control = 'select';
      const options = Array.isArray(item.options) ? item.options : [];
      row.options = options;
      const current = item.value === undefined || item.value === null ? '' : String(item.value);
      row.selected = current;
      const match = options.find((o) => o.value === current);
      if (match) row.valueText = match.label;
      if (options.length === 0) row.disabled = true;
      break;
    }
    case 'button': {
      row.control = 'button';
      row.valueText = '';
      break;
    }
    case 'link': {
      // Only http(s) becomes clickable: the URL comes off a socket, and a
      // `javascript:` href in an extension page is not something to render.
      if (isHttpUrl(item.value)) {
        row.control = 'link';
        row.href = item.value;
      }
      break;
    }
    default:
      break;
  }

  if (item.hint !== undefined) row.hint = item.hint;
  if (item.requiresRestart === true) row.requiresRestart = true;
  return row;
}

/** Flatten the server state into rows, section then item order. A malformed
 * state yields no rows: the popup shows an empty section, never a crash. */
export function buildAdminRows(state: AdminState | null | undefined, t: Messages): AdminRow[] {
  if (!state || !Array.isArray(state.sections)) return [];
  const rows: AdminRow[] = [];
  // The state arrives off a socket as JSON: entries are typed loosely here so
  // the guards below are checks the compiler keeps, not dead code.
  const sections = state.sections as (AdminSection | null | undefined)[];
  for (const section of sections) {
    if (!section || !Array.isArray(section.items)) continue;
    const items = section.items as (AdminItem | null | undefined)[];
    for (const item of items) {
      if (!item || typeof item.id !== 'string') continue;
      rows.push(rowFor(section, item, t));
    }
  }
  return rows;
}

/** The server's UI strings, or the fallback in the interface language. */
export function adminUi(state: AdminState | null | undefined, language: Language): AdminUiStrings {
  return state?.ui ?? fallbackAdminUi(language);
}

/** `not-connected` is the background's own code for "no open socket"; it
 * reads as the server's (or fallback) sentence. Anything else is shown as is. */
export function describeAdminError(error: string, ui: AdminUiStrings): string {
  return error === 'not-connected' ? ui.notConnected : error;
}

export type AdminNextAction =
  | {
      type: 'confirm';
      preview: string;
      confirmLabel: string;
      cancelLabel: string;
      resend: AdminRequest & { confirm: true };
    }
  | { type: 'applied'; message: string; output?: string[]; refresh: true }
  | { type: 'error'; message: string };

/** Decide what the popup does with one action result. */
export function nextAction(
  result: AdminActionResult,
  request: AdminRequest,
  ui: AdminUiStrings,
): AdminNextAction {
  if (!result.ok) return { type: 'error', message: describeAdminError(result.error, ui) };
  if (!result.applied) {
    const resend: AdminRequest & { confirm: true } = { id: request.id, confirm: true };
    if (request.value !== undefined) resend.value = request.value;
    return {
      type: 'confirm',
      preview: result.preview,
      confirmLabel: ui.confirm,
      cancelLabel: ui.cancel,
      resend,
    };
  }
  const applied: AdminNextAction = {
    type: 'applied',
    message: result.requiresRestart === true ? ui.restartRequired : ui.changed,
    refresh: true,
  };
  if (Array.isArray(result.output)) applied.output = result.output;
  return applied;
}

export type ConfirmState =
  | { phase: 'idle' }
  | { phase: 'confirming'; preview: string; pendingRequest: AdminRequest & { confirm: true } }
  | { phase: 'applied'; message: string; output?: string[] }
  | { phase: 'error'; message: string };

export type ConfirmEvent =
  | { type: 'result'; request: AdminRequest; result: AdminActionResult; ui: AdminUiStrings }
  | { type: 'cancel' };

export function initialConfirmState(): ConfirmState {
  return { phase: 'idle' };
}

/** idle → confirming(preview, pendingRequest) → applied | error; cancel → idle. */
export function reduceConfirm(_state: ConfirmState, event: ConfirmEvent): ConfirmState {
  if (event.type === 'cancel') return { phase: 'idle' };
  const action = nextAction(event.result, event.request, event.ui);
  if (action.type === 'confirm') {
    return { phase: 'confirming', preview: action.preview, pendingRequest: action.resend };
  }
  if (action.type === 'error') return { phase: 'error', message: action.message };
  const applied: ConfirmState = { phase: 'applied', message: action.message };
  if (action.output) applied.output = action.output;
  return applied;
}
