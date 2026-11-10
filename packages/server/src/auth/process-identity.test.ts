import { describe, expect, test } from 'vitest';
import { userInfo } from 'node:os';
import {
  buildCimIdentityScript,
  classifyLookupError,
  decodeLsofString,
  isValidPid,
  lookupPeerProcess,
  lookupPeerProcessDetailed,
  type PeerLookupDeps,
  parseCimIdentity,
  parseLsofExecutablePath,
  parseLsofOutput,
  parseNetstatForLocal,
  parseTasklistVerbose,
} from './process-identity.js';

describe('decodeLsofString', () => {
  test('decodes the \\xHH escapes lsof uses for spaces and tabs', () => {
    expect(decodeLsofString('Google\\x20Chrome\\x20Helper')).toBe('Google Chrome Helper');
    expect(decodeLsofString('python\\x093.11')).toBe('python\t3.11');
  });

  test('leaves a name without escapes untouched', () => {
    expect(decodeLsofString('chrome')).toBe('chrome');
  });
});

describe('parseLsofOutput', () => {
  // Regression for the loopback ambiguity bug: on a localhost connection,
  // lsof -i @host:port matches BOTH ends of the socket — the peer's local
  // side AND the server's remote side. The parser must pick the entry whose
  // local endpoint matches the queried host:port, never the other one.
  test('returns the peer whose local endpoint matches host:port (loopback)', () => {
    const out = [
      'p1061',
      'cnode',
      'u501',
      'n127.0.0.1:17529->127.0.0.1:64836',
      'p3532',
      'cGoogle\\x20Chrome\\x20Helper',
      'u501',
      'n127.0.0.1:64836->127.0.0.1:17529',
      '',
    ].join('\n');
    expect(parseLsofOutput(out, '127.0.0.1', 64836)).toEqual({
      pid: 3532,
      binaryName: 'Google Chrome Helper',
      uid: 501,
    });
  });

  test('does not flip when the peer prints first', () => {
    const out = [
      'p3532',
      'cGoogle\\x20Chrome\\x20Helper',
      'u501',
      'n127.0.0.1:64836->127.0.0.1:17529',
      'p1061',
      'cnode',
      'u501',
      'n127.0.0.1:17529->127.0.0.1:64836',
      '',
    ].join('\n');
    expect(parseLsofOutput(out, '127.0.0.1', 64836)).toEqual({
      pid: 3532,
      binaryName: 'Google Chrome Helper',
      uid: 501,
    });
  });

  test('returns the single owner in a non-loopback dump', () => {
    const out = ['p42', 'cchrome', 'u1000', 'n10.0.0.5:54321->1.2.3.4:80', ''].join('\n');
    expect(parseLsofOutput(out, '10.0.0.5', 54321)).toEqual({
      pid: 42,
      binaryName: 'chrome',
      uid: 1000,
    });
  });

  test('reads the u field (uid) and reports null when it is absent', () => {
    const out = ['p42', 'cchrome', 'n127.0.0.1:54321->127.0.0.1:17529', ''].join('\n');
    expect(parseLsofOutput(out, '127.0.0.1', 54321)).toEqual({
      pid: 42,
      binaryName: 'chrome',
      uid: null,
    });
  });

  test('a malformed u field reads as no uid', () => {
    const out = ['p42', 'cchrome', 'uroot', 'n127.0.0.1:54321->127.0.0.1:17529', ''].join('\n');
    expect(parseLsofOutput(out, '127.0.0.1', 54321)?.uid).toBeNull();
  });

  test('returns null when no entry has a local endpoint matching host:port', () => {
    const out = ['p1', 'cchrome', 'n127.0.0.1:9999->127.0.0.1:17529', ''].join('\n');
    expect(parseLsofOutput(out, '127.0.0.1', 64836)).toBeNull();
  });

  test('fails closed when two distinct PIDs claim the same local endpoint', () => {
    // Kernel-impossible in practice but defensive: never guess in the auth path.
    const out = [
      'p1',
      'cnode',
      'n127.0.0.1:64836->127.0.0.1:17529',
      'p2',
      'cchrome',
      'n127.0.0.1:64836->127.0.0.1:17529',
      '',
    ].join('\n');
    expect(parseLsofOutput(out, '127.0.0.1', 64836)).toBeNull();
  });

  test('returns null on empty output', () => {
    expect(parseLsofOutput('', '127.0.0.1', 1)).toBeNull();
  });

  test('returns null when the command line is missing', () => {
    const out = ['p1234', 'n127.0.0.1:64836->127.0.0.1:17529', ''].join('\n');
    expect(parseLsofOutput(out, '127.0.0.1', 64836)).toBeNull();
  });

  test('returns null when the n field is missing', () => {
    const out = ['p1234', 'cchrome', ''].join('\n');
    expect(parseLsofOutput(out, '127.0.0.1', 64836)).toBeNull();
  });

  test('ignores malformed pid lines', () => {
    const out = ['pNOT_A_NUMBER', 'cchrome', 'n127.0.0.1:64836->127.0.0.1:17529', ''].join('\n');
    expect(parseLsofOutput(out, '127.0.0.1', 64836)).toBeNull();
  });

  test('skips n lines without an arrow (e.g. LISTEN sockets that leaked through)', () => {
    const out = ['p1', 'cnginx', 'n127.0.0.1:64836', ''].join('\n');
    expect(parseLsofOutput(out, '127.0.0.1', 64836)).toBeNull();
  });
});

