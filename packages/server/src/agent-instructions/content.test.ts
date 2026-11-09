import { describe, expect, test } from 'vitest';
import { VERSION } from '../version.js';
import { renderCore } from '../manual/core.js';
import { renderInstallBody, renderTrigger } from '../manual/render.js';
import { renderTopic } from '../manual/topics.js';
import {
  BEGIN_PREFIX,
  beginMarker,
  block,
  END_MARKER,
  findBlockSpan,
  modeMarker,
} from './content.js';

/**
 * The agent-instructions block is what every agent session reads. Its body is
 * rendered by the agent manual (`../manual/`): by default the short trigger
 * (what browser-link is, when to use it, where the rules come from); with
 * `--with-core`, the trigger followed by the core rules. Everything else is
 * served on demand by `browser.manual`, so the topics are pinned on
 * `renderTopic` here, not on the block.
 *
 * These tests pin the two shapes, the mode marker the start-time refresh
 * reads, and the markers the installer relies on.
 */

describe('agent-instructions block — default (trigger only)', () => {
  test('carries the trigger and the trigger mode marker', () => {
    const out = block();
    expect(out).toContain(renderTrigger());
    expect(out).toContain(renderInstallBody().join('\n'));
    expect(out).toContain(modeMarker('trigger'));
    expect(modeMarker('trigger')).toBe('<!-- browser-link:instructions:mode=trigger -->');
  });

  test('does not carry the core or any topic', () => {
    const out = block();
    expect(out).not.toContain(renderCore({}));
    expect(out).not.toContain('Curation');
    for (const name of ['token-efficiency', 'downloads', 'flows', 'map'] as const) {
      expect(out).not.toContain(renderTopic(name));
    }
  });

  test('tells the agent the first browser call returns the rules', () => {
    expect(block()).toContain(
      'Your first browser tool call returns the rules; `browser.manual()` has the rest.',
    );
  });
});

describe('agent-instructions block — with the core', () => {
  test('carries the trigger, then the core, and the core mode marker', () => {
    const out = block(VERSION, '\n', { withCore: true });
    expect(out).toContain(`${renderTrigger()}\n\n${renderCore({})}`);
    expect(out).toContain(modeMarker('core'));
    expect(out).not.toContain(modeMarker('trigger'));
  });

  test('carries the wrap_up rule and the curation rules', () => {
    const out = block(VERSION, '\n', { withCore: true });
    expect(out).toContain('call `browser.wrap_up`');
    expect(out).toContain('8. In doubt, drop.');
  });

  test('CRLF keeps every line ending uniform', () => {
    const out = block(VERSION, '\r\n', { withCore: true });
    expect(out.replace(/\r\n/g, '')).not.toContain('\n');
  });
});

describe('findBlockSpan reads the mode', () => {
  test('core when the marker says so, trigger otherwise', () => {
    expect(findBlockSpan(block(VERSION, '\n', { withCore: true }))?.mode).toBe('core');
    expect(findBlockSpan(block())?.mode).toBe('trigger');
  });

  test('a block written before modes existed reads as trigger', () => {
    const legacy = `${beginMarker('0.44.1')}\nold body\n${END_MARKER}\n`;
    expect(findBlockSpan(legacy)?.mode).toBe('trigger');
    expect(findBlockSpan(`${BEGIN_PREFIX} -->\nbody\n${END_MARKER}\n`)?.mode).toBe('trigger');
  });

  test('a mode marker outside the block is ignored', () => {
    const text = `${modeMarker('core')}\n\n${block()}`;
    expect(findBlockSpan(text)?.mode).toBe('trigger');
  });
});

