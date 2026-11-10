import {
  DEFAULT_CDP_DIRECT_PORT,
  DEFAULT_GRANT_TTL_MINUTES,
  type BrowserLinkConfig,
} from '../config.js';
import type { ClientInstructionsStatus } from '../manual/status.js';
import type { ClientId } from '../installers/index.js';
import type { DoctorServerStatus } from '../commands/doctor.js';
import type { Language } from '../commands/welcome.js';
import type { AdminItem, AdminSection, AdminState } from '../messages.js';
import { ADMIN_I18N, type AdminI18n } from './i18n.js';

/**
 * The admin descriptor (S1): one source of truth for what the console's
 * status view and the popup's Admin section show. `buildAdminState` is pure:
 * every fact arrives in `AdminInput`, gathered by `admin/sources.ts` in the
 * primary (in process) or in the console (out of process, through the
 * primary's `/version`). Every string is localised here.
 *
 * Process-ending operations (`stop`/free-port, self-update) are never
 * actions: they would end the very primary that answers the popup, so they
 * are readouts carrying the console command instead. So are the settings
 * that widen what an agent may do (the tool set, cdp-direct and its grant
 * lifetime, MCP client registration): anything that can reach the bridge
 * could otherwise grant them, so only the console changes them.
 */

export const REPO_URL = 'https://github.com/jobshimo/browser-link';
export const STOP_COMMAND = 'browser-link stop';
export const SELF_UPDATE_COMMAND = 'npm install -g @jobshimo/browser-link@latest';
const CDP_DIRECT_GRANT_TTL_COMMAND = 'browser-link config set cdp-direct.grant-ttl <minutes|never>';

/** The console command that flips a tool (`browser-link tools enable|disable`). */
function toolCommand(name: string, enabled: boolean): string {
  return `browser-link tools ${enabled ? 'disable' : 'enable'} ${name}`;
}

/** The console command that flips cdp-direct (`config set cdp-direct.enabled`). */
function cdpDirectEnabledCommand(enabled: boolean): string {
  return `browser-link config set cdp-direct.enabled ${enabled ? 'false' : 'true'}`;
}

function registerCommand(client: ClientId): string {
  return `browser-link install --client ${client}`;
}

export interface AdminClient {
  id: ClientId;
  displayName: string;
  /** The client's config exists on this machine. */
  installed: boolean;
  /** browser-link is already registered in it. */
  registered: boolean;
}

export interface AdminInput {
  config: BrowserLinkConfig;
  /** Epoch ms used for `generatedAt` and the uptime. */
  now: number;
  /** The version of the process building the state. */
  version: string;
  /** Running primary (from `/version` or in process) against the version on disk. */
  server: DoctorServerStatus;
  /** `null` when unknown: the console runs out of process. */
  tabsConnected: number | null;
  ports: { ws: number; ipc: number };
  extension: { path: string | null; connectedVersion: string | null };
  instructions: readonly ClientInstructionsStatus[];
  clients: readonly AdminClient[];
  cdpGrant: { live: boolean; remainingMs: number | null };
  /** Cached update check; `null` when none ran yet. */
  update: { latest: string | null; isNewer: boolean } | null;
  toolNames: readonly string[];
  downloadsDir: string;
}

export function adminLanguage(config: BrowserLinkConfig): Language {
  return config.language === 'es' ? 'es' : 'en';
}

function readout(
  id: string,
  label: string,
  value: AdminItem['value'],
  extra: Partial<AdminItem> = {},
): AdminItem {
  return { id, kind: 'readout', label, value, writesDisk: false, ...extra };
}

function toggle(id: string, label: string, value: boolean, requiresRestart = false): AdminItem {
  return {
    id,
    kind: 'toggle',
    label,
    value,
    writesDisk: true,
    ...(requiresRestart ? { requiresRestart: true } : {}),
  };
}

