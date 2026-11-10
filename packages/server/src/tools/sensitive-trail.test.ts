import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleBrowserTool, type BrowserToolDeps } from './browser-dispatch.js';
import { BROWSER_TOOL_DEFINITIONS } from './browser-definitions.js';
import type { AgentCaller } from './tab-claims.js';
import { closeActivityDb } from '../activity/db.js';
import { query, record } from '../activity/queries.js';
import { SENSITIVE_PAYLOAD_MARKER } from '../activity/extract.js';

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

function deps(extensionResult: unknown, recordActivityPayloads: boolean): BrowserToolDeps {
  return {
    listTabs: vi.fn(() => [TAB]),
    callBrowserTool: vi.fn(async () => extensionResult),
    recordActivity: (row) => {
      record(row);
    },
    recordActivityPayloads,
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

  test('an older extension that reports no field type: stored as today, nothing errors', async () => {
    const legacy = { typed: 7, selector: '#pw' };
    expect(await handleBrowserTool('browser.type', TYPE_ARGS, deps(legacy, true), CALLER)).toEqual(
      legacy,
    );
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

describe('the tool manual says what sensitive_field means', () => {
  test.each(['browser.type', 'browser.press', 'browser.activity'])('%s', (name) => {
    const def = BROWSER_TOOL_DEFINITIONS.find((d) => d.name === name);
    const text = JSON.stringify(def?.doc ?? {});
    expect(text).toContain('sensitive_field');
    expect(text).toContain('[sensitive field]');
  });
});
