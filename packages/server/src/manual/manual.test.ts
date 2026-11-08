import { describe, expect, test } from 'vitest';
import { renderCore } from './core.js';
import { renderInstallBody, renderServerInstructions } from './render.js';
import { TOPICS, TOPIC_NAMES, renderTopic } from './topics.js';

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