export function formatUptime(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function statusSection(input: AdminInput, t: AdminI18n): AdminSection {
  const { server, config } = input;
  const running = server.running;
  const startedAt = running ? Date.parse(running.startedAt) : NaN;
  const items: AdminItem[] = [
    readout(
      'status.server',
      t.server,
      running ? t.serverRunning(running.version) : t.serverNotRunning,
      running ? {} : { hint: t.serverNotRunningHint },
    ),
    readout(
      'status.installed',
      t.installed,
      server.installed === null
        ? t.unknown
        : server.outdated
          ? t.installedOutdated(server.installed)
          : server.installed,
      server.outdated ? { hint: STOP_COMMAND } : {},
    ),
    readout('status.pid', t.pid, running ? running.pid : null),
    readout(
      'status.uptime',
      t.uptime,
      running && Number.isFinite(startedAt) ? formatUptime(input.now - startedAt) : null,
    ),
    readout(
      'status.tabs',
      t.tabs,
      input.tabsConnected,
      input.tabsConnected === null ? { hint: t.tabsUnknownHint } : {},
    ),
    readout('status.ports', t.ports, `WS ${input.ports.ws} · IPC ${input.ports.ipc}`),
    readout('status.multiAgent', t.multiAgentStatus, config.multiAgent === false ? t.off : t.on),
    readout(
      'status.extension',
      t.extension,
      // Out of process the console cannot see the tabs, so it cannot know.
      input.tabsConnected === null
        ? t.unknown
        : input.extension.connectedVersion === null
          ? t.extensionNotConnected
          : input.extension.connectedVersion === input.version
            ? t.extensionAligned(input.extension.connectedVersion)
            : t.extensionMismatch(input.extension.connectedVersion, input.version),
    ),
    ...input.instructions.map((s) =>
      readout(
        `status.instructions.${s.id}`,
        t.instructionsFor(s.displayName),
        t.instructionsState(s.state),
      ),
    ),
    readout(
      'status.cdpDirect',
      t.cdpDirect,
      config.cdpDirectEnabled !== true
        ? t.off
        : input.cdpGrant.live
          ? t.cdpDirectGranted(
              input.cdpGrant.remainingMs === null
                ? null
                : Math.ceil(input.cdpGrant.remainingMs / 60_000),
            )
          : t.cdpDirectNoGrant,
    ),
    readout(
      'status.update',
      t.update,
      input.update === null || input.update.latest === null
        ? t.unknown
        : input.update.isNewer
          ? t.updateAvailable(input.update.latest)
          : t.upToDate,
      input.update?.isNewer === true ? { hint: SELF_UPDATE_COMMAND } : {},
    ),
    readout('status.activity', t.activity, config.activityEnabled === false ? t.off : t.on),
  ];
  return { id: 'status', title: t.sections.status, items };
}

function setupSection(input: AdminInput, t: AdminI18n): AdminSection {
  const { config } = input;
  const disabled = new Set(config.disabledTools ?? []);
  const grantTtl = config.cdpDirectGrantTtlMinutes ?? DEFAULT_GRANT_TTL_MINUTES;
  const cdpDirectEnabled = config.cdpDirectEnabled === true;
  const items: AdminItem[] = [
    {
      id: 'language',
      kind: 'select',
      label: t.language,
      value: adminLanguage(config),
      options: [
        { value: 'en', label: 'English' },
        { value: 'es', label: 'Español' },
      ],
      writesDisk: true,
    },
    ...input.toolNames.map((name) => {
      const enabled = !disabled.has(name);
      return readout(`tools.${name}`, t.tool(name), enabled ? t.on : t.off, {
        hint: toolCommand(name, enabled),
      });
    }),
    toggle('multiAgent', t.multiAgent, config.multiAgent !== false, true),
    toggle('autoReelect', t.autoReelect, config.autoReelect === true, true),
    toggle(
      'instructionsAutoRefresh',
      t.instructionsAutoRefresh,
      config.instructionsAutoRefresh !== false,
      true,
    ),
    readout('cdpDirectEnabled', t.cdpDirectEnabled, cdpDirectEnabled ? t.on : t.off, {
      hint: cdpDirectEnabledCommand(cdpDirectEnabled),
    }),
    readout('cdpDirectPort', t.cdpDirectPort, config.cdpDirectPort ?? DEFAULT_CDP_DIRECT_PORT, {
      hint: 'browser-link config set cdp-direct.port <port>',
    }),
    readout(
      'cdpDirectGrantTtlMinutes',
      t.cdpDirectGrantTtl,
      grantTtl === 0 ? t.never : t.minutes(grantTtl),
      { hint: CDP_DIRECT_GRANT_TTL_COMMAND },
    ),
    // Read once when the primary wires the trail, so a change needs a restart.
    toggle('activityEnabled', t.activityEnabled, config.activityEnabled !== false, true),
    toggle(
      'activityRecordPayloads',
      t.activityRecordPayloads,
      config.activityRecordPayloads !== false,
      true,
    ),
    readout('downloadsDir', t.downloadsDir, input.downloadsDir, {
      hint: 'browser-link config set downloads.dir <absolute-path|default>',
    }),
    // These two keep their timestamped `settings.update` path (popup and
    // `config set`), so the admin panel only shows them.
    readout(
      'idleTtl',
      t.idleTtl,
      config.idleTtlMinutes === undefined
        ? t.popupDefault
        : config.idleTtlMinutes === 0
          ? t.never
          : t.minutes(config.idleTtlMinutes),
      { hint: t.idleTtlHint },
    ),
    readout(
      'flowRecording',
      t.flowRecording,
      config.flowRecordingEnabled === undefined
        ? t.popupDefault
        : config.flowRecordingEnabled
          ? t.on
          : t.off,
      { hint: t.flowRecordingHint },
    ),
  ];
  return { id: 'setup', title: t.sections.setup, items };
}

function button(id: string, label: string, writesDisk: boolean): AdminItem {
  return { id, kind: 'button', label, writesDisk };
}

function diagnoseSection(input: AdminInput, t: AdminI18n): AdminSection {
  const items: AdminItem[] = [
    button('doctor', t.doctor, false),
    button('updates.check', t.updatesCheck, false),
  ];
  for (const s of input.instructions) {
    // A corrupt file is the CLI's business: the installers refuse to touch it.
    if (s.state.kind === 'corrupt') continue;
    items.push(button(`instructions.install.${s.id}`, t.instructionsInstall(s.displayName), true));
    if (s.state.kind === 'installed' || s.state.kind === 'installed-outdated') {
      items.push(
        button(`instructions.uninstall.${s.id}`, t.instructionsUninstall(s.displayName), true),
      );
    }
  }
  for (const c of input.clients) {
    if (!c.installed) continue;
    items.push(
      readout(
        `client.register.${c.id}`,
        t.registration(c.displayName),
        c.registered ? t.registered : t.notRegistered,
        { hint: registerCommand(c.id) },
      ),
    );
  }
  items.push(readout('stop', t.stop, STOP_COMMAND, { description: t.stopDescription }));
  items.push(
    readout('selfUpdate', t.selfUpdate, SELF_UPDATE_COMMAND, {
      description: t.selfUpdateDescription,
    }),
  );
  return { id: 'diagnose', title: t.sections.diagnose, items };
}

function referenceSection(input: AdminInput, t: AdminI18n): AdminSection {
  return {
    id: 'reference',
    title: t.sections.reference,
    items: [
      readout('about', t.about, t.aboutText),
      { id: 'repo', kind: 'link', label: t.repo, value: REPO_URL, writesDisk: false },
      readout('extension.path', t.extensionPath, input.extension.path ?? t.extensionNotFound),
    ],
  };
}

/** `language`: the one an `admin.describe`/`admin.action` asked for (the
 * extension's interface language), for this answer only; by default the
 * configured one. The `language` item's value stays the configured one. */
export function buildAdminState(
  input: AdminInput,
  language: Language = adminLanguage(input.config),
): AdminState {
  const t = ADMIN_I18N[language];
  return {
    version: 1,
    generatedAt: new Date(input.now).toISOString(),
    sections: [
      statusSection(input, t),
      setupSection(input, t),
      diagnoseSection(input, t),
      referenceSection(input, t),
    ],
    ui: { language, ...t.ui },
  };
}

/** Every item of a state, in display order. */
export function adminItems(state: AdminState): AdminItem[] {
  return state.sections.flatMap((s) => s.items);
}
