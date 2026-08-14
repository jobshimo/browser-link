import { INSTALLERS, getInstaller, type ClientId } from '../installers/index.js';

export interface UninstallReport {
  client: ClientId;
  displayName: string;
  message: string;
}

export function uninstallFor(client: ClientId): UninstallReport {
  const inst = getInstaller(client);
  const message = inst.uninstall();
  return { client, displayName: inst.displayName, message };
}

export function uninstallAll(): UninstallReport[] {
  return INSTALLERS.map((i) => uninstallFor(i.id));
}
