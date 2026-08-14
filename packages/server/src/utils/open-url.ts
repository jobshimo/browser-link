import { spawn } from 'node:child_process';
import { platform } from 'node:os';

/** Open the given URL in the user's default browser, cross-platform.
 * Best-effort: returns true if the spawn succeeded, false if no opener
 * is available. We never wait for the browser process. */
export function openUrl(url: string): boolean {
  const os = platform();
  const opts = { detached: true, stdio: 'ignore' as const };

  let cmd: string;
  let args: string[];
  if (os === 'darwin') {
    cmd = 'open';
    args = [url];
  } else if (os === 'win32') {
    // `start` is a shell builtin on Windows, so we go through cmd.
    // The empty string ('') is the window title argument that `start` expects
    // when the URL itself contains characters cmd would otherwise misinterpret.
    cmd = 'cmd';
    args = ['/c', 'start', '""', url];
  } else {
    // Linux / BSDs: rely on freedesktop's xdg-open. Most desktop installs
    // ship it; if not, the caller falls back to printing the URL.
    cmd = 'xdg-open';
    args = [url];
  }

  try {
    const child = spawn(cmd, args, opts);
    child.unref();
    return true;
  } catch {
    return false;
  }
}
