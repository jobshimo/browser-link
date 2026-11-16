import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleBrowserTool, type BrowserToolDeps } from './browser-dispatch.js';
import { BROWSER_TOOL_DEFINITIONS } from './browser-definitions.js';
import type { AgentCaller } from './tab-claims.js';
import type { ToolResponseMessage } from '../messages.js';
import {
  sendToolRequest,
  settlePendingRequest,
  toolResponseOutcome,
  type PendingRequest,
} from '../bridge/ws-bridge.js';
import { closeActivityDb } from '../activity/db.js';
import { exportAll, query, record } from '../activity/queries.js';
import { SENSITIVE_PAYLOAD_MARKER, UNIDENTIFIED_FIELD_MARKER } from '../activity/extract.js';
import { SensitiveFieldError } from '../activity/sensitive-field-error.js';
import type { ActivityRecord } from '../activity/types.js';

/*
 * S2 through the extension executor: what the agent sees and what the trail
 * stores, for a `type` / `press` whose result comes back from the extension
 * (`background.ts` perform*). The extension half itself is covered by the
 * in-page builder tests (`buildFocusedFieldJs`), the perform* parity guard
 * against the cdp-direct copy (which has its own end-to-end tests in
 * `cdp/transport.test.ts`), and the real-Chrome e2e check.
 */

const CALLER: AgentCaller = { agent_id: 'agent-s2', pid: 7, binary: 'node' };
const TAB = { tab_id: 'tab_1', url: 'https://bank.example.com/login', title: 'Login' };

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'browser-link-sensitive-trail-'));
  process.env.BROWSER_LINK_DATA_DIR = dataDir;
});

