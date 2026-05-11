export type ClientId = 'claude' | 'opencode' | 'copilot';

export interface ClientInfo {
  id: ClientId;
  displayName: string;
}

export interface DetectResult {
  installed: boolean;
  registered: boolean;
  configPath: string;
}

export interface Installer extends ClientInfo {
  /**
   * Where the client's config lives on this OS, if any conventional location
   * is known. Returns the resolved absolute path even when the file does not exist yet.
   */
  configPath(): string;

  /**
   * Whether the client appears installed on the system (config file or directory exists).
   */
  detect(): DetectResult;

  /**
   * Register browser-link in the client's MCP config. Idempotent.
   * Returns a brief description of what was changed.
   */
  install(command: string, args: string[]): string;

  /**
   * Remove the browser-link entry from the client's MCP config. Idempotent.
   */
  uninstall(): string;
}
