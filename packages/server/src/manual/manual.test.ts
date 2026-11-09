import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { CORE_HEADING, renderCore } from './core.js';
import { renderInstallBody, renderServerInstructions, renderTrigger } from './render.js';
import { TOPICS, TOPIC_NAMES, renderTopic } from './topics.js';
import { detectInstructionsStatus, formatClientStatus, instructionsNotice } from './status.js';
import { refreshNotice, refreshOutdatedBlocks } from './refresh.js';
import {
  type ClientId,
  type InstructionsInstaller,
  type InstructionsState,
} from '../agent-instructions/index.js';
import { END_MARKER, beginMarker } from '../agent-instructions/content.js';
import { detectAt, installAt } from '../agent-instructions/file-ops.js';
import { VERSION as SERVER_VERSION } from '../version.js';

/**
 * The manual is one source rendered four ways: the installed trigger (what
 * browser-link is and when to use it, read every session), the core (the
 * rules, returned by the first browser tool call and first in the MCP
 * connect-time text, which hosts truncate), the installed block body
 * (trigger, plus the core with `--with-core`) and, on demand, single topics.
 */

const TRIGGER_LIMIT = 600;
const CORE_LIMIT = 2000;
const CORE_WITH_NOTICE_LIMIT = 2300;
const INSTALL_BODY_LIMIT = 600;
const INSTALL_BODY_WITH_CORE_LIMIT = 2700;

/** Sentences of at least 20 characters, split on line breaks and on
 * sentence-ending punctuation followed by a space. */
