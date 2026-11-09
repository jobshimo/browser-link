import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeActivityDb, getActivityDb } from '../activity/db.js';
import { recordFeedback } from '../activity/feedback.js';
import { VERSION } from '../version.js';
import {
  ISSUE_REPO,
  issueDraft,
  runFeedbackCommand,
  type FeedbackCommandDeps,
} from './feedback.js';

let dataDir: string;
let printed: string[];

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'browser-link-feedback-cmd-'));
  process.env.BROWSER_LINK_DATA_DIR = dataDir;
  printed = [];
});

afterEach(() => {
  closeActivityDb();
  delete process.env.BROWSER_LINK_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

function seed(): void {
  const db = getActivityDb();
  recordFeedback(db, {
    tool: 'browser.click',
    observed: 'ok: true but the dialog never opened and settle reported zero mutations every time',
    expected: 'an error or a flag when the click changes nothing',
    agentId: 'agent-session-secret-id',
    origin: 'https://shop.example.com',
    build: '3f9a',
  });
  recordFeedback(db, {
    tool: 'browser.find',
    observed: 'not-found without near_misses',
    expected: 'near_misses listed',
  });
}

/** Deps with a scripted answer; `execFile` records its calls and never runs
 * the real `gh`. */
function deps(over: Partial<FeedbackCommandDeps> = {}) {
  let bodyAtCall = '';
  let bodyPath = '';
  const execFile = vi.fn(async (_file: string, args: readonly string[]) => {
    const bodyFile = args[args.indexOf('--body-file') + 1]!;
    bodyAtCall = readFileSync(bodyFile, 'utf8');
    bodyPath = bodyFile;
    return { stdout: 'https://github.com/jobshimo/browser-link/issues/99\n', stderr: '' };
  });
  const d: FeedbackCommandDeps = {
    db: getActivityDb(),
    print: (line: string) => printed.push(line),
    isTTY: true,
    ask: vi.fn(async () => 'y'),
    execFile,
    ...over,
  };
  return { d, execFile, body: () => bodyAtCall, bodyPath: () => bodyPath };
}

describe('browser-link feedback (list)', () => {
  test('prints entries newest first in English, without the agent id', async () => {
    seed();
    const { d } = deps();
    expect(await runFeedbackCommand([], 'en', d)).toBe(0);
    const out = printed.join('\n');
    expect(printed[0]).toBe(
      'Agent feedback, newest first. Draft a GitHub issue from one: browser-link feedback issue <id>',
    );
    expect(out.indexOf('#2')).toBeLessThan(out.indexOf('#1'));
    expect(out).toMatch(
      /#1 {2}\d{4}-\d{2}-\d{2} \d{2}:\d{2} {2}browser\.click {2}https:\/\/shop\.example\.com/,
    );
    expect(out).toContain('    observed: not-found without near_misses');
    expect(out).toContain('    expected: near_misses listed');
    expect(out).not.toContain('agent-session-secret-id');
  });

  test('prints the Spanish copy', async () => {
    seed();
    const { d } = deps();
    await runFeedbackCommand([], 'es', d);
    const out = printed.join('\n');
    expect(printed[0]).toBe(
      'Feedback de los agentes, más reciente primero. Para preparar un issue de GitHub: browser-link feedback issue <id>',
    );
    expect(out).toContain('    observado: not-found without near_misses');
    expect(out).toContain('    esperado: near_misses listed');
  });

  test('--limit keeps the newest n', async () => {
    seed();
    const { d } = deps();
    await runFeedbackCommand(['--limit', '1'], 'en', d);
    const out = printed.join('\n');
    expect(out).toContain('#2  ');
    expect(out).not.toContain('#1  ');
  });

  test('a bad --limit exits 2 with a message', async () => {
    const { d } = deps();
    expect(await runFeedbackCommand(['--limit', 'zero'], 'en', d)).toBe(2);
    expect(printed).toEqual(['--limit takes a whole number from 1 to 500.']);
  });

  test('an unknown subcommand exits 2 with the usage', async () => {
    const { d } = deps();
    expect(await runFeedbackCommand(['bogus'], 'en', d)).toBe(2);
    expect(printed.join('\n')).toContain('browser-link feedback issue <id>');
  });

  test('says so when there is nothing, in both languages', async () => {
    const { d } = deps();
    await runFeedbackCommand([], 'en', d);
    expect(printed).toEqual(['No agent feedback recorded yet.']);
    printed = [];
    await runFeedbackCommand([], 'es', d);
    expect(printed).toEqual(['Todavía no hay feedback de agentes.']);
  });
});

describe('issue draft', () => {
  test('title is "[agent feedback] <tool>: <observed, first 60 chars>"', () => {
    const draft = issueDraft({
      id: 1,
      at: '2026-11-09T10:00:00.000Z',
      tool: 'browser.click',
      observed:
        'ok: true but the dialog never opened and settle reported zero mutations every time',
      expected: 'e',
      agentId: 'agent-x',
      origin: null,
      build: null,
    });
    expect(draft.title).toBe(
      '[agent feedback] browser.click: ok: true but the dialog never opened and settle reported zer',
    );
  });

  test('body has observed, expected, tool, origin, build, date and version, never the agent id', () => {
    const draft = issueDraft({
      id: 4,
      at: '2026-11-09T10:00:00.000Z',
      tool: 'browser.find',
      observed: 'not-found',
      expected: 'near_misses',
      agentId: 'agent-session-secret-id',
      origin: 'https://shop.example.com',
      build: '3f9a',
    });
    expect(draft.body).toContain('**Tool:** `browser.find`');
    expect(draft.body).toContain('**Observed:** not-found');
    expect(draft.body).toContain('**Expected:** near_misses');
    expect(draft.body).toContain('**Origin:** https://shop.example.com');
    expect(draft.body).toContain('**App build:** 3f9a');
    expect(draft.body).toContain('**Date:** 2026-11-09T10:00:00.000Z');
    expect(draft.body).toContain(`**browser-link:** v${VERSION}`);
    expect(draft.body).not.toContain('agent-session-secret-id');
  });

  test('secret-shaped and personal text is redacted from the title and the body', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const draft = issueDraft({
      id: 5,
      at: '2026-11-09T10:00:00.000Z',
      tool: 'browser.evaluate',
      observed: `returned ${jwt} and token=abc123def`,
      expected: `mail me at someone@example.com, hex ${'a1'.repeat(20)}`,
      agentId: null,
      origin: null,
      build: null,
    });
    const all = `${draft.title}\n${draft.body}`;
    expect(all).not.toContain(jwt);
    expect(all).not.toContain('abc123def');
    expect(all).not.toContain('someone@example.com');
    expect(all).not.toContain('a1'.repeat(20));
    expect(all).toContain('[redacted]');
    expect(draft.body).toContain('**Origin:** —');
    expect(draft.body).toContain('**App build:** —');
  });
});

describe('browser-link feedback issue <id>', () => {
  test('on "y" it runs gh issue create with the draft, removes the temp file and prints the URL', async () => {
    seed();
    const { d, execFile, body, bodyPath } = deps();
    expect(await runFeedbackCommand(['issue', '1'], 'en', d)).toBe(0);
    expect(d.ask).toHaveBeenCalledWith(`Create this issue on ${ISSUE_REPO} with gh? [y/N] `);
    expect(execFile).toHaveBeenCalledTimes(1);
    const [file, args] = execFile.mock.calls[0]!;
    expect(file).toBe('gh');
    expect(ISSUE_REPO).toBe('jobshimo/browser-link');
    expect(args.slice(0, 5)).toEqual(['issue', 'create', '--repo', ISSUE_REPO, '--title']);
    expect(args[5]).toMatch(/^\[agent feedback\] browser\.click: /);
    expect(args[6]).toBe('--body-file');
    expect(body()).toContain('**Tool:** `browser.click`');
    expect(existsSync(bodyPath())).toBe(false);
    const out = printed.join('\n');
    expect(out).toContain('Title: [agent feedback] browser.click');
    expect(printed.at(-1)).toBe('Created: https://github.com/jobshimo/browser-link/issues/99');
  });

  test('"yes" in any case also confirms', async () => {
    seed();
    const { d, execFile } = deps({ ask: vi.fn(async () => ' YES ') });
    expect(await runFeedbackCommand(['issue', '1'], 'en', d)).toBe(0);
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  test('on "N", an empty answer or anything else nothing is created', async () => {
    seed();
    for (const answer of ['N', '', 'no', 'sure']) {
      printed = [];
      const { d, execFile } = deps({ ask: vi.fn(async () => answer) });
      expect(await runFeedbackCommand(['issue', '1'], 'en', d)).toBe(0);
      expect(execFile).not.toHaveBeenCalled();
      expect(printed.at(-1)).toBe('Nothing was created.');
    }
  });

  test('without a terminal it prints the draft and exits 0 without asking or creating', async () => {
    seed();
    const { d, execFile } = deps({ isTTY: false });
    expect(await runFeedbackCommand(['issue', '2'], 'en', d)).toBe(0);
    expect(d.ask).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
    const out = printed.join('\n');
    expect(out).toContain('Title: [agent feedback] browser.find: not-found without near_misses');
    expect(printed.at(-1)).toBe(
      'Not a terminal: nothing was created. Run the command in a terminal to confirm.',
    );
  });

  test('the Spanish prompt and outcome', async () => {
    seed();
    const { d } = deps({ ask: vi.fn(async () => 'n') });
    await runFeedbackCommand(['issue', '1'], 'es', d);
    expect(d.ask).toHaveBeenCalledWith(`¿Crear este issue en ${ISSUE_REPO} con gh? [y/N] `);
    expect(printed.at(-1)).toBe('No se creó nada.');
  });

  test('an unknown or malformed id exits 2 without asking', async () => {
    seed();
    const { d, execFile } = deps();
    expect(await runFeedbackCommand(['issue', '42'], 'en', d)).toBe(2);
    expect(printed).toEqual(['No feedback entry #42.']);
    printed = [];
    expect(await runFeedbackCommand(['issue', 'x'], 'en', d)).toBe(2);
    expect(printed).toEqual(['Usage: browser-link feedback issue <id>']);
    expect(d.ask).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
  });

  test('gh missing exits 1 and says so', async () => {
    seed();
    const { d } = deps({
      execFile: vi.fn(async () => {
        throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
      }),
    });
    expect(await runFeedbackCommand(['issue', '1'], 'en', d)).toBe(1);
    expect(printed.at(-1)).toBe(
      'The GitHub CLI (gh) was not found. Install it and run `gh auth login`, or file the draft above by hand.',
    );
  });

  test('another gh failure exits 1 with its message', async () => {
    seed();
    const { d } = deps({
      execFile: vi.fn(async () => {
        throw new Error('HTTP 401: Bad credentials');
      }),
    });
    expect(await runFeedbackCommand(['issue', '1'], 'en', d)).toBe(1);
    expect(printed.at(-1)).toBe('gh issue create failed: HTTP 401: Bad credentials');
  });
});
