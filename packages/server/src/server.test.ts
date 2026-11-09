import { afterEach, describe, expect, test, vi } from 'vitest';
import { VERSION } from './version.js';

// Capture what the MCP server is constructed with; nothing else of the SDK
// class is exercised here.
const constructed = vi.hoisted(() => [] as unknown[][]);
vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: class {
    server = { setRequestHandler: () => undefined };
    constructor(...args: unknown[]) {
      constructed.push(args);
    }
  },
}));

const { createMcpServer } = await import('./server.js');

afterEach(() => {
  constructed.length = 0;
});

describe('createMcpServer', () => {
  test('announces the running VERSION as serverInfo, with the tools capability and instructions', () => {
    createMcpServer('the instructions');
    expect(constructed).toEqual([
      [
        { name: 'browser-link', version: VERSION },
        { capabilities: { tools: {} }, instructions: 'the instructions' },
      ],
    ]);
  });
});

const { startServer } = await import('./server.js');
const { AddrInUseError } = await import('./bridge/ws-bridge.js');

/*
 * The start-up orchestration: bind → (port taken) hand-off retries →
 * version-aware election → step the older primary down → rebind → else
 * proxy (multi-agent) or the port-in-use error. Every effect is injected:
 * `bind` stands in for `runPrimary`, the election deps for the probe and the
 * kill, `sleep` makes the retry loops instant.
 */
describe('startServer — primary election orchestration', () => {
  type Deps = Parameters<typeof startServer>[0];

  function harness(opts: {
    /** How many bind attempts fail with EADDRINUSE before one succeeds
     * (Infinity: the port never frees). */
    bindFailures: number;
    probe: Deps['election']['probe'];
    multiAgent?: boolean;
    findOwnerPid?: () => number | null;
    processStartTime?: (pid: number) => number | null;
    installedCodeMtime?: () => number | null;
  }) {
    let binds = 0;
    const logs: string[] = [];
    const stepDown = vi.fn(async (_pid: number) => {});
    const runProxy = vi.fn(async () => {});
    const deps: Deps = {
      bind: async () => {
        binds++;
        if (binds <= opts.bindFailures) throw new AddrInUseError();
      },
      runProxy,
      multiAgent: opts.multiAgent ?? false,
      election: {
        localVersion: '0.48.0',
        probe: opts.probe,
        findOwnerPid: opts.findOwnerPid ?? (() => null),
        processStartTime: opts.processStartTime ?? (() => null),
        installedCodeMtime: opts.installedCodeMtime ?? (() => null),
        stepDown,
      },
      log: (msg) => logs.push(msg),
      sleep: async () => {},
    };
    return { deps, logs, stepDown, runProxy, binds: () => binds };
  }

  const versionProbe =
    (version: string, pid = 42) =>
    async () =>
      ({
        kind: 'version',
        info: {
          name: 'browser-link',
          version,
          pid,
          startedAt: '2026-11-09T00:00:00.000Z',
          installedVersion: version,
        },
      }) as const;

  test('fresh start: the first bind succeeds, this process is primary, nothing else runs', async () => {
    const probe = vi.fn(versionProbe('0.47.0'));
    const h = harness({ bindFailures: 0, probe });
    await expect(startServer(h.deps)).resolves.toBeUndefined();
    expect(h.binds()).toBe(1);
    expect(probe).not.toHaveBeenCalled();
    expect(h.stepDown).not.toHaveBeenCalled();
    expect(h.runProxy).not.toHaveBeenCalled();
    expect(h.logs).toEqual([]);
  });

  test('the holder leaves during the hand-off window: primary without an election', async () => {
    const probe = vi.fn(versionProbe('0.47.0'));
    const h = harness({ bindFailures: 3, probe });
    await startServer(h.deps);
    expect(h.binds()).toBe(4);
    expect(probe).not.toHaveBeenCalled();
    expect(h.logs).toEqual([]);
  });

  test('a newer version finds an older primary: the older one steps down and this one binds', async () => {
    // 1 initial bind + 5 hand-off attempts fail, the first rebind after the
    // step-down succeeds.
    const h = harness({ bindFailures: 6, probe: versionProbe('0.47.0', 4242) });
    await startServer(h.deps);
    expect(h.stepDown).toHaveBeenCalledExactlyOnceWith(4242);
    expect(h.runProxy).not.toHaveBeenCalled();
    expect(h.binds()).toBe(7);
    expect(h.logs).toEqual([
      'Primary election: take-over (running primary 0.47.0 is older than 0.48.0).',
      'Took over from PID 4242 (running 0.48.0).',
    ]);
  });

  test('bind fails and a same-version primary exists: proxy fallback with multi-agent on', async () => {
    const h = harness({ bindFailures: Infinity, probe: versionProbe('0.48.0'), multiAgent: true });
    await startServer(h.deps);
    expect(h.stepDown).not.toHaveBeenCalled();
    expect(h.runProxy).toHaveBeenCalledTimes(1);
    expect(h.logs).toEqual([
      'Primary election: defer (running primary 0.48.0 is not older than 0.48.0).',
    ]);
  });

  test('bind fails and a same-version primary exists with multi-agent off: the port-in-use error', async () => {
    const h = harness({ bindFailures: Infinity, probe: versionProbe('0.48.0') });
    const err = await startServer(h.deps).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toMatch(
      /^browser-link: port 127\.0\.0\.1:17529 is already in use by another browser-link instance\./,
    );
    expect(err?.message).toContain('browser-link multi-agent enable');
    expect(err?.cause).toBeInstanceOf(AddrInUseError);
    expect(h.runProxy).not.toHaveBeenCalled();
  });

  test('stale primary without /version that started before the installed code: taken over', async () => {
    const h = harness({
      bindFailures: 6,
      probe: async () => ({ kind: 'no-endpoint' }),
      findOwnerPid: () => 777,
      processStartTime: () => 1_000,
      installedCodeMtime: () => 2_000,
    });
    await startServer(h.deps);
    expect(h.stepDown).toHaveBeenCalledExactlyOnceWith(777);
    expect(h.runProxy).not.toHaveBeenCalled();
    expect(h.logs).toEqual([
      'Primary election: take-over (primary has no /version and started before the installed code was written).',
      'Took over from PID 777 (running 0.48.0).',
    ]);
  });

  test('take-over whose port never frees: defers to the proxy', async () => {
    const h = harness({ bindFailures: Infinity, probe: versionProbe('0.47.0'), multiAgent: true });
    await startServer(h.deps);
    expect(h.stepDown).toHaveBeenCalledOnce();
    expect(h.runProxy).toHaveBeenCalledOnce();
    expect(h.logs.at(-1)).toBe('take-over: the port did not free up in time; deferring.');
  });

  test('a bind failure other than EADDRINUSE propagates unchanged', async () => {
    const boom = new Error('EACCES');
    const h = harness({ bindFailures: 0, probe: versionProbe('0.47.0') });
    h.deps.bind = async () => {
      throw boom;
    };
    await expect(startServer(h.deps)).rejects.toBe(boom);
  });
});
