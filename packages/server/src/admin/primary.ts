import { loadConfig } from '../config.js';
import { buildServerStatus } from '../commands/doctor.js';
import { checkForUpdates, type UpdateCheckResult } from '../commands/update-check.js';
import { formatUpdate } from '../commands/updates.js';
import { buildVersionInfo } from '../lifecycle/version-endpoint.js';
import { readInstalledVersion } from '../version.js';
import type { AdminHandlers } from '../bridge/ws-bridge.js';
import { applyAdminAction } from './actions.js';
import { adminLanguage, buildAdminState, type AdminInput } from './descriptor.js';
import { gatherAdminInput } from './sources.js';

/**
 * The primary's admin handlers for the WS bridge. In process: the server
 * rows describe this very process, the tab count and the extension version
 * come from the live sessions. The update check never runs at boot: the
 * first `admin.describe` starts one in the background (honouring the 6 h
 * disk cache) and later states carry its result; the `updates.check` button
 * forces a fresh one. `doctor` runs only on its button, because it is slow.
 */

export interface PrimaryAdminOptions {
  version: string;
  tabsConnected: () => number;
  connectedExtensionVersion: () => string | null;
  /** Test seams; production leaves them unset. */
  checkUpdates?: (opts: { force?: boolean }) => Promise<UpdateCheckResult>;
  doctor?: () => Promise<string[]>;
}

async function runDoctorLines(): Promise<string[]> {
  const { runDoctor, formatDoctor } = await import('../commands/doctor.js');
  return formatDoctor(await runDoctor(), adminLanguage(loadConfig())).split('\n');
}

export function createPrimaryAdminHandlers(opts: PrimaryAdminOptions): AdminHandlers {
  const check = opts.checkUpdates ?? checkForUpdates;
  let update: { latest: string | null; isNewer: boolean } | null = null;
  let backgroundCheck: Promise<void> | null = null;

  const input = (): Promise<AdminInput> =>
    gatherAdminInput({
      server: () =>
        Promise.resolve(
          buildServerStatus(
            { kind: 'version', info: buildVersionInfo(opts.version) },
            readInstalledVersion(),
          ),
        ),
      version: opts.version,
      tabsConnected: opts.tabsConnected,
      connectedExtensionVersion: opts.connectedExtensionVersion,
      update: () => update,
    });

  const startBackgroundCheck = (): void => {
    if (backgroundCheck) return;
    backgroundCheck = check({})
      .then((r) => {
        update = { latest: r.latest, isNewer: r.isNewer };
      })
      .catch(() => {
        /* passive: an unreachable registry leaves "unknown" */
      });
  };

  const checkUpdatesLines = async (): Promise<string[]> => {
    const r = await check({ force: true });
    update = { latest: r.latest, isNewer: r.isNewer };
    const info =
      r.latest === null
        ? { current: r.current, latest: null, newer: null }
        : { current: r.current, latest: r.latest, newer: r.isNewer };
    return formatUpdate(info, adminLanguage(loadConfig())).split('\n');
  };

  return {
    describe: async () => {
      startBackgroundCheck();
      return buildAdminState(await input());
    },
    action: (req) =>
      applyAdminAction(req, {
        input,
        doctor: opts.doctor ?? runDoctorLines,
        checkUpdates: checkUpdatesLines,
      }),
  };
}
