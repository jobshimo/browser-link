import { describe, expect, test } from 'vitest';
import { VERSION } from '../version.js';
import { beginMarker, block, END_MARKER, findBlockSpan } from './content.js';

/**
 * The agent-instructions block is the user-facing copy that AI agents read
 * to know when to call `browser.*` tools. v0.8.3 rewrites it as an
 * engram-style reflex protocol — imperative trigger list, bilingual
 * trigger phrases as data, explicit SELF-CHECK + NEVER sections.
 *
 * These tests assert structural sections and a few representative phrases.
 * Wording is allowed to evolve without breaking the suite as long as the
 * shape (trigger list + bilingual phrases + self-check + never) survives.
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

  test('SELF-CHECK section is present and references browser.list_tabs', () => {
    const out = block();
    expect(out).toContain('### SELF-CHECK');
    expect(out).toContain('browser.list_tabs');
  });

  test('NEVER section enumerates the four forbidden behaviors', () => {
    const out = block();
    expect(out).toContain('### NEVER');
    expect(out).toContain('Speculate about DOM state');
    expect(out).toContain('try clicking X');
    expect(out).toContain('selectors you have not just successfully executed');
    expect(out).toContain('domain data');
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

  test('TOKEN-EFFICIENT PATTERNS section names the new dedicated tools and the evaluate fallbacks', () => {
    const out = block();
    expect(out).toContain('### TOKEN-EFFICIENT PATTERNS');
    // New tools introduced in v0.13.0 — agent must reach for these before
    // hand-rolling the equivalent evaluate expression.
    expect(out).toContain('browser.find');
    expect(out).toContain('within_selector');
    expect(out).toContain('only_interactive');
    // Patterns staying as evaluate-recipes (no tool added) — must still be taught.
    expect(out).toContain('pane.scrollTop');
    expect(out).toContain('scrollIntoView');
    expect(out).toContain('latest_id');
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
    expect(out).toContain('settle');
    expect(out).toContain('mutation_count');
  });

  test('BULK WORK section points at flow+repeat instead of an evaluate loop', () => {
    const out = block();
    expect(out).toContain('### BULK WORK');
    expect(out).toContain('NEVER a loop inside `evaluate`');
    // The three things that make repeat safe to reach for.
    expect(out).toContain('max_iterations');
    expect(out).toContain('while_found');
    expect(out).toContain('dry_run: true');
    // And the reason it beats the evaluate loop at all.
    expect(out).toContain('trusted CDP input with the occlusion guard');
  });

  test('LONG-RUNNING WORK section carries the safety-critical relaunch check', () => {
    const out = block();
    expect(out).toContain('### LONG-RUNNING WORK');
    // The finding that matters most: a bridge timeout drops the response
    // but the page keeps executing, so a "failed" evaluate that gets
    // relaunched double-executes irreversible actions.
    expect(out).toContain('KEEPS RUNNING');
    expect(out).toContain('BEFORE relaunching');
    // The worker guard is what makes a relaunch safe when it does happen.
    expect(out).toContain('window.__job?.running');
    expect(out).toContain('The guard on `running` is mandatory');
    // Waiting on the worker must not be hand-rolled polling.
    expect(out).toContain('window.__job?.finished === true');
    // No manifest exists anywhere in the bridge — the agent has to build it.
    expect(out).toContain('window.__job.manifest.push(id)');
  });

  test('READING DATA section teaches the two silent wrong-answer traps', () => {
    const out = block();
    expect(out).toContain('### READING DATA');
    // Detached-document text extraction.
    expect(out).toContain('DOMParser');
    expect(out).toContain('`undefined` on a document with no layout');
    // Paginated counters as a completion signal.
    expect(out).toContain('authoritative total elsewhere');
    expect(out).toContain('empty-state string');
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
