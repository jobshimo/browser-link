import { describe, expect, test } from 'vitest';
import { VERSION } from '../version.js';
import { renderCore } from '../manual/core.js';
import { renderInstallBody } from '../manual/render.js';
import { renderTopic } from '../manual/topics.js';
import { beginMarker, block, END_MARKER, findBlockSpan } from './content.js';

/**
 * The agent-instructions block is the user-facing copy that AI agents read
 * to know when to call `browser.*` tools. Its body is rendered by the agent
 * manual (`../manual/`): the core (reflex protocol with the bilingual trigger
 * phrases as data, success is not proof, habits) and the install topics.
 *
 * These tests pin the structural sections and a few representative phrases,
 * plus the markers the installer relies on.
 */

describe('agent-instructions block — reflex protocol shape', () => {
  test('starts with the ALWAYS ACTIVE reflex protocol heading', () => {
    const out = block();
    expect(out).toContain('## browser-link — reflex protocol (ALWAYS ACTIVE)');
  });

  test('TRIGGER LIST section is present', () => {
    const out = block();
    expect(out).toContain('### TRIGGER LIST');
  });

  test('bilingual EN+ES trigger phrases are present as data, not paraphrased', () => {
    const out = block();
    // English representatives.
    expect(out).toContain("the button doesn't work");
    expect(out).toContain('broken layout');
    expect(out).toContain('does X work?');
    expect(out).toContain('open this in the browser');
    // Spanish representatives.
    expect(out).toContain('no anda el botón');
    expect(out).toContain('está roto');
    expect(out).toContain('abrí esto en el navegador');
    expect(out).toContain('¿anda X?');
  });

  test('SELF-CHECK line is present and references browser.list_tabs', () => {
    const out = block();
    expect(out).toContain('SELF-CHECK after each user message');
    expect(out).toContain('browser.list_tabs');
  });

  test('the former NEVER rules survive: verify before suggesting, executed selectors only, no domain data', () => {
    const out = block();
    expect(out).toContain('`browser.snapshot` and verify the element exists');
    expect(out).toContain('`browser.map.save` the selectors you just executed');
    expect(out).toContain('never domain data');
    expect(out).toContain('use placeholders (`<QUERY>`, `<NAME>`)');
  });

  test('multi-agent claim layer is referenced (claim_tab + release_tab)', () => {
    const out = block();
    expect(out).toContain('browser.claim_tab');
    expect(out).toContain('browser.release_tab');
  });

  test('teaches recall-before-snapshot on a list_tabs map hint (v0.20.0)', () => {
    const out = block();
    expect(out).toContain('`map` field');
    expect(out).toContain('browser.map.recall` BEFORE `browser.snapshot`');
  });

  test('the body is the manual install body: core, then the four install topics', () => {
    const out = block();
    expect(out).toContain(renderInstallBody().join('\n'));
    expect(out).toContain(renderCore({}));
    expect(out).toContain('### Success is not proof');
    expect(out).toContain('### Habits');
    for (const name of ['token-efficiency', 'downloads', 'flows', 'map'] as const) {
      expect(out).toContain(renderTopic(name));
    }
  });

  test('hit_element guidance is in the core of the block', () => {
    expect(block()).toContain('If it is not your target or inside it, the click missed');
  });

  test('token-efficiency topic names the dedicated tools and the evaluate fallbacks', () => {
    const out = block();
    expect(out).toContain('### Token-efficient patterns');
    expect(out).toContain('browser.find');
    expect(out).toContain('within_selector');
    expect(out).toContain('only_interactive');
    expect(out).toContain('pane.scrollTop');
    expect(out).toContain('scrollIntoView');
    expect(out).toContain('latest_id');
  });

  test('one full snapshot per view then since, and ref recovery, are taught', () => {
    const out = block();
    expect(out).toContain('One full `snapshot` per view, then `snapshot({ since: snapshot_id })`');
    expect(out).toContain(
      '`ref-stale` → take a fresh `snapshot`/`find`; never retry the same ref.',
    );
    expect(out).toContain('`semantic_key` in the payload next to it, and use');
    expect(out).toContain('Never save a key for an `ambiguous` entry.');
    expect(out).not.toContain('informational, not an action');
  });

  test('special keys point at browser.press instead of synthetic KeyboardEvent (v0.16.0)', () => {
    const out = block();
    expect(out).toContain('browser.press');
    expect(out).toContain('isTrusted:false');
    expect(out).toContain('isTrusted:true');
  });

  test('settle pattern is taught: click/type/press settle_ms usually replaces a follow-up wait_for', () => {
    const out = block();
    expect(out).toContain('settle_ms');
    expect(out).toContain('mutation_count');
    expect(out).toContain('settle.changes');
    expect(out).toContain('changes: null');
    expect(out).toContain('observer: "<reason>"');
    expect(out).toMatch(/starts\s+after\s+the\s+quiet\s+window/);
    expect(out).not.toContain('before the observer');
  });

  test('downloads go through browser.download, never a click', () => {
    const out = block();
    expect(out).toContain('### Downloads — never click a download button');
    expect(out).toContain('never a click on a download control');
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