describe('parseLsofExecutablePath', () => {
  test('returns the first txt name (the program itself)', () => {
    const out = [
      'p3532',
      'ftxt',
      'n/Applications/Google\\x20Chrome.app/Contents/MacOS/Google\\x20Chrome',
      'ftxt',
      'n/usr/lib/dyld',
      '',
    ].join('\n');
    expect(parseLsofExecutablePath(out)).toBe(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    );
  });

  test('ignores names that belong to another fd type', () => {
    const out = ['p42', 'fcwd', 'n/home/me', 'ftxt', 'n/opt/google/chrome/chrome', ''].join('\n');
    expect(parseLsofExecutablePath(out)).toBe('/opt/google/chrome/chrome');
  });

  test('returns null when there is no txt entry or the name is not absolute', () => {
    expect(parseLsofExecutablePath('')).toBeNull();
    expect(parseLsofExecutablePath(['p42', 'fcwd', 'n/home/me', ''].join('\n'))).toBeNull();
    expect(parseLsofExecutablePath(['p42', 'ftxt', 'nchrome', ''].join('\n'))).toBeNull();
  });
});

describe('parseNetstatForLocal', () => {
  const sample = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    127.0.0.1:54321        127.0.0.1:17529        ESTABLISHED     1234
  TCP    127.0.0.1:17529        127.0.0.1:54321        ESTABLISHED     9999
  TCP    0.0.0.0:445            0.0.0.0:0              LISTENING       4
`;

  test('returns the PID whose LOCAL endpoint matches host:port', () => {
    expect(parseNetstatForLocal(sample, '127.0.0.1', 54321)).toBe(1234);
  });

  test('does not return the server-side PID (host:port is the server)', () => {
    expect(parseNetstatForLocal(sample, '127.0.0.1', 17529)).toBe(9999);
  });

  test('returns null when nothing matches', () => {
    expect(parseNetstatForLocal(sample, '127.0.0.1', 11111)).toBeNull();
  });

  test('rejects a local endpoint owned by two different PIDs', () => {
    const twoOwners = `${sample}  TCP    127.0.0.1:54321        127.0.0.1:17600        ESTABLISHED     5678\n`;
    expect(parseNetstatForLocal(twoOwners, '127.0.0.1', 54321)).toBeNull();
  });

  test('accepts the same PID listed twice for one local endpoint', () => {
    const twice = `${sample}  TCP    127.0.0.1:54321        127.0.0.1:17600        ESTABLISHED     1234\n`;
    expect(parseNetstatForLocal(twice, '127.0.0.1', 54321)).toBe(1234);
  });

  /*
   * Real `netstat -ano -p TCP` lines from Windows 11 (2026-11-10), right
   * after a full test run: a peer at 127.0.0.1:60554 connected to a server
   * listening on 127.0.0.1:1042. The TIME_WAIT line is a real line whose
   * local port was set to 60554 to model a stale row on the same endpoint.
   */
  describe('stale TIME_WAIT rows and the server endpoint (real output)', () => {
    const SERVER = { host: '127.0.0.1', port: 1042 };
    const ESTABLISHED =
      '  TCP    127.0.0.1:60554        127.0.0.1:1042         ESTABLISHED     46344';
    const STALE = '  TCP    127.0.0.1:60554        127.0.0.1:52878        TIME_WAIT       0';
    const OTHER_FOREIGN =
      '  TCP    127.0.0.1:60554        127.0.0.1:65388        ESTABLISHED     12244';

    test('the same local endpoint as TIME_WAIT 0 and as ESTABLISHED <pid> is that pid', () => {
      const out = [STALE, ESTABLISHED].join('\r\n');
      expect(parseNetstatForLocal(out, '127.0.0.1', 60554)).toBe(46344);
      expect(parseNetstatForLocal(out, '127.0.0.1', 60554, SERVER)).toBe(46344);
    });

    test('only a TIME_WAIT 0 row is no owner (PID 0 is never an owner)', () => {
      expect(parseNetstatForLocal(STALE, '127.0.0.1', 60554)).toBeNull();
    });

    test('a row for the same local port to another foreign endpoint is not counted', () => {
      const out = [OTHER_FOREIGN, ESTABLISHED].join('\r\n');
      expect(parseNetstatForLocal(out, '127.0.0.1', 60554, SERVER)).toBe(46344);
      expect(parseNetstatForLocal(OTHER_FOREIGN, '127.0.0.1', 60554, SERVER)).toBeNull();
    });

    test('two live pids on the same local and foreign endpoint stay ambiguous', () => {
      const out = [ESTABLISHED, ESTABLISHED.replace('46344', '777')].join('\r\n');
      expect(parseNetstatForLocal(out, '127.0.0.1', 60554, SERVER)).toBeNull();
    });
  });
});

describe('isValidPid', () => {
  test('accepts a positive safe integer only', () => {
    expect(isValidPid(1234)).toBe(true);
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(isValidPid(bad)).toBe(false);
    }
  });
});

describe('buildCimIdentityScript', () => {
  test('puts both validated pids in the CIM filter and calls GetOwner', () => {
    const script = buildCimIdentityScript(1234, 5678);
    expect(script).toContain("-Filter 'ProcessId = 1234 OR ProcessId = 5678'");
    expect(script).toContain('GetOwner');
    expect(script).toContain('ExecutablePath');
  });

  test('refuses a pid that is not a positive safe integer before building any string', () => {
    for (const bad of [Number.NaN, 1.5, -3, 0, 2 ** 53]) {
      expect(() => buildCimIdentityScript(bad, 5678)).toThrow();
      expect(() => buildCimIdentityScript(1234, bad)).toThrow();
    }
  });
});

describe('parseCimIdentity', () => {
  test('reads the rows PowerShell printed as JSON (BOM tolerated)', () => {
    const out =
      '\uFEFF[{"pid":30068,"name":"chrome.exe","path":"C:\\\\Program Files\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe","rv":0,"domain":"PC","user":"me"}]\r\n';
    expect(parseCimIdentity(out)).toEqual([
      {
        pid: 30068,
        name: 'chrome.exe',
        path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        rv: 0,
        domain: 'PC',
        user: 'me',
      },
    ]);
  });

  test('returns null for output that is not the expected JSON array', () => {
    expect(parseCimIdentity('')).toBeNull();
    expect(parseCimIdentity('not json')).toBeNull();
    expect(parseCimIdentity('{"pid":1}')).toBeNull();
    expect(
      parseCimIdentity('[{"pid":"1","name":"a","path":"","rv":0,"domain":"","user":""}]'),
    ).toBe(null);
  });
});

describe('parseTasklistVerbose', () => {
  test('reads the image name and the DOMAIN\\user owner from /V CSV output', () => {
    const out =
      '"chrome.exe","30068","Console","1","449,008 K","Running","PC\\me","0:01:29","Title, with ""quotes"""\r\n';
    expect(parseTasklistVerbose(out)).toEqual({ binaryName: 'chrome.exe', owner: 'PC\\me' });
  });

  test('an owner that is not DOMAIN\\user (N/A, localised N/D) reads as unknown', () => {
    const out = '"System","4","Services","0","6,448 K","Unknown","N/A","0:10:09","N/A"';
    expect(parseTasklistVerbose(out)).toEqual({ binaryName: 'System', owner: null });
  });

  test('returns null when no process matched (INFO line, empty output)', () => {
    expect(
      parseTasklistVerbose('INFO: No tasks are running which match the specified criteria.\r\n'),
    ).toBeNull();
    expect(parseTasklistVerbose('')).toBeNull();
  });
});

describe('classifyLookupError', () => {
  test('a command execFile cannot find (ENOENT) is command-missing', () => {
    expect(
      classifyLookupError(Object.assign(new Error('spawn lsof ENOENT'), { code: 'ENOENT' })),
    ).toBe('command-missing');
  });
});

describe('lookupPeerProcessDetailed: same OS user, fail closed', () => {
  const SELF = process.pid;
  const PEER = 1234;
  const NETSTAT = [
    '  Proto  Local Address          Foreign Address        State           PID',
    `  TCP    127.0.0.1:54321        127.0.0.1:17529        ESTABLISHED     ${PEER}`,
    `  TCP    127.0.0.1:17529        127.0.0.1:54321        ESTABLISHED     ${SELF}`,
  ].join('\r\n');
  const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const lsofFor = (uid: number | null) =>
    [
      'p3532',
      'cchrome',
      ...(uid === null ? [] : [`u${uid}`]),
      'n127.0.0.1:64836->127.0.0.1:17529',
      '',
    ].join('\n');

  interface Row {
    pid: number;
    name: string;
    path: string;
    rv: number;
    domain: string;
    user: string;
  }
  const row = (over: Partial<Row> = {}): Row => ({
    pid: PEER,
    name: 'chrome.exe',
    path: CHROME_PATH,
    rv: 0,
    domain: 'PC',
    user: 'me',
    ...over,
  });
  const selfRow = (over: Partial<Row> = {}): Row =>
    row({ pid: SELF, name: 'node.exe', path: 'C:\\node\\node.exe', ...over });
  const cim = (...rows: Row[]) => JSON.stringify(rows) + '\r\n';

  type ExecFile = NonNullable<PeerLookupDeps['execFile']>;
  type Call = { file: string; args: readonly string[] };
  type Answer = string | Error | ((args: readonly string[]) => string | Error);
  /** Fake execFile: answers by the program name, recording every call. */
  function fakeExecFile(answers: Record<string, Answer>, calls: Call[] = []): ExecFile {
    return (file, args) => {
      calls.push({ file, args });
      const entry = answers[file];
      if (entry === undefined) return Promise.reject(new Error(`unexpected command ${file}`));
      const answer = typeof entry === 'function' ? entry(args) : entry;
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve({ stdout: answer });
    };
  }
  /** The shapes child_process.execFile rejects with. */
  const timedOut = () =>
    Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM', code: null });
  const exitWith = (code: number, stderr = '') =>
    Object.assign(new Error('Command failed'), { killed: false, signal: null, code, stderr });
  const missing = (file: string) =>
    Object.assign(new Error(`spawn ${file} ENOENT`), { code: 'ENOENT' });
  const tasklistRow = (name: string, pid: number, owner: string) =>
    `"${name}","${pid}","Console","1","10 K","Running","${owner}","0:00:01","N/A"\r\n`;
  /** tasklist answering per `/FI "PID eq <n>"`. */
  const tasklistBy = (owners: Record<number, string>) => (args: readonly string[]) => {
    const pid = Number((args[args.length - 1] ?? '').replace('PID eq ', ''));
    const owner = owners[pid];
    return owner === undefined
      ? 'INFO: No tasks are running which match the specified criteria.\r\n'
      : tasklistRow(pid === SELF ? 'node.exe' : 'chrome.exe', pid, owner);
  };
  const win = (answers: Record<string, Answer>, calls?: Call[]): PeerLookupDeps => ({
    platform: 'win32',
    execFile: fakeExecFile(answers, calls),
  });
  const unix = (
    os: NodeJS.Platform,
    answers: Record<string, Answer>,
    uid = 501,
    calls?: Call[],
  ): PeerLookupDeps => ({
    platform: os,
    execFile: fakeExecFile(answers, calls),
    getuid: () => uid,
  });

  // --- existing behaviour: a same-user allowlisted browser is accepted ---

  test('win32: a same-user browser is identified (netstat + one CIM call)', async () => {
    const res = await lookupPeerProcessDetailed(
      '127.0.0.1',
      54321,
      win({ netstat: NETSTAT, powershell: cim(row(), selfRow()) }),
    );
    expect(res).toEqual({ ok: true, peer: { pid: PEER, binaryName: 'chrome.exe' } });
  });

  test('linux: a same-user browser is identified (lsof uid === getuid)', async () => {
    const res = await lookupPeerProcessDetailed(
      '127.0.0.1',
      64836,
      unix('linux', { lsof: lsofFor(501) }),
    );
    expect(res).toEqual({ ok: true, peer: { pid: 3532, binaryName: 'chrome' } });
  });

  test('darwin: a same-user browser is identified (lsof uid === getuid)', async () => {
    const res = await lookupPeerProcessDetailed(
      '127.0.0.1',
      64836,
      unix('darwin', { lsof: lsofFor(501) }),
    );
    expect(res).toEqual({ ok: true, peer: { pid: 3532, binaryName: 'chrome' } });
  });

  // --- condition 1: the owner check fails closed ---

  test('win32: GetOwner returning 2 for the peer rejects (owner-unreadable)', async () => {
    const res = await lookupPeerProcessDetailed(
      '127.0.0.1',
      54321,
      win({ netstat: NETSTAT, powershell: cim(row({ rv: 2, domain: '', user: '' }), selfRow()) }),
    );
    expect(res).toEqual({ ok: false, cause: 'owner-unreadable' });
  });

  test('win32: ReturnValue 0 with an empty user rejects (owner-unreadable)', async () => {
    const res = await lookupPeerProcessDetailed(
      '127.0.0.1',
      54321,
      win({ netstat: NETSTAT, powershell: cim(row({ user: '' }), selfRow()) }),
    );
    expect(res).toEqual({ ok: false, cause: 'owner-unreadable' });
  });

  test('win32: an unreadable owner of the server itself rejects (owner-unreadable)', async () => {
    const res = await lookupPeerProcessDetailed(
      '127.0.0.1',
      54321,
      win({ netstat: NETSTAT, powershell: cim(row(), selfRow({ rv: 8, domain: '', user: '' })) }),
    );
    expect(res).toEqual({ ok: false, cause: 'owner-unreadable' });
  });

  test('win32: a peer that vanished before the CIM call is peer-row-missing', async () => {
    const res = await lookupPeerProcessDetailed(
      '127.0.0.1',
      54321,
      win({ netstat: NETSTAT, powershell: cim(selfRow()) }),
    );
    expect(res).toEqual({ ok: false, cause: 'peer-row-missing' });
  });

  test('win32: a CIM reply without the server row is server-row-missing', async () => {
    const res = await lookupPeerProcessDetailed(
      '127.0.0.1',
      54321,
      win({ netstat: NETSTAT, powershell: cim(row()) }),
    );
    expect(res).toEqual({ ok: false, cause: 'server-row-missing' });
  });

  test('win32: a CIM reply that is not the expected JSON array is cim-unparsable', async () => {
    for (const out of ['', 'WARNING: something\r\n', JSON.stringify(row())]) {
      const res = await lookupPeerProcessDetailed(
        '127.0.0.1',
        54321,
        win({ netstat: NETSTAT, powershell: out }),
      );
      expect(res).toEqual({ ok: false, cause: 'cim-unparsable' });
    }
  });

  // --- condition 2: compared with the server's owner, by the same method ---

  test('win32: a peer owned by another account rejects (owner-mismatch)', async () => {
    const res = await lookupPeerProcessDetailed(
      '127.0.0.1',
      54321,
      win({ netstat: NETSTAT, powershell: cim(row({ user: 'other' }), selfRow()) }),
    );
    expect(res).toEqual({ ok: false, cause: 'owner-mismatch' });
  });

  test('win32: the same user name in another domain rejects (not os.userInfo().username alone)', async () => {
    const name = userInfo().username;
    const res = await lookupPeerProcessDetailed(
      '127.0.0.1',
      54321,
      win({
        netstat: NETSTAT,
        powershell: cim(row({ domain: 'OTHERPC', user: name }), selfRow({ user: name })),
      }),
    );
    expect(res).toEqual({ ok: false, cause: 'owner-mismatch' });
  });

  // --- condition 3: POSIX requests the u field and requires uid === getuid() ---

  test('posix: lsof is asked for the u field', async () => {
    const calls: Call[] = [];
    await lookupPeerProcessDetailed(
      '127.0.0.1',
      64836,
      unix('linux', { lsof: lsofFor(501) }, 501, calls),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe('lsof');
    expect(calls[0]?.args).toContain('pcun');
  });

  test('posix: a peer uid that differs from getuid() rejects (owner-mismatch)', async () => {
    const res = await lookupPeerProcessDetailed(
      '127.0.0.1',
      64836,
      unix('darwin', { lsof: lsofFor(0) }, 501),
    );
    expect(res).toEqual({ ok: false, cause: 'owner-mismatch' });
  });

  test('posix: a missing u field rejects (owner-unreadable)', async () => {
    const res = await lookupPeerProcessDetailed(
      '127.0.0.1',
      64836,
      unix('linux', { lsof: lsofFor(null) }),
    );
    expect(res).toEqual({ ok: false, cause: 'owner-unreadable' });
  });

  test('posix: a server without getuid() rejects (owner-unreadable)', async () => {
    const res = await lookupPeerProcessDetailed('127.0.0.1', 64836, {
      ...unix('linux', { lsof: lsofFor(501) }),
      getuid: () => undefined,
    });
    expect(res).toEqual({ ok: false, cause: 'owner-unreadable' });
  });

  // --- condition 4: the tasklist fallback checks the owner too ---

  test('win32: PowerShell blocked → tasklist /V accepts a same-owner peer', async () => {
    const calls: Call[] = [];
    const res = await lookupPeerProcessDetailed(
      '127.0.0.1',
      54321,
      win(
        {
          netstat: NETSTAT,
          powershell: exitWith(1),
          tasklist: tasklistBy({ [PEER]: 'PC\\me', [SELF]: 'PC\\me' }),
        },
        calls,
      ),
    );
    expect(res).toEqual({ ok: true, peer: { pid: PEER, binaryName: 'chrome.exe' } });
    const tasklistCalls = calls.filter((c) => c.file === 'tasklist');
    expect(tasklistCalls).toHaveLength(2);
    for (const c of tasklistCalls) expect(c.args).toContain('/V');
  });

  test('win32: PowerShell blocked → tasklist /V rejects a peer of another owner', async () => {
    const res = await lookupPeerProcessDetailed(
      '127.0.0.1',
      54321,
      win({
        netstat: NETSTAT,
        powershell: missing('powershell'),
        tasklist: tasklistBy({ [PEER]: 'PC\\other', [SELF]: 'PC\\me' }),
      }),
    );
    expect(res).toEqual({ ok: false, cause: 'owner-mismatch' });
  });

  test('win32: PowerShell blocked → tasklist owner N/A rejects, even when both read N/A', async () => {
    const res = await lookupPeerProcessDetailed(
      '127.0.0.1',
      54321,
      win({
        netstat: NETSTAT,
        powershell: exitWith(1),
        tasklist: tasklistBy({ [PEER]: 'N/A', [SELF]: 'N/A' }),
      }),
    );
    expect(res).toEqual({ ok: false, cause: 'owner-unreadable' });
  });

  test('win32: PowerShell blocked and tasklist timing out reports the fallback cause', async () => {
    const res = await lookupPeerProcessDetailed(
      '127.0.0.1',
      54321,
      win({ netstat: NETSTAT, powershell: exitWith(1), tasklist: timedOut() }),
    );
    expect(res).toEqual({ ok: false, cause: 'timeout' });
  });

  // --- condition 5: execFile with argument arrays, validated pids ---

  test('win32: every command is a program plus an argument array, never a shell line', async () => {
    const calls: Call[] = [];
    await lookupPeerProcessDetailed(
      '127.0.0.1',
      54321,
      win({ netstat: NETSTAT, powershell: cim(row(), selfRow()) }, calls),
    );
    expect(calls.map((c) => c.file)).toEqual(['netstat', 'powershell']);
    expect(calls[0]?.args).toEqual(['-ano', '-p', 'TCP']);
    expect(calls[1]?.args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
    expect(calls[1]?.args[3]).toBe(buildCimIdentityScript(PEER, SELF));
  });

  test('win32: a pid that is not a safe integer never reaches PowerShell (invalid-pid)', async () => {
    const calls: Call[] = [];
    const huge = NETSTAT.replace(`ESTABLISHED     ${PEER}`, 'ESTABLISHED     99999999999999999999');
    const res = await lookupPeerProcessDetailed(
      '127.0.0.1',
      54321,
      win({ netstat: huge, powershell: cim(row(), selfRow()) }, calls),
    );
    expect(res).toEqual({ ok: false, cause: 'invalid-pid' });
    expect(calls.map((c) => c.file)).toEqual(['netstat']);
  });

  test('win32: a stale TIME_WAIT 0 row on the peer endpoint does not make it ambiguous', async () => {
    const stale = `  TCP    127.0.0.1:54321        127.0.0.1:52878        TIME_WAIT       0\r\n${NETSTAT}`;
    const res = await lookupPeerProcessDetailed(
      '127.0.0.1',
      54321,
      win({ netstat: stale, powershell: cim(row(), selfRow()) }),
      { serverEndpoint: { host: '127.0.0.1', port: 17529 } },
    );
    expect(res).toEqual({ ok: true, peer: { pid: PEER, binaryName: 'chrome.exe' } });
  });

  test('win32: only a TIME_WAIT 0 row for the peer endpoint is endpoint-not-listed', async () => {
    const res = await lookupPeerProcessDetailed(
      '127.0.0.1',
      54321,
      win({ netstat: '  TCP    127.0.0.1:54321        127.0.0.1:17529        TIME_WAIT       0' }),
      { serverEndpoint: { host: '127.0.0.1', port: 17529 } },
    );
    expect(res).toEqual({ ok: false, cause: 'endpoint-not-listed' });
  });

  test('win32: a live row to another foreign endpoint is ignored when the server endpoint is known', async () => {
    const other = `${NETSTAT}\r\n  TCP    127.0.0.1:54321        127.0.0.1:17600        ESTABLISHED     777`;
    const res = await lookupPeerProcessDetailed(
      '127.0.0.1',
      54321,
      win({ netstat: other, powershell: cim(row(), selfRow()) }),
      { serverEndpoint: { host: '127.0.0.1', port: 17529 } },
    );
    expect(res).toEqual({ ok: true, peer: { pid: PEER, binaryName: 'chrome.exe' } });
  });

  test('posix: an owner of the same local endpoint to another remote is ignored when the server endpoint is known', async () => {
    const lsof = [
      'p3532',
      'cchrome',
      'u501',
      'n127.0.0.1:64836->127.0.0.1:17529',
      'p4000',
      'cnode',
      'u501',
      'n127.0.0.1:64836->10.0.0.9:443',
      '',
    ].join('\n');
    const res = await lookupPeerProcessDetailed('127.0.0.1', 64836, unix('linux', { lsof }), {
      serverEndpoint: { host: '127.0.0.1', port: 17529 },
    });
    expect(res).toEqual({ ok: true, peer: { pid: 3532, binaryName: 'chrome' } });
  });

  test('win32: a port owned by two different pids is endpoint-ambiguous', async () => {
    const calls: Call[] = [];
    const twoOwners = `${NETSTAT}\r\n  TCP    127.0.0.1:54321        127.0.0.1:17600        ESTABLISHED     777`;
    const res = await lookupPeerProcessDetailed(
      '127.0.0.1',
      54321,
      win({ netstat: twoOwners, powershell: cim(row(), selfRow()) }, calls),
    );
    expect(res).toEqual({ ok: false, cause: 'endpoint-ambiguous' });
    expect(calls.map((c) => c.file)).toEqual(['netstat']);
  });

  test('win32: the server as its own peer is refused before PowerShell (self)', async () => {
    const calls: Call[] = [];
    const res = await lookupPeerProcessDetailed(
      '127.0.0.1',
      17529,
      win({ netstat: NETSTAT, powershell: cim(row(), selfRow()) }, calls),
    );
    expect(res).toEqual({ ok: false, cause: 'self' });
    expect(calls.map((c) => c.file)).toEqual(['netstat']);
  });

  // --- strict mode: the executable path, only when asked for ---

  test('win32: the executable path comes from the same CIM call when asked for', async () => {
    const calls: Call[] = [];
    const res = await lookupPeerProcessDetailed(
      '127.0.0.1',
      54321,
      win({ netstat: NETSTAT, powershell: cim(row(), selfRow()) }, calls),
      { withExecutablePath: true },
    );
    expect(res).toEqual({
      ok: true,
      peer: { pid: PEER, binaryName: 'chrome.exe', executablePath: CHROME_PATH },
    });
    expect(calls).toHaveLength(2);
  });

  test('win32: an empty ExecutablePath rejects when asked for (path-unreadable)', async () => {
    const res = await lookupPeerProcessDetailed(
      '127.0.0.1',
      54321,
      win({ netstat: NETSTAT, powershell: cim(row({ path: '' }), selfRow()) }),
      { withExecutablePath: true },
    );
    expect(res).toEqual({ ok: false, cause: 'path-unreadable' });
  });

  test('win32: the tasklist fallback cannot read a path and rejects when asked for', async () => {
    const res = await lookupPeerProcessDetailed(
      '127.0.0.1',
      54321,
      win({
        netstat: NETSTAT,
        powershell: exitWith(1),
        tasklist: tasklistBy({ [PEER]: 'PC\\me', [SELF]: 'PC\\me' }),
      }),
      { withExecutablePath: true },
    );
    expect(res).toEqual({ ok: false, cause: 'path-unreadable' });
  });

  test('posix: the executable path is the first txt entry of a second lsof call', async () => {
    const calls: Call[] = [];
    const res = await lookupPeerProcessDetailed(
      '127.0.0.1',
      64836,
      unix(
        'linux',
        {
          lsof: (args) =>
            args.includes('txt')
              ? ['p3532', 'ftxt', 'n/opt/google/chrome/chrome', ''].join('\n')
              : lsofFor(501),
        },
        501,
        calls,
      ),
      { withExecutablePath: true },
    );
    expect(res).toEqual({
      ok: true,
      peer: { pid: 3532, binaryName: 'chrome', executablePath: '/opt/google/chrome/chrome' },
    });
    expect(calls[1]?.args).toEqual(['-nP', '-a', '-p', '3532', '-d', 'txt', '-F', 'n']);
  });

  test('posix: no readable txt entry rejects when asked for (path-unreadable)', async () => {
    const res = await lookupPeerProcessDetailed(
      '127.0.0.1',
      64836,
      unix('darwin', {
        lsof: (args) => (args.includes('txt') ? 'p3532\n' : lsofFor(501)),
      }),
      { withExecutablePath: true },
    );
    expect(res).toEqual({ ok: false, cause: 'path-unreadable' });
  });

  // --- existing causes keep their meaning ---

  test('timeout', async () => {
    const res = await lookupPeerProcessDetailed(
      '127.0.0.1',
      64836,
      unix('linux', { lsof: timedOut() }),
    );
    expect(res).toEqual({ ok: false, cause: 'timeout' });
  });

  test('command-missing (lsof not installed: ENOENT)', async () => {
    const res = await lookupPeerProcessDetailed(
      '127.0.0.1',
      64836,
      unix('linux', { lsof: missing('lsof') }),
    );
    expect(res).toEqual({ ok: false, cause: 'command-missing' });
  });

  test('command-missing (netstat not found: ENOENT)', async () => {
    const res = await lookupPeerProcessDetailed(
      '127.0.0.1',
      54321,
      win({ netstat: missing('netstat') }),
    );
    expect(res).toEqual({ ok: false, cause: 'command-missing' });
  });

  test('command-failed:<exit>', async () => {
    const res = await lookupPeerProcessDetailed(
      '127.0.0.1',
      64836,
      unix('linux', { lsof: exitWith(2) }),
    );
    expect(res).toEqual({ ok: false, cause: 'command-failed:2' });
  });

  test('endpoint-not-listed (netstat has no row for the local endpoint)', async () => {
    const res = await lookupPeerProcessDetailed('127.0.0.1', 11111, win({ netstat: NETSTAT }));
    expect(res).toEqual({ ok: false, cause: 'endpoint-not-listed' });
  });

  test('parse-miss (lsof printed no single owner of the local endpoint)', async () => {
    const res = await lookupPeerProcessDetailed(
      '127.0.0.1',
      11111,
      unix('linux', { lsof: lsofFor(501) }),
    );
    expect(res).toEqual({ ok: false, cause: 'parse-miss' });
  });

  test('unsupported-platform', async () => {
    const res = await lookupPeerProcessDetailed('127.0.0.1', 1, { platform: 'aix' });
    expect(res).toEqual({ ok: false, cause: 'unsupported-platform' });
  });

  test('lookupPeerProcess keeps its PeerProcess | null contract', async () => {
    expect(
      await lookupPeerProcess('127.0.0.1', 64836, unix('linux', { lsof: lsofFor(501) })),
    ).toEqual({
      pid: 3532,
      binaryName: 'chrome',
    });
    expect(
      await lookupPeerProcess('127.0.0.1', 64836, unix('linux', { lsof: lsofFor(0) })),
    ).toBeNull();
  });
});
