import { afterEach, describe, expect, test } from 'vitest';
import { platform } from 'node:os';
import { createServer, type Server, type Socket } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lookupPeerProcess, lookupPeerProcessDetailed } from './process-identity.js';

const execFileAsync = promisify(execFile);

// Real-loopback tests: lsof (macOS / Linux) or netstat + PowerShell CIM
// (Windows) must agree on which side is local and who owns it.
const isUnix = platform() === 'darwin' || platform() === 'linux';
const isWindows = platform() === 'win32';

async function lsofAvailable(): Promise<boolean> {
  try {
    await execFileAsync('lsof', ['-v'], { timeout: 1000 });
    return true;
  } catch {
    return false;
  }
}

let server: Server | null = null;
let acceptedSocket: Socket | null = null;
let child: ChildProcess | null = null;

afterEach(async () => {
  acceptedSocket?.destroy();
  acceptedSocket = null;
  if (child && !child.killed) {
    child.kill('SIGKILL');
    child = null;
  }
  if (server) {
    await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  }
});

/** Listen on a free loopback port; resolves with the port and a promise of
 * the first accepted connection. */
async function listen(): Promise<{ port: number; connection: Promise<Socket> }> {
  server = createServer();
  const connection = new Promise<Socket>((resolve) => {
    server!.once('connection', (sock) => {
      acceptedSocket = sock;
      resolve(sock);
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  return { port: (server.address() as { port: number }).port, connection };
}

/** Spawn a child node that opens a TCP connection and holds it. The child
 * prints "READY <pid> <localPort>" once connected, then blocks on stdin so
 * the connection can be measured deterministically. */
async function connectFromChild(port: number): Promise<{ pid: number; localPort: number }> {
  const childScript = `
    const net = require('node:net');
    const sock = net.createConnection({ host: '127.0.0.1', port: ${port} }, () => {
      process.stdout.write('READY ' + process.pid + ' ' + sock.localPort + '\\n');
    });
    sock.on('error', (e) => { process.stderr.write('ERR ' + e.message + '\\n'); process.exit(1); });
    // Block forever; the test kills us in afterEach.
    process.stdin.resume();
  `;
  child = spawn(process.execPath, ['-e', childScript], { stdio: ['pipe', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let buf = '';
    child!.stdout!.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const m = buf.match(/READY (\d+) (\d+)/);
      if (m) resolve({ pid: Number(m[1]), localPort: Number(m[2]) });
    });
    child!.stderr!.on('data', (chunk: Buffer) => {
      reject(new Error('child stderr: ' + chunk.toString()));
    });
    child!.once('exit', (code) => reject(new Error('child exited early: ' + code)));
  });
}

describe.skipIf(!isUnix)('lookupPeerProcess against a real localhost connection', () => {
  test('identifies the connecting child process — not the server itself', async () => {
    if (!(await lsofAvailable())) return; // belt-and-suspenders: skip if lsof is missing

    const { port, connection } = await listen();
    const ready = await connectFromChild(port);
    // Wait for the server to actually accept the connection so lsof can see it.
    await connection;

    const peer = await lookupPeerProcess('127.0.0.1', ready.localPort);
    expect(peer).not.toBeNull();
    expect(peer!.pid).toBe(ready.pid);
    // The child IS a node process; the binaryName must reflect that, NOT 'node'
    // pointing at the test runner. We assert on the pid (above) for the strict
    // identity guarantee — the name only needs to be node-shaped.
    expect(peer!.binaryName.toLowerCase()).toContain('node');
    expect(peer!.pid).not.toBe(process.pid);
  });

  test('reads the same-user child executable path when asked for', async () => {
    if (!(await lsofAvailable())) return;

    const { port, connection } = await listen();
    const ready = await connectFromChild(port);
    await connection;

    const res = await lookupPeerProcessDetailed(
      '127.0.0.1',
      ready.localPort,
      {},
      {
        withExecutablePath: true,
      },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.peer.pid).toBe(ready.pid);
    expect(res.peer.executablePath?.startsWith('/')).toBe(true);
    expect(res.peer.executablePath?.toLowerCase()).toContain('node');
  });

  test('returns null when the peer is THIS process (defense in depth)', async () => {
    if (!(await lsofAvailable())) return;

    const { port, connection } = await listen();
    const { createConnection } = await import('node:net');
    const sock = createConnection({ host: '127.0.0.1', port });
    await new Promise<void>((resolve, reject) => {
      sock.once('connect', () => resolve());
      sock.once('error', reject);
    });
    await connection;

    try {
      const peer = await lookupPeerProcess('127.0.0.1', sock.localPort!);
      // The peer IS us. Even if lsof resolves correctly, the self-pid guard
      // must reject so we never authenticate against our own process.
      expect(peer).toBeNull();
    } finally {
      sock.destroy();
    }
  });
});

describe.skipIf(!isWindows)('lookupPeerProcessDetailed against a real Windows connection', () => {
  test('identifies a same-user child with its image name and executable path', async () => {
    const { port, connection } = await listen();
    const ready = await connectFromChild(port);
    await connection;

    const res = await lookupPeerProcessDetailed(
      '127.0.0.1',
      ready.localPort,
      {},
      {
        withExecutablePath: true,
      },
    );
    expect(res).toEqual({
      ok: true,
      peer: {
        pid: ready.pid,
        binaryName: 'node.exe',
        executablePath: expect.stringMatching(/node\.exe$/i) as unknown,
      },
    });
    if (res.ok) expect(res.peer.executablePath?.toLowerCase()).toBe(process.execPath.toLowerCase());
  }, 15000);
});
