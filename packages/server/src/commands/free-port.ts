import { execFileSync } from 'node:child_process';
import { platform } from 'node:os';
import type { Language } from './welcome.js';

const WS_HOST = '127.0.0.1';
const WS_PORT = 17529;

export interface FreePortResult {
  /** True when the port was free (nothing to do) OR the owning process was killed. */
  ok: boolean;
  /** PID found bound to WS_PORT, or null when the port was already free. */
  pid: number | null;
  /** Image / executable name reported by the OS, used as a safety check. */
  imageName: string | null;
  /** Human-readable message in the requested language. */
  message: string;
}

/**
 * Best-effort lookup of the PID owning the WS port, cross-platform.
 * Returns null when nothing is listening on the port, when the OS tools
 * needed to find the owner are missing, or when parsing fails.
 *
 * We don't shell out via a string command — `execFileSync` with an argv
 * array avoids any quoting / injection surprises.
 */
function findPidOnPort(port: number): number | null {
  try {
    if (platform() === 'win32') {
      // netstat -ano -p TCP produces lines like:
      //   "  TCP    127.0.0.1:17529    0.0.0.0:0    LISTENING    13212"
      const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      for (const line of out.split(/\r?\n/)) {
        if (!line.includes(`:${port}`)) continue;
        if (!line.includes('LISTENING')) continue;
        const cols = line.trim().split(/\s+/);
        const pid = Number.parseInt(cols[cols.length - 1] ?? '', 10);
        if (Number.isFinite(pid) && pid > 0) return pid;
      }
      return null;
    }
    // Unix-likes: lsof gives just the PID with -t.
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const pid = Number.parseInt(out.trim().split('\n')[0] ?? '', 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Return the image / executable name of a PID, or null when the lookup
 * fails. We use this as a safety check before killing: we will only kill
 * processes whose image name starts with "node" — refuse to nuke anything
 * else that happens to share the port (some other dev server, malware,
 * a misconfigured tool, etc.).
 */
function imageNameOf(pid: number): string | null {
  try {
    if (platform() === 'win32') {
      // tasklist /FI "PID eq 13212" /FO CSV /NH produces:
      //   "node.exe","13212","Console","1","45,000 K"
      const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (!out || out.startsWith('INFO:')) return null;
      // Strip leading quote, then take up to next quote.
      const first = out.indexOf('"');
      const second = out.indexOf('"', first + 1);
      if (first === -1 || second === -1) return null;
      return out.slice(first + 1, second);
    }
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function isNodeImage(image: string | null): boolean {
  if (!image) return false;
  const lc = image.toLowerCase();
  return lc.startsWith('node') || lc === 'node.exe';
}

function killByPid(pid: number): boolean {
  try {
    if (platform() === 'win32') {
      execFileSync('taskkill', ['/F', '/PID', String(pid)], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      return true;
    }
    process.kill(pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

interface FreePortI18n {
  alreadyFree: string;
  killed: (pid: number) => string;
  killFailed: (pid: number) => string;
  notNode: (pid: number, image: string) => string;
  unknownOwner: (pid: number) => string;
}

const I18N: Record<Language, FreePortI18n> = {
  en: {
    alreadyFree: `Port ${WS_HOST}:${WS_PORT} is already free — nothing to stop.`,
    killed: (pid) =>
      `✓ Stopped browser-link primary (PID ${pid}). Port ${WS_HOST}:${WS_PORT} is now free.`,
    killFailed: (pid) =>
      `✗ Could not kill PID ${pid}. Try again as administrator, or close the MCP client manually.`,
    notNode: (pid, image) =>
      `✗ Port ${WS_HOST}:${WS_PORT} is held by PID ${pid} (${image}), which is NOT a node process. ` +
      `Refusing to kill it — close that process yourself if you know what it is.`,
    unknownOwner: (pid) =>
      `✗ Port ${WS_HOST}:${WS_PORT} is held by PID ${pid}, but we could not identify the process. ` +
      `Refusing to kill it. Close it manually with: taskkill /F /PID ${pid} (Windows) or kill ${pid} (Unix).`,
  },
  es: {
    alreadyFree: `El puerto ${WS_HOST}:${WS_PORT} ya está libre — no hay nada que parar.`,
    killed: (pid) =>
      `✓ browser-link primary detenido (PID ${pid}). El puerto ${WS_HOST}:${WS_PORT} quedó libre.`,
    killFailed: (pid) =>
      `✗ No se pudo matar el PID ${pid}. Probá de nuevo como administrador o cerrá el cliente MCP a mano.`,
    notNode: (pid, image) =>
      `✗ El puerto ${WS_HOST}:${WS_PORT} lo tiene el PID ${pid} (${image}), que NO es un proceso node. ` +
      `Por seguridad no se mata — cerralo a mano si sabés qué es.`,
    unknownOwner: (pid) =>
      `✗ El puerto ${WS_HOST}:${WS_PORT} lo tiene el PID ${pid}, pero no pudimos identificar el proceso. ` +
      `Por seguridad no se mata. Cerralo a mano con: taskkill /F /PID ${pid} (Windows) o kill ${pid} (Unix).`,
  },
};

/**
 * Find the process listening on WS_PORT and try to stop it.
 *
 * Safety rule: only kill processes whose image name starts with "node".
 * Anything else (or unidentified) is left alone with a clear message.
 * This stops a stray browser-link from blocking the next MCP client
 * without ever risking killing some unrelated user process that happens
 * to share the port.
 */
export function runFreePort(language: Language = 'en'): FreePortResult {
  const t = I18N[language];
  const pid = findPidOnPort(WS_PORT);
  if (pid == null) {
    return { ok: true, pid: null, imageName: null, message: t.alreadyFree };
  }
  const image = imageNameOf(pid);
  if (image == null) {
    return { ok: false, pid, imageName: null, message: t.unknownOwner(pid) };
  }
  if (!isNodeImage(image)) {
    return { ok: false, pid, imageName: image, message: t.notNode(pid, image) };
  }
  const killed = killByPid(pid);
  return {
    ok: killed,
    pid,
    imageName: image,
    message: killed ? t.killed(pid) : t.killFailed(pid),
  };
}