function sentences(text: string): string[] {
  return text
    .split(/\n|(?<=[.:;!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 20);
}

function occurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}

describe('installed trigger', () => {
  test(`fits in ${TRIGGER_LIMIT} characters`, () => {
    expect(renderTrigger().length).toBeLessThanOrEqual(TRIGGER_LIMIT);
  });

  test('says what browser-link is, when to use it, and where the rules come from', () => {
    const trigger = renderTrigger();
    expect(trigger.split('\n')[0]).toBe('## browser-link');
    expect(trigger).toContain('Chrome tabs the user connected through its extension');
    expect(trigger).toContain('Use it when the user mentions a web page');
    expect(trigger).toContain('"no anda"');
    expect(trigger).toContain(
      'Your first browser tool call returns the rules; `browser.manual()` has the rest.',
    );
  });

  test('repeats no sentence of the core', () => {
    const core = renderCore({});
    for (const sentence of sentences(renderTrigger())) {
      expect(core.includes(sentence), sentence).toBe(false);
    }
  });
});

describe('manual core', () => {
  test(`fits in ${CORE_LIMIT} characters without a notice`, () => {
    expect(renderCore({}).length).toBeLessThanOrEqual(CORE_LIMIT);
  });

  test('is the exact prefix of the connect-time instructions', () => {
    const core = renderCore({});
    expect(renderServerInstructions({}).startsWith(core)).toBe(true);
  });

  test('without a notice it starts with the rules heading', () => {
    expect(CORE_HEADING).toBe('## browser-link rules');
    expect(renderCore({}).split('\n')[0]).toBe(CORE_HEADING);
  });

  test('a notice becomes the first line and still fits the connect-time budget', () => {
    const notice =
      'Your browser-link instructions block is installed-outdated (installed v0.36.0, server v0.38.0): run `browser-link instructions install` and restart the client.';
    const core = renderCore({ notice });
    expect(core.split('\n')[0]).toBe(notice);
    expect(core.length).toBeLessThanOrEqual(CORE_WITH_NOTICE_LIMIT);
    expect(renderServerInstructions({ notice }).startsWith(core)).toBe(true);
  });

  test('carries its rules in the specified order', () => {
    const core = renderCore({});
    const order = [
      'Use `browser.*` when the request involves a web page',
      'Call `browser.list_tabs` first',
      '`ok` is not proof',
      'Act on the `ref` from your last `snapshot`/`find`',
      'Before writing JS, try `browser.find`, `browser.read({ name })` and `browser.flow({ name })`',
      'Downloads only through `browser.download`',
      'call `browser.wrap_up`',
      'Curation',
      'browser.manual()',
    ].map((h) => core.indexOf(h));
    for (const at of order) expect(at).toBeGreaterThanOrEqual(0);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test('list_tabs first, reading the knowledge field', () => {
    expect(renderCore({})).toContain(
      "Call `browser.list_tabs` first and read each tab's `knowledge`",
    );
  });

  test('success is not proof: hit_element, settle and expect', () => {
    const core = renderCore({});
    expect(core).toMatch(/`hit_element` that is not your target means the click missed/);
    expect(core).toContain('`settle.settled: false` or `mutation_count: 0`');
    expect(core).toContain('quiet, not effect');
    expect(core).toContain('Pass `expect` when the effect matters');
  });

  test('the wrap_up rule and what pending_wrap_up means', () => {
    const core = renderCore({});
    expect(core).toContain(
      'Before you answer the user after using the browser, call `browser.wrap_up`',
    );
    expect(core).toContain('`pending_wrap_up: n` on a result means n items wait for it');
  });

  test('the eight curation rules, numbered as the server enforces them', () => {
    const lines = renderCore({}).split('\n');
    const rules = [
      '1. Only what worked enters knowledge; failures stay as evidence.',
      "2. Keep a reader only if it is reusable without this task's data; data literals become `<PLACEHOLDER>` templates.",
      '3. Never credentials, tokens, cookies, storage or personal data, even as structure; mutations are never readers.',
      '4. Names say what is returned: kebab-case, ≤ 40 chars, no verbs.',
      '5. One-offs are dropped by default.',
      '6. A pitfall is a server-generated candidate you confirm, never free text.',
      '7. Nothing about the user, only how the app works.',
      '8. In doubt, drop.',
    ];
    const at = rules.map((r) => lines.indexOf(r));
    for (const i of at) expect(i).toBeGreaterThan(0);
    expect(at).toEqual(at.map((_, k) => at[0]! + k));
  });

  test('every rule line names the failure it prevents', () => {
    const bullets = renderCore({})
      .split('\n')
      .filter((l) => l.startsWith('- '));
    expect(bullets).toHaveLength(6);
    for (const line of bullets) expect(line, line).toMatch(/[;:,] [^;:]+\.$/);
  });

  test('points at browser.manual for the index, a tool and every topic', () => {
    const core = renderCore({});
    expect(core).toContain('`browser.manual()`');
    expect(core).toContain('browser.manual({ tool');
    expect(core).toContain('browser.manual({ topic })');
    for (const name of TOPIC_NAMES) expect(core).toContain(name);
  });
});

describe('connect-time instructions', () => {
  test('are the core, then the per-tool sections under a Tools heading', () => {
    const out = renderServerInstructions({});
    const core = renderCore({});
    expect(out.startsWith(`${core}\n\n## Tools\n`)).toBe(true);
    expect(out.indexOf('### browser.click')).toBeGreaterThan(core.length);
  });
});

describe('installed block body', () => {
  test(`by default is the trigger only, within ${INSTALL_BODY_LIMIT} characters`, () => {
    const body = renderInstallBody().join('\n');
    expect(body).toBe(renderTrigger());
    expect(body.length).toBeLessThanOrEqual(INSTALL_BODY_LIMIT);
    expect(renderInstallBody({ withCore: false }).join('\n')).toBe(body);
  });

  test(`with the core is the trigger, a blank line and the core, within ${INSTALL_BODY_WITH_CORE_LIMIT} characters`, () => {
    const body = renderInstallBody({ withCore: true }).join('\n');
    expect(body).toBe(`${renderTrigger()}\n\n${renderCore({})}`);
    expect(body.length).toBeLessThanOrEqual(INSTALL_BODY_WITH_CORE_LIMIT);
  });

  test('never carries a topic', () => {
    const body = renderInstallBody({ withCore: true }).join('\n');
    for (const name of TOPIC_NAMES) expect(body).not.toContain(renderTopic(name));
  });

  test('repeats no sentence verbatim', () => {
    const out = renderInstallBody({ withCore: true }).join('\n');
    for (const sentence of sentences(out)) {
      expect(occurrences(out, sentence), sentence).toBe(1);
    }
  });

  test('is a list of single lines (no embedded line breaks)', () => {
    for (const withCore of [false, true]) {
      for (const line of renderInstallBody({ withCore })) expect(line).not.toContain('\n');
    }
  });
});

describe('topics', () => {
  test('TOPIC_NAMES matches the TOPICS keys', () => {
    expect([...TOPIC_NAMES].sort()).toEqual(Object.keys(TOPICS).sort());
    expect(TOPIC_NAMES).toEqual([
      'downloads',
      'canvas',
      'screenshot',
      'flows',
      'map',
      'token-efficiency',
      'multi-agent',
      'cdp-direct',
      'results',
    ]);
  });

  test('every topic renders with a title heading and a non-empty body', () => {
    for (const name of TOPIC_NAMES) {
      const topic = TOPICS[name];
      expect(topic.title.trim().length).toBeGreaterThan(0);
      expect(topic.body.trim().length).toBeGreaterThan(0);
      const rendered = renderTopic(name);
      expect(rendered.startsWith(`### ${topic.title}\n\n`)).toBe(true);
      expect(rendered).toContain(topic.body);
    }
  });

  test('no topic repeats a sentence of the core verbatim', () => {
    const core = renderCore({});
    for (const name of TOPIC_NAMES) {
      for (const sentence of sentences(renderTopic(name))) {
        expect(core.includes(sentence), `${name}: ${sentence}`).toBe(false);
      }
    }
  });
});

describe('what left the core lives in topics', () => {
  test('the results topic carries every success-is-not-proof field', () => {
    const topic = renderTopic('results');
    for (const field of [
      '`hit_element` on `click`',
      '`retargeted` error on `click`',
      'settle.settled: false',
      '`since_status`',
      '`reresolved: true`',
      '`ref-stale`',
      '`matched: false`',
      '`extension_outdated: true`',
      'Tab not connected',
    ]) {
      expect(topic).toContain(field);
    }
    expect(topic).toMatch(/retargeted[^\n]*ancestor of your target[^\n]*`force: true`/);
    expect(topic).toMatch(/hit_element[^\n]*not your target or inside it, the click missed/);
    expect(topic).toContain('update or reload the extension');
  });

  test('the multi-agent and cdp-direct topics carry the claim and gate lines', () => {
    const multi = renderTopic('multi-agent');
    expect(multi).toContain(
      '`browser.claim_tab` before a multi-step flow, `browser.release_tab` after.',
    );
    expect(multi).toContain('do not spin-retry');
    const cdp = renderTopic('cdp-direct');
    expect(cdp).toContain('browser-link config set cdp-direct.enabled true');
    expect(cdp).toContain('browser-link cdp allow');
    expect(cdp).toContain('download by selector');
  });
});

describe('instructions-block status and notice', () => {
  const VERSION = '0.38.0';
  const st = (kind: string, version?: string | null) =>
    ({ kind, ...(version === undefined ? {} : { version }) }) as InstructionsState;
  const entry = (displayName: string, state: InstructionsState) => ({
    id: 'claude' as const,
    displayName,
    state,
  });

  test('no notice when every block is installed or the file is absent', () => {
    expect(
      instructionsNotice(
        [entry('Claude Code', st('installed', '0.38.0')), entry('OpenCode', st('no-file'))],
        VERSION,
      ),
    ).toBeUndefined();
  });

  test('an outdated block yields the installed-outdated notice with both versions', () => {
    expect(
      instructionsNotice(
        [
          entry('Claude Code', st('not-installed')),
          entry('OpenCode', st('installed-outdated', '0.36.0')),
        ],
        VERSION,
      ),
    ).toBe(
      'Your browser-link instructions block is installed-outdated (installed v0.36.0, server v0.38.0): run `browser-link instructions install` and restart the client.',
    );
  });

  test('a client without a block is a choice: not-installed, no-file and corrupt never yield a notice', () => {
    expect(
      instructionsNotice(
        [
          entry('Claude Code', st('not-installed')),
          entry('OpenCode', st('no-file')),
          entry('GitHub Copilot CLI', { kind: 'corrupt', reason: 'multiple-begin-markers' }),
        ],
        VERSION,
      ),
    ).toBeUndefined();
  });

  test('the realistic notice sits first and core + notice stays within the budget', () => {
    const notice = instructionsNotice(
      [entry('Claude Code', st('installed-outdated', '0.37.0'))],
      '0.38.0',
    )!;
    const core = renderCore({ notice });
    expect(core.startsWith(`${notice}\n\n${CORE_HEADING}\n`)).toBe(true);
    expect(core.length).toBeLessThanOrEqual(CORE_WITH_NOTICE_LIMIT);
  });

  test('status lines per state', () => {
    expect(formatClientStatus(entry('A', st('installed', '0.38.0')), VERSION)).toBe(
      'A: installed v0.38.0',
    );
    expect(formatClientStatus(entry('A', st('installed-outdated', '0.36.0')), VERSION)).toBe(
      'A: installed-outdated v0.36.0 → v0.38.0: run browser-link instructions install',
    );
    expect(formatClientStatus(entry('A', st('not-installed')), VERSION)).toBe('A: not-installed');
    expect(formatClientStatus(entry('A', st('no-file')), VERSION)).toBe('A: no-file');
  });

  test('detection reads every installer and skips one that throws', () => {
    const ok = {
      id: 'claude',
      displayName: 'Claude Code',
      detect: () => ({ filePath: 'x', state: st('installed', '0.38.0') }),
    } as unknown as InstructionsInstaller;
    const broken = {
      id: 'opencode',
      displayName: 'OpenCode',
      detect: () => {
        throw new Error('EACCES');
      },
    } as unknown as InstructionsInstaller;
    expect(detectInstructionsStatus([ok, broken])).toEqual([
      { id: 'claude', displayName: 'Claude Code', state: st('installed', '0.38.0') },
    ]);
  });
});

describe('instructions block refreshed at primary start', () => {
  const st = (kind: string, version?: string | null) =>
    ({ kind, ...(version === undefined ? {} : { version }) }) as InstructionsState;

  /** A stub installer whose `install()` turns its state into `installed`
   * (or throws `failWith`), counting calls. */
  function stub(
    id: 'claude' | 'opencode' | 'copilot',
    displayName: string,
    initial: InstructionsState,
    failWith?: string,
  ) {
    let state = initial;
    const install = vi.fn(() => {
      if (failWith !== undefined) throw new Error(failWith);
      state = st('installed', '9.9.9');
      return `${displayName}: block refreshed.`;
    });
    const installer = {
      id,
      displayName,
      filePath: () => 'x',
      detect: () => ({ filePath: 'x', state }),
      install,
      uninstall: () => '',
    } as unknown as InstructionsInstaller;
    return { installer, install };
  }

  const statusOf = (i: InstructionsInstaller) => ({
    id: i.id,
    displayName: i.displayName,
    state: i.detect().state,
  });

  test('an outdated client is refreshed once and its status becomes installed', () => {
    const a = stub('claude', 'Claude Code', st('installed-outdated', '0.37.0'));
    const result = refreshOutdatedBlocks({
      statuses: [statusOf(a.installer)],
      installers: [a.installer],
      enabled: true,
    });
    expect(a.install).toHaveBeenCalledTimes(1);
    expect(result.statuses[0]!.state.kind).toBe('installed');
    expect(result.refreshed.map((r) => r.displayName)).toEqual(['Claude Code']);
    expect(result.failed).toEqual([]);
    expect(refreshNotice(result, '0.39.0')).toBe(
      'Your browser-link instructions block was updated to v0.39.0 for Claude Code: restart the client to load it.',
    );
  });

  test('several refreshed clients are named in one notice', () => {
    const a = stub('claude', 'Claude Code', st('installed-outdated', '0.37.0'));
    const b = stub('opencode', 'OpenCode', st('installed-outdated', null));
    const installers = [a.installer, b.installer];
    const result = refreshOutdatedBlocks({
      statuses: installers.map(statusOf),
      installers,
      enabled: true,
    });
    expect(refreshNotice(result, '0.39.0')).toBe(
      'Your browser-link instructions block was updated to v0.39.0 for Claude Code, OpenCode: restart the client to load it.',
    );
  });

  test('not-installed, no-file and corrupt clients are never touched', () => {
    const a = stub('claude', 'Claude Code', st('not-installed'));
    const b = stub('opencode', 'OpenCode', st('no-file'));
    const c = stub('copilot', 'GitHub Copilot CLI', {
      kind: 'corrupt',
      reason: 'multiple-begin-markers',
    });
    const installers = [a.installer, b.installer, c.installer];
    const result = refreshOutdatedBlocks({
      statuses: installers.map(statusOf),
      installers,
      enabled: true,
    });
    expect(a.install).not.toHaveBeenCalled();
    expect(b.install).not.toHaveBeenCalled();
    expect(c.install).not.toHaveBeenCalled();
    expect(result.refreshed).toEqual([]);
    expect(refreshNotice(result, '0.39.0')).toBeUndefined();
  });

  test('enabled: false never calls install and keeps the installed-outdated notice', () => {
    const a = stub('claude', 'Claude Code', st('installed-outdated', '0.37.0'));
    const result = refreshOutdatedBlocks({
      statuses: [statusOf(a.installer)],
      installers: [a.installer],
      enabled: false,
    });
    expect(a.install).not.toHaveBeenCalled();
    expect(refreshNotice(result, '0.39.0')).toBe(
      'Your browser-link instructions block is installed-outdated (installed v0.37.0, server v0.39.0): run `browser-link instructions install` and restart the client.',
    );
  });

  test('a failed refresh keeps the installed-outdated notice with the reason; the others are still refreshed', () => {
    const a = stub('claude', 'Claude Code', st('installed-outdated', '0.37.0'), 'EACCES: denied');
    const b = stub('opencode', 'OpenCode', st('installed-outdated', '0.36.0'));
    const installers = [a.installer, b.installer];
    const result = refreshOutdatedBlocks({
      statuses: installers.map(statusOf),
      installers,
      enabled: true,
    });
    expect(a.install).toHaveBeenCalledTimes(1);
    expect(b.install).toHaveBeenCalledTimes(1);
    expect(result.statuses.map((s) => s.state.kind)).toEqual(['installed-outdated', 'installed']);
    expect(result.failed).toEqual([
      { id: 'claude', displayName: 'Claude Code', message: 'EACCES: denied' },
    ]);
    expect(refreshNotice(result, '0.39.0')).toBe(
      'Your browser-link instructions block was updated to v0.39.0 for OpenCode: restart the client to load it. ' +
        'Your browser-link instructions block is installed-outdated (installed v0.37.0, server v0.39.0): run `browser-link instructions install` and restart the client. ' +
        'Automatic refresh failed for Claude Code: EACCES: denied',
    );
  });

  describe('against a temp home with the real file operations', () => {
    let home: string;

    /** The production installer shape over the real `detectAt`/`installAt`,
     * rooted at an injected home instead of the process environment. The
     * temp dir is not under the real home, so the home guard is lifted here
     * exactly as an explicit client override (`COPILOT_HOME`) lifts it. */
    function installerAt(id: ClientId, displayName: string, file: string): InstructionsInstaller {
      return {
        id,
        displayName,
        filePath: () => file,
        detect: () => detectAt(file),
        install: (opts = {}) => installAt(file, displayName, { ...opts, allowOutsideHome: true }),
        uninstall: () => '',
      };
    }

    const claudeFile = () => join(home, '.claude', 'CLAUDE.md');
    const claudeInstaller = () => installerAt('claude', 'Claude Code', claudeFile());

    beforeEach(() => {
      home = mkdtempSync(join(tmpdir(), 'browser-link-refresh-'));
      mkdirSync(join(home, '.claude'), { recursive: true });
    });

    afterEach(() => {
      rmSync(home, { recursive: true, force: true });
    });

    test('an outdated block is refreshed in place, keeping the rest of the file', () => {
      const file = claudeFile();
      writeFileSync(file, `# Mine\n\n${beginMarker('0.0.1')}\nold body\n${END_MARKER}\n\nTail.\n`);
      const installers = [claudeInstaller()];
      const result = refreshOutdatedBlocks({
        statuses: detectInstructionsStatus(installers),
        installers,
        enabled: true,
      });
      expect(result.statuses[0]!.state).toEqual({
        kind: 'installed',
        version: SERVER_VERSION,
        mode: 'trigger',
      });
      const text = readFileSync(file, 'utf8');
      expect(text.startsWith('# Mine\n')).toBe(true);
      expect(text).toContain(beginMarker());
      expect(text).not.toContain('old body');
      expect(text.trimEnd().endsWith('Tail.')).toBe(true);
      expect(refreshNotice(result)).toContain(`was updated to v${SERVER_VERSION} for Claude Code`);
    });

    test('a file without a block and a corrupt file are left byte-identical', () => {
      const file = claudeFile();
      const installers = [claudeInstaller()];
      for (const body of [
        '# Mine, no block\n',
        `${beginMarker('0.0.1')}\na\n${END_MARKER}\n${beginMarker('0.0.1')}\nb\n${END_MARKER}\n`,
      ]) {
        writeFileSync(file, body);
        refreshOutdatedBlocks({
          statuses: detectInstructionsStatus(installers),
          installers,
          enabled: true,
        });
        expect(readFileSync(file, 'utf8')).toBe(body);
      }
    });

    test('a block removed after the status was read is not re-added', () => {
      const file = claudeFile();
      const installers = [claudeInstaller()];
      const statuses = detectInstructionsStatus(installers);
      expect(statuses[0]!.state.kind).toBe('no-file');
      writeFileSync(file, `${beginMarker('0.0.1')}\nold\n${END_MARKER}\n`);
      const stale = detectInstructionsStatus(installers);
      expect(stale[0]!.state.kind).toBe('installed-outdated');
      writeFileSync(file, '# Mine, block removed\n');
      const result = refreshOutdatedBlocks({ statuses: stale, installers, enabled: true });
      expect(readFileSync(file, 'utf8')).toBe('# Mine, block removed\n');
      expect(result.refreshed).toEqual([]);
      expect(result.statuses[0]!.state.kind).toBe('not-installed');
    });

    test('a block that stopped being ours is skipped and left byte-identical; the next client is still refreshed', () => {
      // The status said installed-outdated, but by write time the file holds
      // two blocks (the user pasted one): the re-read sees it corrupt, nothing is
      // rewritten, and the following client is refreshed as usual.
      const file = claudeFile();
      const corrupt = `${beginMarker('0.0.1')}\na\n${END_MARKER}\n${beginMarker('0.0.1')}\nb\n${END_MARKER}\n`;
      writeFileSync(file, corrupt);
      const otherFile = join(home, '.config', 'opencode', 'AGENTS.md');
      mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
      writeFileSync(otherFile, `${beginMarker('0.0.1')}\nold\n${END_MARKER}\n`);
      const installers = [claudeInstaller(), installerAt('opencode', 'OpenCode', otherFile)];
      const outdated = { kind: 'installed-outdated', version: '0.0.1' } as const;
      const result = refreshOutdatedBlocks({
        statuses: installers.map((i) => ({
          id: i.id,
          displayName: i.displayName,
          state: outdated,
        })),
        installers,
        enabled: true,
      });
      expect(readFileSync(file, 'utf8')).toBe(corrupt);
      expect(result.statuses.map((x) => x.state.kind)).toEqual(['corrupt', 'installed']);
      expect(result.refreshed.map((r) => r.id)).toEqual(['opencode']);
      expect(readFileSync(otherFile, 'utf8')).toContain(beginMarker());
    });

    test('an outdated block installed with --with-core is refreshed with the core kept', () => {
      const file = claudeFile();
      installAt(file, 'Claude Code', { allowOutsideHome: true, withCore: true });
      writeFileSync(file, readFileSync(file, 'utf8').replace(beginMarker(), beginMarker('0.0.1')));
      expect(detectAt(file).state).toEqual({
        kind: 'installed-outdated',
        version: '0.0.1',
        mode: 'core',
      });
      const installers = [claudeInstaller()];
      const result = refreshOutdatedBlocks({
        statuses: detectInstructionsStatus(installers),
        installers,
        enabled: true,
      });
      expect(result.statuses[0]!.state).toEqual({
        kind: 'installed',
        version: SERVER_VERSION,
        mode: 'core',
      });
      const text = readFileSync(file, 'utf8');
      expect(text).toContain(renderTrigger());
      expect(text).toContain(renderCore({}));
    });

    test('a legacy block (no mode marker, old full body) is refreshed to the trigger only', () => {
      const file = claudeFile();
      writeFileSync(
        file,
        `${beginMarker('0.0.1')}\n${'old core line\n'.repeat(50)}${END_MARKER}\n`,
      );
      const installers = [claudeInstaller()];
      refreshOutdatedBlocks({
        statuses: detectInstructionsStatus(installers),
        installers,
        enabled: true,
      });
      const text = readFileSync(file, 'utf8');
      expect(text).toContain(renderTrigger());
      expect(text).not.toContain(renderCore({}));
      expect(text).not.toContain('old core line');
      expect(detectAt(file).state).toEqual({
        kind: 'installed',
        version: SERVER_VERSION,
        mode: 'trigger',
      });
    });
  });

  test('the refresh passes the installed mode to install()', () => {
    for (const [mode, withCore] of [
      ['core', true],
      ['trigger', false],
      [undefined, false],
    ] as const) {
      const a = stub('claude', 'Claude Code', {
        kind: 'installed-outdated',
        version: '0.37.0',
        ...(mode ? { mode } : {}),
      });
      refreshOutdatedBlocks({
        statuses: [statusOf(a.installer)],
        installers: [a.installer],
        enabled: true,
      });
      expect(a.install).toHaveBeenCalledWith({ withCore });
    }
  });
});

describe('map learning in the manual', () => {
  test('the map topic explains learned entries and the map-learning switch', () => {
    const map = renderTopic('map');
    expect(map).toContain('`learned`');
    expect(map).toContain('browser-link config set map-learning off');
    expect(map).toMatch(/Never values/);
  });

  test('a topic documents the browser.activity friction report', () => {
    expect(renderTopic('multi-agent')).toContain('browser.activity({ summary: true })');
  });
});
