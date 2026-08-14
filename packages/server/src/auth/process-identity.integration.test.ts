import { afterEach, describe, expect, test } from 'vitest';
import { platform } from 'node:os';
import { createServer, type Server, type Socket } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lookupPeerProcess } from './process-identity.js';

const execFileAsync = promisify(execFile);

// Real-loopback test: lsof must agree on which side is local. Skipped where
// lsof isn't the lookup primitive (Windows uses netstat, covered elsewhere).
const isUnix = platform() === 'darwin' || platform() === 'linux';

async function lsofAvailable(): Promise<boolean> {
  try {
    await execFileAsync('lsof', ['-v'], { timeout: 1000 });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!isUnix)('lookupPeerProcess against a real localhost connection', () => {
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

  test('identifies the connecting child process — not the server itself', async () => {
    if (!(await lsofAvailable())) return; // belt-and-suspenders: skip if lsof is missing

    server = createServer();
    const connection = new Promise<Socket>((resolve) => {
      server!.once('connection', (sock) => {
        acceptedSocket = sock;
        resolve(sock);
      });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;

    // Spawn a child node that opens a TCP connection and holds it. The child
    // prints "READY <pid> <localPort>" once connected, then blocks on stdin
    // so we can measure the connection deterministically.
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

    const ready = await new Promise<{ pid: number; localPort: number }>((resolve, reject) => {
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

  test('returns null when the peer is THIS process (defense in depth)', async () => {
    if (!(await lsofAvailable())) return;

    server = createServer();
    const connection = new Promise<Socket>((resolve) => {
      server!.once('connection', (sock) => {
        acceptedSocket = sock;
        resolve(sock);
      });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;

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
