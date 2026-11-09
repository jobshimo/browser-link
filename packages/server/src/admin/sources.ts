import { loadConfig } from '../config.js';
import { IPC_PORT } from '../bridge/protocol.js';
import { detectInstructionsStatus } from '../manual/status.js';
import { INSTALLERS } from '../installers/index.js';
import { isGrantLive, loadGrant, remainingMs } from '../cdp/grant.js';
import { resolveDownloadsDir } from '../downloads.js';
import { getDataDir } from '../map/paths.js';
import { TOOL_CATALOGUE } from '../permissions.js';
import { resolveExtensionPath } from '../commands/extension.js';
import { buildServerStatus, type DoctorServerStatus } from '../commands/doctor.js';
import { probeVersion } from '../lifecycle/election.js';
import { VERSION, readInstalledVersion } from '../version.js';
import type { AdminClient, AdminInput } from './descriptor.js';

/**
 * Gathers the facts `buildAdminState` needs from the real machine. Shared by
 * the primary (in process: it knows its tabs and is the running server) and
 * the console's status view (out of process: it asks the primary's
 * `/version`, and the tab count stays unknown). Every source is a
 * best-effort read: one that throws degrades to an empty or unknown value.
 */

/** The WS bridge port; `ws-bridge.ts` owns it, repeated here (as `doctor`
 * does) so the console does not load the bridge to read a number. */
const WS_BRIDGE_PORT = 17529;

export interface AdminSourceOptions {
  /** The running primary against the installed version. */
  server: () => Promise<DoctorServerStatus>;
  /** `null` when unknown (out of process). */
  tabsConnected?: () => number | null;
  /** Version a connected tab's extension reported; `null` when none did. */
  connectedExtensionVersion?: () => string | null;
  /** Version of the running server; default this module's `VERSION`. */
  version?: string;
  /** Last known update check; `null` when none ran yet. */
  update?: () => { latest: string | null; isNewer: boolean } | null;
  now?: () => number;
}

function safe<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

function detectClients(): AdminClient[] {
  const out: AdminClient[] = [];
  for (const installer of INSTALLERS) {
    try {
      const d = installer.detect();
      out.push({
        id: installer.id,
        displayName: installer.displayName,
        installed: d.installed,
        registered: d.registered,
      });
    } catch {
      /* best effort: an unreadable client is left out */
    }
  }
  return out;
}

export async function gatherAdminInput(opts: AdminSourceOptions): Promise<AdminInput> {
  const config = safe(() => loadConfig(), {});
  const grant = safe(() => loadGrant(), null);
  const now = opts.now?.() ?? Date.now();
  const server = await opts.server().catch((): DoctorServerStatus => ({
    running: null,
    installed: readInstalledVersion(),
    outdated: false,
  }));
  return {
    config,
    now,
    version: opts.version ?? VERSION,
    server,
    tabsConnected: opts.tabsConnected?.() ?? null,
    ports: { ws: WS_BRIDGE_PORT, ipc: IPC_PORT },
    extension: {
      path: safe(() => resolveExtensionPath(), null),
      connectedVersion: opts.connectedExtensionVersion?.() ?? null,
    },
    instructions: safe(() => detectInstructionsStatus(), []),
    clients: detectClients(),
    cdpGrant: { live: isGrantLive(grant, now), remainingMs: remainingMs(grant, now) },
    update: opts.update?.() ?? null,
    toolNames: TOOL_CATALOGUE.map((t) => t.name),
    downloadsDir: safe(() => resolveDownloadsDir(config, getDataDir()), ''),
  };
}

/** The console's view of the running primary: its `/version`, or "not
 * running" when nothing answers. */
export async function probeRunningServer(): Promise<DoctorServerStatus> {
  return buildServerStatus(await probeVersion(WS_BRIDGE_PORT), readInstalledVersion());
}
