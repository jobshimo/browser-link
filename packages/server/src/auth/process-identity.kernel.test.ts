import { describe, expect, test } from 'vitest';
import { isAllowedBrowser, isAllowedExecutablePath } from './allowlist.js';
import {
  buildCimIdentityScript,
  LOOKUP_TIMEOUT_MS,
  lookupPeerProcessDetailed,
  type PeerLookupDeps,
} from './process-identity.js';
import {
  buildKernelOwnerScript,
  KERNEL_MAX_PROCESSES,
  parseKernelOwnerReply,
} from './windows-tcp-owner.js';

// The Windows lookup reads the kernel TCP table and the owner's token in one
// PowerShell (the "kernel" source); the netstat + CIM lookup is its fallback.
// Every case here goes through the public lookup with the exec seam faking
// the PowerShell reply.

const SELF = process.pid;
const PEER = 1234;
const PEER_PORT = 54321;
const SERVER_PORT = 17529;
const SERVER = { host: '127.0.0.1', port: SERVER_PORT };
const MY_SID = 'S-1-5-21-1-2-3-1001';
const OTHER_SID = 'S-1-5-21-1-2-3-1002';
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
// nvm on Windows starts node through a junction; the kernel reports the
// real file behind it.
const NODE_JUNCTION = 'C:\\nvm4w\\nodejs\\node.exe';
const NODE_REAL = 'C:\\Users\\me\\AppData\\Local\\nvm\\v24.16.0\\node.exe';

interface Row {
  state: number;
  la: string;
  lp: number;
  ra: string;
  rp: number;
  pid: number;
}
interface Proc {
  pid: number;
  name: string | null;
  path: string | null;
  sid: string | null;
  err: string | null;
}
const peerRow = (over: Partial<Row> = {}): Row => ({
  state: 5,
  la: '127.0.0.1',
  lp: PEER_PORT,
  ra: '127.0.0.1',
  rp: SERVER_PORT,
  pid: PEER,
  ...over,
});
const proc = (over: Partial<Proc> = {}): Proc => ({
  pid: PEER,
  name: 'chrome.exe',
  path: CHROME_PATH,
  sid: MY_SID,
  err: null,
  ...over,
});
const selfProc = (over: Partial<Proc> = {}): Proc =>
  proc({ pid: SELF, name: 'node.exe', path: NODE_REAL, ...over });
const reply = (
  rows: Row[] = [peerRow()],
  procs: Proc[] = [selfProc(), proc()],
  rowsAfter: Row[] = rows,
): string => JSON.stringify({ v: 1, rows, rowsAfter, procs }) + '\r\n';

// The fallback's answers, the same shapes the netstat + CIM tests use.
const NETSTAT = [
  '  Proto  Local Address          Foreign Address        State           PID',
  `  TCP    127.0.0.1:${PEER_PORT}        127.0.0.1:${SERVER_PORT}        ESTABLISHED     ${PEER}`,
  `  TCP    127.0.0.1:${SERVER_PORT}        127.0.0.1:${PEER_PORT}        ESTABLISHED     ${SELF}`,
].join('\r\n');
const cimRow = (pid: number, name: string, path: string, user = 'me') => ({
  pid,
  name,
  path,
  rv: 0,
  domain: 'PC',
  user,
});
const cim = (peerUser = 'me', peerPath = CHROME_PATH) =>
  JSON.stringify([
    cimRow(PEER, 'chrome.exe', peerPath, peerUser),
    cimRow(SELF, 'node.exe', NODE_JUNCTION),
  ]);

const timedOut = () =>
  Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM', code: null });
const missing = () =>
  Object.assign(new Error('spawn powershell ENOENT'), { code: 'ENOENT', killed: false });

type Answer = string | Error;
interface Call {
  file: string;
  args: readonly string[];
  timeout: number;
}
const isKernel = (file: string, args: readonly string[]) =>
  file === 'powershell' && args.some((a) => a.includes('BrowserLinkPeer'));

