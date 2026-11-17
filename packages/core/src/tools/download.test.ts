// The download and download_settle entries (design 3.3, slice 16): the
// capture around the click, each outcome's result, the error texts, and
// cdp-direct refusing both.
import { describe, expect, it } from 'vitest';
import {
  buildClickAimJs,
  buildClickHitCheckJs,
  buildClickMoveCheckJs,
  buildClickResolveJs,
} from '../inpage/builders.js';
import { createManualClock, createMemoryDownloads } from '../ports/contract/index.js';
import type { Downloads } from '../ports/downloads.js';
import type { CapturedDownload } from '../ports/values.js';
import { TOOL_REGISTRY } from './catalog.js';
import { DOWNLOAD_HOLD_SLACK_MS } from './download.js';
import { toolResponse } from './failure.js';
import { dispatchTool, type Transport } from './registry.js';
import type { Requirement, ToolDeps } from './requirement.js';

const EXTENSION: ReadonlySet<Requirement> = new Set<Requirement>([
  'evaluator',
  'pointer',
  'settler',
  'downloads',
]);
const CDP: ReadonlySet<Requirement> = new Set<Requirement>(['evaluator', 'pointer', 'settler']);

const AIMED = { ok: true, x: 5, y: 6, tag: 'a' };
const FILE: CapturedDownload = {
  download_id: 7,
  url: 'https://a.test/f.csv',
  original_url: 'https://a.test/get',
  filename: 'f.csv',
  mime: 'text/csv',
  total_bytes: 12,
};

/** A page whose `#dl` is clicked cleanly, or is missing; `downloads` decides
 * what the capture sees. */
function deps(downloads: Downloads, options: { missing?: boolean; log?: string[] } = {}): ToolDeps {
  const resolve = buildClickResolveJs({ selector: '#dl', force: false });
  const answers: Record<string, unknown> = options.missing
    ? { [resolve]: { ok: false, reason: 'not-found' } }
    : {
        [resolve]: AIMED,
        [buildClickAimJs({ selector: '#dl', force: false })]: AIMED,
        [buildClickMoveCheckJs()]: { armed: true, moved: true },
        [buildClickHitCheckJs()]: { armed: true, landed: true },
      };
  return {
    clock: createManualClock(),
    evaluator: {
      evaluate: (expression: string) =>
        Promise.resolve(Object.hasOwn(answers, expression) ? answers[expression] : true),
    },
    pointer: {
      mouse: (event: { type: string }) => {
        options.log?.push(event.type);
        return Promise.resolve();
      },
    },
    settler: {
      mark: () => Promise.resolve({ kind: 'none' }),
      settle: () => Promise.resolve(undefined),
    },
    downloads,
  } as unknown as ToolDeps;
}

function call(tool: string, params: unknown, given: ToolDeps, transport: Transport = 'extension') {
  return dispatchTool(
    TOOL_REGISTRY,
    transport === 'extension' ? EXTENSION : CDP,
    given,
    transport,
    tool,
    params,
  );
}

