import { INSTALLERS, getInstaller, type ClientId } from '../installers/index.js';
import { refusedMessage } from './install.js';

export interface UninstallReport {
  client: ClientId;
  displayName: string;
  message: string;
  /** Set when the installer refused this client; nothing was written to it. */
  refused?: true;
}

export function uninstallFor(client: ClientId): UninstallReport {
  const inst = getInstaller(client);
  const message = inst.uninstall();
  return { client, displayName: inst.displayName, message };
}

/** Every client, in order. A refused client is reported with its reason
 * and does not stop the others; any refusal sets the exit code to 1. */
export function uninstallAll(): UninstallReport[] {
  return INSTALLERS.map((i) => {
    try {
      return uninstallFor(i.id);
    } catch (err) {
      process.exitCode = 1;
      return {
        client: i.id,
        displayName: i.displayName,
        message: refusedMessage(err),
        refused: true,
      };
    }
  });
}