describe('what left the block is served by the manual topics', () => {
  test('map topic: executed selectors only, placeholders, no domain data, semantic_key', () => {
    const topic = renderTopic('map');
    expect(topic).toContain('`browser.map.save` the selectors you just executed');
    expect(topic).toContain('never domain data');
    expect(topic).toContain('use placeholders (`<QUERY>`, `<NAME>`)');
    expect(topic).toContain('`semantic_key` in the payload next to it, and use');
    expect(topic).toContain('Never save a key for an `ambiguous` entry.');
  });

  test('results topic: verify before suggesting, ref recovery, snapshot since', () => {
    const topic = renderTopic('results');
    expect(topic).toContain('`browser.snapshot` and verify the element exists');
    expect(topic).toContain(
      '`ref-stale` → take a fresh `snapshot`/`find`; never retry the same ref.',
    );
    expect(topic).toContain(
      'One full `snapshot` per view, then `snapshot({ since: snapshot_id })`',
    );
    expect(topic).toContain('if it is not your target or inside it, the click missed');
    expect(topic).toContain('`retargeted` error on `click`');
  });

  test('token-efficiency topic names the dedicated tools and the evaluate fallbacks', () => {
    const topic = renderTopic('token-efficiency');
    expect(topic).toContain('### Token-efficient patterns');
    expect(topic).toContain('within_selector');
    expect(topic).toContain('only_interactive');
    expect(topic).toContain('pane.scrollTop');
    expect(topic).toContain('scrollIntoView');
    expect(topic).toContain('latest_id');
    expect(topic).toContain('browser.press');
    expect(topic).toContain('isTrusted:false');
    expect(topic).toContain('isTrusted:true');
  });

  test('settle pattern is taught: click/type/press settle_ms usually replaces a follow-up wait_for', () => {
    const topic = renderTopic('token-efficiency');
    expect(topic).toContain('settle_ms');
    expect(topic).toContain('mutation_count');
    expect(topic).toContain('settle.changes');
    expect(topic).toContain('changes: null');
    expect(topic).toContain('observer: "<reason>"');
    expect(topic).toMatch(/starts\s+after\s+the\s+quiet\s+window/);
    expect(topic).not.toContain('before the observer');
  });

  test('downloads topic: browser.download, never a click', () => {
    expect(renderTopic('downloads')).toContain('### Downloads — never click a download button');
    expect(renderCore({})).toContain('Downloads only through `browser.download`');
  });

  test('flows topic: bulk work is flow + repeat, NEVER a loop inside evaluate', () => {
    const topic = renderTopic('flows');
    expect(topic).toContain('NEVER a loop inside `evaluate`');
    expect(topic).toContain('max_iterations');
    expect(topic).toContain('while_found');
    expect(topic).toContain('dry_run: true');
    expect(topic).toContain('trusted CDP input with the occlusion guard');
    expect(topic).toContain('`detach`, then poll');
  });

  test('flows topic carries the safety-critical evaluate relaunch check', () => {
    const topic = renderTopic('flows');
    expect(topic).toContain('KEEPS RUNNING');
    expect(topic).toContain('BEFORE relaunching');
    expect(topic).toContain('window.__job?.running');
    expect(topic).toContain('The guard on `running` is mandatory');
    expect(topic).toContain('window.__job?.finished === true');
    expect(topic).toContain('window.__job.manifest.push(id)');
  });

  test('token-efficiency topic teaches the two silent wrong-answer traps of reading data', () => {
    const topic = renderTopic('token-efficiency');
    expect(topic).toContain('DOMParser');
    expect(topic).toContain('`undefined` on a document with no layout');
    expect(topic).toContain('authoritative total elsewhere');
    expect(topic).toContain('empty-state string');
  });
});

describe('agent-instructions block — markers', () => {
  test('block is fenced with versioned BEGIN + END markers', () => {
    const out = block();
    expect(out).toContain(beginMarker());
    expect(out).toContain(END_MARKER);
    expect(out).toContain(`v${VERSION}`);
  });

  test('findBlockSpan locates the block inside a host file', () => {
    const wrapped = `# user notes\n\n${block()}\n\n## other\n`;
    const span = findBlockSpan(wrapped);
    expect(span).not.toBeNull();
    if (span) {
      expect(span.installedVersion).toBe(VERSION);
    }
  });
});