/** Win32 deps: `kernel` answers the kernel-source PowerShell, the other keys
 * answer the fallback's commands by program name. Calls and log lines are
 * recorded. */
function win(
  answers: { kernel: Answer; netstat?: Answer; powershell?: Answer },
  calls: Call[] = [],
  logs: string[] = [],
): PeerLookupDeps {
  return {
    platform: 'win32',
    sleep: () => Promise.resolve(),
    log: (line) => logs.push(line),
    execFile: (file, args, options) => {
      const name = isKernel(file, args) ? 'kernel' : file;
      calls.push({ file: name, args, timeout: options.timeout });
      const answer = (answers as Record<string, Answer | undefined>)[name];
      if (answer === undefined) return Promise.reject(new Error(`unexpected command ${name}`));
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve({ stdout: answer });
    },
  };
}

const lookup = (deps: PeerLookupDeps, withExecutablePath = false) =>
  lookupPeerProcessDetailed('127.0.0.1', PEER_PORT, deps, {
    serverEndpoint: SERVER,
    withExecutablePath,
  });

describe('Windows peer lookup: the kernel TCP table source', () => {
  test('a same-user owner is identified by one PowerShell, without netstat or CIM', async () => {
    const calls: Call[] = [];
    const logs: string[] = [];
    const res = await lookup(win({ kernel: reply() }, calls, logs));
    expect(res).toEqual({ ok: true, peer: { pid: PEER, binaryName: 'chrome.exe' } });
    expect(calls.map((c) => c.file)).toEqual(['kernel']);
    expect(logs).toEqual([]);
  });

  test('it runs as a bounded, non-interactive PowerShell with the validated port and server pid', async () => {
    const calls: Call[] = [];
    await lookup(win({ kernel: reply() }, calls));
    expect(calls[0]?.timeout).toBe(LOOKUP_TIMEOUT_MS);
    expect(calls[0]?.args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
    expect(calls[0]?.args[3]).toBe(buildKernelOwnerScript(PEER_PORT, SELF));
  });

  test('the executable path is the one the kernel reports, when asked for', async () => {
    const res = await lookup(win({ kernel: reply() }), true);
    expect(res).toEqual({
      ok: true,
      peer: { pid: PEER, binaryName: 'chrome.exe', executablePath: CHROME_PATH },
    });
  });

  test('a peer of another user is refused (owner-mismatch), and the fallback is not asked', async () => {
    const calls: Call[] = [];
    // The fallback would accept this peer: the kernel's refusal must stand.
    const res = await lookup(
      win(
        {
          kernel: reply(undefined, [selfProc(), proc({ sid: OTHER_SID })]),
          netstat: NETSTAT,
          powershell: cim(),
        },
        calls,
      ),
    );
    expect(res).toEqual({ ok: false, cause: 'owner-mismatch' });
    expect(calls.map((c) => c.file)).toEqual(['kernel']);
  });

  test('a program with another name is returned with that name, which the gate refuses', async () => {
    const res = await lookup(
      win({
        kernel: reply(undefined, [selfProc(), proc({ name: 'evil.exe', path: 'C:\\x\\evil.exe' })]),
      }),
    );
    expect(res).toEqual({ ok: true, peer: { pid: PEER, binaryName: 'evil.exe' } });
    if (res.ok) expect(isAllowedBrowser(res.peer.binaryName, 'win32')).toBe(false);
  });

  test('strict mode by path gets the real file behind a junction; a junction entry matches once resolved', async () => {
    const res = await lookup(
      win({ kernel: reply(undefined, [selfProc(), proc({ name: 'node.exe', path: NODE_REAL })]) }),
      true,
    );
    expect(res).toMatchObject({ ok: true, peer: { executablePath: NODE_REAL } });
    if (!res.ok) return;
    const resolve = (p: string) => (p === NODE_JUNCTION ? NODE_REAL : null);
    expect(isAllowedExecutablePath(res.peer.executablePath, [NODE_REAL], 'win32', resolve)).toBe(
      true,
    );
    // An entry through the junction matches through its resolution...
    expect(
      isAllowedExecutablePath(res.peer.executablePath, [NODE_JUNCTION], 'win32', resolve),
    ).toBe(true);
    // ...and not when the junction points at another file.
    expect(
      isAllowedExecutablePath(res.peer.executablePath, [NODE_JUNCTION], 'win32', () => 'C:\\x.exe'),
    ).toBe(false);
  });

  test('two live owners of the peer endpoint are refused (endpoint-ambiguous), no fallback', async () => {
    const calls: Call[] = [];
    const rows = [peerRow(), peerRow({ pid: 999 })];
    const res = await lookup(
      win(
        { kernel: reply(rows, [selfProc(), proc(), proc({ pid: 999 })]), netstat: NETSTAT },
        calls,
      ),
    );
    expect(res).toEqual({ ok: false, cause: 'endpoint-ambiguous' });
    expect(calls.map((c) => c.file)).toEqual(['kernel']);
  });

  test('the server as its own peer is refused (self)', async () => {
    const res = await lookup(win({ kernel: reply([peerRow({ pid: SELF })]), netstat: NETSTAT }));
    expect(res).toEqual({ ok: false, cause: 'self' });
  });

  test('a row in state 0, which netstat does not print, is the owner', async () => {
    const res = await lookup(win({ kernel: reply([peerRow({ state: 0 })]) }));
    expect(res).toEqual({ ok: true, peer: { pid: PEER, binaryName: 'chrome.exe' } });
  });

  test('a TIME_WAIT row (pid 0) and a row to another remote end are not owners', async () => {
    const rows = [peerRow({ pid: 0, state: 11 }), peerRow({ pid: 777, rp: 9999 }), peerRow()];
    const res = await lookup(win({ kernel: reply(rows) }));
    expect(res).toEqual({ ok: true, peer: { pid: PEER, binaryName: 'chrome.exe' } });
  });

  test('an IPv6 loopback row matches the normalised endpoint', async () => {
    const rows = [peerRow({ la: '::1', ra: '::1' })];
    const res = await lookup(win({ kernel: reply(rows) }));
    expect(res).toEqual({ ok: true, peer: { pid: PEER, binaryName: 'chrome.exe' } });
  });

  test('a row on another local address is not the peer', async () => {
    const calls: Call[] = [];
    const rows = [peerRow({ la: '10.0.0.5' })];
    const res = await lookup(
      win({ kernel: reply(rows), netstat: NETSTAT, powershell: cim() }, calls),
    );
    // Not listed by the kernel: the fallback decides (here it finds it).
    expect(calls.map((c) => c.file)).toEqual(['kernel', 'netstat', 'powershell']);
    expect(res).toEqual({ ok: true, peer: { pid: PEER, binaryName: 'chrome.exe' } });
  });
});

describe('Windows peer lookup: falling back to netstat + CIM, with one log line', () => {
  const fallbackCase = async (kernel: Answer, withPath = false) => {
    const calls: Call[] = [];
    const logs: string[] = [];
    const res = await lookup(
      win({ kernel, netstat: NETSTAT, powershell: cim() }, calls, logs),
      withPath,
    );
    return { res, calls: calls.map((c) => c.file), logs };
  };
  const accepted = { ok: true, peer: { pid: PEER, binaryName: 'chrome.exe' } };

  test('Add-Type blocked (Constrained Language Mode, AppLocker): fallback used and logged', async () => {
    const { res, calls, logs } = await fallbackCase('{"v":1,"stage":"add-type"}\r\n');
    expect(res).toEqual(accepted);
    expect(calls).toEqual(['kernel', 'netstat', 'powershell']);
    expect(logs).toEqual([
      '[browser-link] Windows peer lookup: the kernel TCP table source failed at stage add-type (cause: command-failed:add-type); checking with netstat + CIM instead.',
    ]);
  });

  test('an unparsable reply: fallback used and logged', async () => {
    const { res, calls, logs } = await fallbackCase('Add-Type : Cannot add type.\r\n');
    expect(res).toEqual(accepted);
    expect(calls).toEqual(['kernel', 'netstat', 'powershell']);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('stage reply (cause: parse-miss)');
  });

  test('a PowerShell that times out: fallback used and logged', async () => {
    const { res, calls, logs } = await fallbackCase(timedOut());
    expect(res).toEqual(accepted);
    expect(calls).toEqual(['kernel', 'netstat', 'powershell']);
    expect(logs[0]).toContain('stage powershell (cause: timeout)');
  });

  test('PowerShell missing for the kernel source (ENOENT): fallback used and logged', async () => {
    const { res, logs } = await fallbackCase(missing());
    expect(logs[0]).toContain('stage powershell (cause: command-missing)');
    expect(res).toEqual(accepted);
  });

  test('a failing native call (stage tcp-table / native) falls back', async () => {
    for (const stage of ['tcp-table', 'native']) {
      const { res, logs } = await fallbackCase(`{"v":1,"stage":"${stage}"}`);
      expect(res).toEqual(accepted);
      expect(logs[0]).toContain(`stage ${stage} (cause: command-failed:${stage})`);
    }
  });

  test('an unknown stage name is unparsable, never echoed into the log', async () => {
    const { logs } = await fallbackCase('{"v":1,"stage":"evil\\nline"}');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('stage reply (cause: parse-miss)');
    expect(logs[0]).not.toContain('evil');
  });

  test('the endpoint not in the kernel table: fallback', async () => {
    const { res, logs } = await fallbackCase(reply([]));
    expect(res).toEqual(accepted);
    expect(logs[0]).toContain('stage endpoint (cause: endpoint-not-listed)');
  });

  test('another owner in the second read (pid reused or connection gone): fallback', async () => {
    const { res, logs } = await fallbackCase(reply(undefined, undefined, [peerRow({ pid: 4321 })]));
    expect(res).toEqual(accepted);
    expect(logs[0]).toContain('stage table-changed');
  });

  test('a token that cannot be read (an elevated process): fallback, which still checks the owner', async () => {
    const calls: Call[] = [];
    const logs: string[] = [];
    const res = await lookup(
      win(
        {
          kernel: reply(undefined, [selfProc(), proc({ sid: null, err: 'token 5' })]),
          netstat: NETSTAT,
          powershell: cim('someone-else'),
        },
        calls,
        logs,
      ),
    );
    expect(logs[0]).toContain('stage token (cause: owner-unreadable)');
    expect(res).toEqual({ ok: false, cause: 'owner-mismatch' });
  });

  test('the server token unreadable, or the peer process gone: fallback', async () => {
    const a = await fallbackCase(reply(undefined, [selfProc({ sid: null }), proc()]));
    expect(a.logs[0]).toContain('stage server-token (cause: owner-unreadable)');
    const b = await fallbackCase(reply(undefined, [selfProc()]));
    expect(b.logs[0]).toContain('stage process (cause: peer-row-missing)');
    expect(b.res).toEqual(accepted);
  });

  test('strict mode with an unreadable image path: fallback reads it through CIM', async () => {
    const { res, logs } = await fallbackCase(
      reply(undefined, [selfProc(), proc({ path: null, err: 'path 31' })]),
      true,
    );
    expect(logs[0]).toContain('stage image-path (cause: path-unreadable)');
    expect(res).toEqual({
      ok: true,
      peer: { pid: PEER, binaryName: 'chrome.exe', executablePath: CHROME_PATH },
    });
  });

  test('without strict mode an unreadable image path does not matter', async () => {
    const { res, calls } = await fallbackCase(
      reply(undefined, [selfProc(), proc({ path: null, err: 'path 31' })]),
    );
    expect(res).toEqual(accepted);
    expect(calls).toEqual(['kernel']);
  });

  test('the fallback refuses what it always refused: a peer of another user', async () => {
    const calls: Call[] = [];
    const res = await lookup(
      win(
        { kernel: '{"v":1,"stage":"add-type"}', netstat: NETSTAT, powershell: cim('other') },
        calls,
      ),
    );
    expect(res).toEqual({ ok: false, cause: 'owner-mismatch' });
  });

  test('a spent total budget ends the lookup (deadline), no fallback', async () => {
    const calls: Call[] = [];
    let t = 0;
    const deps = win({ kernel: timedOut(), netstat: NETSTAT, powershell: cim() }, calls);
    const inner = deps.execFile!;
    const res = await lookupPeerProcessDetailed(
      '127.0.0.1',
      PEER_PORT,
      {
        ...deps,
        now: () => t,
        execFile: (file, args, options) => {
          t += options.timeout;
          return inner(file, args, options);
        },
      },
      { serverEndpoint: SERVER, totalTimeoutMs: 3000 },
    );
    expect(res).toMatchObject({ ok: false, cause: 'deadline' });
    expect(calls.map((c) => [c.file, c.timeout])).toEqual([['kernel', 3000]]);
  });

  test('the fallback CIM script is unchanged', async () => {
    const calls: Call[] = [];
    await lookup(win({ kernel: timedOut(), netstat: NETSTAT, powershell: cim() }, calls));
    expect(calls[2]?.args[3]).toBe(buildCimIdentityScript(PEER, SELF));
  });
});

describe('buildKernelOwnerScript / parseKernelOwnerReply', () => {
  test('the script refuses a port or pid that is not a safe positive integer', () => {
    expect(() => buildKernelOwnerScript(0, SELF)).toThrow();
    expect(() => buildKernelOwnerScript(70000, SELF)).toThrow();
    expect(() => buildKernelOwnerScript(PEER_PORT, 1.5)).toThrow();
    expect(() => buildKernelOwnerScript(PEER_PORT, -1)).toThrow();
  });

  test('the script reads every state of both address families and caps the processes it opens', () => {
    const s = buildKernelOwnerScript(PEER_PORT, SELF);
    expect(s).toContain('GetExtendedTcpTable');
    expect(s).toContain('Table(2, port');
    expect(s).toContain('Table(23, port');
    expect(s).toContain('QueryFullProcessImageNameW');
    expect(s).toContain('OpenProcessToken');
    expect(s).toContain(`pids.Count > ${String(KERNEL_MAX_PROCESSES)}`);
    expect(s).toContain(`Run(${String(PEER_PORT)}, ${String(SELF)})`);
  });

  test('the reply parser accepts the two shapes and nothing else', () => {
    expect(parseKernelOwnerReply('{"v":1,"stage":"add-type"}\r\n')).toEqual({
      kind: 'stage',
      stage: 'add-type',
    });
    expect(parseKernelOwnerReply(reply())).toMatchObject({ kind: 'table' });
    for (const bad of [
      '',
      'null',
      '[]',
      '{"v":2,"stage":"add-type"}',
      '{"v":1,"stage":"other"}',
      '{"v":1,"rows":[],"procs":[]}',
      '{"v":1,"rows":[{"state":5}],"rowsAfter":[],"procs":[]}',
      '{"v":1,"rows":[],"rowsAfter":[],"procs":[{"pid":"1"}]}',
      JSON.stringify({ v: 1, rows: [peerRow({ lp: 70000 })], rowsAfter: [], procs: [] }),
      JSON.stringify({ v: 1, rows: [peerRow({ pid: -1 })], rowsAfter: [], procs: [] }),
    ]) {
      expect(parseKernelOwnerReply(bad), bad).toBeNull();
    }
  });
});
