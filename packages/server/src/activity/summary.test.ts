import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeActivityDb, getActivityDb } from './db.js';
import { record } from './queries.js';
import { summarizeActivity } from './summary.js';
import type { ActivityInput } from './types.js';

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'browser-link-activity-summary-'));
  process.env.BROWSER_LINK_DATA_DIR = dataDir;
});

afterEach(() => {
  closeActivityDb();
  delete process.env.BROWSER_LINK_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

function row(over: Partial<ActivityInput> = {}): ActivityInput {
  return {
    tool: 'browser.click',
    tabId: 'tab_1',
    transport: 'extension',
    url: 'https://example.com/a',
    title: 'A',
    agent: 'claude-code',
    agentPid: 1,
    selector: '#go',
    payload: null,
    outcome: 'ok',
    error: null,
    durationMs: 10,
    flowId: null,
    flag: null,
    agentId: 's-1',
    ...over,
  };
}

/** Nine rows across two sessions plus one legacy row with no session. */
function seed(): void {
  const db = getActivityDb();
  record(row(), db); // 1
  record(row({ outcome: 'error', error: 'Click would land on x', flag: 'retargeted' }), db); // 2
  record(row({ flag: 'unsettled' }), db); // 3
  const s2 = { agent: 'opencode', agentId: 's-2' };
  record(row({ ...s2, tool: 'browser.wait_for', selector: '.done', flag: 'unmatched' }), db); // 4
  record(row({ ...s2, tool: 'browser.evaluate', selector: null, payload: '1' }), db); // 5
  record(
    row({
      ...s2,
      tool: 'browser.evaluate',
      selector: null,
      outcome: 'error',
      error: "Tool 'browser.evaluate' timed out after 30000ms",
      flag: 'timeout',
    }),
    db,
  ); // 6
  record(row({ tool: 'browser.flow', selector: null, flag: 'flow-timeout' }), db); // 7
  record(row({ ...s2, tool: 'browser.download', selector: '#dl', flag: 'download-timeout' }), db); // 8
  record(
    row({ tool: 'browser.list_tabs', tabId: null, selector: null, agent: null, agentId: null }),
    db,
  ); // 9
}

describe('summarizeActivity', () => {
  test('aggregates a seeded trail', () => {
    seed();
    expect(summarizeActivity(getActivityDb(), {})).toEqual({
      records: 9,
      errors: 2,
      by_flag: {
        'download-timeout': 1,
        'flow-timeout': 1,
        retargeted: 1,
        timeout: 1,
        unmatched: 1,
        unsettled: 1,
      },
      by_tool_errors: { 'browser.click': 1, 'browser.evaluate': 1 },
      evaluate_calls: 2,
      timeouts: 3,
      top_failing_targets: [
        { selector: '#go', tool: 'browser.click', n: 2, last_flag: 'unsettled' },
        { selector: '#dl', tool: 'browser.download', n: 1, last_flag: 'download-timeout' },
        { selector: '.done', tool: 'browser.wait_for', n: 1, last_flag: 'unmatched' },
      ],
      sessions: [
        { agent_id: null, agent: null, records: 1, errors: 0, flags: {} },
        {
          agent_id: 's-2',
          agent: 'opencode',
          records: 4,
          errors: 1,
          flags: { 'download-timeout': 1, timeout: 1, unmatched: 1 },
        },
        {
          agent_id: 's-1',
          agent: 'claude-code',
          records: 4,
          errors: 1,
          flags: { 'flow-timeout': 1, retargeted: 1, unsettled: 1 },
        },
      ],
    });
  });

  test('an empty trail is all zeros, never an error', () => {
    expect(summarizeActivity(getActivityDb(), {})).toEqual({
      records: 0,
      errors: 0,
      by_flag: {},
      by_tool_errors: {},
      evaluate_calls: 0,
      timeouts: 0,
      top_failing_targets: [],
      sessions: [],
    });
  });

  test('sinceId narrows to newer rows', () => {
    seed();
    const s = summarizeActivity(getActivityDb(), { sinceId: 7 });
    expect(s.records).toBe(2);
    expect(s.by_flag).toEqual({ 'download-timeout': 1 });
  });

  test('since narrows by timestamp', () => {
    seed();
    const db = getActivityDb();
    expect(summarizeActivity(db, { since: '2999-01-01T00:00:00.000Z' }).records).toBe(0);
    expect(summarizeActivity(db, { since: '2000-01-01T00:00:00.000Z' }).records).toBe(9);
  });

  test('agentId narrows to one session', () => {
    seed();
    const s = summarizeActivity(getActivityDb(), { agentId: 's-1' });
    expect(s.records).toBe(4);
    expect(s.sessions.map((x) => x.agent_id)).toEqual(['s-1']);
    expect(s.evaluate_calls).toBe(0);
  });

  test('top_failing_targets is capped at 10', () => {
    const db = getActivityDb();
    for (let i = 0; i < 12; i += 1) record(row({ selector: `#t${i}`, flag: 'unsettled' }), db);
    expect(summarizeActivity(db, {}).top_failing_targets).toHaveLength(10);
  });
});
