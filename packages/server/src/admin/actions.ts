import { saveConfig, type BrowserLinkConfig } from '../config.js';
import { disableTools, enableTools } from '../commands/tools.js';
import {
  disableAutoReelect,
  disableMultiAgent,
  enableAutoReelect,
  enableMultiAgent,
} from '../commands/multi-agent.js';
import { setCdpDirectEnabled, setCdpDirectGrantTtl } from '../commands/config.js';
import { installInstructionsFor, uninstallInstructionsFor } from '../commands/instructions.js';
import { installFor } from '../commands/install.js';
import type { ClientId } from '../installers/index.js';
import type { AdminActionResult, AdminItem } from '../messages.js';
import { adminItems, adminLanguage, buildAdminState, type AdminInput } from './descriptor.js';
import { ADMIN_I18N } from './i18n.js';

/**
 * Admin actions (S2). The only way the popup changes server state, and a
 * closed allowlist: an action id must name an actionable item of the state
 * the server builds right now (so a tool outside the catalogue, a client
 * that is not detected, or a readout can never be written), its value is
 * checked against the item's kind and options, a disk write needs an
 * explicit `confirm: true`, and the write itself goes through the SAME
 * helper the CLI uses, never a new write path.
 */

export interface AdminActionRequest {
  id: string;
  value?: string | number | boolean;
  confirm?: boolean;
}

/** The existing write helpers, injectable so tests can spy on each one. */
export interface AdminHelpers {
  saveConfig: (patch: Partial<BrowserLinkConfig>) => unknown;
  enableTools: typeof enableTools;
  disableTools: typeof disableTools;
  enableMultiAgent: typeof enableMultiAgent;
  disableMultiAgent: typeof disableMultiAgent;
  enableAutoReelect: typeof enableAutoReelect;
  disableAutoReelect: typeof disableAutoReelect;
  setCdpDirectEnabled: typeof setCdpDirectEnabled;
  setCdpDirectGrantTtl: typeof setCdpDirectGrantTtl;
  installInstructionsFor: (client: ClientId) => { ok: boolean; message?: string };
  uninstallInstructionsFor: (client: ClientId) => { ok: boolean; message?: string };
  installFor: (client: ClientId) => { installedClient: boolean; message: string };
}

export const DEFAULT_ADMIN_HELPERS: AdminHelpers = {
  saveConfig,
  enableTools,
  disableTools,
  enableMultiAgent,
  disableMultiAgent,
  enableAutoReelect,
  disableAutoReelect,
  setCdpDirectEnabled,
  setCdpDirectGrantTtl,
  installInstructionsFor,
  uninstallInstructionsFor,
  installFor: (client) => installFor(client),
};

export interface AdminActionDeps {
  /** Fresh facts for the state; called before and after the action. */
  input: () => Promise<AdminInput>;
  /** `runDoctor` + `formatDoctor`, split into lines. Slow: runs only on the button. */
  doctor: () => Promise<string[]>;
  /** A forced update check, formatted into lines (network). */
  checkUpdates: () => Promise<string[]>;
  helpers?: Partial<AdminHelpers>;
}

/** Toggles whose value is one config key written with `saveConfig`, exactly
 * as the console does for the keys without a dedicated CLI helper. */
const PLAIN_TOGGLES = [
  'instructionsAutoRefresh',
  'activityEnabled',
  'activityRecordPayloads',
] as const;
type PlainToggle = (typeof PLAIN_TOGGLES)[number];

function isPlainToggle(id: string): id is PlainToggle {
  return (PLAIN_TOGGLES as readonly string[]).includes(id);
}

class AdminRefusal extends Error {}

function suffix(id: string, prefix: string): string | null {
  return id.startsWith(prefix) ? id.slice(prefix.length) : null;
}

function lines(text: string | undefined): string[] {
  return text === undefined || text.length === 0 ? [] : text.split('\n');
}

function checkValue(item: AdminItem, value: AdminActionRequest['value']): boolean {
  if (item.kind === 'toggle') return typeof value === 'boolean';
  if (item.kind === 'select') {
    if (typeof value !== 'string' && typeof value !== 'number') return false;
    return (item.options ?? []).some((o) => o.value === String(value));
  }
  return true;
}