afterEach(() => {
  closeActivityDb();
  delete process.env.BROWSER_LINK_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

function deps(
  extensionResult: unknown,
  recordActivityPayloads: boolean,
  hideSensitiveActivity?: boolean,
): BrowserToolDeps {
  return {
    listTabs: vi.fn(() => [TAB]),
    callBrowserTool: vi.fn(async () => extensionResult),
    recordActivity: (row) => {
      record(row);
    },
    recordActivityPayloads,
    ...(hideSensitiveActivity === undefined ? {} : { hideSensitiveActivity }),
  };
}

/** The stored payloads of this caller, newest first, read back through the
 * public query function. */
function storedPayloads(): (string | null)[] {
  return query({ agentId: CALLER.agent_id }).records.map((r) => r.payload);
}

const TYPE_ARGS = { tab_id: 'tab_1', selector: '#pw', text: 'hunter2' };
const PRESS_ARGS = { tab_id: 'tab_1', selector: '#pw', key: 'h' };

describe('browser.type / browser.press via the extension: sensitive fields are not stored', () => {
  test.each([
    ['browser.type', TYPE_ARGS, { typed: 7, selector: '#pw', sensitive_field: true }, 'hunter2'],
    ['browser.press', PRESS_ARGS, { key: 'h', modifiers: [], sensitive_field: true }, 'h'],
  ] as const)(
    '%s on a sensitive field: the agent sees sensitive_field, the row stores the marker (payloads on and off)',
    async (tool, args, extensionResult, secret) => {
      for (const recordPayloads of [true, false]) {
        const result = await handleBrowserTool(
          tool,
          args,
          deps(extensionResult, recordPayloads),
          CALLER,
        );
        expect(result).toEqual(extensionResult);
      }
      const payloads = storedPayloads();
      expect(payloads).toEqual([SENSITIVE_PAYLOAD_MARKER, SENSITIVE_PAYLOAD_MARKER]);
      expect(payloads).not.toContain(secret);
      const rows = query({ agentId: CALLER.agent_id }).records;
      expect(rows.every((r) => r.tool === tool && r.outcome === 'ok')).toBe(true);
      expect(rows.every((r) => r.transport === 'extension' && r.selector === '#pw')).toBe(true);
    },
  );

  test('a plain text field is stored as today (payloads on: the text; off: nothing)', async () => {
    const plain = { typed: 7, selector: '#pw', sensitive_field: false };
    expect(await handleBrowserTool('browser.type', TYPE_ARGS, deps(plain, true), CALLER)).toEqual(
      plain,
    );
    expect(await handleBrowserTool('browser.type', TYPE_ARGS, deps(plain, false), CALLER)).toEqual(
      plain,
    );
    expect(storedPayloads()).toEqual([null, 'hunter2']);
  });

  test('an older extension that reports no field type: the text is hidden as not identified (D13), nothing errors', async () => {
    const legacy = { typed: 7, selector: '#pw' };
    expect(await handleBrowserTool('browser.type', TYPE_ARGS, deps(legacy, true), CALLER)).toEqual(
      legacy,
    );
    const [row] = query({ agentId: CALLER.agent_id }).records;
    expect(row).toMatchObject({ payload: UNIDENTIFIED_FIELD_MARKER, outcome: 'ok', error: null });
  });

  test('an older extension, trail stored unhidden: stored as before the hide setting', async () => {
    const legacy = { typed: 7, selector: '#pw' };
    await handleBrowserTool('browser.type', TYPE_ARGS, deps(legacy, true, false), CALLER);
    const [row] = query({ agentId: CALLER.agent_id }).records;
    expect(row).toMatchObject({ payload: 'hunter2', outcome: 'ok', error: null });
  });

  test('press on a plain field keeps its key in the row, as today', async () => {
    const plain = { key: 'Enter', modifiers: [], sensitive_field: false };
    const args = { tab_id: 'tab_1', key: 'Enter' };
    expect(await handleBrowserTool('browser.press', args, deps(plain, true), CALLER)).toEqual(
      plain,
    );
    expect(storedPayloads()).toEqual(['Enter']);
  });
});

describe('a failed browser.type / browser.press via the extension (S2)', () => {
  const ERROR = 'expectation not met: url_changed after 150ms';

  /** The extension answers with this error frame; the bridge settles it. */
  function failingDeps(
    frame: ToolResponseMessage,
    recordActivityPayloads: boolean,
    hideSensitiveActivity?: boolean,
  ): BrowserToolDeps {
    return {
      ...deps(undefined, recordActivityPayloads, hideSensitiveActivity),
      callBrowserTool: (_tabId, tool, params, timeoutMs = 30_000) => {
        const tabs = new Map([['tab_1', { ws: { readyState: 1, send: () => {} } } as never]]);
        const pending = new Map<string, PendingRequest>();
        const request = sendToolRequest(tabs, pending, 'tab_1', frame.id, tool, params, timeoutMs);
        settlePendingRequest(pending, frame.id, toolResponseOutcome(frame));
        return request;
      },
    };
  }

  test.each([
    ['browser.type', TYPE_ARGS, 'hunter2'],
    ['browser.press', PRESS_ARGS, 'h'],
  ] as const)(
    '%s that fails after acting on a sensitive field: same error text, the row stores the marker (payloads on and off)',
    async (tool, args, secret) => {
      const frame = {
        kind: 'tool.response',
        id: 'r1',
        ok: false,
        error: ERROR,
        sensitive_field: true,
      } as const;
      for (const recordPayloads of [true, false]) {
        const error: unknown = await handleBrowserTool(
          tool,
          args,
          failingDeps(frame, recordPayloads),
          CALLER,
        ).catch((e: unknown) => e);
        expect(String(error)).toBe(`Error: ${ERROR}`);
      }
      expect(storedPayloads()).toEqual([SENSITIVE_PAYLOAD_MARKER, SENSITIVE_PAYLOAD_MARKER]);
      expect(storedPayloads()).not.toContain(secret);
      const rows = query({ agentId: CALLER.agent_id }).records;
      expect(rows.every((r) => r.outcome === 'error' && r.error === ERROR)).toBe(true);
    },
  );

  // The bridge carries `sensitive_field` on a failure only when it is true,
  // so a failure on a plain field cannot be told from one that never reached
  // the field: by default both are hidden as not identified (D13).
  test('a failed type on a plain field: hidden as not identified by default, the text when stored unhidden', async () => {
    const frame = {
      kind: 'tool.response',
      id: 'r1',
      ok: false,
      error: ERROR,
      sensitive_field: false,
    } as const;
    await expect(
      handleBrowserTool('browser.type', TYPE_ARGS, failingDeps(frame, true), CALLER),
    ).rejects.toThrow(ERROR);
    await expect(
      handleBrowserTool('browser.type', TYPE_ARGS, failingDeps(frame, true, false), CALLER),
    ).rejects.toThrow(ERROR);
    expect(storedPayloads()).toEqual(['hunter2', UNIDENTIFIED_FIELD_MARKER]);
  });

  test('an error without the field (older extension): hidden by default, as before when stored unhidden', async () => {
    const frame = { kind: 'tool.response', id: 'r1', ok: false, error: ERROR } as const;
    for (const hide of [undefined, false]) {
      await expect(
        handleBrowserTool('browser.type', TYPE_ARGS, failingDeps(frame, true, hide), CALLER),
      ).rejects.toThrow(ERROR);
      await expect(
        handleBrowserTool('browser.press', PRESS_ARGS, failingDeps(frame, true, hide), CALLER),
      ).rejects.toThrow(ERROR);
    }
    expect(storedPayloads()).toEqual([
      'h',
      'hunter2',
      UNIDENTIFIED_FIELD_MARKER,
      UNIDENTIFIED_FIELD_MARKER,
    ]);
  });
});

describe('a sensitive row hides the value in every column, or none (D13)', () => {
  const SECRET = 'hunter2';
  /** The tab after a login form sent by GET: the password is in the URL and
   * the page title quotes it. */
  const ECHO_TAB = {
    tab_id: 'tab_1',
    url: 'https://bank.example.com/login?user=ana&pw=hunter2',
    title: 'Wrong password hunter2',
  };
  const ERROR = 'expectation not met: text_appears "hunter2"';

  function echoDeps(
    callBrowserTool: BrowserToolDeps['callBrowserTool'],
    hideSensitiveActivity?: boolean,
  ): BrowserToolDeps {
    return {
      listTabs: vi.fn(() => [ECHO_TAB]),
      callBrowserTool,
      recordActivity: (row) => {
        record(row);
      },
      recordActivityPayloads: true,
      ...(hideSensitiveActivity === undefined ? {} : { hideSensitiveActivity }),
    };
  }

  const sensitiveFailure = (async () => {
    throw new SensitiveFieldError(ERROR);
  }) as BrowserToolDeps['callBrowserTool'];

  function storedRows(): ActivityRecord[] {
    return query({ agentId: CALLER.agent_id }).records;
  }

  test('by default every column of the stored row, the export and browser.activity are free of the value', async () => {
    await expect(
      handleBrowserTool('browser.type', TYPE_ARGS, echoDeps(sensitiveFailure), CALLER),
    ).rejects.toThrow(ERROR);
    const [row] = storedRows();
    expect(row).toMatchObject({
      tool: 'browser.type',
      payload: SENSITIVE_PAYLOAD_MARKER,
      url: 'https://bank.example.com/login',
      title: `Wrong password ${SENSITIVE_PAYLOAD_MARKER}`,
      selector: '#pw',
      error: `expectation not met: text_appears "${SENSITIVE_PAYLOAD_MARKER}"`,
      outcome: 'error',
    });
    expect(JSON.stringify(row)).not.toContain(SECRET);
    expect(JSON.stringify([...exportAll()])).not.toContain(SECRET);
    const viaTool = await handleBrowserTool(
      'browser.activity',
      {},
      echoDeps(sensitiveFailure),
      CALLER,
    );
    expect(JSON.stringify(viaTool)).not.toContain(SECRET);
  });

  test('payloads off: a sensitive row keeps its marker, a not-identified row stores null, both scrubbed', async () => {
    const notFound = (async () => {
      throw new Error('Element not found: #pw');
    }) as BrowserToolDeps['callBrowserTool'];
    for (const failing of [sensitiveFailure, notFound]) {
      await handleBrowserTool(
        'browser.type',
        TYPE_ARGS,
        { ...echoDeps(failing), recordActivityPayloads: false },
        CALLER,
      ).catch(() => undefined);
    }
    const rows = storedRows();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.payload).sort()).toEqual([null, SENSITIVE_PAYLOAD_MARKER].sort());
    for (const row of rows) {
      expect(row.url).toBe('https://bank.example.com/login');
      expect(JSON.stringify(row)).not.toContain(SECRET);
    }
    expect(rows.map((r) => r.title).sort()).toEqual(
      [
        `Wrong password ${UNIDENTIFIED_FIELD_MARKER}`,
        `Wrong password ${SENSITIVE_PAYLOAD_MARKER}`,
      ].sort(),
    );
  });

  test('by default a type whose field was never identified (not found) hides its value too', async () => {
    const notFound = (async () => {
      throw new Error('Element not found: #pw');
    }) as BrowserToolDeps['callBrowserTool'];
    await expect(
      handleBrowserTool('browser.type', TYPE_ARGS, echoDeps(notFound), CALLER),
    ).rejects.toThrow('Element not found: #pw');
    const [row] = storedRows();
    expect(row).toMatchObject({
      payload: UNIDENTIFIED_FIELD_MARKER,
      url: 'https://bank.example.com/login',
      title: `Wrong password ${UNIDENTIFIED_FIELD_MARKER}`,
    });
    expect(JSON.stringify(row)).not.toContain(SECRET);
  });

  test('stored unhidden: every column keeps what it had, the typed text included', async () => {
    await expect(
      handleBrowserTool('browser.type', TYPE_ARGS, echoDeps(sensitiveFailure, false), CALLER),
    ).rejects.toThrow(ERROR);
    const [row] = storedRows();
    expect(row).toMatchObject({
      payload: SECRET,
      url: ECHO_TAB.url,
      title: ECHO_TAB.title,
      selector: '#pw',
      error: ERROR,
    });
  });

  test('a plain field keeps its url and title whatever the setting', async () => {
    const plain = vi.fn(async () => ({ typed: 7, selector: '#pw', sensitive_field: false }));
    await handleBrowserTool('browser.type', TYPE_ARGS, echoDeps(plain), CALLER);
    await handleBrowserTool('browser.type', TYPE_ARGS, echoDeps(plain, false), CALLER);
    for (const row of storedRows()) {
      expect(row).toMatchObject({ payload: SECRET, url: ECHO_TAB.url, title: ECHO_TAB.title });
    }
  });
});

describe('the tool manual says what sensitive_field means', () => {
  test.each(['browser.type', 'browser.press', 'browser.activity'])('%s', (name) => {
    const def = BROWSER_TOOL_DEFINITIONS.find((d) => d.name === name);
    const text = JSON.stringify(def?.doc ?? {});
    expect(text).toContain('sensitive_field');
    expect(text).toContain('[sensitive field]');
  });
});