describe('download', () => {
  it('captures the download the click starts, held for the budget plus the slack', async () => {
    const clock = createManualClock();
    const memory = createMemoryDownloads(clock);
    const waits: unknown[] = [];
    const log: string[] = [];
    const downloads: Downloads = {
      captureAround: async (wait, act) => {
        waits.push(wait);
        return memory.captureAround(wait, async () => {
          const clicked = await act();
          memory.start(FILE);
          return clicked;
        });
      },
      settle: (id, saved) => memory.settle(id, saved),
    };
    const outcome = await call(
      'download',
      { selector: '#dl', timeout_ms: 5_000 },
      deps(downloads, { log }),
    );
    expect(outcome).toEqual({ ok: true, result: { state: 'captured', ...FILE } });
    expect(Object.keys((outcome as { result: object }).result)).toEqual([
      'state',
      'download_id',
      'url',
      'original_url',
      'filename',
      'mime',
      'total_bytes',
    ]);
    expect(waits).toEqual([{ timeoutMs: 5_000, holdMs: 5_000 + DOWNLOAD_HOLD_SLACK_MS }]);
    expect(log).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);
  });

  it('answers timeout when no download appears', async () => {
    const clock = createManualClock();
    const pending = call(
      'download',
      { selector: '#dl', timeout_ms: 100 },
      deps(createMemoryDownloads(clock)),
    );
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    await clock.advance(100);
    expect(await pending).toEqual({ ok: true, result: { state: 'timeout' } });
  });

  it('answers unattributed as the capture reports it', async () => {
    const downloads: Downloads = {
      captureAround: async (_wait, act) => {
        await act();
        return { ok: true, outcome: { state: 'unattributed' } };
      },
      settle: () => Promise.resolve('not_held'),
    };
    expect(await call('download', { selector: '#dl', timeout_ms: 100 }, deps(downloads))).toEqual({
      ok: true,
      result: { state: 'unattributed' },
    });
  });

  it('a click that fails says so, with the click error', async () => {
    const outcome = await call(
      'download',
      { selector: '#dl', timeout_ms: 100 },
      deps(createMemoryDownloads(createManualClock()), { missing: true }),
    );
    expect(toolResponse('d1', outcome)).toEqual({
      kind: 'tool.response',
      id: 'd1',
      ok: false,
      error:
        'the click that should start the download failed, so no download was captured: Element not found: #dl',
    });
  });

  it.each([{ selector: '#dl' }, { selector: '#dl', timeout_ms: 0 }, { timeout_ms: '5' }])(
    '%j fails with download: timeout_ms required, without arming a capture',
    async (params) => {
      let armed = false;
      const downloads: Downloads = {
        captureAround: () => {
          armed = true;
          return Promise.resolve({ ok: true, outcome: { state: 'timeout' } });
        },
        settle: () => Promise.resolve('not_held'),
      };
      const outcome = await call('download', params, deps(downloads));
      expect(toolResponse('d2', outcome)).toEqual({
        kind: 'tool.response',
        id: 'd2',
        ok: false,
        error: 'download: timeout_ms required',
      });
      expect(armed).toBe(false);
    },
  );

  it('an error thrown by the capture is the answer', async () => {
    const downloads: Downloads = {
      captureAround: () => Promise.reject(new Error('download: another capture is waiting')),
      settle: () => Promise.resolve('not_held'),
    };
    const outcome = await call('download', { selector: '#dl', timeout_ms: 100 }, deps(downloads));
    expect(toolResponse('d3', outcome)).toEqual({
      kind: 'tool.response',
      id: 'd3',
      ok: false,
      error: 'download: another capture is waiting',
    });
  });
});

describe('download_settle', () => {
  it('answers what became of Chrome download', async () => {
    const settled: unknown[][] = [];
    const downloads: Downloads = {
      captureAround: () => Promise.reject(new Error('unused')),
      settle: (id, saved) => {
        settled.push([id, saved]);
        return Promise.resolve('removed');
      },
    };
    expect(await call('download_settle', { download_id: 7, saved: true }, deps(downloads))).toEqual(
      { ok: true, result: { chrome_download: 'removed' } },
    );
    expect(settled).toEqual([[7, true]]);
  });

  it.each([{ download_id: 7 }, { saved: true }, { download_id: '7', saved: false }])(
    '%j fails with download_settle: download_id and saved required',
    async (params) => {
      const outcome = await call(
        'download_settle',
        params,
        deps(createMemoryDownloads(createManualClock())),
      );
      expect(toolResponse('s1', outcome)).toEqual({
        kind: 'tool.response',
        id: 's1',
        ok: false,
        error: 'download_settle: download_id and saved required',
      });
    },
  );

  it('is not listed', () => {
    expect(TOOL_REGISTRY.get('download_settle')?.listed).toBe(false);
    expect(TOOL_REGISTRY.get('download')?.listed).toBe(true);
  });
});

describe('cdp-direct', () => {
  it.each(['download', 'download_settle'])('refuses %s as unsupported', async (tool) => {
    const outcome = await call(
      tool,
      { selector: '#dl', timeout_ms: 100 },
      deps(createMemoryDownloads(createManualClock())),
      'cdp-direct',
    );
    expect(outcome).toEqual({
      ok: false,
      failure: { kind: 'unsupported', tool, missing: ['downloads'] },
    });
  });
});