function preview(item: AdminItem, value: AdminActionRequest['value'], input: AdminInput): string {
  const t = ADMIN_I18N[adminLanguage(input.config)];
  const tool = suffix(item.id, 'tools.');
  if (tool !== null) return value === true ? t.previewToolOn(tool) : t.previewToolOff(tool);
  if (item.kind === 'toggle') return t.previewToggle(item.label, value === true);
  if (item.kind === 'select') {
    const option = item.options?.find((o) => o.value === String(value));
    return t.previewSelect(item.label, option?.label ?? String(value));
  }
  const displayName = (id: string | null): string =>
    input.instructions.find((s) => s.id === id)?.displayName ??
    input.clients.find((c) => c.id === id)?.displayName ??
    String(id);
  const install = suffix(item.id, 'instructions.install.');
  if (install !== null) return t.previewInstall(displayName(install));
  const uninstall = suffix(item.id, 'instructions.uninstall.');
  if (uninstall !== null) return t.previewUninstall(displayName(uninstall));
  return t.previewRegister(displayName(suffix(item.id, 'client.register.')));
}

/** Runs the write for one validated, confirmed item. Returns output lines;
 * throws an `AdminRefusal` (or the helper's own error) when it refused. */
async function apply(
  item: AdminItem,
  value: AdminActionRequest['value'],
  input: AdminInput,
  deps: AdminActionDeps,
  h: AdminHelpers,
): Promise<string[]> {
  const language = adminLanguage(input.config);
  const on = value === true;
  const { id } = item;
  if (id === 'doctor') return deps.doctor();
  if (id === 'updates.check') return deps.checkUpdates();
  if (id === 'language') {
    h.saveConfig({ language: value === 'es' ? 'es' : 'en' });
    return [];
  }
  const tool = suffix(id, 'tools.');
  if (tool !== null) {
    return lines(on ? h.enableTools([tool], language) : h.disableTools([tool], language));
  }
  if (id === 'multiAgent') {
    return lines(on ? h.enableMultiAgent(language) : h.disableMultiAgent(language));
  }
  if (id === 'autoReelect') {
    return lines(on ? h.enableAutoReelect(language) : h.disableAutoReelect(language));
  }
  if (isPlainToggle(id)) {
    h.saveConfig({ [id]: on });
    return [];
  }
  if (id === 'cdpDirectEnabled') return lines(h.setCdpDirectEnabled(String(on), language));
  if (id === 'cdpDirectGrantTtlMinutes') {
    return lines(h.setCdpDirectGrantTtl(String(value), language));
  }
  const install = suffix(id, 'instructions.install.');
  const uninstall = suffix(id, 'instructions.uninstall.');
  if (install !== null || uninstall !== null) {
    const report =
      install !== null
        ? h.installInstructionsFor(install as ClientId)
        : h.uninstallInstructionsFor(uninstall as ClientId);
    if (!report.ok) throw new AdminRefusal(report.message ?? id);
    return lines(report.message);
  }
  const register = suffix(id, 'client.register.');
  if (register !== null) {
    const report = h.installFor(register as ClientId);
    if (!report.installedClient) throw new AdminRefusal(report.message);
    return lines(report.message);
  }
  // Reaching here means the descriptor offers an actionable item this
  // module does not know: refuse rather than guess.
  throw new AdminRefusal(ADMIN_I18N[language].unknownAction(id));
}

/** Validate, confirm, apply. Never throws: every failure is `ok: false`. */
export async function applyAdminAction(
  req: AdminActionRequest,
  deps: AdminActionDeps,
): Promise<AdminActionResult> {
  try {
    const input = await deps.input();
    const t = ADMIN_I18N[adminLanguage(input.config)];
    const item = adminItems(buildAdminState(input)).find((i) => i.id === req.id);
    if (!item) return { ok: false, error: t.unknownAction(req.id) };
    if (item.kind === 'readout' || item.kind === 'link') {
      return { ok: false, error: t.notAnAction(item.id) };
    }
    if (!checkValue(item, req.value)) return { ok: false, error: t.invalidValue(item.id) };
    if (item.writesDisk && req.confirm !== true) {
      return {
        ok: true,
        applied: false,
        needsConfirm: true,
        preview: preview(item, req.value, input),
      };
    }
    const helpers = { ...DEFAULT_ADMIN_HELPERS, ...deps.helpers };
    const output = await apply(item, req.value, input, deps, helpers);
    const state = buildAdminState(await deps.input());
    return {
      ok: true,
      applied: true,
      ...(item.requiresRestart ? { requiresRestart: true } : {}),
      state,
      ...(output.length > 0 ? { output } : {}),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
