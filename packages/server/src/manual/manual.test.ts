import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { renderCore } from './core.js';
import { renderInstallBody, renderServerInstructions } from './render.js';
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
 * The manual is one source rendered three ways: the MCP connect-time text
 * (core first, then one section per tool), the installed instructions block
 * (core plus a few topic sections) and, on demand, single topics. The size
 * pins exist because hosts truncate `initialize.instructions` (Claude Code
 * cut it at ~4,090 characters) and the installed block is read every session.
 */

const CORE_LIMIT = 3800;
const CORE_WITH_NOTICE_LIMIT = 4000;
const INSTALL_BODY_LIMIT = 12000;

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

describe('manual core', () => {
  test(`fits in ${CORE_LIMIT} characters without a notice`, () => {
    expect(renderCore({}).length).toBeLessThanOrEqual(CORE_LIMIT);
  });

  test('tells the agent what extension_outdated on list_tabs means, within the budget', () => {
    const core = renderCore({});
    const line = core.split('\n').find((l) => l.includes('`extension_outdated: true`'));
    expect(line).toBeDefined();
    expect(line).toContain('update or reload the extension');
    expect(core.indexOf(line!)).toBeGreaterThan(core.indexOf('### Success is not proof'));
    expect(core.indexOf(line!)).toBeLessThan(core.indexOf('### Habits'));
    expect(core.length).toBeLessThanOrEqual(CORE_LIMIT);
  });

  test('is the exact prefix of the connect-time instructions', () => {
    const core = renderCore({});
    expect(renderServerInstructions({}).startsWith(core)).toBe(true);
  });

  test('without a notice it starts with the reflex protocol heading', () => {
    expect(renderCore({}).split('\n')[0]).toBe('## browser-link — reflex protocol (ALWAYS ACTIVE)');
  });

  test('a notice becomes the first line and still fits the connect-time budget', () => {
    const notice =
      'Your browser-link instructions block is installed-outdated (installed v0.36.0, server v0.38.0): run `browser-link instructions install` and restart the client.';
    const core = renderCore({ notice });
    expect(core.split('\n')[0]).toBe(notice);
    expect(core.length).toBeLessThanOrEqual(CORE_WITH_NOTICE_LIMIT);
    expect(renderServerInstructions({ notice }).startsWith(core)).toBe(true);
  });

  test('carries its sections in the specified order', () => {
    const core = renderCore({});
    const order = [
      '## browser-link — reflex protocol (ALWAYS ACTIVE)',
      '### TRIGGER LIST',
      '### Success is not proof',
      '### Habits',
      '### Shared tabs and cdp-direct',
      '### Depth on demand',
    ].map((h) => core.indexOf(h));
    for (const at of order) expect(at).toBeGreaterThanOrEqual(0);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test('tells the agent that a hit_element off the target means the click missed', () => {
    const core = renderCore({});
    expect(core).toContain('`hit_element`');
    expect(core).toMatch(/hit_element[^\n]*not your target or inside it/);
  });

  test('names every success-is-not-proof field', () => {
    const core = renderCore({});
    for (const field of [
      'settle.settled: false',
      'mutation_count: 0',
      '`since_status`',
      '`reresolved: true`',
      '`ref-stale`',
      '`matched: false`',
    ]) {
      expect(core).toContain(field);
    }
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
  test('the per-tool sections follow the core under a Tools heading', () => {
    const out = renderServerInstructions({});
    const core = renderCore({});
    const tools = out.indexOf('\n## Tools\n');
    expect(tools).toBeGreaterThanOrEqual(core.length);
    expect(out.indexOf('### browser.click')).toBeGreaterThan(tools);
  });
});

describe('installed block body', () => {
  test(`fits in ${INSTALL_BODY_LIMIT} characters`, () => {
    expect(renderInstallBody().join('\n').length).toBeLessThanOrEqual(INSTALL_BODY_LIMIT);
  });

  test('starts with the core', () => {
    expect(renderInstallBody().join('\n').startsWith(renderCore({}))).toBe(true);
  });

  test('carries the token-efficiency, downloads, flows and map topics in that order', () => {
    const out = renderInstallBody().join('\n');
    const at = (['token-efficiency', 'downloads', 'flows', 'map'] as const).map((name) =>
      out.indexOf(renderTopic(name)),
    );
    for (const i of at) expect(i).toBeGreaterThan(0);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  test('repeats no sentence of the core verbatim', () => {
    const out = renderInstallBody().join('\n');
    for (const sentence of sentences(renderCore({}))) {
      expect(occurrences(out, sentence), sentence).toBe(1);
    }
  });

  test('is a list of single lines (no embedded line breaks)', () => {
    for (const line of renderInstallBody()) expect(line).not.toContain('\n');
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

describe('manual core after the retargeted click failure', () => {
  test('names the retargeted click error and its way out', () => {
    const core = renderCore({});
    expect(core).toContain('`retargeted` error on `click`');
    expect(core).toMatch(/retargeted[^\n]*ancestor of your target[^\n]*`force: true`/);
  });

  test('scopes hit_element to the cases that still succeed', () => {
    const line = renderCore({})
      .split('\n')
      .find((l) => l.startsWith('- `hit_element`'));
    expect(line).toBeDefined();
    expect(line).toContain('`pointer-events: none`');
    expect(line).toContain('`force: true`');
    expect(line).toContain('the click missed');
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
    expect(core.startsWith(`${notice}\n\n## browser-link — reflex protocol`)).toBe(true);
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
        install: () => installAt(file, displayName, { allowOutsideHome: true }),
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
      expect(result.statuses[0]!.state).toEqual({ kind: 'installed', version: SERVER_VERSION });
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
